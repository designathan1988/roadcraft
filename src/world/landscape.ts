import type { Vec2 } from '@core/vec2';
import type { Network, SegmentRibbon } from './network';
import type { NodeId, SegmentId } from './ids';
import type { RoadSide, RoadType } from './roadTypes';
import { m } from './units';
import { travelShift } from './roadTypes';
import { CROSSWALK_DEPTH } from './approach';
import { carriesPedestrians } from './pedestrianAccess';
import { BENCH_ZONE, LAMP_ZONE, MIN_THROUGH, TREE_KERB_SETBACK, TREE_PIT, sectionOf, zonesOn } from './section';

/** Street landscaping the PLAYER places */

export const LANDSCAPE_KINDS = ['tree', 'shrub', 'bench', 'bin', 'lamp', 'hydrant', 'postbox', 'phone', 'drain', 'meadow', 'sign', 'streetname'] as const;
export type LandscapeKind = (typeof LANDSCAPE_KINDS)[number];

export interface LandscapeItem {
  readonly id: number;
  readonly kind: LandscapeKind;
  readonly x: number;
  readonly y: number;
  /** A sign's type (`SIGN_TYPES`). */
  readonly signType?: SignType;
  /** What a sign says, or a street's name. */
  readonly text?: string;
  /** When a plant was planted, in city minutes (`City.minutes`, `sim/city/city.ts`); absent: fully grown. */
  readonly planted?: number;
}

/** City minutes a planted tree or shrub takes to reach its full size: three days. */
export const GROW_MINUTES = 3 * 1440;
/** The size a plant is planted at, as a share of its full size. */
const PLANTED_SIZE = 0.3;

/** A plant's size now, as a share of its full size: planted small, grown over `GROW_MINUTES`. */
export function plantGrowth(planted: number | undefined, now: number): number {
  if (planted === undefined || !Number.isFinite(now)) return 1;
  const t = Math.max(0, Math.min(1, (now - planted) / GROW_MINUTES));
  return PLANTED_SIZE + (1 - PLANTED_SIZE) * (t * t * (3 - 2 * t));
}

/** The signs the one sign tool makes (the player's order of 2026-10-05) */
export const SIGN_TYPES = ['stop', 'yield', 'speed', 'noParking', 'noEntry', 'pedestrian', 'school', 'direction', 'street', 'info'] as const;
export type SignType = (typeof SIGN_TYPES)[number];
export function isSignType(value: unknown): value is SignType {
  return typeof value === 'string' && (SIGN_TYPES as readonly string[]).includes(value);
}
/** Signs whose plate shows the player's text. */
export const SIGN_HAS_TEXT: ReadonlySet<SignType> = new Set<SignType>(['speed', 'direction', 'street', 'info']);
/** The longest text a sign or a street name keeps. */
export const SIGN_TEXT_MAX = 40;

export function isLandscapeKind(value: unknown): value is LandscapeKind {
  return typeof value === 'string' && (LANDSCAPE_KINDS as readonly string[]).includes(value);
}

/** Plan radius of each kind, for spacing and for anyone walking round it. */
export const LANDSCAPE_RADIUS: Readonly<Record<LandscapeKind, number>> = {
  tree: TREE_PIT / 2,
  shrub: m(0.35),
  bench: Math.hypot(m(0.9), m(0.26)),
  bin: m(0.33),
  lamp: m(0.13),
  hydrant: m(0.16),
  postbox: m(0.33),
  phone: m(0.45),
  drain: m(0.5),
  meadow: m(2),
  sign: m(0.15),
  streetname: m(1),
};

/** The least clear distance kept between two placed items, besides their radii. */
const ITEM_GAP = m(0.4);

/** Where a point lies on the footways: the road, the station along it and the side. */
export interface FootwayHit {
  readonly segment: SegmentId;
  readonly road: RoadType;
  /** Station along the ribbon's full centreline. */
  readonly s: number;
  /** +1 left of the segment's a -> b direction, -1 right. */
  readonly side: 1 | -1;
  /** Distance of the point from the centreline. */
  readonly across: number;
  readonly frame: { readonly p: Vec2; readonly t: Vec2; readonly n: Vec2 };
}

