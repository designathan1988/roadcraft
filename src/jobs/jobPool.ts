import { WEAK_MACHINE } from '@core/weakMachine';
import type { AdoptLane, CloseLane, FromJob, JobService, ToJob } from './jobScope';

/** THE JOB SYSTEM: one pool of workers (hardwareConcurrency - 2, within the machine's memory) for every kind of work off the page, in place of a pool per kind */
/** DO NOT make every worker at the start nor give a kind's job to any free worker: each worker is a whole JS heap with the code and state of every service it ran, so 22 of them each running every service took the page's process past 6 GB on a 3 x 3 tile region (2026-10-16, Chrome memory-infra: 2.8 GB of V8 in the workers, out of memory at 8 GB) - workers are made as work waits, and a kind's jobs go first to the workers that already run it */

/** DO NOT size the pool by the machine alone: the page and every worker of its process share ONE V8 heap cage of 4 GB (pointer compression's shared cage, V8 9.2; the V8 sandbox needs it), and a streamed opening died "out of memory" with 3.4 GB of V8 across 24 workers (2026-10-16) - the pool takes a fifth of it, at a busy worker's V8 heap and young generation (~170 MB). */
const CAGE_BYTES = 4 * 2 ** 30;
/** Two fifths of the cage for the pool (2026-10-16: the worker that took it down was a Clipper2 union that never ended, fixed in `scripts/patches`; a busy worker holds 100-250 MB): 9 workers at most by the cage, the page's heap and the simulation's keep the rest. */
const POOL_CAGE_SHARE = 2 / 5;
/** In a browser every worker is a thread of the page's process, in the page's cage: a fifth of it, 4 workers. DO NOT give it two fifths there: the page alone runs to 2.7 GB of V8 between its collections on the 10 km city (969 MB live after one), and with 9 workers beside it the cage ran out and Chrome killed the page whenever the camera drew back (2026-10-18). */
const PAGE_POOL_CAGE_SHARE = 1 / 5;
const WORKER_HEAP_BYTES = 170 * 2 ** 20;

/** Services whose one job runs for seconds: kept on workers of their own, never beside another kind's lane or a queued job (a streamed tile is 2-25 s, `cityTile.worker.ts`: the traffic's conflict pairs waited behind tile after tile and the city's clock stood still). */
const LONG_RUNNING: readonly JobService[] = ['growth'];

/** Services whose worker no queued job runs on (where another worker can take it), all on one worker (never one each: the short side has two, the V8 cage's count, `jobWorkers`): the save's writes are a few short awaits, and each waited for the job running on its worker - under load a tile's write took past a reload, the edit lost (conf15, conf22); the store's reads (`tileRead`) beside them, never beside the queue or the rush's tiles - a reopening's tiles waited behind far levels' bakes of seconds (conf37). No bake runs there (`tileStore.ts` upgraded, `TileStore.write`). */
const KEPT_CLEAR: readonly JobService[] = ['save', 'tileRead'];
const keptClear = (host: Host): boolean => KEPT_CLEAR.some((service) => host.services.has(service));
/** How many kinds a worker hosts lanes of besides the kept-clear ones. */
const otherKinds = (host: Host): number => { let n = 0; for (const service of host.services.keys()) if (!KEPT_CLEAR.includes(service)) n++; return n; };

/** Workers set apart for the long-running services: the pool less two kept for every other kind, one at least (the desktop's, in job processes outside the page's cage).
 *  In a browser one: the long-running services have one lane (`growthPool.ts`), and a second long worker of the page's four took no lane, while the traffic's, the roads' and the ground's lanes and the save were crowded on the other two, the save waiting behind a batch of conflicts or bays (JOB-02). */
export function longWorkers(): number {
  const n = jobWorkers();
  if (!system.makeWorker) return 1;
  return n >= 3 ? n - 2 : 1;
}

