import { describe, expect, it } from 'vitest';
import { SimWorld } from '@sim/world';
import { CrossingSpans } from '@sim/intersections/crossingSpans';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate } from '../fuzz/support/runner';

/** The ops the editor refused (a fuzz op may be one it would not do): the sequence stops there. */
const rejected: unknown[] = [];
const recordRejected = (error: unknown): void => { rejected.push(error); };

/** THE ZEBRA SPANS KEPT BY WHAT CHANGED (`CrossingSpans.update`, from the world's topology log) */
function lines(w: SimWorld, spans: CrossingSpans): string[] {
  const out: string[] = [];
  for (const junction of w.graph.junctions.values()) {
    const incident = w.doc.node(junction.node)?.incident ?? [];
    for (const connector of junction.connectors) {
      for (const segment of incident) out.push(`span ${connector} ${segment} ${JSON.stringify(spans.span(connector, `${junction.node}:${segment}`) ?? 'none')}`);
    }
    for (const lane of junction.inbound) out.push(`stop ${lane} ${spans.approachStop(lane) ?? '-'}`);
  }
  return out.sort();
}

describe('the zebra spans kept by the topology log', () => {
  for (let seed = 1; seed <= 6; seed++) it(`equal those measured from nothing after every op of fuzz sequence ${seed}`, () => {
    const ops = generate(seed, 24);
    const state = freshState();
    const w = new SimWorld(state.doc, state.net, 1);
    w.rebuildTopology();
    for (let i = 0; i < ops.length; i++) {
      let changed: boolean;
      try { changed = applyOp(state, ops[i]!); } catch (error) { recordRejected(error); break; }
      if (!changed) continue;
      w.rebuildTopology();
      const whole = new CrossingSpans();
      whole.build(w);
      expect(lines(w, w.crossingSpans), `seed ${seed} op ${i} (${ops[i]!.op})`).toEqual(lines(w, whole));
    }
  });
});
