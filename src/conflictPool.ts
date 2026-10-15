import type { PairMeasurer, SweepSamples } from '@world/conflictTable';

/**
 * THE TRAFFIC'S CONFLICT PAIRS, MEASURED ON THE OTHER CORES. Each pair of
 * movements through a junction has its zones measured once (`pairTable`,
 * about a millisecond a pair); a generated city has thousands, 3.4 s of its
 * opening on the page's thread (profiled 2026-10-14). They are pure - two
 * sweeps' samples in, a table out - so they are split across workers
 * (`conflictTable.worker.ts`), as Cesium hands its heavy jobs to a
 * `TaskProcessor` and answers by promise; the pool is sized by the cores the
 * browser reports (MDN, `navigator.hardwareConcurrency`), one left to the
 * page. No workers here (a test, an old browser): `measure` rejects, and the
 * pairs are measured on the page as before (`ConflictIndex.prepare`).
 */
interface Lane { readonly worker: Worker; readonly waiting: Map<number, { resolve(tables: (Float64Array | null)[]): void; reject(error: Error): void }> }

/** Most workers the pool opens: past four, a city's pairs are done before the copies are. */
const MOST_LANES = 4;

export class ConflictPool implements PairMeasurer {
  private lanes: Lane[] | null = null;
  private broken = false;
  private nextId = 1;

  measure(pairs: readonly { readonly a: SweepSamples; readonly b: SweepSamples }[]): Promise<readonly (Float64Array | null)[]> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no workers in this browser'));
    // Contiguous shares, one a lane, each with only the sweeps its pairs read.
    const per = Math.ceil(pairs.length / lanes.length);
    const parts: Promise<(Float64Array | null)[]>[] = [];
    for (let k = 0; k < lanes.length && k * per < pairs.length; k++) {
      const share = pairs.slice(k * per, (k + 1) * per);
      const index = new Map<SweepSamples, number>();
      const sweeps: { c0: number; count: number; length: number; frame: Float64Array; frameLengthSq: Float64Array }[] = [];
      const at = (s: SweepSamples): number => {
        let i = index.get(s);
        if (i === undefined) {
          i = sweeps.length;
          index.set(s, i);
          sweeps.push({ c0: s.c0, count: s.count, length: s.length, frame: s.frame, frameLengthSq: s.frameLengthSq });
        }
        return i;
      };
      const indices = new Int32Array(share.length * 2);
      share.forEach((p, q) => { indices[q * 2] = at(p.a); indices[q * 2 + 1] = at(p.b); });
      parts.push(this.ask(lanes[k]!, sweeps, indices));
    }
    return Promise.all(parts).then((answers) => answers.flat());
  }

  private ask(lane: Lane, sweeps: readonly object[], pairs: Int32Array): Promise<(Float64Array | null)[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      lane.waiting.set(id, { resolve, reject });
      // The samples are copied (the page keeps its own); the indices handed over.
      lane.worker.postMessage({ id, sweeps, pairs }, [pairs.buffer]);
    });
  }

  private start(): Lane[] | null {
    if (this.lanes || this.broken) return this.lanes;
    if (typeof Worker === 'undefined') { this.broken = true; return null; }
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const count = Math.max(1, Math.min(MOST_LANES, cores - 1));
    try {
      const lanes: Lane[] = [];
      for (let k = 0; k < count; k++) {
        const worker = new Worker(new URL('./conflictTable.worker.ts', import.meta.url), { type: 'module' });
        const lane: Lane = { worker, waiting: new Map() };
        worker.onmessage = (event: MessageEvent<{ id: number; tables?: (Float64Array | null)[]; error?: string }>) => {
          const job = lane.waiting.get(event.data.id);
          if (!job) return;
          lane.waiting.delete(event.data.id);
          if (event.data.tables) job.resolve(event.data.tables);
          else job.reject(new Error(event.data.error ?? 'conflict worker failed'));
        };
        // A worker that cannot run, or a message it cannot read: the pool is
        // done (`fail`).
        worker.onerror = (event) => this.fail(`a conflict worker failed: ${event.message}`);
        worker.onmessageerror = () => this.fail('a conflict worker sent a message that cannot be read');
        lanes.push(lane);
      }
      this.lanes = lanes;
    } catch (error) {
      console.warn('[traffic] the conflict workers are unavailable; the pairs are measured on the page', error);
      this.broken = true;
      this.lanes = null;
    }
    return this.lanes;
  }

  /**
   * The pool fails: every job waiting on ANY of its workers is rejected (its
   * pairs are then measured on the page, `ConflictIndex.prepare`) and every
   * worker is ended. DO NOT end only the lane that failed: the others were left
   * running for the page's life, their jobs answered into a pool marked broken.
   */
  private fail(why: string): void {
    if (this.broken) return;
    console.warn(`[traffic] ${why}; the pairs are measured on the page`);
    this.broken = true;
    this.end(new Error(why));
  }

  /** Ends the workers, every job still waiting rejected (`fail`; the page going away). */
  dispose(): void {
    this.broken = true;
    this.end(new Error('the conflict pool was closed'));
  }

  private end(error: Error): void {
    for (const lane of this.lanes ?? []) {
      for (const job of lane.waiting.values()) job.reject(error);
      lane.waiting.clear();
      lane.worker.terminate();
    }
    this.lanes = null;
  }
}
