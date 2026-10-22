import { keepDerivedManyCommitted, readDerivedSome } from './derivedCache';
import type { JobScope } from '../jobs/jobScope';

/** A write to keep (answered `done` on its commit) or a read (answered `got` with the entries found). */
type DerivedAsk =
  | { readonly id: number; readonly prefix: string; readonly entries: readonly [string, unknown][] }
  | { readonly read: number; readonly prefix: string; readonly keys: readonly string[] };

/** The array buffers under `value`, each once (a shared one left: it cannot be handed over). */
function buffersOf(value: unknown, out: Set<ArrayBuffer>, depth = 0): void {
  if (value === null || typeof value !== 'object' || depth > 8) return;
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) out.add(value.buffer);
    return;
  }
  if (value instanceof ArrayBuffer) { out.add(value); return; }
  if (Array.isArray(value)) { for (const item of value) buffersOf(item, out, depth + 1); return; }
  if (value instanceof Map) { for (const item of value.values()) buffersOf(item, out, depth + 1); return; }
  for (const key in value) buffersOf((value as Record<string, unknown>)[key], out, depth + 1);
}

/** This service of the job system (`job.worker.ts`): its messages answered on the scope it is given. */
export function serve(self: JobScope): void {
  /** DO NOT write them from the page */
  self.onmessage = (event: MessageEvent<DerivedAsk>) => {
    const ask = event.data;
    if ('read' in ask) {
      // DO NOT read the kept road tiles on the page: IndexedDB rebuilds every value where it is read, its bytes copied, and the page spent
      // 305 ms of a flight in its `onsuccess` (the player's probe, 2026-10-22). Read here, their arrays handed over, not copied.
      void readDerivedSome<unknown>(ask.prefix, ask.keys)
        .catch((error: unknown) => { console.error('[derived] the road tiles were not read', error); return new Map<string, unknown>(); })
        .then((got) => {
          const buffers = new Set<ArrayBuffer>();
          for (const value of got.values()) buffersOf(value, buffers);
          self.postMessage({ got: ask.read, entries: [...got] }, [...buffers]);
        });
      return;
    }
    // Answered on the commit, not on the queueing: the page holds its bytes in flight under a ceiling (`DerivedWriterLane`).
    const { id } = ask;
    // Answered whatever came of it: a write not kept is made again next time, its bytes free again on the page.
    void keepDerivedManyCommitted(ask.prefix, new Map(ask.entries))
      .catch((error: unknown) => console.error('[derived] the road tiles were not kept', error))
      .finally(() => self.postMessage({ done: id }));
  };
}
