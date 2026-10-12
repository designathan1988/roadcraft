import { m } from '@world/units';

/**
 * A car's path off the road: out of a parking bay to its lane, or from the lane
 * into a bay (brought back from `src/backup/residents` for the cars that use
 * the lots' car gates, `lotTraffic.ts`).
 *
 * A path is a chain of legs, each a cubic Hermite curve between two points
 * with the direction of MOTION given at both ends (the basis h00, h10, h01,
 * h11 on [0, 1], tangents scaled by the leg's chord and shortened as a
 * cardinal spline's tension does, so the curve does not bulge or loop off the
 * line the lot grid found clear). A leg driven in reverse keeps the body
 * pointing against its motion: backing out of a bay, the nose stays towards
 * the bay while the car swings round. Bays are entered nose first and left
 * backing out, as drivers do in a car park.
 */

export interface PathSample {
  readonly x: number;
  readonly y: number;
  /** Heading of the BODY (nose), radians. */
  readonly angle: number;
  /** Distance along the whole path. */
  readonly s: number;
  /** Index of the leg the sample belongs to. */
  readonly leg: number;
}

export interface Leg {
  readonly x0: number; readonly y0: number;
  /** Unit direction of motion at the start. */
  readonly tx0: number; readonly ty0: number;
  readonly x1: number; readonly y1: number;
  /** Unit direction of motion at the end. */
  readonly tx1: number; readonly ty1: number;
  readonly reverse: boolean;
}

/** Points per leg: a leg is a few metres to a few tens of metres long. */
const SAMPLES = 28;
/** Top speed in a car park, forward and backing out. */
const FORWARD = m(3.6);
const BACKWARD = m(1.7);
/** Distance over which a car gets up to speed and comes to rest, per leg. */
const RAMP = m(2.2);
/** Slowest it creeps while moving (so a leg always ends). */
const CREEP = m(0.25);
/** Hermite tangent length as a share of a leg's chord. */
const TANGENT = 0.6;

export class Manoeuvre {
  readonly samples: PathSample[] = [];
  readonly legEnds: number[] = [];
  readonly length: number;
  /** Distance travelled along the path. */
  s = 0;

  constructor(readonly legs: readonly Leg[]) {
    let s = 0;
    legs.forEach((leg, i) => {
      const k = TANGENT * Math.hypot(leg.x1 - leg.x0, leg.y1 - leg.y0);
      let px = leg.x0, py = leg.y0;
      for (let j = 0; j <= SAMPLES; j++) {
        const u = j / SAMPLES;
        const u2 = u * u, u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
        const x = h00 * leg.x0 + h10 * k * leg.tx0 + h01 * leg.x1 + h11 * k * leg.tx1;
        const y = h00 * leg.y0 + h10 * k * leg.ty0 + h01 * leg.y1 + h11 * k * leg.ty1;
        // Tangent of the curve (the basis differentiated): the direction of motion here.
        const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
        const dx = d00 * leg.x0 + d10 * k * leg.tx0 + d01 * leg.x1 + d11 * k * leg.tx1;
        const dy = d00 * leg.y0 + d10 * k * leg.ty0 + d01 * leg.y1 + d11 * k * leg.ty1;
        const motion = dx === 0 && dy === 0 ? Math.atan2(leg.ty0, leg.tx0) : Math.atan2(dy, dx);
        if (j > 0) s += Math.hypot(x - px, y - py);
        else if (i > 0) continue; // the joint is the previous leg's last sample
        px = x; py = y;
        this.samples.push({ x, y, angle: leg.reverse ? motion + Math.PI : motion, s, leg: i });
      }
      this.legEnds.push(s);
    });
    this.length = s;
  }

  get done(): boolean { return this.s >= this.length - 1e-6; }

  /** The leg being driven now. */
  get leg(): number {
    let i = 0;
    while (i < this.legEnds.length - 1 && this.s >= this.legEnds[i]! - 1e-6) i++;
    return i;
  }

  /** Speed for the current place: up to speed and down to rest within each leg. */
  speed(): number {
    const i = this.leg;
    const start = i === 0 ? 0 : this.legEnds[i - 1]!;
    const end = this.legEnds[i]!;
    const top = this.legs[i]!.reverse ? BACKWARD : FORWARD;
    const ramp = Math.min(1, (this.s - start) / RAMP + 0.15, (end - this.s) / RAMP + 0.1);
    return Math.max(CREEP, top * Math.max(0, ramp));
  }

