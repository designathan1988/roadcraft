import type { EcologyField, EcologyInput } from '@world/ecology';
import type { FarWoods, FarWoodsAsk } from './farWoods';

/** THE ECOSYSTEMS, WORKED OUT OFF THE PAGE. */

interface Job {
  readonly kind: 'near';
  readonly key: number;
  readonly input: EcologyInput;
  readonly transfer: ArrayBuffer[];
  readonly done: (field: EcologyField) => void;
  readonly failed: () => void;
}
interface FarJob {
  readonly kind: 'far';
  readonly key: number;
  readonly far: FarWoodsAsk;
  readonly done: (woods: FarWoods) => void;
  readonly failed: () => void;
}
type Running = (Job | FarJob) & { id: number };

let worker: Worker | null = null;
let broken = false;
let busy: Running | null = null;
/** The plates' ecosystems first, in the order asked; the far woods after all of them. */
const queue: (Job | FarJob)[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function start(): Worker | null {
  if (worker || broken) return worker;
  if (typeof Worker === 'undefined') { broken = true; return null; }
  try {
    worker = new Worker(new URL('./ecology.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; field?: EcologyField; woods?: FarWoods; error?: string }>) => {
      const job = busy;
      busy = null;
      if (job && job.id === event.data.id) {
        if (job.kind === 'far') {
          if (event.data.woods) job.done(event.data.woods);
          else { console.warn('[terrain] the far woods of a plate failed in their worker', event.data.error); job.failed(); }
        } else {
          if (event.data.field) job.done(event.data.field);
          else { console.warn('[terrain] an ecosystem failed in its worker', event.data.error); job.failed(); }
          for (const listener of listeners) listener();
        }
      }
      pump();
    };
    worker.onerror = (event) => {
      console.warn('[terrain] the ecosystem worker failed', event.message);
      const job = busy;
      busy = null;
      job?.failed();
      pump();
    };
  } catch (error) {
    console.warn('[terrain] the ecosystem worker is unavailable; ecosystems are read on the page', error);
    broken = true;
    worker = null;
  }
  return worker;
}

function pump(): void {
  if (busy || !worker || !queue.length) return;
  const near = queue.findIndex((j) => j.kind === 'near');
  const job = queue.splice(near >= 0 ? near : 0, 1)[0]!;
  busy = { ...job, id: nextId++ };
  if (job.kind === 'near') worker.postMessage({ id: busy.id, input: job.input }, job.transfer);
  else worker.postMessage({ id: busy.id, far: job.far });
}

/** Whether ecosystems can be read off the page here (a browser with workers). */
export function ecologyOffPage(): boolean {
  return start() !== null;
}

/** Reads plate `key`'s ecosystem in the worker: `done` with the field, or `failed` (the caller reads it on the page then). */
export function readEcology(key: number, input: EcologyInput, transfer: ArrayBuffer[], done: (field: EcologyField) => void, failed: () => void): void {
  if (!start()) { failed(); return; }
  const queued = queue.findIndex((j) => j.kind === 'near' && j.key === key);
  const job: Job = { kind: 'near', key, input, transfer, done, failed };
  if (queued >= 0) queue[queued] = job; else queue.push(job);
  pump();
}

/** Called each time a field comes back (the scene draws again). */
export function onEcologyRead(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Works out plate `key`'s far woods in the worker (`farWoods.ts`), after every plate's ecosystem asked */
export function readFarWoods(key: number, far: FarWoodsAsk, done: (woods: FarWoods) => void, failed: () => void): void {
  if (!start()) { failed(); return; }
  const queued = queue.findIndex((j) => j.kind === 'far' && j.key === key);
  const job: FarJob = { kind: 'far', key, far, done, failed };
  if (queued >= 0) queue[queued] = job; else queue.push(job);
  pump();
}