/** The ribbons a point within `reach` of a road's surface can be on */
function ribbonsNear(net: Network, at: Vec2, reach: number): Iterable<SegmentRibbon> {
  return net.ribbonsMeeting([at.x - reach, at.y - reach, at.x + reach, at.y + reach]);
}

/** The footway a point stands on, or, with `reach`, the nearest one within that distance of the footway's own band. */
export function footwayAt(net: Network, at: Vec2, reach = 0): FootwayHit | null {
  let best: FootwayHit | null = null;
  let bestMiss = Infinity;
  const hit = { s: 0, distance: 0 };
  for (const ribbon of ribbonsNear(net, at, reach)) {
    const road = ribbon.road;
    if (!carriesPedestrians(road) || road.sidewalk <= 0) continue;
    const segment = net.doc.segment(ribbon.id);
    if (!segment) continue;
    const box = ribbon.full.bbox;
    const pad = road.width / 2 + road.sidewalk + reach;
    if (at.x < box.minX - pad || at.x > box.maxX + pad || at.y < box.minY - pad || at.y > box.maxY + pad) continue;
    ribbon.full.closestInto(at.x, at.y, hit);
    // The side the point is on, and that side's own footway (an asymmetric road).
    const atFrame = ribbon.full.sampleAt(hit.s);
    const onLeft = (at.x - atFrame.p.x) * atFrame.n.x + (at.y - atFrame.p.y) * atFrame.n.y >= 0;
    const zones = zonesOn(sectionOf(road, segment.direction), onLeft ? 'left' : 'right');
    const inner = zones.curb.outer;
    const outer = zones.frontage.outer;
    const length = ribbon.full.length;
    // Not past the mouths: the corner of a junction belongs to no one leg.
    const lo = net.mouthDistance(ribbon.id, segment.a);
    const hi = length - net.mouthDistance(ribbon.id, segment.b);
    if (hit.s < lo - 1e-6 || hit.s > hi + 1e-6) continue;
    const miss = hit.distance < inner ? inner - hit.distance : hit.distance > outer ? hit.distance - outer : 0;
    if (miss > reach || miss >= bestMiss) continue;
    bestMiss = miss;
    best = { segment: ribbon.id, road, s: hit.s, side: onLeft ? 1 : -1, across: hit.distance, frame: atFrame };
  }
  return best;
}

/** A planted median a point stands on: trees and shrubs go there too. */
export interface MedianHit {
  readonly segment: SegmentId;
  readonly s: number;
  /** The median's centre at the station. */
  readonly centre: Vec2;
  readonly frame: { readonly p: Vec2; readonly t: Vec2; readonly n: Vec2 };
}

/** Narrowest median a tree is planted in: its pit and a kerb's width each side. */
const MEDIAN_TREE_MIN = m(1.5);

/** Whether a road's median takes plants: wide enough, kerbed (not painted flush), not paved. */
export function plantedMedian(road: RoadType): boolean {
  const material = road.materials?.median;
  return road.median >= MEDIAN_TREE_MIN - 1e-6 && !road.medianFlush && (material === undefined || material === 'grass');
}

/** Room left between a crossing's far edge and a median island's nose, world units. */
const MEDIAN_NOSE_GAP = m(0.5);

/** How far from `node` along the segment its median island begins: past the crossing there */
export function medianNose(net: Network, segment: SegmentId, node: NodeId): number {
  const crossing = net.crosswalkDistanceAt(segment, node);
  const behindCrossing = crossing > 0 ? crossing + CROSSWALK_DEPTH / 2 + MEDIAN_NOSE_GAP : 0;
  // A U-turn's opening (retorno)
  const at = net.doc.node(node);
  if (at?.uturn === undefined || at.incident.length !== 2) return behindCrossing;
  return Math.max(behindCrossing, segment === at.uturn ? MEDIAN_NOSE_GAP * 3 : MEDIAN_UTURN_OPENING);
}

/** How far each side of a U-turn's node its median opening runs: a car's half circle and half its length. */
export const MEDIAN_UTURN_OPENING = m(10);

