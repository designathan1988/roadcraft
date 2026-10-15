import { describe, expect, it } from 'vitest';
import { LaneletGraph, laneletWork } from '@world/lanelets';
import { ConflictIndex } from '@world/conflictPoints';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate, loadFixtures } from '../fuzz/support/runner';
import { conflictLines, graphLines } from './support/graphLines';

/**
 * THE LANE GRAPH KEPT BY WHAT CHANGED (`LaneletGraph.update`): after every edit
 * of the fuzzer's sequences and fixtures (the editor's own commands), the graph
 * brought up to the network by its delta must be the graph built from nothing -
 * every lanelet and connector, each lane's exits, each node's lanes in and out,
 * each junction's groups, connectors and signal.
 */
/** The ops the editor refused (a fuzz op may be one it would not do): the sequence stops there. */
const rejected: unknown[] = [];
const recordRejected = (error: unknown): void => { rejected.push(error); };

function fresh(doc: RoadDoc, net: Network): string[] {
  const graph = new LaneletGraph();
  graph.build(doc, net);
  const conflicts = new ConflictIndex();
  conflicts.build(graph);
  return [...graphLines(graph), ...conflictLines(conflicts)].sort();
}

/** A graph and its conflicts brought up by what changed, as the game keeps them. */
function keptOf(doc: RoadDoc, net: Network): { lines(): string[]; follow(): boolean } {
  const graph = new LaneletGraph();
  graph.build(doc, net);
  const conflicts = new ConflictIndex();
  conflicts.build(graph);
  return {
    lines: () => [...graphLines(graph), ...conflictLines(conflicts)].sort(),
    follow: () => {
      const changed = graph.update(doc, net);
      if (changed === null) conflicts.build(graph); else conflicts.update(graph, changed.junctions);
      return changed !== null;
    },
  };
}

describe('the lane graph kept by the network\'s delta', () => {
  for (let seed = 1; seed <= 8; seed++) it(`equals a graph built from nothing after every op of fuzz sequence ${seed}`, () => {
    const ops = generate(seed, 24);
    const state = freshState();
    const kept = keptOf(state.doc, state.net);
    let local = 0;
    for (let i = 0; i < ops.length; i++) {
      let changed: boolean;
      try { changed = applyOp(state, ops[i]!); } catch (error) { recordRejected(error); break; }
      if (!changed) continue;
      const before = laneletWork.segments;
      // The edit's own segments, not the map's: counted where the map has more than a handful.
      if (kept.follow() && laneletWork.segments - before < state.doc.segments.size) local++;
      expect(kept.lines(), `seed ${seed} op ${i} (${ops[i]!.op})`).toEqual(fresh(state.doc, state.net));
    }
    expect(local, 'edits taken in by the delta alone').toBeGreaterThan(0);
  });

  for (const fixture of loadFixtures()) it(`equals a graph built from nothing over the fuzz fixture ${fixture.name}`, () => {
    const state = freshState();
    const kept = keptOf(state.doc, state.net);
    fixture.ops.forEach((op, i) => {
      let changed: boolean;
      try { changed = applyOp(state, op); } catch (error) { recordRejected(error); return; }
      if (!changed) return;
      kept.follow();
      expect(kept.lines(), `${fixture.name} op ${i}`).toEqual(fresh(state.doc, state.net));
    });
  });
});
