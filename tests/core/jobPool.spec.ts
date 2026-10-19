import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToJob } from '@/jobs/jobScope';

/** Where the job system puts a lane: the long-running services on workers of their own, a kind's lanes apart, the least busy worker; a queued job never behind a tile */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly asked: ToJob[] = [];
  constructor() { FakeWorker.made.push(this); }
  postMessage(message: ToJob): void { this.asked.push(message); }
  ended = false;
  terminate(): void { this.ended = true; }
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

  it('keeps the long-running services and every other kind on workers apart, the lanes of a kind spread over its side', async () => {
    const { jobChannel, jobPort, jobWorkers, longWorkers, shortWorkers } = await import('@/jobs/jobPool');
    expect(jobWorkers()).toBe(4);
    expect([longWorkers(), shortWorkers()]).toEqual([2, 2]);
    // The traffic's lanes first (as the page opens), the tiles' and the growth's after: never on the traffic's workers.
    const conflicts = [0, 1].map(() => jobChannel('conflicts', () => {}));
    const traffic = FakeWorker.made.filter((w) => w.asked.some((m) => (m as unknown as { adopt?: string }).adopt === 'conflicts')).map((w) => FakeWorker.made.indexOf(w));
    // The adopt messages read: `hostOf` finds a worker by what it was last sent.
    for (const w of FakeWorker.made) w.asked.length = 0;
    const tiles = [0, 1].map(() => hostOf(jobPort('growth')));
    const growth = hostOf(jobPort('growth'));
    const roads = [0, 1].map(() => hostOf(jobPort('roadTiles')));
    expect(new Set(traffic).size).toBe(2);
    for (const t of [...tiles, growth]) expect(traffic).not.toContain(t);
    for (const r of roads) expect([...tiles, growth]).not.toContain(r);
    expect(new Set(tiles).size).toBe(2);
    expect(new Set(roads).size).toBe(2);
    expect(FakeWorker.made).toHaveLength(4);
    for (const port of conflicts) port.close();
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

  it('ranks the waiting jobs by where the view looks now, not where it looked when they were asked', async () => {
    const { jobPort, setJobFocus, submitJob } = await import('@/jobs/jobPool');
    hostOf(jobPort('growth'));
    const written: string[] = [];
    const job = (name: string, priority: number, at?: readonly [number, number]) => submitJob({
      service: 'cells', key: null, priority, ...(at ? { at } : {}),
      write: () => { written.push(name); return { data: name, transfer: [] }; },
      done: () => {}, failed: () => {},
    });
    setJobFocus(0, 0);
    // Every worker but growth's taken by jobs of seconds (the idle tile worker too).
    for (const name of ['busy1', 'busy2', 'busy3']) job(name, -1);
    // Asked from the district view at (0, 0): its cells near it; one cell far off, where the street view will be.
    job('district near', 0, [100, 0]);
    job('district farther', 0, [600, 0]);
    job('street', 0, [3000, 0]);
    // A band before every distance stays before them.
    job('far level', -1e9, [9000, 0]);
    // The view goes down onto the street.
    setJobFocus(3000, 0);
    const answer = (name: string): void => {
      const w = FakeWorker.made.find((x) => x.asked.some((m) => m.data === name))!;
      const m = w.asked.find((x) => x.data === name)!;
      w.onmessage!({ data: { port: m.port, data: name, seq: m.seq } });
    };
    answer('busy1');
    answer('busy2');
    answer('busy3');
    expect(written).toEqual(['busy1', 'busy2', 'busy3', 'far level', 'street', 'district farther']);
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

  it('hands a lane to another thread as a port its worker serves, and tells that thread when the worker fails', async () => {
    const { jobChannel, portWorker } = await import('@/jobs/jobPool');
    const lost: string[] = [];
    const port = jobChannel('bays', () => lost.push('bays'));
    const serving = FakeWorker.made.find((w) => w.asked.some((m) => (m as unknown as { adopt?: string }).adopt === 'bays'))!;
    expect(serving).toBeDefined();
    const adopted = serving.asked.find((m) => (m as unknown as { adopt?: string }).adopt === 'bays') as unknown as { port: MessagePort };
    // The thread and the worker talk straight over the channel.
    const heard = new Promise<unknown>((done) => { adopted.port.onmessage = (event) => done(event.data); });
    portWorker(port).postMessage({ id: 1 });
    expect(await heard).toEqual({ id: 1 });
    serving.onerror!({ message: 'crashed' });
    expect(lost).toEqual(['bays']);
    port.close();
    adopted.port.close();
  });

  it('puts a lane let go back in the count: the next lane takes the worker it freed', async () => {
    const { jobPort } = await import('@/jobs/jobPool');
    const lanes = [0, 1, 2, 3].map(() => jobPort('bays'));
    const freed = hostOf(lanes[2]!);
    lanes[2]!.terminate();
    expect(hostOf(jobPort('ecology'))).toBe(freed);
  });

  it("runs no queued job on the save's worker: its writes never wait behind a job", async () => {
    const { jobPort, submitJob } = await import('@/jobs/jobPool');
    const save = hostOf(jobPort('save'));
    // A second lane of the save, the pool not full: on the same worker, no worker made for it.
    expect(hostOf(jobPort('save'))).toBe(save);
    expect(FakeWorker.made).toHaveLength(1);
    const written: string[] = [];
    for (let k = 0; k < 8; k++) {
      submitJob({ service: 'cells', key: null, priority: k, write: () => { written.push(String(k)); return { data: k, transfer: [] }; }, done: () => {}, failed: () => {} });
    }
    // Jobs went to the other workers (four in all here), none to the save's.
    expect(written.length).toBeGreaterThan(0);
    expect(FakeWorker.made[save]!.asked.filter((m) => m.seq !== undefined)).toEqual([]);
    // And another kind's lane is put elsewhere too; another lane of the save on the same worker.
    expect(hostOf(jobPort('roadTiles'))).not.toBe(save);
    expect(hostOf(jobPort('save'))).toBe(save);
  });

  it("puts the tile store's reads on the save's worker, where no queued job runs, within the pool's count (conf37)", async () => {
    const { jobPort, jobWorkers, submitJob } = await import('@/jobs/jobPool');
    const save = hostOf(jobPort('save'));
    const reads = [0, 1, 2].map(() => hostOf(jobPort('tileRead')));
    for (const r of reads) expect(r).toBe(save);
    // The queue full of long jobs: the reads' worker never given one.
    for (let k = 0; k < 12; k++) {
      submitJob({ service: 'cells', key: null, priority: k, write: () => ({ data: k, transfer: [] }), done: () => {}, failed: () => {} });
    }
    expect(FakeWorker.made[save]!.asked.filter((m) => m.seq !== undefined)).toEqual([]);
    expect(FakeWorker.made.length).toBeLessThanOrEqual(jobWorkers());
  });

  it("makes a side's workers where the maker says, the page's Worker where it says nothing", async () => {
    const { jobPort, setJobWorkerMaker } = await import('@/jobs/jobPool');
    const made: boolean[] = [];
    setJobWorkerMaker((long) => { made.push(long); return long ? new FakeWorker() as unknown as Worker : null; });
    const before = FakeWorker.made.length;
    jobPort('growth');
    jobPort('roadTiles');
    expect(made).toEqual([true, false]);
    expect(FakeWorker.made.length).toBe(before + 2);
    setJobWorkerMaker(null);
  });

  /** The page's clock and heap as the pool reads them (`performance.now`, `performance.memory`). */
  const pageHeap = { now: 0, heap: 100 * 2 ** 20 };
  const stubPage = (): void => {
    pageHeap.now = 0;
    pageHeap.heap = 100 * 2 ** 20;
    vi.stubGlobal('performance', { now: () => pageHeap.now, memory: { get totalJSHeapSize() { return pageHeap.heap; } } });
  };
  /** Room in the 4 GB cage for two workers at their peak (`pageRoomWorkers`), the page grown to fill the rest. */
  const GROWN_PAGE = 4 * 2 ** 30 - 600 * 2 ** 20 - 2 * 600 * 2 ** 20 - 1;
  const cellJob = (submitJob: typeof import('@/jobs/jobPool').submitJob, name: string): void => {
    submitJob({ service: 'cells', key: null, priority: 1, write: () => ({ data: name, transfer: [] }), done: () => {}, failed: () => {} });
  };
  const answerJob = (name: string): void => {
    const w = FakeWorker.made.find((x) => x.asked.some((m) => m.data === name))!;
    const m = w.asked.find((x) => x.data === name)!;
    w.onmessage!({ data: { port: m.port, data: `${name} done`, seq: m.seq } });
  };

  it("lets go of the page's idle workers once the page has grown past room for them, after they stood idle a while", async () => {
    stubPage();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { jobPort, submitJob, RETIRE_IDLE_MS } = await import('@/jobs/jobPool');
      // A growth lane (its worker kept: it holds the lane's state) and two queued jobs, made while the page was small.
      jobPort('growth');
      cellJob(submitJob, 'a');
      cellJob(submitJob, 'b');
      expect(FakeWorker.made).toHaveLength(3);
      answerJob('a');
      answerJob('b');
      // The page grows: room for two of the three.
      pageHeap.heap = GROWN_PAGE;
      pageHeap.now = RETIRE_IDLE_MS / 2;
      vi.advanceTimersByTime(RETIRE_IDLE_MS / 2);
      expect(FakeWorker.made.filter((w) => w.ended)).toHaveLength(0);
      cellJob(submitJob, 'c');
      answerJob('c');
      pageHeap.now = 2 * RETIRE_IDLE_MS;
      vi.advanceTimersByTime(2 * RETIRE_IDLE_MS);
      // One let go, the growth's kept, the pool at the page's room: the next job runs on the worker left, none made.
      const ended = FakeWorker.made.filter((w) => w.ended);
      expect(ended).toHaveLength(1);
      expect(ended[0]!.asked.some((m) => m.service === 'growth')).toBe(false);
      cellJob(submitJob, 'd');
      expect(FakeWorker.made).toHaveLength(3);
      expect(FakeWorker.made.find((w) => w.asked.some((m) => m.data === 'd'))!.ended).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the page's workers while the page has room for them, idle or not", async () => {
    stubPage();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { jobPort, submitJob, RETIRE_IDLE_MS } = await import('@/jobs/jobPool');
      jobPort('growth');
      cellJob(submitJob, 'a');
      cellJob(submitJob, 'b');
      answerJob('a');
      answerJob('b');
      pageHeap.now = 10 * RETIRE_IDLE_MS;
      vi.advanceTimersByTime(10 * RETIRE_IDLE_MS);
      cellJob(submitJob, 'c');
      expect(FakeWorker.made.filter((w) => w.ended)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

});
