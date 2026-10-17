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

  it('keeps the long-running services and every other kind on workers apart, the lanes of a kind spread over its side', async () => {
    const { jobChannel, jobPort, jobWorkers, longWorkers, shortWorkers } = await import('@/jobs/jobPool');
    expect(jobWorkers()).toBe(4);
    expect([longWorkers(), shortWorkers()]).toEqual([2, 2]);
    // The traffic's lanes first (as the page opens), the tiles' and the growth's after: never on the traffic's workers.
    const conflicts = [0, 1].map(() => jobChannel('conflicts', () => {}));
    const traffic = FakeWorker.made.filter((w) => w.asked.some((m) => (m as unknown as { adopt?: string }).adopt === 'conflicts')).map((w) => FakeWorker.made.indexOf(w));
    // The adopt messages read: `hostOf` finds a worker by what it was last sent.
    for (const w of FakeWorker.made) w.asked.length = 0;
    const tiles = [0, 1].map(() => hostOf(jobPort('cityTiles')));
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

  it('sends a queued job to a worker whose lanes have nothing in flight, to an idle tile worker before a busy one, never behind a tile', async () => {
    const { jobPort, submitJob } = await import('@/jobs/jobPool');
    // Two lanes on the two workers of the other kinds, one with a request in flight; a tile lane with a tile being made, another idle.
    const lanes = [0, 1].map(() => jobPort('roadTiles'));
    const tiles = [0, 1].map(() => jobPort('cityTiles'));
    expect(FakeWorker.made).toHaveLength(4);
    const workerOf = (lane: Worker): FakeWorker => (lane as unknown as { worker: FakeWorker }).worker;
    lanes[0]!.postMessage({ tiles: [] });
    tiles[0]!.postMessage({ stream: true });
    const job = (name: string): void => { submitJob({ service: 'cells', key: null, priority: 1, write: () => ({ data: name, transfer: [] }), done: () => {}, failed: () => {} }); };
    const queuedOn = (name: string): number => FakeWorker.made.findIndex((w) => w.asked.some((m) => m.data === name && m.seq !== undefined));
    job('first');
    expect(queuedOn('first')).toBe(FakeWorker.made.indexOf(workerOf(lanes[1]!)));
    // The other kinds' free workers busy: the idle tile worker, never the one making a tile.
    job('second');
    expect(queuedOn('second')).toBe(FakeWorker.made.indexOf(workerOf(tiles[1]!)));
    // Only a worker with lane work left: it takes the next rather than waiting, still not the tile worker.
    job('third');
    expect(queuedOn('third')).toBe(FakeWorker.made.indexOf(workerOf(lanes[0]!)));
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

  it("puts the tile store's reads on the save's worker, where no queued job nor the rush's tiles run, within the pool's count (conf37)", async () => {
    const { jobPort, jobWorkers, submitJob } = await import('@/jobs/jobPool');
    const save = hostOf(jobPort('save'));
    const reads = [0, 1, 2].map(() => hostOf(jobPort('tileRead')));
    for (const r of reads) expect(r).toBe(save);
    // The rush's lanes of tiles and the queue full of long jobs: elsewhere, the reads' worker never given one.
    const aside = [0, 1].map(() => hostOf(jobPort('cityTilesAside')));
    for (const a of aside) expect(a).not.toBe(save);
    for (let k = 0; k < 12; k++) {
      submitJob({ service: 'cells', key: null, priority: k, write: () => ({ data: k, transfer: [] }), done: () => {}, failed: () => {} });
    }
    expect(FakeWorker.made[save]!.asked.filter((m) => m.seq !== undefined)).toEqual([]);
    expect(FakeWorker.made.length).toBeLessThanOrEqual(jobWorkers());
  });

  it("gives the store's reads a worker of their own, apart from the save's, where the pool has five or more: within its count, the queue first (conf28, conf37)", async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 10 });
    const { jobPort, jobWorkers, keptClearWorkers, longWorkers, shortWorkers, submitJob } = await import('@/jobs/jobPool');
    expect(jobWorkers()).toBe(8);
    expect([longWorkers(), shortWorkers(), keptClearWorkers()]).toEqual([5, 3, 2]);
    // The queue full of long jobs before the world opens: it grows what it may, never the kept-clear services' workers.
    const queued = (n: number): void => {
      for (let k = 0; k < n; k++) submitJob({ service: 'cells', key: null, priority: k, write: () => ({ data: k, transfer: [] }), done: () => {}, failed: () => {} });
    };
    queued(20);
    // The worker a port posts to, the queue's own messages left where they are.
    const placed = (port: Worker): number => {
      const before = FakeWorker.made.map((w) => w.asked.length);
      port.postMessage({});
      return FakeWorker.made.findIndex((w, i) => w.asked.length > (before[i] ?? 0));
    };
    const save = placed(jobPort('save'));
    const reads = [0, 1, 2].map(() => placed(jobPort('tileRead')));
    expect(new Set(reads).size).toBe(1);
    expect(reads[0]).not.toBe(save);
    const aside = [0, 1].map(() => placed(jobPort('cityTilesAside')));
    queued(20);
    for (const a of aside) expect([save, reads[0]]).not.toContain(a);
    for (const kept of [save, reads[0]!]) expect(FakeWorker.made[kept]!.asked.filter((m) => m.seq !== undefined)).toEqual([]);
    expect(FakeWorker.made.length).toBeLessThanOrEqual(jobWorkers());
  });
});
