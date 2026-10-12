import { padGarmentPixels, type GarmentPadRequest, type GarmentPadResponse } from './garmentPadding';

type Input = Omit<GarmentPadRequest, 'id' | 'url'> & { readonly pixels: Uint8ClampedArray };
type FileInput = Omit<GarmentPadRequest, 'id' | 'pixels' | 'width' | 'height'> & { readonly url: string };
/** A padded sheet: its pixels and size. */
export interface PaddedSheet {
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}
interface Waiting {
  /** Pixels sent from the page; null for a sheet the worker reads by file. */
  readonly input: Input | null;
  readonly resolve: (sheet: PaddedSheet | null) => void;
  readonly reject: (error: unknown) => void;
}

const waiting = new Map<number, Waiting>();
let worker: Worker | null = null;
let unavailable = false;
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** On the page: the pixels sent are padded here; a sheet by file is left to the caller (null). */
function padHere(job: Waiting): void {
  if (!job.input) {
    job.resolve(null);
    return;
  }
  try {
    const { pixels, width, height, uvs, index, padding } = job.input;
    padGarmentPixels(pixels, width, height, uvs, index, padding);
    job.resolve({ pixels, width, height });
  } catch (error) {
    job.reject(error);
  }
}

function clearIdle(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
}

function idleSoon(): void {
  if (waiting.size || !worker) return;
  clearIdle();
  idleTimer = setTimeout(() => {
    if (waiting.size) return;
    worker?.terminate();
    worker = null;
    idleTimer = null;
  }, 30_000);
}

function failWorker(error: unknown): void {
  console.warn('Garment padding worker failed; finishing on the main thread.', error);
  unavailable = true;
  clearIdle();
  worker?.terminate();
  worker = null;
  for (const job of waiting.values()) padHere(job);
  waiting.clear();
}

function startWorker(): Worker | null {
  if (worker || unavailable) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    const created = new Worker(new URL('./garmentPadding.worker.ts', import.meta.url), { type: 'module' });
    created.onmessage = ({ data }: MessageEvent<GarmentPadResponse>) => {
      const job = waiting.get(data.id);
      if (!job) return;
      waiting.delete(data.id);
      if (data.pixels) {
        job.resolve({ pixels: data.pixels, width: data.width ?? job.input?.width ?? 0, height: data.height ?? job.input?.height ?? 0 });
      } else {
        console.warn('Garment padding worker rejected a texture; retrying on the main thread.', data.error);
        padHere(job);
      }
      idleSoon();
    };
    created.onerror = (event) => failWorker(event.message);
    created.onmessageerror = (event) => failWorker(event);
    worker = created;
    return created;
  } catch (error) {
    failWorker(error);
    return null;
  }
}

function send(message: Omit<GarmentPadRequest, 'id'>, job: Waiting): void {
  const active = startWorker();
  if (!active) {
    padHere(job);
    return;
  }
  clearIdle();
  const id = nextId++;
  waiting.set(id, job);
  try {
    // Pixels are cloned, not moved, so the same bytes remain if the worker fails.
    active.postMessage({ id, ...message });
  } catch (error) {
    waiting.delete(id);
    console.warn('Garment padding request could not be sent; retrying on the main thread.', error);
    padHere(job);
    idleSoon();
  }
}

/** Runs pixel padding away from the frame loop, with the same algorithm as the fallback. */
export function padGarmentInWorker(input: Input): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => send(input, { input, resolve: (sheet) => resolve(sheet!.pixels), reject }));
}

/**
 * A sheet fetched, decoded, read and padded in the worker, its pixels moved
 * back (a transfer: no copy). Null when there is no worker or it could not:
 * the caller reads the sheet itself.
 */
export function padGarmentFileInWorker(input: FileInput): Promise<PaddedSheet | null> {
  return new Promise((resolve, reject) => send({ ...input, width: 0, height: 0 }, { input: null, resolve, reject }));
}
