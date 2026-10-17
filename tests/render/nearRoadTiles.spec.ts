import { MeshBasicMaterial, type BufferGeometry, type Mesh, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { FLAT_GROUND, buildRoadElevation } from '@world/elevation';
import { RoadDoc, type TileRecords } from '@world/doc';
import type { NodeId } from '@world/ids';
import { Network } from '@world/network';
import { gatesNear, parkingLinesOf } from '@world/parkingLayout';
import { TILE, tileKey } from '@world/tiles';
import { m } from '@world/units';
import type { SceneMaterials } from '@render/materials';
import { marksRoadSection } from '@render/mesh/roadEdges';
import { type NearRoadMesh, type NearTileRoads, bakeNearRoads, nearKey, nearSig, runNearRoadJob } from '@render/nearRoadTiles';
import { buildRoadSurfaces, passLook, type SurfaceReuse } from '@render/roadSurfaces';
import type { FarRoadCache } from '@render/farRoadTiles';
import { type SharedGroundData, sharedGroundReaders } from '@render/sharedGround';
import { RELIEF_NATURAL } from '@world/terrain';

/** THE ROADS NEAR THE CAMERA, BAKED PER TILE IN A WORKER (`nearRoadTiles.ts`): the surfaces the page's region draws for the same tile */

/** A stand-in material that reads every attribute a road surface may carry. */
function readingAll(): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ vertexColors: true });
  marksRoadSection(material);
  return material;
}
const materials = new Proxy({}, {
  get: (_target, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : readingAll(),
}) as unknown as SceneMaterials;

/** 3 x 3 tiles round tile (1, 1), whose road tiles of 76.8 m stand up to 25 m past its edges (`roadSurfaceInputs.ts` TILE_ORIGIN): avenues and streets crossing the tiles' edges at a node on the edge (as the generator lays them), junctions 9 m inside an edge and 15 m and 20 m outside, a curved street over one, parking along some. */
function world(): RoadDoc {
  const doc = new RoadDoc();
  const at = new Map<string, NodeId>();
  const node = (x: number, y: number): NodeId => {
    const key = `${x},${y}`;
    let id = at.get(key);
    if (id === undefined) at.set(key, id = doc.addNode({ x, y }).id);
    return id;
  };
  const lines = [m(300), TILE - m(15), TILE + m(9), TILE + m(256), TILE + m(640), 2 * TILE - m(20), 2 * TILE + m(9), 2 * TILE + m(400)];
  const parked = { left: 'parallel', right: 'parallel' } as const;
  // Along x: each line cut at every crossing line and at each tile edge.
  const cuts = [...new Set([...lines, TILE, 2 * TILE].concat([m(30), 3 * TILE - m(30)]))].sort((a, b) => a - b);
  lines.forEach((y, n) => {
    for (let k = 1; k < cuts.length; k++) doc.addSegment(node(cuts[k - 1]!, y), node(cuts[k]!, y), n % 3, null, 0, 'both', null, 'ground', undefined, n % 2 ? parked : undefined);
  });
  lines.forEach((x, n) => {
    for (let k = 1; k < cuts.length; k++) doc.addSegment(node(x, cuts[k - 1]!), node(x, cuts[k]!), (n + 1) % 3, null, 0, 'both', null, 'ground', undefined, n % 2 ? undefined : parked);
  });
  // A street bowed over the tile's west edge.
  doc.addSegment(node(TILE - m(200), TILE + m(800)), node(TILE, TILE + m(810)), 0, { t: 0.5, h: m(60) });
  doc.addSegment(node(TILE, TILE + m(810)), node(TILE + m(200), TILE + m(820)), 0, { t: 0.5, h: -m(40) });
  return doc;
}

/** The world as the store keeps it, a record a tile. */
function stored(doc: RoadDoc): Map<number, TileRecords> {
  const out = new Map<number, TileRecords>();
  for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) out.set(tileKey(i, j), doc.tileRecords(tileKey(i, j), 1));
  return out;
}

