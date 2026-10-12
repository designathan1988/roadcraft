import { clamp, lerp } from '@core/scalar';
import { type Vec2, addScaled, dist, lerpVec } from '@core/vec2';
import { type FrameOut, newFrame } from '@core/polyline';
import type { SimWorld } from '@sim/world';
import type { Kinematics, Vehicle } from '@sim/vehicles/state';
import type { PedView } from '@sim/people/view';
import { HEADING_CHORD } from '@world/heading';
import { cycleShift } from '@sim/vehicles/cycleLane';
import { onChartOf } from '@world/planet/charts';
import { m } from '@world/units';

export interface Pose {
  readonly p: Vec2;
  readonly angle: number;
}

/** A pose written in place (`vehiclePoseInto`): one per caller, made once. */
export interface PoseOut {
  p: { x: number; y: number };
  angle: number;
}

/** A pose to write into. */
export function newPose(): PoseOut {
  return { p: { x: 0, y: 0 }, angle: 0 };
}

/**
 * Largest gap, in world units, that two consecutive poses may be apart before
 * the interpolation is abandoned.
 *
 * A topology rebuild can move a vehicle to a lanelet somewhere else entirely,
 * and lerping across that would draw a car sliding over open ground. Ordinary
 * motion is at most `v * DT` plus a lane width, so this is generous enough
 * never to fire on a real step and tight enough to catch a re-seat.
 */
const POSE_JUMP_LIMIT = m(24);

/**
 * Angle a vehicle points into its own lane change.
 *
 * The change is a curve in distance (`laneChangeOffset`), so the body points
 * exactly along it: the heading is the arctangent of the offset gained per
 * unit of road. It is zero at both ends of the curve, so the car turns into
 * the move and straightens out of it, and it does not depend on speed — a car
 * that stops half way across stays angled across the line, as a real one
 * does, instead of snapping straight while its body is still in two lanes.
 */
function laneChangeYaw(slope: number): number {
  return slope === 0 ? 0 : Math.atan(slope);
}

/**
 * Distance from the rear axle to the middle of the body, as a share of its
 * length: the axle sits about a fifth of the length in from the tail.
 */
const REAR_AXLE_TO_CENTRE = 0.3;

/**
 * Sideways offset of the body CENTRE during a lane change.
 *
 * `lateral` is the offset of the rear axle, which is what follows the curve.
 * A body used to be rotated about its own centre instead, so a long vehicle
 * swung its tail a metre or more back into the lane it was leaving — a truck
 * pivoting across the line like a compass needle, and measured as body
 * overlaps with whoever was beside it. Steered from the rear axle, the tail
 * tracks the curve and it is the nose that leads into the new lane.
 */
function bodyOffset(k: Kinematics, length: number): number {
  if (k.lateralSlope === 0) return k.lateral;
  const sine = k.lateralSlope / Math.sqrt(1 + k.lateralSlope * k.lateralSlope);
  return k.lateral + REAR_AXLE_TO_CENTRE * length * sine;
}

/**
 * Pose of a vehicle, interpolated between the last two simulation steps.
 *
 * Two things here were making the traffic look mechanical, and both were
 * reported as cars "jumping" or "bugging out" while driving.
 *
 * THE POSITION. This used to return the current pose outright whenever the
 * vehicle had changed lanelet since the last snapshot, on the grounds that
 * there is nothing meaningful to interpolate between two different lanes. But
 * a lanelet change is not a discontinuity: entering a connector, leaving one,
 * or transferring to a sibling lane all leave the vehicle within a metre or
 * two of where it was. Refusing to interpolate meant that at every junction
 * entry, every junction exit and every lane change - the three moments the eye
 * is actually following - the car was drawn snapping to its new centreline.
 * It now interpolates from wherever it actually was, and only gives up if the
 * two poses are implausibly far apart, which means the topology was rebuilt
 * underneath it.
 *
 * THE HEADING. The angle was never interpolated at all: it was read from the
 * tangent at the current arc position, which only changes when the simulation
 * steps. Between two ticks it is constant, so a turning car rotated in
 * sixty-per-second increments rather than sweeping, and at 2x or 4x speed the
 * stepping is plainly visible. It is now interpolated the short way round,
 * which is the only way to interpolate an angle without a car occasionally
 * spinning the long way through 359 degrees.
 */
export function vehiclePose(w: SimWorld, v: Vehicle, alpha: number): Pose | null {
  const out = newPose();
  return vehiclePoseInto(w, v, alpha, out) ? out : null;
}

/**
 * `vehiclePose` into `out`; false where there is none. The drawing asks it
 * for every vehicle every frame: the pose and its sums were made anew each
 * time (2026-10-11: 48 MB in 10 s with 400 vehicles, the frame's own share
 * after the walkers and the matrices).
 */
