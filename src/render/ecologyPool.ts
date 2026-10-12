import { TILES } from '@core/planetTiles';
import type { EcologyField, EcologyInput } from '@world/ecology';

/**
 * THE PLANET'S ECOSYSTEMS, WORKED OUT OFF THE PAGE. A plate brought in full
 * as the view nears it (`planet/terrainAtlas.ts`) read its whole ecosystem
 * on the page's thread - 90 ms of one frame, a hitch at every plate the
 * zoom or a drag brought in (profiled 2026-10-10). As Cesium hands its
 * terrain meshes to a worker (`TaskProcessor`) and a planet renderer shows
 * the coarse level until the fine one is made (Proland), the field is read
 * by one worker here and the plate shows its land without it meanwhile.
 *
 * One job per plate at a time: asked again before its turn, the newer land
 * replaces the queued one; the plate nearest the place looked at goes first.
 */

interface Job {
  readonly key: number;
  readonly input: EcologyInput;
  readonly transfer: ArrayBuffer[];
  readonly done: (field: EcologyField) => void;
  readonly failed: () => void;
}

let worker: Worker | null = null;
let broken = false;
let busy: (Job & { id: number }) | null = null;
const queue: Job[] = [];
let nextId = 1;
let focus = -1;
const listeners = new Set<() => void>();

function start(): Worker | null {
  if (worker || broken) return worker;
  if (typeof Worker === 'undefined') { broken = true; return null; }
  try {
    worker = new Worker(new URL('./ecology.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; field?: EcologyField; error?: string }>) => {
      const job = busy;
      busy = null;
      if (job && job.id === event.data.id) {
        if (event.data.field) job.done(event.data.field);
        else { console.warn('[terrain] an ecosystem failed in its worker', event.data.error); job.failed(); }
        for (const listener of listeners) listener();
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

/** How far a plate is from the one looked at: 0 there, 2 opposite. */
function rank(key: number): number {
  if (focus < 0) return 0;
  const a = TILES[key]?.centre, b = TILES[focus]?.centre;
  return a && b ? 1 - (a.x * b.x + a.y * b.y + a.z * b.z) : 0;
}

function pump(): void {
  if (busy || !queue.length || !worker) return;
  let best = 0;
  for (let i = 1; i < queue.length; i++) if (rank(queue[i]!.key) < rank(queue[best]!.key)) best = i;
  const [job] = queue.splice(best, 1);
  busy = { ...job!, id: nextId++ };
  worker.postMessage({ id: busy.id, input: job!.input }, job!.transfer);
}

/** Whether ecosystems can be read off the page here (a browser with workers). */
export function ecologyOffPage(): boolean {
  return start() !== null;
}

/**
 * Reads plate `key`'s ecosystem in the worker: `done` with the field, or
 * `failed` (the caller reads it on the page then). The input's arrays in
 * `transfer` are handed over - they must be the caller's own copies.
 */
export function readEcology(key: number, input: EcologyInput, transfer: ArrayBuffer[], done: (field: EcologyField) => void, failed: () => void): void {
  if (!start()) { failed(); return; }
  const queued = queue.findIndex((j) => j.key === key);
  const job: Job = { key, input, transfer, done, failed };
  if (queued >= 0) queue[queued] = job; else queue.push(job);
  pump();
}

/** The plate looked at: those nearest it are read first. */
export function setEcologyFocus(key: number): void {
  focus = key;
}

/** Called each time a field comes back (the scene draws again). */
export function onEcologyRead(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
