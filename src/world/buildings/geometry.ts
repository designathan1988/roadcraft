import { identityMemo } from '@core/identityMemo';
import { steadyRatio } from '@core/scalar';
import type { Vec2 } from '@core/vec2';
import { pointInPolygon } from '@core/polygon';
import { TUNED_UNIT, m } from '../units';
import { localFootprint, edgeFrame, volumeSides, offsetRing, overlapArea, supportShare } from './footprints';
import {
  BAY_COMPONENTS,
  type BayComponent,
  type Building,
  type BuildingElement,
  type Relief,
  type FaceId,
  type Side,
  type Volume,
  componentAt,
  volumeTop,
} from './types';

/** Every spatial question about a building, answered from the record. */

/** The step every horizontal dimension snaps to in the editor: half a metre. */
export const GRID = m(0.5);
/** The smallest a volume may be on either side. */
export const MIN_SIZE = m(2);
/** Two lengths closer than this (0.04 mm) are the same one (shared walls, touching volumes). */
export const EPS = 1e-4 * TUNED_UNIT;

/** What a building's frame is read from: its origin and rotation (a worker is sent no more, `sim/agents/lotBays.ts`). */
type Frame = Pick<Building, 'x' | 'y' | 'rotation'>;

export function localToWorld(b: Frame, lx: number, ly: number): Vec2 {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  return { x: b.x + lx * c - ly * s, y: b.y + lx * s + ly * c };
}

/** DO NOT call `localToWorld` point by point in a building's loops */
export interface BuildingFrame {
  readonly x: number;
  readonly y: number;
  readonly c: number;
  readonly s: number;
}

export const buildingFrame = (b: Building): BuildingFrame => ({ x: b.x, y: b.y, c: Math.cos(b.rotation), s: Math.sin(b.rotation) });
/** World x of a local point, as `localToWorld` gives it. */
export const frameX = (f: BuildingFrame, lx: number, ly: number): number => f.x + lx * f.c - ly * f.s;
/** World y of a local point, as `localToWorld` gives it. */
export const frameY = (f: BuildingFrame, lx: number, ly: number): number => f.y + lx * f.s + ly * f.c;
export const frameToWorld = (f: BuildingFrame, lx: number, ly: number): Vec2 => ({ x: frameX(f, lx, ly), y: frameY(f, lx, ly) });
/** A world point in the building's frame, as `worldToLocal` gives it. */
export function frameToLocal(f: BuildingFrame, x: number, y: number): Vec2 {
  const dx = x - f.x;
  const dy = y - f.y;
  return { x: dx * f.c + dy * f.s, y: -dx * f.s + dy * f.c };
}

