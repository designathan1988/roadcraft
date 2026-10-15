import { type SweepSamples, pairTable } from '@world/conflictTable';
import type { ChosenTurn } from '@world/junctionTurns';
import type { JunctionSurface } from '@world/turnPaths';
import { chooseTurnOf } from '@world/turnChoice';

/**
 * The traffic's pure work off the page's thread (`conflictPool.ts`), answered
 * with the job's id:
 * - conflict pairs: each pair's table by `pairTable` itself on the samples
 *   sent, the tables' buffers transferred, not copied (MDN, "Transferable
 *   objects");
 * - junction turns: each by `chooseTurnOf` on the lanes and the surface sent,
 *   each surface made once.
 */
interface PairsAsk {
  readonly kind: 'pairs';
  readonly id: number;
  readonly sweeps: readonly { readonly c0: number; readonly count: number; readonly length: number; readonly frame: Float64Array; readonly frameLengthSq: Float64Array }[];
  /** Two indices into `sweeps` a pair. */
  readonly pairs: Int32Array;
}
interface TurnsAsk {
  readonly kind: 'turns';
  readonly id: number;
  readonly surfaces: readonly { readonly key: string; readonly centre: { readonly x: number; readonly y: number }; readonly rings: readonly Float64Array[] }[];
  readonly turns: readonly {
    readonly surface: number; readonly inXY: Float64Array; readonly outXY: Float64Array; readonly waiting: readonly Float64Array[];
    readonly fromRoadEnd: boolean; readonly toRoadEnd: boolean;
  }[];
}

/** Most time between two words to the page while working: the pool's watchdog hears the worker is alive (`SILENCE_MS`). */
const BEAT_MS = 500;

self.onmessage = (event: MessageEvent<PairsAsk | TurnsAsk>) => {
  const ask = event.data;
  let spoke = performance.now();
  const beat = (): void => {
    const now = performance.now();
    if (now - spoke >= BEAT_MS) { spoke = now; self.postMessage({ id: ask.id, beat: true }); }
  };
  try {
    if (ask.kind === 'turns') {
      const made = new Map<string, JunctionSurface>();
      const turns: ChosenTurn[] = [];
      for (const t of ask.turns) {
        const s = ask.surfaces[t.surface]!;
        turns.push(chooseTurnOf({ ...t, surfaceKey: s.key, centre: s.centre, rings: s.rings }, made));
        beat();
      }
      self.postMessage({ id: ask.id, turns });
      return;
    }
    // The caches `pairTable` keeps on a sweep start empty here, as on the page.
    const samples: SweepSamples[] = ask.sweeps.map((s) => ({ ...s, bounds: null, grid: null, range: null }));
    const tables: (Float64Array | null)[] = [];
    const transfer: ArrayBuffer[] = [];
    for (let k = 0; k < ask.pairs.length; k += 2) {
      const table = pairTable(samples[ask.pairs[k]!]!, samples[ask.pairs[k + 1]!]!);
      tables.push(table);
      if (table) transfer.push(table.buffer as ArrayBuffer);
      beat();
    }
    (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ id: ask.id, tables }, transfer);
  } catch (error) {
    // Reported here and answered: the page does this work itself (`ConflictIndex.prepare`, `LaneletGraph.redoProvisional`).
    console.error(`[traffic] ${ask.kind} failed in their worker`, error);
    self.postMessage({ id: ask.id, error: String(error) });
  }
};
