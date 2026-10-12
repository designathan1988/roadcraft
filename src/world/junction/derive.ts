import { type Vec2, addScaled, angleOf, dist } from '@core/vec2';
import { Ring, type RingEdge, arcEdge, lineEdge } from '@core/ring';
import { isSimple } from '@core/polygon';
import { lineLine } from '@core/intersect';
import { FINE_EPS, SIN_EPS, normalizeAngle } from '@core/scalar';
import type { Fillet } from '@core/fillet';
import type { RoadDoc } from '../doc';
import type { NodeId, SegmentId } from '../ids';
import type { PolylineCache } from '../geometry';
import { Level, type SurfaceLevel } from '../roadTypes';
import { type Leg, buildLegs, mouthLeft, mouthRight } from './legs';
import { type Corner, computeCorners } from './corners';
import { transitionRing } from './transition';
import { legTongue, nodeCap, nodeCentre } from './polygon';
import type { Junction } from './build';
import { m } from '../units';

/**
 * Every outer surface of a junction, derived from its kerb line.
 *
 * A junction used to be solved four times, once per surface (carriageway,
 * kerb, footway, verge), each with its own trims and its own corner radius,
 * and the four outlines were then unioned. They did not agree: the footway's
 * own return reached its own mouth while the kerb's stopped short of it, a
 * leg was cut at a different distance on each surface, and the square back
 * corner of the footway was a separate kite laid over all of it. What the
 * player saw was a notch in the back of every footway corner, a step where a
 * kerb return met its leg, and lumps of footway standing proud of the corner.
 *
 * Here the junction is solved ONCE, on the carriageway (the kerb face), as a
 * road designer lays it out, and every other surface is an offset of that one
 * outline (procedural junction builders do the same: the curb return is
 * computed once, the curb and the sidewalk are bands along it):
 *
 * - every surface is cut at the SAME distance along each leg, so a mouth is
 *   one straight cut across the whole cross-section;
 * - the kerb stone follows the kerb return concentrically, its own width
 *   further from the carriageway all the way round;
 * - the back of the footway, and the verge beyond it, turn a square corner,
 *   as the building line of a block does, where the two footway edges meet
 *   at a sane angle; elsewhere they follow the kerb return too.
 *
 * When the carriageway is a transition (a taper, a seam, a bend of one road,
 * `transition.ts`) every surface is the same transition: the same axis, cut
 * at the same distance on both legs, each level at its own half-width
 * (`deriveTransitionLevel`). When it is a shallow merge or a hull fallback
 * nothing is derived and each surface is built on its own as before.
 */

/** Below this wedge, or above its supplement, the footway's back is rounded, not squared. */
const SQUARE_MIN = Math.PI / 6;
/** How far past the kerb return a squared back corner may reach, world units. */
const SQUARE_REACH = m(16);
/** Narrowest footway a squared back corner may leave beside the kerb return. */
const SQUARE_MIN_WIDTH = m(1.5);
/** Points along a return whose two sides have different widths. */
const BLEND_STEPS = 16;

