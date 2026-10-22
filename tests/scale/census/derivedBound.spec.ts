import { beforeAll, describe, expect, it } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera, type BufferAttribute, type InstancedMesh, type InterleavedBuffer, type Object3D } from 'three';

import { buildLargeCityMap, buildSmallCityMap } from '@editor/smallCityMap';
import { createCoverIndex } from '@render/buildings/layerCells';
import { drawnMatrices, type Pack } from '@render/cellInstances';
import { createGardenCells, createGardens, gardenPack, gardenPlants } from '@render/gardens';
import { createInstanceRuns } from '@render/instanceRuns';
import { sceneryPictures } from '@render/plantImpostors';
import { PoleCells } from '@render/poleCells';
import { PROP_CELL, lookProps, propView, type PropSquare, type PropView } from '@render/propCells';
import { SurfaceInputs } from '@render/roadSurfaceInputs';
import { SHADOW_REACH, createSceneryKit } from '@render/scenery';
import { createStreetFurniture, furnitureAbout, furnitureStores } from '@render/streetFurnitureLayer';
import { poleGroundAt } from '@render/utilities';
import type { SerializedDoc } from '@world/doc';
import { RoadDoc } from '@world/doc';
import { buildRoadElevation } from '@world/elevation';
import { Network } from '@world/network';
import { m } from '@world/units';

/**
 * WHAT IS DERIVED FROM THE MAP IS HELD ROUND THE VIEW, NOT FOR THE MAP (`viewCells.ts`): the small city and the large one (six times its
 * buildings) seen by the same camera at their centre hold about the same bytes of derived data on the CPU, the road surfaces' rings
 * (`roadSurfaceInputs.ts` `InputResidency`) and the plants' cover of the buildings (`layerCells.ts` `createCoverIndex`); and an edit
 * makes again a handful of cells, never the map. Seconds, no GPU, no browser.
 */

/** How far round the eye the view's work reaches here: the roads a build near the camera visits, the plants a cull asks about. */
const VIEW = m(400);

interface Held {
  readonly buildings: number;
  readonly roadBytes: number;
  readonly roadCells: number;
  readonly coverBytes: number;
  readonly coverCells: number;
  readonly doc: RoadDoc;
  readonly net: Network;
  readonly inputs: SurfaceInputs;
  readonly cover: ReturnType<typeof createCoverIndex>;
  readonly eye: { readonly x: number; readonly y: number };
}

/** A city with its derived data made round one camera at its centre, as a build and a plant cull near the camera ask for it. */
function heldRound(data: SerializedDoc): Held {
  const doc = RoadDoc.fromJSON(data);
  const net = new Network(doc);
  net.rebuild();
  let sx = 0, sy = 0;
  for (const node of doc.nodes.values()) { sx += node.x; sy += node.y; }
  const eye = { x: sx / doc.nodes.size, y: sy / doc.nodes.size };
  const inputs = new SurfaceInputs(null, { cpuBudget: 8 * 1048576, reach: VIEW });
  inputs.refresh(net);
  // A build near the camera: the tiles within the view visited (their rings read), the rest left as they are.
  for (const { id } of inputs.passList()) {
    for (const key of inputs.tileKeys(id)) {
      const ix = Math.floor(key / 0x1_0000) - 32768, iy = (key % 0x1_0000) - 32768;
      const cx = (ix + 0.5) * m(76.8), cy = (iy + 0.5) * m(76.8);
      if (Math.hypot(cx - eye.x, cy - eye.y) > VIEW) continue;
      inputs.wakeTile(key);
      if (inputs.hasTile(id, key)) inputs.reachOf(id, key);
    }
  }
  inputs.keepNear(eye);
  // A plant cull round the camera: every 8 m within the view asked whether a building covers it.
  const cover = createCoverIndex();
  cover.follow(doc);
  for (let x = eye.x - VIEW; x <= eye.x + VIEW; x += m(8)) for (let y = eye.y - VIEW; y <= eye.y + VIEW; y += m(8)) cover.covers(x, y);
  cover.look(eye.x, eye.y, Infinity);
  return {
    buildings: doc.buildings.size, roadBytes: inputs.residentBytes, roadCells: inputs.cells!.size,
    coverBytes: cover.cells.cpuBytes, coverCells: cover.cells.size, doc, net, inputs, cover, eye,
  };
}