export function worldToLocal(b: Frame, p: Vec2): Vec2 {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  const dx = p.x - b.x;
  const dy = p.y - b.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

/** `worldToLocal` for a point the pointer gives (a click). */
export function worldToLocalAt(b: Building, p: Vec2): Vec2 {
  return worldToLocal(b, p);
}

/** A local direction turned into the world. */
export function localDirToWorld(b: Frame, dx: number, dy: number): Vec2 {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** Outward unit normal of a side, in the local frame. */
export const SIDE_NORMAL: Readonly<Record<Side, Vec2>> = {
  0: { x: 0, y: -1 },
  1: { x: 1, y: 0 },
  2: { x: 0, y: 1 },
  3: { x: -1, y: 0 },
};

// ------------------------------------------------------------------ levels

/** Height of level `L`, world units. */
export function levelHeight(b: Building, level: number): number {
  const custom = b.levels?.[level];
  if (typeof custom === 'number') return custom;
  return level === 0 ? b.groundHeight : b.storeyHeight;
}

/** Height of the floor of level `L` above the building's ground floor. */
export function levelElevation(b: Building, level: number): number {
  let z = 0;
  for (let i = 0; i < level; i++) z += levelHeight(b, i);
  return z;
}

/** Highest level any volume reaches (one past the top storey). */
export function topLevel(b: Building): number {
  let top = 0;
  for (const v of b.volumes) top = Math.max(top, volumeTop(v));
  return top;
}

/** Whether a volume has a storey on `level`. */
const occupiesLevel = (v: Volume, level: number): boolean => v.base <= level && level < volumeTop(v);

/** How far a block's own floor stands from the building's ground floor (`Volume.lift`). */
export const volumeLift = (v: Volume): number => v.lift ?? 0;

/** Height of the floor of a block's level `level` above the building's ground floor, its lift included. */
export const volumeElevation = (b: Building, v: Volume, level: number): number => volumeLift(v) + levelElevation(b, level);

/** The lift of the block a point of the plan is in, on `level`: where a floor's furniture, partitions and cores stand */
export function liftAt(b: Building, level: number, x: number, y: number): number {
  let best: Volume | null = null;
  for (const v of b.volumes) {
    if (v.open || !isMass(v) || !occupiesLevel(v, level)) continue;
    if (x < v.x - EPS || x > v.x + v.w + EPS || y < v.y - EPS || y > v.y + v.d + EPS) continue;
    if (!best || v.w * v.d < best.w * best.d) best = v;
  }
  return best ? volumeLift(best) : 0;
}

/** The heights a block stands against, above the building's ground floor: from its floor to its eaves */
function solidSpan(b: Building, o: Volume): [number, number] {
  const top = volumeElevation(b, o, volumeTop(o));
  return [o.base === 0 ? -Infinity : volumeElevation(b, o, o.base), top];
}

/** How much of storey `level` of block `v` another block `o` stands against, by height */
function standsAgainst(b: Building, o: Volume, v: Volume, level: number): 0 | 1 | 2 {
  if (Math.abs(volumeLift(o) - volumeLift(v)) < EPS) return occupiesLevel(o, level) ? 2 : 0;
  const z0 = volumeElevation(b, v, level), z1 = z0 + levelHeight(b, level);
  const [o0, o1] = solidSpan(b, o);
  if (o0 <= z0 + EPS && o1 >= z1 - EPS) return 2;
  return o1 > z0 + EPS && o0 < z1 - EPS ? 1 : 0;
}

// ------------------------------------------------------------------ plan

/** Local rectangle of a volume, world units: [x0, y0, x1, y1]. */
export function volumeRectLocal(_b: Building, v: Volume): [number, number, number, number] {
  return [v.x, v.y, v.x + v.w, v.y + v.d];
}

/** The four world corners of a volume, anticlockwise in the local frame. */
export function volumeCorners(b: Building, v: Volume, grow = 0): Vec2[] {
  if (v.outline) return offsetRing(localFootprint(v), grow).map((p) => localToWorld(b, p.x, p.y));
  const [x0, y0, x1, y1] = volumeRectLocal(b, v);
  return [
    localToWorld(b, x0 - grow, y0 - grow),
    localToWorld(b, x1 + grow, y0 - grow),
    localToWorld(b, x1 + grow, y1 + grow),
    localToWorld(b, x0 - grow, y1 + grow),
  ];
}

/** Volumes standing on the ground. Everything else stands on these. */
export const groundVolumes = (b: Building): Volume[] => b.volumes.filter((v) => v.base === 0 && isMass(v));

/** A block that is mass (solid or exclusive), not a cut or a clip of others. */
export const isMass = (v: Volume): boolean => v.mode !== 'void' && v.mode !== 'intersect';

/** World corner rings of the BUILT ground volumes: what a person cannot walk through. */
export function solidFootprints(b: Building, grow = 0): Vec2[][] {
  return groundVolumes(b).filter((v) => !v.open).map((v) => volumeCorners(b, v, grow));
}

/** World corner rings of every ground volume: the building's footprint. */
export function footprintRects(b: Building, grow = 0): Vec2[][] {
  return groundVolumes(b).map((v) => volumeCorners(b, v, grow));
}

/** Local bounding box of the footprint, world units. */
export function footprintBox(b: Building): { x0: number; y0: number; x1: number; y1: number } {
  const ground = groundVolumes(b);
  const list = ground.length > 0 ? ground : b.volumes;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const v of list) {
    x0 = Math.min(x0, v.x);
    y0 = Math.min(y0, v.y);
    x1 = Math.max(x1, v.x + v.w);
    y1 = Math.max(y1, v.y + v.d);
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: b.module, y1: b.module };
  return { x0, y0, x1, y1 };
}

/** World centre of the footprint's bounding box. */
export function footprintCentre(b: Building): Vec2 {
  const f = footprintBox(b);
  return localToWorld(b, (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2);
}

/** An element's plan, local frame: [x0, y0, x1, y1]. `w` runs across its facing, `d` along it. */
export function elementRect(e: BuildingElement): [number, number, number, number] {
  const alongY = e.facing === 0 || e.facing === 2;
  const sx = alongY ? e.w : e.d;
  const sy = alongY ? e.d : e.w;
  if (!e.angle) return [e.x - sx / 2, e.y - sy / 2, e.x + sx / 2, e.y + sy / 2];
  // A turned box (a run drawn along a path)
  const cs = Math.abs(Math.cos(e.angle));
  const sn = Math.abs(Math.sin(e.angle));
  const hx = (sx * cs + sy * sn) / 2;
  const hy = (sx * sn + sy * cs) / 2;
  return [e.x - hx, e.y - hy, e.x + hx, e.y + hy];
}

/** World bounding box of a building: its volumes and its elements. */
export function buildingBounds(b: Building, grow = 0): { minX: number; minY: number; maxX: number; maxY: number } {
  // DO NOT turn each corner into a point object: every check of a draft and every building filed passes here.
  const c = Math.cos(b.rotation), s = Math.sin(b.rotation);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const take = (lx: number, ly: number): void => {
    const x = b.x + lx * c - ly * s, y = b.y + lx * s + ly * c;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const v of b.volumes) {
    if (v.outline) { for (const p of offsetRing(localFootprint(v), grow)) take(p.x, p.y); continue; }
    take(v.x - grow, v.y - grow); take(v.x + v.w + grow, v.y - grow); take(v.x + v.w + grow, v.y + v.d + grow); take(v.x - grow, v.y + v.d + grow);
  }
  for (const e of b.elements ?? []) {
    const [x0, y0, x1, y1] = elementRect(e);
    const gx0 = Math.sign(x0 - e.x) * grow, gx1 = Math.sign(x1 - e.x) * grow, gy0 = Math.sign(y0 - e.y) * grow, gy1 = Math.sign(y1 - e.y) * grow;
    take(x0 + gx0, y0 + gy0); take(x1 + gx1, y0 + gy0); take(x1 + gx1, y1 + gy1); take(x0 + gx0, y1 + gy1);
  }
  return { minX, minY, maxX, maxY };
}

type Bounds = { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
const STORED_BOUNDS = new WeakMap<Building, Map<number, Bounds>>();
/** `buildingBounds` of a record held by the store, worked out once per record and margin. */
export function storedBounds(b: Building, grow = 0): Bounds {
  let byGrow = STORED_BOUNDS.get(b);
  if (!byGrow) STORED_BOUNDS.set(b, byGrow = new Map());
  let box = byGrow.get(grow);
  if (!box) byGrow.set(grow, box = buildingBounds(b, grow));
  return box;
}

// ------------------------------------------------------------------ solids


/** Whether two volumes share floor area in plan (touching is not sharing). */
export const planOverlap = (a: Volume, c: Volume): boolean =>
  a.outline || c.outline ? overlapArea(localFootprint(a), localFootprint(c)) > EPS :
  a.x < c.x + c.w - EPS && c.x < a.x + a.w - EPS && a.y < c.y + c.d - EPS && c.y < a.y + a.d - EPS;

/** Whether a volume above the ground has something under every part of it */
export function isSupported(b: Building, v: Volume): boolean {
  // A cut or a clip carries nothing and needs nothing under it.
  if (v.base === 0 || !isMass(v)) return true;
  // A block may overhang - a cantilever, a balcony block, a brick set half over the edge
  const floor = volumeElevation(b, v, v.base);
  const bears = (o: Volume): boolean => Math.abs(volumeLift(o) - volumeLift(v)) < EPS
    ? occupiesLevel(o, v.base - 1)
    : volumeElevation(b, o, o.base) < floor - EPS && volumeElevation(b, o, volumeTop(o)) >= floor - EPS;
  const supports = b.volumes.filter((o) => o.id !== v.id && isMass(o) && bears(o)).map(localFootprint);
  return supportShare(localFootprint(v), supports) >= MIN_BEARING;
}

/** The share of a block's plan that must bear on the blocks under it. */
const MIN_BEARING = 0.3;

// ------------------------------------------------------------------ facades

/** Length of one side of a volume. */
export const sideLength = (v: Volume, side: FaceId): number => edgeFrame(v, side).length;

/** Bays on a side: as many as fit at about one module each, at least one. */
export const baysOn = (b: Building, v: Volume, side: FaceId): number =>
  v.facadeGeometry?.[side]?.bays ?? Math.max(1, Math.round(steadyRatio(sideLength(v, side), b.module)));

/** Width of every bay of a side: the side shared evenly. */
export const bayWidth = (b: Building, v: Volume, side: FaceId): number => sideLength(v, side) / baysOn(b, v, side);

/** Local start of a side (where its along coordinate is 0) and its along direction. */
export function sideStart(v: Volume, side: FaceId): { x: number; y: number; tx: number; ty: number } {
  if (v.outline) return edgeFrame(v, side);
  switch (side) {
    case 0: return { x: v.x, y: v.y, tx: 1, ty: 0 };
    case 1: return { x: v.x + v.w, y: v.y, tx: 0, ty: 1 };
    case 2: return { x: v.x, y: v.y + v.d, tx: 1, ty: 0 };
    default: return { x: v.x, y: v.y, tx: 0, ty: 1 };
  }
}

/** Stretches of a side, in its along coordinate, that another volume stands against on `level` */
export function coveredSpans(b: Building, v: Volume, side: FaceId, level: number): [number, number][] {
  return spansAgainst(b, v, side, level, 2);
}

/** Stretches of a side another block stands against over PART of storey `level`'s height */
function partlyCoveredSpans(b: Building, v: Volume, side: FaceId, level: number): [number, number][] {
  if (!b.volumes.some((o) => Math.abs(volumeLift(o) - volumeLift(v)) > EPS)) return [];
  return spansAgainst(b, v, side, level, 1);
}

function spansAgainst(b: Building, v: Volume, side: FaceId, level: number, want: 1 | 2): [number, number][] {
  const out: [number, number][] = [];
  if (b.volumes.some((o) => o.outline)) {
    const a = edgeFrame(v, side);
    for (const o of b.volumes) {
      // An open lot (a garden, a car park) or a cut stands against no wall.
      if (o.id === v.id || o.open || !isMass(o) || standsAgainst(b, o, v, level) !== want) continue;
      for (const edge of volumeSides(o)) {
        const c = edgeFrame(o, edge);
        const facing = a.nx * c.nx + a.ny * c.ny;
        // Back to back (a shared wall), or - fully covered only
        const against = facing <= -.9999;
        const same = want === 2 && facing >= .9999 && o.id < v.id;
        if (!against && !same) continue;
        if (Math.abs((c.x - a.x) * a.nx + (c.y - a.y) * a.ny) > EPS * 10) continue;
        const start = (c.x - a.x) * a.tx + (c.y - a.y) * a.ty;
        const end = start + c.length * (c.tx * a.tx + c.ty * a.ty);
        const from = Math.max(0, Math.min(start, end)), to = Math.min(a.length, Math.max(start, end));
        if (to - from > EPS) out.push([from, to]);
      }
      // Inside the other block: a wall in the middle of its mass.
      if (want === 2) out.push(...insideSpans(a, localFootprint(o)));
    }
    return out.sort((p, q) => p[0] - q[0]);
  }
  for (const o of b.volumes) {
    if (o.id === v.id || o.open || !isMass(o) || standsAgainst(b, o, v, level) !== want) continue;
    let touches: boolean;
    let from: number;
    let to: number;
    if (side === 0 || side === 2) {
      const line = side === 0 ? v.y : v.y + v.d;
      touches = side === 0 ? Math.abs(o.y + o.d - v.y) < EPS * 10 : Math.abs(o.y - (v.y + v.d)) < EPS * 10;
      // Fully covered only (CityEngine's `inside`, which drops what lies completely inside or on the surface of another mass)
      if (want === 2) {
        const inside = line > o.y + EPS * 10 && line < o.y + o.d - EPS * 10;
        const same = o.id < v.id && (side === 0 ? Math.abs(o.y - v.y) < EPS * 10 : Math.abs(o.y + o.d - (v.y + v.d)) < EPS * 10);
        touches ||= inside || same;
      }
      from = Math.max(o.x, v.x) - v.x;
      to = Math.min(o.x + o.w, v.x + v.w) - v.x;
    } else {
      const line = side === 3 ? v.x : v.x + v.w;
      touches = side === 3 ? Math.abs(o.x + o.w - v.x) < EPS * 10 : Math.abs(o.x - (v.x + v.w)) < EPS * 10;
      if (want === 2) {
        const inside = line > o.x + EPS * 10 && line < o.x + o.w - EPS * 10;
        const same = o.id < v.id && (side === 3 ? Math.abs(o.x - v.x) < EPS * 10 : Math.abs(o.x + o.w - (v.x + v.w)) < EPS * 10);
        touches ||= inside || same;
      }
      from = Math.max(o.y, v.y) - v.y;
      to = Math.min(o.y + o.d, v.y + v.d) - v.y;
    }
    if (touches && to - from > EPS) out.push([from, to]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** The stretches of an edge (its along coordinate) that run strictly inside a polygon */
function insideSpans(a: { x: number; y: number; tx: number; ty: number; nx: number; ny: number; length: number }, poly: readonly Vec2[]): [number, number][] {
  const out: [number, number][] = [];
  const step = Math.max(EPS * 20, a.length / 64);
  const nudge = EPS * 20;
  let from = -1;
  for (let s = 0; s <= a.length + 1e-9; s += step) {
    const t = Math.min(s, a.length);
    const p = { x: a.x + a.tx * t + a.nx * nudge, y: a.y + a.ty * t + a.ny * nudge };
    const inside = pointInPolygon(p, poly);
    if (inside && from < 0) from = Math.max(0, t - step / 2);
    if ((!inside || t >= a.length) && from >= 0) { const to = inside ? a.length : Math.min(a.length, t - step / 2); if (to - from > EPS) out.push([from, to]); from = -1; }
  }
  return out;
}

/** The parts of [a0, a1] no span covers. */
export function exposedParts(spans: readonly (readonly [number, number])[], a0: number, a1: number): [number, number][] {
  const out: [number, number][] = [];
  let from = a0;
  for (const [s0, s1] of spans) {
    if (s1 <= from + EPS || s0 >= a1 - EPS) continue;
    if (s0 > from + EPS) out.push([from, Math.min(s0, a1)]);
    from = Math.max(from, s1);
    if (from >= a1 - EPS) break;
  }
  if (a1 - from > EPS) out.push([from, a1]);
  return out;
}

// ------------------------------------------------------------------ reliefs

/** The relief a bay of a storey is in, if any (the last one listed wins). */
export function reliefAt(v: Volume, side: FaceId, index: number, storey: number): Relief | null {
  const list = v.reliefs;
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i] as Relief;
    if (r.side === side && index >= r.bay0 && index <= r.bay1 && storey >= r.storey0 && storey <= r.storey1) return r;
  }
  return null;
}

/** The plan rectangle a relief's region occupies in front of its face, local frame, world units: [x0, y0, x1, y1]. */
export function projectionRect(b: Building, v: Volume, r: Relief): [number, number, number, number] | null {
  if (r.depth <= 0) return null;
  if (v.outline) {
    const f = edgeFrame(v, r.side), width = bayWidth(b, v, r.side);
    const a0 = r.bay0 * width, a1 = (r.bay1 + 1) * width;
    const points = [
      { x: f.x + f.tx * a0, y: f.y + f.ty * a0 },
      { x: f.x + f.tx * a1, y: f.y + f.ty * a1 },
      { x: f.x + f.tx * a1 + f.nx * r.depth, y: f.y + f.ty * a1 + f.ny * r.depth },
      { x: f.x + f.tx * a0 + f.nx * r.depth, y: f.y + f.ty * a0 + f.ny * r.depth },
    ];
    return [Math.min(...points.map((p) => p.x)), Math.min(...points.map((p) => p.y)),
      Math.max(...points.map((p) => p.x)), Math.max(...points.map((p) => p.y))];
  }
  const w = bayWidth(b, v, r.side);
  const count = baysOn(b, v, r.side);
  const a0 = Math.max(0, r.bay0) * w;
  const a1 = (Math.min(count - 1, r.bay1) + 1) * w;
  switch (r.side) {
    case 0: return [v.x + a0, v.y - r.depth, v.x + a1, v.y];
    case 2: return [v.x + a0, v.y + v.d, v.x + a1, v.y + v.d + r.depth];
    case 1: return [v.x + v.w, v.y + a0, v.x + v.w + r.depth, v.y + a1];
    default: return [v.x - r.depth, v.y + a0, v.x, v.y + a1];
  }
}

/** World rings of the projections that stand on the ground (from the first storey of a ground volume) */
export function groundProjections(b: Building, grow = 0): Vec2[][] {
  const out: Vec2[][] = [];
  for (const v of groundVolumes(b)) {
    for (const r of v.reliefs ?? []) {
      if (r.storey0 !== 0) continue;
      const rect = projectionRect(b, v, r);
      if (!rect) continue;
      if (v.outline) {
        const f = edgeFrame(v, r.side), width = bayWidth(b, v, r.side);
        const start = r.bay0 * width, end = (r.bay1 + 1) * width;
        const at = (a: number, d: number): Vec2 => localToWorld(b, f.x + f.tx * a + f.nx * d, f.y + f.ty * a + f.ny * d);
        out.push([at(start - grow, -grow), at(end + grow, -grow), at(end + grow, r.depth + grow), at(start - grow, r.depth + grow)]);
        continue;
      }
      const [x0, y0, x1, y1] = rect;
      out.push([
        localToWorld(b, x0 - grow, y0 - grow),
        localToWorld(b, x1 + grow, y0 - grow),
        localToWorld(b, x1 + grow, y1 + grow),
        localToWorld(b, x0 - grow, y1 + grow),
      ]);
    }
  }
  return out;
}

/** Local centre of bay `index` on the facade line of `side`. */
export function bayCentreLocal(b: Building, v: Volume, side: FaceId, index: number): Vec2 {
  const s = sideStart(v, side);
  const a = (index + 0.5) * bayWidth(b, v, side);
  return { x: s.x + s.tx * a, y: s.y + s.ty * a };
}

/** What one exposed bay (or piece of one) of one storey is wherever its building stands. */
interface BayOf {
  readonly volume: number;
  /** Storey index within the volume. */
  readonly storey: number;
  readonly level: number;
  readonly side: FaceId;
  readonly index: number;
  readonly component: BayComponent;
  /** Height of the bay's floor above the building's ground floor. */
  readonly z: number;
  /** Where the piece starts along the side, local units from the side's start. */
  readonly start: number;
  /** How far the bay's plane stands out from the side (negative: set back), by a relief. */
  readonly push: number;
  readonly width: number;
  readonly height: number;
}

/** One exposed bay (or piece of one) of one storey: everything a mesh builder or a picker needs. */
export interface FacadeBay extends BayOf {
  /** World point at the bottom centre of the bay (of the piece), on the facade line. */
  readonly x: number;
  readonly y: number;
  /** Outward normal, world. */
  readonly nx: number;
  readonly ny: number;
}

/** The same bay in the building's own frame (`bayLayout`): its point and normal local. */
export interface LocalBay extends BayOf {
  readonly lx: number;
  readonly ly: number;
  readonly lnx: number;
  readonly lny: number;
}

/** What a building's bays and floors are laid by besides its blocks: the bay module across, the storey heights up (`levelHeight`). */
export interface Rhythm {
  readonly module: number;
  readonly groundHeight: number;
  readonly storeyHeight: number;
  /** A copy of `Building.levels`: a draft's list changed in place does not change what was keyed by it. */
  readonly levels: readonly (number | null)[] | undefined;
}

export const rhythmOf = (b: Building): Rhythm =>
  ({ module: b.module, groundHeight: b.groundHeight, storeyHeight: b.storeyHeight, levels: b.levels?.slice() });

/** Whether a building has this rhythm: every number the same (`Object.is`), level by level. */
export function sameRhythm(r: Rhythm, b: Building): boolean {
  if (!Object.is(r.module, b.module) || !Object.is(r.groundHeight, b.groundHeight) || !Object.is(r.storeyHeight, b.storeyHeight)) return false;
  const a = r.levels, c = b.levels;
  // None given, however it was written (a save may hold null): the defaults alike.
  if (!a || !c) return !a && !c;
  if (a.length !== c.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], c[i])) return false;
  return true;
}

/** A building's closed blocks (an open one is a lot, laid on the ground): one list for every record with the same blocks, the blocks themselves when none is open */
export const closedBlocks: (volumes: Volume[]) => Volume[] = identityMemo((volumes: Volume[]): Volume[] =>
  (volumes.some((v) => v.open) ? volumes.filter((v) => !v.open) : volumes));

/** Each blocks list's layouts, one per rhythm it was asked with: what `bayLayout` keeps. */
const layoutsOf = identityMemo((_volumes: readonly Volume[]): { readonly rhythm: Rhythm; readonly bays: readonly LocalBay[] }[] => []);

/** A building's bays in its own frame, worked out once for its blocks list and rhythm: the records sharing them (`intern.ts`, a tile's decoded members, a draft moved) share it; asked by emission alone (a job's records, the page's few), let go with the list; DO NOT key it by the record nor cap it */
export function bayLayout(b: Building): readonly LocalBay[] {
  const known = layoutsOf(b.volumes);
  for (const k of known) if (sameRhythm(k.rhythm, b)) return k.bays;
  const bays = workOutLayout(b);
  known.push({ rhythm: rhythmOf(b), bays });
  return bays;
}

/** A building's bays in the world (`level`: that storey's alone), from its layout turned and moved to where it stands; a new list each time, kept by no one. */
export function facadeBays(b: Building, level?: number): FacadeBay[] {
  const f = buildingFrame(b);
  const out: FacadeBay[] = [];
  for (const bay of bayLayout(b)) {
    if (level !== undefined && bay.level !== level) continue;
    out.push({
      volume: bay.volume,
      storey: bay.storey,
      level: bay.level,
      side: bay.side,
      index: bay.index,
      component: bay.component,
      // As `localToWorld` and `localDirToWorld` turn them.
      x: frameX(f, bay.lx, bay.ly),
      y: frameY(f, bay.lx, bay.ly),
      nx: bay.lnx * f.c - bay.lny * f.s,
      ny: bay.lnx * f.s + bay.lny * f.c,
      z: bay.z,
      start: bay.start,
      push: bay.push,
      width: bay.width,
      height: bay.height,
    });
  }
  return out;
}

/** Numbers per bay in a `GroundBays` table, and where each lies. */
export const GROUND_BAY_STRIDE = 8;
export const GB_X = 0, GB_Y = 1, GB_NX = 2, GB_NY = 3, GB_Z = 4, GB_SIDE = 5, GB_WIDTH = 6;
const GB_COMPONENT = 7;

/** The ground storey's bays (level 0) of a building, packed */
export type GroundBays = Float64Array;

/** Each record's ground storey bays (`GroundBays`), by the record itself: a stored record is never changed in place */
const GROUND_BAYS = new WeakMap<Building, GroundBays>();
export function groundBays(b: Building): GroundBays {
  let known = GROUND_BAYS.get(b);
  if (!known) {
    // DO NOT read them off `bayLayout`: the page asks this of every building it holds, and would keep every storey's bays.
    const bays = workOutLayout(b, 0);
    const f = buildingFrame(b);
    known = new Float64Array(bays.length * GROUND_BAY_STRIDE);
    bays.forEach((bay, i) => {
      const o = i * GROUND_BAY_STRIDE;
      known![o + GB_X] = frameX(f, bay.lx, bay.ly);
      known![o + GB_Y] = frameY(f, bay.lx, bay.ly);
      known![o + GB_NX] = bay.lnx * f.c - bay.lny * f.s;
      known![o + GB_NY] = bay.lnx * f.s + bay.lny * f.c;
      known![o + GB_Z] = bay.z;
      known![o + GB_SIDE] = bay.side;
      known![o + GB_WIDTH] = bay.width;
      known![o + GB_COMPONENT] = BAY_COMPONENTS.indexOf(bay.component);
    });
    GROUND_BAYS.set(b, known);
  }
  return known;
}

/** The component of a packed ground bay. */
export const groundBayComponent = (table: GroundBays, i: number): BayComponent =>
  BAY_COMPONENTS[table[i * GROUND_BAY_STRIDE + GB_COMPONENT]!]!;

/** Every bay that is an OUTSIDE wall, in the building's own frame: its blocks and rhythm alone decide it. */
function workOutLayout(b: Building, onlyLevel?: number): LocalBay[] {
  const out: LocalBay[] = [];
  const elevations: number[] = [];
  const top = topLevel(b);
  for (let level = 0; level <= top; level++) elevations.push(levelElevation(b, level));
  // Whether two blocks stand at lifts apart (`partlyCoveredSpans` finds nothing otherwise).
  let lowLift = Infinity, highLift = -Infinity;
  for (const o of b.volumes) { lowLift = Math.min(lowLift, volumeLift(o)); highLift = Math.max(highLift, volumeLift(o)); }
  const lifted = highLift - lowLift > EPS;
  for (const v of b.volumes) {
    // DO NOT work a side's frame, bays and start out again each storey: they are the block's.
    const sides = volumeSides(v).map((side) => {
      const frame = edgeFrame(v, side);
      return { side, nx: frame.nx, ny: frame.ny, count: baysOn(b, v, side), width: bayWidth(b, v, side), s: sideStart(v, side) };
    });
    const lift = volumeLift(v);
    for (let k = 0; k < v.storeys.length; k++) {
      const storey = v.storeys[k];
      if (!storey) continue;
      const level = v.base + k;
      if (onlyLevel !== undefined && level !== onlyLevel) continue;
      const z = lift + (elevations[level] ?? levelElevation(b, level));
      const height = levelHeight(b, level);
      for (const { side, nx, ny, count, width, s } of sides) {
        const spans = coveredSpans(b, v, side, level);
        // Against a block at another floor for part of the storey: plain wall there.
        const partly = lifted ? partlyCoveredSpans(b, v, side, level) : NO_SPANS;
        const bay = (index: number, push: number, p0: number, p1: number, whole: boolean): void => {
          const mid = (p0 + p1) / 2;
          out.push({
            volume: v.id,
            storey: k,
            level,
            side,
            index,
            component: whole ? componentAt(storey.facade, side, index) : 'wall',
            lx: s.x + s.tx * mid + nx * push,
            ly: s.y + s.ty * mid + ny * push,
            lnx: nx,
            lny: ny,
            z,
            start: p0,
            push,
            width: p1 - p0,
            height,
          });
        };
        for (let index = 0; index < count; index++) {
          const a0 = index * width;
          const a1 = a0 + width;
          const push = reliefAt(v, side, index, k)?.depth ?? 0;
          let partlyHere = false;
          for (const [s0, s1] of partly) if (s1 > a0 + EPS && s0 < a1 - EPS) { partlyHere = true; break; }
          // Nothing against the side: the bay whole, no list made.
          if (spans.length === 0) { bay(index, push, a0, a1, !partlyHere); continue; }
          const parts = exposedParts(spans, a0, a1);
          const first = parts[0];
          const whole = parts.length === 1 && first !== undefined && Math.abs(first[0] - a0) < EPS && Math.abs(first[1] - a1) < EPS && !partlyHere;
          for (const [p0, p1] of parts) bay(index, push, p0, p1, whole);
        }
      }
    }
  }
  return out;
}

/** No spans. */
const NO_SPANS: readonly (readonly [number, number])[] = Object.freeze([]);

// ------------------------------------------------------------------ roofs

/** Default roof pitches, degrees. */
export const DEFAULT_PITCH: Readonly<Record<string, number>> = { gable: 30, hip: 30, shed: 12, sawtooth: 35 };

/** A volume's roof pitch as rise over run. */
export function roofSlope(v: Volume): number {
  const degrees = v.pitch ?? DEFAULT_PITCH[v.roof] ?? 30;
  return Math.tan((degrees * Math.PI) / 180);
}

/** Whether a gable or hip ridge runs along the local x axis: as set, else along the longer side. */
export const ridgeAlongX = (v: Volume): boolean => (v.ridge ? v.ridge === 'x' : v.w >= v.d);

/** The side a shed roof falls towards. */
export const shedFall = (v: Volume): Side => v.fall ?? 0;

/** The run of one sawtooth: two modules, or the whole depth if less. */
export const sawtoothRun = (b: Building, v: Volume): number => Math.min(2 * b.module, v.d);

/** How far a volume's roof rises above its top floor, world units. */
export function roofRise(b: Building, v: Volume): number {
  const slope = roofSlope(v);
  switch (v.roof) {
    case 'gable':
    case 'hip':
      return (ridgeAlongX(v) ? v.d : v.w) * 0.5 * slope;
    case 'shed': {
      const fall = shedFall(v);
      return (fall === 0 || fall === 2 ? v.d : v.w) * slope;
    }
    case 'sawtooth':
      return sawtoothRun(b, v) * 0.5 * slope;
    default:
      return 0;
  }
}

/** Height over the eaves at one local roof point, shared by roof parts. */
export function roofHeightAt(b: Building, v: Volume, p: Vec2): number {
  const x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.d;
  const slope = roofSlope(v);
  switch (v.roof) {
    case 'flat': case 'terrace': return 0;
    case 'gable': return (ridgeAlongX(v) ? Math.min(p.y - y0, y1 - p.y) : Math.min(p.x - x0, x1 - p.x)) * slope;
    case 'hip': return Math.min(p.x - x0, x1 - p.x, p.y - y0, y1 - p.y) * slope;
    case 'shed': {
      const fall = shedFall(v);
      return (fall === 0 ? p.y - y0 : fall === 2 ? y1 - p.y : fall === 1 ? x1 - p.x : p.x - x0) * slope;
    }
    case 'sawtooth': {
      const run = sawtoothRun(b, v), segment = Math.floor((p.y - y0) / run);
      const from = y0 + segment * run, to = Math.min(y1, from + run);
      return Math.min(p.y - from, to - p.y) * slope;
    }
  }
}

/** Height of a volume's top (eaves), above the building's ground floor, its lift included. */
export const volumeHeight = (b: Building, v: Volume): number => volumeElevation(b, v, volumeTop(v));

/** The highest point of the building above its ground floor. */
export function buildingHeight(b: Building): number {
  let h = 0;
  for (const v of b.volumes) h = Math.max(h, volumeHeight(b, v) + roofRise(b, v));
  return h;
}
