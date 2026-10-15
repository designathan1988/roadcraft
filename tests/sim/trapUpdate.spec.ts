import { describe, expect, it } from 'vitest';
import type { LaneletId } from '@world/lanelets';
import { SimWorld } from '@sim/world';
import { trapLanes } from '@sim/routing/router';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate, loadFixtures } from '../fuzz/support/runner';

/** The ops the editor refused (a fuzz op may be one it would not do): the sequence stops there. */
const rejected: unknown[] = [];
const recordRejected = (error: unknown): void => { rejected.push(error); };

/** THE TRAP LANES KEPT BY WHAT CHANGED (`router.ts` TrapIndex, from the world's topology log) */
function fromNothing(w: SimWorld, body: number): string[] {
  const into = new Map<LaneletId, LaneletId[]>();
  const links: LaneletId[] = [];
  for (const lane of w.graph.lanelets.values()) {
    if (lane.kind !== 'link') continue;
    links.push(lane.id);
    for (const cid of w.graph.exitsOf(lane.id)) {
      const c = w.connector(cid);
      if (!c || c.maxBodyClass < body) continue;
      into.set(c.toLane, [...into.get(c.toLane) ?? [], lane.id]);
    }
  }
  const out = new Map<LaneletId, number>();
  for (const id of links) out.set(id, w.graph.exitsOf(id).filter((cid) => (w.connector(cid)?.maxBodyClass ?? -1) >= body).length);
  const peel = links.filter((id) => out.get(id) === 0 && w.graph.exitsOf(id).length > 0);
  const traps = new Set(peel);
  while (peel.length) {
    const id = peel.pop()!;
    for (const from of into.get(id) ?? []) {
      const d = out.get(from)! - 1;
      out.set(from, d);
      if (d === 0 && !traps.has(from)) { traps.add(from); peel.push(from); }
    }
  }
  return [...traps].sort();
}

function run(ops: readonly Parameters<typeof applyOp>[1][], name: string): void {
  const state = freshState();
  const w = new SimWorld(state.doc, state.net, 1);
  w.rebuildTopology();
  for (let body = 0; body <= 3; body++) trapLanes(w, body);
  ops.forEach((op, i) => {
    let changed: boolean;
    try { changed = applyOp(state, op); } catch (error) { recordRejected(error); return; }
    if (!changed) return;
    w.rebuildTopology();
    for (let body = 0; body <= 3; body++) expect([...trapLanes(w, body)].sort(), `${name} op ${i} (${op.op}) body ${body}`).toEqual(fromNothing(w, body));
  });
}

describe('the trap lanes kept by the topology log', () => {
  for (let seed = 1; seed <= 8; seed++) it(`equal those peeled from nothing after every op of fuzz sequence ${seed}`, () => run(generate(seed, 24), `seed ${seed}`));
  for (const fixture of loadFixtures()) it(`equal those peeled from nothing over the fuzz fixture ${fixture.name}`, () => run(fixture.ops, fixture.name));
});
