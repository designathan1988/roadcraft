import { describe, expect, it } from 'vitest';
import { tileKey } from '@world/tiles';
import { m } from '@world/units';
import type { TileRecords } from '@world/doc';
import { emptyRecords } from '@render/buildings/farGrid';
import type { NearTileJob, NearTileReply } from '@render/nearTileBake';
import { type NearLanded, type NearProduct, NearTiles } from '@render/nearTiles';

/** THE NEAR PRODUCTS' CHOICE OF TILES (`nearTiles.ts`): by the view, the bake drawn standing until the next one lands */

/** A product whose bakes are strings, its landings written down. */
function product(log: string[], ready?: () => Promise<void>): NearProduct<string> {
  return {
    kind: 'poles', cover: m(2) * m(2), top: m(9),
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
      jobs.set(job.node, { job, done });
      return () => { if (jobs.get(job.node)?.job === job) jobs.delete(job.node); };
    },
  };
}

const answer = (held: { job: NearTileJob; done: (reply: NearTileReply) => void }, payload: string): void =>
  held.done({ kind: 'near', node: held.job.node, sig: held.job.sig, bake: `${held.job.want}#${payload}`, payload, same: false });

describe('the near products chosen by tile', () => {
  it('asks the tiles where the kind spans a pixel, keeps a bake drawn until the next lands, and lets go what the view leaves', () => {
    const log: string[] = [];
    const { jobs, run } = runs();
    const near = new NearTiles(run, null);
    near.add(product(log));
    for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) near.stored(tileKey(i, j), 1);
    near.setSource({ records: async (key) => emptyRecords(key, 1), plan: null }, () => false);
    // Over tile (0, 0) at 100 m, 1000 px a metre at a metre: a 2 m piece spans a pixel to 2 km.
    near.choose(m(512), m(512), m(100), 1000, null);
    expect(jobs.has('poles:0,0')).toBe(true);
    expect(jobs.has('poles:2,0')).toBe(true);
    expect(jobs.has('poles:3,0')).toBe(false);
    const first = jobs.get('poles:0,0')!;
    answer(first, 'a');
    expect(log).toEqual([`put ${tileKey(0, 0)} a`]);
    expect(near.heldKeys('poles')).toEqual([tileKey(0, 0)]);
    // The tile written again: asked again, the bake drawn standing meanwhile.
    near.stored(tileKey(0, 0), 2);
    near.choose(m(512), m(512), m(100), 1000, null);
    const again = jobs.get('poles:0,0')!;
    // The bake drawn named: a worker that makes the same sends nothing back.
    expect(again.job.shown).toBe(`${first.job.want}#a`);
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
    answer(jobs.get('poles:0,0')!, 'a');
    expect(log).toEqual([]);
    release();
    await Promise.resolve();
    expect(log).toEqual([`put ${tileKey(0, 0)} a`]);
    near.stored(tileKey(0, 0), 2);
    near.choose(m(512), m(512), m(100), 1000, null);
    answer(jobs.get('poles:0,0')!, 'b');
    expect(log).toEqual([`put ${tileKey(0, 0)} a`]);
    release();
    await Promise.resolve();
    expect(log).toEqual([`put ${tileKey(0, 0)} a`, `remove ${tileKey(0, 0)} a`, `put ${tileKey(0, 0)} b`]);
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
    expect(jobs.get('poles:0,0')!.job.records).toBeUndefined();
    edit = 3;
    near.choose(m(512), m(512), m(100), 1000, null);
    const job = jobs.get('poles:0,0')!.job;
    expect(job.records?.[0]?.poles).toEqual(page.poles);
    // The page's buildings never posted to a kind that reads none.
    expect(job.records?.[0]?.buildings).toBeUndefined();
    expect(job.records?.slice(1).every((r) => r === null)).toBe(true);
  });
});
