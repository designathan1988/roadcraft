import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import type { NodeId } from '@world/ids';
import { SimWorld } from '@sim/world';
import { vehiclePose } from '@sim/pose';
import { spawnVehicleAt } from '@sim/vehicles/spawn';
import { archetypeById } from '@sim/vehicles/archetypes';
import { Rng } from '@core/rng';

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
    // The window first: the junctions' conflicts are built only where it asks (as in the game), not for the whole town before it.
    w.useMicroWindow();
    w.rebuildTopology();
    // Cars put on lanes drawn across the town: where they stand is all the window reads (DO NOT drive the town 40 s for it).
    const rng = new Rng(0x77c1);
    const links = [...w.graph.lanelets.values()].filter((lane) => lane.kind === 'link' && lane.length > m(20));
    const car = archetypeById('sedan');
    for (let k = 0; k < 6; k++) {
      const lane = links[rng.int(0, links.length - 1)]!;
      spawnVehicleAt(w, lane.id, car.length + m(1) + rng.float() * (lane.length - car.length - m(2)), car);
    }
    expect(w.vehicles.size).toBeGreaterThan(3);
    w.keepMicroWindow();
    const asked = (w as unknown as { windowWanted: ReadonlySet<NodeId> | null }).windowWanted!;
    const poses = [...w.vehicles.values()].map((v) => vehiclePose(w, v, 1)!.p);
    const reach = (node: NodeId): number => {
      const n = doc.node(node)!;
      return Math.min(...poses.map((p) => Math.max(Math.abs(n.x - p.x), Math.abs(n.y - p.y))));
    };
    let near = 0, far = 0;
    for (const node of w.graph.junctions.keys()) {
      const d = reach(node);
      if (d <= m(300)) { near++; expect(asked.has(node), `junction ${node} at ${d}`).toBe(true); }
      if (d > m(400)) { far++; expect(asked.has(node), `junction ${node} at ${d}`).toBe(false); }
    }
    // Both sides of the edge looked at.
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(0);
  });
});
