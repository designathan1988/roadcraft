import { COARSE_EPS } from '@core/scalar';
import { Ring } from '@core/ring';
import { type Vec2, addScaled, dot } from '@core/vec2';
import { type RoadSide, type RoadType, SURFACE_LEVELS, halfWidth, sideHalfWidth, symmetric } from '../roadTypes';
import type { Leg } from './legs';
import { m } from '../units';

/**
 * A road that simply carries on as a wider or narrower one.
 *
 * A node of two legs whose widths differ used to be built as a junction like
 * any other: a mouth on each leg, a straight chord between them at 12 degrees,
 * and each leg's full-width carriageway rectangle ("tongue") run back to the
 * node. The tongue of the wide leg stuck out past the chord, so the width
 * stepped at the node, the kerb and footway were notched, and the painted
 * approach - a zebra and a stop line on each leg, no markings inside - told the
 * eye it was an intersection. The player's screenshot of an urban street
 * running into a boulevard is exactly that.
 *
 * What a road designer builds there is a TAPER: the carriageway, the kerbs and
 * the footways all widen together over a length set by how far the kerb has to
 * move, the edge lines follow the kerb, and the lanes the two roads share run
 * straight through. This module draws that shape.
 */

/**
 * Run of a taper per unit of lateral change of the kerb line: 1 in 8.
 *
 * The shape is a smoothstep, whose steepest point is 1.5 times its mean, so the
 * kerb turns at most 1 in 5.3 (11 degrees) and eases in and out at both ends.
 * That is the short end of what the references allow on an urban street at
 * 50 km/h - the MUTCD's shifting taper for 30 mph is `W S^2 / 120`, about 1 in
 * 7.5 per lane width, and AASHTO's lane-addition tapers run 8:1 to 15:1 - and
 * it was chosen at the short end on purpose: the taper is also the length of
 * the movement through it, and at 1 in 12 the lane drop of a street widening
 * into a boulevard held the merging lane still for 47 s
 * (`tests/sim/classJoin.spec.ts`, limit 45) against 38 s at 1 in 8. The old
 * straight chord at 12 DEGREES was 1 in 4.7 with a notch at the node.
 */
export const TAPER_RATIO = 8;
/** Shortest taper worth drawing, end to end, in world units. */
export const TAPER_MIN = m(9.6);
/**
 * Largest bend at a node of two legs that is still one road running on: a
 * taper (when the widths differ), no zebra and no stop line. Past it the node
 * is a corner, crossed on foot, and built as a junction.
 */
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

/**
 * The largest change of half-width from one leg into the other, SIDE BY
 * SIDE: a road running on keeps its left side along the other's right side
 * (`+nrm` of one leg is `-nrm` of the other). The same as `widthStep` for
 * two symmetric roads; an asymmetric road turned round is a step on both
 * sides though its widest half-width is unchanged (docs/VIAS.md V1).
 */
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

/**
 * How far each leg is given over to the taper, from the node.
 *
 * One number for every surface level, so the kerb band keeps its width and the
 * footway grows smoothly: levels tapered over different lengths would cross.
 */
export function transitionRun(a: RoadType, b: RoadType): number {
  return transitionRunFor(widthStep(a, b));
}

/** `transitionRun` for a width step already measured (`legWidthStep`). */
export function transitionRunFor(step: number): number {
  return Math.max(TAPER_MIN, step * TAPER_RATIO) / 2;
}

/** Ease of the cross-section from the first leg's to the second's. */
export const taperEase = (u: number): number => {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  return t * t * (3 - 2 * t);
};

/**
 * The centreline of a transition, from the mouth of the first leg to the mouth
 * of the second: a cubic whose ends are tangent to both legs, with handles of a
 * third of the chord so that on a straight road its parameter IS arc length.
 */
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

/**
 * The outline of one surface level of a transition: both kerb lines of the
 * taper, from mouth to mouth. Nothing else - no tongues, which is what put the
 * wide leg's full width back at the node.
 */
export function transitionRing(legs: readonly Leg[], trims: readonly number[]): Ring {
  const a = legs[0] as Leg;
  const b = legs[1] as Leg;
  const axis = new TransitionAxis(a, trims[0] as number, b, trims[1] as number);
  // The axis runs from leg a into leg b: its left is a's `-nrm` side and
  // b's `+nrm` side, its right a's `+nrm` side and b's `-nrm` side. Each
  // side tapers from its own width to its own width (docs/VIAS.md V1).
  const halfLeft = (u: number): number => a.hwRight + (b.hwLeft - a.hwRight) * taperEase(u);
  const halfRight = (u: number): number => a.hwLeft + (b.hwRight - a.hwLeft) * taperEase(u);
  const left = axis.offset(halfLeft);
  const right = axis.offset((u) => -halfRight(u)).reverse();
  return Ring.fromPolygon([...left, ...right]).ensurePositive();
}
