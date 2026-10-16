import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { bodyClassOfArchetype } from '@sim/vehicles/archetypes';

/** STAGE 7 LOOKS AT THE LANES THAT CAN CONCERN IT, AND LEAVES THE FLEET AS THE WALK OVER IT DID */
const BLOCK = 120;

function town(n: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * (i - n / 2), y: m(BLOCK) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, j % 3 === 0 ? 3 : 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, i % 3 === 0 ? 3 : 1);
    }
  }
  const half = m(BLOCK) * (n / 2);
  doc.addSegment(ids[0]![0]! as never, doc.addNode({ x: -half - m(150), y: -half }).id as never, 1);
  doc.addSegment(ids[n]![n]! as never, doc.addNode({ x: half + m(150), y: half }).id as never, 1);
  return doc;
}

describe('stage 7', () => {
  it('leaves no vehicle the walk over the fleet would have taken away, and no stall counted off a lane into a signal', () => {
    const doc = town(5);
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x5e7e);
    w.rebuildTopology();
    w.trafficCount = 100;
    w.ambient.enabled = true;
    w.ambient.source = 'edges';
    w.clock.paused = false;
    for (let t = 1; t <= 900; t++) {
      step(w, { traffic: true, pedestrians: false });
      if (t % 5) continue;
      for (const v of w.vehicles.values()) {
        const lane = w.lanelet(v.lanelet);
        expect(lane, `vehicle ${v.id} on a lane of the graph`).toBeDefined();
        if (!lane) continue;
        // The walk's test, after the step: nobody left at a road's end with nowhere to go.
        const body = bodyClassOfArchetype(v.archetype);
        const atEnd = lane.length - v.s < v.driver.s0 + 2;
        const nowhere = w.graph.exitsOf(v.lanelet).every((id) => (w.connector(id)?.maxBodyClass ?? -1) < body);
        const edge = lane.to !== undefined && doc.mapEdge(lane.to);
        expect(lane.kind === 'link' && atEnd && nowhere && edge && !w.ambient.sighted.has(v.id), `vehicle ${v.id} at a road end`).toBe(false);
        if (lane.kind !== 'link' || !lane.controlled) expect([v.greenStall, v.greenDenied], `vehicle ${v.id}`).toEqual([0, 0]);
      }
    }
    // There was traffic.
    expect(w.vehicles.size).toBeGreaterThan(30);
  });
});
