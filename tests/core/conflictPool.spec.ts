import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SweepSamples } from '@world/conflictTable';
import type { ToJob } from '@/jobs/jobScope';

/** The conflict pool waits for a slow worker (it shares the job pool and the CPU share) and gives up only on a real failure */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  /** What the job pool posted to this worker: a port's message (`jobs/jobScope.ts` `ToJob`). */
  readonly asked: ToJob[] = [];
  constructor() { FakeWorker.made.push(this); }
  postMessage(message: ToJob): void { this.asked.push(message); }
  terminate(): void { /* the job pool's workers outlive a lane */ }
  /** A service's answer on `port`, as the job worker wraps it. */
  say(port: number, data: unknown): void { this.onmessage?.({ data: { port, data } }); }
}

const sweep = (): SweepSamples => ({ c0: 0, count: 1, length: 1, frame: new Float64Array(4), frameLengthSq: new Float64Array(1), bounds: null, grid: null, range: null } as unknown as SweepSamples);

/** The worker a conflicts job went to, its port and the job's id. */
function asked(): { worker: FakeWorker; port: number; id: number } {
  for (const worker of FakeWorker.made) {
    const message = worker.asked.find((m) => m.service === 'conflicts');
    if (message) return { worker, port: message.port, id: (message.data as { id: number }).id };
  }
  throw new Error('no conflicts job was posted');
}

describe('the conflict pool', () => {
  beforeEach(() => {
    FakeWorker.made = [];
    // A fresh job pool each test: its workers are made once per module.
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
    vi.stubGlobal('document', {});
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports a worker silent past the deadline and still takes its answer', async () => {
    const { ConflictPool, SILENCE_MS } = await import('@/conflictPool');
    const pool = new ConflictPool();
    const answer = pool.measure([{ a: sweep(), b: sweep() }]);
    const { worker, port, id } = asked();
    await vi.advanceTimersByTimeAsync(SILENCE_MS * 3);
    expect(console.warn).toHaveBeenCalledTimes(1);
    worker.say(port, { id, tables: [null] });
    await expect(answer).resolves.toEqual([null]);
    pool.dispose();
  });

  it('rejects the pairs of a worker that fails', async () => {
    const { ConflictPool } = await import('@/conflictPool');
    const pool = new ConflictPool();
    const answer = pool.measure([{ a: sweep(), b: sweep() }]);
    asked().worker.onerror?.({ message: 'boom' });
    await expect(answer).rejects.toThrow('boom');
  });

  it('waits past the deadline for a worker that keeps reporting as it works, without a word', async () => {
    const { ConflictPool, SILENCE_MS } = await import('@/conflictPool');
    const pool = new ConflictPool();
    const answer = pool.measure([{ a: sweep(), b: sweep() }]);
    const { worker, port, id } = asked();
    for (let k = 0; k < 4; k++) {
      await vi.advanceTimersByTimeAsync(SILENCE_MS / 2);
      worker.say(port, { id, beat: true });
    }
    worker.say(port, { id, tables: [null] });
    await expect(answer).resolves.toEqual([null]);
    expect(console.warn).not.toHaveBeenCalled();
    pool.dispose();
  });
});
