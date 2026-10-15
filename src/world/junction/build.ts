import { dot } from '@core/vec2';
import { Ring } from '@core/ring';
import type { RoadDoc, RoadSegment } from '../doc';
import type { NodeId, SegmentId } from '../ids';
import { type PolylineCache, frameFromNode, segmentStartsAt } from '../geometry';
import {
  Level,
  type RoadSide,
  type RoadType,
  SURFACE_LEVELS,
  type SurfaceLevel,
  halfWidth,
  roadProfile,
  sideHalfWidth,
  symmetric,
} from '../roadTypes';
import { type Leg, buildLegs } from './legs';
import { type Corner, computeCorners } from './corners';
import { computeTrims } from './trim';
import { isTransition, legWidthStep, transitionRing, transitionRunFor } from './transition';
import { buildJunctionRing, findSlabViolations } from './polygon';
import { COARSE_EPS, FINE_EPS } from '@core/scalar';
import { TUNNEL_HEADROOM } from '../structures';
import { buildBulb } from './bulb';
import { m } from '../units';

/** How a node behaves geometrically. */
export type SurfaceMode = 'none' | 'junction';

/** Two legs of the same class meeting at less than this angle need no junction. */
const CHAIN_BEND_COS = Math.cos((5 * Math.PI) / 180);

/** A mouth moved further than this after its leg was framed is framed again, world units. */
const REFRAME_EPS = 1e-3;

/** Runaway guard for the slab-separation loop, as a multiple of the widest leg. */
const SLAB_BUMP_CAP = 40;

/** Widest angle between a ramp and the carriageway it joins or leaves that is still a gore */
const MERGE_BEND = (30 * Math.PI) / 180;


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

/** Classifies a node. */
export function surfaceMode(doc: RoadDoc, cache: PolylineCache, nodeId: NodeId): SurfaceMode {
  const node = doc.node(nodeId);
  // A road's end marked as a turning circle is a junction of one leg (`bulb.ts`).
  if (node && node.incident.length === 1 && node.end === 'bulb') return 'junction';
  if (!node || node.incident.length < 2) return 'none';
  if (node.incident.length > 2) return 'junction';

  const p = node.incident[0];
  const q = node.incident[1];
  if (p === undefined || q === undefined) return 'none';
  const sp = doc.segment(p);
  const sq = doc.segment(q);
  if (!sp || !sq) return 'none';
  if ((sp.structure ?? 'ground') !== (sq.structure ?? 'ground')) return 'junction';
  if (sp.type !== sq.type) return 'junction';

  // A chain needs the same WIDTH, not merely the same class.
  const wp = roadProfile(sp.type, sp.lanes, sp.direction, sp.section, sp.parking);
  const wq = roadProfile(sq.type, sq.lanes, sq.direction, sq.section, sq.parking);
  if (!outlinesMeet(nodeId, sp, wp, sq, wq)) return 'junction';

  // A bend deep inside a bore is concealed by terrain.
  if (node.heightOffset < -TUNNEL_HEADROOM) return 'none';


  const legs = buildLegs(doc, cache, nodeId, Level.Asphalt);
  if (legs.length < 2) return 'none';
  // Directions point away from the node, so a straight-through node has them opposed: dot near -1.
  const d = dot((legs[0] as Leg).dir, (legs[1] as Leg).dir);
  if (d > -CHAIN_BEND_COS) return 'junction';
  // And straight where the two roads actually MEET.
  return bendAtNode(doc, cache, nodeId) < CHAIN_BEND ? 'none' : 'junction';
}

/** Largest bend at a node of two legs that is still one road with no junction, radians. */
const CHAIN_BEND = (5 * Math.PI) / 180;

/** How far the road turns AT a node of two legs: the angle between the two roads' own directions where they meet, radians. */
export function bendAtNode(doc: RoadDoc, cache: PolylineCache, nodeId: NodeId): number {
  const node = doc.node(nodeId);
  if (!node || node.incident.length !== 2) return 0;
  const dirs = node.incident.map((segId) => {
    const seg = doc.requireSegment(segId);
    return frameFromNode(cache.get(doc, segId), segmentStartsAt(seg, nodeId), 0).dir;
  });
  return Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(dirs[0]!, dirs[1]!))));
}

/** How far each leg is given to a change of structure on one road, units. */
const SEAM_RUN = m(2.4);

/** Whether the two roads at a two-leg node differ only in their structure. */
function structureSeam(doc: RoadDoc, nodeId: NodeId): boolean {
  const node = doc.node(nodeId);
  if (!node || node.incident.length !== 2) return false;
  const sp = doc.segment(node.incident[0]!), sq = doc.segment(node.incident[1]!);
  if (!sp || !sq || (sp.structure ?? 'ground') === (sq.structure ?? 'ground')) return false;
  const wp = roadProfile(sp.type, sp.lanes, sp.direction, sp.section, sp.parking);
  const wq = roadProfile(sq.type, sq.lanes, sq.direction, sq.section, sq.parking);
  if (!outlinesMeet(nodeId, sp, wp, sq, wq)) return false;
  return wp.median === wq.median;
}