/** Workers for every other kind (the traffic's lanes, the cells, the far levels, the roads, the ground): the rest of the pool, one at least. */
export const shortWorkers = (): number => Math.max(1, jobWorkers() - longWorkers());

/** A job of the central queue (Cidade's job pool, `submit`): its message written when a worker takes it, answered once. */
interface JobSpec {
  readonly service: JobService;
  /** A newer job with the same key replaces this one: never sent if still waiting, its answer dropped if begun. */
  readonly key: string | null;
  /** Lower first: the job's distance to the eye (`focusDistance`), in metres, or below it for what must come first; with `at`, its band (what comes before the distance, the same for a kind of job). */
  readonly priority: number;
  /** Where on the map the job's work stands: its rank is `priority` plus its distance to where the view looks NOW, re-ranked as the view moves (`setJobFocus`), not where it looked when the job was asked. */
  readonly at?: readonly [number, number];
  /** The message, written only when a worker takes the job (a job waiting its turn holds no copy of it). */
  readonly write: () => { readonly data: unknown; readonly transfer: Transferable[] };
  readonly done: (answer: unknown) => void;
  /** Its worker failed, or none can run it: the asker does it another way. */
  readonly failed: (message: string) => void;
}

/** A job of the queue as its asker holds it. */
export interface JobTicket {
  /** Not wanted any more: never sent if waiting, its answer dropped if begun. */
  cancel(): void;
  /** Waiting or running, not answered, cancelled nor replaced. */
  readonly pending: boolean;
}

/** A job in the queue: waiting, running on a worker, or over (answered, cancelled or replaced by a newer one of its key). */
interface Queued { readonly seq: number; readonly spec: JobSpec; state: 'waiting' | 'running' | 'over'; rank: number }

/** A job's place in the queue now: its band and its distance to the view's focus (`JobSpec.at`), or its priority alone. */
const rankOf = (spec: JobSpec): number => (spec.at ? spec.priority + focusDistance(spec.at[0], spec.at[1]) : spec.priority);

/** ONE PRIORITY QUEUE FOR EVERY WORKER: a binary min-heap by (priority, order asked); a job replaced or cancelled is left in it and skipped when popped */
class JobQueue {
  private readonly heap: Queued[] = [];
  /** Each key's newest job, while it is not over. */
  private readonly newest = new Map<string, Queued>();
  private seq = 0;
  private count = 0;

  /** Jobs waiting for a worker. */
  get waiting(): number {
    return this.count;
  }

  submit(spec: JobSpec): Queued {
    const job: Queued = { seq: ++this.seq, spec, state: 'waiting', rank: rankOf(spec) };
    if (spec.key !== null) {
      const older = this.newest.get(spec.key);
      if (older) this.end(older);
      this.newest.set(spec.key, job);
    }
    this.count++;
    this.push(job);
    // DO NOT let the jobs over (replaced or cancelled) pile up in the heap: they are left in it and skipped when popped, and a camera moving replaces thousands a second (the far nodes and the cells asked again under their keys), each dispatch popping them one by one (500 ms of a 16 s drag, 2026-10-16); compacted once they outnumber the waiting.
    if (this.heap.length > this.count * 2 + 64) this.compact();
    return job;
  }

  /** Every waiting job placed by where the view looks now (`setJobFocus`), the heap made again. */
  rerank(): void {
    for (const job of this.heap) if (job.state === 'waiting') job.rank = rankOf(job.spec);
    this.compact();
  }

  /** The heap made again of the waiting jobs alone (Floyd's build-heap, O(n)). */
  private compact(): void {
    const a = this.heap;
    let n = 0;
    for (const job of a) if (job.state === 'waiting') a[n++] = job;
    a.length = n;
    for (let i = (n >> 1) - 1; i >= 0; i--) this.sink(i);
  }

  /** The waiting job that would run next, left waiting; null when none waits. */
  peek(): Queued | null {
    while (this.heap.length > 0 && this.heap[0]!.state !== 'waiting') this.pop();
    return this.heap[0] ?? null;
  }

