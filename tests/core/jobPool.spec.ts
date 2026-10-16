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

  it('puts a lane let go back in the count: the next lane takes the worker it freed', async () => {
    const { jobPort } = await import('@/jobs/jobPool');
    const lanes = [0, 1, 2, 3].map(() => jobPort('bays'));
    const freed = hostOf(lanes[2]!);
    lanes[2]!.terminate();
    expect(hostOf(jobPort('ecology'))).toBe(freed);
  });
});
