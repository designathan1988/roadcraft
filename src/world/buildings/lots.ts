import type { Vec2 } from '@core/vec2';
import { m } from '../units';
import { type BuildingFrame, buildingFrame, frameToLocal, frameToWorld, frameX, frameY } from './geometry';
import type { Building, Volume } from './types';

/** The surface of a building's open lot - its car park, its yard - as it is laid */
export interface LotSurface {
  readonly volume: Volume;
  /** World corners of the lot. */
  readonly ring: readonly Vec2[];
  /** The surface as plain numbers (`lotHeightAt`): what the ground's shaping off the page reads of it. */
  readonly slope: LotSlope;
  /** Height of the surface at a world point (extrapolated outside the lot). */
  heightAt(x: number, y: number): number;
}

/** A lot's surface as plain numbers, copied to a worker as they are */
export type LotSlope =
  | { readonly kind: 'level'; readonly level: number }
  | { readonly kind: 'ramp'; readonly frame: BuildingFrame; readonly from: number; readonly level: number; readonly y0: number; readonly d: number }
  | {
    readonly kind: 'street'; readonly frame: BuildingFrame; readonly side: number;
    readonly x0: number; readonly y0: number; readonly w: number; readonly d: number;
    readonly ha: number; readonly hb: number; readonly floor: number;
  };

const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));

/** DO NOT change its arithmetic for one side only */
export function lotHeightAt(s: LotSlope, x: number, y: number): number {
  if (s.kind === 'level') return s.level;
  const p = frameToLocal(s.frame, x, y);
  if (s.kind === 'ramp') return s.from + (s.level - s.from) * Math.max(0, Math.min(1, (p.y - s.y0) / s.d));
  const { ha, hb, floor } = s;
  const u = clamp01((p.x - s.x0) / s.w), w = clamp01((p.y - s.y0) / s.d);
  switch (s.side) {
    case 0: return (ha + (hb - ha) * u) * (1 - w) + floor * w;
    case 2: return (ha + (hb - ha) * u) * w + floor * (1 - w);
    case 1: return (ha + (hb - ha) * w) * u + floor * (1 - u);
    default: return (ha + (hb - ha) * w) * (1 - u) + floor * u;
  }
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
    // A terrace of a hillside lot is laid at its own level
    const level = floor + (v.terrace ?? 0);
    let slope: LotSlope = { kind: 'level', level };
    if (v.ramp !== undefined) {
      // A drive's ramp (`Volume.ramp`): straight along its depth, from its front edge's level to its back edge's.
      slope = { kind: 'ramp', frame: f, from: floor + v.ramp, level, y0, d: v.d };
    } else if (street >= 0 && v.terrace === undefined) {
      slope = {
        kind: 'street', frame: f, side: street, x0, y0, w: v.w, d: v.d,
        ha: sides[street]!.a + KERB_RISE, hb: sides[street]!.b + KERB_RISE, floor,
      };
    }
    const lot = slope;
    out.push({ volume: v, ring, slope: lot, heightAt: (x, y) => lotHeightAt(lot, x, y) });
  }
  return out;
}