  /** The waiting job to run next, marked running; null when none waits. */
  take(): Queued | null {
    for (let job = this.pop(); job; job = this.pop()) {
      if (job.state !== 'waiting') continue;
      this.count--;
      job.state = 'running';
      return job;
    }
    return null;
  }

  cancel(job: Queued): void {
    this.end(job);
  }

  /** A running job's answer, handed to its asker if it is still wanted. */
  answer(job: Queued, data: unknown): void {
    if (this.end(job) === 'running') job.spec.done(data);
  }

  /** A running job that failed, said to its asker if it is still wanted. */
  fail(job: Queued, message: string): void {
    if (this.end(job) === 'running') job.spec.failed(message);
  }

  /** Every waiting job failed: no worker can run them. */
  failAll(message: string): void {
    for (let job = this.take(); job; job = this.take()) this.fail(job, message);
  }

  /** The job over; what it was. */
  private end(job: Queued): Queued['state'] {
    const was = job.state;
    if (was === 'waiting') this.count--;
    job.state = 'over';
    if (job.spec.key !== null && this.newest.get(job.spec.key) === job) this.newest.delete(job.spec.key);
    return was;
  }

  private less(a: Queued, b: Queued): boolean {
    return a.rank < b.rank || (a.rank === b.rank && a.seq < b.seq);
  }

  private push(job: Queued): void {
    const a = this.heap;
    a.push(job);
    let i = a.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!this.less(a[i]!, a[up]!)) break;
      [a[i], a[up]] = [a[up]!, a[i]!];
      i = up;
    }
  }

  private pop(): Queued | undefined {
    const a = this.heap;
    const top = a[0];
    const last = a.pop();
    if (top === undefined || last === undefined || a.length === 0) return top;
    a[0] = last;
    this.sink(0);
    return top;
  }

  /** The job at `i` moved down until both children are after it. */
  private sink(i: number): void {
    const a = this.heap;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
      if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
      if (m === i) return;
      [a[i], a[m]] = [a[m]!, a[i]!];
      i = m;
    }
  }
}

/** A worker of the pool: the lanes it hosts (`place`), its port per service for queued jobs, the queued job it runs, whether it failed. */
interface Host {
  readonly worker: Worker;
  /** A worker of the long-running services (`longWorkers`) or of every other kind: never both. */
  readonly long: boolean;
  /** A thread of the page's own process, in the page's V8 cage (`pageRoomWorkers`); not a desktop job process's. */
  readonly inPage: boolean;
  /** Since when it has had nothing on it (`idle`), NaN while it has. */
  freeSince: number;
  ports: number;
  readonly services: Map<JobService, number>;
  readonly queuePorts: Map<JobService, number>;
  job: Queued | null;
  failed: boolean;
  /** Messages its lanes posted and not yet answered (`JobPort`): a queued job sent there waits behind them. */
  laneWork: number;
  /** Told when it fails: the lanes it serves for another thread (`jobChannel`), whose ports say nothing of it. */
  readonly channelLost: (() => void)[];
}

/** The pool of this thread: its workers (made as work waits, `grow`), its lanes by port, its queue and the point the view looks at. */
class JobSystem {
  readonly workers: Host[] = [];
  readonly ports = new Map<number, JobPort>();
  nextPort = 1;
  readonly queue = new JobQueue();
  focusX = 0;
  focusY = 0;
  /** Where the waiting jobs were last ranked from (`setJobFocus`). */
  rankedX = 0;
  rankedY = 0;
  /** What each worker is told when it is made, before any job (`setJobWorkerSetup`). */
  setup: ((worker: Worker) => void) | null = null;
  /** Where a worker of a side is made instead of a page's Worker (`setJobWorkerMaker`: the desktop's utility process for the long side); null: the page's. */
  makeWorker: ((long: boolean) => Worker | null) | null = null;
  /** Tiles of the map waiting for the long side's lanes (`tilesWaiting`): its workers take no queued job meanwhile. */
  tilesWaiting = false;
}
const system = new JobSystem();