  /** Moves on by `ds`, never past the end. */
  advance(ds: number): void { this.s = Math.min(this.length, this.s + Math.max(0, ds)); }

  /** Body centre and heading at distance `s` (now, by default). */
  poseAt(s = this.s): { x: number; y: number; angle: number } {
    const pts = this.samples;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid]!.s <= s) lo = mid; else hi = mid;
    }
    const a = pts[lo]!, b = pts[hi]!;
    const t = b.s > a.s ? Math.min(1, Math.max(0, (s - a.s) / (b.s - a.s))) : 0;
    let da = b.angle - a.angle;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: a.angle + da * t };
  }
}

/** Unit vector, or `fallback` for a zero one. */
function unit(x: number, y: number, fallback: [number, number]): [number, number] {
  const l = Math.hypot(x, y);
  return l > 1e-9 ? [x / l, y / l] : fallback;
}

type Point = { readonly x: number; readonly y: number };

/**
 * Forward legs through `points`, leaving the first along `t0` and arriving at the
 * last along `t1`; at the points between, the direction halves the turn.
 */
function through(points: readonly Point[], t0: [number, number], t1: [number, number]): Leg[] {
  const legs: Leg[] = [];
  const dirAt = (i: number): [number, number] => {
    if (i === 0) return t0;
    if (i === points.length - 1) return t1;
    const a = points[i - 1]!, p = points[i]!, c = points[i + 1]!;
    const [ux, uy] = unit(p.x - a.x, p.y - a.y, t0);
    const [vx, vy] = unit(c.x - p.x, c.y - p.y, t1);
    return unit(ux + vx, uy + vy, [vx, vy]);
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!, b = points[i + 1]!;
    const [tx0, ty0] = dirAt(i), [tx1, ty1] = dirAt(i + 1);
    legs.push({ x0: a.x, y0: a.y, tx0, ty0, x1: b.x, y1: b.y, tx1, ty1, reverse: false });
  }
  return legs;
}

/** How far into the lane from its kerb side a car crossing the footway first aims, u. */
const ACROSS_INTO_LANE = m(1.2);

/**
 * Where a car leaving a lot by its gate `edge` is once across the footway:
 * on the carriageway square in front of it, a little short of the lane's
 * centre line. A driver crosses a footway straight and turns along the road
 * on the road. Null when the lane point is not ahead along the lane (the car
 * would turn back on the road) or the edge is already at it.
 */
function acrossFootway(edge: Point, lane: { x: number; y: number; tx: number; ty: number }): Point | null {
  const t = (edge.x - lane.x) * lane.tx + (edge.y - lane.y) * lane.ty;
  if (t > -m(1.5)) return null;
  const qx = lane.x + lane.tx * t, qy = lane.y + lane.ty * t;
  const [nx, ny] = unit(edge.x - qx, edge.y - qy, [0, 0]);
  if (nx === 0 && ny === 0) return null;
  return { x: qx + nx * ACROSS_INTO_LANE, y: qy + ny * ACROSS_INTO_LANE };
}

/**
 * Out of a bay to the lane: backing out of the stall into the aisle, swinging
 * the nose towards the way out, then forward down the aisle, out through the
 * gate (`Bay.via`), square across the footway and onto the lane at its
 * joining point.
 */
export function departure(
  bay: { x: number; y: number; ox: number; oy: number; via: readonly Point[] },
  lane: { x: number; y: number; tx: number; ty: number },
): Manoeuvre {
  const aisle = bay.via[0] ?? { x: bay.x + bay.ox * m(5), y: bay.y + bay.oy * m(5) };
  const across = bay.via.length ? acrossFootway(bay.via[bay.via.length - 1]!, lane) : null;
  const ahead = [...(bay.via.length ? bay.via : [aisle]), ...(across ? [across] : []), lane];
  const next = ahead[1]!;
  const [dx, dy] = unit(next.x - aisle.x, next.y - aisle.y, [lane.tx, lane.ty]);
  return new Manoeuvre([
    { x0: bay.x, y0: bay.y, tx0: bay.ox, ty0: bay.oy, x1: aisle.x, y1: aisle.y, tx1: -dx, ty1: -dy, reverse: true },
    ...through(ahead, [dx, dy], [lane.tx, lane.ty]),
  ]);
}

/**
 * From the lane into a bay, nose first: from where the car stopped (`from`,
 * before the gate), square across the footway to the gate, in along the way
 * out run backwards, and straight into the stall.
 */