const roadsOf = (r: TileRecords): NearTileRoads => ({ key: r.key, nodes: r.nodes, borrowedNodes: r.borrowedNodes, segments: r.segments, gates: r.gates ?? [] });

/** Every triangle of some meshes by their name, each as its three corners' positions rounded to the micrometre, sorted: what is drawn, whatever buffer it is in. */
function trianglesByName(meshes: readonly { name: string; position: ArrayLike<number>; index: ArrayLike<number> }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const q = (v: number): string => (Math.round(v * 1e6) / 1e6).toFixed(6);
  for (const mesh of meshes) {
    let list = out.get(mesh.name);
    if (!list) out.set(mesh.name, list = []);
    for (let t = 0; t < mesh.index.length; t += 3) {
      const corners = [0, 1, 2].map((c) => { const v = mesh.index[t + c]!; return `${q(mesh.position[v * 3]!)},${q(mesh.position[v * 3 + 1]!)},${q(mesh.position[v * 3 + 2]!)}`; });
      // A triangle by its corners in turn from the least: its winding kept.
      const first = corners.indexOf([...corners].sort()[0]!);
      list.push([0, 1, 2].map((c) => corners[(first + c) % 3]).join(' '));
    }
  }
  for (const list of out.values()) list.sort();
  return out;
}

/** The region's near roads for tile (1, 1): the page's build of the nine tiles loaded, its road tiles kept to those whose centre is in it (`renderer.ts` `within`). */
function regionDrawn(tiles: ReadonlyMap<number, TileRecords>, groundAt: (x: number, y: number) => number = FLAT_GROUND): Map<string, string[]> {
  const doc = new RoadDoc();
  for (const records of tiles.values()) doc.loadTile(records);
  const net = new Network(doc);
  net.rebuild();
  const elevation = buildRoadElevation(net, groundAt);
  const reuse: SurfaceReuse = {
    tiles: new Map(), dependsOn: () => 0, paint: new Map(), chunks: new Map(),
    within: (rect) => { const cx = (rect[0] + rect[2]) / 2, cy = (rect[1] + rect[3]) / 2; return cx >= TILE && cx < 2 * TILE && cy >= TILE && cy < 2 * TILE; },
  };
  const built = buildRoadSurfaces(net, elevation, materials, groundAt, reuse);
  const meshes: { name: string; position: ArrayLike<number>; index: ArrayLike<number> }[] = [];
  built.group.traverse((o: Object3D) => {
    const geometry = (o as Mesh).geometry as BufferGeometry | undefined;
    if (!geometry || !(o as Mesh).isMesh) return;
    meshes.push({ name: o.name, position: geometry.getAttribute('position').array, index: geometry.getIndex()!.array });
  });
  return trianglesByName(meshes);
}

const baked = (mesh: NearRoadMesh): Map<string, string[]> =>
  trianglesByName(mesh.surfaces.map((s) => ({ name: s.name, position: s.position, index: s.index })));

/** The page's region and the tile's bake on the same ground: its triangles by surface, both. */
function bothOn(ground: SharedGroundData | null): { page: Map<string, string[]>; near: Map<string, string[]> } {
  const doc = world();
  const tiles = stored(doc);
  const centre = tileKey(1, 1);
  const around = [...tiles].filter(([key]) => key !== centre).map(([, r]) => roadsOf(r));
  const mesh = bakeNearRoads(roadsOf(tiles.get(centre)!), around, { look: passLook(materials, undefined), markingStyle: doc.markingStyle, ground, naturalIsGround: true });
  expect(mesh).not.toBeNull();
  // The page reads the ground as drawn, point for point as the workers read it shared (`sharedGround.ts`).
  return { page: regionDrawn(tiles, ground ? sharedGroundReaders(ground).groundAt : FLAT_GROUND), near: baked(mesh!) };
}

