import { describe, expect, it } from 'vitest';
import { tileKey, tileOfKey } from '@world/tiles';
import { m } from '@world/units';
import type { TileRecords } from '@world/doc';
import { emptyRecords } from '@render/buildings/farGrid';
import type { NearKind, NearTileJob, NearTileReply } from '@render/nearTileBake';
import { NearGate, type NearLanded, type NearProduct, NearTiles, nearPriority } from '@render/nearTiles';
import { EDIT_TIER, NEAR_TIER, TIER_SPAN, cellPriority } from '@render/buildings/cellPool';

/** THE NEAR PRODUCTS' CHOICE OF TILES (`nearTiles.ts`): by the view, the bake drawn standing until the next one lands */

/** A product whose bakes are strings, its landings written down. */
function product(log: string[], ready?: () => Promise<void>, kind: NearKind = 'poles'): NearProduct<string> {
  return {
    kind, cover: m(2) * m(2), top: m(9),
    land(payload, tile): NearLanded {
      return {
        put: () => log.push(`put ${tile} ${payload}`),
        remove: () => log.push(`remove ${tile} ${payload}`),
        ...(ready ? { ready: ready() } : {}),
      };
    },
  };
}

/** A run that keeps every job asked, answered by hand. */
function runs(): { jobs: Map<string, { job: NearTileJob; done: (reply: NearTileReply) => void }>; run: (job: NearTileJob, done: (reply: NearTileReply) => void) => () => void } {
  const jobs = new Map<string, { job: NearTileJob; done: (reply: NearTileReply) => void }>();
  return {
    jobs,
    run: (job, done) => {
      jobs.set(job.heavy ? job.node : `${job.node}:light`, { job, done });
      const key = job.heavy ? job.node : `${job.node}:light`;
      return () => { if (jobs.get(key)?.job === job) jobs.delete(key); };
    },
  };
}

const answer = (held: { job: NearTileJob; done: (reply: NearTileReply) => void }, payload: string): void =>
  held.done({ kind: 'near', node: held.job.node, answers: held.job.asks.map((a) => ({ kind: a.kind, sig: a.sig, bake: `${a.want}#${payload}`, payload, same: false })) });