export function vehiclePoseInto(w: SimWorld, v: Vehicle, alpha: number, out: PoseOut): boolean {
  // Off the road (parked, or manoeuvring to or from a bay): its own pose.
  const free = v.free;
  const t = clamp(alpha, 0, 1);
  if (free) {
    out.p.x = lerp(free.px, free.x, t); out.p.y = lerp(free.py, free.y, t);
    out.angle = lerpAngle(free.pangle, free.angle, t);
    return true;
  }
  const frame = axleFrame(w, v, v, v.archetype.length, AXLE_NOW);
  if (!frame) return false;

  // Simulation arc position is the FRONT of the vehicle. The visible body
  // centre can still be on the previous lanelet after the front enters a turn.
  // `lateral` is the unfinished part of a lane change: the simulation has
  // already moved the vehicle onto the new centreline, and this is how far it
  // still has to slide across to get there visually.
  // A bicycle by a cycle lane rides in it (`vehicles/cycleLane.ts`).
  const side = bodyOffset(v, v.archetype.length) + cycleShift(v, w.lanelet(v.lanelet), v.s);
  // Along the frame's left normal (`perp` of its tangent).
  const atX = frame.p.x - frame.t.y * side, atY = frame.p.y + frame.t.x * side;
  const heading = Math.atan2(frame.t.y, frame.t.x);
  out.p.x = atX; out.p.y = atY; out.angle = heading;

  const before = axleFrame(w, v, v.prev, v.archetype.length, AXLE_BEFORE);
  if (!before) return true;
  const sideBefore = bodyOffset(v.prev, v.archetype.length) + cycleShift(v, w.lanelet(v.prev.lanelet), v.prev.s);
  BEFORE_OWN.x = before.p.x - before.t.y * sideBefore; BEFORE_OWN.y = before.p.y + before.t.x * sideBefore;
  // On the planet the last step's pose may be written on another piece's
  // chart (a lane and the junction's turn across a border are kept on two):
  // carried onto this one, as a floating origin shifts the pose a body is
  // blended from along with the body, or the blend would cross the atlas.
  const beforeAt = onChartOf(BEFORE_OWN, out.p);
  const beforeAhead = beforeAt === BEFORE_OWN ? before.t
    : direction(beforeAt, onChartOf(addScaled(BEFORE_OWN, before.t, 1), out.p), before.t);
  if (Math.hypot(beforeAt.x - atX, beforeAt.y - atY) > POSE_JUMP_LIMIT) return true;

  // Point into the change, blended across the tick like everything else.
  const yaw = lerp(laneChangeYaw(v.prev.lateralSlope), laneChangeYaw(v.lateralSlope), t);
  out.p.x = lerp(beforeAt.x, atX, t); out.p.y = lerp(beforeAt.y, atY, t);
  out.angle = lerpAngle(Math.atan2(beforeAhead.y, beforeAhead.x), heading, t) + yaw;
  return true;
}

/** The last step's body centre on its own chart, written in place. */
const BEFORE_OWN = { x: 0, y: 0 };

/**
 * Where a vehicle is now, for the simulation itself: `vehiclePose` at the end
 * of the tick (alpha 1), without the previous step's frame that only the
 * drawing's blend between two steps needs (Glenn Fiedler, "Fix Your
 * Timestep!": the blended state is for rendering, the simulation works from
 * its current state). Half the work of `vehiclePose(w, v, 1)`, which the
 * walkers' gap check paid for every vehicle in town every tick.
 */
export function vehiclePoseNow(w: SimWorld, v: Vehicle): Pose | null {
  const out = newPose();
  return vehiclePoseNowInto(w, v, out) ? out : null;
}

/** `vehiclePoseNow` into `out`; false where there is none (the walkers read every vehicle's every tick). */
export function vehiclePoseNowInto(w: SimWorld, v: Vehicle, out: PoseOut): boolean {
  const free = v.free;
  if (free) { out.p.x = free.x; out.p.y = free.y; out.angle = free.angle; return true; }
  const frame = axleFrame(w, v, v, v.archetype.length, AXLE_NOW);
  if (!frame) return false;
  const side = bodyOffset(v, v.archetype.length) + cycleShift(v, w.lanelet(v.lanelet), v.s);
  out.p.x = frame.p.x - frame.t.y * side; out.p.y = frame.p.y + frame.t.x * side;
  out.angle = Math.atan2(frame.t.y, frame.t.x) + laneChangeYaw(v.lateralSlope);
  return true;
}

