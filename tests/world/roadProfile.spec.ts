import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import { Level, ROAD_TYPES, footwayOn, roadProfile } from '@world/roadTypes';
import { flipSection, normalizeRoadSection } from '@world/roadSection';
import { type RoadProfileSpec, applyProfile, profileOf, profileProblems, profileRoad } from '@world/roads/profile';
import { classTemplates, normalizeTemplate } from '@world/roads/templates';
import { sectionOf } from '@world/section';
import { buildWalkways } from '@world/walkways';
import { m } from '@world/units';
import { applyProfileTo } from '@editor/roads/profile';
import { footwayRiseShare } from '@world/roads/footwayRise';
import { FLAT_GROUND, buildRoadElevation } from '@world/elevation';
import { checkWorld } from '../fuzz/support/invariants';
import { openCategories } from '../fuzz/support/runner';

/**
 * THE ROAD PROFILE (docs/VIAS.md V1): an ordered cross-section that turns into
 * the segment's own fields, read back the same; asymmetric footways cut into
 * the outline, the junctions, the walking lines and the furniture zones of
 * each side; problems named before anything is built.
 */
const withFootways = (p: RoadProfileSpec, left: number, right: number, extra: { flushLeft?: boolean; flushRight?: boolean } = {}): RoadProfileSpec => {
  const last = p.elements.length - 1;
  return { ...p, elements: p.elements.map((e, i) => (e.kind !== 'footway' ? e
    : { ...e, width: i === 0 ? left : right, ...((i === 0 ? extra.flushLeft : i === last && extra.flushRight) ? { flush: true } : {}) })) };
};

describe('road profile', () => {
  it('reads a class road as its elements, left edge to right edge', () => {
    const p = profileOf({ type: 2, lanes: null, direction: 'both' });
    expect(p.elements.map((e) => e.kind)).toEqual(['footway', 'lane', 'lane', 'lane', 'lane', 'footway']);
    expect(p.elements.filter((e) => e.kind === 'lane').map((e) => (e as { dir: string }).dir)).toEqual(['backward', 'backward', 'forward', 'forward']);
    const boulevard = profileOf({ type: 3, lanes: null, direction: 'both' });
    expect(boulevard.elements.map((e) => e.kind)).toContain('median');
  });

  it('builds back the same road it was read from', () => {
    for (let type = 0; type < ROAD_TYPES.length; type++) {
      const source = { type, lanes: null, direction: ROAD_TYPES[type]!.lanes === 1 ? 'aToB' as const : 'both' as const };
      const stock = roadProfile(type, null, source.direction);
      const built = profileRoad(profileOf(source), type);
      expect(built.width).toBeCloseTo(stock.width, 9);
      expect(built.lanes).toBe(stock.lanes);
      expect(built.sidewalk).toBe(stock.sidewalk);
      expect(built.median).toBe(stock.median);
    }
  });

  it('carries different footways on its two sides', () => {
    const p = withFootways(profileOf({ type: 1, lanes: null, direction: 'both' }), m(2), m(5));
    expect(profileProblems(p, 1)).toEqual([]);
    const applied = applyProfile(p);
    expect(applied.section!.sidewalkLeft).toBe(m(2));
    expect(applied.section!.sidewalkRight).toBe(m(5));
    expect(applied.section!.sidewalk).toBe(m(5));
    const rt = profileRoad(p, 1);
    expect(footwayOn(rt, 'left')).toBe(m(2));
    expect(footwayOn(rt, 'right')).toBe(m(5));
    // Read back, the same two sides.
    const back = profileOf({ type: 1, lanes: applied.lanes, direction: applied.direction, section: applied.section! });
    expect(back.elements[0]!.width).toBe(m(2));
    expect(back.elements[back.elements.length - 1]!.width).toBe(m(5));
  });

  it('names what it cannot build', () => {
    const base = profileOf({ type: 1, lanes: null, direction: 'both' });
    expect(profileProblems({ ...base, elements: base.elements.slice(1) }, 1)).toContain('footways');
    const lanes = base.elements.filter((e) => e.kind === 'lane');
    expect(profileProblems({ ...base, elements: [base.elements[0]!, ...lanes, { kind: 'lane', width: m(3), dir: 'forward' }, base.elements[3]!] }, 1))
      .toContain('laneBalance');
    expect(profileProblems({ ...base, elements: [base.elements[0]!, lanes[0]!, { kind: 'parking', width: m(2) }, lanes[1]!, base.elements[3]!] }, 1))
      .toContain('parkingSide');
    expect(profileProblems({ ...base, elements: [base.elements[0]!, { ...lanes[0]!, width: m(5) }, lanes[1]!, base.elements[3]!] }, 1))
      .toContain('laneWidths');
    expect(profileProblems({ ...base, elements: [base.elements[0]!, lanes[1]!, lanes[0]!, base.elements[3]!] }, 1)).toContain('order');
    expect(profileProblems({ ...base, elements: [base.elements[0]!, { kind: 'parking', width: m(2) }, ...lanes, base.elements[3]!] }, 4)).toContain('class');
  });

  it('turns round with its road: left and right change places', () => {
    const s = normalizeRoadSection({ laneWidth: m(3), sidewalk: m(4), sidewalkLeft: m(2), sidewalkRight: m(4), median: 0,
      speedKmh: 50, priority: 1, flushLeft: true, materials: { footwayLeft: 'stone' } })!;
    const f = flipSection(s)!;
    expect(f.sidewalkLeft).toBe(m(4));
    expect(f.sidewalkRight).toBe(m(2));
    expect(f.flushRight).toBe(true);
    expect(f.flushLeft).toBeUndefined();
    expect(f.materials?.footwayRight).toBe('stone');
    expect(flipSection(f)).toEqual(s);
  });

  it('offers the classes as templates and reads a saved one back only when it can be built', () => {
    const templates = classTemplates();
    expect(templates).toHaveLength(ROAD_TYPES.length);
    const mine = { id: 'user:1', name: 'Rua da feira', type: 1, profile: withFootways(templates[1]!.profile, m(3), m(6)) };
    expect(normalizeTemplate(JSON.parse(JSON.stringify(mine)))).toEqual(mine);
    expect(normalizeTemplate({ ...mine, profile: { ...mine.profile, elements: mine.profile.elements.slice(1) } })).toBeNull();
    expect(normalizeTemplate({ ...mine, type: 99 })).toBeNull();
    expect(normalizeTemplate({ ...mine, name: '' })).toBeNull();
  });
});

