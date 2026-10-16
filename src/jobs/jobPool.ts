import type { FromJob, JobService, ToJob } from './jobScope';

/** THE JOB SYSTEM: one pool of workers (hardwareConcurrency - 2) for every kind of work off the page, in place of a pool per kind */

/** Services whose one job runs for seconds: each gets a worker of its own, so no other lane waits behind it. */
const LONG_RUNNING: readonly JobService[] = ['growth'];

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
    return job;
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
    for (let i = 0; ;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
      if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
      if (m === i) break;
      [a[i], a[m]] = [a[m]!, a[i]!];
      i = m;
    }
    return top;
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

/** The pool of this thread: its workers (made when first needed), its lanes by port, its queue and the point the view looks at. */
class JobSystem {
  workers: Host[] | null = null;
  readonly ports = new Map<number, JobPort>();
  nextPort = 1;
  readonly queue = new JobQueue();
  focusX = 0;
  focusY = 0;
}
const system = new JobSystem();

/** How many workers the pool holds: the cores less the page's and the simulation's (at least one). */
export function jobWorkers(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  // Inside the simulation's worker (no document): its own few, for the lots' bays and the junctions' pairs.
  if (typeof document === 'undefined') return Math.max(1, Math.min(2, cores - 2));
  return Math.max(1, cores - 2);
}

/** How many lanes a kind of work may have: never more than the pool's workers (a lane per worker, `jobPort`). */
export const jobLanes = (most: number): number => Math.max(1, Math.min(most, jobWorkers()));

/** Whether a worker hosts a long-running service's lane. */
function hostsLong(host: Host): boolean {
  for (const service of host.services.keys()) if (LONG_RUNNING.includes(service)) return true;
  return false;
}

function pool(): Host[] {
  if (system.workers) return system.workers;
  system.workers = Array.from({ length: jobWorkers() }, () => {
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
    return host;
  });
  return system.workers;
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

/** DO NOT give a queued job to a worker running growth while another worker could take it: it waited seconds behind it */
function dispatch(): void {
  if (system.queue.waiting === 0) return;
  let all: Host[];
  try {
    all = pool();
  } catch (error) {
    system.queue.failAll(`no job workers: ${String(error)}`);
    return;
  }
  if (all.every((h) => h.failed)) { system.queue.failAll('every job worker failed'); return; }
  const short = all.some((h) => !h.failed && !hostsLong(h));
  for (const host of all) {
    if (short && hostsLong(host)) continue;
    // One queued job at a time on a worker: the next goes to whichever worker is free first (Cidade's `pump`).
    while (!host.job && !host.failed) {
      const job = system.queue.take();
      if (!job) return;
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

/** The pool's workers made now, ahead of the first job (their modules load meanwhile). */
export function warmJobWorkers(): void {
  pool();
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
  const all = pool();
  let best: Host | null = null;
  let bestScore = Infinity;
  for (const w of all) {
    // A long-running service alone on its worker, and nothing else beside one; lanes of a kind on different workers.
    const score = (LONG_RUNNING.includes(service) ? w.ports * 1000 : 0) + (hostsLong(w) ? 100_000 : 0) + (w.services.get(service) ?? 0) * 10_000 + w.ports;
    if (score < bestScore) { bestScore = score; best = w; }
  }
  return best!;
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
