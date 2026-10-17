import { describe, expect, it } from 'vitest';

import { roadRecipes } from '@render/bake/roadRecipes';
import { TOP_LEVEL, emptyRecords, farKey, farNode } from '@render/buildings/farTiles';
import type { FarTileSource } from '@render/buildings/farLevels';
import { FarRoads, type NearRoadKit, type RoadPayload, farRoadJob, farRoadPriority } from '@render/farRoads';
import { EDIT_TIER, FAR_TIER, TIER_SPAN, cellPriority } from '@render/buildings/cellPool';
import { MeshBasicMaterial, type Mesh } from 'three';
import type { SceneMaterials } from '@render/materials';
import { marksRoadSection } from '@render/mesh/roadEdges';
import { passLook, surfaceLook } from '@render/roadSurfaces';
import { type FarRoadCache, type FarRoadMesh, STREET_MEANS, bakeTileRoads, farRoadTones, runFarRoadJob, tileNetwork } from '@render/farRoadTiles';
import type { FarTreeJob, FarTreeRun } from '@render/farTree';
import { surfaceTexels } from '@render/mesh/textureBaker';
import { CURB_BAND, Level } from '@world/roadTypes';
import { TILE, tileIdBase, tileKey, tileOfKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { m } from '@world/units';

/** THE ROADS FAR FROM THE CAMERA, BAKED PER TILE FROM THE TILE STORE (`farRoadTiles.ts`, `farRoads.ts`, `farTree.ts`) */

/** A tile's roads as the store keeps them: a cross of urban streets (8 m, 2 m footways) about its middle; a later version moves its east arm. */
function crossTile(i: number, j: number, version = 1): TileRecords {
  const key = tileKey(i, j), base = tileIdBase(key);
  const at = (fx: number, fy: number): { x: number; y: number } => ({ x: (i + fx) * TILE, y: (j + fy) * TILE });
  const nodes = [at(0.2, 0.5), at(0.5, 0.5), at(0.8 + 0.05 * (version - 1), 0.5), at(0.5, 0.2), at(0.5, 0.8)].map((p, n) => ({ id: base + n, ...p }));
  const segments = [[0, 1], [1, 2], [3, 1], [1, 4]].map(([a, b], n) => ({ id: base + 100 + n, a: base + a!, b: base + b!, type: 1, curve: null }));
  return { ...emptyRecords(key, version), nodes, segments };
}

/** The first vertex of the mesh's triangle holding a plan point, -1 off the mesh. */
function hit(mesh: FarRoadMesh, x: number, y: number): number {
  const px = (v: number): number => mesh.ox + mesh.xz[v * 2]! / mesh.q;
  const py = (v: number): number => mesh.oy + mesh.xz[v * 2 + 1]! / mesh.q;
  for (let t = 0; t < mesh.index.length; t += 3) {
    const a = mesh.index[t]!, b = mesh.index[t + 1]!, c = mesh.index[t + 2]!;
    const d = (px(b) - px(a)) * (py(c) - py(a)) - (py(b) - py(a)) * (px(c) - px(a));
    if (d === 0) continue;
    const u = ((px(b) - x) * (py(c) - y) - (py(b) - y) * (px(c) - x)) / d;
    const v = ((px(c) - x) * (py(a) - y) - (py(c) - y) * (px(a) - x)) / d;
    if (u >= -1e-6 && v >= -1e-6 && 1 - u - v >= -1e-6) return a;
  }
  return -1;
}

/** A texture's mean linear albedo over every texel, as the GPU reads the stored sRGB bytes. */
function fullMean(key: string): [number, number, number] {
  const recipe = roadRecipes().find((r) => r.key === key)!.recipe;
  const { map } = surfaceTexels(recipe);
  const lin = (b: number): number => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const sum = [0, 0, 0];
  for (let p = 0; p < map.length; p += 4) for (let k = 0; k < 3; k++) sum[k] = sum[k]! + lin(map[p + k]!);
  const n = map.length / 4;
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
}

const srgbByte = (c: number): number => Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);

/** A store of bakes in memory, as the browser's keeps them (a copy each), with every key written. */
function memoryCache(): FarRoadCache & { readonly puts: string[] } {
  const kept = new Map<string, unknown>();
  const puts: string[] = [];
  return {
    puts,
    ready: () => Promise.resolve(true),
    get: (key) => Promise.resolve(kept.get(key)),
    put: (key, value) => { kept.set(key, structuredClone(value)); puts.push(key); return Promise.resolve(); },
  };
}

