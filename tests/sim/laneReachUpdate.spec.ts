import { describe, expect, it } from 'vitest';
import type { LaneletId } from '@world/lanelets';
import { SimWorld } from '@sim/world';
import { boundaryExit } from '@sim/routing/laneReach';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate, loadFixtures } from '../fuzz/support/runner';

/** The ops the editor refused (a fuzz op may be one it would not do): the sequence stops there. */
const rejected: unknown[] = [];
const recordRejected = (error: unknown): void => { rejected.push(error); };

/** THE ROAD ENDS EACH LANE REACHES, KEPT BY WHAT CHANGED (`laneReach.ts`, from the world's topology log) */
function fromNothing(w: SimWorld, start: LaneletId, body: number): LaneletId[] {
  return [...reachedFrom(w, start, body)].filter((id) => boundaryExit(w, id)).sort();
}

/** Every link lane a search reaches from `start` for a body, `start` included. */
function reachedFrom(w: SimWorld, start: LaneletId, body: number): Set<LaneletId> {
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
  return seen;
}

function check(w: SimWorld, name: string): number {
  let reached = 0;
  const links = [...w.graph.lanelets.values()].filter((lane) => lane.kind === 'link').map((lane) => lane.id);
  for (const lane of w.graph.lanelets.values()) {
    if (lane.kind !== 'link') continue;
    for (let body = 0; body <= 3; body++) {
      const kept = [...w.laneReaches.exitsFrom(w, lane.id, body as never)];
      expect(kept, `${name}: ${lane.id} body ${body}`).toEqual(fromNothing(w, lane.id, body));
      reached += kept.length;
      // Whether it may reach each other lane (`mayReach`, the routes' first check) is what the search finds.
      const found = reachedFrom(w, lane.id, body);
      for (const goal of links) expect(w.laneReaches.mayReach(w, lane.id, goal, body as never), `${name}: ${lane.id} to ${goal} body ${body}`).toBe(found.has(goal));
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

  it('are brought up to the graph where the topology is built, not by the next vehicle made', () => {
    const state = freshState();
    const w = new SimWorld(state.doc, state.net, 1);
    w.rebuildTopology();
    const link = [...w.graph.lanelets.values()].find((lane) => lane.kind === 'link');
    if (link) w.laneReaches.exitsFrom(w, link.id, 1 as never);
    const seen = (): unknown => (w.laneReaches as unknown as { seen: unknown }).seen;
    for (const op of generate(3, 12)) {
      try { if (!applyOp(state, op)) continue; } catch (error) { recordRejected(error); continue; }
      w.rebuildTopology();
      expect(seen()).toBe(w.topologyLog.state);
    }
  });
});
