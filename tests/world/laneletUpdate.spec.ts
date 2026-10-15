import { describe, expect, it } from 'vitest';
import { Digest } from '@core/digest';
import { LaneletGraph, laneletWork } from '@world/lanelets';
import { ConflictIndex } from '@world/conflictPoints';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate, loadFixtures } from '../fuzz/support/runner';

/**
 * THE LANE GRAPH KEPT BY WHAT CHANGED (`LaneletGraph.update`): after every edit
 * of the fuzzer's sequences and fixtures (the editor's own commands), the graph
 * brought up to the network by its delta must be the graph built from nothing -
 * every lanelet and connector, each lane's exits, each node's lanes in and out,
 * each junction's groups, connectors and signal.
 */
function graphLines(graph: LaneletGraph): string[] {
  const out: string[] = [];
  for (const l of graph.lanelets.values()) {
    const d = new Digest().addText(l.kind).addAll(l.centre.xy).add(l.length).add(l.speedLimit).add(l.controlled ? 1 : 0);
    out.push(`lanelet ${l.id} ${l.segment ?? '-'} ${l.node ?? '-'} ${d.value()}`);
  }
  for (const c of graph.connectors.values()) out.push(`connector ${c.id} ${c.node} ${c.fromLane} ${c.toLane} ${c.turn} ${c.carried} ${c.group} ${c.maxBodyClass}`);
  for (const [id, exits] of graph.exits) if (exits.length) out.push(`exits ${id} ${[...exits].sort().join(',')}`);
  for (const [node, lanes] of graph.inbound) if (lanes.length) out.push(`in ${node} ${[...lanes].sort().join(',')}`);
  for (const [node, lanes] of graph.outbound) if (lanes.length) out.push(`out ${node} ${[...lanes].sort().join(',')}`);
  for (const [node, j] of graph.junctions) {
    out.push(`junction ${node} ${j.signalised} ${j.control} ${[...j.connectors].sort().join(',')} ${j.groups.map((g) => `${g.id}:${[...g.segments].sort().join('/')}`).join(' ')}`);
  }
  return out.sort();
}

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

/** The conflicts as lines, without their ids (kept stable across builds, not across indexes). */
function conflictLines(conflicts: ConflictIndex): string[] {
  const out: string[] = [];
  for (const point of conflicts.points) if (point) out.push(`point ${point.node} ${point.a} ${point.b} ${point.kind} ${point.sA} ${point.sB} ${point.at.x} ${point.at.y}`);
  for (const [id, refs] of conflicts.byConnector) out.push(`refs ${id} ${refs.map((r) => `${r.other}:${r.kind}:${r.s}`).join(',')}`);
  for (const [id, list] of conflicts.diverges) out.push(`diverges ${id} ${list.map((d) => d.other).sort().join(',')}`);
  for (const q of conflicts.queueIntrusions) out.push(`intrusion ${q.a} ${q.b} ${q.mine} ${q.theirs}`);
  return out;
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