describe("a tile's near roads baked in a worker", () => {
  it("are the surfaces the page's region draws for that tile, triangle for triangle, from the tile's roads and its neighbours' alone", () => {
    const { page, near } = bothOn(null);
    expect([...near.keys()].sort()).toEqual([...page.keys()].sort());
    for (const [name, list] of page) {
      const mine = near.get(name)!;
      expect(mine.length, name).toBe(list.length);
      expect(mine, name).toEqual(list);
    }
    // Something of every kind a street has: the carriageway, its kerbs and footways, and paint.
    for (const name of ['asphalt', 'kerb', 'footway']) expect(page.get(name)?.length ?? 0, name).toBeGreaterThan(0);
    expect([...page.keys()].some((name) => name.startsWith('markings-'))).toBe(true);
  }, 10_000);

  it("are the same on hilly ground: the heights solved from the tile and its fringe are the region's there", () => {
    const ground: SharedGroundData = { n: 2, cell: 1, half: 0.5, base: 0, relief: RELIEF_NATURAL, plates: new Map() };
    const { page, near } = bothOn(ground);
    expect([...near.keys()].sort()).toEqual([...page.keys()].sort());
    for (const [name, list] of page) expect(near.get(name), name).toEqual(list);
  }, 10_000);

  it("give a street's parking the same paint from the tile's kept gates as from its buildings", () => {
    const doc = world();
    const net = new Network(doc);
    net.rebuild();
    // A gate 3 m off a parked street's kerb, its building's entrance as `entrancesOf` gives it.
    const gates = [TILE + m(100), TILE + m(256) + m(8), TILE + m(106), TILE + m(256) + m(8)];
    let tested = 0;
    for (const ribbon of net.ribbons.values()) {
      const lines = parkingLinesOf(net, ribbon, gatesNear(gates, ribbon.full, ribbon.road.width / 2));
      const none = parkingLinesOf(net, ribbon, []);
      if (!lines.length) continue;
      tested++;
      const near = gatesNear(gates, ribbon.full, ribbon.road.width / 2);
      if (near.length) expect(lines).not.toEqual(none);
      else expect(lines).toEqual(none);
    }
    expect(tested).toBeGreaterThan(0);
  });

  it('are kept by the versions of the tiles they read, baked once a version', async () => {
    const doc = world();
    const tiles = stored(doc);
    const kept = new Map<string, unknown>();
    const puts: string[] = [];
    const cache: FarRoadCache = {
      ready: () => Promise.resolve(true), get: (key) => Promise.resolve(kept.get(key)),
      put: (key, value) => { kept.set(key, structuredClone(value)); puts.push(key); return Promise.resolve(); },
    };
    const order = [tileKey(1, 1), ...[...tiles.keys()].filter((k) => k !== tileKey(1, 1))];
    const versions = order.map((key) => ({ key, version: 1 }));
    const near = { look: passLook(materials, undefined), markingStyle: doc.markingStyle, ground: null, naturalIsGround: false, tiles: versions };
    const node = nearKey(1, 1), sig = nearSig(versions);
    // No store this thread reads: the page's records asked for.
    const asked = await runNearRoadJob({ node, sig, want: true, prefix: 'test:', near }, cache);
    expect(asked.kind).toBe('farRecords');
    const made = await runNearRoadJob({ node, sig, want: true, prefix: 'test:', near: { ...near, records: order.map((key) => roadsOf(tiles.get(key)!)) } }, cache);
    if (made.kind !== 'far' || !made.payload) throw new Error(made.kind);
    expect(made.payload.triangles).toBeGreaterThan(0);
    const again = await runNearRoadJob({ node, sig, want: true, prefix: 'test:', near }, cache);
    if (again.kind !== 'far' || !again.payload) throw new Error(again.kind);
    expect(again.payload.triangles).toBe(made.payload.triangles);
    expect(puts).toEqual([`test:${node}`]);
    // A neighbour written again: another version, baked again.
    const moved = nearSig(versions.map((v, n) => (n === 3 ? { ...v, version: 2 } : v)));
    expect(moved).not.toBe(sig);
  });
});
