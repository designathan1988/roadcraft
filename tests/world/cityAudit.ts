import type { Vec2 } from '@core/vec2';
import { area as polyArea, intersection, type MultiPoly } from '@core/clipper';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { METERS_PER_UNIT, m } from '@world/units';
import { applyLots, planLots, type Lot } from '@world/lots';
import { planCity, DEFAULT_CITY, type CityOptions, type CityPlan } from '@world/cityGen/plan';
import { layCity, zoneCity } from '@editor/cityGenerator';
import { growOnLot } from '@editor/zoning';
import { levelPolygons } from '@world/surfaces';
import { Level } from '@world/roadTypes';
import { roofRise, volumeCorners, levelElevation } from '@world/buildings/geometry';
import type { Building, BuildingId, Volume } from '@world/buildings/types';

/**
 * A GENERATED CITY, grown and audited as the player looks at it (the
 * player, 2026-10-09, on seed 20261009: lots over the streets, buildings run into each other, giant lean-to wedges, blank walls,
 * rows of twins, a sixth of the lots left bare). Shared by the specs that
 * guard each of those classes, and by the probe in the browser.
 */

export interface GrownCity { doc: RoadDoc; net: Network; plan: CityPlan; zoned: number }

/** The city as `main.ts` `generateCity` makes it, on flat land, grown to the end. */
export function growCity(options: Partial<CityOptions>): GrownCity {
  const plan = planCity({ ...DEFAULT_CITY, ...options });
  const doc = layCity(plan);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  const zoned = zoneCity(doc, plan);
  const refused = new Set<number>();
  for (let guard = 0; guard < zoned * 3 + 50; guard++) {
    const id = growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed);
    if (id === null) {
      const open = doc.lots.some((l) => l.use && (l.building === undefined || !doc.buildings.has(l.building as BuildingId)) && !refused.has(l.id));
      if (!open) break;
    }
  }
  return { doc, net, plan, zoned };
}

const M2 = METERS_PER_UNIT * METERS_PER_UNIT;
const ring = (pts: readonly Vec2[]): MultiPoly => [[pts.map((p) => [p.x, p.y])]] as MultiPoly;
const box = (pts: readonly Vec2[]): [number, number, number, number] => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return [x0, y0, x1, y1];
};
const boxesMeet = (a: readonly number[], b: readonly number[]): boolean => a[0]! <= b[2]! && a[2]! >= b[0]! && a[1]! <= b[3]! && a[3]! >= b[1]!;
const overlapM2 = (a: readonly Vec2[], b: readonly Vec2[]): number => Math.abs(polyArea(intersection(ring(a), ring(b)))) * M2;

/** The lots: on the paving, over each other, too big. */
export function auditLots(city: GrownCity): { lots: number; onPaving: number; overlapping: number; huge: number; maxArea: number; worstPaving: number } {
  const { doc, net } = city;
  const paving = levelPolygons(net, Level.Sidewalk).map((poly) => ({ poly, box: box(poly[0]!.map(([x, y]) => ({ x: x!, y: y! }))) }));
  let onPaving = 0, overlapping = 0, huge = 0, maxArea = 0, worstPaving = 0;
  const boxes = doc.lots.map((l) => box(l.corners));
  doc.lots.forEach((l, i) => {
    const b = boxes[i]!;
    const near = paving.filter((p) => boxesMeet(p.box, b)).map((p) => p.poly);
    const over = near.length ? Math.abs(polyArea(intersection(ring(l.corners), near))) * M2 : 0;
    worstPaving = Math.max(worstPaving, over);
    if (over > 3) onPaving++;
    const a = Math.abs(polyArea(ring(l.corners))) * M2;
    maxArea = Math.max(maxArea, a);
    if (a > 2400) huge++;
    for (let j = i + 1; j < doc.lots.length; j++) {
      if (!boxesMeet(b, boxes[j]!)) continue;
      if (overlapM2(l.corners, doc.lots[j]!.corners) > 1) overlapping++;
    }
  });
  return { lots: doc.lots.length, onPaving, overlapping, huge, maxArea, worstPaving };
}

const solidRings = (b: Building, grow = 0): Vec2[][] => b.volumes.filter((v) => !v.open && v.mode !== 'void').map((v) => volumeCorners(b, v, grow));

/** The buildings: bare zoned lots, buildings run into each other or out of their lots. */
export function auditBuildings(city: GrownCity): { zoned: number; bare: number; built: number; clashes: number; outOfLot: number; worstOut: number } {
  const { doc } = city;
  const zonedLots = doc.lots.filter((l) => l.use);
  const lotOf = new Map<number, Lot>();
  for (const l of zonedLots) if (l.building !== undefined && doc.buildings.has(l.building as BuildingId)) lotOf.set(l.building, l);
  const bare = zonedLots.length - lotOf.size;
  const all = [...doc.buildings.all()];
  const rings = all.map((b) => solidRings(b, -m(0.06)));
  const boxes = rings.map((r) => box(r.flat()));
  let clashes = 0;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    if (!rings[i]!.length || !rings[j]!.length || !boxesMeet(boxes[i]!, boxes[j]!)) continue;
    if (rings[i]!.some((a) => rings[j]!.some((c) => overlapM2(a, c) > 0.05))) clashes++;
  }
  let outOfLot = 0, worstOut = 0;
  for (const b of all) {
    const lot = lotOf.get(b.id);
    if (!lot) continue;
    let out = 0;
    for (const r of solidRings(b, -m(0.06))) out += Math.abs(polyArea(ring(r))) * M2 - overlapM2(r, lot.corners);
    worstOut = Math.max(worstOut, out);
    if (out > 0.5) outOfLot++;
  }
  return { zoned: zonedLots.length, bare, built: lotOf.size, clashes, outOfLot, worstOut };
}

/**
 * The masses: a roof rising more than its walls are tall or more than a
 * real roof does (a lean-to "from the ground to the top"), and works halls
 * out of a hall's proportion.
 */
export function auditForms(city: GrownCity): { wildRoofs: number; badHalls: number; examples: string[] } {
  let wildRoofs = 0, badHalls = 0;
  const examples: string[] = [];
  for (const b of city.doc.buildings.all()) {
    for (const v of b.volumes as Volume[]) {
      if (v.open || v.roof === 'flat' || v.roof === 'terrace') continue;
      const rise = roofRise(b, v) * METERS_PER_UNIT;
      const wall = (levelElevation(b, v.base + v.storeys.length) - levelElevation(b, v.base)) * METERS_PER_UNIT;
      // A lean-to or a sawtooth tooth: a couple of metres at most; a gable or a hip: about a storey.
      const limit = v.roof === 'shed' || v.roof === 'sawtooth' ? Math.min(2.2, Math.max(1.2, wall * 0.4)) : Math.min(4.5, Math.max(3.2, wall * 0.9));
      if (rise > limit + 0.05) { wildRoofs++; if (examples.length < 8) examples.push(`telhado ${v.roof} sobe ${rise.toFixed(1)} m sobre ${wall.toFixed(1)} m: ${b.function} ${b.id}`); }
    }
    if (b.use === 'industrial') {
      const hall = [...b.volumes].filter((v) => !v.open).sort((p, q) => q.w * q.d - p.w * p.d)[0];
      if (hall) {
        const h = (levelElevation(b, hall.base + hall.storeys.length) - levelElevation(b, hall.base)) * METERS_PER_UNIT;
        if (h < 5.5 || h > 12) { badHalls++; if (examples.length < 8) examples.push(`galpão de ${h.toFixed(1)} m`); }
      }
    }
  }
  return { wildRoofs, badHalls, examples };
}
