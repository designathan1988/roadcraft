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

/**
 * Widest angle between a ramp and the carriageway it joins or leaves that is
 * still a gore: the bend below which a movement is straight on
 * (`lanelets.ts classifyTurn`).
 */
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
  /**
   * True for a node of two legs where one road carries on at another width:
   * the outline is a taper (`transition.ts`), there is no approach zone, and
   * the lanes run straight through.
   */
  readonly transition: boolean;
}

/**
 * Classifies a node.
 *
 * A degree-2 node joining two segments of the same class at a gentle angle is
 * not a junction at all: the two segments merge into one render chain and
 * nothing is drawn there, so no sliver polygon and no seam can appear.
 *
 * A node joining two different STRUCTURES is always a junction, however
 * straight it looks. It is the terminal of a ramp: the raised deck comes down
 * to the ground there and the two connect, so the node needs a mouth like any
 * other connection. Treated as a bend in a chain instead, no junction was built
 * and the ground road kept its closed end — its kerb and footway bands closed
 * across the carriageway and painted a pale stripe over the join, measured on a
 * saved map as a 7.5-unit cap on a road that visibly continued.
 */
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
  //
  // Width is `roadProfile(type, lanes, direction)`, and both `lanes` and
  // `direction` are per-segment overrides. Comparing only `type` merged a
  // two-lane street into an eight-lane one-way of the same class and called it
  // a bend in a chain: no junction, no trim and no taper, so a width step of
  // more than thirty units was drawn as a butt joint with each ribbon's closed
  // end sticking out of the other. The taper machinery in `corners.ts` exists
  // for exactly this shape and could never be reached.
  const wp = roadProfile(sp.type, sp.lanes, sp.direction, sp.section, sp.parking);
  const wq = roadProfile(sq.type, sq.lanes, sq.direction, sq.section, sq.parking);
  if (!outlinesMeet(nodeId, sp, wp, sq, wq)) return 'junction';

  // A bend deep inside a bore is concealed by terrain. Sweeping an open-air
  // junction ring across it makes a crescent of pavement emerge beside the
  // portal when one leg climbs back to daylight.
  if (node.heightOffset < -TUNNEL_HEADROOM) return 'none';


  const legs = buildLegs(doc, cache, nodeId, Level.Asphalt);
  if (legs.length < 2) return 'none';
  // Directions point away from the node, so a straight-through node has them
  // opposed: dot near -1.
  const d = dot((legs[0] as Leg).dir, (legs[1] as Leg).dir);
  if (d > -CHAIN_BEND_COS) return 'junction';
  // And straight where the two roads actually MEET. The legs are framed a
  // half-width out, and two curves can point the same way there while they
  // meet at an angle: with no junction the lanes of the two roads end and
  // begin at the node itself, and on the inside of that kink each lane ran
  // on past the start of the next (by 2 d tan(bend / 2)), so the movement
  // between them was a hook (fuzz `turnOffSurface`, seed 51 of 60 operations:
  // a 19-degree kink read as under 5).
  return bendAtNode(doc, cache, nodeId) < CHAIN_BEND ? 'none' : 'junction';
}

/** Largest bend at a node of two legs that is still one road with no junction, radians. */
const CHAIN_BEND = (5 * Math.PI) / 180;

/**
 * How far the road turns AT a node of two legs: the angle between the two
 * roads' own directions where they meet, radians. Zero for any other node.
 */
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

/**
 * Whether two roads meeting at a node run on into each other at every level
 * with the same outline: each side of one along the matching side of the
 * other (one's left is the other's right when they are drawn the same way
 * through the node, docs/source/VIAS.md V1).
 */
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
  /**
   * Final per-segment mouth limits, keyed by segment id.
   *
   * Network reconciliation supplies these for short links after both ends have
   * competed for the available length. Applying the same limit here keeps the
   * junction mouth and its ribbon bit-for-bit aligned.
   */
  readonly maxTrimBySegment?: ReadonlyMap<number, number>;
  /** Refinement passes for curved legs. Two is enough for a single quadratic. */
  readonly refinePasses?: number;
}