/** Where the pool's workers are made, by side (`long`: tiles and growth); null from it: the page's own Worker. On the desktop the long side goes to a utility process outside the renderer's V8 cage (`jobs/processWorker.ts`), whose `terminate` ends that thread; the short side stays the page's own. */
export function setJobWorkerMaker(make: ((long: boolean) => Worker | null) | null): void {
  system.makeWorker = make;
}

/** Told to every worker of the pool, those made and those to come, before its first job: on the desktop, the port it reads and writes the tiles through (`editor/workerParts.ts`). */
export function setJobWorkerSetup(setup: (worker: Worker) => void): void {
  system.setup = setup;
  for (const host of system.workers) setup(host.worker);
}

/** The most workers the pool holds: the cores less the page's and the simulation's (the city-game's pool), within the V8 cage the page and its workers share (at least one). DO NOT size it by `navigator.deviceMemory`: the browser tells 8 GB at most, 32 GB included, and a 24-thread machine made the map's 100 tiles on 2 workers (2026-10-16). */
export function jobWorkers(): number {
  // A weaker machine played on this one (`core/weakMachine.ts`): its threads.
  const cores = WEAK_MACHINE.threads ?? ((typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0) || 2);
  // Inside the simulation's worker (no document): its own few, for the lots' bays and the junctions' pairs.
  if (typeof document === 'undefined') return Math.max(1, Math.min(2, cores - 2));
  const share = system.makeWorker ? POOL_CAGE_SHARE : PAGE_POOL_CAGE_SHARE;
  const byCage = Math.floor((CAGE_BYTES * share) / WORKER_HEAP_BYTES);
  return Math.max(1, Math.min(cores - 2, byCage));
}

/** A worker of the page's own process at its busiest, measured (CDP `Runtime.getHeapUsage` on the 10 km city's generation, 2026-10-18): a tile worker held 450-650 MB of V8 heap, not the ~170 MB `WORKER_HEAP_BYTES` counts. */
const PAGE_WORKER_PEAK_BYTES = 600 * 2 ** 20;
/** Of the cage, what the page keeps clear of its own heap and its workers' (the simulation's worker, the thread stacks, the next collection's room). */
const CAGE_KEPT_BYTES = 600 * 2 ** 20;
/** How many workers the page's process holds now, by the room its cage has (in a browser every worker is a thread of the page's process): the page's heap as V8 holds it now (`performance.memory.totalJSHeapSize`), each worker at its peak. DO NOT count on the page staying small: with a city open the page's heap ran to 2.7 GB between its collections, and the tile workers made on top of it took the cage past 4 GB - Chrome killed the page (2026-10-18). Two at least (one each side, or no tile is ever made); the next is made only if it fits, and one made while the page was small is let go once idle when the page has grown past room for it (`retireIdle`). */
function pageRoomWorkers(): number {
  const page = (performance as { memory?: { totalJSHeapSize: number } }).memory?.totalJSHeapSize;
  if (page === undefined) return Infinity;
  return Math.max(2, Math.floor((CAGE_BYTES - CAGE_KEPT_BYTES - page) / PAGE_WORKER_PEAK_BYTES));
}

/** How many lanes a kind of work may have: never more than the workers its side has (a lane per worker, `jobPort`; the long-running services' are `tileLanes`). */
export const jobLanes = (most: number): number => Math.max(1, Math.min(most, laneWorkers()));

/** The short side's workers a kind's lanes may take: all but one while it has more than one, that one left for the kept-clear lanes (the save's writes, `KEPT_CLEAR`) - DO NOT let the traffic's lanes take every worker at the boot: the save made later shared one with them, and waited behind each batch (JOB-02). */
const laneWorkers = (): number => { const n = shortWorkers(); return n > 1 ? n - 1 : 1; };