/** The far jobs run here, as a worker runs them: posted as the runner posts them (`farRoadJob`). */
const runner = (cache: FarRoadCache, kit: NearRoadKit | null = null): FarTreeRun<RoadPayload> => (job, done) => {
  let live = true;
  void runFarRoadJob(farRoadJob(job, kit), cache).then((reply) => { if (live) done(reply); });
  return () => { live = false; };
};

/** Stand-in materials, one of each, reading every attribute a road surface may carry. */
const made = new Map<PropertyKey, MeshBasicMaterial>();
const materials = new Proxy({}, {
  get: (_target, key) => {
    if (key === 'scale') return new Proxy({}, { get: () => 4 });
    let material = made.get(key);
    if (!material) { material = new MeshBasicMaterial({ vertexColors: true }); marksRoadSection(material); made.set(key, material); }
    return material;
  },
}) as unknown as SceneMaterials;
const paint = new MeshBasicMaterial();
/** The page's look of the roads, as the renderer hands it (`renderer.ts`). */
const kit: NearRoadKit = {
  look: () => passLook(materials, undefined), markingStyle: () => 'classic', naturalIsGround: () => false,
  dress: (source, raised) => surfaceLook(source, raised, materials, undefined, () => paint),
};

/** 4 x 4 tiles round the origin, a cross of streets each. */
function world(): Map<number, TileRecords> {
  const out = new Map<number, TileRecords>();
  for (let i = -2; i < 2; i++) for (let j = -2; j < 2; j++) out.set(tileKey(i, j), crossTile(i, j));
  return out;
}

const storeOf = (tiles: ReadonlyMap<number, TileRecords>): FarTileSource => ({ records: (key) => Promise.resolve(tiles.get(key) ?? null), plan: null });

/** How many nodes drawn stand for each tile. */
function coverage(keys: readonly string[], tiles: Iterable<number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const tile of tiles) {
    const { i, j } = tileOfKey(tile);
    out.set(tile, keys.filter((key) => { const n = farNode(key); return Math.floor(i / 2 ** n.k) === n.i && Math.floor(j / 2 ** n.k) === n.j; }).length);
  }
  return out;
}

/** The view chosen again until what it wants has come (the jobs answer between turns). */
async function until(look: () => void, done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2000; turn++) {
    look();
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('the far roads never came');
}