describe('an asymmetric road in the world', () => {
  /** A cross of two streets, the east-west one with a 2 m footway north (left of a -> b) and 5 m south. */
  function cross(): { doc: RoadDoc; net: Network; id: SegmentId } {
    const doc = new RoadDoc();
    const w = doc.addNode({ x: -300, y: 0 }), c = doc.addNode({ x: 0, y: 0 }), e = doc.addNode({ x: 300, y: 0 });
    const n = doc.addNode({ x: 0, y: 300 }), s = doc.addNode({ x: 0, y: -300 });
    doc.addSegment(w.id, c.id, 1);
    const id = doc.addSegment(c.id, e.id, 1)!.id;
    doc.addSegment(c.id, n.id, 1);
    doc.addSegment(c.id, s.id, 1);
    const net = new Network(doc);
    net.rebuild();
    const p = withFootways(profileOf(doc.requireSegment(id)), m(2), m(5));
    expect(applyProfileTo(doc, [id], p).changed).toBe(true);
    net.rebuild();
    return { doc, net, id };
  }

  it('cuts each side of its outline at its own footway', () => {
    const { net, id } = cross();
    const ring = net.ribbons.get(id)!.rings[Level.Sidewalk]!.flatten();
    const half = net.ribbons.get(id)!.road.width / 2;
    const ys = ring.map((p) => p.y);
    expect(Math.max(...ys)).toBeCloseTo(half + m(2), 6);
    expect(Math.min(...ys)).toBeCloseTo(-(half + m(5)), 6);
  });

  it('frames its junction leg with both widths', () => {
    const { net, id } = cross();
    const centre = net.doc.requireSegment(id).a;
    const leg = net.junctions.get(centre)!.get(Level.Sidewalk)!.legs.find((l) => l.seg === id)!;
    const half = net.ribbons.get(id)!.road.width / 2;
    // Leaving the centre eastwards, `+nrm` is north: the road's left.
    expect(leg.plusSide).toBe('left');
    expect(leg.hwLeft).toBeCloseTo(half + m(2), 6);
    expect(leg.hwRight).toBeCloseTo(half + m(5), 6);
  });

  it('keeps every world invariant the fuzzer checks', () => {
    const { doc, net } = cross();
    const open = openCategories();
    expect(checkWorld(doc, net).filter((d) => !open.has(d.category))).toEqual([]);
  });

  it('stands a flush footway level with the carriageway, and a kerbed one at its rise', () => {
    const { doc, net, id } = cross();
    const half = net.ribbons.get(id)!.road.width / 2;
    // Nothing flush yet: the rise everywhere.
    expect(footwayRiseShare(net, 150, half + m(1))).toBe(1);
    applyProfileTo(doc, [id], { ...profileOf(doc.requireSegment(id)), elements: profileOf(doc.requireSegment(id)).elements
      .map((e, i) => (i === 0 && e.kind === 'footway' ? { ...e, flush: true } : e)) });
    net.rebuild();
    expect(footwayRiseShare(net, 150, half + m(1))).toBe(0);
    expect(footwayRiseShare(net, 150, -(half + m(1)))).toBe(1);
    // A flush side has no kerb stone: its kerb level is the carriageway's edge.
    const curb = net.ribbons.get(id)!.rings[Level.Curb]!.flatten().map((p) => p.y);
    expect(Math.max(...curb)).toBeCloseTo(half, 6);
  });

  it('walks each footway down its own through zone', () => {
    const { net, id } = cross();
    const section = sectionOf(net.ribbons.get(id)!.road, 'both');
    expect(section.left.frontage.outer).toBeLessThan(section.right.frontage.outer);
    const ways = buildWalkways(net).ways.filter((w) => w.kind === 'footway' && w.segment === id);
    // The footways may be cut where crossings land on them: every piece lies on its side's line.
    const ys = ways.map((w) => w.path.sampleAt(w.path.length / 2).p.y);
    expect(Math.max(...ys)).toBeCloseTo((section.left.through.inner + section.left.through.outer) / 2, 6);
    expect(Math.min(...ys)).toBeCloseTo(-(section.right.through.inner + section.right.through.outer) / 2, 6);
  });
});

