import { describe, expect, it } from 'vitest';
import { Digest } from '@core/digest';
import { Walkways, type WalkGraph } from '@world/walkways';
import { buildWalkways } from './oracle/buildWalkways';
import { rebuildWork } from '@world/rebuildWork';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate, loadFixtures } from '../fuzz/support/runner';

/** The ops the editor refused (a fuzz op may be one it would not do): the sequence stops there. */
const rejected: unknown[] = [];
const recordRejected = (error: unknown): void => { rejected.push(error); };

/** THE WALKWAYS KEPT BY WHAT CHANGED (`Walkways.update`) */
function graphLines(g: WalkGraph): string[] {
  const at = (id: number): string => {
    const n = g.nodes[id];
    return n ? `${n.x},${n.y}` : `missing ${id}`;
  };
  const out: string[] = [];
  for (const w of g.walkways()) {
    const path = new Digest().addAll(w.path.xy).value();
    out.push(`${w.kind} ${w.segment ?? '-'} ${w.node ?? '-'} ${w.kerb} ${w.structure} ${w.unmarked ? 1 : 0} ${w.lo} ${w.hi} ${w.width} ${at(w.a)} ${at(w.b)} ${path}`);
  }
  return out.sort();
}

/** Every walkway's ends in the graph, and each node's list exactly the walkways meeting there. */
function holdsTogether(g: WalkGraph): string[] {
  const wrong: string[] = [];
  const meeting = new Map<number, number[]>();
  for (const w of g.walkways()) {
    if (!g.nodes[w.a] || !g.nodes[w.b]) wrong.push(`way ${w.id} ends off the graph`);
    for (const n of [w.a, w.b]) meeting.set(n, [...meeting.get(n) ?? [], w.id]);
  }
  for (const [n, list] of g.at) {
    if (list.length && !g.nodes[n]) wrong.push(`node ${n} listed but gone`);
    const expected = (meeting.get(n) ?? []).slice().sort((a, b) => a - b).join(',');
    if (list.slice().sort((a, b) => a - b).join(',') !== expected) wrong.push(`node ${n} lists ${list.join(',')} not ${expected}`);
  }
  for (const [n, list] of meeting) if (!g.at.has(n)) wrong.push(`node ${n} lists nothing, meets ${list.join(',')}`);
  return wrong;
}

describe('the walkways kept by the network\'s delta', () => {
  for (let seed = 1; seed <= 8; seed++) it(`equal the walkways built from nothing after every op of fuzz sequence ${seed}`, () => {
    const ops = generate(seed, 24);
    const state = freshState();
    const kept = new Walkways();
    kept.update(state.net);
    let local = 0;
    for (let i = 0; i < ops.length; i++) {
      let changed: boolean;
      try { changed = applyOp(state, ops[i]!); } catch (error) { recordRejected(error); break; }
      if (!changed) continue;
      const before = rebuildWork.walkways;
      const g = kept.update(state.net);
      // The edit's own roads and nodes, not the map's: counted where the map has more than a handful.
      if (rebuildWork.walkways - before < state.doc.segments.size + state.doc.nodes.size) local++;
      expect(holdsTogether(g), `seed ${seed} op ${i} (${ops[i]!.op})`).toEqual([]);
      expect(graphLines(g), `seed ${seed} op ${i} (${ops[i]!.op})`).toEqual(graphLines(buildWalkways(state.net)));
    }
    expect(local, 'edits taken in by the delta alone').toBeGreaterThan(0);
  });

  for (const fixture of loadFixtures()) it(`equal the walkways built from nothing over the fuzz fixture ${fixture.name}`, () => {
    const state = freshState();
    const kept = new Walkways();
    kept.update(state.net);
    fixture.ops.forEach((op, i) => {
      let changed: boolean;
      try { changed = applyOp(state, op); } catch (error) { recordRejected(error); return; }
      if (!changed) return;
      const g = kept.update(state.net);
      expect(holdsTogether(g), `${fixture.name} op ${i}`).toEqual([]);
      expect(graphLines(g), `${fixture.name} op ${i}`).toEqual(graphLines(buildWalkways(state.net)));
    });
  });

  it('hands back, the same object, a walkway an edit elsewhere left as it was', () => {
    const ops = generate(3, 24);
    const state = freshState();
    const kept = new Walkways();
    let handed = 0;
    for (const op of ops) {
      const g = kept.update(state.net);
      const before = g.walkways();
      try { if (!applyOp(state, op)) continue; } catch (error) { recordRejected(error); break; }
      kept.update(state.net);
      handed += before.filter((w) => g.holds(w)).length;
    }
    expect(handed).toBeGreaterThan(0);
  });
});
