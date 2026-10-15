import type { Vec2 } from '@core/vec2';
import { convexHull, pointInPolygon } from '@core/polygon';
import { m } from '../units';
import { edgeFrame, localFootprint, overlapArea } from './footprints';
import { STEP_RISE, STEP_RUN } from './foundation';
import { isRetainingStone } from './cityBuildings';
import {
  EPS,
  GRID,
  bayWidth,
  elementRect,
  localToWorld,
  sideStart,
  volumeElevation,
  volumeHeight,
  volumeLift,
} from './geometry';
import {
  type Building,
  type BuildingElement,
  type ElementKind,
  type FaceId,
  type Side,
  type Volume,
  volumeTop,
} from './types';

/** Free parts of a building. */

/** A ramp's slope: one in twelve, the usual limit for a wheelchair ramp. */
const RAMP_RUN_PER_RISE = 12;
export const MIN_ELEMENT = m(0.1);
export const MAX_ELEMENT = m(40);

/** Sizes an element starts with, world units: [w, d, h]. */
export const ELEMENT_DEFAULTS: Readonly<Record<ElementKind, readonly [number, number, number]>> = {
  stair: [m(1.2), m(3), m(1)],
  ramp: [m(1.5), m(6), m(0.5)],
  pillar: [m(0.4), m(0.4), m(3)],
  canopy: [m(2.4), m(1.2), m(0.15)],
  wall: [m(4), m(0.25), m(1.8)],
  slab: [m(4), m(4), m(0.25)],
  pavement: [m(4), m(3), m(0.12)],
  fence: [m(2), m(0.12), m(1.1)],
  tree: [m(3), m(3), m(5)],
  bench: [m(1.6), m(0.5), m(0.45)],
  ac: [m(0.8), m(0.35), m(0.6)],
  planter: [m(1), m(1), m(0.5)],
  railing: [m(2), m(0.12), m(1.05)],
  awning: [m(3), m(1.2), m(0.12)],
  flowers: [m(1.4), m(1.4), m(0.4)],
  rocks: [m(1.6), m(1.6), m(0.7)],
  parking: [m(6), m(5), m(0.12)],
  clock: [m(3), m(0.25), m(3)],
  hedge: [m(3), m(0.7), m(1.2)],
  shrub: [m(1.4), m(1.4), m(1.2)],
  gate: [m(3), m(0.12), m(1.8)],
  bin: [m(1.4), m(0.7), m(1.1)],
  lamp: [m(0.3), m(0.3), m(4.5)],
  bollard: [m(0.2), m(0.2), m(0.9)],
  drain: [m(0.5), m(0.5), m(0.1)],
};

/** Parts hung on a facade rather than standing on the ground. */
export const ON_FACADE: ReadonlySet<ElementKind> = new Set<ElementKind>(['canopy', 'ac', 'awning', 'clock']);

/** Parts that dress a lot rather than raise a building. */
const GROUND_DRESSING: ReadonlySet<ElementKind> = new Set<ElementKind>([
  'pavement',
  'fence',
  'tree',
  'bench',
  'shrub',
  'flowers',
  'hedge',
  'planter',
  'gate',
  'bin',
  'lamp',
  'bollard',
  'drain',
]);

/** Whether an element's foot stands on the ground (rather than on a floor, or hung on a wall). */
export const onGround = (e: BuildingElement): boolean => e.z <= EPS && !ON_FACADE.has(e.kind);

/** Parts that stand on the land itself and follow it */
export const FOLLOWS_GROUND: ReadonlySet<ElementKind> = new Set<ElementKind>([
  'wall', 'fence', 'railing', 'pavement', 'hedge', 'bin', 'lamp', 'bollard', 'drain', 'planter', 'bench', 'rocks',
  'flowers', 'shrub', 'tree', 'gate',
]);

/** The longest step of a run that follows the ground. */
const FOLLOW_STEP = m(2);