/**
 * Builds one surface level of one junction.
 *
 * Everything here is per-level: half-widths, corners, curb returns and trims.
 * That is what makes the level rings nest, and it is the structural fix for the
 * V6 monolith's seven layers all stopping at the same distance along every leg
 * (defect 1.2) as well as its single isotropic radius (defect 1.6).
 */
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

  // EVERYTHING per-leg below is keyed by SEGMENT, never carried across a
  // re-solve as a positional array.
  //
  // `buildLegs` reads the node's incident list in segment-id order and returns
  // it sorted by ANGLE. Any array handed back to it, or reused after it runs
  // again, is therefore indexed in a different order than it will be read in.
  // Both `scale` and `trims` used to be positional and both were silently
  // permuted on every refinement pass, so each leg was framed at another leg's
  // trim distance — which is exactly the error the refinement loop exists to
  // remove.
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
    // A merge or diverge of a limited-access road: every leg a highway or a
    // ramp (the gore where a ramp joins or leaves the carriageway). An ordinary
    // road meeting a highway and a ramp at one node is a junction, and needs
    // its plate: built as a merge, the avenue's mouth was a hole in the asphalt
    // and a straight movement across it fitted no vehicle (fuzz
    // `turnOffSurface`, seed 16).
    //
    // And only where the ramp leaves or joins at a gore: at a divergence of
    // 2-5 degrees on a taper-type exit, the joining lanes running on straight
    // (a movement under `MERGE_BEND` is straight on, `lanelets.ts
    // classifyTurn`). A highway turning a corner, or a road meeting it square,
    // is not that: built as a gore it had no plate and no setback, the lanes
    // ran into the corner's point and the outer lane's right turn pivoted on a
    // 3-unit chord (fuzz `turnOffSurface`, seed 16: a highway bending 90
    // degrees at a ramp; seed 46 of 60 operations: a highway meeting two
    // ramps at 60 degrees).
    const highwayMerge = legs.length === 3 &&
      legs.some((leg) => leg.road.id === 'highway') &&
      legs.some((leg) => leg.road.id === 'ramp') &&
      legs.every((leg) => leg.road.id === 'highway' || leg.road.id === 'ramp') &&
      gap < MERGE_BEND;
    if (gap < (25 * Math.PI) / 180 || highwayMerge) {
      // A shallow merge has no central crossroads slab. The ribbons overlap
      // over a long, narrow gore; unioning them directly keeps asphalt within
      // the actual road outlines instead of filling a giant triangular plate.
      const ring = new Ring({ x: node.x, y: node.y }, []);
      return { nodeId, level, legs, corners: [], trims: legs.map(() => 0),
        ring, tongues: [], rings: [], usedHullFallback: false, transition: false };
    }
  }

  // A continuous bend or width change is one road, with one swept cross-section.
  // Treating it as a normal junction closes both ribbons across their mouths,
  // leaving a dead-end bulb or a gap where the player expected a through road.
  // The bend is the larger of the legs' (framed a half-width out) and the
  // roads' own where they meet (`bendAtNode`): two curves can look aligned a
  // little way out and still meet at a kink the run has to absorb.
  const bendAngle = legs.length === 2
    ? Math.max(bendAtNode(doc, cache, nodeId), Math.PI - Math.acos(Math.max(-1, Math.min(1,
      dot((legs[0] as Leg).dir, (legs[1] as Leg).dir)))))
    : 0;
  // The transition axis covers moderate changes in direction; a tighter
  // corner needs a junction plate so large vehicles keep their swept area.
  const MAX_CONTINUOUS_BEND = (55 * Math.PI) / 180;
  const throughBend = legs.length === 2 && bendAngle > 1e-5 &&
    bendAngle < MAX_CONTINUOUS_BEND;
  // Only the structure changes - a ramp lands on the ground, a viaduct goes on
  // as a bridge - on one road of one width: a seam, drawn as the taper's band
  // of no width step. Built as a crossroads plate it put rounded kerb returns
  // on a straight road, the edges stepped at the joint and the lane lines bent
  // round them.
  const seam = legs.length === 2 && bendAngle < MAX_CONTINUOUS_BEND && structureSeam(doc, nodeId);
  if (isTransition(legs) || throughBend || seam) {
    const a = legs[0] as Leg;
    const b = legs[1] as Leg;
    const turn = Math.max(bendAngle, Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(a.dir, b.dir)))));
    // One radius for every level: the carriageway's. Each level used its own
    // half-width, so the kerb, the footway and the verge bent over runs of
    // their own - on a 45-degree bend of a highway the mouths at 7.4, 7.5, 8.2
    // and 9.0 units, the kerb stepped out where the footway still ran straight
    // - and a level whose longer run its cap cut short became a corner plate
    // under a transition: a strip of footway across the carriageway at a
    // curved mouth (AT2). Every boundary of a road is an offset of one line at
    // the same stations (OpenDRIVE's lanes, sidewalks included, are cumulative
    // widths from one reference line), as `transitionRun` already does for a
    // width change.
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
    // A narrow link may cap both mouths so severely that the intended taper
    // has no run left. On a 45-degree, 6-unit width change, an 8-unit total
    // axis cut a full metre into the wide carriageway. A corner plate is the
    // honest shape when there is no space to make the transition.
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

  // Curved legs: the mouth cut must be perpendicular to the tangent AT the trim
  // distance, not at the node. Re-frame the legs with the trims just found and
  // solve again. Converges in two passes for a quadratic.
  for (let pass = 0; pass < passes; pass++) {
    framedBy = bySegment(trims, legs);
    legs = buildLegs(doc, cache, nodeId, level, { trims: framedBy });
    // Re-derived from the NEW leg order rather than reused from the old one.
    corners = computeCorners(legs, legs.map(scaleOf));
    trims = capTrims(computeTrims(legs, corners), legs);
  }

  // NOT DONE HERE. Three attempts, each measured (the record they were kept
  // in is not in this repository; the two that matter are summarised here).
  //
  // The staircase in a junction kerb is the gap between what one corner's arc
  // demands and where its leg is actually cut, which is the maximum over BOTH
  // its corners. Growing each arc until it reaches its own mouth fixes it:
  // sharp concave corners on the derived outline go 13 -> 1 on a four-leg
  // crossing of two classes and 20 -> 12 on a five-leg star.
  //
  // Both ways of arranging that growth break something load-bearing:
  //
  //   Let the mouths move out to meet the arcs — every junction lengthens, the
  //   link beside it shortens, and the 4x4 grid of 70-unit blocks ends with two
  //   vehicles holding a junction they can never enter. Scaling by the
  //   per-segment radius factor did not recover it.
  //
  //   Clamp the reported trims so the mouths cannot move — the radius then
  //   depends on THIS level's trims, and every level has its own. The levels
  //   stop nesting, which is the guarantee that keeps a kerb inside its footway,
  //   and the ring simplicity fuzz rate rises with it.
  //
  // The route that remains is to derive the growth once, from a single level's
  // trims, and apply that same radius at every level — which needs the caller
  // to coordinate across levels rather than building each one alone.
  //
  // `computeCorners` keeps its optional trims parameter for that work.

  // Non-adjacent legs must not have their mouths land inside another leg's
  // carriageway.
  // The cap is deliberately loose: a shallow fork legitimately needs a very
  // long gore, and the real bound on trim length is the segment itself, applied
  // globally afterwards. Capping here is what makes mouths overlap.
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
      // Only ever GROW. This assignment used to be unconditional, so whenever
      // `limit` or `bumpCap` bit, the loop named "bump" pushed the trim BELOW
      // what `computeCorners` demanded and reintroduced the very mouth-inside-
      // another-carriageway overlap it was invoked to remove.
      if (bumped > (next[i] as number) + FINE_EPS) {
        next[i] = bumped;
        changed = true;
      }
    }
    trims = next;
    // A length cap can make a slab violation geometrically unavoidable. The
    // ring validator below then falls back to a safe union shape; retrying the
    // same capped values cannot improve it.
    if (!changed) break;
  }

  // ---- a node the editor would have refused ------------------------------
  //
  // The map can still contain one: `localStorage`, an imported file, an undo
  // into an older state, or a map made before the rule existed. Refusing to
  // LOAD is not an option — that destroys the user's work — so the shape is
  // built degraded instead.
  //
  // DEGRADING A HAIRPIN JUNCTION HERE: TWO ATTEMPTS, BOTH MEASURED, BOTH WORSE.
  // Left undone deliberately; the rule that matters now runs upstream instead.
  //
  // The goal was: a node below `MIN_LEG_ANGLE` should not paint a long finger
  // of kerb and footway across open grass. A measurement script (since
  // removed) put a 7-degree hairpin's tongue at 246 units, 16.6 times the road's half-width,
  // against 2.0 for a healthy cross or T.
  //
  //   1. Capping the TRIMS at three half-widths. The hull-fallback rate over
  //      five thousand random junctions went from under 1 % to 53 %, and the
  //      named 15-degree fork broke. Exactly what `corners.ts:112` predicts: a
  //      shorter setback puts one leg's mouth inside the other's carriageway
  //      and the ring stops being simple. Half the map on a convex hull is a
  //      worse map than a pale finger.
  //
  //   2. Shortening or dropping the TONGUES, leaving the ring untouched. The
  //      fuzz sweep catches it by sampling the midpoint between node and mouth:
  //      at a hairpin the corner ring's vertices all sit far from the node, so
  //      the tongue is the only thing covering the approach. Shortening it puts
  //      a HOLE in the drivable surface — a hole where a vehicle drives, which
  //      is worse than a pale patch where nothing does.
  //
  // Both would have needed an existing test weakened to land, and a test that
  // says "no hole in the surface a car drives on" is not one to weaken.
  //
  // What answers it is upstream: a node below `MIN_LEG_ANGLE` is found on
  // every rebuild (`Network.impossible`), and the roundabout and street-object
  // tools refuse to build on one. Drawing and dragging used to refuse such a
  // node too; that refusal went with the freeform roads (e77538b7).

  // A bump moved a mouth after the legs were framed for it. On a curved leg
  // the mouth was then cut square to the tangent at the OLD distance - a wedge
  // of bare ground between the plate and the ribbon, up to 19 degrees out on a
  // curved bridge (the fuzzer's `surfaceGap`). Re-frame the legs at the trims
  // actually used; they re-sort by angle, so the trims travel by segment.
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