/** One more worker of its side (`long`), while the pool and that side have room (`longWorkers`, `shortWorkers`); null when full. */
function grow(long: boolean): Host | null {
  const live = system.workers;
  if (live.length >= jobWorkers()) return null;
  if (live.filter((h) => h.long === long).length >= (long ? longWorkers() : shortWorkers())) return null;
  // The guard by where the worker is made: on the desktop the short side is the page's own (`desktopJobs.ts`), in the page's cage.
  const made = system.makeWorker?.(long) ?? null;
  if (made === null && pageWorkers() >= pageRoomWorkers()) return null;
  const worker = made ?? new Worker(new URL('../job.worker.ts', import.meta.url), { type: 'module' });
  system.setup?.(worker);
  const host: Host = { worker, long, inPage: made === null, freeSince: NaN, ports: 0, services: new Map(), queuePorts: new Map(), job: null, failed: false, laneWork: 0, channelLost: [] };
  worker.onmessage = (event: MessageEvent<FromJob>) => {
    const port = system.ports.get(event.data.port);
    if (port) {
      // A lane's answer: its worker has one message less before a queued job (a lane posting without answer only ranks its worker lower).
      // DO NOT count a beat as an answer (`{ beat: true }`, every 500 ms of a long batch: road tiles, conflicts, bays): the first one freed a worker mid-batch, and a cell's job waited behind the batch (JOB-01). The pool's own lane still hears it (its watchdog).
      const said = event.data.data as { beat?: unknown } | null | undefined;
      const beat = typeof said === 'object' && said !== null && said.beat === true;
      if (!beat && port.answered()) dispatch();
      if (event.data.error !== undefined) port.onerror?.(new ErrorEvent('error', { message: event.data.error }));
      else port.onmessage?.(new MessageEvent('message', { data: event.data.data }));
      return;
    }
    const job = host.job;
    // The answer of a job already given up (its worker's error came first) changes nothing.
    if (!job || event.data.seq !== job.seq) return;
    host.job = null;
    if (event.data.error !== undefined) system.queue.fail(job, event.data.error);
    else system.queue.answer(job, event.data.data);
    dispatch();
  };
  worker.onerror = (event) => {
    for (const port of system.ports.values()) if (port.worker === worker) port.onerror?.(event);
    for (const lost of host.channelLost.splice(0)) lost();
    failHost(host, event.message || 'a job worker failed', true);
  };
  worker.onmessageerror = () => {
    for (const port of system.ports.values()) if (port.worker === worker) port.onmessageerror?.(new MessageEvent('messageerror'));
    failHost(host, 'a job worker\'s answer could not be read', false);
  };
  system.workers.push(host);
  return host;
}

/** The workers made in the page's own process. */
function pageWorkers(): number {
  let n = 0;
  for (const host of system.workers) if (host.inPage) n++;
  return n;
}

/** How long a worker of the page stands with nothing on it before it may be let go: a burst of jobs keeps its workers. */
export const RETIRE_IDLE_MS = 10_000;
let retireTimer: ReturnType<typeof setTimeout> | null = null;

/** Nothing on it: no queued job, no lane (each service's own state is kept by its lanes: `classRigs`, the fixed lanes), no message in flight, no other thread's channel, not failed. */
const idle = (host: Host): boolean =>
  host.job === null && host.ports === 0 && host.laneWork === 0 && host.services.size === 0 && host.channelLost.length === 0 && !host.failed;

