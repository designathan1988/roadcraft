import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToJob } from '@/jobs/jobScope';
import { tileKey } from '@world/tiles';

/** A stored tile's bays (low work) start only while the job queue is quiet: a queued job never waits for the bays of the whole map */
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

/** Every bays ask posted so far. */
const bays = (): ToJob[] => FakeWorker.made.flatMap((w) => w.asked.filter((m) => (m.data as { store?: { baysOnly?: boolean } } | undefined)?.store?.baysOnly === true));

describe("the tile generator's bays", () => {
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

  it('start none while a queued job runs, go on two at a time once the queue is quiet, and start no more when a job comes', async () => {
    const { submitJob } = await import('@/jobs/jobPool');
    const { TileGenerator } = await import('@/tileGenerator');
    const job = (name: string): void => { submitJob({ service: 'cells', key: null, priority: 0, write: () => ({ data: name, transfer: [] }), done: () => {}, failed: () => {} }); };
    const answerJob = (name: string): void => {
      const w = FakeWorker.made.find((x) => x.asked.some((m) => m.data === name && m.seq !== undefined))!;
      const m = w.asked.find((x) => x.data === name)!;
      w.onmessage!({ data: { port: m.port, data: `${name} done`, seq: m.seq } });
    };
    job('cell');
    const generator = new TileGenerator({} as never);
    for (let k = 0; k < 6; k++) void generator.makeStored(k, 'map', 0, false, false, true).catch(() => {});
    expect(bays()).toEqual([]);
    answerJob('cell');
    // Two at most under way: the tile workers stay free for what the view asks.
    const started = bays();
    expect(started).toHaveLength(2);
    // A job comes while bays run: the one under way ends, no other begins.
    job('near roads');
    const first = started[0]!;
    const host = FakeWorker.made.find((w) => w.asked.includes(first))!;
    const at = first.data as { i: number; j: number };
    host.onmessage!({ data: { port: first.port, data: { key: tileKey(at.i, at.j), stored: 1, existed: true } } });
    expect(bays()).toHaveLength(started.length);
    answerJob('near roads');
    // One under way still, one more begun: two again.
    expect(bays()).toHaveLength(3);
    generator.dispose();
  });
});
