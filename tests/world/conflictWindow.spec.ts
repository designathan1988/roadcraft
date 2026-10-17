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

  it('forgets the ids of the junctions it left, so walking the window back and forth does not grow them, and keeps those it holds', () => {
    const graph = graphOf();
    const junctions = [...graph.junctions.keys()];
    const inside = new Set(junctions.slice(0, Math.ceil(junctions.length / 2)));
    const outside = new Set(junctions.filter((n) => !inside.has(n)));
    const index = new ConflictIndex();
    index.setWindow(graph, new Set());
    index.build(graph);
    index.setWindow(graph, inside);
    const ids = (): number => (index as unknown as { idByKey: Map<string, number> }).idByKey.size;
    const held = (): number => index.points.filter((p) => p !== undefined).length;
    expect(ids()).toBe(held());
    // The pairs held before.
    const before = new Map(index.points.filter((p) => p !== undefined).map((p) => [`${p.node}|${p.a}|${p.b}`, p.id]));
    for (let k = 0; k < 5; k++) { index.setWindow(graph, outside); index.setWindow(graph, inside); }
    expect(ids()).toBe(held());
    index.setWindow(graph, new Set([...inside, ...outside]));
    for (const p of index.points) if (p && inside.has(p.node)) expect(before.has(`${p.node}|${p.a}|${p.b}`)).toBe(true);
    expect(ids()).toBe(held());
  });

  it('lets go of the zones kept for pairs it no longer holds when the window moves, not only at a whole build', () => {
    const graph = graphOf();
    const junctions = [...graph.junctions.keys()];
    const inside = new Set(junctions.slice(0, Math.ceil(junctions.length / 2)));
    const index = new ConflictIndex();
    index.setWindow(graph, new Set());
    index.build(graph);
    // Zones of an earlier session for pairs this map does not have (`seed`).
    index.seed(new Map(Array.from({ length: 6000 }, (_, k) => [`elsewhere:${k}`, null] as const)));
    const kept = (): number => (index as unknown as { store: { kept: Map<string, unknown> } }).store.kept.size;
    expect(kept()).toBeGreaterThanOrEqual(6000);
    index.setWindow(graph, inside);
    expect(kept()).toBeLessThan(6000);
  });
});
