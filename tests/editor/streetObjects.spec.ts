import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import { buildWalkways } from '@world/walkways';
import { CROSSWALK_DEPTH, STOP_BAR_SETBACK } from '@world/approach';
import { History, restoreSnapshot } from '@editor/history';
import { commitPedestrianCrossing } from '@editor/streetObjects';
import { joinSegments, splitSegment } from '@editor/commit';
import { junctionDetail } from '@world/markings';
import { signalPostPlace } from '@world/signalPosts';
import { crossingsCompatibleWith } from '@sim/signals/plan';

function street(curved = false) {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -250, y: 0 }, 1), b = doc.addNode({ x: 250, y: 0 }, 3);
  const segment = doc.addSegment(a.id, b.id, 1, curved ? { t: 0.5, h: 55 } : null,
    17, 'both', 2, 'ground', { laneWidth: 9, sidewalk: 7, median: 0, speedKmh: 30, priority: 1 })!;
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, segment };
}

describe('authored pedestrian crossing', () => {
  it.each(['zebra', 'signal'] as const)('creates routable %s crossings with stop lines behind the paint', (kind) => {
    const { doc, net, segment } = street();
    const result = commitPedestrianCrossing(doc, net, segment.id, kind);
    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(doc.requireNode(result.node).control).toBe(kind === 'signal' ? 'signal' : 'priority');
    expect(doc.requireNode(result.node).crossing).toEqual({ kind, segment: result.segments[0] });
    const walking = buildWalkways(net);
    const crossings = walking.ways.filter((way) => way.kind === 'crossing' && way.node === result.node);
    expect(crossings).toHaveLength(1);
    const middle = crossings[0]!.path.sampleAt(crossings[0]!.path.length / 2).p;
    expect(middle.x).toBeCloseTo(0, 2);
    expect(middle.y).toBeCloseTo(0, 2);
    const graph = new LaneletGraph();
    graph.build(doc, net);
    const junction = graph.junctions.get(result.node)!;
    expect(junction.signalised).toBe(kind === 'signal');
    const crossingId = `${result.node}:${crossings[0]!.segment}`;
    for (const group of junction.groups) {
      expect(crossingsCompatibleWith(junction, [group.id], [crossingId], (id) => graph.connectors.get(id))).toEqual([]);
    }
    expect(crossingsCompatibleWith(junction, [], [crossingId], (id) => graph.connectors.get(id))).toEqual([crossingId]);
    for (const id of result.segments) {
      const crossing = net.crosswalkDistanceAt(id, result.node);
      expect(crossing).toBe(id === crossings[0]!.segment ? CROSSWALK_DEPTH / 2 : 0);
      expect(net.stopLineDistance(id, result.node)).toBeGreaterThanOrEqual(CROSSWALK_DEPTH + STOP_BAR_SETBACK);
      expect(net.stopLineDistance(id, result.node)).toBeGreaterThanOrEqual(crossing + CROSSWALK_DEPTH / 2 + STOP_BAR_SETBACK);
      const incoming = [...graph.lanelets.values()].filter((lane) => lane.kind === 'link' && lane.segment === id && lane.to === result.node);
      expect(incoming).toHaveLength(1);
      expect(incoming[0]!.controlled).toBe(true);
    }
  });

  it('preserves curved geometry, heights, section and dash phase through save and exact undo', () => {
    const { doc, net, segment } = street(true);
    const history = new History(), before = doc.toJSON();
    const original = net.polylines.get(doc, segment.id);
    history.record(doc);
    const result = commitPedestrianCrossing(doc, net, segment.id, 'zebra');
    expect(result.committed).toBe(true);
    if (!result.committed) return;
    const pieces = result.segments.map((id) => doc.requireSegment(id));
    expect(pieces.map((piece) => piece.section)).toEqual([segment.section, segment.section]);
    expect(pieces.map((piece) => piece.curve)).not.toContain(null);
    expect(pieces[0]!.dashOrigin).toBe(17);
    expect(pieces[1]!.dashOrigin).toBeCloseTo(17 + original.length / 2 + CROSSWALK_DEPTH / 2, 5);
    expect(doc.requireNode(result.node).heightOffset).toBeCloseTo(2 + CROSSWALK_DEPTH / original.length, 5);
    for (const id of result.segments) {
      for (const point of net.polylines.get(doc, id).toPoints()) expect(original.distanceTo(point)).toBeLessThan(0.5);
    }
    const after = doc.toJSON(), loaded = new RoadDoc();
    loaded.replaceFromJSON(after, { repair: false });
    expect(loaded.toJSON()).toEqual(after);
    restoreSnapshot(doc, history.undo(doc)!, net);
    expect(doc.toJSON()).toEqual(before);
    restoreSnapshot(doc, history.redo(doc)!, net);
    expect(doc.toJSON()).toEqual(after);
  });

  it('keeps the crossing through a split of its piece and drops it when a junction forms', () => {
    const { doc, net, segment } = street();
    const result = commitPedestrianCrossing(doc, net, segment.id, 'zebra');
    expect(result.committed).toBe(true);
    if (!result.committed) return;
    const owner = doc.requireNode(result.node).crossing!.segment;
    // A road crossing the painted piece splits it: the crossing follows the
    // piece that still touches the node, and stays where it was painted.
    splitSegment(doc, net, owner, 60, net.polylines.get(doc, owner).sampleAt(60).p);
    net.rebuild();
    const carried = doc.requireNode(result.node).crossing;
    expect(carried?.kind).toBe('zebra');
    expect(carried?.segment).not.toBe(owner);
    expect(doc.requireNode(result.node).incident).toContain(carried!.segment);
    expect(net.crosswalkDistanceAt(carried!.segment, result.node)).toBe(CROSSWALK_DEPTH / 2);
    // The crossing node is not joined away.
    expect(joinSegments(doc, result.node)).toBe(false);
    // A third road makes it a junction, which draws its own crossings.
    const side = doc.addNode({ x: 0, y: 200 });
    doc.addSegment(result.node, side.id, 1);
    expect(doc.requireNode(result.node).crossing).toBeUndefined();
    expect(doc.requireNode(result.node).control).toBe('auto');
  });

  it('a graph that reuses its junctions sees a crossing placed later', () => {
    const { doc, net, segment } = street();
    const graph = new LaneletGraph();
    graph.build(doc, net);
    const result = commitPedestrianCrossing(doc, net, segment.id, 'signal');
    expect(result.committed).toBe(true);
    if (!result.committed) return;
    net.rebuild();
    graph.build(doc, net);
    expect(graph.junctions.get(result.node)?.signalised).toBe(true);
    doc.clearNodeCrossing(result.node);
    net.rebuild();
    graph.build(doc, net);
    for (const lane of graph.lanelets.values()) {
      if (lane.kind === 'link' && lane.to === result.node) expect(lane.controlled).toBe(false);
    }
  });

  it('keeps lane arrows on the piece that reaches the junction, so the crossing lane has a way on', () => {
    const { doc, net, segment } = street();
    doc.setSegmentSection(segment.id, { ...segment.section!, turnsForward: ['left'], turnsBackward: ['right'] });
    net.rebuild();
    const result = commitPedestrianCrossing(doc, net, segment.id, 'zebra');
    expect(result.committed).toBe(true);
    if (!result.committed) return;
    const [first, second] = result.segments.map((id) => doc.requireSegment(id)).sort((p, q) => (p.a === segment.a ? -1 : q.a === segment.a ? 1 : 0));
    expect(first!.section?.turnsForward).toBeUndefined();
    expect(first!.section?.turnsBackward).toEqual(['right']);
    expect(second!.section?.turnsForward).toEqual(['left']);
    expect(second!.section?.turnsBackward).toBeUndefined();
    const graph = new LaneletGraph();
    graph.build(doc, net);
    for (const lane of graph.lanelets.values()) {
      if (lane.kind === 'link' && lane.to === result.node) expect(graph.exitsOf(lane.id).length).toBeGreaterThan(0);
    }
    // Joining back gives the road its two ends' arrows again.
    doc.clearNodeCrossing(result.node);
    expect(joinSegments(doc, result.node)).toBe(true);
    const joined = [...doc.segments.values()][0]!;
    expect(joined.section?.turnsForward).toEqual(['left']);
    expect(joined.section?.turnsBackward).toEqual(['right']);
  });

  it('paints the zebra and both stop bars of a mid-block crossing', () => {
    const { doc, net, segment } = street();
    const before = junctionDetail(net);
    const result = commitPedestrianCrossing(doc, net, segment.id, 'zebra');
    expect(result.committed).toBe(true);
    if (!result.committed) return;
    net.rebuild();
    const after = junctionDetail(net);
    const node = doc.requireNode(result.node);
    const near = (bars: { a: { x: number; y: number }; b: { x: number; y: number } }[]) =>
      bars.filter((bar) => Math.hypot((bar.a.x + bar.b.x) / 2 - node.x, (bar.a.y + bar.b.y) / 2 - node.y) < 20);
    expect(near(after.zebras).length).toBeGreaterThan(0);
    expect(near(before.zebras)).toHaveLength(0);
    for (const bar of near(after.zebras)) {
      const mx = (bar.a.x + bar.b.x) / 2;
      expect(mx).toBeGreaterThan(node.x - CROSSWALK_DEPTH - 0.01);
      expect(mx).toBeLessThan(node.x + 0.01);
    }
    expect(near(after.stops)).toHaveLength(2);
  });

  it('stands the signal posts of a signal crossing at its stop lines', () => {
    const { doc, net, segment } = street();
    const result = commitPedestrianCrossing(doc, net, segment.id, 'signal');
    expect(result.committed).toBe(true);
    if (!result.committed) return;
    net.rebuild();
    const node = doc.requireNode(result.node);
    for (const id of result.segments) {
      const post = signalPostPlace(net, result.node, id)!;
      const along = Math.abs(post.x - node.x);
      expect(along).toBeCloseTo(net.stopLineDistance(id, result.node), 5);
    }
  });

  it('rejects unsafe locations and unsupported roads atomically', () => {
    const { doc, net, segment } = street();
    const before = doc.toJSON();
    for (const s of [NaN, -1, 1, 499, 501]) {
      expect(commitPedestrianCrossing(doc, net, segment.id, 'zebra', s).committed).toBe(false);
      expect(doc.toJSON()).toEqual(before);
    }
    // An authored section always keeps a footway (`ROAD_SECTION_LIMITS`), so the
    // road without pedestrians is a class that carries none: the highway.
    doc.setSegmentSection(segment.id, undefined);
    doc.setSegmentType(segment.id, 4);
    net.rebuild();
    const withoutFootway = doc.toJSON();
    expect(commitPedestrianCrossing(doc, net, segment.id, 'zebra')).toMatchObject({ committed: false, reason: 'unsupported' });
    expect(doc.toJSON()).toEqual(withoutFootway);
  });
});
