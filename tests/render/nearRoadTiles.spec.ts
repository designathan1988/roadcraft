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
import { type KeptNear, type NearRoadMesh, type NearTileRoads, bakeNearRoads, nearKey, nearMeshOf, nearSig, runNearRoadJob } from '@render/nearRoadTiles';
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

/** A bake's triangles by surface, over all its blocks, at a level. */
const baked = (kept: KeptNear, variant: 'full' | 'coarse' = 'full'): Map<string, string[]> =>
  trianglesByName(nearMeshOf(kept, variant, null).draws.map((s) => ({ name: s.name, position: s.arrays.position, index: s.arrays.index })));

/** A cache in memory, as the browser's store keeps a value (a copy each), with every key written. */
function memoryCache(): FarRoadCache & { readonly puts: string[] } {
  const kept = new Map<string, unknown>();
  const puts: string[] = [];
  return {
    puts,
    ready: () => Promise.resolve(true), get: (key) => Promise.resolve(kept.get(key)),
    put: (key, value) => { kept.set(key, structuredClone(value)); puts.push(key); return Promise.resolve(); },
  };
}

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

  it('are kept by the versions of the tiles they read, baked once a version, both levels from one bake', async () => {
    const doc = world();
    const tiles = stored(doc);
    const cache = memoryCache();
    const order = [tileKey(1, 1), ...[...tiles.keys()].filter((k) => k !== tileKey(1, 1))];
    const versions = order.map((key) => ({ key, version: 1 }));
    const bake = nearSig(versions);
    const ask = { look: passLook(materials, undefined), markingStyle: doc.markingStyle, ground: null, naturalIsGround: false, tiles: versions, bake, shown: null };
    const node = nearKey(1, 1);
    // No store this thread reads: the page's records asked for.
    const asked = await runNearRoadJob({ node, sig: `${bake}:full`, want: true, prefix: 'test:', near: { ...ask, variant: 'full' } }, cache);
    expect(asked.kind).toBe('farRecords');
    const records = order.map((key) => roadsOf(tiles.get(key)!));
    const full = await runNearRoadJob({ node, sig: `${bake}:full`, want: true, prefix: 'test:', near: { ...ask, variant: 'full', records } }, cache);
    if (full.kind !== 'far' || !full.payload) throw new Error(full.kind);
    expect(full.payload.base).toBeNull();
    expect(full.payload.draws.length).toBe(full.payload.keys.length);
    // A mesh a surface for the whole tile (name and standing), never one a block and surface.
    expect(new Set(full.payload.draws.map((d) => d.key)).size).toBe(full.payload.draws.length);
    expect(full.payload.draws.length).toBeLessThan(30);
    // The simplified level from the same bake: nothing baked again, fewer triangles, the paint whole.
    const coarse = await runNearRoadJob({ node, sig: `${bake}:coarse`, want: true, prefix: 'test:', near: { ...ask, variant: 'coarse' } }, cache);
    if (coarse.kind !== 'far' || !coarse.payload) throw new Error(coarse.kind);
    expect(cache.puts).toEqual([`test:${node}`]);
    expect(coarse.payload.triangles).toBeLessThan(full.payload.triangles);
    const paintOf = (mesh: NearRoadMesh): number => mesh.draws.filter((x) => x.source.kind === 'paint').reduce((n, x) => n + x.arrays.index.length, 0);
    expect(paintOf(coarse.payload)).toBe(paintOf(full.payload));
    expect(paintOf(full.payload)).toBeGreaterThan(0);
  });

  it('are baked again a block at a time after an edit: the draws of the blocks it reached sent alone, the others kept', async () => {
    const doc = world();
    const tiles = stored(doc);
    const cache = memoryCache();
    const order = [tileKey(1, 1), ...[...tiles.keys()].filter((k) => k !== tileKey(1, 1))];
    const versions = order.map((key) => ({ key, version: 1 }));
    const look = { look: passLook(materials, undefined), markingStyle: doc.markingStyle, ground: null, naturalIsGround: false };
    const node = nearKey(1, 1);
    const first = nearSig(versions);
    const made = await runNearRoadJob({ node, sig: `${first}:full`, want: true, prefix: 'test:',
      near: { ...look, tiles: versions, bake: first, variant: 'full', shown: null, records: order.map((key) => roadsOf(tiles.get(key)!)) } }, cache);
    if (made.kind !== 'far' || !made.payload) throw new Error(made.kind);
    // A street of the tile bent, as the page holds it before it is written: the tile's records the page's.
    const edited = new RoadDoc();
    for (const r of tiles.values()) edited.loadTile(r);
    const street = [...edited.segments.values()].find((x) => {
      const a = edited.node(x.a)!, b = edited.node(x.b)!;
      return Math.min(a.x, b.x) > TILE + m(200) && Math.max(a.x, b.x) < TILE + m(700) && Math.min(a.y, b.y) > TILE + m(200) && Math.max(a.y, b.y) < TILE + m(700);
    })!;
    expect(street).toBeDefined();
    edited.setSegmentCurve(street.id, { t: 0.5, h: m(12) });
    const page = order.map((key, n) => (n === 0 ? roadsOf(edited.tileRecords(key, 1)) : null));
    const second = nearSig(versions.map((v, n) => (n === 0 ? { ...v, version: '1+1' } : v)));
    const again = await runNearRoadJob({ node, sig: `${second}:full`, want: true, prefix: 'test:',
      near: { ...look, tiles: versions, bake: second, variant: 'full', shown: made.payload.bake, records: page.map((r, n) => r ?? roadsOf(tiles.get(order[n]!)!)) } }, cache);
    if (again.kind !== 'far' || !again.payload) throw new Error(again.kind);
    expect(again.payload.base).toBe(made.payload.bake);
    expect(again.payload.draws.length).toBeGreaterThan(0);
    expect(again.payload.draws.length).toBeLessThanOrEqual(again.payload.keys.length);
    // The draws sent are those with a block the bend reached (a street bent reaches every surface of its blocks: here all); a draw none of whose blocks changed is kept as the page has it.
    const before = new Map(made.payload.draws.map((d) => [d.key, d.digest]));
    for (const d of again.payload.draws) expect(before.get(d.key)).not.toBe(d.digest);
  });

  it('are not baked again for the same roads at other versions (a building grown, the tile written): nothing made, written nor sent', async () => {
    const doc = world();
    const tiles = stored(doc);
    const cache = memoryCache();
    const order = [tileKey(1, 1), ...[...tiles.keys()].filter((k) => k !== tileKey(1, 1))];
    const look = { look: passLook(materials, undefined), markingStyle: doc.markingStyle, ground: null, naturalIsGround: false };
    const node = nearKey(1, 1);
    const records = order.map((key) => roadsOf(tiles.get(key)!));
    const at = (version: number) => order.map((key) => ({ key, version }));
    const first = nearSig(at(1));
    const made = await runNearRoadJob({ node, sig: `${first}:full`, want: true, prefix: 'test:', near: { ...look, tiles: at(1), bake: first, variant: 'full', shown: null, records } }, cache);
    if (made.kind !== 'far' || !made.payload) throw new Error(made.kind);
    const puts = cache.puts.length;
    // Every tile written again with the same roads: asked at new versions.
    const later = nearSig(at(2));
    const again = await runNearRoadJob({ node, sig: `${later}:full`, want: true, prefix: 'test:', near: { ...look, tiles: at(2), bake: later, variant: 'full', shown: made.payload.bake, records } }, cache);
    if (again.kind !== 'far' || !again.payload) throw new Error(again.kind);
    expect(cache.puts.length).toBe(puts);
    expect(again.payload.bake).toBe(made.payload.bake);
    expect(again.payload.base).toBe(made.payload.bake);
    expect(again.payload.draws).toEqual([]);
    expect(again.payload.keys).toEqual(made.payload.keys);
  });
});