describe('a tile of roads baked from the store', () => {
  it('takes each street texture at its mean as the recipes bake it (the constants follow the recipes)', () => {
    for (const key of ['asphalt', 'footway', 'kerb', 'verge'] as const) {
      const mean = fullMean(key);
      expect(STREET_MEANS[key].map((v, k) => Math.abs(v - mean[k]!) < 2e-6), `${key}: ${mean.map((v) => v.toFixed(6)).join(', ')}`).toEqual([true, true, true]);
    }
  });

  it("covers every carriageway and footway's ground, each in its near material's colour from afar", () => {
    const records = crossTile(0, 0);
    const mesh = bakeTileRoads(records);
    expect(mesh).not.toBeNull();
    const net = tileNetwork(records);
    const tones = farRoadTones();
    const asphalt = fullMean('asphalt'), footway = fullMean('footway');
    expect(net.ribbons.size).toBe(4);
    for (const ribbon of net.ribbons.values()) {
      const half = ribbon.road.width / 2;
      const outer = ribbon.road.width / 2 + ribbon.road.sidewalk;
      const centre = ribbon.centre[Level.Asphalt]!;
      for (let f = 0.1; f <= 0.9; f += 0.1) {
        const { p, n } = centre.sampleAt(centre.length * f);
        for (const across of [0, half * 0.6, -half * 0.6]) {
          const v = hit(mesh!, p.x + n.x * across, p.y + n.y * across);
          expect(v, `carriageway of ${ribbon.id} at ${f.toFixed(1)}, ${across}`).toBeGreaterThanOrEqual(0);
          // The urban class is the asphalt's reference colour: its tint is 1, its colour the texture's mean.
          for (let k = 0; k < 3; k++) expect(Math.abs(mesh!.color[v * 4 + k]! - srgbByte(asphalt[k]!))).toBeLessThanOrEqual(2);
        }
        for (const side of [1, -1]) {
          const across = side * (half + CURB_BAND + (outer - half - CURB_BAND) / 2);
          const v = hit(mesh!, p.x + n.x * across, p.y + n.y * across);
          expect(v, `footway of ${ribbon.id} at ${f.toFixed(1)}, ${across}`).toBeGreaterThanOrEqual(0);
          for (let k = 0; k < 3; k++) expect(Math.abs(mesh!.color[v * 4 + k]! - srgbByte(footway[k]!))).toBeLessThanOrEqual(2);
        }
      }
    }
    // The junction's plate.
    expect(hit(mesh!, 0.5 * TILE, 0.5 * TILE)).toBeGreaterThanOrEqual(0);
    // The kerb, too thin to be kept far off, still takes its texture's mean.
    const kerb = fullMean('kerb');
    for (let k = 0; k < 3; k++) expect(Math.abs(tones.kerb[k]! - kerb[k]!) / kerb[k]!).toBeLessThan(0.02);
    // Every vertex on the flat ground at its lift, every normal up.
    for (let v = 0; v < mesh!.height.length; v++) {
      expect(mesh!.height[v]!).toBeGreaterThan(0);
      expect(mesh!.height[v]!).toBeLessThanOrEqual(m(0.15) + 1e-6);
      expect(mesh!.normal[v * 4 + 1]).toBe(127);
    }
  });

  it('is kept by its version: its records asked only when not kept', async () => {
    const cache = memoryCache();
    const records = crossTile(0, 0);
    const node = farKey(0, 0, 0);
    const job = { node, k: 0, i: 0, j: 0, sig: '1', want: true, prefix: 'test:' } as const;
    expect((await runFarRoadJob(job, cache)).kind).toBe('farRecords');
    const made = await runFarRoadJob({ ...job, records }, cache);
    if (made.kind !== 'far') throw new Error(made.kind);
    const again = await runFarRoadJob(job, cache);
    if (again.kind !== 'far') throw new Error(again.kind);
    expect((again.payload as FarRoadMesh).index).toEqual((made.payload as FarRoadMesh).index);
    expect(cache.puts).toEqual([`test:${node}`]);
  });

  it('is posted, when the page read the tile, its roads alone: never its buildings', () => {
    const records: TileRecords = { ...crossTile(0, 0), buildings: [{ id: 1, x: 0, y: 0, volumes: [] }] };
    const tree = { node: farKey(0, 0, 0), k: 0, i: 0, j: 0, sig: '1', want: true, prefix: null } as const;
    const job = farRoadJob({ ...tree, records });
    expect(Object.keys(job.records!).sort()).toEqual(['borrowedNodes', 'key', 'nodes', 'segments']);
    expect(job.records).toEqual({ key: records.key, nodes: records.nodes, borrowedNodes: records.borrowedNodes, segments: records.segments });
    // The same mesh as from the whole records.
    expect(bakeTileRoads(job.records!)!.index).toEqual(bakeTileRoads(records)!.index);
    // The store's map kept for a worker that reads the store itself.
    expect(farRoadJob({ ...tree, store: 'map' }).store).toBe('map');
  });
});

