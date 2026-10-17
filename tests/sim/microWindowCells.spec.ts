import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import type { NodeId } from '@world/ids';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { vehiclePose } from '@sim/pose';

/** THE MICRO WINDOW ROUND THE VEHICLES ASKED BY CELL (`SimWorld.keepMicroWindow`): every junction within reach of a vehicle, none much past it */
const BLOCK = 120;

function town(n: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) { ids.push([]); for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * i, y: m(BLOCK) * j }).id); }
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
    if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
  }
  doc.addSegment(ids[0]![0]! as never, doc.addNode({ x: -m(150), y: 0 }).id as never, 1);
  doc.addSegment(ids[n]![n]! as never, doc.addNode({ x: m(BLOCK) * n + m(150), y: m(BLOCK) * n }).id as never, 1);
  return doc;
}

describe('the micro window round the vehicles', () => {
  it('holds every junction within 300 m of a vehicle, and none more than a cell past it', () => {
    const doc = town(12);
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x77c1);
    w.rebuildTopology();
    w.trafficIntensity = 10;
    w.clock.paused = false;
    for (let t = 0; t < Math.round(40 / DT); t++) step(w, { traffic: true, pedestrians: false });
    expect(w.vehicles.size).toBeGreaterThan(3);
    w.useMicroWindow();
    w.keepMicroWindow();
    const asked = (w as unknown as { windowWanted: ReadonlySet<NodeId> | null }).windowWanted!;
    const poses = [...w.vehicles.values()].map((v) => vehiclePose(w, v, 1)!.p);
    const reach = (node: NodeId): number => {
      const n = doc.node(node)!;
      return Math.min(...poses.map((p) => Math.max(Math.abs(n.x - p.x), Math.abs(n.y - p.y))));
    };
    for (const node of w.graph.junctions.keys()) {
      const d = reach(node);
      if (d <= m(300)) expect(asked.has(node), `junction ${node} at ${d}`).toBe(true);
      if (d > m(400)) expect(asked.has(node), `junction ${node} at ${d}`).toBe(false);
    }
  });
});
