import type { FromJob, JobService, ToJob } from './jobScope';

/** THE JOB SYSTEM: one pool of workers (hardwareConcurrency - 2) for every kind of work off the page, in place of a pool per kind */

/** The workers of this thread's pool, made when first needed, and what each one hosts (`place`). */
interface Host { readonly worker: Worker; ports: number; readonly services: Map<JobService, number> }
let workers: Host[] | null = null;
const ports = new Map<number, JobPort>();
let nextPort = 1;

/** Services whose one job runs for seconds: each gets a worker of its own, so no other lane waits behind it. */
const LONG_RUNNING: readonly JobService[] = ['growth'];

/** How many workers the pool holds: the cores less the page's and the simulation's (at least one). */
export function jobWorkers(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  // Inside the simulation's worker (no document): its own few, for the lots' bays and the junctions' pairs.
  if (typeof document === 'undefined') return Math.max(1, Math.min(2, cores - 2));
  return Math.max(1, cores - 2);
}

/** How many lanes a kind of work may have: never more than the pool's workers (a lane per worker, `jobPort`). */
export const jobLanes = (most: number): number => Math.max(1, Math.min(most, jobWorkers()));

function pool(): Host[] {
  if (workers) return workers;
  workers = Array.from({ length: jobWorkers() }, () => {
    const worker = new Worker(new URL('./job.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<FromJob>) => {
      const port = ports.get(event.data.port);
      if (!port) return;
      if (event.data.error !== undefined) port.onerror?.(new ErrorEvent('error', { message: event.data.error }));
      else port.onmessage?.(new MessageEvent('message', { data: event.data.data }));
    };
    worker.onerror = (event) => { for (const port of ports.values()) if (port.worker === worker) port.onerror?.(event); };
    worker.onmessageerror = () => { for (const port of ports.values()) if (port.worker === worker) port.onmessageerror?.(new MessageEvent('messageerror')); };
    return { worker, ports: 0, services: new Map<JobService, number>() };
  });
  return workers;
}

/** DO NOT pin a lane by a hash of its service: two kinds landed on one worker and a lane waited seconds behind growth */
function place(service: JobService): Host {
  const all = pool();
  const long = (w: Host): boolean => [...w.services.keys()].some((s) => LONG_RUNNING.includes(s));
  let best: Host | null = null;
  let bestScore = Infinity;
  for (const w of all) {
    // A long-running service alone on its worker, and nothing else beside one; lanes of a kind on different workers.
    const score = (LONG_RUNNING.includes(service) ? w.ports * 1000 : 0) + (long(w) ? 100_000 : 0) + (w.services.get(service) ?? 0) * 10_000 + w.ports;
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
  private readonly id = nextPort++;
  private readonly host: Host;

  constructor(private readonly service: JobService) {
    // The least busy worker; a service's own state is per worker, so a lane stays on the one it was given.
    this.host = place(service);
    this.host.ports++;
    this.host.services.set(service, (this.host.services.get(service) ?? 0) + 1);
    this.worker = this.host.worker;
    ports.set(this.id, this);
  }

  postMessage(data: unknown, transfer: Transferable[] = []): void {
    const message: ToJob = { port: this.id, service: this.service, data };
    this.worker.postMessage(message, transfer);
  }

  /** The lane let go (its service's state stays in the worker for the next lane of the kind). */
  terminate(): void {
    if (!ports.delete(this.id)) return;
    this.host.ports--;
    const left = (this.host.services.get(this.service) ?? 1) - 1;
    if (left > 0) this.host.services.set(this.service, left); else this.host.services.delete(this.service);
  }
}

/** A port of the pool for one of `service`'s lanes (`jobLanes` lanes at most), typed as the `Worker` its pool was written for. */
export function jobPort(service: JobService): Worker {
  return new JobPort(service) as unknown as Worker;
}
