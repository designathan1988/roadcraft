import { describe, expect, it } from 'vitest';
import { RoadDoc, movementKey } from '../../src/world/doc';
import { Network } from '../../src/world/network';
import { LaneletGraph } from '../../src/world/lanelets';
import { sectionFromProfile, roadProfile, Level } from '../../src/world/roadTypes';
import { segmentMarkings } from '../../src/world/markings';

function crossing(reverse = false) {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  const ends = [{ x: -180, y: 0 }, { x: 0, y: 180 }, { x: 180, y: 0 }, { x: 0, y: -180 }];
  const segments = ends.map((p, index) => {
    const end = doc.addNode(p);
    return reverse && index === 0 ? doc.addSegment(centre.id, end.id, 2)! : doc.addSegment(end.id, centre.id, 2)!;
  });
  const incoming = segments[0]!;
  const section = sectionFromProfile(roadProfile(incoming.type, incoming.lanes, incoming.direction));
  const net = new Network(doc);
  const graph = new LaneletGraph();
  function build() { net.rebuild(); graph.build(doc, net); }
  return { doc, centre, segments, incoming, section, net, graph, build };
}

describe('authored lane turn rules', () => {
  it('filters each incoming lane and permits explicit mixed rules on an outer lane', () => {
    const f = crossing();
    f.doc.setSegmentSection(f.incoming.id, { ...f.section, turnsForward: ['through', 'leftThrough'] });
    f.build();
    const inbound = [...f.graph.lanelets.values()].filter((l) => l.kind === 'link' && l.segment === f.incoming.id && l.to === f.centre.id);
    for (const lane of inbound) {
      const turns = f.graph.exitsOf(lane.id).map((id) => f.graph.connectors.get(id)!.turn);
      expect(new Set(turns)).toEqual(new Set(lane.laneIndex === 0 ? ['through'] : ['left', 'through']));
    }
  });

  it('never restores a forbidden turn through the no-exit fallback', () => {
    const f = crossing();
    f.doc.setSegmentSection(f.incoming.id, { ...f.section, turnsForward: ['left', 'left'] });
    f.doc.requireNode(f.centre.id).blockedMovements.push(movementKey(f.incoming.id, f.segments[1]!.id));
    f.build();
    for (const lane of f.graph.lanelets.values()) {
      if (lane.kind === 'link' && lane.segment === f.incoming.id && lane.to === f.centre.id) {
        expect(f.graph.exitsOf(lane.id)).toEqual([]);
      }
    }
  });

  it('an edit of the arrows alone reaches a graph that reuses its junctions', () => {
    const f = crossing();
    f.doc.setSegmentSection(f.incoming.id, f.section);
    const turns = (graph: LaneletGraph) => [...graph.lanelets.values()]
      .filter((l) => l.kind === 'link' && l.segment === f.incoming.id && l.to === f.centre.id)
      .flatMap((l) => graph.exitsOf(l.id).map((id) => `${l.laneIndex}:${graph.connectors.get(id)!.turn}`))
      .sort();
    f.build();
    f.doc.setSegmentSection(f.incoming.id, { ...f.section, turnsForward: ['left', 'left'] });
    f.build();
    const fresh = new LaneletGraph();
    fresh.build(f.doc, f.net);
    expect(turns(f.graph)).toEqual(turns(fresh));
    expect(turns(f.graph)).toEqual(['0:left', '1:left']);
  });

  it('reads backward rules at the stored a end, independently of forward rules', () => {
    const f = crossing(true);
    f.doc.setSegmentSection(f.incoming.id, { ...f.section, turnsForward: ['left', 'left'], turnsBackward: ['right', 'right'] });
    f.build();
    // This approach was authored centre -> west; arriving traffic therefore reads backward rules.
    for (const lane of f.graph.lanelets.values()) {
      if (lane.kind === 'link' && lane.segment === f.incoming.id && lane.to === f.incoming.a) {
        const turns = f.graph.exitsOf(lane.id).map((id) => f.graph.connectors.get(id)!.turn);
        expect(new Set(turns)).toEqual(new Set(['right']));
      }
    }
  });

  it('deep-copies arrow arrays at input, snapshot, clone and replacement boundaries', () => {
    const f = crossing();
    const rules = ['left' as const, 'through' as const];
    f.doc.setSegmentSection(f.incoming.id, { ...f.section, turnsForward: rules });
    const saved = f.doc.toJSON();
    const cloned = f.doc.clone();
    const replacement = new RoadDoc();
    replacement.replaceWith(f.doc);
    rules.reverse();
    expect(f.incoming.section!.turnsForward).toEqual(['left', 'through']);
    expect(saved.segments[0]!.section!.turnsForward).not.toBe(f.incoming.section!.turnsForward);
    expect(cloned.requireSegment(f.incoming.id).section!.turnsForward).not.toBe(f.incoming.section!.turnsForward);
    expect(replacement.requireSegment(f.incoming.id).section!.turnsForward).not.toBe(f.incoming.section!.turnsForward);
    const revision = f.doc.revision;
    f.doc.setSegmentSection(f.incoming.id, { ...f.section, turnsForward: ['right', 'through'] });
    expect(f.doc.revision).toBeGreaterThan(revision);
    expect(saved.segments[0]!.section!.turnsForward).toEqual(['left', 'through']);
  });

  it('paints the same rules inside the approach lanes and preserves unconfigured markings', () => {
    const f = crossing();
    f.build();
    const oldRibbon = f.net.ribbons.get(f.incoming.id)!;
    const oldPaint = segmentMarkings(oldRibbon, 0);
    f.doc.setSegmentSection(f.incoming.id, { ...f.section, turnsForward: ['through', 'right'] });
    f.build();
    const ribbon = f.net.ribbons.get(f.incoming.id)!;
    const paint = segmentMarkings(ribbon, 0);
    expect(paint.length).toBeGreaterThan(oldPaint.length);
    const arrows = paint.slice(oldPaint.length);
    const end = ribbon.centre[Level.Asphalt]!.sampleAt(ribbon.centre[Level.Asphalt]!.length).p.x;
    for (const stroke of arrows) for (const point of stroke.points) {
      expect(point.x).toBeLessThan(end - 5);
      expect(Math.abs(point.y)).toBeLessThan(ribbon.road.width / 2);
    }
  });
});
