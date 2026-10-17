import { refOf } from '@world/buildings/recordTable';
import { Frustum, Matrix4, PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';

import { readStoredTilesWith } from '@core/storedTiles';
import { prepareTile, preparedRecords } from '@editor/tileStore';
import type { CellMass } from '@render/buildings/cellArrays';
import { type CellJob, runCellJob } from '@render/buildings/cellWork';
import { FarLevels, type FarRun, type FarTileSource, farJobOf } from '@render/buildings/farLevels';
import { type FarCache, type FarJob, TOP_LEVEL, bakeTileMasses, emptyRecords, farKey, farNode, runFarJob, tileRows } from '@render/buildings/farTiles';
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
const storeOf = (tiles: ReadonlyMap<number, TileRecords>): FarTileSource => ({ records: (key) => Promise.resolve(tiles.get(key) ?? null), plan: null });

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
        entries: buildings.map((b, i) => ({ key: String(b.id), sig: i, digest: 0, record: refOf(b) })),
      };
      const reply = runCellJob(job, { groundAt, naturalAt });
      if (reply.kind !== 'done') throw new Error(reply.kind);
      const baked = bakeTileMasses(records, detail, { groundAt, naturalAt });
      expect(baked).not.toBeNull();
      expect(difference(baked, reply.result.mass ?? null)).toBe('');
    }
    // In a worker's job: the same, kept by the tile's version, its buildings asked only when not kept.
    const cache = memoryCache();
    const node = farKey(0, 0, 0);
    const asked = await runFarJob({ far: true, node, sig: '1', want: true, prefix: 'test:' }, cache);
    expect(asked.kind).toBe('farRecords');
    const made = await runFarJob({ far: true, node, sig: '1', want: true, prefix: 'test:', buildings: tileRows(buildings) }, cache);
    if (made.kind !== 'far') throw new Error(made.kind);
    expect(difference(made.mass, bakeTileMasses(records, TILE_DETAIL))).toBe('');
    const again = await runFarJob({ far: true, node, sig: '1', want: true, prefix: 'test:' }, cache);
    if (again.kind !== 'far') throw new Error(again.kind);
    expect(difference(again.mass, made.mass)).toBe('');
    // Each reader's part under its own key: the tile's masses, its plate's, its boxes.
    expect(cache.puts).toEqual([`test:${node}`, `test:${node}#plate`, `test:${node}#boxes`]);
  });

  it("a level-1 node keeps its tiles' plates merged: drawn again, its four tiles are not read", async () => {
    const cache = memoryCache();
    const gets: string[] = [];
    const watched: FarCache = { ...cache, get: (key) => { gets.push(key); return cache.get(key); } };
    // Its four tiles baked and kept first, as their jobs keep them.
    const quarters = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
    for (const [i, j] of quarters) {
      const buildings = [building(i * 2 + j, (i + 0.5) * TILE, (j + 0.5) * TILE)];
      const reply = await runFarJob({ far: true, node: farKey(0, i, j), sig: '1', want: false, prefix: 'test:', buildings: tileRows(buildings) }, watched);
      expect(reply.kind).toBe('far');
    }
    const children = quarters.map(([i, j]) => ({ key: farKey(0, i, j), sig: '1' }));
    const job: FarJob = { far: true, node: farKey(1, 0, 0), sig: 'q', want: true, prefix: 'test:', children };
    const first = await runFarJob(job, watched);
    if (first.kind !== 'far') throw new Error(first.kind);
    expect(first.mass).not.toBeNull();
    gets.length = 0;
    const again = await runFarJob(job, watched);
    if (again.kind !== 'far') throw new Error(again.kind);
    expect(difference(again.mass, first.mass)).toBe('');
    // The node's own entries only: no tile's entry read again.
    for (const key of gets) expect(key.startsWith(`test:${farKey(1, 0, 0)}`), key).toBe(true);
  });

  it("is posted, when the page read the tile, as its shared table's rows, no record of it", async () => {
    const buildings = [0, 1, 2, 3].map((n) => building(n, m(150) + n * m(80), m(300) + (n % 2) * m(60)));
    const stored: TileRecords = { ...emptyRecords(tileKey(0, 0), 1), buildings: buildings.map((b) => JSON.parse(JSON.stringify(b)) as unknown) };
    // As the desktop's store hands the page a tile (`TileStore.read`): prepared where it is read, its buildings read from its table.
    const prepared = prepareTile(stored, false);
    const job = farJobOf({ node: farKey(0, 0, 0), k: 0, i: 0, j: 0, sig: '1', want: true, prefix: null, records: preparedRecords(prepared) });
    expect('records' in job).toBe(false);
    expect(job.buildings).toHaveLength(1);
    expect(job.buildings![0]!.buffer).toBe(prepared.buildings);
    expect([...job.buildings![0]!.rows]).toEqual([0, 1, 2, 3]);
    // The worker's masses are the stored records' own.
    const made = await runFarJob(job, memoryCache());
    if (made.kind !== 'far') throw new Error(made.kind);
    expect(made.mass).not.toBeNull();
    expect(difference(made.mass, bakeTileMasses(stored, TILE_DETAIL))).toBe('');
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

    // From 6 km up: the boxes' levels' squares would be drawn wider than their least pixels (`farLevels.ts` BOX_PIXELS), so they refine; the plates' error (level 1) spans under the pixels.
    const fromHigh = (): void => far.choose(0, 0, m(6_000), 1000, null);
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

  it('waits only for the nodes in the view: those out of it are asked and drawn all the same, never waited for', async () => {
    const kit = createBuildingKit();
    const cache = memoryCache();
    const tiles = world();
    // Each answer a turn after its job, as a worker's: the tree chooses again between them (`again`).
    const later: FarRun = (job, done) => {
      let live = true;
      void runFarJob(job, cache).then((reply) => setTimeout(() => { if (live) done(reply); }, 0));
      return () => { live = false; };
    };
    const far = new FarLevels(kit, later, 'test:');
    far.setSource(storeOf(tiles), () => false);
    for (const [key, records] of tiles) far.stored(key, records.version);
    // 6 km up, looking up at the sky: no node of the city in the frustum.
    const camera = new PerspectiveCamera(35, 1, m(1), m(20_000));
    camera.position.set(0, m(6_000), 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, m(12_000), 0);
    camera.updateMatrixWorld();
    const sky = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const away = (): void => far.choose(0, 0, m(6_000), 1000, null, Infinity, sky);
    away();
    expect(far.waiting).toBe(0);
    // Chosen again by the tree itself as the answers come in (`again`): in the same frustum, still nothing waited for.
    for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(far.waiting).toBe(0);
    // Turned back to the city: the same nodes, already come, nothing to wait for and nothing missing.
    await until(away, () => far.shownKeys().length === 16);
    far.choose(0, 0, m(6_000), 1000, null);
    expect(far.waiting).toBe(0);
    expect([...coverage(far.shownKeys(), tiles.keys()).values()].every((c) => c === 1)).toBe(true);
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
    expect(cache.puts.filter((key) => key.startsWith('test:f0:') && !key.includes('#')).length).toBe(tiles.size);
    expect(new Set(cache.puts).size).toBe(cache.puts.length);

    cache.puts.length = 0;
    const changed = tileKey(0, 0);
    tiles.set(changed, { ...tiles.get(changed)!, version: 2, buildings: [...tiles.get(changed)!.buildings, building(999, 0.6 * TILE, 0.4 * TILE)] });
    far.stored(changed, 2);
    const chain = Array.from({ length: TOP_LEVEL + 1 }, (_, k) => `test:${farKey(k, 0, 0)}`);
    const nodes = (): string[] => [...new Set(cache.puts.map((key) => key.split('#')[0]!))];
    await until(fromAfar, () => nodes().length >= chain.length);
    // A few more turns: nothing else is baked.
    for (let turn = 0; turn < 5; turn++) { fromAfar(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    expect(nodes().sort()).toEqual([...chain].sort());
    far.dispose();
    kit.dispose();
  });

  it("hands the worker the store's map: a worker that reads the store bakes the tile with nothing of it through the page", async () => {
    const tiles = world();
    const key = tileKey(0, 0);
    // The job worker's reader of the store (`job.worker.ts`): the buildings' part as stored.
    readStoredTilesWith((map, at, part) => Promise.resolve(map === 'map' && part === 'buildings' && tiles.has(at) ? { buildings: tiles.get(at)!.buildings } : null));
    const kit = createBuildingKit();
    const cache = memoryCache();
    const jobs: FarJob[] = [];
    const run = runner(cache);
    const far = new FarLevels(kit, (job, done) => { jobs.push(job); return run(job, done); }, 'test:');
    let read = 0;
    far.setSource({ records: (at) => { read++; return Promise.resolve(tiles.get(at) ?? null); }, plan: null, workersRead: 'map' }, () => false);
    far.stored(key, 1);
    const over = (): void => far.choose(0.5 * TILE, 0.5 * TILE, m(300), 1000, null);
    await until(over, () => far.waiting === 0);
    expect(far.shownKeys()).toContain(farKey(0, 0, 0));
    expect(far.top()).toBeGreaterThan(0);
    const leaf = jobs.filter((job) => job.node === farKey(0, 0, 0));
    expect(leaf.length).toBeGreaterThan(0);
    for (const job of leaf) expect(job.store).toBe('map');
    expect(jobs.some((job) => job.buildings !== undefined)).toBe(false);
    expect(read).toBe(0);
    far.dispose();
    kit.dispose();
  });
});