/** The planted median under a point (within `reach` of its band), or null. */
export function medianAt(net: Network, at: Vec2, reach = 0): MedianHit | null {
  const hit = { s: 0, distance: 0 };
  for (const ribbon of ribbonsNear(net, at, reach)) {
    const road = ribbon.road;
    if (!plantedMedian(road)) continue;
    const segment = net.doc.segment(ribbon.id);
    if (!segment || segment.direction !== 'both') continue;
    const box = ribbon.full.bbox;
    const pad = road.width / 2 + reach;
    if (at.x < box.minX - pad || at.x > box.maxX + pad || at.y < box.minY - pad || at.y > box.maxY + pad) continue;
    ribbon.full.closestInto(at.x, at.y, hit);
    const lo = Math.max(net.mouthDistance(ribbon.id, segment.a), medianNose(net, ribbon.id, segment.a));
    const hi = ribbon.full.length - Math.max(net.mouthDistance(ribbon.id, segment.b), medianNose(net, ribbon.id, segment.b));
    if (hit.s < lo || hit.s > hi) continue;
    const frame = ribbon.full.sampleAt(hit.s);
    // The median is centred on the travel way's own centre (`travelShift`).
    const shift = travelShift(road);
    const centre = { x: frame.p.x + frame.n.x * shift, y: frame.p.y + frame.n.y * shift };
    const off = Math.abs((at.x - centre.x) * frame.n.x + (at.y - centre.y) * frame.n.y);
    if (off > road.median / 2 + reach) continue;
    return { segment: ribbon.id, s: hit.s, centre, frame };
  }
  return null;
}

/** How far out from the centreline each kind stands, inside the furnishing zone. */
function depthFor(kind: LandscapeKind, road: RoadType, direction: 'both' | 'aToB' | 'bToA', side: RoadSide = 'right'): number | null {
  const zones = zonesOn(sectionOf(road, direction), side);
  const zone = zones.furnishing;
  const depth = zone.outer - zone.inner;
  if (depth <= 0) return null;
  switch (kind) {
    case 'lamp':
    case 'hydrant':
    case 'sign':
      return zone.inner + Math.min(LAMP_ZONE, depth) / 2;
    // A telephone booth is no column: placed as one, half a lamp's depth off the kerb, its box stood 0.27 m over it.
    case 'phone':
      if (depth < 2 * LANDSCAPE_RADIUS.phone - 1e-9) return null;
      return zone.inner + LANDSCAPE_RADIUS.phone;
    // A kerb inlet ("boca de lobo"): its mouth is IN the kerb, its grate in the gutter in front
    case 'drain':
      return zone.inner + m(0.05);
    // Long grass is placed on open ground and a street's name on the street itself (`snapLandscape`), never by depth.
    case 'meadow':
    case 'streetname':
      return null;
    case 'tree': {
      // A pit beside the kerb, so long as the walkers keep their through width behind it: a 2 m footway takes one
      const footway = zones.frontage.outer - zone.inner;
      if (footway - TREE_KERB_SETBACK - TREE_PIT < MIN_THROUGH - 1e-6) return null;
      return zone.inner + TREE_KERB_SETBACK + TREE_PIT / 2;
    }
    case 'shrub':
      return zone.inner + depth / 2;
    case 'bench':
    case 'bin':
    case 'postbox':
      if (depth < BENCH_ZONE - 1e-9) return null;
      return zone.inner + BENCH_ZONE / 2;
  }
}

type LandscapeRefusal = 'offFootway' | 'narrow' | 'occupied' | 'crossing';

/** The landing of a crossing on the footways: kept clear of everything. */
export interface CrossingAccess {
  readonly x: number;
  readonly y: number;
  readonly tx: number;
  readonly ty: number;
  readonly across: number;
  readonly structure: string;
}

