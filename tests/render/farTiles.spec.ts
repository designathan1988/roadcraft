import { describe, expect, it } from 'vitest';

import type { CellMass } from '@render/buildings/cellArrays';
import { type CellJob, runCellJob } from '@render/buildings/cellWork';
import { FarLevels, type FarRun, type FarTileSource } from '@render/buildings/farLevels';
import { type FarCache, TOP_LEVEL, bakeTileMasses, emptyRecords, farKey, farNode, runFarJob } from '@render/buildings/farTiles';
import { createBuildingKit } from '@render/buildings/kit';
import { PLATE_DETAIL, TILE_DETAIL } from '@render/buildings/massing';
import { drawsSignature } from '@render/buildings/signature';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { migrateBuilding } from '@world/buildings/serialize';
import type { Building } from '@world/buildings/types';
import { TILE, tileKey, tileOfKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { m } from '@world/units';

/** THE BUILDINGS FAR FROM THE CAMERA, BAKED PER TILE FROM THE TILE STORE (`farTiles.ts`, `farLevels.ts`) */
const groundAt = (x: number, y: number): number => x * 0.011 - y * 0.007 + Math.sin(x * 0.03) * m(0.3);
const naturalAt = (x: number, y: number): number => groundAt(x, y) - m(0.2);

const bodyOf = (index: number): Building => JSON.parse(JSON.stringify(BLUEPRINTS[index]!.body)) as Building;
/** The blueprints drawn by their masses (a signature one is drawn by a body of its own near, `signature.ts`). */
const PLAIN = BLUEPRINTS.map((_, i) => i).filter((i) => !drawsSignature({ ...bodyOf(i), id: 1, x: 0, y: 0, rotation: 0 } as Building));

/** A building as the document holds it once loaded (`BuildingStore.load` reads it with `migrateBuilding`). */
function building(n: number, x: number, y: number): Building {
  return migrateBuilding({ ...bodyOf(PLAIN[n % PLAIN.length]!), id: n + 1, x, y, rotation: 0.3 * n })!;
}

/** Every array of a mesh's arrays by its path, as bytes, and its other values. */
function leavesOf(o: unknown, path = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (ArrayBuffer.isView(o)) out.set(path, `${o.constructor.name}:${Buffer.from(o.buffer, o.byteOffset, o.byteLength).toString('base64')}`);
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) leavesOf(v, `${path}.${k}`, out);
  else out.set(path, o);
  return out;
}

/** Where two meshes' arrays differ, '' when they are the same to the byte. */
function difference(a: CellMass | null, b: CellMass | null): string {
  const x = leavesOf(a), y = leavesOf(b);
  for (const path of new Set([...x.keys(), ...y.keys()])) if (!Object.is(x.get(path), y.get(path))) return path || '(root)';
  return '';
}