describe('derived data held round the view', () => {
  it('holds about the same bytes for the small city and for the large one, and an edit makes few cells again', () => {
    const small = heldRound(buildSmallCityMap(7));
    const large = heldRound(buildLargeCityMap(7));
    console.log(JSON.stringify({
      small: { buildings: small.buildings, roadBytes: small.roadBytes, roadCells: small.roadCells, coverBytes: small.coverBytes, coverCells: small.coverCells },
      large: { buildings: large.buildings, roadBytes: large.roadBytes, roadCells: large.roadCells, coverBytes: large.coverBytes, coverCells: large.coverCells },
    }));
    expect(large.buildings).toBeGreaterThan(small.buildings * 4);
    const smallBytes = small.roadBytes + small.coverBytes, largeBytes = large.roadBytes + large.coverBytes;
    expect(smallBytes).toBeGreaterThan(0);
    // The map six times larger, the bytes the same view holds within a third of each other.
    expect(largeBytes / smallBytes).toBeGreaterThan(0.67);
    expect(largeBytes / smallBytes).toBeLessThan(1.5);

    // A building beside the eye moved a little: the cover cells it reached dropped, nothing else.
    const { doc, cover, inputs, net, eye } = large;
    const b = doc.buildings.near(eye.x - m(50), eye.y - m(50), eye.x + m(50), eye.y + m(50))[0]!;
    const before = cover.cells.work.invalidated;
    doc.buildings.put({ ...b, x: b.x + m(0.5) });
    cover.follow(doc);
    const dropped = cover.cells.work.invalidated - before;
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(9);

    // A road laid beside the eye: the tiles it made dirty visited, the cells they derive a handful.
    const derivedBefore = inputs.cells!.work.derived;
    const a = doc.addNode({ x: eye.x + m(30), y: eye.y + m(30) });
    const c = doc.addNode({ x: eye.x + m(90), y: eye.y + m(45) });
    doc.addSegment(a.id, c.id, 1);
    net.rebuild();
    inputs.refresh(net);
    for (const { id } of inputs.passList()) {
      for (const key of inputs.dirtyOf(id)?.keys ?? []) { inputs.wakeTile(key); if (inputs.hasTile(id, key)) inputs.reachOf(id, key); }
    }
    inputs.keepNear(eye);
    expect(inputs.cells!.work.derived - derivedBefore).toBeLessThanOrEqual(9);
  }, 60_000);
});

/**
 * THE PROPS HELD ROUND THE VIEW (`propCells.ts`, `poleLayer.ts` PoleCells): the gardens, the street furniture and the poles of a city
 * seen by one camera hold about the same CPU bytes whatever the city's size, once what the view asks is placed and on the GPU (a far
 * batch's arrays let go after their upload, as three uploads them on their first draw); and what they draw near the camera is, plant
 * for plant, what the whole map placed at once draws there, and their far batches hold the whole map's plants of their blocks.
 */

const kit = createSceneryKit();
const flat = (): number => 0;

interface City { readonly doc: RoadDoc; readonly net: Network; readonly eye: { readonly x: number; readonly y: number } }

function cityOf(data: SerializedDoc): City {
  const doc = RoadDoc.fromJSON(data);
  const net = new Network(doc);
  net.rebuild();
  let sx = 0, sy = 0;
  for (const node of doc.nodes.values()) { sx += node.x; sy += node.y; }
  return { doc, net, eye: { x: sx / doc.nodes.size, y: sy / doc.nodes.size } };
}

/** A street-level camera over the eye, looking along the city to the horizon. */
function cameraAt(eye: { readonly x: number; readonly y: number }): PerspectiveCamera {
  const camera = new PerspectiveCamera(35, 16 / 9, m(0.4), m(8000));
  camera.position.set(eye.x, m(45), -eye.y);
  camera.lookAt(eye.x + m(400), 0, -(eye.y + m(250)));
  camera.updateMatrixWorld();
  return camera;
}