describe('the far roads chosen top down', () => {
  it('draws coarse levels from far, the tiles near, never a tile the document holds', async () => {
    const cache = memoryCache();
    const tiles = world();
    const far = new FarRoads(() => null, runner(cache), 'test:');
    let loaded: number | null = null;
    far.setSource(storeOf(tiles), (key) => key === loaded);
    for (const [key, records] of tiles) far.stored(key, records.version);

    // From 50 km up: the top level only, each tile under one node.
    const fromAfar = (): void => far.choose(0, 0, m(50_000), 1000, null);
    await until(fromAfar, () => far.waiting === 0);
    const afar = far.shownKeys();
    for (const key of afar) expect(farNode(key).k).toBe(TOP_LEVEL);
    expect([...coverage(afar, tiles.keys()).values()].every((c) => c === 1)).toBe(true);

    // Over the middle of tile (0, 0), 50 m up: that tile at its own level, every other under one node, finer the nearer.
    const near = (): void => far.choose(0.5 * TILE, 0.5 * TILE, m(50), 1000, null);
    await until(near, () => far.waiting === 0);
    const close = far.shownKeys();
    expect(close).toContain(farKey(0, 0, 0));
    expect([...coverage(close, tiles.keys()).values()].every((c) => c === 1)).toBe(true);
    expect(Math.max(...close.map((key) => farNode(key).k))).toBeLessThan(TOP_LEVEL);

    // The tile in the page's document: drawn near, nothing here stands for it.
    loaded = tileKey(0, 0);
    far.loadedChanged(loaded);
    await until(near, () => far.waiting === 0);
    const held = coverage(far.shownKeys(), tiles.keys());
    expect(held.get(loaded)).toBe(0);
    for (const [tile, count] of held) if (tile !== loaded) expect(count).toBe(1);
    far.dispose();
  });

  it("draws a tile's near level where the view wants its detail (the region's surfaces, materials and all), its far level from afar", async () => {
    const cache = memoryCache();
    const tiles = world();
    const roads = new FarRoads(() => null, runner(cache, kit), 'test:', kit);
    // Every material the near level draws with stands in the tree before any tile comes, for the opening to compile (`shaderCatalogue.ts`).
    const programs = new Set<unknown>();
    roads.group.traverse((o) => { if (o.name === 'roads-near-program') programs.add((o as Mesh).material); });
    expect(programs.has(materials.asphalt)).toBe(true);
    expect(programs.has(materials.asphaltRaised)).toBe(true);
    expect(programs.has(paint)).toBe(true);
    roads.setSource(storeOf(tiles), () => false);
    for (const [key, records] of tiles) roads.stored(key, records.version);
    // 300 m over tile (0, 0): a metre spans 3 px there, past what the far level may leave out where the cells come near.
    const over = (): void => roads.choose(0.5 * TILE, 0.5 * TILE, m(300), 1000, null);
    await until(over, () => roads.nearKeys().includes(farKey(0, 0, 0)));
    expect(roads.shownKeys()).not.toContain(farKey(0, 0, 0));
    const near = roads.group.children.find((o) => o.name === 'roads-near' && o.visible)!;
    // Its meshes, block by block.
    const meshes: Mesh[] = [];
    near.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
    const asphalt = meshes.find((o) => o.name === 'asphalt');
    expect(asphalt).toBeDefined();
    expect(asphalt!.material).toBe(materials.asphalt);
    expect(meshes.some((o) => o.name.startsWith('markings-') && o.material === paint)).toBe(true);
    // From 6 km up: the far levels, the near one let go.
    const afar = (): void => roads.choose(0.5 * TILE, 0.5 * TILE, m(6_000), 1000, null);
    await until(afar, () => roads.nearKeys().length === 0 && roads.waiting === 0);
    expect(roads.group.children.some((o) => o.name === 'roads-near')).toBe(false);
    // Back over it: its near level read from where it was kept, not baked again.
    const puts = cache.puts.length;
    await until(over, () => roads.nearKeys().includes(farKey(0, 0, 0)));
    expect(cache.puts.slice(puts).filter((key) => key.includes('n0:'))).toEqual([]);
    roads.dispose();
  });

  it("draws a tile the page holds edited from the page's records, its bake asked before anything", async () => {
    const cache = memoryCache();
    const tiles = world();
    const asked: FarTreeJob[] = [];
    const run = runner(cache, kit);
    const roads = new FarRoads(() => null, (job, done) => { asked.push(job); return run(job, done); }, 'test:', kit);
    const edited = tileKey(0, 0);
    let edit = 0;
    roads.setSource({ ...storeOf(tiles), pageEdit: (key) => (key === edited ? edit : 0), pageRecords: (key) => (key === edited ? crossTile(0, 0, 2) : null) }, () => false);
    for (const [key, records] of tiles) roads.stored(key, records.version);
    const over = (): void => roads.choose(0.5 * TILE, 0.5 * TILE, m(300), 1000, null);
    await until(over, () => roads.nearKeys().includes(farKey(0, 0, 0)));
    const before = asked.filter((job) => job.near);
    expect(before.length).toBeGreaterThan(0);
    for (const job of before) expect(job.near!.edited).toBeUndefined();
    // The player edits the tile: the store still has the old one.
    edit = 1;
    asked.length = 0;
    await until(over, () => asked.some((job) => job.near && job.i === 0 && job.j === 0));
    const own = asked.find((job) => job.near && job.i === 0 && job.j === 0)!;
    expect(own.near!.edited).toBe(true);
    expect(own.near!.records![0]!.version).toBe(2);
    // A neighbour that reads the edited tile reads it from the page too, but is not the player's edit.
    for (const job of asked) if (job.near && (job.i !== 0 || job.j !== 0)) expect(job.near.edited).toBeUndefined();
    // Another edit of the tile that leaves its roads as they were (a building grown): nothing asked again.
    await until(over, () => roads.nearKeys().includes(farKey(0, 0, 0)) && !asked.some((job) => job.near && job.i === 0 && job.j === 0 && !job.near.edited));
    for (let k = 0; k < 50; k++) { over(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    asked.length = 0;
    edit = 2;
    for (let k = 0; k < 20; k++) { over(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    expect(asked.filter((job) => job.near).map((job) => `${job.i},${job.j} ${job.near!.bake} ${job.near!.variant} ${job.near!.edited}`)).toEqual([]);
    roads.dispose();
  });

  it("queues a near level as a cell's detail is, never behind the masses; an edited tile's before anything", () => {
    const job = (near?: { edited?: boolean }): FarTreeJob => ({
      node: 'n0:0,0', k: -1, i: 0, j: 0, sig: 's', want: true, prefix: null,
      ...(near ? { near: { tiles: [], bake: 'b', variant: 'full', shown: null, ...(near.edited ? { edited: true } : {}) } } : {}),
    });
    const shown = { ...kit, coarseFirst: () => false };
    const hidden = { ...kit, coarseFirst: () => true };
    expect(farRoadPriority(job(), shown)).toBe(FAR_TIER * TIER_SPAN);
    expect(farRoadPriority(job({ edited: true }), shown)).toBe(EDIT_TIER * TIER_SPAN);
    // In the cells' band (the queue adds the distance to the eye): a street's near roads ahead of a cell's facade or a mass 1 km off.
    expect(farRoadPriority(job({}), shown)).toBe(cellPriority('cell', 0, false, false));
    expect(farRoadPriority(job({}), shown) + m(100)).toBeLessThan(cellPriority('facade', m(1000), false, false));
    expect(farRoadPriority(job({}), shown) + m(100)).toBeLessThan(cellPriority('mass', m(1000), false, false));
    // Behind the curtain, put back with the cells past the masses the opening shows.
    expect(farRoadPriority(job({}), hidden)).toBe(cellPriority('cell', 0, false, true));
    expect(farRoadPriority(job({}), hidden)).toBeGreaterThan(cellPriority('massPlate', m(5000), false, true));
  });

  it("keeps a tile's near level drawn when its neighbour is written with the same roads: nothing made nor sent to the GPU again", async () => {
    const cache = memoryCache();
    const tiles = world();
    const roads = new FarRoads(() => null, runner(cache, kit), 'test:', kit);
    roads.setSource(storeOf(tiles), () => false);
    for (const [key, records] of tiles) roads.stored(key, records.version);
    const over = (): void => roads.choose(0.5 * TILE, 0.5 * TILE, m(300), 1000, null);
    await until(over, () => roads.nearKeys().includes(farKey(0, 0, 0)));
    for (let k = 0; k < 50; k++) { over(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    const before = roads.group.children.filter((o) => o.name === 'roads-near');
    // A neighbour written again with the same roads (a building grown on it): a new version.
    const key = tileKey(1, 0);
    roads.stored(key, tiles.get(key)!.version + 1);
    for (let k = 0; k < 50; k++) { over(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    // The very same groups: none made again (a neighbour reads tile (1, 0) too, its roads the same).
    expect(roads.group.children.filter((o) => o.name === 'roads-near')).toEqual(before);
    roads.dispose();
  });

  it('bakes again only the tile whose version changed and its ancestors', async () => {
    const cache = memoryCache();
    const tiles = world();
    const far = new FarRoads(() => null, runner(cache), 'test:');
    far.setSource(storeOf(tiles), () => false);
    for (const [key, records] of tiles) far.stored(key, records.version);
    const fromAfar = (): void => far.choose(0, 0, m(50_000), 1000, null);
    await until(fromAfar, () => far.waiting === 0);
    const before = cache.puts.length;
    expect(before).toBeGreaterThan(tiles.size);

    const changed = tileKey(1, 0);
    tiles.set(changed, crossTile(1, 0, 2));
    far.stored(changed, 2);
    const chain: string[] = [];
    for (let k = 0; k <= TOP_LEVEL; k++) chain.push(`test:${farKey(k, Math.floor(1 / 2 ** k), 0)}`);
    // The old top level stands while the new one is made (nothing waits): watched until the top is kept again, then a while longer.
    await until(fromAfar, () => cache.puts.slice(before).includes(chain[TOP_LEVEL]!));
    let turns = 0;
    await until(fromAfar, () => ++turns > 50);
    const again = cache.puts.slice(before).sort();
    expect(again).toEqual(chain.sort());
    far.dispose();
  });
});