/** The page's workers idle for `RETIRE_IDLE_MS` let go while the page holds more of them than its cage has room for now (`pageRoomWorkers`): DO NOT keep for the session a worker made while the page was small (each holds up to 600 MB of the cage). The next job makes one again (`grow`). */
function retireIdle(): void {
  const now = performance.now();
  let waiting = Infinity;
  let candidates = 0;
  for (const host of system.workers) {
    if (!host.inPage || !idle(host)) { host.freeSince = NaN; continue; }
    if (Number.isNaN(host.freeSince)) host.freeSince = now;
    candidates++;
  }
  if (candidates === 0) return;
  let over = pageWorkers() - pageRoomWorkers();
  for (let i = 0; i < system.workers.length && over > 0; i++) {
    const host = system.workers[i]!;
    if (!host.inPage || Number.isNaN(host.freeSince)) continue;
    const left = host.freeSince + RETIRE_IDLE_MS - now;
    if (left > 0) { waiting = Math.min(waiting, left); continue; }
    system.workers.splice(i--, 1);
    host.worker.terminate();
    over--;
  }
  // The others idle not long enough yet: looked at again when they will have been.
  if (over > 0 && waiting < Infinity && retireTimer === null) {
    retireTimer = setTimeout(() => { retireTimer = null; retireIdle(); }, waiting);
  }
}

/** A worker's queued job failed with it; a worker that failed whole (`dead`) is given no queued job again. */
function failHost(host: Host, message: string, dead: boolean): void {
  if (dead) host.failed = true;
  const job = host.job;
  host.job = null;
  if (job) system.queue.fail(job, message);
  dispatch();
}

/** The port a worker runs a service's queued jobs on, one per service and worker. */
function queuePort(host: Host, service: JobService): number {
  let port = host.queuePorts.get(service);
  if (port === undefined) host.queuePorts.set(service, port = system.nextPort++);
  return port;
}

/** The worker a queued job of `service` goes to: a free one already running the kind, else a new one while the pool has room, else any free one
 *  - a long-running service's worker only while its lanes have nothing in flight: a tile asked after it waits one job, never a job behind a tile (only a pool of one worker shares it otherwise).
 *  - DO NOT give it to a long worker in a desktop job process (`inPage` false), nor make one for it: the message went there copied whole, every ground plate of the page's shared memory with it (`processWorker.ts` unshared, ~33 MB a cell job, JOB-03); it waits for the page's own.
 *  - DO NOT give it to a worker whose lanes have messages in flight while one with none is free: it waited behind a tile read or a batch of road tiles (`JobPort` posts straight to its worker); such a worker only when no other is free. */
function hostFor(service: JobService): Host | null {
  let cold: Host | null = null, idleLong: Host | null = null, warmBusy: Host | null = null, coldBusy: Host | null = null;
  for (const host of system.workers) {
    if (host.job || host.failed) continue;
    if (keptClear(host) && system.workers.length > 1) continue;
    if (host.long && system.workers.length > 1) { if (host.laneWork === 0 && host.inPage) idleLong ??= host; continue; }
    const warm = host.queuePorts.has(service);
    if (host.laneWork > 0) {
      if (warm) warmBusy ??= host; else coldBusy ??= host;
      continue;
    }
    if (warm) return host;
    cold ??= host;
  }
  return grow(false) ?? cold ?? idleLong ?? (system.makeWorker ? null : grow(true)) ?? warmBusy ?? coldBusy;
}

/** Each waiting job, nearest first, to a worker free for it (Cidade's `pump`): one queued job at a time on a worker. */
function dispatch(): void {
  for (let job = system.queue.peek(); job; job = system.queue.peek()) {
    let host: Host | null;
    try {
      host = hostFor(job.spec.service);
    } catch (error) {
      system.queue.failAll(`no job workers: ${String(error)}`);
      return;
    }
    if (!host) {
      if (system.workers.length > 0 && system.workers.every((h) => h.failed)) system.queue.failAll('every job worker failed');
      retireIdle();
      return;
    }
    system.queue.take();
    try {
      const { data, transfer } = job.spec.write();
      const message: ToJob = { port: queuePort(host, job.spec.service), service: job.spec.service, data, seq: job.seq };
      host.worker.postMessage(message, transfer);
      host.job = job;
    } catch (error) {
      system.queue.fail(job, String(error));
    }
  }
  retireIdle();
}