/** A long run that follows the ground in steps of at most `FOLLOW_STEP`; anything else whole. */
export function followPieces(el: BuildingElement): BuildingElement[] {
  if (!FOLLOWS_GROUND.has(el.kind) || el.kind === 'gate') return [el];
  const alongW = el.w >= el.d;
  const length = alongW ? el.w : el.d;
  const n = Math.ceil(length / FOLLOW_STEP - 1e-9);
  if (n <= 1) return [el];
  // The way `w` runs: across the facing, turned by the element's own angle.
  const a = el.angle ?? 0;
  const wx = el.facing === 0 || el.facing === 2 ? 1 : 0, wy = 1 - wx;
  const ux = wx * Math.cos(a) - wy * Math.sin(a), uy = wx * Math.sin(a) + wy * Math.cos(a);
  const [dx, dy] = alongW ? [ux, uy] : [-uy, ux];
  const out: BuildingElement[] = [];
  for (let k = 0; k < n; k++) {
    const off = (k + 0.5) * (length / n) - length / 2;
    out.push({ ...el, x: el.x + dx * off, y: el.y + dy * off, ...(alongW ? { w: length / n } : { d: length / n }) });
  }
  return out;
}

export { elementRect };

/** The world ring of an element's plan. */
export function elementRing(b: Building, e: BuildingElement, grow = 0): Vec2[] {
  const [x0, y0, x1, y1] = elementRect(e);
  return [
    localToWorld(b, x0 - grow, y0 - grow),
    localToWorld(b, x1 + grow, y0 - grow),
    localToWorld(b, x1 + grow, y1 + grow),
    localToWorld(b, x0 - grow, y1 + grow),
  ];
}

/** World rings of the elements that stand on the ground: footprint, for the road and neighbour tests. */
export const groundElements = (b: Building, grow = 0): Vec2[][] =>
  (b.elements ?? [])
    .filter((e) => onGround(e) && !GROUND_DRESSING.has(e.kind))
    .map((e) => elementRing(b, e, grow));

/** Steps of a stair: every riser at most `STEP_RISE`. */
export const stairSteps = (e: BuildingElement): number => Math.max(1, Math.ceil(e.h / STEP_RISE - 1e-9));

/** The run a stair or a ramp needs for its rise. */
export function runFor(kind: ElementKind, rise: number): number {
  if (kind === 'ramp') return Math.max(m(1), rise * RAMP_RUN_PER_RISE);
  return Math.max(STEP_RUN, Math.ceil(rise / STEP_RISE - 1e-9) * STEP_RUN);
}

/** The first volume an element would stand inside of, or null. Touching is allowed. */
export function elementClash(b: Building, e: BuildingElement): Volume | null {
  const [x0, y0, x1, y1] = elementRect(e);
  const z0 = e.z;
  const z1 = e.z + e.h;
  for (const v of b.volumes) {
    // A lot is ground to stand things on, and a cut or a clip is no mass.
    if (v.open || v.mode === 'void' || v.mode === 'intersect') continue;
    // Its own heights (a block at a floor of its own, `Volume.lift`)
    const vz0 = v.base === 0 ? Math.min(0, volumeLift(v)) : volumeElevation(b, v, v.base);
    const vz1 = volumeElevation(b, v, volumeTop(v));
    // A canopy, an awning or a unit hangs ON the wall
    if (ON_FACADE.has(e.kind)) {
      if (z0 < vz1 - EPS && vz0 < z1 - EPS && pointInPolygon({ x: e.x, y: e.y }, localFootprint(v))) return v;
      continue;
    }
    if (z0 < vz1 - EPS && vz0 < z1 - EPS &&
      (v.outline ? overlapArea(localFootprint(v), [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]) > EPS
        : x0 < v.x + v.w - EPS && v.x < x1 - EPS && y0 < v.y + v.d - EPS && v.y < y1 - EPS)) return v;
  }
  return null;
}