/** Whether two roads meeting at a node run on into each other at every level with the same outline */
function outlinesMeet(nodeId: NodeId, sp: RoadSegment, wp: RoadType, sq: RoadSegment, wq: RoadType): boolean {
  if (symmetric(wp) && symmetric(wq)) {
    for (const level of SURFACE_LEVELS) if (Math.abs(halfWidth(wp, level) - halfWidth(wq, level)) >= COARSE_EPS) return false;
    return true;
  }
  const plus = (s: RoadSegment): RoadSide => (s.a === nodeId ? 'left' : 'right');
  const minus = (s: RoadSegment): RoadSide => (s.a === nodeId ? 'right' : 'left');
  for (const level of SURFACE_LEVELS) {
    if (Math.abs(sideHalfWidth(wp, level, plus(sp)) - sideHalfWidth(wq, level, minus(sq))) >= COARSE_EPS) return false;
    if (Math.abs(sideHalfWidth(wp, level, minus(sp)) - sideHalfWidth(wq, level, plus(sq))) >= COARSE_EPS) return false;
  }
  return true;
}

export interface BuildOptions {
  /** Per-segment curb-radius scale, keyed by segment id. Defaults to 1. */
  readonly radiusScaleBySegment?: ReadonlyMap<number, number>;
  /** Final per-segment mouth limits, keyed by segment id. */
  readonly maxTrimBySegment?: ReadonlyMap<number, number>;
  /** Refinement passes for curved legs. Two is enough for a single quadratic. */
  readonly refinePasses?: number;
}