export function arrival(
  from: { x: number; y: number; angle: number },
  bay: { x: number; y: number; ox: number; oy: number; via: readonly Point[] },
): Manoeuvre {
  const [hx, hy] = unit(Math.cos(from.angle), Math.sin(from.angle), [1, 0]);
  const inward = [...bay.via].reverse();
  const aisle = inward[inward.length - 1] ?? { x: bay.x + bay.ox * m(5), y: bay.y + bay.oy * m(5) };
  // Off the lane square across the footway to the gate: the way out run
  // backwards (`acrossFootway` with the travel direction reversed).
  const across = inward.length ? acrossFootway(inward[0]!, { x: from.x, y: from.y, tx: -hx, ty: -hy }) : null;
  return new Manoeuvre([
    ...through([from, ...(across ? [across] : []), ...(inward.length ? inward : [aisle])], [hx, hy], [-bay.ox, -bay.oy]),
    { x0: aisle.x, y0: aisle.y, tx0: -bay.ox, ty0: -bay.oy, x1: bay.x, y1: bay.y, tx1: -bay.ox, ty1: -bay.oy, reverse: false },
  ]);
}

/** Top speeds of a lorry shunting in a yard, forward and backing, and the distance it gets up to speed and stops in. */
const SHUNT_FORWARD = m(2.5);
const SHUNT_BACKWARD = m(1.2);
const SHUNT_RAMP = m(1.5);

/**
 * A lorry's way through a yard (`lorryDocks.ts`): the rear axle's poses, a
 * fraction of a metre apart, each with whether it is reached backing. The
 * body is posed at its centre, `rear` ahead of the axle along the heading,
 * as a vehicle steered by its front wheels moves. Between two changes of
 * direction the lorry gets up to speed and comes to rest, as `Manoeuvre`
 * does on each of its legs.
 */
export class Shunt {
  /** Distance along the way at each pose, and where each run in one direction ends. */
  private readonly at: Float64Array;
  private readonly runEnds: number[] = [];
  readonly length: number;
  s = 0;

  constructor(readonly poses: readonly { readonly x: number; readonly y: number; readonly angle: number; readonly reverse: boolean }[], private readonly rear: number) {
    this.at = new Float64Array(poses.length);
    let s = 0;
    for (let i = 1; i < poses.length; i++) {
      s += Math.hypot(poses[i]!.x - poses[i - 1]!.x, poses[i]!.y - poses[i - 1]!.y);
      this.at[i] = s;
      if (i + 1 < poses.length && poses[i + 1]!.reverse !== poses[i]!.reverse) this.runEnds.push(s);
    }
    this.runEnds.push(s);
    this.length = s;
  }

  get done(): boolean { return this.s >= this.length - 1e-6; }

  /** Index of the pose at or before `s`. */
  indexAt(s = this.s): number {
    let lo = 0, hi = this.poses.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.at[mid]! <= s) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** Distance along the way at a pose. */
  distanceAt(index: number): number { return this.at[Math.max(0, Math.min(this.poses.length - 1, index))]!; }

  /** Speed for the current place: up to speed and down to rest within each run. */
  speed(): number {
    let end = this.length, start = 0;
    for (const e of this.runEnds) { if (this.s < e - 1e-6) { end = e; break; } start = e; }
    const reverse = this.poses[Math.min(this.poses.length - 1, this.indexAt() + 1)]!.reverse;
    const top = reverse ? SHUNT_BACKWARD : SHUNT_FORWARD;
    const ramp = Math.min(1, (this.s - start) / SHUNT_RAMP + 0.15, (end - this.s) / SHUNT_RAMP + 0.1);
    return Math.max(CREEP, top * Math.max(0, ramp));
  }

  /** Moves on by `ds`, never past the end of the run it is on (a lorry stops before it changes direction). */
  advance(ds: number): void {
    let end = this.length;
    for (const e of this.runEnds) if (this.s < e - 1e-6) { end = e; break; }
    this.s = Math.min(end, this.s + Math.max(0, ds));
  }

  /** Body centre and heading at distance `s` (now, by default). */
  poseAt(s = this.s): { x: number; y: number; angle: number } {
    const i = this.indexAt(s), j = Math.min(this.poses.length - 1, i + 1);
    const a = this.poses[i]!, b = this.poses[j]!;
    const span = this.at[j]! - this.at[i]!;
    const t = span > 0 ? Math.min(1, Math.max(0, (s - this.at[i]!) / span)) : 0;
    let da = b.angle - a.angle;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const angle = a.angle + da * t;
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    return { x: x + Math.cos(angle) * this.rear, y: y + Math.sin(angle) * this.rear, angle };
  }
}
