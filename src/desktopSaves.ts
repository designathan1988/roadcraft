import type { LargeStore } from '@editor/persistence';
import { type PartStore, type SaveBatch, SAVES_STORE, openSaves } from '@editor/saveStore';
import { markBytes, markTexts } from '@editor/workerParts';

/** THE DESKTOP'S SAVES: the autosave's stores as files in the folder Steam Auto-Cloud syncs, kept by the shell's utility process (`desktop/saves.cjs`); none in a browser. */

interface SavesBridge { connectSaves(): void }
type Request =
  | { readonly op: 'get'; readonly keys: readonly string[] }
  | { readonly op: 'write'; readonly put: readonly (readonly [string, Uint8Array])[]; readonly remove: readonly string[] }
  | { readonly op: 'batch'; readonly batch: SaveBatch }
  | { readonly op: 'keys' }
  | { readonly op: 'marks'; readonly prefix: string };
interface Answer { readonly id: number; readonly ok: boolean; readonly result?: unknown }

/** The window messages the preload hands on (`desktop/preload.cjs`). */
const PORT_MESSAGE = 'roadcraft:saves-port';
const LOST_MESSAGE = 'roadcraft:saves-lost';
/** How long the shell may take to hand the port over before the stores answer "nothing" (the game opens without its save rather than never). */
const CONNECT_MS = 10_000;
/** Kept in the folder once the map an older desktop build left in IndexedDB was looked at (`migrate`). */
const MIGRATED = 'roadcraft.desktop.migrated';
/** IndexedDB entries copied per write while migrating. */
const MIGRATE_CHUNK = 32;

/** The desktop's stores: the page's (`new Persistence`), a port of its own for each worker that reads or writes the tiles (`connect`, `editor/workerParts.ts`), and who to tell when the writer stopped (`onLost`: each such port is dead). */
export interface DesktopStores {
  readonly store: LargeStore;
  readonly parts: PartStore;
  connect(): Promise<MessagePort>;
  onLost(listener: () => void): void;
}