export function deriveJunctionLevel(
  doc: RoadDoc,
  cache: PolylineCache,
  base: Junction,
  level: SurfaceLevel,
): Junction | null {
  if (base.transition) return deriveTransitionLevel(doc, cache, base, level);
  if (base.usedHullFallback || base.ring.isEmpty || base.legs.length < 2) return null;
  const nodeId: NodeId = base.nodeId;
  const trimOf = new Map<SegmentId, number>();
  base.legs.forEach((leg, i) => trimOf.set(leg.seg, base.trims[i] as number));
  const legs = buildLegs(doc, cache, nodeId, level, { trims: trimOf });
  if (legs.length !== base.legs.length) return null;
  const index = new Map<SegmentId, number>();
  legs.forEach((leg, i) => index.set(leg.seg, i));
  const trims = legs.map((leg) => trimOf.get(leg.seg) as number);
  const baseLeg = new Map<SegmentId, Leg>(base.legs.map((leg) => [leg.seg, leg]));

  const squareBack = level === Level.Sidewalk || level === Level.Casing;
  const corners: Corner[] = [];
  /** The outline of each corner, from leg i's left boundary to leg j's right one. */
  const shapes = new Map<number, (push: (e: RingEdge, to: Vec2) => void, cursor: () => Vec2) => void>();

  for (const c of base.corners) {
    const bi = base.legs[c.i] as Leg, bj = base.legs[c.j] as Leg;
    const i = index.get(bi.seg), j = index.get(bj.seg);
    if (i === undefined || j === undefined) return null;
    const li = legs[i] as Leg, lj = legs[j] as Leg;
    // Leg i's left side and leg j's right side, each at its own width.
    const di = li.hwLeft - (baseLeg.get(li.seg) as Leg).hwLeft;
    const dj = lj.hwRight - (baseLeg.get(lj.seg) as Leg).hwRight;
    // The two boundary lines at this level, and where they meet.
    const ai = addScaled(li.origin, li.nrm, li.hwLeft);
    const aj = addScaled(lj.origin, lj.nrm, -lj.hwRight);
    const hit = lineLine(ai, li.dir, aj, lj.dir, SIN_EPS);
    const x = hit?.point ?? null;

    let fillet: Fillet | null = null;
    let mode: Corner['mode'] = c.mode;
    const kerb = c.fillet;
    // Squared only where the square leaves the footway its width all round
    // the kerb return: at an acute bend the two back edges meet beyond the
    // return and a square corner would cut the footway off at its apex.
    const keepsWidth = (): boolean => {
      if (!kerb) return true;
      const mx = (kerb.ta.x - kerb.c.x) + (kerb.tb.x - kerb.c.x);
      const my = (kerb.ta.y - kerb.c.y) + (kerb.tb.y - kerb.c.y);
      const ml = Math.hypot(mx, my);
      if (ml < 1e-9) return false;
      const mid = { x: kerb.c.x + (mx / ml) * kerb.r, y: kerb.c.y + (my / ml) * kerb.r };
      const need = Math.min(SQUARE_MIN_WIDTH, 0.6 * Math.min(di, dj));
      const intoI = (mid.x - ai.x) * li.nrm.x + (mid.y - ai.y) * li.nrm.y;
      const intoJ = -((mid.x - aj.x) * lj.nrm.x + (mid.y - aj.y) * lj.nrm.y);
      return intoI <= -need && intoJ <= -need;
    };
    const squared = squareBack && x !== null && c.psi >= SQUARE_MIN && c.psi <= Math.PI - SQUARE_MIN &&
      (!kerb || dist(x, kerb.ta) <= SQUARE_REACH) && keepsWidth();
    if (squared && x) {
      // The block's corner: both footway edges run straight on until they meet.
      shapes.set(i, (push) => push(lineEdge(x), x));
    } else if (c.mode === 'fillet' && kerb) {
      // The kerb return, carried out to this surface's edge on either side.
      const ta = addScaled(kerb.ta, li.nrm, di);
      const tb = addScaled(kerb.tb, lj.nrm, -dj);
      const ra = dist(kerb.c, ta), rb = dist(kerb.c, tb);
      if (Math.min(ra, rb) < m(0.02)) {
        // The return has shrunk to its centre: this surface turns a point.
        shapes.set(i, (push) => push(lineEdge(ta), ta));
      } else if (Math.abs(ra - rb) < 1e-6) {
        fillet = { ta, tb, c: kerb.c, r: ra, run: kerb.run };
        shapes.set(i, (push, cursor) => {
          push(lineEdge(ta), ta);
          if (dist(cursor(), tb) > FINE_EPS) push(arcEdge(kerb.c, ra, cursor(), tb), tb);
        });
      } else {
        // Two widths: a return whose radius eases from one side's to the other's.
        const a0 = angleOf({ x: ta.x - kerb.c.x, y: ta.y - kerb.c.y });
        const sweep = normalizeAngle(angleOf({ x: tb.x - kerb.c.x, y: tb.y - kerb.c.y }) - a0);
        shapes.set(i, (push) => {
          push(lineEdge(ta), ta);
          for (let k = 1; k <= BLEND_STEPS; k++) {
            const t = k / BLEND_STEPS;
            const ease = t * t * (3 - 2 * t);
            const r = ra + (rb - ra) * ease;
            const a = a0 + sweep * t;
            const p = k === BLEND_STEPS ? tb : { x: kerb.c.x + Math.cos(a) * r, y: kerb.c.y + Math.sin(a) * r };
            push(lineEdge(p), p);
          }
        });
      }
    } else {
      // A chord or a straight run: the same cut, at this surface's edges.
      const pi = mouthLeft(li, c.trimI);
      const pj = mouthRight(lj, c.trimJ);
      shapes.set(i, (push) => {
        push(lineEdge(pi), pi);
        push(lineEdge(pj), pj);
      });
      mode = c.mode;
    }
    corners.push({ i, j, mode, x, psi: c.psi, fillet, trimI: c.trimI, trimJ: c.trimJ });
  }

  // The outline: each mouth one straight cut, each corner its shape.
  const mouths = legs.map((leg, i) => ({ right: mouthRight(leg, trims[i] as number), left: mouthLeft(leg, trims[i] as number) }));
  const start = (mouths[0] as { right: Vec2 }).right;
  const edges: RingEdge[] = [];
  let cursor = start;
  const push = (e: RingEdge, to: Vec2): void => {
    if (dist(cursor, to) > FINE_EPS) {
      edges.push(e);
      cursor = to;
    }
  };
  for (let i = 0; i < legs.length; i++) {
    const mouth = mouths[i] as { right: Vec2; left: Vec2 };
    if (i > 0) push(lineEdge(mouth.right), mouth.right);
    push(lineEdge(mouth.left), mouth.left);
    shapes.get(i)?.(push, () => cursor);
  }
  if (dist(cursor, start) > FINE_EPS) edges.push(lineEdge(start));
  const ring = new Ring(start, edges).ensurePositive();
  const flat = ring.flatten();
  if (flat.length < 3 || !isSimple(flat)) return null;

  const tongues = legs.map((leg, i) => legTongue(leg, trims[i] as number)).filter((r): r is Ring => r !== null);
  const cap = nodeCap(legs, nodeCentre(legs));
  return {
    nodeId,
    level,
    legs,
    corners,
    trims,
    ring,
    tongues,
    rings: [ring, ...tongues, ...(cap ? [cap] : [])],
    usedHullFallback: false,
    transition: false,
  };
}