/** Every crossing's approach, including its landing on each footway. */
const accessMemo = new WeakMap<Network, { revision: number; trafficRevision: number; list: CrossingAccess[] }>();
export function crossingAccesses(net: Network): CrossingAccess[] {
  // Asked once per item placed: the city generator places thousands (V7).
  const known = accessMemo.get(net);
  if (known && known.revision === net.revision && known.trafficRevision === net.trafficRevision) return known.list;
  const list = crossingAccessesNow(net);
  accessMemo.set(net, { revision: net.revision, trafficRevision: net.trafficRevision, list });
  return list;
}
function crossingAccessesNow(net: Network): CrossingAccess[] {
  return crossingAccessesAt(net, net.doc.nodes.keys());
}

/** DO NOT work a landing out here again. */
export function crossingAccessesAt(net: Network, nodes: Iterable<NodeId>): CrossingAccess[] {
  const out: CrossingAccess[] = [];
  for (const nodeId of nodes) {
    const node = net.doc.node(nodeId);
    if (!node || node.incident.length < 2) continue;
    for (const segmentId of node.incident) {
      const landing = net.crossingLandingAt(segmentId, nodeId);
      if (landing) out.push(landing);
    }
  }
  return out;
}

/** Whether something of `radius` at a point of `segment`'s footway stands in a crossing's landing. */
export function onCrossingAccess(
  net: Network, accesses: readonly CrossingAccess[], segment: SegmentId, x: number, y: number, radius: number,
): boolean {
  const structure = net.doc.segment(segment)?.structure ?? 'ground';
  return accesses.some((access) => {
    if (structure !== access.structure) return false;
    const dx = x - access.x, dy = y - access.y;
    return Math.abs(dx * access.tx + dy * access.ty) < CROSSWALK_DEPTH / 2 + m(0.3) + radius &&
      Math.abs(-dx * access.ty + dy * access.tx) < access.across + radius;
  });
}

/** How far from a point a crossing's landing can reach it, besides the item's own radius */
export const ACCESS_REACH = m(40);

/** DO NOT test against `crossingAccesses(net)` (every landing of the map) for one point. */
export function nearCrossingAccess(net: Network, segment: SegmentId, x: number, y: number, radius: number): boolean {
  const r = ACCESS_REACH + radius;
  const nodes = new Set<NodeId>();
  for (const ribbon of net.ribbonsMeeting([x - r, y - r, x + r, y + r])) {
    const s = net.doc.segment(ribbon.id);
    if (s) { nodes.add(s.a); nodes.add(s.b); }
  }
  if (nodes.size === 0) return false;
  return onCrossingAccess(net, crossingAccessesAt(net, [...nodes].sort((a, b) => a - b)), segment, x, y, radius);
}

/** The side of the cells `crossingAccessTester` files the landings in. */
const ACCESS_CELL = m(32);

/** `onCrossingAccess` for many items against the same landings */
export function crossingAccessTester(net: Network, accesses: readonly CrossingAccess[]): (segment: SegmentId, x: number, y: number, radius: number) => boolean {
  const cells = new Map<string, CrossingAccess[]>();
  let reach = 0;
  for (const a of accesses) {
    reach = Math.max(reach, Math.hypot(CROSSWALK_DEPTH / 2 + m(0.3), a.across));
    const key = `${Math.floor(a.x / ACCESS_CELL)},${Math.floor(a.y / ACCESS_CELL)}`;
    const list = cells.get(key);
    if (list) list.push(a); else cells.set(key, [a]);
  }
  return (segment, x, y, radius) => {
    const r = reach + radius * Math.SQRT2;
    const near: CrossingAccess[] = [];
    for (let cx = Math.floor((x - r) / ACCESS_CELL); cx <= Math.floor((x + r) / ACCESS_CELL); cx++) {
      for (let cy = Math.floor((y - r) / ACCESS_CELL); cy <= Math.floor((y + r) / ACCESS_CELL); cy++) near.push(...(cells.get(`${cx},${cy}`) ?? []));
    }
    return near.length > 0 && onCrossingAccess(net, near, segment, x, y, radius);
  };
}

export type LandscapeSnap =
  | { readonly ok: true; readonly at: Vec2; readonly hit: FootwayHit | null; readonly median?: MedianHit }
  | { readonly ok: false; readonly at: Vec2; readonly reason: LandscapeRefusal };