/**
 * The body centre on the path, pointing along a short chord centred on it.
 *
 * The heading used to be the tangent of the path under the centre. Paths are
 * polylines, so that tangent is constant along each piece and jumps at every
 * vertex: a car driving round a junction turned in steps of three to six
 * degrees, each in a single tick - measured as yaw rates up to 13 rad/s, and
 * seen as a body that ticks round a corner instead of sweeping. The chord
 * (`HEADING_CHORD`) turns continuously as the body moves along the path, and on
 * a circular arc it is the tangent at the centre, so the body stays where it
 * was and only the stepping is gone.
 */
/**
 * The frames `axleFrame` writes and reads (`out` of the two in a pose, and the
 * chord's ends): made once. Every vehicle's pose made three frames and their
 * points anew, for the drawing every frame and for the walkers every tick.
 */
const AXLE_NOW = newFrame();
const AXLE_BEFORE = newFrame();
const AHEAD = newFrame();
const BEHIND = newFrame();

function axleFrame(w: SimWorld, vehicle: Vehicle, kinematics: Kinematics, length: number, out: FrameOut): FrameOut | null {
  if (!bodyFrame(w, vehicle, kinematics, length / 2, out)) return null;
  if (!bodyFrame(w, vehicle, kinematics, length / 2 - HEADING_CHORD, AHEAD) || !bodyFrame(w, vehicle, kinematics, length / 2 + HEADING_CHORD, BEHIND)) return out;
  // The chord's ends on the centre's chart: on the planet they can lie on the
  // lanes either side of a junction's turn, written on other pieces' charts.
  // (`chordHeading`, without its new vector: kept where the ends meet.)
  const behind = onChartOf(BEHIND.p, out.p), ahead = onChartOf(AHEAD.p, out.p);
  const dx = ahead.x - behind.x, dy = ahead.y - behind.y, d = Math.hypot(dx, dy);
  if (d < 1e-6) return out;
  const tx = dx / d, ty = dy / d;
  out.t.x = tx; out.t.y = ty;
  out.n.x = -ty; out.n.y = tx;
  return out;
}

/** The body's frame `behindFront` behind the front, into `out`; false off the road behind it. */
function bodyFrame(w: SimWorld, vehicle: Vehicle, kinematics: Kinematics, behindFront: number, out: FrameOut): boolean {
  let lane = w.lanelet(kinematics.lanelet);
  if (!lane) return false;
  let s = kinematics.s - behindFront;
  // The heading chord can reach past the front's lanelet even while the
  // front is still on it. Sample the following lanelet on both sides of the
  // transition; clamping the earlier snapshot to the connector's endpoint
  // made the body snap its heading as soon as the front crossed that point.
  if (s > lane.length) {
    const nextId = lane.kind === 'connector' ? lane.toLane
      : kinematics.lanelet !== vehicle.lanelet && w.connector(vehicle.lanelet)?.fromLane === lane.id
        ? vehicle.lanelet
        : vehicle.admittedConnector && w.connector(vehicle.admittedConnector)?.fromLane === lane.id
          ? vehicle.admittedConnector : undefined;
    const next = nextId ? w.lanelet(nextId) : undefined;
    if (next) { next.centre.sampleAtInto(s - lane.length, out); return true; }
  }
  if (s >= 0) { lane.centre.sampleAtInto(s, out); return true; }
  for (const id of kinematics.rearPath) {
    lane = w.lanelet(id);
    if (!lane) return false;
    s += lane.length;
    if (s >= 0) { lane.centre.sampleAtInto(s, out); return true; }
  }
  return false;
}

/** The unit direction from `a` to `b`, or `fallback` when they meet. */
function direction(a: Vec2, b: Vec2, fallback: Vec2): Vec2 {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  return d < 1e-9 ? fallback : { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
}

/** Interpolates two headings the short way round. */
function lerpAngle(from: number, to: number, t: number): number {
  let delta = (to - from) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return from + delta * t;
}

/**
 * Pose of a pedestrian, interpolated between the last two steps in WORLD
 * space.
 *
 * It used to be rebuilt from the edge and arc position each frame, which made
 * every change of footway edge a hard cut to the new edge's centreline frame,
 * and read the heading from the path tangent plus the tick-to-tick sideways
 * step — 42,885 heading snaps of more than 8.6 degrees in one tick in two
 * minutes on the saved player map, and a visible pop at every corner. The
 * simulation now owns a world position and a heading turned at a human rate
 * (`settlePose`), and this only blends them.
 */
export function pedPose(p: PedView, alpha: number): Pose {
  const t = clamp(alpha, 0, 1);
  const now = { x: p.x, y: p.y };
  const before = { x: p.prev.x, y: p.prev.y };
  if (dist(before, now) > POSE_JUMP_LIMIT) return { p: now, angle: p.heading };
  return { p: lerpVec(before, now, t), angle: lerpAngle(p.prev.heading, p.heading, t) };
}
