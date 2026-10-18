/** A JOB WORKER IN ANOTHER PROCESS (the desktop's, `desktop/jobs.cjs`): the shape of a `Worker` the pool was written for (`jobPool.ts` grow), over a port to a thread of a utility process, so its heap is in that process's V8 cage, not in the page's (Electron `utilityProcess`; V8 pointer compression: one cage a process) */

/** What the pool uses of a worker. */
export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

/** What the host in the other process posts when its thread failed or stopped (`desktop/jobs.cjs`). */
export interface ThreadFailed { readonly threadFailed: string }
const isThreadFailed = (data: unknown): data is ThreadFailed =>
  typeof data === 'object' && data !== null && typeof (data as { threadFailed?: unknown }).threadFailed === 'string';

/** A buffer in shared memory: none reaches another process (the structured clone refuses one past its agent cluster, HTML "StructuredSerialize"). */
const isShared = (value: unknown): value is SharedArrayBuffer =>
  typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer;

/** `value` as another process may be sent it: every SharedArrayBuffer (and every view on one) a copy of its bytes now, one copy a buffer however often it is named; everything else as it is. The same object when nothing in it is shared. */
export function unshared<T>(value: T): T {
  const copies = new Map<SharedArrayBuffer, ArrayBuffer>();
  const done = new Map<object, unknown>();
  const copyOf = (buffer: SharedArrayBuffer): ArrayBuffer => {
    let copy = copies.get(buffer);
    if (!copy) { copy = new ArrayBuffer(buffer.byteLength); new Uint8Array(copy).set(new Uint8Array(buffer)); copies.set(buffer, copy); }
    return copy;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v !== 'object' || v === null) return v;
    if (done.has(v)) return done.get(v);
    if (isShared(v)) return copyOf(v);
    if (ArrayBuffer.isView(v)) {
      if (!isShared(v.buffer)) return v;
      const Kind = v.constructor as new (buffer: ArrayBuffer, offset: number, length: number) => ArrayBufferView;
      const length = v instanceof DataView ? v.byteLength : (v as unknown as { length: number }).length;
      return new Kind(copyOf(v.buffer), v.byteOffset, length);
    }
    if (v instanceof ArrayBuffer || v instanceof Blob || (typeof MessagePort !== 'undefined' && v instanceof MessagePort)) return v;
    if (v instanceof Map) {
      let changed = false;
      const out = new Map();
      done.set(v, out);
      for (const [k, x] of v) { const k2 = walk(k), x2 = walk(x); if (k2 !== k || x2 !== x) changed = true; out.set(k2, x2); }
      if (!changed) done.set(v, v);
      return changed ? out : v;
    }
    if (v instanceof Set) {
      let changed = false;
      const out = new Set();
      done.set(v, out);
      for (const x of v) { const x2 = walk(x); if (x2 !== x) changed = true; out.add(x2); }
      if (!changed) done.set(v, v);
      return changed ? out : v;
    }
    if (Array.isArray(v)) {
      let changed = false;
      const out: unknown[] = new Array(v.length);
      done.set(v, out);
      for (let k = 0; k < v.length; k++) { const x2 = walk(v[k]); if (x2 !== v[k]) changed = true; out[k] = x2; }
      if (!changed) done.set(v, v);
      return changed ? out : v;
    }
    // A plain record: its own fields (a class's instance is posted as its fields too, as the structured clone does).
    let changed = false;
    const out: Record<string, unknown> = {};
    done.set(v, out);
    for (const key of Object.keys(v)) { const x = (v as Record<string, unknown>)[key]; const x2 = walk(x); if (x2 !== x) changed = true; out[key] = x2; }
    if (!changed) done.set(v, v);
    return changed ? out : v;
  };
  return walk(value) as T;
}

/** A job worker whose thread is in another process: messages posted before its port came are held, then sent in order; its port given by `connect` (one port a worker, `desktopJobs.ts`). */
export class ProcessWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  private port: MessagePort | null = null;
  private readonly held: { readonly message: unknown; readonly transfer: Transferable[] }[] = [];
  private ended = false;

  constructor(connect: () => Promise<MessagePort>) {
    connect().then((port) => {
      if (this.ended) { port.close(); return; }
      this.port = port;
      port.onmessage = (event: MessageEvent) => {
        if (isThreadFailed(event.data)) { this.fail(event.data.threadFailed); return; }
        this.onmessage?.(event);
      };
      port.onmessageerror = (event: MessageEvent) => this.onmessageerror?.(event);
      for (const { message, transfer } of this.held.splice(0)) this.send(message, transfer);
    }, (error: unknown) => this.fail(`the job process could not be reached: ${String(error)}`));
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    if (this.ended) return;
    if (!this.port) { this.held.push({ message, transfer }); return; }
    this.send(message, transfer);
  }

  terminate(): void {
    this.ended = true;
    this.held.length = 0;
    this.port?.close();
    this.port = null;
  }

  /** The thread lost (its process stopped, or it failed): told as a worker's error is, nothing sent to it again. */
  fail(why: string): void {
    if (this.ended) return;
    this.ended = true;
    this.held.length = 0;
    this.port?.close();
    this.port = null;
    this.onerror?.({ message: why } as ErrorEvent);
  }

  private send(message: unknown, transfer: Transferable[]): void {
    // What is moved stays moved (a port, a buffer of its own); a buffer in shared memory is copied (`unshared`) and so not in the list.
    const moved = transfer.filter((t) => !isShared(t));
    try {
      this.port!.postMessage(unshared(message), moved);
    } catch (error) {
      this.fail(`a message could not reach the job process: ${String(error)}`);
    }
  }
}
