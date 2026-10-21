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

/** A buffer in shared memory written once and never again (a record table, `recordTable.ts`) as a job process's thread keeps it: its id, with its bytes the first time that thread is sent it (`ProcessWorker` keeps). */
export interface KeptBuffer { readonly keptBuffer: number; readonly bytes?: ArrayBuffer }
const isKept = (value: unknown): value is KeptBuffer => typeof (value as KeptBuffer | null)?.keptBuffer === 'number';
/** Page to thread: the kept buffers whose page buffer is gone (collected), let go there too. */
export interface ForgetKept { readonly forgetKept: readonly number[] }
export const isForgetKept = (data: unknown): data is ForgetKept => Array.isArray((data as ForgetKept | null)?.forgetKept);

/** `value` as another process may be sent it: every SharedArrayBuffer (and every view on one) a copy of its bytes now, one copy a buffer however often it is named; everything else as it is. The same object when nothing in it is shared. `kept`: a buffer the other side keeps, sent as its token (`KeptBuffer`) in place of a copy. */
export function unshared<T>(value: T, kept?: (buffer: SharedArrayBuffer) => KeptBuffer | null): T {
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
    if (isShared(v)) { const token = kept?.(v) ?? copyOf(v); done.set(v, token); return token; }
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

/** The thread's side of `KeptBuffer`: each token in `value` put back as the buffer it names, its bytes kept the first time they come (`keep`); in place. DO NOT copy a record table into the job process with every job: the large city's buildings are one table (`editor/preparedCity.ts`, ~8 MB), and every cell job went there with a copy of it. */
export function restoreKept(value: unknown, keep: Map<number, ArrayBuffer>): unknown {
  const seen = new Set<object>();
  const put = (v: unknown): unknown => {
    if (!isKept(v)) { walk(v); return v; }
    if (v.bytes) keep.set(v.keptBuffer, v.bytes);
    const buffer = keep.get(v.keptBuffer);
    if (!buffer) throw new Error(`[jobs] a kept buffer this thread never got (${v.keptBuffer})`);
    return buffer;
  };
  const walk = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || seen.has(v) || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return;
    seen.add(v);
    if (v instanceof Map) { for (const [k, x] of v) { const y = put(x); if (y !== x) v.set(k, y); } return; }
    if (v instanceof Set) { for (const x of v) walk(x); return; }
    const record = v as Record<string, unknown>;
    for (const key of Object.keys(record)) { const x = record[key]; const y = put(x); if (y !== x) record[key] = y; }
  };
  return put(value);
}

/** Each buffer kept by job threads: its id, and the workers whose thread holds it. */
const keptIds = new WeakMap<SharedArrayBuffer, number>();
let nextKept = 1;
const living = new Set<ProcessWorker>();
/** A kept buffer collected on the page: let go in every thread holding it (`ForgetKept`). */
const collected = typeof FinalizationRegistry === 'undefined' ? null : new FinalizationRegistry<number>((id) => { for (const worker of living) worker.forget(id); });

/** A job worker whose thread is in another process: messages posted before its port came are held, then sent in order; its port given by `connect` (one port a worker, `desktopJobs.ts`). */
export class ProcessWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  private port: MessagePort | null = null;
  private readonly held: { readonly message: unknown; readonly transfer: Transferable[] }[] = [];
  private ended = false;
  /** The kept buffers its thread holds (`KeptBuffer`). */
  private readonly given = new Set<number>();

  /** `keeps`: which shared buffers are written once and never again (a record table), kept by the thread once sent (`KeptBuffer`). */
  constructor(connect: () => Promise<MessagePort>, private readonly keeps?: (buffer: SharedArrayBuffer) => boolean) {
    living.add(this);
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
    living.delete(this);
    this.ended = true;
    this.held.length = 0;
    this.port?.close();
    this.port = null;
  }

  /** The thread lost (its process stopped, or it failed): told as a worker's error is, nothing sent to it again. */
  fail(why: string): void {
    living.delete(this);
    if (this.ended) return;
    this.ended = true;
    this.held.length = 0;
    this.port?.close();
    this.port = null;
    this.onerror?.({ message: why } as ErrorEvent);
  }

  /** A kept buffer collected on the page: its thread lets it go. */
  forget(id: number): void {
    if (this.given.delete(id)) this.postMessage({ forgetKept: [id] } satisfies ForgetKept);
  }

  /** A buffer as this thread is sent it: its token, with a copy of its bytes the first time; null for one not kept (copied with the message). */
  private kept(buffer: SharedArrayBuffer): KeptBuffer | null {
    if (!this.keeps!(buffer)) return null;
    let id = keptIds.get(buffer);
    if (id === undefined) { keptIds.set(buffer, id = nextKept++); collected?.register(buffer, id); }
    if (this.given.has(id)) return { keptBuffer: id };
    this.given.add(id);
    const bytes = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(bytes).set(new Uint8Array(buffer));
    return { keptBuffer: id, bytes };
  }

  private send(message: unknown, transfer: Transferable[]): void {
    // DO NOT move a buffer to the shell's port: only ports cross it (Electron `MessagePortMain.postMessage`, transfer `MessagePortMain[]`); the shell's deserializer reads the message's bytes alone, no buffer moved beside it (`shell/common/v8_util.cc` V8Deserializer: V8 reads a moved buffer only from a transfer map, none there), so the message comes out null - the cell jobs move their paving's buffers. A buffer is copied with the message; a buffer in shared memory is copied too (`unshared`).
    const moved = transfer.filter((t) => typeof MessagePort !== 'undefined' && t instanceof MessagePort);
    try {
      const out = unshared(message, this.keeps ? (buffer) => this.kept(buffer) : undefined);
      // DO NOT leave a port in the message: the shell's deserializer reads no port in it (Blink writes one as a host object, `shell/common/v8_util.cc` V8Deserializer knows only its NativeImage), and the message came out null - each job thread's store setup (`{ storeSetup, port }`, `main.ts`) killed the thread ("Cannot use 'in' operator to search for 'adopt' in null"). The port goes in the list alone; the job process puts it back as `port` (`desktop/jobs.cjs` serve).
      const port = (out as { port?: unknown } | null)?.port;
      this.port!.postMessage(typeof MessagePort !== 'undefined' && port instanceof MessagePort ? { ...(out as object), port: null } : out, moved);
    } catch (error) {
      this.fail(`a message could not reach the job process: ${String(error)}`);
    }
  }
}
