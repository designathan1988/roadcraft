import { type Vec2, addScaled, angleOf } from '@core/vec2';
import { LEG_TRIM_CAP } from '../approach';
import type { RoadDoc, SegmentDirection } from '../doc';
import type { NodeId, SegmentId } from '../ids';
import { type RoadSide, type RoadType, type SurfaceLevel, halfWidth, roadProfile, sideHalfWidth, sidewalkHalf, symmetric, travelShift } from '../roadTypes';
import { type PolylineCache, frameFromNode, farNode, segmentStartsAt } from '../geometry';

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

/** A leg as plain data, every field its own (`legData`, `legOf`): what a message's clone keeps of it (`NetworkBake`). */
export type LegData = { -readonly [K in keyof Leg]: Leg[K] };

/** Where a leg's numbers stand in its run (`PackedLeg`). */
const OX = 0, OY = 1, DX = 2, DY = 3, NX = 4, NY = 5, ANG = 6, HW = 7, HW_LEFT = 8, HW_RIGHT = 9, HW_SIDEWALK = 10, LENGTH = 11, SHIFT = 12;

/**
 * DO NOT keep a leg as an object of points and numbers (three points and seven boxed numbers, ~300 B a leg, four levels of every
 * junction: 2026-10-21): its numbers in one run of doubles, its points made when read. A class: a message's clone of it keeps no
 * getter, so it crosses as `legData` and is made again by `legOf`.
 */
class PackedLeg implements Leg {
  constructor(
    readonly seg: SegmentId,
    readonly far: NodeId,
    readonly plusSide: RoadSide,
    readonly typeIndex: number,
    readonly direction: SegmentDirection,
    readonly approaching: boolean,
    readonly road: RoadType,
    private readonly v: readonly number[],
  ) {}

  get origin(): Vec2 { return { x: this.v[OX]!, y: this.v[OY]! }; }
  get dir(): Vec2 { return { x: this.v[DX]!, y: this.v[DY]! }; }
  get nrm(): Vec2 { return { x: this.v[NX]!, y: this.v[NY]! }; }
  get ang(): number { return this.v[ANG]!; }
  get hw(): number { return this.v[HW]!; }
  get hwLeft(): number { return this.v[HW_LEFT]!; }
  get hwRight(): number { return this.v[HW_RIGHT]!; }
  get hwSidewalk(): number { return this.v[HW_SIDEWALK]!; }
  get length(): number { return this.v[LENGTH]!; }
  get shift(): number { return this.v[SHIFT]!; }
}

/** A leg kept compact (`PackedLeg`) from its fields. */
export function legOf(d: Leg): Leg {
  const v = new Array<number>(SHIFT + 1);
  v[OX] = d.origin.x; v[OY] = d.origin.y; v[DX] = d.dir.x; v[DY] = d.dir.y; v[NX] = d.nrm.x; v[NY] = d.nrm.y;
  v[ANG] = d.ang; v[HW] = d.hw; v[HW_LEFT] = d.hwLeft; v[HW_RIGHT] = d.hwRight; v[HW_SIDEWALK] = d.hwSidewalk; v[LENGTH] = d.length; v[SHIFT] = d.shift;
  return new PackedLeg(d.seg, d.far, d.plusSide, d.typeIndex, d.direction, d.approaching, d.road, v);
}

/** A road's directions by number, for `packLegs`. */
const DIRECTIONS: readonly SegmentDirection[] = ['both', 'aToB', 'bToA'];
/** How many numbers `packLegs` gives a leg: its road, far node, side, type, direction, approach and profile (an index into the roads), then its run (`PackedLeg`). */
const LEG_PACK = 7 + SHIFT + 1;

/**
 * Legs as one run of numbers, their profiles in `roads` (each once: a message's clone keeps one copy of an object it meets twice):
 * DO NOT hand a thread a leg as an object of points - the page took 0.4 s to read back the junctions of the city of 70,000 buildings
 * solved off it (2026-10-22).
 */
export function packLegs(legs: readonly Leg[], roads: RoadType[]): number[] {
  const out: number[] = [];
  for (const leg of legs) {
    let road = roads.indexOf(leg.road);
    if (road < 0) road = roads.push(leg.road) - 1;
    out.push(leg.seg, leg.far, leg.plusSide === 'left' ? 1 : 0, leg.typeIndex, DIRECTIONS.indexOf(leg.direction), leg.approaching ? 1 : 0, road,
      leg.origin.x, leg.origin.y, leg.dir.x, leg.dir.y, leg.nrm.x, leg.nrm.y, leg.ang, leg.hw, leg.hwLeft, leg.hwRight, leg.hwSidewalk, leg.length, leg.shift);
  }
  return out;
}