const viewOf = (camera: PerspectiveCamera, half: number): PropView => {
  const matrix = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return propView(camera, new Frustum().setFromProjectionMatrix(matrix), half, 0);
};

/** What three does on a buffer's first upload (r186 `WebGLAttributes.createBuffer`): its upload callback, once each, under `root`. */
function uploaded(root: Object3D): void {
  const done = new Set<object>();
  const send = (b: BufferAttribute | InterleavedBuffer | null | undefined): void => {
    if (!b || done.has(b) || !b.array) return;
    done.add(b);
    b.onUploadCallback();
  };
  root.traverse((o) => {
    const mesh = o as InstancedMesh;
    if (!mesh.geometry) return;
    for (const a of Object.values(mesh.geometry.attributes)) send((a as unknown as { data?: InterleavedBuffer }).data ?? (a as BufferAttribute));
    if (mesh.isInstancedMesh) { send(mesh.instanceMatrix); send(mesh.instanceColor); }
  });
}

interface Props {
  readonly gardens: ReturnType<typeof createGardenCells>;
  readonly furniture: ReturnType<typeof createStreetFurniture>;
  readonly poles: PoleCells;
  readonly square: PropSquare;
  readonly camera: PerspectiveCamera;
}

/** The props of a city brought to one camera's view, every cell and block it asks for placed. */
function propsRound(city: City, half: number): Props {
  const elevation = buildRoadElevation(city.net, flat);
  const gardens = createGardenCells(kit);
  gardens.source(city.doc.buildings, flat);
  const furniture = createStreetFurniture(kit);
  furniture.sync(city.net, elevation, flat, 600);
  const poles = new PoleCells(kit);
  poles.source(city.net, poleGroundAt(elevation, flat, city.net));
  const camera = cameraAt(city.eye);
  const view = viewOf(camera, half);
  let square: PropSquare = { cx: 0, cy: 0, k: -1 };
  for (let i = 0; i < 500; i++) {
    square = lookProps([gardens.layer, furniture.layer], view);
    poles.look(view, Infinity);
    if (!gardens.layer.busy && !furniture.layer.busy && !poles.busy) break;
  }
  expect(gardens.layer.busy || furniture.layer.busy || poles.busy).toBe(false);
  return { gardens, furniture, poles, square, camera };
}

const bytesOf = (p: Props): number => p.gardens.layer.cpuBytes + p.furniture.layer.cpuBytes + p.poles.cells.cpuBytes;

/** Each instance's pose (its first seven floats: place, yaw, scales) and tint, as text, of those standing where `keep` says. */
function rowsOf(packs: ReadonlyMap<number, Pack>, keep: (x: number, y: number) => boolean, stride: number): string[] {
  const rows: string[] = [];
  for (const pack of packs.values()) {
    for (let i = 0; i < pack.count; i++) {
      const at = i * stride;
      if (!keep(pack.data[at]!, -pack.data[at + 2]!)) continue;
      rows.push([...pack.data.subarray(at, at + 7), ...(pack.colours ? pack.colours.subarray(i * 3, i * 3 + 3) : [1, 1, 1])].join(','));
    }
  }
  return rows.sort();
}

/** Each drawn instance of each mesh (but the far batches), as matrix and tint, of those standing where `keep` says. */
function drawnRows(meshes: readonly InstancedMesh[], keep: (x: number, y: number) => boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const mesh of meshes) {
    if (mesh.name.endsWith('-far-cells')) continue;
    const matrices = drawnMatrices(mesh), tints = mesh.instanceColor?.array;
    const rows: string[] = [];
    for (let i = 0; i < mesh.count; i++) {
      const at = i * 16;
      if (!keep(matrices[at + 12]!, -matrices[at + 14]!)) continue;
      rows.push([...matrices.subarray(at, at + 16), ...(tints ? tints.subarray(i * 3, i * 3 + 3) : [])].join(','));
    }
    if (rows.length) out.set(mesh.name, [...(out.get(mesh.name) ?? []), ...rows].sort());
  }
  return out;
}

