import type { LabContext } from '../labTypes';
import type { Aggregate } from './aggregate';
import { functionRows, type FunctionRow } from './analysis';
import { createCodeSampler, type CodeSampler, type SampleView } from './sampler';
import { createSourceStore, type SourceStore } from './sourceStore';

/** THE CODE TABS' SHARED STATE: the sampler, the sources, what is shown, the engine's products counted (idle refreshes). */

export interface ProductCount { refreshes: number; idle: number; ms: number }

export interface CodeState {
  readonly sampler: CodeSampler;
  readonly store: SourceStore;
  view: SampleView;
  /** Sampling while the "Código" tab is shown. */
  live: boolean;
  /** Each engine product's refreshes since the lab began (`Engine.onRefresh`). */
  readonly products: Map<string, ProductCount>;
  /** `agg`'s functions placed (cached by its version and the maps loaded). */
  rows(agg: Aggregate): FunctionRow[];
  /** Per original file (`/src/x.ts`), the lines functions sampled in the session were written on, with their total ms. */
  seenLines(): Map<string, Map<number, number>>;
}

export function createCodeState(ctx: LabContext): CodeState {
  const sampler = createCodeSampler(ctx);
  const store = createSourceStore();
  const products = new Map<string, ProductCount>();
  ctx.onProduct((name, _phase, ms, _keys, idle) => {
    let p = products.get(name);
    if (!p) { p = { refreshes: 0, idle: 0, ms: 0 }; products.set(name, p); }
    p.refreshes++;
    if (idle) p.idle++;
    p.ms += ms;
  });
  const cache = new WeakMap<Aggregate, { version: number; mapped: number; rows: FunctionRow[] }>();
  const state: CodeState = {
    sampler, store, products,
    view: 'last',
    live: true,
    rows(agg) {
      const mapped = store.stats().mapped;
      const hit = cache.get(agg);
      if (hit && hit.version === agg.version && hit.mapped === mapped) return hit.rows;
      const rows = functionRows(agg, store);
      cache.set(agg, { version: agg.version, mapped, rows });
      return rows;
    },
    seenLines() {
      const out = new Map<string, Map<number, number>>();
      for (const r of state.rows(sampler.aggregate('session'))) {
        if (!r.loc) continue;
        let lines = out.get(r.loc.file);
        if (!lines) { lines = new Map(); out.set(r.loc.file, lines); }
        lines.set(r.loc.line, (lines.get(r.loc.line) ?? 0) + r.stat.totalMs);
      }
      return out;
    },
  };
  return state;
}
