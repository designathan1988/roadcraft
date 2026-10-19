import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import type { NodeId } from '@world/ids';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { createAgentWalkEngine } from '@sim/agents/walk';

/** SIM-36: the walks that end are not piled up for a reader that does not exist (it grew without end with the ambient off). */
describe('the walks that end', () => {
  it('are not kept', () => {
    const doc = new RoadDoc();
    const ids: NodeId[] = [];
    for (let i = 0; i < 3; i++) ids.push(doc.addNode({ x: m(80) * i, y: 0 }).id);
    doc.addSegment(ids[0]!, ids[1]!, 1);
    doc.addSegment(ids[1]!, ids[2]!, 1);
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x36);
    w.rebuildTopology();
    w.usePedestrianEngine(createAgentWalkEngine());
    w.ambient.enabled = false;
    let trips = 0;
    for (const way of w.walkwaysNow().walkways()) {
      if (way.kind !== 'footway' || way.path.length < m(6)) continue;
      const a = way.path.sampleAt(way.path.length * 0.4).p, b = way.path.sampleAt(way.path.length * 0.6).p;
      if (w.pedEngine.walkTrip!(w, { trip: trips, fromX: a.x, fromY: a.y, toX: b.x, toY: b.y, seed: trips + 1, ageClass: 'adult' }) !== null) trips++;
    }
    expect(trips).toBeGreaterThan(2);
    let seen = 0;
    for (let i = 0; i < 60 * 120 && (i < 60 || w.pedViews.length > 0); i++) {
      seen = Math.max(seen, w.pedViews.length);
      step(w, { traffic: false, pedestrians: true });
    }
    expect(seen).toBe(trips);
    expect(w.pedViews.length).toBe(0);
    // Before: every trip that ended, held until somebody took them, and nobody did.
    const engine = w.pedEngine as { takeArrivals?: (w: SimWorld) => number[] };
    expect(engine.takeArrivals?.(w) ?? []).toEqual([]);
  });
});
