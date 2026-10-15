import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { commitPoleRun, onFootway, planPoleRun, snapPole } from '@editor/poles';
import { m } from '@world/units';
import { DEFAULT_POLE_SPACING, poleArms } from '@world/utilities';
import { roadProfile } from '@world/roadTypes';
import { LAMP_ZONE, sectionOf } from '@world/section';
import { footwayAt } from '@world/landscape';
import type { PoleId, SpanId } from '@world/ids';
import type { UtilityPole, UtilitySpan } from '@world/utilities';
import { TUNED_UNIT } from '@world/units';

/** The 0.4 m unit these scenes were laid out in: lengths below in it, times U. */
const U = TUNED_UNIT;

/** The wire tool, judged by what it BUILDS (the player's order of 2026-10-05) */

function street(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -400 * U, y: 0 });
  const b = doc.addNode({ x: 400 * U, y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** Two streets meeting at a corner: west to the corner, then north. */
function corner(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const w = doc.addNode({ x: -400 * U, y: 0 });
  const c = doc.addNode({ x: 0, y: 0 });
  const n = doc.addNode({ x: 0, y: 400 * U });
  doc.addSegment(w.id, c.id, 1);
  doc.addSegment(c.id, n.id, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** Distance from the road centreline of the line the poles stand on. */
function poleLine(doc: RoadDoc): number {
  const seg = [...doc.segments.values()][0]!;
  const zone = sectionOf(roadProfile(seg.type, seg.lanes, seg.direction), seg.direction).side.furnishing;
  return zone.inner + Math.min(LAMP_ZONE, Math.max(zone.outer - zone.inner, 0.5 * U)) / 2;
}

describe('pole snapping', () => {
  it('pulls a pole onto the footway of the road it was aimed at', () => {
    const { doc, net } = street();
    const want = poleLine(doc);
    const snap = snapPole(doc, net, { x: 0, y: want + 2 * U }, 20 * U);
    expect(snap.kind).toBe('footway');
    expect(Math.abs(snap.at.y)).toBeCloseTo(want, 2);
    expect(snap.at.x).toBeCloseTo(0, 4);
  });

  it('keeps the side the player aimed at', () => {
    const { doc, net } = street();
    const want = poleLine(doc);
    expect(snapPole(doc, net, { x: 100 * U, y: want + 2 * U }, 20 * U).at.y).toBeGreaterThan(0);
    expect(snapPole(doc, net, { x: 100 * U, y: -want - 2 * U }, 20 * U).at.y).toBeLessThan(0);
  });

  it('does not take open ground', () => {
    const { doc, net } = street();
    expect(snapPole(doc, net, { x: 0, y: 600 * U }, 20 * U).kind).toBe('free');
  });

  it('takes an existing pole over the footway under it', () => {
    const { doc, net } = street();
    const want = poleLine(doc);
    const standing = doc.addPole({ x: 120 * U, y: want });
    const snap = snapPole(doc, net, { x: 126 * U, y: want + 2 * U }, 30 * U);
    expect(snap.kind).toBe('pole');
    expect(snap.pole).toBe(standing.id);
  });
});

describe('pole runs', () => {
  it('refuses a run with an end off the footways, and builds nothing', () => {
    const { doc, net } = street();
    const want = poleLine(doc);
    const plan = planPoleRun(doc, net, { x: -200 * U, y: want }, { x: 200 * U, y: 600 * U }, 20 * U);
    expect(plan.refused).toBe('offFootway');
    expect(commitPoleRun(doc, plan)).toBe(false);
    expect(doc.poles.size).toBe(0);
  });

  it('keeps every pole of a run on the footway line, however the drag wanders', () => {
    const { doc, net } = street();
    const want = poleLine(doc);
    const plan = planPoleRun(doc, net, { x: -300 * U, y: want + 1 * U }, { x: 300 * U, y: want + 6 * U }, 20 * U);
    expect(plan.refused).toBeUndefined();
    expect(plan.poles.length).toBeGreaterThan(2);
    for (const pole of plan.poles) {
      expect(Math.abs(pole.at.y - want)).toBeLessThan(1e-3);
      expect(footwayAt(net, pole.at)).not.toBeNull();
    }
  });

  it('spaces poles the way a line is spaced, both ends included', () => {
    const { doc, net } = street();
    const want = poleLine(doc);
    const plan = planPoleRun(doc, net, { x: 0, y: want }, { x: 300 * U, y: want }, 20 * U);
    expect(plan.poles[0]!.at.x).toBeCloseTo(0, 3);
    expect(plan.poles[plan.poles.length - 1]!.at.x).toBeCloseTo(300 * U, 3);
    for (let i = 1; i < plan.poles.length; i++) {
      const step = plan.poles[i]!.at.x - plan.poles[i - 1]!.at.x;
      expect(step).toBeGreaterThan(DEFAULT_POLE_SPACING * 0.5);
      expect(step).toBeLessThan(DEFAULT_POLE_SPACING * 1.5);
    }
  });

  it('turns the corner along the footways instead of cutting across the block', () => {
    const { doc, net } = corner();
    const want = poleLine(doc);
    // The inside of the corner: south of the west street... no, NORTH of it, and WEST of the north street
    const plan = planPoleRun(doc, net, { x: -300 * U, y: want }, { x: -want, y: 300 * U }, 20 * U);
    expect(plan.refused).toBeUndefined();
    for (const pole of plan.poles) {
      // On the pavement: never in the block's interior, never on the asphalt of the corner's kerb return...
      expect(onFootway(net, pole.at), `${pole.at.x.toFixed(1)}, ${pole.at.y.toFixed(1)}`).toBe(true);
      // ...and a kerb's depth behind it all the way round.
      const kerbLine = Math.min(Math.abs(pole.at.y - want), Math.abs(pole.at.x + want));
      const onCorner = pole.at.x > -want - 40 * U && pole.at.y < want + 40 * U;
      if (!onCorner) expect(kerbLine).toBeLessThan(1e-2);
    }
    // One pole at the corner, not two or three a few metres apart.
    for (let i = 1; i < plan.poles.length; i++) {
      const a = plan.poles[i - 1]!.at, b = plan.poles[i]!.at;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(m(9));
    }
    // ...and every span between them short: none jumps the block.
    for (let i = 1; i < plan.poles.length; i++) {
      const a = plan.poles[i - 1]!.at, b = plan.poles[i]!.at;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(DEFAULT_POLE_SPACING * 1.5);
    }
  });

  it('continues an existing line through the pole it ends on', () => {
    const { doc, net } = street();
    const want = poleLine(doc);
    const first = planPoleRun(doc, net, { x: -300 * U, y: want }, { x: 0, y: want }, 20 * U);
    commitPoleRun(doc, first);
    const afterFirst = doc.poles.size;
    const end = first.poles[first.poles.length - 1]!.at;
    const second = planPoleRun(doc, net, end, { x: 300 * U, y: want }, 20 * U);
    expect(second.poles[0]!.existing).not.toBeNull();
    commitPoleRun(doc, second);
    expect(doc.poles.size).toBe(afterFirst + second.poles.length - 1);
    const joinId = second.poles[0]!.existing;
    expect([...doc.poleSpans.values()].filter((s) => s.a === joinId || s.b === joinId)).toHaveLength(2);
  });

  it('lights the poles as the tool is set: none, every other, all', () => {
    const { doc, net } = street();
    const want = poleLine(doc);
    const lit = (mode: 'none' | 'alternate' | 'all'): boolean[] =>
      planPoleRun(doc, net, { x: -300 * U, y: want }, { x: 300 * U, y: want }, 20 * U, DEFAULT_POLE_SPACING, mode).poles.map((p) => p.lamp);
    expect(lit('none').every((l) => !l)).toBe(true);
    expect(lit('all').every((l) => l)).toBe(true);
    expect(lit('alternate')).toEqual(lit('alternate').map((_, i) => i % 2 === 0));
  });
});

describe('cross-arms', () => {
  const line = (points: [number, number][]): { poles: Map<PoleId, UtilityPole>; spans: Map<SpanId, UtilitySpan> } => {
    const poles = new Map<PoleId, UtilityPole>();
    const spans = new Map<SpanId, UtilitySpan>();
    points.forEach(([x, y], i) => poles.set((i + 1) as PoleId, { id: (i + 1) as PoleId, x, y, lamp: false }));
    for (let i = 1; i < points.length; i++) spans.set(i as SpanId, { id: i as SpanId, a: i as PoleId, b: (i + 1) as PoleId });
    return { poles, spans };
  };
  const angle = (v: { x: number; y: number }): number => (Math.atan2(v.y, v.x) * 180) / Math.PI;

  it('lies square to a straight line on every pole of it, not just the ends', () => {
    const { poles, spans } = line([[0, 0], [40, 0], [80, 0], [120, 0]]);
    for (const arms of poleArms(poles, spans).values()) {
      expect(arms.arms).toHaveLength(1);
      expect(Math.abs(arms.arms[0]!.x)).toBeLessThan(1e-9);
    }
  });

  it('lies on the bisector of a small bend', () => {
    // A 30 degree bend at the middle pole.
    const turn = (30 * Math.PI) / 180;
    const { poles, spans } = line([[-40, 0], [0, 0], [40 * Math.cos(turn), 40 * Math.sin(turn)]]);
    const middle = poleArms(poles, spans).get(2 as PoleId)!;
    expect(middle.arms).toHaveLength(1);
    // The bisector of the angle at the pole points at 105 (or -75) degrees.
    const a = ((angle(middle.arms[0]!) % 180) + 180) % 180;
    expect(a).toBeCloseTo(105, 6);
  });

  it('gives each line its own arm at a right-angle corner', () => {
    const { poles, spans } = line([[-40, 0], [0, 0], [0, 40]]);
    const middle = poleArms(poles, spans).get(2 as PoleId)!;
    expect(middle.arms).toHaveLength(2);
    expect(Math.abs(middle.bySpan.get(1 as SpanId)!.x)).toBeLessThan(1e-9);
    expect(Math.abs(middle.bySpan.get(2 as SpanId)!.y)).toBeLessThan(1e-9);
  });

  it('turns both ends of a span to the same side, so its wires never cross', () => {
    const { poles, spans } = line([[0, 0], [40, 0], [80, 10], [120, 10]]);
    const framing = poleArms(poles, spans);
    for (const span of spans.values()) {
      const a = framing.get(span.a)!.bySpan.get(span.id)!;
      const b = framing.get(span.b)!.bySpan.get(span.id)!;
      expect(a.x * b.x + a.y * b.y).toBeGreaterThan(0);
    }
  });
});