describe('paving round a bend', () => {
  it('keeps its size on the inside and the outside of a curve (no stretch)', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 }), b = doc.addNode({ x: 200, y: 200 });
    const id = doc.addSegment(a.id, b.id, 1, { t: 0.5, h: 60 })!.id;
    const net = new Network(doc);
    net.rebuild();
    const elevation = buildRoadElevation(net, FLAT_GROUND);
    const line = net.ribbons.get(id)!.full;
    const offset = 15;
    const at = (s: number): { x: number; y: number } => {
      const f = line.sampleAt(s);
      return { x: f.p.x + f.n.x * offset, y: f.p.y + f.n.y * offset };
    };
    const ratio = (panel?: number): number => {
      // Inside one panel (a joint lies at every multiple of 40).
      // Over several of the centreline's vertices, where the bend is, and
      // measured along the offset line itself.
      const s0 = Math.floor((line.length * 0.4) / 40) * 40 + 5, s1 = s0 + 30;
      let length = 0;
      for (let s = s0; s < s1; s += 0.5) { const p = at(s), q = at(s + 0.5); length += Math.hypot(q.x - p.x, q.y - p.y); }
      const p = at(s0), q = at(s1);
      const fp = elevation.surfaceFrameAt(p.x, p.y, undefined, p.x, p.y, true, undefined, panel);
      const fq = elevation.surfaceFrameAt(q.x, q.y, undefined, q.x, q.y, true, undefined, panel);
      return Math.abs(fq.along - fp.along) / length;
    };
    // Laid along the centreline the texture is stretched by the curvature...
    expect(Math.abs(ratio() - 1)).toBeGreaterThan(0.03);
    // ...laid at the true length of the line it is on, it is not.
    expect(ratio(40)).toBeCloseTo(1, 2);
  });
});