/** A job for the queue: run by the first free worker, nearest the eye first (`JobSpec`). */
export function submitJob(spec: JobSpec): JobTicket {
  const job = system.queue.submit(spec);
  dispatch();
  return {
    cancel: () => system.queue.cancel(job),
    get pending() { return job.state !== 'over'; },
  };
}

/** Whether this thread can run queued jobs at all (Node's tests have no `Worker`): the asker does them itself otherwise. */
export const canQueueJobs = (): boolean => typeof Worker !== 'undefined';

/** A worker of the pool made now, ahead of the first job (its modules load meanwhile); the others as work waits. */
export function warmJobWorkers(): void {
  if (system.workers.length === 0) grow(false);
}

/** The point the view looks at, each frame (`flatAtlas.ts` `focus`): what the queue's jobs are ranked by. */
export function setJobFocus(x: number, y: number): void {
  system.focusX = x;
  system.focusY = y;
  // DO NOT leave the waiting jobs ranked by where the view was when they were asked: after a move, the cells at the new eye waited behind the old view's (the street view after a reload stood in masses for 14 s, its cell's detail queued behind those of the district view before it, 2026-10-17); Cesium sorts its requests by the current frame's screen error.
  if (Math.hypot(x - system.rankedX, y - system.rankedY) < RERANK_MOVE) return;
  system.rankedX = x;
  system.rankedY = y;
  system.queue.rerank();
}

/** How far the view moves before the waiting jobs are ranked again: a fraction of a cell (`BATCH_CELL` 256 m). */
const RERANK_MOVE = 64;

/** How far a point is from where the view looks (`setJobFocus`): a queued job's priority. */
export const focusDistance = (x: number, y: number): number => Math.hypot(x - system.focusX, y - system.focusY);

/** DO NOT pin a lane by a hash of its service, nor put a long-running service's lane on a worker of the other kinds (or the other way round): the traffic's conflict pairs waited behind tile after tile and the city's clock stood still (the long lanes were placed last, on the workers the traffic's lanes already held) */
function place(service: JobService): Host {
  const long = LONG_RUNNING.includes(service);
  let best: Host | null = null;
  let bestScore = Infinity;
  for (const w of system.workers) {
    if (w.long !== long) continue;
    // Lanes of a kind on different workers, then the least loaded; the kept-clear services' worker kept to them, on a worker of their own where there is one.
    // The kept-clear lanes together on their worker (never a worker each: the pool's workers are the jobs').
    const clear = KEPT_CLEAR.includes(service);
    const apart = clear ? (otherKinds(w) > 0 ? 1 : 0) : keptClear(w) ? 1 : 0;
    const score = apart * 1_000_000 + (clear ? (keptClear(w) ? 0 : 10_000) : (w.services.get(service) ?? 0) * 10_000) + w.ports;
    if (score < bestScore) { bestScore = score; best = w; }
  }
  // A worker with nothing on it scores 0: one is made for the lane while its side has room, as if every worker were there.
  // A kept-clear lane goes to their own worker once there is one, not to a new worker.
  const own = best !== null && KEPT_CLEAR.includes(service) && keptClear(best) && otherKinds(best) === 0;
  const roomForLane = long || KEPT_CLEAR.includes(service) || system.workers.filter((w) => !w.long).length < laneWorkers();
  if (best === null || (bestScore > 0 && !own && roomForLane)) best = grow(long) ?? best;
  // A pool of one worker: the two sides share it.
  if (!best) best = system.workers.reduce<Host | null>((a, w) => (a === null || w.ports < a.ports ? w : a), null);
  if (!best) throw new Error('no job worker could be made');
  return best;
}

