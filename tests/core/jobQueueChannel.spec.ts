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

  it.each([[4, 2], [6, 4], [12, 9]])('runs on the first worker freed, ahead of the cells waiting, never pinned to one (%i cores, %i workers)', async (cores, workers) => {
    vi.stubGlobal('navigator', { hardwareConcurrency: cores });
    const { jobPort, jobQueueChannel, jobWorkers, queuePortWorker, submitJob } = await import('@/jobs/jobPool');
    expect(jobWorkers()).toBe(workers);
    // A tile being made, and a cell job of seconds on every other worker; one more cell waiting.
    jobPort('cityTiles').postMessage({ stream: true });
    for (let k = 0; k < workers; k++) submitJob({ service: 'cells', key: `cell ${k}`, priority: 5, write: () => ({ data: `cell ${k}`, transfer: [] }), done: () => {}, failed: () => {} });
    const busy = FakeWorker.made.filter((w) => jobsOf(w, 'cells').length > 0);
    expect(busy).toHaveLength(workers - 1);
    // The simulation's worker asks for a batch of pairs on its channel.
    const lane = queuePortWorker(jobQueueChannel('conflicts'));
    const heard: unknown[] = [];
    lane.onmessage = (event: MessageEvent) => heard.push(event.data);
    lane.postMessage({ kind: 'pairs', id: 7 });
    await settle();
    // No worker free: it waits in the queue, on none of them.
    expect(FakeWorker.made.every((w) => jobsOf(w, 'conflicts').length === 0)).toBe(true);
    // The last worker's cell ends: that worker takes the pairs, ahead of the cell still waiting.
    const freed = busy[busy.length - 1]!;
    answer(freed, jobsOf(freed, 'cells')[0]!, 'cell done');
    const pairs = jobsOf(freed, 'conflicts');
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.data).toEqual({ kind: 'pairs', id: 7, quiet: true });
    // Its answer comes back on the channel it was asked on.
    answer(freed, pairs[0]!, { id: 7, tables: [] });
    await settle();
    expect(heard).toEqual([{ id: 7, tables: [] }]);
    lane.terminate();
  });
});
