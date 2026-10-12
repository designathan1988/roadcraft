import { describe, expect, it } from 'vitest';
import { RoadDoc } from '../../src/world/doc';
import { Network } from '../../src/world/network';
import { LaneletGraph } from '../../src/world/lanelets';
import { roadProfile, roadType } from '../../src/world/roadTypes';
import { History, restoreSnapshot } from '../../src/editor/history';
import { duplicateSegment, splitSegment } from '../../src/editor/commit';
import { normalizeRoadSection } from '../../src/world/roadSection';
import { kmh, m } from '../../src/world/units';

// Whole metres of the universal grid: 4 m lanes, 4 m footways, a 2 m median.
const section = { laneWidth: m(4), sidewalk: m(4), median: m(2), speedKmh: 40, priority: 3 };
function street() {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-60), y: 0 });
  const b = doc.addNode({ x: m(60), y: 0 });
  const segment = doc.addSegment(a.id, b.id, 0)!;
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, segment };
}

describe('authored road cross-section', () => {
  it('rejects malformed sections and bounds finite dimensions', () => {
    expect(normalizeRoadSection({ ...section, laneWidth: NaN })).toBeUndefined();
    expect(normalizeRoadSection({ laneWidth: m(4) })).toBeUndefined();
    expect(normalizeRoadSection({ ...section, sidewalk: m(-2), median: m(40) })).toEqual({ ...section, sidewalk: m(1), median: m(8) });
    // Off-grid widths come back as whole metres.
    expect(normalizeRoadSection({ ...section, laneWidth: m(3.44) })?.laneWidth).toBe(m(3));
  });

  it('centres one-way lanes and restores the authored median when changed back', () => {
    const { doc, segment } = street();
    doc.setSegmentSection(segment.id, section);
    doc.setSegmentDirection(segment.id, 'aToB');
    let profile = roadProfile(segment.type, segment.lanes, segment.direction, segment.section);
    expect(profile.width).toBe(m(8));
    expect(profile.median).toBe(0);
    doc.setSegmentDirection(segment.id, 'both');
    profile = roadProfile(segment.type, segment.lanes, segment.direction, segment.section);
    expect(profile.median).toBe(m(2));
    const revision = doc.revision;
    doc.setSegmentSection(segment.id, { ...section });
    expect(doc.revision).toBe(revision);
    doc.setSegmentSection(segment.id);
    expect(roadProfile(segment.type, segment.lanes, segment.direction, segment.section)).toBe(roadType(0));
  });

  it('keeps old documents on their exact class profile', () => {
    const { doc, segment } = street();
    expect(roadProfile(segment.type, segment.lanes, segment.direction)).toBe(roadType(0));
    expect(doc.toJSON().segments[0]).not.toHaveProperty('section');
  });

  it('places actual vehicle lanelets within the authored drawn carriageway', () => {
    const { doc, net, segment } = street();
    doc.setSegmentSection(segment.id, section);
    net.rebuild();
    const graph = new LaneletGraph();
    graph.build(doc, net);
    const profile = net.ribbons.get(segment.id)!.road;
    expect(profile.width).toBe(m(10));
    expect(profile.sidewalk).toBe(m(4));
    expect(profile.priorityRank).toBe(3);
    expect(graph.lanelets.size).toBe(2);
    for (const lane of graph.lanelets.values()) {
      expect(Math.abs(lane.centre.sampleAt(lane.length / 2).p.y)).toBeCloseTo(m(3));
      expect(Math.abs(lane.centre.sampleAt(lane.length / 2).p.y) + section.laneWidth / 2).toBeLessThanOrEqual(profile.width / 2);
      expect(lane.speedLimit).toBeCloseTo(kmh(40));
    }
  });

  it('persists independent snapshots and restores undo/redo with revision invalidation', () => {
    const { doc, net, segment } = street();
    const history = new History();
    history.record(doc);
    const oldRevision = doc.revision;
    const oldTraffic = doc.trafficRevision;
    doc.setSegmentSection(segment.id, section);
    expect(doc.revision).toBeGreaterThan(oldRevision);
    expect(doc.trafficRevision).toBeGreaterThan(oldTraffic);
    const saved = doc.toJSON();
    doc.setSegmentSection(segment.id, { ...section, sidewalk: m(5) });
    expect(saved.segments[0]!.section).toEqual(section);
    expect(RoadDoc.fromJSON(saved).requireSegment(segment.id).section).toEqual(section);
    restoreSnapshot(doc, history.undo(doc)!, net);
    expect(doc.requireSegment(segment.id).section).toBeUndefined();
    restoreSnapshot(doc, history.redo(doc)!, net);
    expect(doc.requireSegment(segment.id).section?.sidewalk).toBe(m(5));
  });

  it('preserves authored widths when splitting and duplicating', () => {
    const { doc, net, segment } = street();
    doc.setSegmentSection(segment.id, section);
    net.rebuild();
    const copied = duplicateSegment(doc, net, segment.id)!;
    expect(doc.requireSegment(copied).section).toEqual(section);
    expect(splitSegment(doc, net, segment.id, m(60), { x: 0, y: 0 })).not.toBeNull();
    expect(doc.segments.size).toBe(3);
    for (const road of doc.segments.values()) expect(road.section).toEqual(section);
  });
});