/** A store of bakes in memory, as the browser's keeps them (a copy each), with every key written. */
function memoryCache(): FarCache & { readonly puts: string[] } {
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
const runner = (cache: FarCache): FarRun => (job, done) => {
  let live = true;
  void runFarJob(job, cache).then((reply) => { if (live) done(reply); });
  return () => { live = false; };
};

/** 8 x 8 tiles round the origin, two buildings each, as the store keeps them. */
function world(): Map<number, TileRecords> {
  const out = new Map<number, TileRecords>();
  let n = 0;
  for (let i = -4; i < 4; i++) {
    for (let j = -4; j < 4; j++) {
      const key = tileKey(i, j);
      out.set(key, { ...emptyRecords(key, 1), buildings: [building(n++, (i + 0.5) * TILE, (j + 0.5) * TILE), building(n++, (i + 0.25) * TILE, (j + 0.7) * TILE)] });
    }
  }
  return out;
}

/** The tile store as the coordinator wires it. */
const storeOf = (tiles: ReadonlyMap<number, TileRecords>): FarTileSource => ({ records: (key) => Promise.resolve(tiles.get(key) ?? null) });

/** How many nodes drawn stand for each tile of the world. */
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
  for (let turn = 0; turn < 500; turn++) {
    look();
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('the far levels never came');
}

describe('a tile baked from the store', () => {
  it("is its buildings' masses as the cells' job emits them, at the tile's level and the plate's", async () => {
    const buildings = [0, 1, 2, 3, 4, 5].map((n) => building(n, m(100) + n * m(70), m(200) + (n % 2) * m(90)));
    const records: TileRecords = { ...emptyRecords(tileKey(0, 0), 1), buildings: buildings.map((b) => JSON.parse(JSON.stringify(b)) as unknown) };
    for (const [kind, detail] of [['massTile', TILE_DETAIL], ['massPlate', PLATE_DETAIL]] as const) {
      const job: CellJob = {
        id: 1, kind, cell: 't:0,0', paved: false, boxes: { parts: {}, furniture: {} } as unknown as CellJob['boxes'],
        entries: buildings.map((b, i) => ({ key: String(b.id), sig: i, digest: 0, record: JSON.stringify(b) })),
      };
      const reply = runCellJob(job, { groundAt, naturalAt });
      if (reply.kind !== 'done') throw new Error(reply.kind);
      const baked = bakeTileMasses(records, detail, { groundAt, naturalAt });
      expect(baked).not.toBeNull();
      expect(difference(baked, reply.result.mass ?? null)).toBe('');
    }
    // In a worker's job: the same, kept by the tile's version, its records asked only when not kept.
    const cache = memoryCache();
    const node = farKey(0, 0, 0);
    const asked = await runFarJob({ far: true, node, sig: '1', want: true, prefix: 'test:' }, cache);
    expect(asked.kind).toBe('farRecords');
    const made = await runFarJob({ far: true, node, sig: '1', want: true, prefix: 'test:', records }, cache);
    if (made.kind !== 'far') throw new Error(made.kind);
    expect(difference(made.mass, bakeTileMasses(records, TILE_DETAIL))).toBe('');
    const again = await runFarJob({ far: true, node, sig: '1', want: true, prefix: 'test:' }, cache);
    if (again.kind !== 'far') throw new Error(again.kind);
    expect(difference(again.mass, made.mass)).toBe('');
    expect(cache.puts).toEqual([`test:${node}`]);
  });
});

describe('the far levels chosen top down', () => {
  it('draws only coarse levels from far, refining as the eye nears, never a tile the document holds', async () => {
    const kit = createBuildingKit();
    const cache = memoryCache();
    const tiles = world();
    const far = new FarLevels(kit, runner(cache), 'test:');
    let loaded: number | null = null;
    far.setSource(storeOf(tiles), (key) => key === loaded);
    for (const [key, records] of tiles) far.stored(key, records.version);

    // From 50 km up (0.0005 px a metre): the top level, a node a quarter round the origin.
    const fromAfar = (): void => far.choose(0, 0, m(50_000), 1000, 0.0005);
    await until(fromAfar, () => far.waiting === 0);
    const afar = far.shownKeys();
    expect(afar.length).toBe(4);
    for (const key of afar) expect(farNode(key).k).toBe(TOP_LEVEL);
    expect([...coverage(afar, tiles.keys()).values()].every((c) => c === 1)).toBe(true);
    expect(far.top()).toBeGreaterThan(0);

    // From 20 km up: the boxes' levels' error spans the pixels, the plates' (level 1) do not.
    const fromHigh = (): void => far.choose(0, 0, m(20_000), 1000, null);
    await until(fromHigh, () => far.waiting === 0);
    const high = far.shownKeys();
    expect(high.length).toBe(16);
    for (const key of high) expect(farNode(key).k).toBe(1);
    expect([...coverage(high, tiles.keys()).values()].every((c) => c === 1)).toBe(true);

    // Over a tile, low: that tile at its own level, the others no finer.
    const over = (): void => far.choose(0.5 * TILE, 0.5 * TILE, m(300), 1000, null);
    await until(over, () => far.waiting === 0);
    const near = far.shownKeys();
    expect(near).toContain(farKey(0, 0, 0));
    expect(near.length).toBeGreaterThan(high.length);
    expect([...coverage(near, tiles.keys()).values()].every((c) => c === 1)).toBe(true);

    // The streamer loads that tile into the document: the cells draw it, nothing here stands for it.
    loaded = tileKey(0, 0);
    far.loadedChanged(loaded);
    await until(over, () => far.waiting === 0);
    const held = coverage(far.shownKeys(), tiles.keys());
    expect(held.get(loaded)).toBe(0);
    for (const [tile, count] of held) if (tile !== loaded) expect(count).toBe(1);
    far.dispose();
    kit.dispose();
  });

  it("bakes again only a changed tile and its ancestors, the other tiles' bakes kept", async () => {
    const kit = createBuildingKit();
    const cache = memoryCache();
    const tiles = world();
    const far = new FarLevels(kit, runner(cache), 'test:');
    far.setSource(storeOf(tiles), () => false);
    for (const [key, records] of tiles) far.stored(key, records.version);
    const fromAfar = (): void => far.choose(0, 0, m(50_000), 1000, 0.0005);
    await until(fromAfar, () => far.waiting === 0);
    // Every tile baked once, and the levels above them.
    expect(cache.puts.filter((key) => key.startsWith('test:f0:')).length).toBe(tiles.size);
    expect(new Set(cache.puts).size).toBe(cache.puts.length);

    cache.puts.length = 0;
    const changed = tileKey(0, 0);
    tiles.set(changed, { ...tiles.get(changed)!, version: 2, buildings: [...tiles.get(changed)!.buildings, building(999, 0.6 * TILE, 0.4 * TILE)] });
    far.stored(changed, 2);
    const chain = Array.from({ length: TOP_LEVEL + 1 }, (_, k) => `test:${farKey(k, 0, 0)}`);
    await until(fromAfar, () => cache.puts.length >= chain.length);
    // A few more turns: nothing else is baked.
    for (let turn = 0; turn < 5; turn++) { fromAfar(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    expect([...cache.puts].sort()).toEqual([...chain].sort());
    far.dispose();
    kit.dispose();
  });
});