/** Builds one surface level of one junction. */
export function buildJunction(
  doc: RoadDoc,
  cache: PolylineCache,
  nodeId: NodeId,
  level: SurfaceLevel,
  opts: BuildOptions = {},
): Junction | null {
  const node = doc.node(nodeId);
  if (node && node.incident.length === 1 && node.end === 'bulb') return buildBulb(doc, cache, nodeId, level);
  if (!node || node.incident.length < 2) return null;

  const passes = opts.refinePasses ?? 2;

  let legs = buildLegs(doc, cache, nodeId, level);

  // EVERYTHING per-leg below is keyed by SEGMENT, never carried across a re-solve as a positional array.
  const scaleOf = (leg: Leg): number => opts.radiusScaleBySegment?.get(leg.seg) ?? 1;
  const capTrims = (values: readonly number[], currentLegs: readonly Leg[]): number[] =>
    values.map((value, i) =>
      Math.min(value, opts.maxTrimBySegment?.get((currentLegs[i] as Leg).seg) ?? Infinity),
    );
  /** Re-keys this pass's positional trims so the next pass cannot mis-index them. */
  const bySegment = (
    values: readonly number[],
    currentLegs: readonly Leg[],
  ): Map<SegmentId, number> => {
    const out = new Map<SegmentId, number>();
    currentLegs.forEach((leg, i) => out.set(leg.seg, values[i] as number));
    return out;
  };

  if (legs.length >= 3) {
    const angles = legs.map((leg) => Math.atan2(leg.dir.y, leg.dir.x)).sort((a, b) => a - b);
    let gap = Infinity;
    for (let i = 0; i < angles.length; i++) {
      const next = i + 1 === angles.length ? angles[0]! + Math.PI * 2 : angles[i + 1]!;
      gap = Math.min(gap, next - angles[i]!);
    }
    // A merge or diverge of a limited-access road: every leg a highway or a ramp
    const highwayMerge = legs.length === 3 &&
      legs.some((leg) => leg.road.id === 'highway') &&
      legs.some((leg) => leg.road.id === 'ramp') &&
      legs.every((leg) => leg.road.id === 'highway' || leg.road.id === 'ramp') &&
      gap < MERGE_BEND;
    if (gap < (25 * Math.PI) / 180 || highwayMerge) {
      // A shallow merge has no central crossroads slab.
      const ring = new Ring({ x: node.x, y: node.y }, []);
      return { nodeId, level, legs, corners: [], trims: legs.map(() => 0),
        ring, tongues: [], rings: [], usedHullFallback: false, transition: false };
    }
  }

  // A continuous bend or width change is one road, with one swept cross-section.
  const bendAngle = legs.length === 2
    ? Math.max(bendAtNode(doc, cache, nodeId), Math.PI - Math.acos(Math.max(-1, Math.min(1,
      dot((legs[0] as Leg).dir, (legs[1] as Leg).dir)))))
    : 0;
  // The transition axis covers moderate changes in direction
  const MAX_CONTINUOUS_BEND = (55 * Math.PI) / 180;
  const throughBend = legs.length === 2 && bendAngle > 1e-5 &&
    bendAngle < MAX_CONTINUOUS_BEND;
  // Only the structure changes - a ramp lands on the ground, a viaduct goes on as a bridge - on one road of one width
  const seam = legs.length === 2 && bendAngle < MAX_CONTINUOUS_BEND && structureSeam(doc, nodeId);
  if (isTransition(legs) || throughBend || seam) {
    const a = legs[0] as Leg;
    const b = legs[1] as Leg;
    const turn = Math.max(bendAngle, Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(a.dir, b.dir)))));
    // One radius for every level: the carriageway's.
    const carriageway = (leg: Leg): number => symmetric(leg.road) ? halfWidth(leg.road, Level.Asphalt)
      : Math.max(sideHalfWidth(leg.road, Level.Asphalt, 'left'), sideHalfWidth(leg.road, Level.Asphalt, 'right'));
    const radius = Math.max(carriageway(a), carriageway(b)) * 2;
    const bendRun = Math.min(radius * 10,
      radius * Math.tan(Math.min(turn, (170 * Math.PI) / 180) / 2));
    const step = legWidthStep(a, b);
    const taperRun = step >= COARSE_EPS ? transitionRunFor(step) : 0;
    const run = Math.max(taperRun, bendRun, seam ? SEAM_RUN : 0);
    let trims = capTrims(legs.map(() => run), legs);
    for (let pass = 0; pass < passes; pass++) {
      legs = buildLegs(doc, cache, nodeId, level, { trims: bySegment(trims, legs) });
      trims = capTrims(legs.map(() => run), legs);
    }
    // A narrow link may cap both mouths so severely that the intended taper has no run left.
    if (trims.every((trim) => trim >= run * 0.75)) {
      const ring = transitionRing(legs, trims);
      return {
        nodeId,
        level,
        legs,
        corners: computeCorners(legs, legs.map(scaleOf)),
        trims,
        ring,
        tongues: [],
        rings: [ring],
        usedHullFallback: false,
        transition: true,
      };
    }
  }

  /** The trims the current legs were framed at, by segment. */
  let framedBy: Map<SegmentId, number> | null = null;
  let corners = computeCorners(legs, legs.map(scaleOf));
  let trims = capTrims(computeTrims(legs, corners), legs);

  // Curved legs: the mouth cut must be perpendicular to the tangent AT the trim distance, not at the node.
  for (let pass = 0; pass < passes; pass++) {
    framedBy = bySegment(trims, legs);
    legs = buildLegs(doc, cache, nodeId, level, { trims: framedBy });
    // Re-derived from the NEW leg order rather than reused from the old one.
    corners = computeCorners(legs, legs.map(scaleOf));
    trims = capTrims(computeTrims(legs, corners), legs);
  }

  // NOT DONE HERE.

  // Non-adjacent legs must not have their mouths land inside another leg's carriageway.
  const maxHw = legs.reduce((mx, l) => Math.max(mx, l.hw), 0);
  const bumpCap = SLAB_BUMP_CAP * maxHw;
  for (let attempt = 0; attempt < 8; attempt++) {
    const bad = findSlabViolations(legs, trims);
    if (bad.length === 0) break;
    const next = trims.slice();
    let changed = false;
    for (const i of bad) {
      const leg = legs[i] as Leg;
      const limit = opts.maxTrimBySegment?.get(leg.seg) ?? Infinity;
      const bumped = Math.min((next[i] as number) * 1.25 + m(0.2), bumpCap, limit);
      // Only ever GROW.
      if (bumped > (next[i] as number) + FINE_EPS) {
        next[i] = bumped;
        changed = true;
      }
    }
    trims = next;
    // A length cap can make a slab violation geometrically unavoidable.
    if (!changed) break;
  }

  // ---- a node the editor would have refused ------------------------------ The map can still contain one

  // A bump moved a mouth after the legs were framed for it.
  if (legs.some((leg, i) => !(Math.abs((trims[i] as number) - (framedBy?.get(leg.seg) ?? NaN)) <= REFRAME_EPS))) {
    const bySeg = bySegment(trims, legs);
    legs = buildLegs(doc, cache, nodeId, level, { trims: bySeg });
    corners = computeCorners(legs, legs.map(scaleOf));
    trims = legs.map((leg) => bySeg.get(leg.seg) as number);
  }

  const built = buildJunctionRing(legs, corners, trims);

  return {
    nodeId,
    level,
    legs,
    corners,
    trims,
    ring: built.ring,
    tongues: built.tongues,
    rings: built.rings,
    usedHullFallback: built.usedHullFallback,
    transition: false,
  };
}