/** The parts nothing holds up: a carport roof whose posts were refused, a pergola whose posts a retaining wall cleared */
export function unsupportedElements(b: Building): Set<number> {
  const els = b.elements ?? [];
  const out = new Set<number>();
  if (els.length === 0) return out;
  const tol = m(0.05);
  const masses = b.volumes.filter((v) => !v.open && v.mode !== 'void' && v.mode !== 'intersect');
  const rects = new Map(els.map((e) => [e.id, elementRect(e)] as const));
  const square = ([x0, y0, x1, y1]: readonly number[], grow: number): Vec2[] =>
    [{ x: x0! - grow, y: y0! - grow }, { x: x1! + grow, y: y0! - grow }, { x: x1! + grow, y: y1! + grow }, { x: x0! - grow, y: y1! + grow }];
  const onLand = (e: BuildingElement): boolean => {
    if (onGround(e) || FOLLOWS_GROUND.has(e.kind)) return true;
    // On a terrace (an open block raised or lowered with the slope) it touches at its own base
    const box = square(rects.get(e.id)!, tol);
    for (const v of b.volumes) {
      if (!v.open || v.terrace === undefined) continue;
      if (Math.abs(e.z - v.terrace) <= tol && overlapArea(localFootprint(v), box) > EPS) return true;
    }
    return false;
  };
  // Hung on the building's wall, or laid on one of its roofs or floors
  const heldByMass = (e: BuildingElement): boolean => {
    const box = square(rects.get(e.id)!, m(0.3));
    for (const v of masses) {
      const vz0 = v.base === 0 ? Math.min(0, volumeLift(v)) : volumeElevation(b, v, v.base);
      const vz1 = volumeElevation(b, v, volumeTop(v));
      if (e.z > vz1 + tol || e.z + e.h < vz0 - tol) continue;
      if (overlapArea(localFootprint(v), box) > EPS) return true;
    }
    return false;
  };
  const held = new Set<number>();
  for (const e of els) if (onLand(e) || heldByMass(e)) held.add(e.id);
  for (let changed = true; changed;) {
    changed = false;
    for (const e of els) {
      if (held.has(e.id)) continue;
      const [ex0, ey0, ex1, ey1] = rects.get(e.id)!;
      const contacts: Vec2[] = [];
      for (const s of els) {
        if (s === e || !held.has(s.id)) continue;
        // Touching across a height they share: under it (its top at e's underside), over it (e hangs from it) or beside it
        if (s.z > e.z + e.h + tol || e.z > s.z + s.h + tol) continue;
        const [sx0, sy0, sx1, sy1] = rects.get(s.id)!;
        const ix0 = Math.max(ex0, sx0), iy0 = Math.max(ey0, sy0), ix1 = Math.min(ex1, sx1), iy1 = Math.min(ey1, sy1);
        if (ix1 < ix0 - tol || iy1 < iy0 - tol) continue;
        contacts.push(...square([ix0, iy0, Math.max(ix0, ix1), Math.max(iy0, iy1)], tol));
      }
      if (contacts.length === 0 || !pointInPolygon({ x: e.x, y: e.y }, convexHull(contacts))) continue;
      held.add(e.id);
      changed = true;
    }
  }
  for (const e of els) if (!held.has(e.id)) out.add(e.id);
  return out;
}

/** The objects a lot's parts make: parts that touch (by the same contact `unsupportedElements` reads) are one thing */
export function partGroups(b: Building): Map<number, number> {
  const els = (b.elements ?? []).filter((e) => !FOLLOWS_GROUND.has(e.kind));
  const tol = m(0.05);
  const rects = els.map((e) => elementRect(e));
  const parent = els.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  for (let i = 0; i < els.length; i++) {
    const a = els[i]!, [ax0, ay0, ax1, ay1] = rects[i]!;
    for (let j = i + 1; j < els.length; j++) {
      const c = els[j]!, [cx0, cy0, cx1, cy1] = rects[j]!;
      if (c.z > a.z + a.h + tol || a.z > c.z + c.h + tol) continue;
      if (cx0 > ax1 + tol || ax0 > cx1 + tol || cy0 > ay1 + tol || ay0 > cy1 + tol) continue;
      parent[find(i)] = find(j);
    }
  }
  const out = new Map<number, number>();
  els.forEach((e, i) => out.set(e.id, find(i)));
  return out;
}

/** A new element's id, and the building's counter moved past it. */
export function takeElementId(b: Building): number {
  const used = (b.elements ?? []).reduce((n, e) => Math.max(n, e.id), 0);
  const id = Math.max(b.nextElementId ?? 1, used + 1);
  b.nextElementId = id + 1;
  return id;
}

// ------------------------------------------------------------------ snapping

/** A bay of a face, as the pointer picked it. */
export interface BayRef {
  readonly volume: number;
  readonly side: FaceId;
  readonly index: number;
  readonly storey: number;
}

const snap = (v: number, step = GRID): number => Math.round(v / step) * step;

/** Candidate placements of an element of `kind` against a picked bay, best first. */
export function elementsAgainstBay(b: Building, v: Volume, bay: BayRef, kind: ElementKind): Omit<BuildingElement, 'id'>[] {
  const made = elementsAgainstBayAxis(b, v, bay, kind);
  if (!ON_FACADE.has(kind)) return made;
  // Hung on a face that is not square to the frame
  const frame = edgeFrame(v, bay.side);
  return made.map((e) => {
    const fn = FACING_NORMAL[e.facing];
    let angle = Math.atan2(frame.ny, frame.nx) - Math.atan2(fn.y, fn.x);
    angle = Math.atan2(Math.sin(angle), Math.cos(angle));
    return Math.abs(angle) > 1e-3 ? { ...e, angle } : e;
  });
}

