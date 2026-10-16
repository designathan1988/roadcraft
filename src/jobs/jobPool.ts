import type { FromJob, JobService, ToJob } from './jobScope';

/** THE JOB SYSTEM: one pool of workers (hardwareConcurrency - 2, within the machine's memory) for every kind of work off the page, in place of a pool per kind */
/** DO NOT make every worker at the start nor give a kind's job to any free worker: each worker is a whole JS heap with the code and state of every service it ran, so 22 of them each running every service took the page's process past 6 GB on a 3 x 3 tile region (2026-10-16, Chrome memory-infra: 2.8 GB of V8 in the workers, out of memory at 8 GB) - workers are made as work waits, and a kind's jobs go first to the workers that already run it */

/** What one busy worker costs the page's process at its peak: its V8 heap with its services' code and state (about 110 MB), its young generation grown to its most under a fast allocator (about 56 MB) and the arrays it hands the page (2026-10-16, memory-infra of a streamed opening: 16 workers, 1.77 GB of V8 and 1.2 GB of array buffers). */
const WORKER_BYTES = 512 * 2 ** 20;
/** The share of the machine's memory the pool may take: the page, the GPU's process and the system keep the rest. */
const POOL_SHARE = 1 / 8;
/** DO NOT size the pool by the machine alone: the page and every worker of its process share ONE V8 heap cage of 4 GB (pointer compression's shared cage, V8 9.2; the V8 sandbox needs it), and a streamed opening died "out of memory" with 3.4 GB of V8 across 24 workers (2026-10-16) - the pool takes a fifth of it, at a busy worker's V8 heap and young generation (~170 MB). */
const CAGE_BYTES = 4 * 2 ** 30;
/** Two fifths of the cage for the pool (2026-10-16: the worker that took it down was a Clipper2 union that never ended, fixed in `scripts/patches`; a busy worker holds 100-250 MB): 9 workers at most by the cage, the page's heap and the simulation's keep the rest. */
const POOL_CAGE_SHARE = 2 / 5;
const WORKER_HEAP_BYTES = 170 * 2 ** 20;

/** Services whose one job runs for seconds: each gets a worker of its own, so no other lane waits behind it (a streamed tile is 2-25 s of generation and growth, `cityTile.worker.ts`: the roads', the ground's and the cells' lanes waited behind it at the opening, 2026-10-16). */
const LONG_RUNNING: readonly JobService[] = ['growth', 'cityTiles'];

/** A job of the central queue (Cidade's job pool, `submit`): its message written when a worker takes it, answered once. */
interface JobSpec {
  readonly service: JobService;
  /** A newer job with the same key replaces this one: never sent if still waiting, its answer dropped if begun. */
  readonly key: string | null;
  /** Lower first: the job's distance to the eye (`focusDistance`), in metres, or below it for what must come first. */
  readonly priority: number;
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
interface Queued { readonly seq: number; readonly spec: JobSpec; state: 'waiting' | 'running' | 'over' }

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
    const job: Queued = { seq: ++this.seq, spec, state: 'waiting' };
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
    return a.spec.priority < b.spec.priority || (a.spec.priority === b.spec.priority && a.seq < b.seq);
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
  ports: number;
  readonly services: Map<JobService, number>;
  readonly queuePorts: Map<JobService, number>;
  job: Queued | null;
  failed: boolean;
}

/** The pool of this thread: its workers (made as work waits, `grow`), its lanes by port, its queue and the point the view looks at. */
class JobSystem {
  readonly workers: Host[] = [];
  readonly ports = new Map<number, JobPort>();
  nextPort = 1;
  readonly queue = new JobQueue();
  focusX = 0;
  focusY = 0;
}
const system = new JobSystem();

