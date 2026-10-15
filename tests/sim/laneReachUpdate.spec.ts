import { describe, expect, it } from 'vitest';
import type { LaneletId } from '@world/lanelets';
import { SimWorld } from '@sim/world';
import { boundaryExit } from '@sim/routing/laneReach';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate, loadFixtures } from '../fuzz/support/runner';

/** The ops the editor refused (a fuzz op may be one it would not do): the sequence stops there. */
const rejected: unknown[] = [];
const recordRejected = (error: unknown): void => { rejected.push(error); };

/**
 * THE ROAD ENDS EACH LANE REACHES, KEPT BY WHAT CHANGED (`laneReach.ts`, from
 * the world's topology log): after every edit, for every link lane and body
 * class, the road ends must be those a search from that lane alone finds -
 * over the movements the body fits and the lane changes beside each lane.
 */
function fromNothing(w: SimWorld, start: LaneletId, body: number): LaneletId[] {
  const next = (lane: LaneletId): LaneletId[] => {
    const out: LaneletId[] = [];
    for (const id of w.graph.exitsOf(lane)) {
      const c = w.connector(id);
      if (c && c.maxBodyClass >= body && c.toLane && w.graph.lanelets.get(c.toLane)?.kind === 'link') out.push(c.toLane);
    }
    for (const s of w.graph.siblingLanes(lane)) if (w.graph.lanelets.get(s)?.kind === 'link') out.push(s);
    return out;
  };
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) for (const v of next(queue.pop()!)) if (!seen.has(v)) { seen.add(v); queue.push(v); }
  return [...seen].filter((id) => boundaryExit(w, id)).sort();
}

function check(w: SimWorld, name: string): number {
  let reached = 0;
  for (const lane of w.graph.lanelets.values()) {
    if (lane.kind !== 'link') continue;
    for (let body = 0; body <= 3; body++) {
      const kept = [...w.laneReaches.exitsFrom(w, lane.id, body as never)];
      expect(kept, `${name}: ${lane.id} body ${body}`).toEqual(fromNothing(w, lane.id, body));
      reached += kept.length;
    }
  }
  return reached;
}

function run(ops: readonly Parameters<typeof applyOp>[1][], name: string): void {
  const state = freshState();
  const w = new SimWorld(state.doc, state.net, 1);
  w.rebuildTopology();
  let reached = check(w, `${name} start`);
  ops.forEach((op, i) => {
    let changed: boolean;
    try { changed = applyOp(state, op); } catch (error) { recordRejected(error); return; }
    if (!changed) return;
    w.rebuildTopology();
    reached += check(w, `${name} op ${i} (${op.op})`);
  });
  expect(reached, 'road ends found at all').toBeGreaterThan(0);
}

describe('the road ends each lane reaches, kept by the topology log', () => {
  for (let seed = 1; seed <= 8; seed++) it(`equal a search from each lane after every op of fuzz sequence ${seed}`, () => run(generate(seed, 24), `seed ${seed}`));
  for (const fixture of loadFixtures()) it(`equal a search from each lane over the fuzz fixture ${fixture.name}`, () => run(fixture.ops, fixture.name));
});
