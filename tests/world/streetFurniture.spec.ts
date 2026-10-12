import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { Level, halfWidth } from '@world/roadTypes';
import { TREE_PIT, streetFurniture } from '@world/streetFurniture';
import { roadProfile } from '@world/roadTypes';
import { sectionOf } from '@world/section';
import { LANDSCAPE_KINDS, footwayAt, snapLandscape } from '@world/landscape';

/**
 * Nothing on a street is generated (the player's order of 2026-10-05): the
 * footways carry exactly what the player placed with the landscaping tool,
 * each item in the furnishing zone beside the kerb, and nowhere else.
 */

function crossroads(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  const north = doc.addNode({ x: 0, y: -520 });
  const south = doc.addNode({ x: 0, y: 520 });
  const west = doc.addNode({ x: -520, y: 0 });
  const east = doc.addNode({ x: 520, y: 0 });
  doc.addSegment(north.id, centre.id, 3);
  doc.addSegment(centre.id, south.id, 2);
  doc.addSegment(west.id, centre.id, 1);
  doc.addSegment(centre.id, east.id, 0);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** A point on the footway of the east leg, `along` from the centre, on the north side. */
function onEastFootway(net: Network, along: number): { x: number; y: number } {
  const seg = [...net.doc.segments.values()].find((s) => s.type === 0)!;
  const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking);
  return { x: along, y: -(rt.width / 2 + rt.sidewalk / 2) };
}

describe('street furniture', () => {
  it('generates nothing: a new street has no lamps, trees, benches or shrubs', () => {
    const { net } = crossroads();
    expect(streetFurniture(net)).toEqual([]);
  });

  it('places every kind on a footway, in the furnishing zone beside the kerb', () => {
    const { doc, net } = crossroads();
    // Long grass is planted on open ground, never on a street (`snapLandscape`);
    // everything else is the street's furniture.
    const onFootway = LANDSCAPE_KINDS.filter((kind) => kind !== 'meadow');
    expect(snapLandscape(net, [], 'meadow', onEastFootway(net, 100), 4)).toMatchObject({ ok: false, reason: 'offFootway' });
    expect(snapLandscape(net, [], 'meadow', { x: 300, y: 300 }, 4).ok).toBe(true);
    let x = 120;
    for (const kind of onFootway) {
      const snap = snapLandscape(net, doc.landscape.values(), kind, onEastFootway(net, x), 4);
      expect(snap.ok, `${kind}: ${snap.ok ? '' : snap.reason}`).toBe(true);
      if (snap.ok) doc.addLandscape(kind, snap.at);
      x += 30;
    }
    const items = streetFurniture(net);
    // Signs and street names stand on the footway too, but are drawn as signs
    // (`render/signs.ts`), not as furniture the walkers go round.
    expect(items).toHaveLength(onFootway.filter((kind) => kind !== 'sign' && kind !== 'streetname').length);
    for (const item of items) {
      const seg = net.doc.requireSegment(item.segment);
      const zone = sectionOf(roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking), seg.direction).side.furnishing;
      const across = net.ribbons.get(item.segment)!.full.distanceTo({ x: item.x, y: item.y });
      const half = item.halfWidth ?? item.radius;
      // A kerb inlet's mouth is in the kerb and its grate in the gutter in
      // front: it stands at the kerb, not inside the furnishing zone.
      if (item.kind === 'drain') expect(Math.abs(across - zone.inner), item.kind).toBeLessThan(half);
      else expect(across - half, item.kind).toBeGreaterThanOrEqual(zone.inner - 1e-6);
      if (item.kind !== 'streetTree') expect(across + half, item.kind).toBeLessThanOrEqual(zone.outer + 1e-6);
      expect(Math.hypot(item.outward.x, item.outward.y)).toBeCloseTo(1, 6);
    }
  });

  it('keeps a tree pit between the kerb and the back of the footway', () => {
    const { doc, net } = crossroads();
    const snap = snapLandscape(net, doc.landscape.values(), 'tree', onEastFootway(net, 200), 4);
    expect(snap.ok).toBe(true);
    if (snap.ok) doc.addLandscape('tree', snap.at);
    const tree = streetFurniture(net).find((item) => item.kind === 'streetTree')!;
    const ribbon = net.ribbons.get(tree.segment)!;
    const across = ribbon.full.closestPoint(tree).distance;
    expect(across - TREE_PIT / 2).toBeGreaterThanOrEqual(halfWidth(ribbon.road, Level.Curb) - 1e-6);
    expect(across + TREE_PIT / 2).toBeLessThanOrEqual(halfWidth(ribbon.road, Level.Sidewalk) + 1e-6);
  });

  it('refuses the carriageway, open ground and a spot already taken', () => {
    const { doc, net } = crossroads();
    expect(snapLandscape(net, [], 'bench', { x: 200, y: 0 }, 2)).toMatchObject({ ok: false, reason: 'offFootway' });
    expect(snapLandscape(net, [], 'tree', { x: 300, y: 300 }, 2)).toMatchObject({ ok: false, reason: 'offFootway' });
    const first = snapLandscape(net, [], 'bin', onEastFootway(net, 250), 4);
    expect(first.ok).toBe(true);
    if (first.ok) doc.addLandscape('bin', first.at);
    expect(snapLandscape(net, doc.landscape.values(), 'bench', onEastFootway(net, 250.5), 4))
      .toMatchObject({ ok: false, reason: 'occupied' });
  });

  it('is not listed once its footway is gone, and comes back with it', () => {
    const { doc, net } = crossroads();
    const snap = snapLandscape(net, [], 'lamp', onEastFootway(net, 300), 4);
    if (!snap.ok) throw new Error('lamp refused');
    doc.addLandscape('lamp', snap.at);
    expect(footwayAt(net, snap.at)).not.toBeNull();
    const east = [...doc.segments.values()].find((s) => s.type === 0)!;
    doc.removeSegment(east.id);
    net.rebuild();
    expect(streetFurniture(net)).toEqual([]);
    expect(doc.landscape.size).toBe(1);
  });

  it('round-trips through the saved map and undo', () => {
    const { doc, net } = crossroads();
    const snap = snapLandscape(net, [], 'shrub', onEastFootway(net, 150), 4);
    if (!snap.ok) throw new Error('shrub refused');
    doc.addLandscape('shrub', snap.at);
    const copy = RoadDoc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect([...copy.landscape.values()]).toEqual([...doc.landscape.values()]);
    const before = doc.utilityRevision;
    const empty = RoadDoc.fromJSON({ ...doc.toJSON(), landscape: [] });
    doc.replaceWith(empty);
    expect(doc.landscape.size).toBe(0);
    expect(doc.utilityRevision).toBeGreaterThan(before);
  });
});
