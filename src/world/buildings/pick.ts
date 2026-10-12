import { bayWidth, baysOn, elementRect, storedBounds, roofHeightAt, roofRise, volumeElevation, volumeHeight, volumeRectLocal, worldToLocal } from './geometry';
import { chartAt, chartToChartInto } from '../planet/charts';
import { containsPoint, edgeFrame, volumeSides } from './footprints';
import type { Building, BuildingId, FaceId } from './types';
import { m } from '../units';

/**
 * A ray, in WORLD axes: x and y on the map, z up. The editor gets one from
 * the viewport for the pixel under the pointer (see `ToolView.ray`).
 */
export interface Ray3 {
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

export interface BuildingHit {
  readonly building: BuildingId;
  readonly volume: number;
  /** The face hit: a side of the volume, or its roof. */
  readonly face: FaceId | 'top';
  /** Level hit, for a side face. */
  readonly level: number;
  /** Storey index within the volume, for a side face. */
  readonly storey: number;
  /** Bay index along the face, for a side face. */
  readonly index: number;
  /** The free element hit, when it was one rather than a volume. */
  readonly element?: number;
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The nearest building face under a ray.
 *
 * `floorOf` gives each building's absolute ground-floor height (its
 * foundation), which the caller caches: sampling the ground for every
 * building on every pointer move would be the slow part.
 */
/**
 * The ray on the chart a building is kept on (on the planet,
 * `world/planet/charts.ts`): the same two points of the line - on the ground
 * and 100 up, where the view gives it (`ToolView.ray`) - written on that
 * chart, the origin as far back along it as before, so the distances along
 * it (`t`) of two buildings on two charts still compare. A ray read as it
 * stands against a building kept on the next piece's chart was 1 600 units
 * or more away from it: that part of a building could not be picked.
 */
function rayOnChartOf(ray: Ray3, b: Building): Ray3 {
  if (!__PLANET__ || ray.dz === 0) return ray;
  const t0 = -ray.oz / ray.dz, t1 = (m(40) - ray.oz) / ray.dz;
  const gx = ray.ox + ray.dx * t0, gy = ray.oy + ray.dy * t0;
  const from = chartAt(gx, gy), to = chartAt(b.x, b.y);
  if (from === to) return ray;
  const low = chartToChartInto(from, to, gx, gy, { x: 0, y: 0 });
  const high = chartToChartInto(from, to, ray.ox + ray.dx * t1, ray.oy + ray.dy * t1, { x: 0, y: 0 });
  const dx = low.x - high.x, dy = low.y - high.y, dz = -m(40);
  const len = Math.hypot(dx, dy, dz);
  const ux = dx / len, uy = dy / len, uz = dz / len;
  return { ox: high.x - ux * t1, oy: high.y - uy * t1, oz: m(40) - uz * t1, dx: ux, dy: uy, dz: uz };
}

export function pickBuilding(
  buildings: Iterable<Building>,
  seen: Ray3,
  floorOf: (b: Building) => number,
): BuildingHit | null {
  let best: BuildingHit | null = null;
  for (const b of buildings) {
    const ray = rayOnChartOf(seen, b);
    // Cheap reject first, before the floor (which samples the ground and the
    // footways): the ray's footprint over any height. Every building in town
    // had its floor worked out for every click - 85 ms a click in the default
    // town (docs/performance.md).
    // The box kept with the record (`storedBounds`): worked out again for
    // every building on every click it was 83 ms of a bomb's click (2026-10-09).
    const box = storedBounds(b, 1);
    if (!rayNearBox(ray, box, -1e6, 1e6)) continue;
    const floor = floorOf(b);
    // The ray's footprint over the building's height span.
    if (!rayNearBox(ray, box, floor - m(0.8), floor + m(160))) continue;
    const c = Math.cos(b.rotation);
    const s = Math.sin(b.rotation);
    const o = worldToLocal(b, { x: ray.ox, y: ray.oy });
    // Directions rotate without the translation.
    const dx = ray.dx * c + ray.dy * s;
    const dy = -ray.dx * s + ray.dy * c;
    for (const v of b.volumes) {
      if (v.outline) {
        const z0 = floor + volumeElevation(b, v, v.base);
        const z1 = floor + volumeHeight(b, v) + roofRise(b, v);
        const makeHit = (t: number, face: FaceId | 'top', along: number): BuildingHit => {
          const lx = o.x + dx * t, ly = o.y + dy * t;
          const z = ray.oz + ray.dz * t;
          let level = v.base;
          for (let k = 0; k < v.storeys.length; k++) if (z - floor >= volumeElevation(b, v, v.base + k) - 1e-6) level = v.base + k;
          const side = face === 'top' ? 0 : face;
          return {
            building: b.id, volume: v.id, face, level, storey: level - v.base,
            index: Math.max(0, Math.min(baysOn(b, v, side) - 1, Math.floor(along / bayWidth(b, v, side)))),
            t, x: b.x + lx * c - ly * s, y: b.y + lx * s + ly * c, z,
          };
        };
        if (ray.dz !== 0) {
          let t = (z1 - ray.oz) / ray.dz;
          for (let i = 0; i < 4; i++) {
            const p = { x: o.x + dx * t, y: o.y + dy * t };
            t = (floor + volumeHeight(b, v) + roofHeightAt(b, v, p) - ray.oz) / ray.dz;
          }
          if (t >= 0 && (!best || t < best.t) && containsPoint(v, { x: o.x + dx * t, y: o.y + dy * t })) best = makeHit(t, 'top', 0);
        }
        for (const side of volumeSides(v)) {
          const f = edgeFrame(v, side);
          const denom = dx * f.nx + dy * f.ny;
          if (Math.abs(denom) < 1e-9) continue;
          const t = ((f.x - o.x) * f.nx + (f.y - o.y) * f.ny) / denom;
          if (t < 0 || (best && t >= best.t)) continue;
          const px = o.x + dx * t, py = o.y + dy * t, h = ray.oz + ray.dz * t;
          const along = (px - f.x) * f.tx + (py - f.y) * f.ty;
          if (along < -1e-5 || along > f.length + 1e-5 || h < z0 || h > z1) continue;
          best = makeHit(t, side, along);
        }
        continue;
      }
      const [x0, y0, x1, y1] = volumeRectLocal(b, v);
      // The block's own heights: a block at a floor of its own (`Volume.lift`) is picked where it is drawn.
      const z0 = floor + volumeElevation(b, v, v.base);
      const z1 = floor + volumeHeight(b, v) + roofRise(b, v) * 0.5;
      const hit = slab([o.x, o.y, ray.oz], [dx, dy, ray.dz], [x0, y0, z0], [x1, y1, z1]);
      if (!hit || (best && hit.t >= best.t)) continue;
      let t = hit.t;
      if (hit.axis === 2 && ray.dz !== 0) {
        for (let i = 0; i < 4; i++) {
          const p = { x: o.x + dx * t, y: o.y + dy * t };
          t = (floor + volumeHeight(b, v) + roofHeightAt(b, v, p) - ray.oz) / ray.dz;
        }
      }
      const lx = o.x + dx * t;
      const ly = o.y + dy * t;
      const z = ray.oz + ray.dz * t;
      if (hit.axis === 2 && (t < 0 || lx < x0 || lx > x1 || ly < y0 || ly > y1)) continue;
      if (best && t >= best.t) continue;
      let face: FaceId | 'top';
      if (hit.axis === 2) face = 'top';
      else if (hit.axis === 0) face = hit.negative ? 3 : 1;
      else face = hit.negative ? 0 : 2;
      let level = v.base;
      const zr = z - floor;
      for (let k = 0; k < v.storeys.length; k++) {
        if (zr >= volumeElevation(b, v, v.base + k) - 1e-6) level = v.base + k;
      }
      const side = face === 'top' ? 0 : face;
      const along = (face === 0 || face === 2 ? lx - v.x : ly - v.y) / bayWidth(b, v, side);
      const index = Math.max(0, Math.min(baysOn(b, v, side) - 1, Math.floor(along)));
      const world = { x: b.x + lx * c - ly * s, y: b.y + lx * s + ly * c };
      best = {
        building: b.id,
        volume: v.id,
        face,
        level,
        storey: level - v.base,
        index,
        t,
        x: world.x,
        y: world.y,
        z,
      };
    }
    for (const el of b.elements ?? []) {
      const [x0, y0, x1, y1] = elementRect(el);
      const hit = slab([o.x, o.y, ray.oz], [dx, dy, ray.dz], [x0, y0, floor + el.z], [x1, y1, floor + el.z + el.h]);
      if (!hit || (best && hit.t >= best.t)) continue;
      const lx = o.x + dx * hit.t;
      const ly = o.y + dy * hit.t;
      best = {
        building: b.id,
        volume: b.volumes[0]?.id ?? 1,
        face: 'top',
        level: 0,
        storey: 0,
        index: 0,
        element: el.id,
        t: hit.t,
        x: b.x + lx * c - ly * s,
        y: b.y + lx * s + ly * c,
        z: ray.oz + ray.dz * hit.t,
      };
    }
  }
  return best;
}

function rayNearBox(
  ray: Ray3,
  box: { minX: number; minY: number; maxX: number; maxY: number },
  zMin: number,
  zMax: number,
): boolean {
  return slab(
    [ray.ox, ray.oy, ray.oz],
    [ray.dx, ray.dy, ray.dz],
    [box.minX, box.minY, zMin],
    [box.maxX, box.maxY, zMax],
  ) !== null;
}

/** Ray against an axis-aligned box: entry distance and the axis entered through. */
function slab(
  o: readonly [number, number, number],
  d: readonly [number, number, number],
  lo: readonly [number, number, number],
  hi: readonly [number, number, number],
): { t: number; axis: number; negative: boolean } | null {
  let tNear = -Infinity;
  let tFar = Infinity;
  let axis = -1;
  let negative = false;
  for (let i = 0; i < 3; i++) {
    const oi = o[i] as number;
    const di = d[i] as number;
    const a = lo[i] as number;
    const b = hi[i] as number;
    if (Math.abs(di) < 1e-12) {
      if (oi < a || oi > b) return null;
      continue;
    }
    let t1 = (a - oi) / di;
    let t2 = (b - oi) / di;
    let neg = true;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      neg = false;
    }
    if (t1 > tNear) {
      tNear = t1;
      axis = i;
      negative = neg;
    }
    tFar = Math.min(tFar, t2);
    if (tNear > tFar) return null;
  }
  if (tFar < 0 || axis < 0) return null;
  return { t: Math.max(0, tNear), axis, negative };
}
