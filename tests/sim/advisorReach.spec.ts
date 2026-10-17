import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import type { NodeId, SegmentId } from '@world/ids';
import { mainRoadLegs } from '@world/roads/rules';
import { ROAD_TUNING } from '@world/roads/tuning';
import { SimWorld } from '@sim/world';
import { warrantedControl } from '@sim/roads/controlAdvisor';

/** THE ADVISOR LOOKS AT THE JUNCTIONS WHOSE CONTROL CAN STILL CHANGE, AND DECIDES AS IF IT LOOKED AT EVERY ONE */
const BLOCK = 120;
const F = ROAD_TUNING.flow;

function town(n: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * i, y: m(BLOCK) * j }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, j % 2 === 0 ? 3 : 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, i % 2 === 0 ? 3 : 1);
    }
  }
  return doc;
}

describe('the control advisor', () => {
  it('lets the junctions at rest go, and leaves none whose evaluation would change it', () => {
    const doc = town(6);
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0xad51);
    w.rebuildTopology();
    const advised = (): ReadonlySet<NodeId> => (w as unknown as { advised: Set<NodeId> }).advised;
    const auto = [...w.graph.junctions.keys()].filter((node) => doc.node(node)!.control === 'auto' && doc.node(node)!.incident.length >= 3);
    // Heavy flow into two junctions, every second; nothing anywhere else.
    const busy = auto.slice(0, 2);
    for (let t = 0; t < F.trendWindow * 2 + 30; t++) {
      for (const node of busy) {
        const legs = doc.node(node)!.incident as SegmentId[];
        const main = mainRoadLegs(doc, node) ?? legs;
        if (t % 4 !== 0) w.flow.record(node, main[0]!);
        if (t % 3 === 0) w.flow.record(node, main[1] ?? main[0]!);
        const minor = legs.find((l) => !main.includes(l));
        if (minor !== undefined && t % 10 === 0) w.flow.record(node, minor);
      }
      w.stepControlAdvisor(1);
      if (t % 10 !== 9) continue;
      // Every junction it no longer looks at: its control what its flows warrant, and its choice made.
      for (const node of auto) {
        if (advised().has(node)) continue;
        const main = mainRoadLegs(doc, node);
        let major = 0, minorMax = 0, minorTotal = 0;
        for (const seg of doc.node(node)!.incident) {
          const rate = w.flow.rate(node, seg);
          if (main?.includes(seg)) major += rate; else { minorMax = Math.max(minorMax, rate); minorTotal += rate; }
        }
        const now = w.advisor.choice(node);
        expect(now, `junction ${node} at ${t} s`).toBeDefined();
        expect(warrantedControl(major, minorMax, minorTotal, now!)).toBe(now);
      }
    }
    // The quiet ones stepped down and were let go; the busy ones are still looked at, and signalised.
    expect(auto.length).toBeGreaterThan(20);
    expect(advised().size).toBeLessThanOrEqual(busy.length);
    for (const node of busy) expect(w.advisor.choice(node)).toBe('signal');
  });

  it('keeps a junction out of the micro window as it stood: its lights do not follow the camera', () => {
    const doc = town(4);
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0xad52);
    w.rebuildTopology();
    w.useMicroWindow();
    const node = [...w.graph.junctions.keys()].find((n) => doc.node(n)!.control === 'auto' && doc.node(n)!.incident.length >= 4)!;
    w.conflicts.setWindow(w.graph, new Set([node]));
    const legs = doc.node(node)!.incident as SegmentId[];
    const main = mainRoadLegs(doc, node) ?? legs;
    const minor = legs.find((l) => !main.includes(l));
    // Busy while the camera is there: signalised.
    for (let t = 0; t < F.trendWindow * 2 + 30; t++) {
      if (t % 4 !== 0) w.flow.record(node, main[0]!);
      if (t % 3 === 0) w.flow.record(node, main[1] ?? main[0]!);
      if (minor !== undefined && t % 10 === 0) w.flow.record(node, minor);
      w.stepControlAdvisor(1);
    }
    expect(w.advisor.choice(node)).toBe('signal');
    // The camera goes elsewhere: the junction is the meso's, nothing counted there; it stays signalised.
    w.conflicts.setWindow(w.graph, new Set());
    for (let t = 0; t < F.trendWindow * 4; t++) w.stepControlAdvisor(1);
    expect(w.advisor.choice(node)).toBe('signal');
  });
});
