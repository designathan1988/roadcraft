import { type PartStore, SAVES_STORE, indexedDbParts, openSaves } from './saveStore';

/** THE SAVE STORE AS A WORKER OPENS IT: the browser's IndexedDB, or on the desktop the shell's saves writer (`desktop/saves.cjs`) through a port of the worker's own that the page handed it (`desktopSaves.ts` `connect`) - never the page in between, so the desktop's workers read and write the tiles as a browser's do */

/** What the page posts a worker of its own about its store, before any job (`jobs/jobPool.ts` `setJobWorkerSetup`): that it comes by a port, then the port. */
export interface StoreSetup {
  readonly storeSetup: true;
  /** The store comes by a port: wait for it, DO NOT open IndexedDB (on the desktop it is not the save). */
  readonly byPort?: boolean;
  readonly port?: MessagePort;
}

export const isStoreSetup = (data: unknown): data is StoreSetup =>
  typeof data === 'object' && data !== null && (data as { storeSetup?: unknown }).storeSetup === true;

interface Answer { readonly id: number; readonly ok: boolean; readonly result?: unknown }

/** This worker's store, once known; what to call when the port comes. */
let backend: Promise<PartStore> | null = null;
let give: ((store: PartStore) => void) | null = null;
/** The port's store in use: told to give up what it waits for when a new port replaces it (the writer restarted). */
let current: { readonly drop: () => void } | null = null;

/** A setup message taken in (`job.worker.ts`, the simulation's worker). */
export function takeStoreSetup(setup: StoreSetup): void {
  if (setup.byPort && !backend) backend = new Promise<PartStore>((resolve) => { give = resolve; });
  if (!setup.port) return;
  current?.drop();
  const store = portParts(setup.port);
  current = store;
  if (give) { give(store); give = null; } else backend = Promise.resolve(store);
}

/** The store of this worker: IndexedDB unless the page said it comes by a port. */
export function workerParts(): PartStore {
  const open = (): Promise<PartStore> => (backend ??= Promise.resolve(indexedDbParts(openSaves, SAVES_STORE)));
  return {
    get: async (keys) => (await open()).get(keys),
    write: async (put, remove, marks) => (await open()).write(put, remove, marks),
    marks: async (prefix) => (await (await open()).marks?.(prefix)) ?? [],
  };
}

/** The saves writer over a port (the requests of `desktop/saves.cjs`: 'get' and 'write', answered by id in the order asked). */
export function portParts(port: MessagePort): PartStore & { readonly drop: () => void } {
  let next = 1;
  const waiting = new Map<number, (answer: Answer | null) => void>();
  port.onmessage = (event: MessageEvent<Answer>) => {
    const done = waiting.get(event.data.id);
    waiting.delete(event.data.id);
    done?.(event.data);
  };
  const call = (request: object): Promise<Answer | null> => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    try { port.postMessage({ id, ...request }); } catch (error) { waiting.delete(id); console.error('[save] the request did not reach the saves writer', error); resolve(null); }
  });
  return {
    async get(keys) {
      const answer = await call({ op: 'get', keys });
      const found = answer?.ok && Array.isArray(answer.result) ? (answer.result as unknown[]) : [];
      return keys.map((_, i) => { const bytes = found[i]; return bytes instanceof Uint8Array ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null; });
    },
    async write(put, remove, marks) {
      const bytes = await Promise.all(put.map(async ([key, blob]) => [key, new Uint8Array(await blob.arrayBuffer())] as const));
      return (await call({ op: 'write', put: [...bytes, ...markBytes(marks)], remove }))?.ok === true;
    },
    async marks(prefix) {
      return markTexts(await call({ op: 'marks', prefix }));
    },
    drop() {
      for (const done of waiting.values()) done(null);
      waiting.clear();
      port.close();
    },
  };
}

/** Marks as the saves writer keeps them: a file each, its text's bytes (`desktop/saves.cjs`). */
export const markBytes = (marks: readonly (readonly [string, string])[] = []): (readonly [string, Uint8Array])[] =>
  marks.map(([key, text]) => [key, new TextEncoder().encode(text)] as const);

/** The saves writer's answer to 'marks' (each key and its bytes) as texts; none when it failed. */
export function markTexts(answer: { readonly ok: boolean; readonly result?: unknown } | null): (readonly [string, string])[] {
  if (!answer?.ok || !Array.isArray(answer.result)) return [];
  const out: [string, string][] = [];
  for (const entry of answer.result as unknown[]) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !(entry[1] instanceof Uint8Array)) continue;
    out.push([entry[0], new TextDecoder().decode(entry[1])]);
  }
  return out;
}