describe('the near products chosen by tile', () => {
  it('keeps its jobs on a few workers at once, the rest free for the cells and roads; the nearest waiting sent first, an edit before it', () => {
    const job = (i: number, edited = false): NearTileJob => ({ node: `${i},0`, asks: [], prefix: null, heavy: false, tiles: [{ key: tileKey(i, 0), version: 1 }], ground: { ground: null, naturalIsGround: true }, ...(edited ? { edited } : {}) });
    const sent: string[] = [];
    const gate = new NearGate(() => 2, (j) => Math.abs(tileOfKey(j.tiles[0]!.key).i) * 1000);
    const ask = (j: NearTileJob): (() => void) => gate.ask(j, () => { sent.push(j.node); return { cancel: () => sent.push(`cancel ${j.node}`) }; });
    ask(job(5)); ask(job(1));
    const far = ask(job(9));
    ask(job(3)); ask(job(7, true));
    expect(sent).toEqual(['5,0', '1,0']);
    expect(gate.queued).toBe(3);
    // A job answered: the edit next, then the nearest.
    gate.settle();
    expect(sent.at(-1)).toBe('7,0');
    gate.settle();
    expect(sent.at(-1)).toBe('3,0');
    // One waiting cancelled is never sent; one running cancelled frees its place.
    far();
    expect(gate.queued).toBe(0);
    gate.settle();
    expect(sent).not.toContain('9,0');
  });

  it('waits in the queue behind every cell, mass and road near level, whatever the distances, and goes before them only for an edit of what it reads', () => {
    // The queue's rank: the band plus the distance to the view's focus (`jobPool.ts` rankOf); the farthest a map can put two jobs apart.
    const far = m(100_000);
    const product = nearPriority({}), edit = nearPriority({ edited: true });
    for (const kind of ['cell', 'facade', 'mass', 'massTile', 'massPlate'] as const) expect(product).toBeGreaterThan(cellPriority(kind, far, false, false));
    // The roads' near level of a tile 100 km away still comes before a near product at the camera.
    expect(product).toBeGreaterThan(NEAR_TIER * TIER_SPAN + far);
    expect(edit).toBe(EDIT_TIER * TIER_SPAN);
    expect(edit + far).toBeLessThan(cellPriority('cell', 0, false, false));
  });

  it('chooses nothing again on the frames where the eye, the view, the stored tiles, the edits and the kinds stand as they were', () => {
    const log: string[] = [];
    const { run } = runs();
    const near = new NearTiles(run, null);
    // Every look the choice takes at a kind (its reach and height), counted.
    let looks = 0;
    const counted = product(log);
    near.add(Object.defineProperties({ ...counted }, {
      cover: { get: () => { looks++; return counted.cover; } },
      top: { get: () => { looks++; return counted.top; } },
    }) as NearProduct<string>);
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) near.stored(tileKey(i, j), 1);
    let edit = 0;
    near.setSource({ records: async (key) => emptyRecords(key, 1), plan: null, pageEdit: () => edit, pageRecords: (key) => emptyRecords(key, 1) }, () => false);
    near.choose(m(512), m(512), m(100), 1000, null);
    expect(looks).toBeGreaterThan(0);
    // The frames of a still camera: nothing walked.
    looks = 0;
    for (let f = 0; f < 60; f++) near.choose(m(512), m(512), m(100), 1000, null);
    expect(looks).toBe(0);
    // A tile written, an edit, the eye moved: chosen again each time.
    near.stored(tileKey(2, 2), 2);
    near.choose(m(512), m(512), m(100), 1000, null);
    expect(looks).toBeGreaterThan(0);
    looks = 0;
    edit = 7;
    near.choose(m(512), m(512), m(100), 1000, null);
    expect(looks).toBeGreaterThan(0);
    looks = 0;
    near.choose(m(600), m(512), m(100), 1000, null);
    expect(looks).toBeGreaterThan(0);
  });

  it('asks the tiles where the kind spans a pixel, keeps a bake drawn until the next lands, and lets go what the view leaves', () => {
    const log: string[] = [];
    const { jobs, run } = runs();
    const near = new NearTiles(run, null);
    near.add(product(log));
    for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) near.stored(tileKey(i, j), 1);
    near.setSource({ records: async (key) => emptyRecords(key, 1), plan: null }, () => false);
    // Over tile (0, 0) at 100 m, 1000 px a metre at a metre: a 2 m piece spans a pixel to 2 km.
    near.choose(m(512), m(512), m(100), 1000, null);
    expect(jobs.has('0,0')).toBe(true);
    expect(jobs.has('2,0')).toBe(true);
    expect(jobs.has('3,0')).toBe(false);
    const first = jobs.get('0,0')!;
    answer(first, 'a');
    expect(log).toEqual([`put ${tileKey(0, 0)} a`]);
    expect(near.heldKeys('poles')).toEqual([tileKey(0, 0)]);
    // The tile written again: asked again, the bake drawn standing meanwhile.
    near.stored(tileKey(0, 0), 2);
    near.choose(m(512), m(512), m(100), 1000, null);
    const again = jobs.get('0,0')!;
    // The bake drawn named: a worker that makes the same sends nothing back.
    expect(again.job.asks[0]!.shown).toBe(`${first.job.asks[0]!.want}#a`);
    expect(log).toEqual([`put ${tileKey(0, 0)} a`]);
    answer(again, 'b');
    expect(log).toEqual([`put ${tileKey(0, 0)} a`, `remove ${tileKey(0, 0)} a`, `put ${tileKey(0, 0)} b`]);
    // The camera gone 6 km away: the tile let go.
    near.choose(m(6000), m(512), m(100), 1000, null);
    expect(log.at(-1)).toBe(`remove ${tileKey(0, 0)} b`);
    expect(near.heldKeys('poles')).toEqual([]);
  });

  it('puts a bake in place only once it can be drawn, the one before standing until then', async () => {
    const log: string[] = [];
    const { jobs, run } = runs();
    let release: () => void = () => {};
    const near = new NearTiles(run, null);
    near.add(product(log, () => new Promise<void>((resolve) => { release = resolve; })));
    near.stored(tileKey(0, 0), 1);
    near.setSource({ records: async (key) => emptyRecords(key, 1), plan: null }, () => false);
    near.choose(m(512), m(512), m(100), 1000, null);
    answer(jobs.get('0,0')!, 'a');
    expect(log).toEqual([]);
    release();
    await Promise.resolve();
    expect(log).toEqual([`put ${tileKey(0, 0)} a`]);
    near.stored(tileKey(0, 0), 2);
    near.choose(m(512), m(512), m(100), 1000, null);
    answer(jobs.get('0,0')!, 'b');
    expect(log).toEqual([`put ${tileKey(0, 0)} a`]);
    release();
    await Promise.resolve();
    expect(log).toEqual([`put ${tileKey(0, 0)} a`, `remove ${tileKey(0, 0)} a`, `put ${tileKey(0, 0)} b`]);
  });

  it('asks the kinds of a tile in two jobs, the light kinds (no roads) apart from the heavy, a job under way replaced by one asking its kinds again', () => {
    const log: string[] = [];
    const { jobs, run } = runs();
    const near = new NearTiles(run, null);
    near.add(product(log, undefined, 'poles'));
    near.add(product(log, undefined, 'signs'));
    near.add(product(log, undefined, 'barriers'));
    near.stored(tileKey(0, 0), 1);
    near.setSource({ records: async (key) => emptyRecords(key, 1), plan: null }, () => false);
    near.choose(m(512), m(512), m(100), 1000, null);
    expect(jobs.size).toBe(2);
    expect(jobs.get('0,0')!.job.heavy).toBe(true);
    expect(jobs.get('0,0')!.job.asks.map((a) => a.kind)).toEqual(['poles', 'signs']);
    expect(jobs.get('0,0:light')!.job.asks.map((a) => a.kind)).toEqual(['barriers']);
    // The light job lands without waiting for the roads' kinds.
    answer(jobs.get('0,0:light')!, 'a');
    expect(log).toEqual([`put ${tileKey(0, 0)} a`]);
    const first = jobs.get('0,0')!;
    answer(first, 'a');
    expect(log).toHaveLength(3);
    // The tile written again: each job asks its kinds again; a late answer of the one replaced is dropped.
    near.stored(tileKey(0, 0), 2);
    near.choose(m(512), m(512), m(100), 1000, null);
    const second = jobs.get('0,0')!;
    expect(second.job.asks.map((a) => a.kind)).toEqual(['poles', 'signs']);
    answer(first, 'stale');
    expect(log).toHaveLength(3);
    answer(second, 'b');
    expect(log.slice(3)).toEqual([`remove ${tileKey(0, 0)} a`, `put ${tileKey(0, 0)} b`, `remove ${tileKey(0, 0)} a`, `put ${tileKey(0, 0)} b`]);
  });

  it('says when a tile\'s bake first lands and when it goes, so what the page drew there stands until then', () => {
    const log: string[] = [];
    const { jobs, run } = runs();
    const near = new NearTiles(run, null);
    near.add(product(log));
    const told: string[] = [];
    near.onLanded = (kind, tile) => told.push(`${kind} ${tile} ${near.landed(kind, tile)}`);
    near.stored(tileKey(0, 0), 1);
    near.setSource({ records: async (key) => emptyRecords(key, 1), plan: null }, () => false);
    near.choose(m(512), m(512), m(100), 1000, null);
    // Asked, not landed: the page's own still stands.
    expect(near.landed('poles', tileKey(0, 0))).toBe(false);
    expect(told).toEqual([]);
    answer(jobs.get('0,0')!, 'a');
    expect(told).toEqual([`poles ${tileKey(0, 0)} true`]);
    // A newer bake replacing it tells nothing; the tile let go does.
    near.stored(tileKey(0, 0), 2);
    near.choose(m(512), m(512), m(100), 1000, null);
    answer(jobs.get('0,0')!, 'b');
    expect(told).toHaveLength(1);
    near.choose(m(6000), m(512), m(100), 1000, null);
    expect(told.at(-1)).toBe(`poles ${tileKey(0, 0)} false`);
  });

  it('asks nothing for an edit that leaves what the kind reads as it was, and puts first only an edit that changed it', () => {
    const log: string[] = [];
    const { jobs, run } = runs();
    const near = new NearTiles(run, null);
    near.add(product(log));
    near.stored(tileKey(0, 0), 1);
    let edit = 1;
    let poles = [{ id: 7 as never, x: m(10), y: m(10), lamp: true }];
    let reads = 0;
    near.setSource({
      records: async (key) => emptyRecords(key, 1), plan: null,
      pageEdit: () => edit,
      // Each read a new object, as the page's document gives one (`RoadDoc.tileRecords`).
      pageRecords: (key) => { reads++; return { ...emptyRecords(key, 1), poles: poles.map((p) => ({ ...p })) }; },
    }, () => false);
    near.choose(m(512), m(512), m(100), 1000, null);
    const first = jobs.get('0,0')!;
    expect(first.job.edited).toBeUndefined();
    answer(first, 'a');
    jobs.clear();
    // A building grown: another edit, the poles as they were. The page's records read once for the edit, no job.
    edit = 2;
    const before = reads;
    near.choose(m(512), m(512), m(100), 1000, null);
    near.choose(m(512), m(512), m(100), 1000, null);
    expect(jobs.size).toBe(0);
    expect(reads - before).toBe(1);
    // A pole moved: asked again, first in the queue.
    edit = 3;
    poles = [{ id: 7 as never, x: m(30), y: m(10), lamp: true }];
    near.choose(m(512), m(512), m(100), 1000, null);
    expect(jobs.get('0,0')!.job.edited).toBe(true);
    expect(jobs.get('0,0')!.job.records?.[0]?.poles).toEqual(poles);
  });

  it('bakes a tile the page holds edited from the page\'s records, from the edit on', () => {
    const log: string[] = [];
    const { jobs, run } = runs();
    const near = new NearTiles(run, null);
    near.add(product(log));
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) near.stored(tileKey(i, j), 1);
    let edit = 0;
    const page: TileRecords = { ...emptyRecords(tileKey(0, 0), 1), poles: [{ id: 7 as never, x: m(10), y: m(10), lamp: true }] };
    near.setSource({ records: async (key) => emptyRecords(key, 1), plan: null, pageEdit: (key) => (key === tileKey(0, 0) ? edit : 0), pageRecords: (key) => (key === tileKey(0, 0) ? page : null) }, () => false);
    near.choose(m(512), m(512), m(100), 1000, null);
    expect(jobs.get('0,0')!.job.records).toBeUndefined();
    edit = 3;
    near.choose(m(512), m(512), m(100), 1000, null);
    const job = jobs.get('0,0')!.job;
    expect(job.records?.[0]?.poles).toEqual(page.poles);
    // The page's buildings never posted to a kind that reads none.
    expect(job.records?.[0]?.buildings).toBeUndefined();
    expect(job.records?.slice(1).every((r) => r === null)).toBe(true);
  });
});
