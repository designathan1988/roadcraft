import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToJob } from '@/jobs/jobScope';

/** Another thread's conflict pairs and bays run as queued jobs of the page's pool (`jobQueueChannel`): on any free worker, never pinned to the one worker a small pool has for every other kind */
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

/** The queued jobs a worker was given of `service`. */
const jobsOf = (w: FakeWorker, service: string): ToJob[] => w.asked.filter((m) => m.service === service && m.seq !== undefined);
/** A queued job answered by its worker. */
const answer = (w: FakeWorker, m: ToJob, data: unknown): void => w.onmessage!({ data: { port: m.port, data, seq: m.seq } });
/** The channel's messages delivered (a MessagePort answers on a later turn). */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe("another thread's work on the page's job queue", () => {
  beforeEach(() => {
    FakeWorker.made = [];
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('document', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([[4, 2], [6, 4], [12, 9]])('waits behind every job of the view, never more than two on the workers (%i cores, %i workers)', async (cores, workers) => {
    vi.stubGlobal('navigator', { hardwareConcurrency: cores });
    const { jobPort, jobQueueChannel, jobWorkers, queuePortWorker, submitJob } = await import('@/jobs/jobPool');
    expect(jobWorkers()).toBe(workers);
    // A tile being made, a cell job of seconds on every other worker, and as many more cells waiting, far from the eye.
    jobPort('cityTiles').postMessage({ stream: true });
    const answered = new Set<ToJob>();
    const cell = (k: number): void => { submitJob({ service: 'cells', key: `cell ${k}`, priority: 0, at: [50_000, 0], write: () => ({ data: `cell ${k}`, transfer: [] }), done: () => {}, failed: () => {} }); };
    for (let k = 0; k < 2 * workers; k++) cell(k);
    const busy = FakeWorker.made.filter((w) => jobsOf(w, 'cells').length > 0);
    expect(busy).toHaveLength(workers - 1);
    // The simulation's worker asks four batches on its channels, pairs and bays.
    const lanes = [jobQueueChannel('conflicts'), jobQueueChannel('conflicts'), jobQueueChannel('bays'), jobQueueChannel('bays')].map((port) => queuePortWorker(port));
    const heard: unknown[] = [];
    for (const lane of lanes) lane.onmessage = (event: MessageEvent) => heard.push(event.data);
    lanes.forEach((lane, k) => lane.postMessage({ kind: 'pairs', id: k + 1 }));
    await settle();
    const simJobs = (): ToJob[] => FakeWorker.made.flatMap((w) => [...jobsOf(w, 'conflicts'), ...jobsOf(w, 'bays')]);
    /** Every cell job given and not answered yet, answered. */
    const endCells = (): void => {
      for (const w of FakeWorker.made) for (const m of jobsOf(w, 'cells')) if (!answered.has(m)) { answered.add(m); answer(w, m, 'cell done'); }
    };
    // Each cell that ends frees its worker for the next CELL waiting, never for the simulation's asks.
    for (const w of busy) { const m = jobsOf(w, 'cells')[0]!; answered.add(m); answer(w, m, 'cell done'); }
    expect(simJobs()).toEqual([]);
    // The view's work done: the asks run, two at a time at most (the tile's worker still busy).
    for (let round = 0; round < 3; round++) endCells();
    await settle();
    expect(simJobs()).toHaveLength(Math.min(2, workers - 1));
    expect(simJobs().every((m) => (m.data as { quiet?: boolean }).quiet === true)).toBe(true);
    // Each answer lets the next one go: all four answered on their channels.
    for (let n = 0; n < 8 && heard.length < 4; n++) {
      const open = FakeWorker.made.flatMap((w) => [...jobsOf(w, 'conflicts'), ...jobsOf(w, 'bays')].filter((m) => !answered.has(m)).map((m) => [w, m] as const))[0];
      if (open) { answered.add(open[1]); answer(open[0], open[1], { id: (open[1].data as { id: number }).id, tables: [] }); }
      await settle();
    }
    expect(heard.map((h) => (h as { id: number }).id).sort()).toEqual([1, 2, 3, 4]);
    for (const lane of lanes) lane.terminate();
  });
});
