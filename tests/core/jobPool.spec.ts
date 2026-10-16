import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToJob } from '@/jobs/jobScope';

/** Where the job system puts a lane: never behind a long-running service, a kind's lanes apart, the least busy worker */
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

/** Which fake worker a port posts to. */
function hostOf(port: Worker): number {
  port.postMessage({});
  return FakeWorker.made.findIndex((w) => w.asked.length > 0 && w.asked.splice(0).length > 0);
}

describe('the job system', () => {
  beforeEach(() => {
    FakeWorker.made = [];
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: 6 });
    vi.stubGlobal('document', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('gives growth a worker no other lane shares, and spreads a kind\'s lanes over different workers', async () => {
    const { jobPort, jobWorkers } = await import('@/jobs/jobPool');
    expect(jobWorkers()).toBe(4);
    const growth = hostOf(jobPort('growth'));
    const roads = [0, 1, 2].map(() => hostOf(jobPort('roadTiles')));
    const cells = [0, 1, 2].map(() => hostOf(jobPort('cells')));
    expect(roads).not.toContain(growth);
    expect(cells).not.toContain(growth);
    expect(new Set(roads).size).toBe(3);
    expect(new Set(cells).size).toBe(3);
  });

  it('runs queued jobs nearest first on any free worker, never behind growth, a newer job of a key replacing the older', async () => {
    const { jobPort, submitJob } = await import('@/jobs/jobPool');
    const growth = hostOf(jobPort('growth'));
    const done: string[] = [];
    const written: string[] = [];
    const job = (name: string, priority: number, key: string | null = null) => submitJob({
      service: 'cells', key, priority,
      write: () => { written.push(name); return { data: name, transfer: [] }; },
      done: (answer) => done.push(String(answer)),
      failed: () => done.push(`failed ${name}`),
    });
    // Four workers, one of them growth's: three jobs at once.
    for (const [name, priority] of [['a', 5], ['b', 4], ['c', 3]] as const) job(name, priority);
    job('far', 900);
    const old = job('old', 10, 'cell 1');
    job('new', 20, 'cell 1');
    job('near', 1);
    expect(old.pending).toBe(false);
    const busy = FakeWorker.made.map((w) => w.asked.filter((m) => m.seq !== undefined));
    expect(busy[growth]).toEqual([]);
    expect(written).toEqual(['a', 'b', 'c']);
    // Each answer frees its worker for the nearest job waiting.
    const answer = (name: string): void => {
      const w = FakeWorker.made.find((x) => x.asked.some((m) => m.data === name))!;
      const m = w.asked.find((x) => x.data === name)!;
      w.onmessage!({ data: { port: m.port, data: `${name} done`, seq: m.seq } });
    };
    answer('b');
    answer('a');
    answer('c');
    expect(written).toEqual(['a', 'b', 'c', 'near', 'new', 'far']);
    expect(done).toEqual(['b done', 'a done', 'c done']);
  });

  it('drops the answer of a job cancelled while it ran', async () => {
    const { submitJob } = await import('@/jobs/jobPool');
    const done: unknown[] = [];
    const ticket = submitJob({ service: 'cells', key: null, priority: 0, write: () => ({ data: 'x', transfer: [] }), done: (a) => done.push(a), failed: () => done.push('failed') });
    const w = FakeWorker.made.find((x) => x.asked.length > 0)!;
    ticket.cancel();
    const m = w.asked[0]!;
    w.onmessage!({ data: { port: m.port, data: 'late', seq: m.seq } });
    expect(done).toEqual([]);
    expect(ticket.pending).toBe(false);
  });

  it('puts a lane let go back in the count: the next lane takes the worker it freed', async () => {
    const { jobPort } = await import('@/jobs/jobPool');
    const lanes = [0, 1, 2, 3].map(() => jobPort('bays'));
    const freed = hostOf(lanes[2]!);
    lanes[2]!.terminate();
    expect(hostOf(jobPort('ecology'))).toBe(freed);
  });
});
