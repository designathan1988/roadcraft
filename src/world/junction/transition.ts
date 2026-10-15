import { COARSE_EPS } from '@core/scalar';
import { Ring } from '@core/ring';
import { type Vec2, addScaled, dot } from '@core/vec2';
import { type RoadSide, type RoadType, SURFACE_LEVELS, halfWidth, sideHalfWidth, symmetric } from '../roadTypes';
import type { Leg } from './legs';
import { m } from '../units';

/** A road that simply carries on as a wider or narrower one. */

/** Run of a taper per unit of lateral change of the kerb line: 1 in 8. */
export const TAPER_RATIO = 8;
/** Shortest taper worth drawing, end to end, in world units. */
const TAPER_MIN = m(9.6);
/** Largest bend at a node of two legs that is still one road running on: no zebra and no stop line */
export const TRANSITION_BEND = (30 * Math.PI) / 180;
/** Taper length between two cross-sections when the outline is sampled. */
const SAMPLE_STEP = m(1.6);

/** Whether two legs meeting at a node form a straight-through change of width. */
export function isTransition(legs: readonly Leg[]): boolean {
  if (legs.length !== 2) return false;
  const a = legs[0] as Leg;
  const b = legs[1] as Leg;
  if (dot(a.dir, b.dir) > -Math.cos(TRANSITION_BEND)) return false;
  return legWidthStep(a, b) >= COARSE_EPS;
}

/** The largest change of half-width from one leg into the other, SIDE BY SIDE */
export function legWidthStep(a: Leg, b: Leg): number {
  if (symmetric(a.road) && symmetric(b.road)) return widthStep(a.road, b.road);
  const other = (side: RoadSide): RoadSide => (side === 'left' ? 'right' : 'left');
  let step = Math.abs(a.road.median - b.road.median) / 2;
  for (const level of SURFACE_LEVELS) {
    step = Math.max(step,
      Math.abs(sideHalfWidth(a.road, level, a.plusSide) - sideHalfWidth(b.road, level, other(b.plusSide))),
      Math.abs(sideHalfWidth(a.road, level, other(a.plusSide)) - sideHalfWidth(b.road, level, b.plusSide)));
  }
  return step;
}

/** The largest change of half-width between two profiles, over every level and the median. */
export function widthStep(a: RoadType, b: RoadType): number {
  let step = Math.abs(a.median - b.median) / 2;
  for (const level of SURFACE_LEVELS) step = Math.max(step, Math.abs(halfWidth(a, level) - halfWidth(b, level)));
  return step;
}

/** How far each leg is given over to the taper, from the node. */
export function transitionRunFor(step: number): number {
  return Math.max(TAPER_MIN, step * TAPER_RATIO) / 2;
}

/** Ease of the cross-section from the first leg's to the second's. */
export const taperEase = (u: number): number => {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  return t * t * (3 - 2 * t);
};

/** The centreline of a transition, from the mouth of the first leg to the mouth of the second */
export class TransitionAxis {
  readonly p0: Vec2;
  readonly p1: Vec2;
  readonly p2: Vec2;
  readonly p3: Vec2;
  readonly length: number;

  constructor(from: Leg, fromTrim: number, to: Leg, toTrim: number) {
    this.p0 = addScaled(from.origin, from.dir, fromTrim);
    this.p3 = addScaled(to.origin, to.dir, toTrim);
    const chord = Math.hypot(this.p3.x - this.p0.x, this.p3.y - this.p0.y);
    this.p1 = addScaled(this.p0, from.dir, -chord / 3);
    this.p2 = addScaled(this.p3, to.dir, -chord / 3);
    this.length = chord;
  }

  point(u: number): Vec2 {
    const v = 1 - u;
    const a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
    return {
      x: a * this.p0.x + b * this.p1.x + c * this.p2.x + d * this.p3.x,
      y: a * this.p0.y + b * this.p1.y + c * this.p2.y + d * this.p3.y,
    };
  }

  /** Unit LEFT normal of the direction of travel from the first leg to the second. */
  normal(u: number): Vec2 {
    const v = 1 - u;
    const tx = 3 * v * v * (this.p1.x - this.p0.x) + 6 * v * u * (this.p2.x - this.p1.x) + 3 * u * u * (this.p3.x - this.p2.x);
    const ty = 3 * v * v * (this.p1.y - this.p0.y) + 6 * v * u * (this.p2.y - this.p1.y) + 3 * u * u * (this.p3.y - this.p2.y);
    const l = Math.hypot(tx, ty) || 1;
    return { x: -ty / l, y: tx / l };
  }

  /** Parameters of the cross-sections an outline or a stroke is sampled at. */
  samples(): number[] {
    const count = Math.max(8, Math.ceil(this.length / SAMPLE_STEP));
    const out: number[] = [];
    for (let i = 0; i <= count; i++) out.push(i / count);
    return out;
  }

  /** Points `offset(u)` to the left of the axis, one per sample. */
  offset(offset: (u: number) => number): Vec2[] {
    return this.samples().map((u) => addScaled(this.point(u), this.normal(u), offset(u)));
  }
}

/** The outline of one surface level of a transition: both kerb lines of the taper, from mouth to mouth. */
export function transitionRing(legs: readonly Leg[], trims: readonly number[]): Ring {
  const a = legs[0] as Leg;
  const b = legs[1] as Leg;
  const axis = new TransitionAxis(a, trims[0] as number, b, trims[1] as number);
  // The axis runs from leg a into leg b
  const halfLeft = (u: number): number => a.hwRight + (b.hwLeft - a.hwRight) * taperEase(u);
  const halfRight = (u: number): number => a.hwLeft + (b.hwRight - a.hwLeft) * taperEase(u);
  const left = axis.offset(halfLeft);
  const right = axis.offset((u) => -halfRight(u)).reverse();
  return Ring.fromPolygon([...left, ...right]).ensurePositive();
}