/** A kind of work's lane in the pool: answers as a `Worker` does (`onmessage`, `onerror`, `postMessage`, `terminate`). */
export class JobPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly worker: Worker;
  private readonly id = system.nextPort++;
  private readonly host: Host;
  /** Messages posted and not yet answered. */
  private inFlight = 0;

  constructor(private readonly service: JobService) {
    // The least busy worker; a service's own state is per worker, so a lane stays on the one it was given.
    this.host = place(service);
    this.host.ports++;
    this.host.services.set(service, (this.host.services.get(service) ?? 0) + 1);
    this.worker = this.host.worker;
    system.ports.set(this.id, this);
  }

  postMessage(data: unknown, transfer: Transferable[] = []): void {
    const message: ToJob = { port: this.id, service: this.service, data };
    this.worker.postMessage(message, transfer);
    this.inFlight++;
    this.host.laneWork++;
  }

  /** A message that asks for no answer (a lane's setup: `terrainLightPool.ts` grid): never counted in flight, or its worker looked busy for good (JOB-01). */
  postSetup(data: unknown, transfer: Transferable[] = []): void {
    const message: ToJob = { port: this.id, service: this.service, data };
    this.worker.postMessage(message, transfer);
  }

  /** An answer came on this lane: one message less in flight on its worker; whether that left the worker with none. */
  answered(): boolean {
    if (this.inFlight === 0) return false;
    this.inFlight--;
    this.host.laneWork--;
    return this.host.laneWork === 0;
  }

  /** The lane let go (its service's state stays in the worker for the next lane of the kind). */
  terminate(): void {
    if (!system.ports.delete(this.id)) return;
    this.worker.postMessage({ close: this.id } satisfies CloseLane);
    const freed = this.inFlight > 0 && this.host.laneWork === this.inFlight;
    this.host.laneWork -= this.inFlight;
    this.inFlight = 0;
    this.host.ports--;
    const left = (this.host.services.get(this.service) ?? 1) - 1;
    if (left > 0) this.host.services.set(this.service, left); else this.host.services.delete(this.service);
    // Its worker counted free now, as an answer that empties it does (`answered`): the waiting jobs given out (JOB-16: they waited for another job's answer or a new one).
    if (freed) dispatch();
    retireIdle();
  }

}

/** A lane's setup posted to `worker` (a pool's port, or any worker): on a pool's port, not counted as a message awaiting an answer (`JobPort.postSetup`). */
export function postSetup(worker: Worker, data: unknown): void {
  if (worker instanceof JobPort) worker.postSetup(data);
  else worker.postMessage(data);
}

/** A port of the pool for one of `service`'s lanes (`jobLanes` lanes at most), typed as the `Worker` its pool was written for. */
export function jobPort(service: JobService): Worker {
  return new JobPort(service) as unknown as Worker;
}

/** A LANE OF THIS PAGE'S POOL HANDED TO ANOTHER THREAD (the simulation's worker): a channel, one end served by a worker of the pool (`job.worker.ts` adopt), the other returned to be transferred; that thread and the worker talk straight. DO NOT let another thread open a pool of its own: its workers were more isolates in the one V8 cage every worker of the page shares. `lost`: told if the serving worker fails (a port says nothing of it). */
export function jobChannel(service: JobService, lost: () => void): MessagePort {
  const host = place(service);
  host.ports++;
  host.services.set(service, (host.services.get(service) ?? 0) + 1);
  host.channelLost.push(lost);
  const channel = new MessageChannel();
  host.worker.postMessage({ adopt: service, port: channel.port1 } satisfies AdoptLane, [channel.port1]);
  return channel.port2;
}

/** A lane's port (`jobChannel`) as the `Worker` a pool was written for: its messages both ways, `terminate` closing it. */
export function portWorker(port: MessagePort): Worker {
  return {
    postMessage: (message: unknown, transfer?: Transferable[]) => port.postMessage(message, transfer ?? []),
    set onmessage(handler: ((event: MessageEvent) => void) | null) { port.onmessage = handler; },
    set onmessageerror(handler: ((event: MessageEvent) => void) | null) { port.onmessageerror = handler; },
    onerror: null,
    terminate: () => port.close(),
  } as unknown as Worker;
}