/** The legs of `packLegs`. */
export function unpackLegs(nums: readonly number[], roads: readonly RoadType[]): Leg[] {
  const out: Leg[] = [];
  for (let k = 0; k < nums.length; k += LEG_PACK) {
    out.push(new PackedLeg(nums[k]! as SegmentId, nums[k + 1]! as NodeId, nums[k + 2] === 1 ? 'left' : 'right', nums[k + 3]!,
      DIRECTIONS[nums[k + 4]!]!, nums[k + 5] === 1, roads[nums[k + 6]!]!, nums.slice(k + 7, k + LEG_PACK)));
  }
  return out;
}

/** A leg's fields as plain data (`LegData`). */
export function legData(leg: Leg): LegData {
  return {
    seg: leg.seg, far: leg.far, origin: leg.origin, dir: leg.dir, nrm: leg.nrm, ang: leg.ang, hw: leg.hw, hwLeft: leg.hwLeft,
    hwRight: leg.hwRight, plusSide: leg.plusSide, hwSidewalk: leg.hwSidewalk, length: leg.length, typeIndex: leg.typeIndex,
    direction: leg.direction, approaching: leg.approaching, road: leg.road, shift: leg.shift,
  };
}

export interface LegBuildOptions {
  /** Per-leg trim guesses, keyed by SEGMENT. */
  readonly trims?: ReadonlyMap<SegmentId, number>;
}

/** Builds the legs of a node, sorted counter-clockwise by outgoing angle. */
export function buildLegs(
  doc: RoadDoc,
  cache: PolylineCache,
  nodeId: NodeId,
  level: SurfaceLevel,
  opts: LegBuildOptions = {},
): Leg[] {
  const node = doc.node(nodeId);
  if (!node) return [];

  // Stable input order so cluster/leg indices are deterministic across rebuilds.
  const incident = node.incident.slice().sort((x, y) => x - y);

  const legs: Leg[] = incident.map((segId) => {
    const seg = doc.requireSegment(segId);
    const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking);
    const pl = cache.get(doc, segId);
    const startsHere = segmentStartsAt(seg, nodeId);
    // The leg points away from the node: from `a` it looks along a -> b and its `+nrm` side is the road's left
    const hwLeft = sideHalfWidth(rt, level, startsHere ? 'left' : 'right');
    const hwRight = sideHalfWidth(rt, level, startsHere ? 'right' : 'left');
    const hw = symmetric(rt) ? halfWidth(rt, level) : Math.max(hwLeft, hwRight);

    // Initial guess: the leg's own half-width.
    const refined = opts.trims?.get(segId);
    const guess = refined ?? hw;
    const clamped = Math.max(0, Math.min(guess, pl.length * (refined === undefined ? LEG_TRIM_CAP : 1)));
    const f = frameFromNode(pl, startsHere, clamped);

    return legOf({
      seg: segId,
      far: farNode(seg, nodeId),
      // Back-project so that origin + dir * trim lands exactly on the mouth.
      origin: addScaled(f.p, f.dir, -clamped),
      dir: f.dir,
      nrm: f.nrm,
      ang: angleOf(f.dir),
      hw,
      hwLeft,
      hwRight,
      plusSide: startsHere ? 'left' : 'right',
      hwSidewalk: sidewalkHalf(rt),
      length: f.length,
      typeIndex: seg.type,
      direction: seg.direction,
      approaching:
        seg.direction === 'both' ||
        (startsHere ? seg.direction === 'bToA' : seg.direction === 'aToB'),
      road: rt,
      shift: travelShift(rt) * (startsHere ? 1 : -1),
    });
  });

  legs.sort((p, q) => p.ang - q.ang || p.seg - q.seg);
  return legs;
}

/** The mouth corner on the `-nrm` side of a leg, at distance `t`. */
export const mouthRight = (leg: Leg, t: number): Vec2 =>
  addScaled(addScaled(leg.origin, leg.dir, t), leg.nrm, -leg.hwRight);

/** The mouth corner on the `+nrm` side of a leg, at distance `t`. */
export const mouthLeft = (leg: Leg, t: number): Vec2 =>
  addScaled(addScaled(leg.origin, leg.dir, t), leg.nrm, leg.hwLeft);