const FACING_NORMAL: Readonly<Record<Side, Vec2>> = { 0: { x: 0, y: -1 }, 1: { x: 1, y: 0 }, 2: { x: 0, y: 1 }, 3: { x: -1, y: 0 } };

function elementsAgainstBayAxis(b: Building, v: Volume, bay: BayRef, kind: ElementKind): Omit<BuildingElement, 'id'>[] {
  const [dw, dd, dh] = ELEMENT_DEFAULTS[kind];
  const frame = edgeFrame(v, bay.side);
  const n = { x: frame.nx, y: frame.ny };
  const facing: Side = Math.abs(n.x) > Math.abs(n.y) ? (n.x > 0 ? 1 : 3) : (n.y > 0 ? 2 : 0);
  const s = sideStart(v, bay.side);
  const width = bayWidth(b, v, bay.side);
  const along = (bay.index + 0.5) * width;
  // A point on the face line, `out` in front of it and `a` along it.
  const at = (a: number, out: number): Vec2 => ({ x: s.x + s.tx * a + n.x * out, y: s.y + s.ty * a + n.y * out });
  const floorZ = volumeElevation(b, v, v.base + bay.storey);
  switch (kind) {
    case 'canopy': {
      // Over the bay's opening, a little below the next floor.
      const z = Math.max(floorZ + m(2.5), volumeElevation(b, v, v.base + bay.storey + 1) - m(0.6));
      const c = at(along, dd / 2);
      return [{ kind, x: c.x, y: c.y, facing, w: Math.max(width, dw), d: dd, z, h: dh }];
    }
    case 'stair':
    case 'ramp': {
      // From the floor of the picked storey down to the ground floor's level.
      const rise = Math.max(floorZ, STEP_RISE);
      const run = runFor(kind, rise);
      const w = kind === 'ramp' ? dw : Math.max(dw, Math.min(width, m(1.6)));
      const straight = at(along, run / 2);
      const out: Omit<BuildingElement, 'id'>[] = [{ kind, x: straight.x, y: straight.y, facing, w, d: run, z: 0, h: rise }];
      // Turned to run along the facade, either way, its top at the bay.
      for (const dir of [1, -1] as const) {
        const turned = ((facing + (dir === 1 ? 1 : 3)) % 4) as Side;
        const c = at(along + dir * (run / 2 - w / 2), w / 2);
        out.push({ kind, x: c.x, y: c.y, facing: turned, w, d: run, z: 0, h: rise });
      }
      return out;
    }
    case 'pillar': {
      // On the nearest bay line, just in front of the face, as tall as the storey.
      const line = Math.round(along / width) * width;
      const c = at(line, dd / 2 + m(0.6));
      return [{ kind, x: c.x, y: c.y, facing, w: dw, d: dd, z: floorZ, h: volumeElevation(b, v, v.base + bay.storey + 1) - floorZ }];
    }
    case 'wall':
    case 'hedge': {
      // Parallel to the face, a module out, on the ground.
      const c = at(along, b.module);
      return [{ kind, x: snap(c.x), y: snap(c.y), facing, w: Math.max(dw, width), d: dd, z: 0, h: dh }];
    }
    case 'slab': {
      // A deck in front of the bay, at its floor.
      const c = at(along, dd / 2);
      return [{ kind, x: c.x, y: c.y, facing, w: Math.max(width, dw), d: dd, z: Math.max(0, floorZ - dh), h: dh }];
    }
    case 'railing': {
      // A run of railing along the facade, a module out.
      const run = Math.max(dw, width);
      const c = at(along, b.module);
      return [{ kind, x: c.x, y: c.y, facing, w: run, d: Math.max(dd, m(0.12)), z: 0, h: dh }];
    }
    case 'awning': {
      // A canvas over the bay's opening, projecting out from above it.
      const z = Math.max(floorZ + m(2.4), volumeElevation(b, v, v.base + bay.storey + 1) - m(0.5));
      const c = at(along, dd / 2);
      return [{ kind, x: c.x, y: c.y, facing, w: Math.max(width, dw), d: dd, z, h: dh }];
    }
    case 'flowers':
    case 'shrub': {
      const c = at(along, m(1.2));
      return [{ kind, x: c.x, y: c.y, facing, w: dw, d: dd, z: 0, h: dh }];
    }
    case 'rocks': {
      const c = at(along, m(2));
      return [{ kind, x: c.x, y: c.y, facing, w: dw, d: dd, z: 0, h: dh }];
    }
    case 'parking': {
      // A paved apron in front of the bay, wide enough for a car each side.
      const run = Math.max(dd, m(5));
      const c = at(along, run / 2);
      return [{ kind, x: c.x, y: c.y, facing, w: Math.max(width * 2, dw), d: run, z: 0, h: dh }];
    }
    case 'pavement': {
      // A paved apron on the ground in front of the bay: its depth runs out from the wall, its width along it.
      const run = Math.max(dd, m(3));
      const c = at(along, run / 2);
      return [{ kind, x: c.x, y: c.y, facing, w: Math.max(width, dw), d: run, z: 0, h: dh }];
    }
    case 'fence': {
      // A run of fence parallel to the face, a module out.
      const run = Math.max(dw, width);
      const c = at(along, b.module);
      return [{ kind, x: c.x, y: c.y, facing, w: run, d: dd, z: 0, h: dh }];
    }
    case 'tree': {
      // On the ground in front of the bay, clear of the flight.
      const c = at(along, m(2.2));
      return [{ kind, x: c.x, y: c.y, facing, w: dw, d: dd, z: 0, h: dh }];
    }
    case 'bench': {
      // On the ground, facing out from the wall.
      const c = at(along, m(1.4));
      return [{ kind, x: c.x, y: c.y, facing, w: dw, d: dd, z: 0, h: dh }];
    }
    case 'bin':
    case 'lamp':
    case 'bollard':
    case 'drain':
    case 'gate':
    case 'planter': {
      const c = at(along, m(1.1));
      return [{ kind, x: c.x, y: c.y, facing, w: dw, d: dd, z: 0, h: dh }];
    }
    case 'clock': {
      // A dial on the wall, centred on the bay, in the middle of the storey.
      const c = at(along, dd / 2 + m(0.02));
      const storeyH = volumeElevation(b, v, v.base + bay.storey + 1) - floorZ;
      const size = Math.min(dw, width * 0.9, storeyH * 0.9);
      return [{ kind, x: c.x, y: c.y, facing, w: size, d: dd, z: floorZ + (storeyH - size) / 2, h: size }];
    }
    case 'ac': {
      // Hung on the facade, a metre above the storey's floor.
      const c = at(along, dd / 2 + m(0.05));
      const z = floorZ + Math.min(m(1.1), Math.max(0, (volumeElevation(b, v, v.base + bay.storey + 1) - floorZ) / 2));
      return [{ kind, x: c.x, y: c.y, facing, w: dw, d: dd, z, h: dh }];
    }
  }
}