/** Two lists of rows the same as multisets: the few missing from `got` and the few extra in it (DO NOT hand vitest two lists of 100,000 rows to diff). */
function expectSameRows(got: readonly string[] | undefined, want: readonly string[], label: string): void {
  const left = new Map<string, number>();
  for (const r of want) left.set(r, (left.get(r) ?? 0) + 1);
  const extra: string[] = [];
  for (const r of got ?? []) {
    const n = left.get(r) ?? 0;
    if (n === 0) extra.push(r); else left.set(r, n - 1);
  }
  const missing = [...left].filter(([, n]) => n > 0).map(([r]) => r);
  expect({ label, got: got?.length ?? 0, want: want.length, missing: missing.slice(0, 3), extra: extra.slice(0, 3) })
    .toEqual({ label, got: want.length, want: want.length, missing: [], extra: [] });
}

const cellOf = (v: number): number => Math.floor(Math.fround(v) / PROP_CELL);
const inSquare = (square: PropSquare) => (x: number, y: number): boolean =>
  Math.max(Math.abs(cellOf(x) - square.cx), Math.abs(cellOf(y) - square.cy)) <= square.k;

describe('the props held round the view', () => {
  let small: City, large: City;
  beforeAll(() => {
    small = cityOf(buildSmallCityMap(7));
    large = cityOf(buildLargeCityMap(7));
  }, 60_000);

  it('hold about the same CPU bytes for the small city and for the large one, and an edit drops a few near cells', () => {
    // A screen whose near square (the plants drawn whole) lies inside the small city: 3 x 3 cells.
    const half = 150;
    const a = propsRound(small, half), b = propsRound(large, half);
    for (const p of [a, b]) {
      uploaded(p.gardens.layer.group);
      uploaded(p.furniture.layer.group);
      uploaded(p.poles.group);
    }
    const row = (c: City, p: Props): Record<string, number> => ({
      buildings: c.doc.buildings.size, items: c.doc.landscape.size, poles: c.doc.poles.size, k: p.square.k,
      gardens: p.gardens.layer.cpuBytes, gardenGpu: p.gardens.layer.far.reduce((n, f) => n + f.gpuBytes, 0),
      furniture: p.furniture.layer.cpuBytes, furnitureGpu: p.furniture.layer.far.reduce((n, f) => n + f.gpuBytes, 0),
      gardenNear: p.gardens.layer.near.cpuBytes, gardenFar: p.gardens.layer.far.reduce((n, f) => n + f.cpuBytes, 0), nearCells: p.gardens.layer.near.size,
      poleBytes: p.poles.cells.cpuBytes, poleGpu: p.poles.cells.gpuBytes, poleBlocks: p.poles.cells.size,
    });
    console.log(JSON.stringify({ small: row(small, a), large: row(large, b) }));
    expect(large.doc.buildings.size).toBeGreaterThan(small.doc.buildings.size * 4);
    expect(a.square.k).toBe(1);
    expect(b.square.k).toBe(1);
    // Far batches and pole blocks hold their arrays on the GPU once uploaded.
    expect(b.gardens.layer.far[0]!.gpuBytes).toBeGreaterThan(0);
    expect(b.poles.cells.gpuBytes).toBeGreaterThan(0);
    // The map six times larger, the bytes the same view holds no more (the large city's middle is downtown, fewer gardens than the small one's):
    // what the view holds, never the map (the whole map placed held 95 MB of the large city's, 2026-10-21).
    expect(bytesOf(b) / bytesOf(a)).toBeLessThan(1.5);
    expect(bytesOf(b)).toBeLessThan(8 * 1048576);

    // A building beside the eye moved a little: the gardens' cells its record's rectangle reached dropped (at most the 3 x 3 round it), never the map's.
    const { doc } = large;
    const near = doc.buildings.near(large.eye.x - m(30), large.eye.y - m(30), large.eye.x + m(30), large.eye.y + m(30))[0]!;
    const before = b.gardens.layer.near.work.invalidated;
    doc.buildings.put({ ...near, x: near.x + m(0.5) });
    b.gardens.follow(doc.changes);
    const dropped = b.gardens.layer.near.work.invalidated - before;
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(9);
    doc.buildings.put(near);
    for (const p of [a, b]) { p.gardens.dispose(); p.furniture.dispose(); p.poles.dispose(); }
  });

  it('draws near the camera the plants the whole map placed at once draws there, and holds far its plants of each block', () => {
    const city = large;
    const p = propsRound(city, 540);
    expect(p.square.k).toBeGreaterThanOrEqual(1);
    const keep = inSquare(p.square);
    const matrix = new Matrix4().multiplyMatrices(p.camera.projectionMatrix, p.camera.matrixWorldInverse);
    const frustum = new Frustum().setFromProjectionMatrix(matrix);

    // The gardens: every building's garden placed at once (`createGardens`), culled to the same view.
    const lists = [...city.doc.buildings.all()].map((b) => gardenPlants([b], flat)).filter((l) => l.length > 0);
    const whole = createGardens(kit);
    whole.update({ added: lists, removed: [] });
    whole.cull(frustum, matrix);
    p.gardens.cull(frustum, matrix);
    const want = drawnRows(whole.meshes, keep), got = drawnRows(p.gardens.meshes, keep);
    expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
    let plants = 0;
    for (const [name, rows] of want) { expectSameRows(got.get(name), rows, name); plants += rows.length; }
    expect(plants).toBeGreaterThan(500);

    // The street furniture and its plants: every item placed at once, culled to the same view.
    const elevation = buildRoadElevation(city.net, flat);
    const pictures = sceneryPictures(kit);
    const stores = furnitureStores(kit, pictures);
    const everything = furnitureAbout({ changes: city.doc.changes, net: city.net, elevation, groundAt: flat }, stores, kit.lens, 600, [-m(3000), -m(3000), m(3000), m(3000)]);
    const runs = createInstanceRuns('whole', stores, SHADOW_REACH);
    runs.update({ removed: [], added: [everything.packs] });
    runs.cull(frustum, matrix);
    p.furniture.cull(frustum, matrix);
    const wantStreet = drawnRows(runs.meshes, keep), gotStreet = drawnRows(p.furniture.meshes, keep);
    expect([...gotStreet.keys()].sort()).toEqual([...wantStreet.keys()].sort());
    let things = 0;
    for (const [name, rows] of wantStreet) { expectSameRows(gotStreet.get(name), rows, name); things += rows.length; }
    expect(things).toBeGreaterThan(200);

    // Far: each held block's picture batch holds the whole map's garden plants of the block, at the same places, tinted the same.
    const allPacks = gardenPack(lists.flat());
    const blocks = new Set<string>();
    const farRows: string[] = [];
    p.gardens.layer.group.traverse((o) => {
      const mesh = o as InstancedMesh;
      if (!mesh.isInstancedMesh || !mesh.name.endsWith('-far-cells') || !o.parent?.parent?.visible) return;
      const poses = (mesh.geometry.getAttribute('instancePoseA') as unknown as { data: InterleavedBuffer }).data.array as Float32Array;
      const tints = mesh.instanceColor!.array as Float32Array;
      for (let i = 0; i < mesh.count; i++) {
        farRows.push([...poses.subarray(i * 8, i * 8 + 7), ...tints.subarray(i * 3, i * 3 + 3)].join(','));
        blocks.add(`${Math.floor(cellOf(poses[i * 8]!) / 4)},${Math.floor(cellOf(-poses[i * 8 + 2]!) / 4)}`);
      }
    });
    expect(blocks.size).toBeGreaterThan(1);
    const inBlocks = (x: number, y: number): boolean => blocks.has(`${Math.floor(cellOf(x) / 4)},${Math.floor(cellOf(y) / 4)}`);
    expectSameRows(farRows, rowsOf(allPacks, inBlocks, 8), 'far pictures');

    whole.dispose();
    runs.dispose();
    pictures.release();
    p.gardens.dispose(); p.furniture.dispose(); p.poles.dispose();
  });
});