/**
 * One surface of a transition, as an offset of the carriageway's.
 *
 * Built on its own, each surface took a run of its own and its own cap, and
 * where the footway's longer run was capped short it fell back to a corner
 * plate under a transition carriageway: a strip of footway paving across the
 * road at the mouth of a curved bend, and on a straight bend the kerb stepping
 * out where the footway still ran straight (AT2). Every boundary of a road is
 * an offset of one line at the same stations - OpenDRIVE's lanes, sidewalks
 * included, are cumulative widths from one reference line - so every surface
 * here is the carriageway's own transition axis, cut at its trims, at the
 * surface's half-widths.
 */
function deriveTransitionLevel(doc: RoadDoc, cache: PolylineCache, base: Junction, level: SurfaceLevel): Junction | null {
  if (base.legs.length !== 2) return null;
  const trimOf = new Map<SegmentId, number>();
  base.legs.forEach((leg, i) => trimOf.set(leg.seg, base.trims[i] as number));
  const legs = buildLegs(doc, cache, base.nodeId, level, { trims: trimOf });
  if (legs.length !== 2) return null;
  const trims = legs.map((leg) => trimOf.get(leg.seg) as number);
  const ring = transitionRing(legs, trims);
  return {
    nodeId: base.nodeId, level, legs, corners: computeCorners(legs), trims, ring,
    tongues: [], rings: [ring], usedHullFallback: false, transition: true,
  };
}
