import { describe, expect, it } from 'vitest';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import { BODY_CLASSES, ConflictIndex } from '@world/conflictPoints';
import { LAYOUTS, fixtureDoc, layoutDoc } from '../sim/support/bodies';

/** The body classes by name, for the report. */
const BODY_CLASS_NAMES = ['small', 'car', 'heavy'] as const;

/** Conflict zones are measured from swept bodies, not centrelines. */

function indexOf(doc: ReturnType<typeof layoutDoc>['doc']) {
  const net = new Network(doc);
  net.rebuild();
  const graph = new LaneletGraph();
  graph.build(doc, net);
  const conflicts = new ConflictIndex();
  conflicts.build(graph);
  return { graph, conflicts };
}

describe('swept conflict zones', () => {
  it('finds the body conflicts that no centreline crossing reveals', () => {
    const { graph, conflicts } = indexOf(layoutDoc(LAYOUTS[0]!).doc);
    const swept = conflicts.points.filter((p) => p?.kind === 'swept');
    expect(swept.length).toBeGreaterThan(0);
    // Paths whose centrelines never meet, yet whose bodies do - a bus's tail swinging over the movement beside it.
    expect(swept.some((p) => p.zone(p.a, 2, 2) !== null && graph.connectors.get(p.a)?.inSegment !==
      graph.connectors.get(p.b)?.inSegment)).toBe(true);
  });

  it('nests: a smaller body is inside the zone of a larger one', () => {
    for (const layout of LAYOUTS) {
      const { conflicts } = indexOf(layoutDoc(layout).doc);
      for (const p of conflicts.points) {
        if (!p) continue;
        for (const on of [p.a, p.b]) {
          for (const theirs of BODY_CLASSES) {
            for (const mine of BODY_CLASSES.slice(0, -1)) {
              const small = p.zone(on, mine, theirs);
              const large = p.zone(on, (mine + 1) as 1 | 2, theirs);
              if (!small) continue;
              expect(large, `${layout.name} ${on}`).not.toBeNull();
              // Centres differ in range by the half-length difference only.
              expect(small.enter).toBeGreaterThanOrEqual(large!.enter - 1e-9);
            }
          }
        }
      }
    }
  });

  it('never reaches a vehicle still waiting behind its own stop line', () => {
    // A claim protects a body that is moving through the box.
    const report: Record<string, unknown> = {};
    for (const layout of LAYOUTS) {
      const { conflicts } = indexOf(layoutDoc(layout).doc);
      report[layout.name] = conflicts.queueIntrusions.map((q) => ({
        ...q, mine: BODY_CLASS_NAMES[q.mine], theirs: BODY_CLASS_NAMES[q.theirs],
      }));
      // Two cars: never.
      expect(conflicts.queueIntrusions.filter((q) => q.mine < 2 && q.theirs < 2), layout.name)
        .toEqual([]);
    }
  });

  it('measures a whole player map within its count of pairs', () => {
    // Counted, not timed (the timed version read 150 ms alone and nearly 2 s beside the rest of the suite)
    const { conflicts } = indexOf(fixtureDoc());
    expect(conflicts.points.filter(Boolean).length).toBeGreaterThan(100);
    expect(conflicts.measured.build).toBeLessThanOrEqual(518);
  });

  it('keeps a conflict id stable across a rebuild', () => {
    const { doc } = layoutDoc(LAYOUTS[0]!);
    const net = new Network(doc);
    net.rebuild();
    const graph = new LaneletGraph();
    graph.build(doc, net);
    const conflicts = new ConflictIndex();
    conflicts.build(graph);
    const before = new Map(conflicts.points.filter(Boolean).map((p) => [`${p.a}|${p.b}`, p.id]));
    conflicts.build(graph);
    for (const p of conflicts.points.filter(Boolean)) {
      expect(before.get(`${p.a}|${p.b}`)).toBe(p.id);
    }
  });
});
