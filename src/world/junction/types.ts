import type { Ring } from '@core/ring';
import type { Vec2 } from '@core/vec2';
import type { Fillet } from '@core/fillet';
import type { NodeId, SegmentId } from '../ids';
import type { RoadSide, RoadType, SegmentDirection, SurfaceLevel } from '../roadTypes';

/**
 * WHAT A JUNCTION IS, APART FROM HOW IT IS SOLVED: the shapes `legs.ts`, `corners.ts` and `build.ts` make and `levels.ts` keeps. DO NOT
 * define them where they are solved again: `levels.ts` read them there, and through them the document, and stood in the world's import
 * cycle with every reader of the network (`tests/arch/imports.spec.ts`).
 */

/** One approach arm of a junction, resolved at a specific surface level. */
export interface Leg {
  readonly seg: SegmentId;
  readonly far: NodeId;
  readonly origin: Vec2;
  readonly dir: Vec2;
  readonly nrm: Vec2;
  readonly ang: number;
  /** Half-width of this leg at the level being built: the wider of its two sides. */
  readonly hw: number;
  /** Half-width on the `+nrm` side and on the `-nrm` side of the leg */
  readonly hwLeft: number;
  readonly hwRight: number;
  /** Which side of its road the leg's `+nrm` side is: the left from `a`, the right from `b`. */
  readonly plusSide: RoadSide;
  /** Half-width at the sidewalk level, used to size curb radii consistently. */
  readonly hwSidewalk: number;
  /** Total arc length of the segment carrying this leg. */
  readonly length: number;
  readonly typeIndex: number;
  readonly direction: SegmentDirection;
  /** Whether any traffic on this leg travels TOWARD the junction. */
  readonly approaching: boolean;
  readonly road: RoadType;
  /** The travel way's offset from the centreline in this leg's frame (+nrm positive) */
  readonly shift: number;
}

export type CornerMode = 'fillet' | 'bevel' | 'collinear' | 'taper';

export interface Corner {
  /** Index of the leg whose LEFT boundary feeds this corner. */
  readonly i: number;
  /** Index of the leg whose RIGHT boundary leaves this corner. */
  readonly j: number;
  readonly mode: CornerMode;
  /** Intersection of the two boundary lines. Null in collinear/taper mode. */
  readonly x: Vec2 | null;
  /** Wedge angle at `x`, in radians. */
  readonly psi: number;
  readonly fillet: Fillet | null;
  /** Trim contribution this corner demands of leg `i`. */
  readonly trimI: number;
  /** Trim contribution this corner demands of leg `j`. */
  readonly trimJ: number;
}

export interface Junction {
  readonly nodeId: NodeId;
  readonly level: SurfaceLevel;
  readonly legs: readonly Leg[];
  readonly corners: readonly Corner[];
  /** Trim distance per leg, indexed the same way as `legs`. */
  readonly trims: readonly number[];
  /** The corner boundary: mouth cuts joined by curb returns. */
  readonly ring: Ring;
  /** Per-leg carriageway rectangles from the node out to each mouth. */
  readonly tongues: readonly Ring[];
  /** Everything this junction contributes to its level, unioned by the painter. */
  readonly rings: readonly Ring[];
  readonly usedHullFallback: boolean;
  /** True for a node of two legs where one road carries on at another width: the outline is a taper */
  readonly transition: boolean;
}

/** What `levels.ts` makes a node's levels again with, handed in by who solves them (`networkBuild.ts`): the solver's own functions, the same. */
export interface JunctionKit {
  /** `legs.ts` */
  legOf(d: Leg): Leg;
  packLegs(legs: readonly Leg[], roads: RoadType[]): number[];
  unpackLegs(nums: readonly number[], roads: readonly RoadType[]): Leg[];
  /** `corners.ts` */
  packCorners(corners: readonly Corner[]): number[];
  unpackCorners(nums: readonly number[]): Corner[];
  /** `polygon.ts` */
  nodeCentre(legs: readonly Leg[]): Vec2;
  legTongue(leg: Leg, trim: number): Ring | null;
  nodeCap(legs: readonly Leg[], centre: Vec2): Ring | null;
  /** `derive.ts` */
  baseTrims(base: Junction): Map<SegmentId, number>;
  deriveFromLegs(base: Junction, level: SurfaceLevel, legs: readonly Leg[]): Junction | null;
}
