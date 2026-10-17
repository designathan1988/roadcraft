import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** While the map is made every worker of the pool makes a tile at once, but the save's: one tile lane on each, none stacked, none on the save's worker */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly asked: unknown[] = [];
  constructor() { FakeWorker.made.push(this); }
  postMessage(message: unknown): void { this.asked.push(message); }
  terminate(): void { /* the pool's workers outlive a lane */ }
}

/** The tiles a worker was asked to make. */
const tilesOn = (w: FakeWorker): number => w.asked.filter((m) => (m as { data?: { stream?: boolean } }).data?.stream === true).length;

describe('the tile generator in the opening rush', () => {
  beforeEach(() => {
    FakeWorker.made = [];
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    vi.stubGlobal('document', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('makes a tile on every worker but the save\'s, one each', async () => {
    const { jobPort, jobWorkers } = await import('@/jobs/jobPool');
    const { TileGenerator } = await import('@/tileGenerator');
    const save = jobPort('save') as unknown as { worker: FakeWorker };
    const generator = new TileGenerator({} as never);
    generator.setAside(true);
    expect(generator.lanesWanted).toBe(jobWorkers() - 1);
    // More tiles asked than lanes: the rest wait in the generator, not behind a tile on a worker.
    for (let k = 0; k < 3 * jobWorkers(); k++) void generator.makeStored(k, 'map', 0, false).catch(() => {});
    expect(FakeWorker.made).toHaveLength(jobWorkers());
    expect(tilesOn(save.worker)).toBe(0);
    const making = FakeWorker.made.filter((w) => w !== save.worker).map(tilesOn);
    expect(making).toEqual(new Array(jobWorkers() - 1).fill(1));
    generator.dispose();
  });
});
