import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { offsetPolyline } from '@core/offset';
import { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';
import type { NodeId, SegmentId } from '@world/ids';
import { LaneletGraph, clipToEndSections } from '@world/lanelets';
import { Level, halfWidth } from '@world/roadTypes';
import { HEAVY } from '@world/conflictPoints';
import { JunctionSurface } from '@world/turnPaths';
import { bendAtNode } from '@world/junction/build';
import { mouthOverlapStrip } from '@world/junction/mouthOverlap';
import { orientedPolyline } from '@world/geometry';
import { replay, type Fixture } from '../fuzz/support/runner';

/**
 * MOVEMENTS NO VEHICLE COULD MAKE (P92, fuzz `turnOffSurface`).
 *
 * A seeded hunt over 60 sequences of 60 gestures found 135 movements that
 * fitted no body at all; each case here is one cause, shrunk to a few
 * gestures, and fails on the code before its fix. Every one is also replayed
 * by `tests/fuzz/regressions.spec.ts`; here each is asked the question its
 * cause answers.
 */
function built(name: string) {
  const fixture = JSON.parse(readFileSync(`tests/fuzz/fixtures/${name}.json`, 'utf8')) as Fixture;
  const outcome = replay(fixture.ops, null, 'turnOffSurface');
  const graph = new LaneletGraph();
  graph.build(outcome.state.doc, outcome.state.net);
  return { ...outcome.state, graph, defects: outcome.defects };
}

describe('a lane ends where its road is cut', () => {
  // The trimmed centre of seed 21's avenue: the cut fell 0.06 units past a
  // vertex of the curve, and the kerb-side lane is 5.25 units to its inside.
  const trimmed: Vec2[] = [[-259.058, -51.352], [-260.664, -51.725], [-262.656, -52.064], [-264.602, -52.267],
    [-266.5, -52.335], [-268.352, -52.267], [-270.156, -52.064], [-270.217, -52.052]].map(([x, y]) => ({ x: x!, y: y! }));
  const centre = Polyline.fromPoints(trimmed);
  const start = centre.sampleAt(0).t, end = centre.sampleAt(centre.length).t;

  it('drops the mitre vertex the offset put past the end', () => {
    const raw = offsetPolyline(trimmed, -5.25);
    const step = (pts: readonly Vec2[]): number => {
      const a = pts[pts.length - 2]!, b = pts[pts.length - 1]!;
      return (b.x - a.x) * end.x + (b.y - a.y) * end.y;
    };
    // The raw offset steps back at its end: what made every turn out of the lane a hook.
    expect(step(raw)).toBeLessThan(0);
    const lane = clipToEndSections(raw, start, end);
    expect(step(lane)).toBeGreaterThan(0);
    expect(lane[0]).toEqual(raw[0]);
    expect(lane[lane.length - 1]).toEqual(raw[raw.length - 1]);
  });

  it('keeps a lane that winds back on itself further along', () => {
    // A hairpin: its first points lie beyond its end's cross-section, but not right before the end.
    const u: Vec2[] = [{ x: -20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 10 }, { x: -1, y: 10 }];
    expect(clipToEndSections(u, { x: 1, y: 0 }, { x: -1, y: 0 })).toEqual(u);
  });

  for (const name of ['lane-end-reversed-by-short-trim-piece', 'lane-end-reversed-on-curved-approach']) {
    it(`points every lane on at both ends (${name})`, () => {
      const { graph, defects } = built(name);
      expect(defects).toEqual([]);
      for (const lane of graph.lanelets.values()) {
        if (lane.kind !== 'link' || lane.length < 1) continue;
        const a = lane.centre.sampleAt(lane.length - 0.5).p, b = lane.centre.sampleAt(lane.length).p;
        const t = lane.centre.sampleAt(lane.length).t;
        expect((b.x - a.x) * t.x + (b.y - a.y) * t.y).toBeGreaterThan(0);
      }
    });
  }
});

describe('a turn is shaped for the largest body that can make it', () => {
  it.each([
    ['bus-leaves-kerb-on-acute-turn', '2:3>2:1->1:2>1:1'],
    ['turn-shaped-for-the-bus-alone-on-gentle-bend', '1:1>2:1->2:2>3:1'],
  ])('lets a car round the outer lane of a bend no bus fits (%s)', (name, movement) => {
    const { graph, defects } = built(name);
    expect(defects).toEqual([]);
    // Not the bus (it overhangs the outer kerb), but a car - not nothing.
    expect(graph.connectors.get(movement)?.maxBodyClass).toBe(1);
    const others = [...graph.connectors.values()].filter((c) => c.id !== movement && c.node === graph.connectors.get(movement)!.node);
    expect(others.every((c) => c.maxBodyClass === HEAVY)).toBe(true);
  });
});

describe('a body is only where traffic can be', () => {
  it('drives into and out of a stub the plate took nearly all of', () => {
    const { doc, graph, defects } = built('stub-taken-by-plate-at-road-end');
    expect(defects).toEqual([]);
    // Segment 3 runs 14.6 units to the end of the road.
    const stub = 3 as SegmentId;
    const through = [...graph.connectors.values()].filter((c) => c.inSegment === stub || c.outSegment === stub);
    expect(through.length).toBeGreaterThan(0);
    expect(through.every((c) => c.maxBodyClass === HEAVY)).toBe(true);
    expect(doc.mapEdge(doc.segment(stub)!.b)).toBe(true);
  });

  it('checks the body with its nose at the road end, not a step short of it', () => {
    expect(built('body-at-road-end-between-sweep-steps').defects).toEqual([]);
  });
});

describe('a ramp gore only where the ramp joins at a gore', () => {
  it.each([
    ['highway-corner-built-as-ramp-gore', 2],
    ['highway-meeting-ramps-square-built-as-gore', 7],
  ])('builds a plate where a highway turns a corner or meets a ramp square (%s)', (name, node) => {
    const { net, defects } = built(name);
    expect(defects).toEqual([]);
    const plate = net.junctions.get(node as NodeId)?.get(Level.Asphalt);
    expect(plate?.rings.length).toBeGreaterThan(0);
    expect(plate?.trims.every((t) => t > 0)).toBe(true);
  });
});

describe('a node of one road is straight where the roads meet', () => {
  it('builds the kink two curves meet at, though they look aligned a half-width out', () => {
    const { doc, net, defects } = built('kink-at-chain-node-read-as-straight');
    expect(defects).toEqual([]);
    const node = 3 as NodeId;
    expect(bendAtNode(doc, net.polylines, node)).toBeGreaterThan((5 * Math.PI) / 180);
    expect(net.junctions.get(node)?.get(Level.Asphalt)?.transition).toBe(true);
  });
});

describe('the ground a turn is swept over is the ground that is drawn', () => {
  it('reaches the road on past a short leg that bends on at a node of its own', () => {
    const { doc, net, defects } = built('short-approach-past-chain-node');
    expect(defects).toEqual([]);
    // Junction 11's leg 21 is 14.9 units to node 21, where the road bends on as segment 22.
    const beyond = orientedPolyline(doc, doc.segment(22 as SegmentId)!, 21 as NodeId).sampleAt(3).p;
    expect(new JunctionSurface(net, 11 as NodeId).contains(beyond)).toBe(true);
  });

  it('includes the strip the drawn surface lays across a curved mouth', () => {
    const { doc, net, defects } = built('curved-mouth-strip-missing-from-turn-surface');
    expect(defects).toEqual([]);
    const node = 1 as NodeId;
    const surface = new JunctionSurface(net, node);
    for (const id of doc.node(node)!.incident) {
      const ribbon = net.ribbons.get(id)!;
      const seg = doc.segment(id)!;
      const trim = (seg.a === node ? net.trims.get(id)!.a : net.trims.get(id)!.b)[Level.Asphalt]!;
      const strip = mouthOverlapStrip(ribbon.full, halfWidth(ribbon.road, Level.Asphalt) * 0.95,
        seg.a === node ? trim : ribbon.full.length - trim);
      for (const p of strip ?? []) expect(surface.contains(p)).toBe(true);
    }
  });
});
