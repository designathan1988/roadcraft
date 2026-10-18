import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import type { NodeId } from '@world/ids';
import { SimWorld } from '@sim/world';

/** A SIGNAL PLANNED OUT OF THE MICRO WINDOW NEVER GREENS CROSSING APPROACHES TOGETHER, AND IS PLANNED AGAIN FROM THE PAIRS WHEN THE WINDOW REACHES IT */
function cross(): { doc: RoadDoc; w: SimWorld; node: NodeId } {
  const doc = new RoadDoc();
  const c = doc.addNode({ x: 0, y: 0 });
  for (const [x, y] of [[m(120), 0], [-m(120), 0], [0, m(120)], [0, -m(120)]] as const) doc.addSegment(c.id, doc.addNode({ x, y }).id, 1);
  doc.setNodeControl(c.id, 'signal');
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x5160);
  w.useMicroWindow();
  w.rebuildTopology();
  return { doc, w, node: c.id };
}

/** Whether a stage greens two approaches whose mean directions cross (neither the same way nor opposite). */
function greensCrossing(w: SimWorld, node: NodeId): boolean {
  const junction = w.graph.junctions.get(node)!;
  const angle = new Map(junction.groups.map((g) => [g.id, g.meanAngle] as const));
  for (const stage of w.controller(node)!.plan.stages) {
    for (const a of stage.greenGroups) for (const b of stage.greenGroups) {
      const d = Math.abs(Math.atan2(Math.sin(angle.get(a)! - angle.get(b)!), Math.cos(angle.get(a)! - angle.get(b)!)));
      if (d > 0.6 && d < Math.PI - 0.6) return true;
    }
  }
  return false;
}

describe('a signal and the micro window', () => {
  it('pairs opposing approaches by their geometry while the conflict pairs are not known', () => {
    const { w, node } = cross();
    expect(w.conflicts.holds(node)).toBe(false);
    expect(w.controller(node)!.plan.stages.filter((s) => s.greenGroups.length).length).toBeGreaterThanOrEqual(2);
    expect(greensCrossing(w, node)).toBe(false);
  });

  it('is planned again from the conflict pairs when the window takes the junction in', () => {
    const { w, node } = cross();
    const before = w.controller(node)!.plan;
    w.conflicts.setWindow(w.graph, new Set([node]));
    (w as unknown as { windowMoved(c: ReadonlySet<NodeId>): void }).windowMoved(new Set([node]));
    expect(w.conflicts.holds(node)).toBe(true);
    expect(w.controller(node)!.plan).not.toBe(before);
    expect(greensCrossing(w, node)).toBe(false);
  });
});
