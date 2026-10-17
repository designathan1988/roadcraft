import { AREA_EPS, validOutline, overlapArea, roofPartFits } from './footprints';
import { hypot2 } from '@core/hypot';
import type { Aabb } from '@core/aabb';
import type { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';
import { pointInPolygon } from '@core/polygon';
import { insideWorld } from '../bounds';
import type { ChangeRect } from '../changes';
import type { RoadDoc } from '../doc';
import type { NodeId, SegmentId } from '../ids';
import type { Network } from '../network';
import { Level, type RoadType, type SurfaceLevel, halfWidth } from '../roadTypes';
import type { RoadStructure } from '../structures';
import { m } from '../units';
import { MAX_ELEMENT, MIN_ELEMENT, elementClash, groundElements } from './elements';
import { MAX_PLINTH, type GroundAt, sampleFootprint } from './foundation';
import {
  MIN_SIZE,
  buildingBounds,
  footprintRects,
  groundProjections,
  groundVolumes,
  isSupported,
  sideLength,
} from './geometry';
import {
  type Building,
  type BuildingId,
  MAX_ELEMENTS,
  MAX_TERRACE,
  MAX_LIFT,
  MAX_MODULE,
  MAX_PITCH,
  MAX_PROJECTION,
  MAX_RECESS,
  MAX_SIZE,
  MIN_PITCH,
  MAX_STOREYS,
  MAX_STOREY_HEIGHT,
  MAX_GROUND_HEIGHT,
  MAX_VOLUMES,
  MIN_MODULE,
  MIN_STOREY_HEIGHT,
} from './types';
import { identityMemo } from '@core/identityMemo';
import { type NeighbourSource, ringBox, storeNeighbours } from './neighbours';

/** Why a building cannot stand where it is. */
export type BuildingProblem =
  | 'cut'
  | 'setback'
  | 'roofSpace'
  | 'outline'
  | 'size'
  | 'overlap'
  | 'support'
  | 'footprint'
  | 'bounds'
  | 'road'
  | 'building'
  | 'slope';

export interface SiteContext {
  readonly doc: RoadDoc;
  /** Null skips the road test (a headless check with no network built). */
  readonly net: Network | null;
  /** Null skips the slope test. */
  readonly groundAt: GroundAt | null;
  /** The paving's height (footways, carriageways), NaN off it: the street floor a grown building takes. */
  readonly pavedAt?: (x: number, y: number) => number;
}

/** A road as the checks read it: its profile's widths and its whole centreline (`SegmentRibbon`). */
export interface RoadReachRibbon {
  readonly id: SegmentId;
  readonly road: Pick<RoadType, 'width' | 'sidewalk'>;
  readonly full: Polyline;
}

/** A junction's kerb ring as the checks read it (`core/ring.ts` `Ring`). */
export interface JunctionRing {
  readonly isEmpty: boolean;
  readonly bbox: Aabb;
  flatten(): readonly Vec2[];
}

/** What a check of a building against the roads reads of the network (`touchesRoad`, the growth's corner test): the roads and junctions filed by place, each road's centreline and widths, each junction's kerb ring, each road's structure. `Network` is one; the growth's worker keeps another, of the same numbers, for the places it grows on (`editor/growthReplica.ts`). */
export interface RoadReach {
  readonly doc: { segment(id: SegmentId): { readonly structure: RoadStructure } | undefined };
  readonly segmentCells: { idsMeeting(rect: ChangeRect): readonly SegmentId[] };
  readonly ribbons: { get(id: SegmentId): RoadReachRibbon | undefined };
  readonly junctionCells: { idsMeeting(rect: ChangeRect): readonly NodeId[] };
  readonly junctions: { get(node: NodeId): { get(level: SurfaceLevel): { readonly ring: JunctionRing } | undefined } | undefined };
  /** The roads filed over `rect`, in increasing id order (`Network.ribbonsMeeting`). */
  ribbonsMeeting(rect: ChangeRect): readonly RoadReachRibbon[];
}

/** What a check of a building on its site reads: the buildings round it, the roads, the ground. The document's (`siteOf` a `SiteContext`) on the page; the growth's worker's own off it (`editor/growthReplica.ts`). */
export interface SiteReads {
  readonly neighbours: NeighbourSource;
  /** Null skips the road test. */
  readonly net: RoadReach | null;
  /** Null skips the slope test. */
  readonly groundAt: GroundAt | null;
  /** The paving's height, NaN off it (a grown building's street floor). */
  readonly pavedAt?: (x: number, y: number) => number;
}

/** The document's site as the checks read it. */
export function siteOf(ctx: SiteContext): SiteReads {
  return { neighbours: storeNeighbours(ctx.doc.buildings), net: ctx.net, groundAt: ctx.groundAt, ...(ctx.pavedAt ? { pavedAt: ctx.pavedAt } : {}) };
}

/** Nothing the player builds may come closer than this to the world's reach (`bounds.ts` WORLD_HALF): there is no map rim. */
const BUILDING_WORLD_MARGIN = m(3.2);
/** Gap kept between a footprint and the back of a footway: next to nothing. */
export const ROAD_CLEARANCE = m(0.008);
/** How far two buildings' volumes may run into each other at a shared party wall, world units (20 cm). */
const PARTY_WALL = m(0.2);
/** Only floating-point noise at an exactly touching road edge, never a visible overlap. */
const ROAD_CONTACT_EPS = 1e-9;
/** Area a footprint may share with a junction's carriageway and kerb and still only touch it, square units (0.16 m2) */
const JUNCTION_TOUCH = m(0.4) * m(0.4);
/** Overlap two footprints may have and still count as touching (terraces). */
const TOUCH = m(0.02);

/** Structural checks: need no world at all. */
export function structuralProblem(b: Building): BuildingProblem | null {
  if (!(b.module >= MIN_MODULE - 1e-9 && b.module <= MAX_MODULE + 1e-9)) return 'size';
  if (!(b.groundHeight >= MIN_STOREY_HEIGHT - 1e-9 && b.groundHeight <= MAX_GROUND_HEIGHT + 1e-9)) return 'size';
  for (const h of [b.storeyHeight, ...(b.levels ?? []).slice(1).filter((x): x is number => typeof x === 'number')]) {
    if (!(h >= MIN_STOREY_HEIGHT - 1e-9 && h <= MAX_STOREY_HEIGHT + 1e-9)) return 'size';
  }
  const first = b.levels?.[0];
  if (typeof first === 'number' && !(first >= MIN_STOREY_HEIGHT - 1e-9 && first <= MAX_GROUND_HEIGHT + 1e-9)) return 'size';
  if (b.volumes.length === 0 || b.volumes.length > MAX_VOLUMES) return 'size';
  for (const v of b.volumes) {
    if (v.outline && !validOutline(v.outline)) return 'outline';
    if ((v.roofDetails?.length ?? 0) > 32 || v.roofDetails?.some((detail) => !roofPartFits(v, detail))) return 'size';
    if (![v.x, v.y, v.w, v.d].every(Number.isFinite)) return 'size';
    if (v.w < MIN_SIZE - 1e-6 || v.d < MIN_SIZE - 1e-6 || v.w > MAX_SIZE + 1e-6 || v.d > MAX_SIZE + 1e-6) return 'size';
    if (!Number.isInteger(v.base) || v.base < 0) return 'size';
    if (v.storeys.length < 1 || v.base + v.storeys.length > MAX_STOREYS) return 'size';
    if (v.pitch !== undefined && !(v.pitch >= MIN_PITCH && v.pitch <= MAX_PITCH)) return 'size';
    // A block at a floor of its own (a split level): a built block, a storey or so either way.
    if (v.lift !== undefined && (v.open || !Number.isFinite(v.lift) || Math.abs(v.lift) > MAX_LIFT + 1e-6)) return 'size';
    // A drive's ramp: a lot's surface, within a terrace's reach of the floor.
    if (v.ramp !== undefined && (!v.open || !Number.isFinite(v.ramp) || Math.abs(v.ramp) > MAX_TERRACE + 1e-6)) return 'size';
    for (const r of v.reliefs ?? []) {
      if (r.side < 0 || r.side >= (v.outline?.length ?? 4)) return 'size';
      if (!Number.isFinite(r.depth) || r.depth > MAX_PROJECTION + 1e-6 || r.depth < -MAX_RECESS - 1e-6) return 'size';
      // A recess leaves at least a metre of the volume behind it.
      const across = sideLength(v, r.side === 0 || r.side === 2 ? 1 : 0);
      if (r.depth < 0 && -r.depth > across - MIN_SIZE / 2) return 'size';
    }
    for (const [faceKey, geometry] of Object.entries(v.facadeGeometry ?? {})) {
      if (!geometry) return 'size';
      const face = Number(faceKey);
      if (!Number.isInteger(face) || face < 0 || face >= (v.outline?.length ?? 4)) return 'size';
      if (geometry.bays !== undefined && (!Number.isInteger(geometry.bays) || geometry.bays < 1 || geometry.bays > 64)) return 'size';
      for (const ratio of [geometry.windowWidth, geometry.windowHeight])
        if (ratio !== undefined && (!Number.isFinite(ratio) || ratio < .15 || ratio > .95)) return 'size';
      for (const length of [geometry.sill, geometry.pierWidth, geometry.pierDepth])
        if (length !== undefined && (!Number.isFinite(length) || length < 0 || length > MAX_PROJECTION)) return 'size';
      if (geometry.pierEvery !== undefined && (!Number.isInteger(geometry.pierEvery) || geometry.pierEvery < 1 || geometry.pierEvery > 16)) return 'size';
    }
  }
  // Blocks may stand in each other's space: a building is blocks put together like bricks, and what is drawn is their union.
  if (groundVolumes(b).length === 0) return 'footprint';
  for (const v of b.volumes) if (!isSupported(b, v)) return 'support';
  const elements = b.elements ?? [];
  if (elements.length > MAX_ELEMENTS) return 'size';
  for (const e of elements) {
    // Below the floor only as far as a terrace of the lot goes (a flight down to a lower yard).
    if (![e.x, e.y, e.w, e.d, e.z, e.h].every(Number.isFinite) || e.z < -MAX_TERRACE - 1e-6) return 'size';
    if (Math.min(e.w, e.d, e.h) < MIN_ELEMENT - 1e-6 || Math.max(e.w, e.d, e.h) > MAX_ELEMENT + 1e-6) return 'size';
    // Parts meet the volumes; they never stand inside them.
    if (elementClash(b, e)) return 'overlap';
  }
  return null;
}

/** The box round several rings. */
function ringsBox(rings: readonly (readonly Vec2[])[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    const r = ringBox(ring);
    minX = Math.min(minX, r.minX); minY = Math.min(minY, r.minY); maxX = Math.max(maxX, r.maxX); maxY = Math.max(maxY, r.maxY);
  }
  return { minX, minY, maxX, maxY };
}

/** The first reason `b` cannot stand, or null; `ignore` is the building being edited (not its own obstacle). */
export function validateBuilding(
  ctx: SiteContext,
  b: Building,
  ignore?: BuildingId | readonly BuildingId[],
): BuildingProblem | null {
  return validateOn(siteOf(ctx), b, ignore);
}

/** `validateBuilding` on a site as the checks read it (`SiteReads`): the page's document, or the growth's worker's. */
export function validateOn(
  ctx: SiteReads,
  b: Building,
  ignore?: BuildingId | readonly BuildingId[],
): BuildingProblem | null {
  // One building (an edit of it) or several (the neighbours a weld is about to absorb): not obstacles to what is checked.
  const ignored = ignore === undefined ? undefined : Array.isArray(ignore) ? new Set(ignore) : new Set([ignore as BuildingId]);
  const structural = structuralProblem(b);
  if (structural) return structural;

  const box = buildingBounds(b);
  // On the world: the plates of the ground are one plane, so a building may stand across the line between two of them.
  if (!insideWorld({ x: box.minX, y: box.minY }, BUILDING_WORLD_MARGIN) || !insideWorld({ x: box.maxX, y: box.maxY }, BUILDING_WORLD_MARGIN)) return 'bounds';

  const rects = [...footprintRects(b, -TOUCH), ...groundProjections(b, -TOUCH), ...groundElements(b, -TOUCH)];
  const party = [...footprintRects(b, -PARTY_WALL), ...groundProjections(b, -TOUCH), ...groundElements(b, -TOUCH)];
  if (ctx.net && rects.some((rect) => touchesRoad(ctx.net as RoadReach, rect))) return 'road';

  // DO NOT ask over `buildingBounds` alone
  const reach = ringsBox(party.concat(rects));
  const partyBoxes = party.map(ringBox);
  for (const other of ctx.neighbours.near(reach.minX - MAX_PROJECTION, reach.minY - MAX_PROJECTION,
    reach.maxX + MAX_PROJECTION, reach.maxY + MAX_PROJECTION)) {
    if (other.id === b.id || ignored?.has(other.id)) continue;
    const ob = other.reach;
    if (ob.minX > reach.maxX || ob.maxX < reach.minX || ob.minY > reach.maxY || ob.maxY < reach.minY) continue;
    // What it puts on the ground, worked out once per record (`neighbours.ts`).
    const others = other.obstacles;
    // Two buildings may share a party wall: volumes shrunk by `PARTY_WALL`, clipped only where their boxes meet.
    for (let i = 0; i < party.length; i++) {
      const a = party[i]!, pa = partyBoxes[i]!;
      for (const { ring: c, box: pc } of others) {
        if (pa.minX > pc.maxX || pa.maxX < pc.minX || pa.minY > pc.maxY || pa.maxY < pc.minY) continue;
        if (overlapArea(a, c) > AREA_EPS) return 'building';
      }
    }
  }

  if (ctx.groundAt) {
    // Each block's ground about its own floor: a split level stepping down its hillside
    const { levelLowest, levelHighest } = sampleFootprint(b, ctx.groundAt);
    if (levelHighest - levelLowest > MAX_PLINTH) return 'slope';
  }
  return null;
}

/** DO NOT go back to a grid of every road and junction of the map made again at each network revision (`RoadContacts`) */
export function touchesRoad(net: RoadReach, rect: readonly Vec2[]): boolean {
  const box = boundsOf(rect);
  const area: readonly [number, number, number, number] = [box.minX, box.minY, box.maxX, box.maxY];
  for (const id of net.segmentCells.idsMeeting(area)) {
    const ribbon = net.ribbons.get(id);
    if (!ribbon || net.doc.segment(id)?.structure === 'tunnel') continue;
    const reach = halfWidth(ribbon.road, Level.Sidewalk) + ROAD_CLEARANCE;
    const bb = ribbon.full.bbox;
    if (bb.minX - reach > box.maxX || bb.maxX + reach < box.minX || bb.minY - reach > box.maxY || bb.maxY + reach < box.minY) continue;
    if (polylineDistance(lineOf(ribbon), rect) < reach - ROAD_CONTACT_EPS) return true;
  }
  for (const node of net.junctionCells.idsMeeting(area)) {
    // The carriageway and kerb of the junction, not its footway plate.
    const junction = net.junctions.get(node)?.get(Level.Curb);
    if (!junction || junction.ring.isEmpty) continue;
    const jb = junction.ring.bbox;
    if (jb.minX > box.maxX || jb.maxX < box.minX || jb.minY > box.maxY || jb.maxY < box.minY) continue;
    const ring = ringOf(junction.ring);
    if (polygonsOverlap(ring, rect) && overlapArea(ring, rect) > JUNCTION_TOUCH) return true;
  }
  return false;
}

/** A road's full centreline as points, once per ribbon (ribbons are never changed, only replaced). */
const lineOf = identityMemo((ribbon: RoadReachRibbon): readonly Vec2[] => ribbon.full.toPoints());

/** A junction's kerb ring as points, once per ring (a junction solved again is a new one). */
const ringOf = identityMemo((ring: JunctionRing): readonly Vec2[] => ring.flatten());

// ------------------------------------------------------------------ geometry

function boundsOf(points: readonly Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return hypot2(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Shortest distance from an open polyline to a closed polygon (0 inside). */
function polylineDistance(line: readonly Vec2[], polygon: readonly Vec2[]): number {
  for (const p of line) if (pointInPolygon(p, polygon)) return 0;
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i] as Vec2;
    const b = line[i + 1] as Vec2;
    for (let k = 0; k < polygon.length; k++) {
      const c = polygon[k] as Vec2;
      const d = polygon[(k + 1) % polygon.length] as Vec2;
      if (segmentsCross(a, b, c, d)) return 0;
      best = Math.min(best, pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
    }
  }
  return best;
}

/** Whether two simple polygons overlap (share interior area, roughly). */
function polygonsOverlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  for (const p of a) if (pointInPolygon(p, b)) return true;
  for (const p of b) if (pointInPolygon(p, a)) return true;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as Vec2;
    const q = a[(i + 1) % a.length] as Vec2;
    for (let k = 0; k < b.length; k++) {
      if (segmentsCross(p, q, b[k] as Vec2, b[(k + 1) % b.length] as Vec2)) return true;
    }
  }
  return false;
}
