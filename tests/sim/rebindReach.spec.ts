import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import type { SegmentId } from '@world/ids';
import { SimWorld } from '@sim/world';
import { step, tickWork } from '@sim/pipeline';

/** AN EDIT REBINDS THE VEHICLES IT REACHED, NOT THE FLEET */
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
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  const half = m(BLOCK) * (n / 2);
  doc.addSegment(ids[0]![0]! as never, doc.addNode({ x: -half - m(150), y: -half }).id as never, 1);
  doc.addSegment(ids[n]![n]! as never, doc.addNode({ x: half + m(150), y: half }).id as never, 1);
  return doc;
}

function running(): SimWorld {
  const doc = town(5);
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x7eb1);
  w.rebuildTopology();
  w.trafficCount = 80;
  w.ambient.enabled = true;
  w.ambient.source = 'edges';
  w.clock.paused = false;
  for (let i = 0; i < 400; i++) step(w, { traffic: true, pedestrians: false });
  return w;
}

/** The vehicles rebound by the next step, and the step taken. */
function rebound(w: SimWorld): number {
  const before = tickWork.rebound;
  step(w, { traffic: true, pedestrians: false });
  return tickWork.rebound - before;
}

describe('an edit of the roads', () => {
  it('rebinds no vehicle when it reaches none', () => {
    const w = running();
    expect(w.vehicles.size).toBeGreaterThan(40);
    const x = m(BLOCK) * 5;
    w.doc.addSegment(w.doc.addNode({ x, y: 0 }).id, w.doc.addNode({ x: x + m(60), y: 0 }).id, 1);
    w.net.rebuild();
    expect(rebound(w)).toBe(0);
  });

  it('rebinds those on, driving over or holding what it took', () => {
    const w = running();
    // The segment the most routes go over.
    const over = new Map<SegmentId, number>();
    for (const v of w.vehicles.values()) {
      for (const id of v.route) {
        const seg = w.lanelet(id)?.segment;
        if (seg !== undefined) over.set(seg as SegmentId, (over.get(seg as SegmentId) ?? 0) + 1);
      }
    }
    const victim = [...over].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
    const gone = new Set([...w.graph.lanelets.values()].filter((l) => l.segment === victim).map((l) => l.id));
    for (const node of [w.doc.segment(victim)!.a, w.doc.segment(victim)!.b]) {
      for (const id of w.graph.junctions.get(node)?.connectors ?? []) gone.add(id);
    }
    const reached = [...w.vehicles.values()].filter((v) => v.route.some((id) => gone.has(id)) || gone.has(v.lanelet));
    expect(reached.length).toBeGreaterThan(0);
    w.doc.removeSegment(victim);
    w.net.rebuild();
    const n = rebound(w);
    expect(n).toBeGreaterThanOrEqual(reached.length);
    expect(n).toBeLessThan(w.vehicles.size);
  });
});
