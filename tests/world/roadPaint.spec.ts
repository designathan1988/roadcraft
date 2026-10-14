import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { approachLegends, segmentMarkings, type StrokeSpec } from '@world/markings';
import { catalogRoads } from '@world/roads/catalog';
import { derivedSigns } from '@world/roads/derivedSigns';
import { markingStyle } from '@world/roads/markingStyle';
import { applyProfile } from '@world/roads/profile';
import { LANE_LINE, sectionFromProfile, travelWidth } from '@world/roadTypes';
import { m } from '@world/units';

/**
 * THE ROAD PAINT AND THE SIGNS (docs/source/VIAS.md V6): the map's regional standard
 * (MBST vol. IV for Brazil), the bus lane's legend, the junction rule's floor
 * legends and its plates, and the speed plates. A map saved before keeps its
 * paint ('classic').
 */
function cross(type = 1, length = m(120)): { doc: RoadDoc; net: Network; centre: NodeId; legs: SegmentId[] } {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  for (const degrees of [0, 90, 180, 270]) {
    const a = (degrees * Math.PI) / 180;
    const far = doc.addNode({ x: Math.cos(a) * length, y: Math.sin(a) * length });
    doc.addSegment(centre.id, far.id, type);
  }
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, centre: centre.id, legs: [...doc.segments.keys()].sort((a, b) => a - b) as SegmentId[] };
}

const centreStrokes = (specs: StrokeSpec[], colour: string): StrokeSpec[] => specs.filter((s) => s.color === colour && s.width >= m(0.12) && s.width <= m(0.16));

/** Distance from a point to a segment's centreline and the share along it (0 at a). */
function along(net: Network, seg: SegmentId, p: { x: number; y: number }): { off: number; s: number } {
  const line = net.polylines.get(net.doc, seg);
  const s = line.closestPoint(p).s;
  const f = line.sampleAt(s);
  return { off: (p.x - f.p.x) * f.n.x + (p.y - f.p.y) * f.n.y, s };
}

describe('the map paint standard', () => {
  it('a map saved before the standards opens classic and saves without the field; a new one keeps its own', () => {
    const { doc } = cross();
    const json = doc.toJSON();
    expect('markingStyle' in json).toBe(false);
    expect(RoadDoc.fromJSON(json).markingStyle).toBe('classic');
    doc.setMarkingStyle('br');
    expect(RoadDoc.fromJSON(doc.toJSON()).markingStyle).toBe('br');
    expect(RoadDoc.fromJSON({ ...doc.toJSON(), markingStyle: 'nonsense' }).markingStyle).toBe('classic');
  });

  it('classic paints exactly what the game painted before', () => {
    const { net } = cross();
    for (const ribbon of net.ribbons.values()) {
      expect(segmentMarkings(ribbon, 0, 0, 0, 'classic')).toEqual(segmentMarkings(ribbon, 0, 0, 0));
    }
  });

  it('Brazil: yellow between the directions, the dash and gap by the speed (1:2 under 60 km/h, 1:3 above)', () => {
    const br = markingStyle('br');
    expect(br.dash(30)).toEqual([m(3), m(6)]);
    expect(br.dash(60)).toEqual([m(3), m(9)]);
    expect(br.dash(80)).toEqual([m(4), m(12)]);
    const { net } = cross(1);
    const ribbon = [...net.ribbons.values()][0]!;
    const specs = segmentMarkings(ribbon, 0, 0, 0, 'br');
    const centre = centreStrokes(specs, br.centre!);
    expect(centre.length).toBe(1);
    expect(centre[0]!.dash).toEqual([m(3), m(6)]);
  });

  it('a double solid centre line, as the section says', () => {
    const { doc, net, legs } = cross(1);
    const seg = doc.segment(legs[0]!)!;
    doc.setSegmentSection(seg.id, { ...sectionFromProfile(net.ribbons.get(seg.id)!.road), centreLine: 'double' });
    net.rebuild();
    const specs = segmentMarkings(net.ribbons.get(seg.id)!, 0, 0, 0, 'br');
    const centre = specs.filter((s) => s.color === markingStyle('br').centre && s.dash === null);
    expect(centre.length).toBe(2);
  });
});

