import type { Vec2 } from '@core/vec2';
import { m } from '../units';
import { buildingFrame, frameToLocal, frameToWorld, frameX, frameY } from './geometry';
import type { Building, Volume } from './types';

/**
 * The surface of a building's open lot - its car park, its yard - as it is
 * laid: level with the street along the edge it opens onto, falling or rising
 * with that street from one end to the other, and meeting the building's ground
 * floor along the far edge. A car drives in off the street.
 *
 * A flat plate at the ground floor's height stood on a retaining wall two
 * metres high at the low end of a sloping street, and a car could not get in.
 */
export interface LotSurface {
  readonly volume: Volume;
  /** World corners of the lot. */
  readonly ring: readonly Vec2[];
  /** Height of the surface at a world point (extrapolated outside the lot). */
  heightAt(x: number, y: number): number;
}

/** The pavement height at a world point, or NaN where there is none. */
export type PavingAt = (x: number, y: number) => number;

/** Rise of a lot's edge over the pavement it meets. */
const KERB_RISE = m(0.04);
/** How far outside a lot's edge the street is looked for. */
const LOOK_OUT = m(0.6);

export function lotSurfaces(b: Building, floor: number, pavedAt?: PavingAt): LotSurface[] {
  const out: LotSurface[] = [];
  // The building's frame once: a lot's height is asked at every corner of the ground its bank reaches (`pads.ts`).
  const f = buildingFrame(b);
  for (const v of b.volumes) {
    if (!v.open) continue;
    const x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.d;
    const ring = [frameToWorld(f, x0, y0), frameToWorld(f, x1, y0), frameToWorld(f, x1, y1), frameToWorld(f, x0, y1)];
    // The street edge: the side with pavement outside it at both ends.
    const at = (lx: number, ly: number): number => (pavedAt ? pavedAt(frameX(f, lx, ly), frameY(f, lx, ly)) : NaN);
    const sides = [
      { a: at(x0 + v.w * 0.06, y0 - LOOK_OUT), b: at(x1 - v.w * 0.06, y0 - LOOK_OUT) },
      { a: at(x1 + LOOK_OUT, y0 + v.d * 0.06), b: at(x1 + LOOK_OUT, y1 - v.d * 0.06) },
      { a: at(x0 + v.w * 0.06, y1 + LOOK_OUT), b: at(x1 - v.w * 0.06, y1 + LOOK_OUT) },
      { a: at(x0 - LOOK_OUT, y0 + v.d * 0.06), b: at(x0 - LOOK_OUT, y1 - v.d * 0.06) },
    ];
    const street = sides.findIndex((s) => Number.isFinite(s.a) && Number.isFinite(s.b));
    const local = (x: number, y: number): Vec2 => frameToLocal(f, x, y);
    // A terrace of a hillside lot is laid at its own level (cut and fill kept
    // near the natural ground), held by the retaining wall the lot planner
    // stands at its edge; one on a street still meets the street.
    const level = floor + (v.terrace ?? 0);
    let heightAt: (x: number, y: number) => number = () => level;
    if (v.ramp !== undefined) {
      // A drive's ramp (`Volume.ramp`): straight along its depth, from its
      // front edge's level to its back edge's.
      const from = floor + v.ramp;
      heightAt = (x, y) => {
        const p = local(x, y);
        return from + (level - from) * Math.max(0, Math.min(1, (p.y - y0) / v.d));
      };
    } else if (street >= 0 && v.terrace === undefined) {
      const ha = sides[street]!.a + KERB_RISE, hb = sides[street]!.b + KERB_RISE;
      const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));
      heightAt = (x, y) => {
        const p = local(x, y);
        const u = clamp01((p.x - x0) / v.w), w = clamp01((p.y - y0) / v.d);
        switch (street) {
          case 0: return (ha + (hb - ha) * u) * (1 - w) + floor * w;
          case 2: return (ha + (hb - ha) * u) * w + floor * (1 - w);
          case 1: return (ha + (hb - ha) * w) * u + floor * (1 - u);
          default: return (ha + (hb - ha) * w) * (1 - u) + floor * u;
        }
      };
    }
    out.push({ volume: v, ring, heightAt });
  }
  return out;
}
