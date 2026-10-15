import { describe, expect, it } from 'vitest';
import { ChangeLog } from '@core/changeLog';
import type { GraphChange } from '@world/lanelets';
import { SimWorld } from '@sim/world';
import { CycleIndex } from '@sim/intersections/cycles';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate, loadFixtures } from '../fuzz/support/runner';

/**
 * THE SMALL LOOPS KEPT BY WHAT CHANGED (`CycleIndex.follow`, from the world's
 * topology log): after every edit, each lanelet's loops - their links,
 * connectors and storage - must be those every link's search finds from
 * nothing.
 */
function lines(index: CycleIndex): string[] {
  const out: string[] = [];
  for (const [lane, cycles] of index.byLanelet) {
    out.push(`${lane} ${cycles.map((c) => `${[...c.lanelets].sort().join('/')}@${c.storage.toFixed(9)}`).sort().join(' ')}`);
  }
  return out.sort();
}

function fromNothing(w: SimWorld): string[] {
  const index = new CycleIndex();
  index.follow(w.graph, new ChangeLog<GraphChange>());
  return lines(index);
}

function run(ops: readonly Parameters<typeof applyOp>[1][], name: string): void {
  const state = freshState();
  const w = new SimWorld(state.doc, state.net, 1);
  w.rebuildTopology();
  const kept = new CycleIndex();
  kept.follow(w.graph, w.topologyLog);
  ops.forEach((op, i) => {
    let changed: boolean;
    try { changed = applyOp(state, op); } catch { return; }
    if (!changed) return;
    w.rebuildTopology();
    kept.follow(w.graph, w.topologyLog);
    expect(lines(kept), `${name} op ${i} (${op.op})`).toEqual(fromNothing(w));
  });
}

describe('the small loops kept by the topology log', () => {
  for (let seed = 1; seed <= 8; seed++) it(`equal those found from nothing after every op of fuzz sequence ${seed}`, () => run(generate(seed, 24), `seed ${seed}`));
  for (const fixture of loadFixtures()) it(`equal those found from nothing over the fuzz fixture ${fixture.name}`, () => run(fixture.ops, fixture.name));
});