/** An element of `kind` at a free point of the local frame, on the ground (a slab at `z`). */
export function elementAt(b: Building, kind: ElementKind, p: Vec2, facing: Side): Omit<BuildingElement, 'id'> {
  const [w, d, h] = ELEMENT_DEFAULTS[kind];
  const top = b.volumes.reduce((z, v) => Math.max(z, volumeHeight(b, v)), 0);
  const z = kind === 'canopy' ? Math.min(top, m(2.6)) : 0;
  return { kind, x: snap(p.x), y: snap(p.y), facing, w, d, z, h };
}

// ------------------------------------------------------------------ parts through parts

/** Laid on the ground to stand things on (`lotPlan.ts` FLAT_KINDS): a surface, not a footprint. */
const SURFACE_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>(['pavement', 'drain', 'parking']);
/** The lot's boundary and its posts: runs meet each other at joints by design. */
const BOUNDARY_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>(['wall', 'fence', 'hedge', 'railing', 'gate', 'pillar']);
/** Planting, which grows under a tree's crown. */
const PLANT_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>(['flowers', 'shrub', 'hedge', 'planter']);
/** How far two parts may run into each other: a contact, a footing set into paving. */
const MEET = m(0.03);
/** A tree's trunk, and where its crown starts as a share of its height. */
const TRUNK = m(0.4);
const CROWN_FROM = 0.35;

/** The yard's earthworks - a flight, a ramp, a retaining wall in its stone */
function isEarthwork(e: BuildingElement): boolean {
  return e.kind === 'stair' || e.kind === 'ramp' || (e.kind === 'slab' && isRetainingStone(e.material));
}
/** Laid with the lot's structure (its boundary, its earthworks): dressing in its way is cleared. */
export function isStructure(e: BuildingElement): boolean {
  return BOUNDARY_KINDS.has(e.kind) || isEarthwork(e);
}