/** The stores, or null where the page has no desktop shell. */
export function desktopSaves(): DesktopStores | null {
  const bridge = (window as unknown as { roadcraftDesktop?: Partial<SavesBridge> }).roadcraftDesktop;
  if (!bridge || typeof bridge.connectSaves !== 'function') return null;
  const connect = (): void => bridge.connectSaves!();

  let port: Promise<MessagePort> | null = null;
  let next = 1;
  const waiting = new Map<number, (answer: Answer | null) => void>();
  const lost: (() => void)[] = [];
  // The writer stopped (`desktop/main.cjs`): what waits fails, the next request connects again, the workers are given new ports.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data !== LOST_MESSAGE) return;
    port = null;
    for (const done of waiting.values()) done(null);
    waiting.clear();
    for (const listener of lost) listener();
  });
  // Each connection asked is handed the next port that comes, in order (the shell answers each `connectSaves` with one).
  const asked: ((given: MessagePort) => void)[] = [];
  window.addEventListener('message', (event) => {
    const given = event.ports[0];
    if (event.source !== window || event.data !== PORT_MESSAGE || !given) return;
    asked.shift()?.(given);
  });
  const nextPort = (): Promise<MessagePort> => new Promise<MessagePort>((resolve, reject) => {
    const take = (given: MessagePort): void => { clearTimeout(timer); resolve(given); };
    const timer = setTimeout(() => { const at = asked.indexOf(take); if (at >= 0) asked.splice(at, 1); reject(new Error('the saves writer did not answer')); }, CONNECT_MS);
    asked.push(take);
    connect();
  });
  const open = (): Promise<MessagePort> => (port ??= nextPort().then((given) => {
    given.onmessage = (answer: MessageEvent<Answer>) => {
      const done = waiting.get(answer.data.id);
      waiting.delete(answer.data.id);
      done?.(answer.data);
    };
    return given;
  }, (error: unknown) => { port = null; throw error; }));
  const call = async (request: Request): Promise<Answer | null> => {
    let to: MessagePort;
    try { to = await open(); } catch (error) { console.error('[save] no saves writer', error); return null; }
    const id = next++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      try { to.postMessage({ id, ...request }); } catch (error) { waiting.delete(id); console.error('[save] the request did not reach the saves writer', error); resolve(null); }
    });
  };
  const written = (answer: Answer | null): boolean => answer?.ok === true;

  let migrated: Promise<void> | null = null;
  const ready = (): Promise<void> => (migrated ??= migrate(call).catch((error: unknown) => console.error('[save] the browser-storage map was not copied to the saves folder', error)));

  const parts: PartStore = {
    async get(keys) {
      await ready();
      const answer = await call({ op: 'get', keys });
      const found = answer?.ok && Array.isArray(answer.result) ? (answer.result as unknown[]) : [];
      return keys.map((_, i) => { const bytes = found[i]; return bytes instanceof Uint8Array ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null; });
    },
    async write(put, remove, marks) {
      await ready();
      const bytes = await Promise.all(put.map(async ([key, blob]) => [key, new Uint8Array(await blob.arrayBuffer())] as const));
      return written(await call({ op: 'write', put: [...bytes, ...markBytes(marks)], remove }));
    },
    async marks(prefix) {
      await ready();
      return markTexts(await call({ op: 'marks', prefix }));
    },
    // The changed squares' binary frames go to the writer as they are: it compresses them there, as the job system's `save` lane does in a browser.
    writer: { write: async (batch) => { await ready(); return written(await call({ op: 'batch', batch })); } },
  };
  const store: LargeStore = {
    get: async (key) => { const [blob] = await parts.get([key]); return blob ? blob.text() : null; },
    put: (key, text) => parts.write([[key, new Blob([text])]], []),
    delete: (key) => parts.write([], [key]),
  };
  // A worker's own port, once the old browser-storage map was copied (`migrate`): it reads and writes the folder as the page does.
  const connectWorker = async (): Promise<MessagePort> => { await ready(); return nextPort(); };
  return { store, parts, connect: connectWorker, onLost: (listener) => { lost.push(listener); } };
}

/** The map an older desktop build kept in IndexedDB copied once into an empty saves folder (IndexedDB left as it is); a folder with files (Steam Cloud brought them) is never overwritten. */
async function migrate(call: (request: Request) => Promise<Answer | null>): Promise<void> {
  const listed = await call({ op: 'keys' });
  if (!listed?.ok || !Array.isArray(listed.result)) return;
  const held = listed.result as string[];
  if (held.includes(MIGRATED)) return;
  const db = held.length === 0 ? await openSaves() : null;
  if (db) {
    const keys = (await read(db, (store) => store.getAllKeys()) ?? []).filter((key): key is string => typeof key === 'string');
    for (let i = 0; i < keys.length; i += MIGRATE_CHUNK) {
      const chunk = keys.slice(i, i + MIGRATE_CHUNK);
      const values = await Promise.all(chunk.map((key) => read(db, (store) => store.get(key) as IDBRequest<unknown>)));
      const put: (readonly [string, Uint8Array])[] = [];
      for (let k = 0; k < chunk.length; k++) {
        const value = values[k];
        if (value instanceof Blob) put.push([chunk[k]!, new Uint8Array(await value.arrayBuffer())]);
        else if (typeof value === 'string') put.push([chunk[k]!, new TextEncoder().encode(value)]);
      }
      // DO NOT mark it copied after a refused write: the next start copies again.
      if (put.length && !(await call({ op: 'write', put, remove: [] }))?.ok) return;
    }
  }
  await call({ op: 'write', put: [[MIGRATED, new TextEncoder().encode(String(Date.now()))]], remove: [] });
}

function read<T>(db: IDBDatabase, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const request = run(db.transaction(SAVES_STORE, 'readonly').objectStore(SAVES_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
