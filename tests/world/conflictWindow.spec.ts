import { describe, expect, it } from 'vitest';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import { ConflictIndex } from '@world/conflictPoints';
import type { NodeId } from '@world/ids';
import { fixtureDoc } from '../sim/support/bodies';

/** The micro simulation's window (`ConflictIndex.setWindow`): conflicts only for the junctions in it, the same as a whole build there. */

function graphOf(): LaneletGraph {
  const doc = fixtureDoc();
  const net = new Network(doc);
  net.rebuild();
  const graph = new LaneletGraph();
  graph.build(doc, net);
  return graph;
}

/** Each junction's points, by connector pair: what a vehicle there reads. */
function pointsOf(index: ConflictIndex, nodes: ReadonlySet<NodeId>): string[] {
  return index.points.filter((p) => p !== undefined && nodes.has(p.node)).map((p) => `${p.node}|${p.a}|${p.b}|${p.kind}|${p.sA.toFixed(6)}|${p.sB.toFixed(6)}`).sort();
}

describe('the conflicts kept in the micro window', () => {
  it('holds the junctions in it as a whole build does, and none out of it', () => {
    const graph = graphOf();
    const whole = new ConflictIndex();
    whole.build(graph);
    const junctions = [...graph.junctions.keys()];
    expect(junctions.length).toBeGreaterThan(1);
    const inside = new Set(junctions.slice(0, Math.ceil(junctions.length / 2)));
    const windowed = new ConflictIndex();
    windowed.setWindow(graph, new Set());
    windowed.build(graph);
    expect(windowed.points.filter((p) => p !== undefined)).toHaveLength(0);
    windowed.setWindow(graph, inside);
    expect(pointsOf(windowed, inside)).toEqual(pointsOf(whole, inside));
    const outside = new Set(junctions.filter((n) => !inside.has(n)));
    expect(pointsOf(windowed, outside)).toEqual([]);
    // Moved: those left behind let go, those reached built.
    windowed.setWindow(graph, outside);
    expect(pointsOf(windowed, inside)).toEqual([]);
    expect(pointsOf(windowed, outside)).toEqual(pointsOf(whole, outside));
  });
});
