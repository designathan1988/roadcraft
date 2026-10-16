import { describe, expect, it } from 'vitest';

import { roadRecipes } from '@render/bake/roadRecipes';
import { TOP_LEVEL, emptyRecords, farKey, farNode } from '@render/buildings/farTiles';
import type { FarTileSource } from '@render/buildings/farLevels';
import { FarRoads } from '@render/farRoads';
import { type FarRoadCache, type FarRoadMesh, bakeTileRoads, farRoadTones, runFarRoadJob, tileNetwork } from '@render/farRoadTiles';
import type { FarTreeRun } from '@render/farTree';
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

/** The far jobs run here, as a worker runs them. */
const runner = (cache: FarRoadCache): FarTreeRun<FarRoadMesh> => (job, done) => {
  let live = true;
  void runFarRoadJob(job, cache).then((reply) => { if (live) done(reply); });
  return () => { live = false; };
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
    expect(again.payload!.index).toEqual(made.payload!.index);
    expect(cache.puts).toEqual([`test:${node}`]);
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
