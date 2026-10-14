import { type SweepSamples, pairTable } from '@world/conflictTable';

/**
 * Conflict pairs measured off the page's thread (`conflictPool.ts`): each
 * pair's table by `pairTable` itself on the samples sent, answered with the
 * job's id, the tables' buffers transferred, not copied (MDN, "Transferable
 * objects").
 */
interface Ask {
  readonly id: number;
  readonly sweeps: readonly { readonly c0: number; readonly count: number; readonly length: number; readonly frame: Float64Array; readonly frameLengthSq: Float64Array }[];
  /** Two indices into `sweeps` a pair. */
  readonly pairs: Int32Array;
}

self.onmessage = (event: MessageEvent<Ask>) => {
  const { id, sweeps, pairs } = event.data;
  try {
    // The caches `pairTable` keeps on a sweep start empty here, as on the page.
    const samples: SweepSamples[] = sweeps.map((s) => ({ ...s, bounds: null, grid: null, range: null }));
    const tables: (Float64Array | null)[] = [];
    const transfer: ArrayBuffer[] = [];
    for (let k = 0; k < pairs.length; k += 2) {
      const table = pairTable(samples[pairs[k]!]!, samples[pairs[k + 1]!]!);
      tables.push(table);
      if (table) transfer.push(table.buffer as ArrayBuffer);
    }
    (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ id, tables }, transfer);
  } catch (error) {
    // Reported here and answered: the page measures these pairs itself (`ConflictIndex.prepare`).
    console.error('[traffic] conflict pairs failed in their worker', error);
    self.postMessage({ id, error: String(error) });
  }
};
