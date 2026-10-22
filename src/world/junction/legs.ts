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

    return {
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
    };
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
