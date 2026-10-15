import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import { SimWorld } from '@sim/world';
import { rebindVehicles } from '@sim/pipeline';
import { commitDraft } from '@editor/commit';

/** The link lanelets and junction connectors a road edit did not touch are reused as they were built. */

function gridDoc(n = 5, spacing = 150, type = 1): RoadDoc {
  const doc = new RoadDoc();
  const ids: NodeId[][] = [];
  const origin = -((n - 1) * spacing) / 2;
  for (let i = 0; i < n; i++) {
    ids.push([]);
    for (let j = 0; j < n; j++) ids[i]!.push(doc.addNode({ x: origin + i * spacing, y: origin + j * spacing }).id);
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, type);
      if (j + 1 < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, type);
    }
  }
  return doc;
}

/** Three legs off one node, 60 degrees apart, none of them in line with another */
function fanDoc(type = 1): { doc: RoadDoc; a: SegmentId; b: SegmentId; c: SegmentId; node: NodeId } {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 }).id;
  const east = doc.addNode({ x: 150, y: 0 }).id;
  const northEast = doc.addNode({ x: 75, y: 130 }).id;
  const northWest = doc.addNode({ x: -75, y: 130 }).id;
  const a = doc.addSegment(centre, east, type)!.id;
  const b = doc.addSegment(centre, northEast, type)!.id;
  const c = doc.addSegment(centre, northWest, type)!.id;
  return { doc, a, b, c, node: centre };
}

/** Every lanelet, connector and junction of the graph, by the numbers that matter. */
function graphShape(sim: SimWorld): string[] {
  const out: string[] = [];
  for (const [id, l] of sim.graph.lanelets) {
    const centre = l.centre.toPoints().map((p) => `${p.x},${p.y}`).join(';');
    out.push(`L|${id}|${l.kind}|${centre}|${l.length}|${l.speedLimit}|${l.segment}|${l.from}|${l.to}|${l.laneIndex}|${l.controlled}`);
  }
  for (const [id, c] of sim.graph.connectors) {
    out.push(`C|${id}|${c.node}|${c.fromLane}|${c.toLane}|${c.inSegment}|${c.outSegment}|${c.turn}|${c.carried}|${c.group}|${c.length}|${c.maxBodyClass}`);
  }
  for (const [node, j] of sim.graph.junctions) {
    out.push(`J|${node}|${j.groups.map((g) => `${g.id}:${g.segments.join(',')}`).join(';')}|${j.connectors.join(',')}|${j.inbound.join(',')}|${j.signalised}|${j.control}`);
  }
  return out.sort();
}

const clearCaches = (sim: SimWorld): void => {
  const c = sim.graph as unknown as { linkCache: Map<string, unknown>; junctionCache: Map<string, unknown> };
  c.linkCache.clear();
  c.junctionCache.clear();
};

const rebuild = (sim: SimWorld): void => { sim.rebuildVehicleTopology(); rebindVehicles(sim); };

/** Builds the graph, makes one change, rebuilds answering from the cache */
function afterChange(net: Network, sim: SimWorld, change: () => void): { reused: string[]; fresh: string[]; before: string[] } {
  const before = graphShape(sim);
  change();
  net.rebuild();
  rebuild(sim);
  const reused = graphShape(sim);
  clearCaches(sim);
  rebuild(sim);
  const fresh = graphShape(sim);
  return { reused, fresh, before };
}

describe('the lanelet graph cache', () => {
  it('builds the same graph reused or from nothing', () => {
    const doc = gridDoc();
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x51ce);
    sim.rebuildTopology();

    const { reused, fresh } = afterChange(net, sim, () => {
      commitDraft(doc, net, { kind: 'free', at: { x: -120, y: -120 } }, { kind: 'free', at: { x: 40, y: -120 } }, 1);
      net.rebuild();
      rebuild(sim);
    });
    expect(reused.length).toBeGreaterThan(50);
    expect(reused).toEqual(fresh);
  });

  it('rebuilds a junction whose road only changed priority', () => {
    const { doc, a } = fanDoc();
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x51ce);
    sim.rebuildTopology();

    // Numbers that reproduce `urban`'s own profile exactly
    const section = { laneWidth: 11, sidewalk: 5, median: 0, speedKmh: 50, priority: 3 };
    doc.setSegmentSection(a, section);
    net.rebuild();
    rebuild(sim);

    const { reused, fresh, before } = afterChange(net, sim, () => {
      doc.setSegmentSection(a, { ...section, priority: 0 });
    });
    expect(reused).not.toEqual(before);
    expect(reused).toEqual(fresh);
  });

  it('cannot be made to fail on the type alone, and says why', () => {
    // Why `type` cannot be caught by a case of its own: the pairs of types that would be needed do not exist.
    const { doc, a } = fanDoc(1);
    const section = { laneWidth: 11, sidewalk: 5, median: 0, speedKmh: 50, priority: 2 };
    doc.setSegmentSection(a, section);
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x51ce);
    sim.rebuildTopology();
    const before = graphShape(sim);

    doc.setSegmentType(a, 0);
    net.rebuild();
    rebuild(sim);
    expect(graphShape(sim)).toEqual(before);
  });

  it('rebuilds a junction whose road changed type', () => {
    // No two types of the table share a profile, so a type change moves the numbers too
    const { doc, a } = fanDoc(1);
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x51ce);
    sim.rebuildTopology();

    const { reused, fresh, before } = afterChange(net, sim, () => {
      doc.setSegmentType(a, 0);
    });
    expect(reused).not.toEqual(before);
    expect(reused).toEqual(fresh);
  });

  it('rebuilds a junction whose control changed', () => {
    // A three-legged junction of two-lane roads: `auto` leaves it uncontrolled, `signal` signalises it.
    const { doc, node } = fanDoc();
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x51ce);
    sim.rebuildTopology();

    const { reused, fresh, before } = afterChange(net, sim, () => {
      doc.setNodeControl(node, 'signal');
    });
    expect(reused).not.toEqual(before);
    expect(reused).toEqual(fresh);
  });

  it('rebuilds a junction whose blocked movements changed', () => {
    const doc = gridDoc();
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x51ce);
    sim.rebuildTopology();
    const node = [...doc.nodes.values()].find((n) => n.incident.length === 4)!;
    const from = node.incident[0]!;

    const { reused, fresh, before } = afterChange(net, sim, () => {
      doc.setMovementBlocked(node.id, from, node.incident[1]!, true);
    });
    expect(reused).not.toEqual(before);
    expect(reused).toEqual(fresh);
  });

  it('rebuilds a junction whose road changed direction', () => {
    // One way to the other, on a segment whose two ends have the same degree
    const doc = gridDoc();
    const segment = [...doc.segments.values()].find((s) =>
      doc.degree(s.a) === 4 && doc.degree(s.b) === 4)!.id;
    doc.setSegmentDirection(segment, 'aToB');
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x51ce);
    sim.rebuildTopology();

    const { reused, fresh, before } = afterChange(net, sim, () => {
      doc.setSegmentDirection(segment, 'bToA');
    });
    expect(reused).not.toEqual(before);
    expect(reused).toEqual(fresh);
  });
});