describe('the bus lane legend', () => {
  it('ÔNIBUS painted in every bus lane, inside the lane, every so often', () => {
    const road = catalogRoads().find((r) => r.id === 'catalog:avenueBusSide')!;
    const { doc, net, legs } = cross(road.type, m(160));
    const applied = applyProfile(road.profile, road.type);
    for (const id of legs) {
      doc.setSegmentLanes(id, applied.lanes);
      doc.setSegmentSection(id, applied.section);
    }
    net.rebuild();
    const ribbon = net.ribbons.get(legs[0]!)!;
    const plain = segmentMarkings(ribbon, 0, 0, 0, 'br');
    const word = plain.filter((s) => s.color === LANE_LINE && Math.abs(s.width - m(0.2)) < 1e-9);
    // Two bus lanes (one each way), at least two legends each along 400 units.
    expect(word.length).toBeGreaterThan(20);
    const half = travelWidth(ribbon.road) / 2;
    for (const stroke of word) {
      for (const p of stroke.points) {
        const { off } = along(net, ribbon.id, p);
        // In the outer lanes: away from the middle, never past the kerb.
        expect(Math.abs(off)).toBeLessThan(half);
        expect(Math.abs(off)).toBeGreaterThan(half / 2);
      }
    }
  });
});

describe('the junction rule, painted and signed', () => {
  it('stop on every leg: PARE before each stop line, a stop plate on the right of each leg, facing the driver', () => {
    const { doc, net, centre, legs } = cross(1);
    doc.setMarkingStyle('br');
    expect(approachLegends(net, 'br')).toEqual([]);
    expect(derivedSigns(net).filter((s) => s.type !== 'speed')).toEqual([]);
    doc.setNodeControl(centre, 'stop');
    net.rebuild();
    const legends = approachLegends(net, 'br');
    expect(legends.length).toBeGreaterThan(0);
    for (const id of legs) {
      const stopAt = net.stopLineDistance(id, centre);
      const mine = legends.filter((l) => l.points.every((p) => {
        const a = along(net, id, p);
        return a.s > 0 && Math.abs(a.off) < travelWidth(net.ribbons.get(id)!.road) / 2;
      }));
      expect(mine.length, `leg ${id}`).toBeGreaterThan(0);
      for (const l of mine) for (const p of l.points) {
        const a = along(net, id, p);
        // Before the stop line as the driver comes, on the arriving half: the
        // traffic coming back along a leg drawn out of the centre keeps right, +n.
        expect(a.s).toBeGreaterThan(stopAt);
        expect(a.off).toBeGreaterThan(0);
      }
    }
    const plates = derivedSigns(net).filter((s) => s.type === 'stop');
    expect(plates.length).toBe(4);
    for (const plate of plates) {
      const a = along(net, plate.segment, plate);
      // Outside the carriageway, on the arriving traffic's right (+n of a leg drawn out of the centre).
      expect(a.off).toBeGreaterThan(travelWidth(net.ribbons.get(plate.segment)!.road) / 2);
      // Facing out along the leg: at the driver coming in.
      const f = net.polylines.get(doc, plate.segment).sampleAt(a.s);
      expect(plate.facing.x * f.t.x + plate.facing.y * f.t.y).toBeGreaterThan(0.9);
    }
  });

  it('signs on each leg: the main road unsigned, the side roads a give-way plate and triangle', () => {
    const { doc, net, centre, legs } = cross(1);
    doc.setSegmentType(legs[0]!, 3);
    doc.setSegmentType(legs[2]!, 3);
    doc.setNodeControl(centre, 'priority');
    net.rebuild();
    const plates = derivedSigns(net).filter((s) => s.type !== 'speed');
    expect(plates.map((p) => [p.segment, p.type]).sort()).toEqual([[legs[1], 'yield'], [legs[3], 'yield']].sort());
    expect(approachLegends(net, 'br').length).toBeGreaterThan(0);
  });

  it('speed plates only on a map painted to a standard, saying the road limit', () => {
    const { doc, net } = cross(1);
    expect(derivedSigns(net).filter((s) => s.type === 'speed')).toEqual([]);
    doc.setMarkingStyle('br');
    net.rebuild();
    const speed = derivedSigns(net).filter((s) => s.type === 'speed');
    // Every leg, leaving the junction (the dead ends start a road too).
    expect(speed.length).toBe(8);
    expect(new Set(speed.map((s) => s.text))).toEqual(new Set(['50']));
  });
});