/** Where an item of `kind` put at `at` would stand, or why it cannot. */
export function snapLandscape(
  net: Network,
  items: Iterable<LandscapeItem>,
  kind: LandscapeKind,
  at: Vec2,
  reach: number,
): LandscapeSnap {
  if (kind === 'streetname') {
    // A street's name is put on the street: its signs stand at the corners.
    if (!onAnyRoad(net, at)) return { ok: false, at, reason: 'offFootway' };
    return { ok: true, at, hit: null };
  }
  if (kind === 'meadow') {
    // A clump of long grass goes on open ground, never on a street.
    if (footwayAt(net, at, m(1)) || onAnyRoad(net, at)) return { ok: false, at, reason: 'offFootway' };
    for (const other of items) {
      if (other.kind === 'meadow' && apart(other, at) < m(2.5)) return { ok: false, at, reason: 'occupied' };
    }
    return { ok: true, at, hit: null };
  }
  const hit = footwayAt(net, at, reach);
  // A tree or a shrub in a planted median, on its centre line (V7).
  const median = !hit && (kind === 'tree' || kind === 'shrub') ? medianAt(net, at, Math.min(reach, m(1))) : null;
  if (median) {
    const radius = LANDSCAPE_RADIUS[kind];
    for (const other of items) {
      const clear = radius + LANDSCAPE_RADIUS[other.kind] + ITEM_GAP;
      if (apart(other, median.centre) < clear) return { ok: false, at: median.centre, reason: 'occupied' };
    }
    return { ok: true, at: median.centre, hit: null, median };
  }
  if (!hit) return { ok: false, at, reason: 'offFootway' };
  const segment = net.doc.requireSegment(hit.segment);
  const depth = depthFor(kind, hit.road, segment.direction, hit.side > 0 ? 'left' : 'right');
  if (depth === null) return { ok: false, at, reason: 'narrow' };
  const placed = {
    x: hit.frame.p.x + hit.frame.n.x * depth * hit.side,
    y: hit.frame.p.y + hit.frame.n.y * depth * hit.side,
  };
  const radius = LANDSCAPE_RADIUS[kind];
  if (nearCrossingAccess(net, hit.segment, placed.x, placed.y, radius)) {
    return { ok: false, at: placed, reason: 'crossing' };
  }
  for (const other of items) {
    const clear = radius + LANDSCAPE_RADIUS[other.kind] + ITEM_GAP;
    if (apart(other, placed) < clear) return { ok: false, at: placed, reason: 'occupied' };
  }
  return { ok: true, at: placed, hit };
}

/** The placed item nearest a point, within `radius`. */
function landscapeNear(items: Iterable<LandscapeItem>, at: Vec2, radius: number): LandscapeItem | null {
  let best: LandscapeItem | null = null;
  let bestD = radius;
  for (const item of items) {
    const d = apart(at, item) - LANDSCAPE_RADIUS[item.kind];
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

/** The largest radius of a placed item (`LANDSCAPE_RADIUS`). */
/** The widest item's radius: what a search round a point grows by to meet every item reaching it. */
export const MAX_ITEM_RADIUS = Math.max(...Object.values(LANDSCAPE_RADIUS));

/** DO NOT hand `doc.landscape.values()` to `landscapeNear` for one point: every item of the map, every move. */
export function landscapeNearIn(doc: { landscapeIn(rect: readonly [number, number, number, number]): LandscapeItem[] }, at: Vec2, radius: number): LandscapeItem | null {
  const r = radius + MAX_ITEM_RADIUS;
  return landscapeNear(doc.landscapeIn([at.x - r, at.y - r, at.x + r, at.y + r]), at, radius);
}

/** Whether a point is on any street's paving (carriageway, kerb or footway). */
function onAnyRoad(net: Network, at: Vec2): boolean {
  for (const ribbon of ribbonsNear(net, at, m(1))) {
    if (ribbon.full.distanceTo(at) < ribbon.road.width / 2 + ribbon.road.sidewalk + m(1)) return true;
  }
  return false;
}

/** How far `a` is from `b`. */
function apart(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