/** The most workers the pool holds: the cores less the page's and the simulation's, and no more than `POOL_SHARE` of the machine's memory holds (at least one). */
export function jobWorkers(): number {
  const nav = typeof navigator !== 'undefined' ? navigator as Navigator & { readonly deviceMemory?: number } : undefined;
  const cores = nav?.hardwareConcurrency || 2;
  // Inside the simulation's worker (no document): its own few, for the lots' bays and the junctions' pairs.
  if (typeof document === 'undefined') return Math.max(1, Math.min(2, cores - 2));
  // `navigator.deviceMemory`: the machine's memory in GB, rounded by the browser; unknown, the cores alone.
  const byMemory = nav?.deviceMemory ? Math.floor((nav.deviceMemory * 2 ** 30 * POOL_SHARE) / WORKER_BYTES) : Infinity;
  const byCage = Math.floor((CAGE_BYTES * POOL_CAGE_SHARE) / WORKER_HEAP_BYTES);
  return Math.max(1, Math.min(cores - 2, byMemory, byCage));
}

/** How many lanes a kind of work may have: never more than the pool's workers (a lane per worker, `jobPort`). */
export const jobLanes = (most: number): number => Math.max(1, Math.min(most, jobWorkers()));

/** Whether a worker hosts a long-running service's lane. */
function hostsLong(host: Host): boolean {
  for (const service of host.services.keys()) if (LONG_RUNNING.includes(service)) return true;
  return false;
}

/** One more worker, while the pool has room (`jobWorkers`); null when full. */
function grow(): Host | null {
  if (system.workers.length >= jobWorkers()) return null;
  const worker = new Worker(new URL('../job.worker.ts', import.meta.url), { type: 'module' });
  const host: Host = { worker, ports: 0, services: new Map(), queuePorts: new Map(), job: null, failed: false };
  worker.onmessage = (event: MessageEvent<FromJob>) => {
    const port = system.ports.get(event.data.port);
    if (port) {
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
    failHost(host, event.message || 'a job worker failed', true);
  };
  worker.onmessageerror = () => {
    for (const port of system.ports.values()) if (port.worker === worker) port.onmessageerror?.(new MessageEvent('messageerror'));
    failHost(host, 'a job worker\'s answer could not be read', false);
  };
  system.workers.push(host);
  return host;
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
 *  - DO NOT give it to a worker running growth while another worker could take it: it waited seconds behind it. */
function hostFor(service: JobService): Host | null {
  const all = system.workers;
  const short = all.some((h) => !h.failed && !hostsLong(h)) || all.length < jobWorkers();
  let cold: Host | null = null;
  for (const host of all) {
    if (host.job || host.failed || (short && hostsLong(host))) continue;
    if (host.queuePorts.has(service)) return host;
    cold ??= host;
  }
  return grow() ?? cold;
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
  if (system.workers.length === 0) grow();
}

/** The point the view looks at, each frame (`flatAtlas.ts` `focus`): what the queue's jobs are ranked by. */
export function setJobFocus(x: number, y: number): void {
  system.focusX = x;
  system.focusY = y;
}

/** How far a point is from where the view looks (`setJobFocus`): a queued job's priority. */
export const focusDistance = (x: number, y: number): number => Math.hypot(x - system.focusX, y - system.focusY);

/** DO NOT pin a lane by a hash of its service: two kinds landed on one worker and a lane waited seconds behind growth */
function place(service: JobService): Host {
  const all = system.workers;
  let best: Host | null = null;
  let bestScore = Infinity;
  for (const w of all) {
    // A long-running service alone on its worker, and nothing else beside one; lanes of a kind on different workers.
    const score = (LONG_RUNNING.includes(service) ? w.ports * 1000 : 0) + (hostsLong(w) ? 100_000 : 0) + (w.services.get(service) ?? 0) * 10_000 + w.ports;
    if (score < bestScore) { bestScore = score; best = w; }
  }
  // A worker with nothing on it scores 0: one is made for the lane while the pool has room, as if every worker were there.
  if (best === null || bestScore > 0) best = grow() ?? best;
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
  }

  /** The lane let go (its service's state stays in the worker for the next lane of the kind). */
  terminate(): void {
    if (!system.ports.delete(this.id)) return;
    this.host.ports--;
    const left = (this.host.services.get(this.service) ?? 1) - 1;
    if (left > 0) this.host.services.set(this.service, left); else this.host.services.delete(this.service);
  }
}

/** A port of the pool for one of `service`'s lanes (`jobLanes` lanes at most), typed as the `Worker` its pool was written for. */
export function jobPort(service: JobService): Worker {
  return new JobPort(service) as unknown as Worker;
}
