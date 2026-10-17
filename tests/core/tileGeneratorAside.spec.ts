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

  it('leaves the save\'s worker and one other to the queue: a queued job never waits behind a tile', async () => {
    const { jobPort, jobWorkers, submitJob } = await import('@/jobs/jobPool');
    const { TileGenerator } = await import('@/tileGenerator');
    const save = (jobPort('save') as unknown as { worker: FakeWorker }).worker;
    const generator = new TileGenerator({} as never);
    generator.setAside(true);
    for (let k = 0; k < 3 * jobWorkers(); k++) void generator.makeStored(k, 'map', 0, false).catch(() => {});
    expect(tilesOn(save)).toEqual([]);
    const making = FakeWorker.made.filter((w) => tilesOn(w).length > 0);
    expect(making.every((w) => tilesOn(w).length === 1)).toBe(true);
    // A cell job asked in the rush: on a worker making no tile, not the save's.
    submitJob({ service: 'cells', key: null, priority: 0, write: () => ({ data: 'cell', transfer: [] }), done: () => {}, failed: () => {} });
    const host = FakeWorker.made.find((w) => w.asked.some((m) => m.data === 'cell'));
    expect(host).toBeDefined();
    expect(host).not.toBe(save);
    expect(tilesOn(host!)).toEqual([]);
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
    for (const lane of lanes.filter((l) => l.busy)) {
      const m = tilesOn(lane.port.worker).at(-1)!;
      const failed = lane === aside[0];
      lane.port.worker.onmessage!({ data: { port: m.port, data: failed ? { i: 0, j: 0, error: 'broken' } : { key: 0, stored: 1 } } });
    }
    expect(await Promise.all(asked)).toContain('failed');
    expect(lanes.filter((l) => l.aside)).toEqual([]);
    generator.dispose();
  });
});
