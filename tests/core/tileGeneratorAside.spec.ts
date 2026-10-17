import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToJob } from '@/jobs/jobScope';

/** The opening's rush: tile lanes set aside on the other kinds' workers never on the save's, one of them always left to the queue, and none kept once no tile waits */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly asked: ToJob[] = [];
  constructor() { FakeWorker.made.push(this); }
  postMessage(message: ToJob): void { this.asked.push(message); }
  terminate(): void { /* the pool's workers outlive a lane */ }
}

/** The tiles a worker was asked to make. */
const tilesOn = (w: FakeWorker): ToJob[] => w.asked.filter((m) => (m.data as { stream?: boolean } | undefined)?.stream === true);

describe('the tile generator in the opening rush', () => {
  beforeEach(() => {
    FakeWorker.made = [];
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    vi.stubGlobal('document', {});
  });
  afterEach(() => {
    vi.doUnmock('@/jobs/jobPool');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([[6, 4], [12, 9]])("makes a tile on the queue's worker while the queue is quiet, gives it back when a job comes, never on the save's (%i cores, %i workers)", async (cores, workers) => {
    vi.stubGlobal('navigator', { hardwareConcurrency: cores });
    const { jobPort, jobWorkers, submitJob } = await import('@/jobs/jobPool');
    expect(jobWorkers()).toBe(workers);
    const { TileGenerator } = await import('@/tileGenerator');
    const save = (jobPort('save') as unknown as { worker: FakeWorker }).worker;
    const generator = new TileGenerator({} as never);
    generator.setAside(true);
    for (let k = 0; k < 3 * jobWorkers(); k++) void generator.makeStored(k, 'map', 0, false).catch(() => {});
    // The queue quiet: every worker but the save's makes one tile.
    expect(tilesOn(save)).toEqual([]);
    const making = FakeWorker.made.filter((w) => tilesOn(w).length > 0);
    expect(making).toHaveLength(jobWorkers() - 1);
    expect(making.every((w) => tilesOn(w).length === 1)).toBe(true);
    const lanes = (generator as unknown as { lanes: { aside: boolean; port: { worker: FakeWorker } }[] }).lanes;
    const queueWorker = lanes.find((l) => l.aside)!.port.worker;
    // A cell job comes: it waits for the tile in flight on the queue's worker, and no tile follows it there.
    submitJob({ service: 'cells', key: null, priority: 0, write: () => ({ data: 'cell', transfer: [] }), done: () => {}, failed: () => {} });
    const job = queueWorker.asked.find((m) => m.data === 'cell')!;
    expect(job).toBeDefined();
    const tile = tilesOn(queueWorker)[0]!;
    queueWorker.onmessage!({ data: { port: tile.port, data: { key: 0, stored: 1 } } });
    expect(tilesOn(queueWorker)).toHaveLength(1);
    // The job answered, the queue quiet again: the next tile goes to the queue's worker.
    queueWorker.onmessage!({ data: { port: job.port, data: 'cell done', seq: job.seq } });
    expect(tilesOn(queueWorker)).toHaveLength(2);
    expect(tilesOn(save)).toEqual([]);
    generator.dispose();
  });

  it('lets a lane set aside go once no tile waits, even when a tile failed and the map is never counted made', async () => {
    // A pool whose other kinds have workers to spare: lanes are set aside on them.
    vi.doMock('@/jobs/jobPool', async (original) => ({ ...(await original<typeof import('@/jobs/jobPool')>()), shortWorkers: () => 4 }));
    const { TileGenerator, tileLanes } = await import('@/tileGenerator');
    const generator = new TileGenerator({} as never);
    generator.setAside(true);
    const asked = Array.from({ length: tileLanes() + 2 }, (_, k) => k).map((k) => generator.makeStored(k, 'map', 0, false).catch(() => 'failed'));
    const lanes = (generator as unknown as { lanes: { aside: boolean; port: { worker: FakeWorker }; busy: unknown }[] }).lanes;
    const aside = lanes.filter((l) => l.aside);
    expect(aside.length).toBeGreaterThan(0);
    // Every tile answered, the first aside one as failed; setAside(true) never turned off.
    for (let n = 0, lane = lanes.find((l) => l.busy); lane && n < 100; n++, lane = lanes.find((l) => l.busy)) {
      const m = tilesOn(lane.port.worker).at(-1)!;
      const failed: boolean = lane === aside[0];
      lane.port.worker.onmessage!({ data: { port: m.port, data: failed ? { i: 0, j: 0, error: 'broken' } : { key: 0, stored: 1 } } });
    }
    expect(await Promise.all(asked)).toContain('failed');
    expect(lanes.filter((l) => l.aside)).toEqual([]);
    generator.dispose();
  });
});