interface Footprint { readonly cx: number; readonly cy: number; readonly hx: number; readonly hy: number; readonly a: number }

function footprintOf(e: BuildingElement, size?: number): Footprint {
  const alongY = e.facing === 0 || e.facing === 2;
  return {
    cx: e.x, cy: e.y,
    hx: (size ?? (alongY ? e.w : e.d)) / 2, hy: (size ?? (alongY ? e.d : e.w)) / 2,
    a: e.angle ?? 0,
  };
}

/** How deep two turned rectangles run into each other (separating axes); <= 0 when apart. */
function planDepth(p: Footprint, q: Footprint): number {
  // Far apart for any turn (bounding circles), without the trigonometry: most pairs.
  const gap = Math.hypot(q.cx - p.cx, q.cy - p.cy) - Math.hypot(p.hx, p.hy) - Math.hypot(q.hx, q.hy);
  if (gap > 0) return -gap;
  let best = Infinity;
  for (const t of [p.a, p.a + Math.PI / 2, q.a, q.a + Math.PI / 2]) {
    const ux = Math.cos(t), uy = Math.sin(t);
    const reach = (b: Footprint): number =>
      b.hx * Math.abs(Math.cos(b.a) * ux + Math.sin(b.a) * uy) + b.hy * Math.abs(-Math.sin(b.a) * ux + Math.cos(b.a) * uy);
    best = Math.min(best, reach(p) + reach(q) - Math.abs((q.cx - p.cx) * ux + (q.cy - p.cy) * uy));
  }
  return best;
}

/** The radius of a circle round every footprint of a part (`footprintOf`, its own or a trunk's). */
const planReach = (e: BuildingElement): number => Math.hypot(Math.max(e.w, TRUNK), Math.max(e.d, TRUNK)) / 2;

/** Heights running into each other by more than a contact (a flush joint of two plates is a contact). */
const heightsMeet = (a0: number, a1: number, b0: number, b1: number): boolean => Math.min(a1, b1) - Math.max(a0, b0) > MEET + m(0.001);

/** Whether two parts of a lot stand in each other (Etapa 5a) */
export function elementsMeet(a: BuildingElement, b: BuildingElement): boolean {
  // Apart for any turn: the circles round their footprints do not meet
  if (Math.hypot(b.x - a.x, b.y - a.y) > planReach(a) + planReach(b)) return false;
  if (SURFACE_KINDS.has(a.kind) || SURFACE_KINDS.has(b.kind)) return false;
  if (isStructure(a) && isStructure(b)) return false;
  // A plant against a thin run of the boundary grows through it (a shrub through a fence); a shed or a cabinet
  const thinRun = (e: BuildingElement): boolean => (e.kind === 'wall' || e.kind === 'fence' || e.kind === 'railing') && Math.min(e.w, e.d) <= m(0.3);
  if ((PLANT_KINDS.has(a.kind) && thinRun(b)) || (PLANT_KINDS.has(b.kind) && thinRun(a))) return false;
  // Foliage into foliage: a shrub grown into a hedge.
  const foliage = (e: BuildingElement): boolean => e.kind === 'shrub' || e.kind === 'hedge';
  if (foliage(a) && foliage(b)) return false;
  if (a.kind === 'tree' || b.kind === 'tree') {
    const [tree, other] = a.kind === 'tree' ? [a, b] : [b, a];
    if (other.kind === 'tree') return heightsMeet(a.z, a.z + a.h, b.z, b.z + b.h) && planDepth(footprintOf(a, TRUNK), footprintOf(b, TRUNK)) > MEET;
    const crown = tree.z + tree.h * CROWN_FROM;
    const trunkMeets = heightsMeet(tree.z, tree.z + tree.h, other.z, other.z + other.h)
      && planDepth(footprintOf(tree, TRUNK), footprintOf(other)) > MEET;
    if (trunkMeets && !PLANT_KINDS.has(other.kind)) return true;
    return !PLANT_KINDS.has(other.kind) && heightsMeet(crown, tree.z + tree.h, other.z, other.z + other.h)
      && other.z >= crown - MEET && planDepth(footprintOf(tree), footprintOf(other)) > MEET;
  }
  return heightsMeet(a.z, a.z + a.h, b.z, b.z + b.h) && planDepth(footprintOf(a), footprintOf(b)) > MEET + m(0.001);
}
