import type { FromJob, JobService, ToJob } from './jobScope';

/** THE JOB SYSTEM: one pool of workers (hardwareConcurrency - 2) for every kind of work off the page, in place of a pool per kind */

/** The workers of this thread's pool, made when first needed. */
let workers: Worker[] | null = null;
const ports = new Map<number, JobPort>();
let nextPort = 1;

/** How many workers the pool holds: the cores less the page's and the simulation's (at least one). */
export function jobWorkers(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  // Inside the simulation's worker (no document): its own few, for the lots' bays and the junctions' pairs.
  if (typeof document === 'undefined') return Math.max(1, Math.min(2, cores - 2));
  return Math.max(1, cores - 2);
}

/** How many lanes a kind of work may have: never more than the pool's workers (a lane per worker, `jobPort`). */
export const jobLanes = (most: number): number => Math.max(1, Math.min(most, jobWorkers()));

function pool(): Worker[] {
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
    return worker;
  });
  return workers;
}

/** A kind of work's lane in the pool: answers as a `Worker` does (`onmessage`, `onerror`, `postMessage`, `terminate`). */
export class JobPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly worker: Worker;
  private readonly id = nextPort++;

  constructor(private readonly service: JobService, lane: number) {
    const all = pool();
    // Each kind's lanes on different workers, the kinds spread over them: a service's own state is per worker.
    this.worker = all[(hash(service) + lane) % all.length]!;
    ports.set(this.id, this);
  }

  postMessage(data: unknown, transfer: Transferable[] = []): void {
    const message: ToJob = { port: this.id, service: this.service, data };
    this.worker.postMessage(message, transfer);
  }

  /** The lane let go (its service's state stays in the worker for the next lane of the kind). */
  terminate(): void {
    ports.delete(this.id);
  }
}

/** A port of the pool for `service`'s lane `lane` (`jobLanes` lanes at most), typed as the `Worker` its pool was written for. */
export function jobPort(service: JobService, lane = 0): Worker {
  return new JobPort(service, lane) as unknown as Worker;
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}
