import { type FrameOut, Polyline, newFrame } from '@core/polyline';
import { type Vec2, addScaled, dot, len, normalize, sub } from '@core/vec2';
import { GEO_EPS } from '@core/scalar';
import { type PolygonBands, insideBands, polygonBands } from '@core/polygonBands';
import type { NodeId } from './ids';
import type { Network } from './network';
import { mouthOverlapStrip } from './junction/mouthOverlap';
import { type SurfaceSource, surfaceParts } from './surfaceParts';
import { BODY_ENVELOPE, HEAVY, type BodyClass } from './conflictTable';
import { m, stepsIn } from './units';
import { TurnDigest as Digest } from './turnDigest';
import { HEADING_CHORD } from './heading';
import { type Queue, type Rect, clearOfQueue, overlap, queueOf, rect } from './sweptBodies';
import type { JunctionTurns, TurnChoice } from './junctionTurns';

/** The path a vehicle drives through a junction, as open as the kerbs allow. */

/** Handle lengths tried, as a fraction of the chord, widest curve first. */
const HANDLES = [0.39, 0.44, 0.49, 0.54, 0.59, 0.65] as const;
const FALLBACK_HANDLE = 0.65;
/** Tried only when even the fallback overruns. */
const SQUARER = [0.72, 0.8] as const;
/** Samples per turn path, cosine-spaced. */
const STEPS = 48;
/** Body-centre spacing of the containment sweep, world units. */
const SWEEP_STEP = m(0.6);
/** The least gap between two bodies following one another on a turn. */
const FOLLOW_GAP = m(1);

type Poly = readonly Vec2[];
interface Box { minX: number; minY: number; maxX: number; maxY: number }
interface Area {
  readonly poly: Poly;
  readonly box: Box;
  readonly hashA: number;
  readonly hashB: number;
  /** Its edges by band (`core/polygonBands.ts`), made the first time a point is tested against it; its flat x, y list, the first time a worker needs it (`flatRings`). */
  bands: PolygonBands | null;
  flat: Float64Array | null;
}

/** A ring's box and digest, kept with the ring's own point list. */
const areas = new WeakMap<Poly, Area>();
function areaOf(points: Poly): Area {
  const known = areas.get(points);
  if (known) return known;
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const digest = new Digest();
  digest.add(points.length);
  for (const p of points) {
    box.minX = Math.min(box.minX, p.x); box.maxX = Math.max(box.maxX, p.x);
    box.minY = Math.min(box.minY, p.y); box.maxY = Math.max(box.maxY, p.y);
    digest.point(p);
  }
  const area: Area = { poly: points, box, hashA: digest.a, hashB: digest.b, bands: null, flat: null };
  areas.set(points, area);
  return area;
}

/** Whether `p` is inside the area's ring (`insideBands`, its edges sorted into bands once). */
const insideArea = (p: Vec2, area: Area): boolean =>
  insideBands(p, (area.bands ??= polygonBands(area.poly, area.box)));

const inBox = (p: Vec2, box: Box): boolean =>
  !(p.x < box.minX || p.x > box.maxX || p.y < box.minY || p.y > box.maxY);

/** A surface's key: digest of its centre and every ring point. */
function surfaceKey(centre: Vec2, areas: readonly Area[]): string {
  const digest = new Digest(); digest.point(centre);
  for (const area of areas) digest.mix(area.hashA, area.hashB);
  return digest.value();
}
export const unflat = (xy: Float64Array): Vec2[] => Array.from({ length: xy.length / 2 }, (_, i) => ({ x: xy[i * 2]!, y: xy[i * 2 + 1]! }));

/** The drivable surface around one node: its junction plate and its legs. */
export class JunctionSurface {
  private readonly areas: Area[] = [];
  /** The ring that held the last point `contains` found (an index into `areas`). */
  private lastHit = 0;
  private readonly approaches = new Map<Polyline, ApproachPoses[]>();
  /** What the sweeps over this surface work in (`sweep`). */
  readonly work = new SweepWork();
  readonly centre: Vec2;
  /** Digest of every ring point, for `turnPath`'s memo. */
  readonly key: string;

  /** The surface round `node`, from its pieces (`surfaceParts`; a worker's, the same pieces sent) */
  constructor(from: Network | SurfaceSource | { readonly centre: Vec2; readonly rings: readonly Float64Array[] }, node?: NodeId) {
    const add = (ring: Poly): void => {
      if (ring.length < 3) return;
      this.areas.push(areaOf(ring));
    };
    if (!('ribbons' in from) && !('parts' in from)) {
      this.centre = { x: from.centre.x, y: from.centre.y };
      for (const xy of from.rings) add(unflat(xy));
      this.key = surfaceKey(this.centre, this.areas);
      return;
    }
    const source = 'ribbons' in from ? surfaceParts(from, node!) : from;
    this.centre = { x: source.centre.x, y: source.centre.y };
    for (const part of source.parts) {
      if ('full' in part) {
        const strip = mouthOverlapStrip(part.full, part.half, part.mouth);
        if (strip) add(strip);
      } else add('edges' in part ? part.flatten() : part);
    }
    this.key = surfaceKey(this.centre, this.areas);
  }

  /** Its rings as flat x, y lists, in order: what a worker builds the same surface from. Each kept with its ring (`areaOf`): DO NOT flatten it per junction, a third of a city's graph build (2026-10-15). */
  flatRings(): Float64Array[] {
    return this.areas.map((a) => (a.flat ??= Float64Array.from({ length: a.poly.length * 2 }, (_, i) => (i % 2 ? a.poly[i >> 1]!.y : a.poly[i >> 1]!.x))));
  }

  /** DO NOT sweep them again per candidate */
  approachPoses(inCentre: Polyline, body: BodyClass, first: number): ApproachPoses {
    let known = this.approaches.get(inCentre);
    if (!known) this.approaches.set(inCentre, (known = []));
    let found = known.find((a) => a.body === body && a.first === first);
    if (!found) known.push((found = approachPosesOf(this, inCentre, body, first)));
    return found;
  }

  get empty(): boolean {
    return this.areas.length === 0;
  }

  /** Whether any of its rings holds `p`. */
  contains(p: Vec2): boolean {
    const areas = this.areas;
    const hint = areas[this.lastHit];
    if (hint && inBox(p, hint.box) && insideArea(p, hint)) return true;
    for (let i = 0; i < areas.length; i++) {
      const a = areas[i]!;
      if (a === hint || !inBox(p, a.box) || !insideArea(p, a)) continue;
      this.lastHit = i;
      return true;
    }
    return false;
  }
}

/** Cubic Bezier from the end of `inCentre` to the start of `outCentre`. */
export function bezierTurn(inCentre: Polyline, outCentre: Polyline, handleFraction: number): Polyline {
  const a = inCentre.sampleAt(inCentre.length).p;
  const b = outCentre.sampleAt(0).p;
  const t0 = inCentre.sampleAt(inCentre.length).t;
  const t3 = outCentre.sampleAt(0).t;
  const chord = sub(b, a);
  const d = len(chord);
  if (d < GEO_EPS) return Polyline.fromPoints([a, b]);
  // A movement already aligned with both lanes is a straight line, and forcing a curve through it only adds sampling error.
  const dir = normalize(chord);
  if (dot(dir, t0) > 0.9999 && dot(dir, t3) > 0.9999) return Polyline.fromPoints([a, b]);

  const handle = handleFraction * d;
  const p1 = addScaled(a, t0, handle);
  const p2 = addScaled(b, t3, -handle);
  const pts: Vec2[] = [];
  for (let i = 0; i <= STEPS; i++) {
    // Cosine spacing: a polyline's tangent at its very end is the direction of its last chord
    const t = 0.5 - 0.5 * Math.cos((Math.PI * i) / STEPS);
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    pts.push({
      x: w0 * a.x + w1 * p1.x + w2 * p2.x + w3 * b.x,
      y: w0 * a.y + w1 * p1.y + w2 * p2.y + w3 * b.y,
    });
  }
  return Polyline.fromPoints(pts);
}

/** Another inbound lane - of another approach, or the one beside this movement's own */
export interface WaitingLane {
  readonly centre: Polyline;
}

/** How far behind a stop line a waiting vehicle is looked for, world units. */
const QUEUE_REACH = BODY_ENVELOPE[HEAVY]!.length * 1.5;

/** Where `sweep` checks a body's outline: its four corners and the middle of each side. */
const CORNER_ALONG = [-0.5, 0, 0.5] as const;
const CORNER_ACROSS = [-0.5, 0.5] as const;

/** Car-sized bodies standing in a waiting lane, front at the line and further back. */
function waitingBodies(lane: WaitingLane): Queue {
  const car = BODY_ENVELOPE[1]!;
  const bodies: Rect[] = [];
  for (let back = car.length / 2; back <= QUEUE_REACH; back += SWEEP_STEP) {
    const f = lane.centre.sampleAt(Math.max(0, lane.centre.length - back));
    bodies.push(rect(f.p, f.t, car.length, car.width));
  }
  return queueOf(bodies, rect({ x: 0, y: 0 }, { x: 1, y: 0 }, car.length, car.width).r);
}

/** Where, in its sequence of positions, the last candidate swept for a body left the surface (`sweep`); -1 before any did. */
interface FailHint { at: number }

/** Frames `sweep` samples into, made once (`Polyline.sampleAtInto`). */
const atFrame = newFrame(), behindFrame = newFrame(), aheadFrame = newFrame();
const corner = { x: 0, y: 0 };

/** The body at `c` along the manoeuvre, headed along the chord about it, written into `out`; false when it leaves the surface (`out` then holds nothing to read). */
/** DO NOT make a rectangle and a heading a candidate position: a turn's search sweeps thousands (the allocation profile, 2026-10-17: `poseAt` 0.5-0.8 GB in the traffic's workers); `sweep` writes into its pool (`takeRect`). */
function poseInto(surface: JunctionSurface, frameAt: (c: number, out: FrameOut) => FrameOut,
  c: number, length: number, width: number, out: Rect): boolean {
  const at = frameAt(c, atFrame);
  const behind = frameAt(c - HEADING_CHORD, behindFrame).p, ahead = frameAt(c + HEADING_CHORD, aheadFrame).p;
  // `chordHeading`, its numbers alone.
  const dx = ahead.x - behind.x, dy = ahead.y - behind.y, d = Math.hypot(dx, dy);
  const tx = d < 1e-6 ? at.t.x : dx / d, ty = d < 1e-6 ? at.t.y : dy / d;
  const px = at.p.x, py = at.p.y;
  for (let ia = 0; ia < CORNER_ALONG.length; ia++) {
    const a = CORNER_ALONG[ia]!;
    for (let ib = 0; ib < CORNER_ACROSS.length; ib++) {
      const b = CORNER_ACROSS[ib]!;
      corner.x = px + tx * a * length - ty * b * width;
      corner.y = py + ty * a * length + tx * b * width;
      if (!surface.contains(corner)) return false;
    }
  }
  setRect(out, px, py, tx, ty, length, width);
  return true;
}

/** A rectangle's fields written as `rect` makes them. */
function setRect(out: Rect, px: number, py: number, tx: number, ty: number, length: number, width: number): void {
  out.cx = px; out.cy = py; out.ux = tx; out.uy = ty; out.hl = length / 2; out.hw = width / 2; out.r = Math.hypot(length, width) / 2;
}

/** What the sweeps over one surface work in, kept by the surface (`JunctionSurface.work`): the rectangles a sweep writes its positions into, and its lists; each sweep's are its own until it returns (no sweep runs inside another). */
export class SweepWork {
  readonly rects: Rect[] = [];
  taken = 0;
  readonly poses: Rect[] = [];
  readonly along: number[] = [];
  readonly behind: Rect[] = [];
  readonly behindAt: number[] = [];
  /** Where the position probed first is written, read for nothing but whether it fits. */
  readonly probe: Rect = { cx: 0, cy: 0, ux: 0, uy: 0, hl: 0, hw: 0, r: 0 };

  /** The next rectangle of this sweep. */
  take(): Rect {
    return this.rects[this.taken++] ?? (this.rects[this.taken - 1] = { cx: 0, cy: 0, ux: 0, uy: 0, hl: 0, hw: 0, r: 0 });
  }
}

/** The body at `c` as a rectangle of its own, kept (an approach's positions, `approachPosesOf`). */
function poseAt(surface: JunctionSurface, frameAt: (c: number, out: FrameOut) => FrameOut,
  c: number, length: number, width: number): Rect | null {
  const out: Rect = { cx: 0, cy: 0, ux: 0, uy: 0, hl: 0, hw: 0, r: 0 };
  return poseInto(surface, frameAt, c, length, width, out) ? out : null;
}



/** A body's positions on an approach lane, before its heading chord reaches the turn */
interface ApproachPoses {
  readonly first: number;
  readonly body: BodyClass;
  readonly poses: readonly Rect[];
  readonly along: readonly number[];
  readonly next: number;
  readonly offSurface: boolean;
}

function approachPosesOf(surface: JunctionSurface, inCentre: Polyline, body: BodyClass, first: number): ApproachPoses {
  const { length, width } = BODY_ENVELOPE[body]!;
  // `sweep`'s own frame for a position behind the line, the only one these use.
  const frameAt = (c: number, out: FrameOut): FrameOut => inCentre.sampleAtInto(Math.max(0, inCentre.length + c), out);
  const poses: Rect[] = [];
  const along: number[] = [];
  let c = first;
  for (; c + HEADING_CHORD < 0; c += SWEEP_STEP) {
    const pose = poseAt(surface, frameAt, c, length, width);
    if (!pose) return { first, body, poses, along, next: c, offSurface: true };
    poses.push(pose);
    along.push(c);
  }
  return { first, body, poses, along, next: c, offSurface: false };
}

/** DO NOT fold the three passes back into one loop */
function sweep(surface: JunctionSurface, inCentre: Polyline, path: Polyline, outCentre: Polyline,
  waiting: readonly Queue[], body: BodyClass = HEAVY, ends: RoadEnds = NO_ROAD_ENDS, hint?: FailHint): number | null {
  const { length, width } = BODY_ENVELOPE[body]!;
  const half = length / 2;
  const frameAt = (c: number, out: FrameOut): FrameOut =>
    c < 0 ? inCentre.sampleAtInto(Math.max(0, inCentre.length + c), out)
      : c <= path.length ? path.sampleAtInto(c, out)
        : outCentre.sampleAtInto(Math.min(outCentre.length, c - path.length), out);
  // Where a lane begins or ends at the end of a road, the body is never beyond it
  const first = ends.fromRoadEnd ? Math.max(-half, half - inCentre.length) : -half;
  const last = ends.toRoadEnd ? Math.min(path.length + half, path.length + outCentre.length - half) : path.length + half;
  // 1.
  const work = surface.work;
  work.taken = 0;
  const poses = work.poses, along = work.along;
  poses.length = 0; along.length = 0;
  let c = first;
  // The positions still wholly on the approach are the same for every candidate path of this movement
  const approach = surface.approachPoses(inCentre, body, first);
  if (approach.next <= last) {
    if (approach.offSurface) return null;
    for (let k = 0; k < approach.poses.length; k++) { poses.push(approach.poses[k]!); along.push(approach.along[k]!); }
    c = approach.next;
  }
  // The position where the last candidate left the surface, first
  if (hint && hint.at > poses.length) {
    let k = poses.length, probe = c;
    while (k < hint.at && probe <= last) { probe = probe < last ? Math.min(last, probe + SWEEP_STEP) : Infinity; k++; }
    if (probe <= last && !poseInto(surface, frameAt, probe, length, width, work.probe)) return null;
  }
  for (; c <= last; c = c < last ? Math.min(last, c + SWEEP_STEP) : Infinity) {
    const pose = work.take();
    if (!poseInto(surface, frameAt, c, length, width, pose)) {
      if (hint) hint.at = poses.length;
      return null;
    }
    poses.push(pose);
    along.push(c);
  }
  // 2.
  const behind = work.behind, behindAt = work.behindAt;
  behind.length = 0; behindAt.length = 0;
  const queueFrom = Math.max(-half - length - FOLLOW_GAP, ends.fromRoadEnd ? half - inCentre.length : -inCentre.length);
  for (let c = queueFrom; c < -half; c += SWEEP_STEP) {
    const at = frameAt(c, atFrame);
    const body = work.take();
    setRect(body, at.p.x, at.p.y, at.t.x, at.t.y, length, width);
    behind.push(body);
    behindAt.push(c);
  }
  const reach = length + FOLLOW_GAP;
  for (let k = 0; k < poses.length; k++) {
    const c = along[k]!, pose = poses[k]!;
    // Only once the body has started to turn
    if (c < 0) {
      if (c >= -inCentre.length) { behind.push(pose); behindAt.push(c); }
      continue;
    }
    // `behindAt` rises, so `c - behindAt[j]` only falls
    for (let j = 0; j < behind.length && c - behindAt[j]! >= reach; j++) {
      if (overlap(pose, behind[j]!)) return null;
    }
    behind.push(pose);
    behindAt.push(c);
  }
  // 3.
  let depth = 0;
  for (let k = 0; k < poses.length; k++) {
    if (along[k]! < 0) continue;
    const pose = poses[k]!;
    for (const queue of waiting) {
      if (clearOfQueue(pose, queue)) continue;
      for (let i = queue.bodies.length - 1; i >= 0 && (i + 1) * SWEEP_STEP > depth; i--) {
        if (!overlap(pose, queue.bodies[i]!)) continue;
        depth = (i + 1) * SWEEP_STEP;
        break;
      }
    }
  }
  return depth;
}

/** The widest turn path whose swept body stays on the junction's surface. */
export interface TurnPathResult {
  readonly path: Polyline;
  /** Largest physical body whose swept corners fit; -1 if even a small body cannot. */
  readonly maxBodyClass: BodyClass | -1;
}

/** Whether the arriving lane begins, or the departing lane ends, at the end of a road */
export interface RoadEnds {
  readonly fromRoadEnd: boolean;
  readonly toRoadEnd: boolean;
}
const NO_ROAD_ENDS: RoadEnds = { fromRoadEnd: false, toRoadEnd: false };

export function turnPath(inCentre: Polyline, outCentre: Polyline, surface: JunctionSurface | null,
  waiting: readonly WaitingLane[] = [], ends: RoadEnds = NO_ROAD_ENDS, turns: JunctionTurns | null = null): TurnPathResult {
  if (!surface || surface.empty) return {
    path: bezierTurn(inCentre, outCentre, FALLBACK_HANDLE), maxBodyClass: HEAVY,
  };
  // A junction rebuilt for a change that did not move this movement
  const key = turns ? `${laneEndKey(inCentre, true)}|${laneEndKey(outCentre, false)}|${surface.key}|` +
    `${ends.fromRoadEnd ? 1 : 0}${ends.toRoadEnd ? 1 : 0}|` +
    waiting.map((lane) => laneEndKey(lane.centre, true, QUEUE_REACH)).join(',') : '';
  const known = turns?.find(key);
  if (known !== undefined) return {
    path: makeChoice(inCentre, outCentre, known.choice), maxBodyClass: known.maxBodyClass,
  };
  // Off the page (`TurnPlan`): asked of the workers; the junction stands on the old shape until built again with the answer.
  if (turns?.deferring) {
    turns.defer(key, () => ({ inXY: inCentre.xy, outXY: outCentre.xy, waiting: waiting.map((lane) => lane.centre.xy), surfaceKey: surface.key, ...ends }),
      () => ({ centre: surface.centre, rings: surface.flatRings() }));
    return { path: bezierTurn(inCentre, outCentre, FALLBACK_HANDLE), maxBodyClass: HEAVY };
  }
  // DO NOT sweep the chosen path again, class by class, to find it
  const { choice, path, body: maxBodyClass } = chooseTurn(inCentre, outCentre, surface, waiting, ends);
  turns?.keep(key, { choice, maxBodyClass });
  return { path, maxBodyClass };
}

/** Turning round in a turning circle at a road's end (`junction/bulb.ts`) */
export function bulbTurnPath(inCentre: Polyline, outCentre: Polyline, surface: JunctionSurface | null,
  centre: Vec2, radius: number): TurnPathResult {
  const start = inCentre.sampleAt(inCentre.length), end = outCentre.sampleAt(0);
  const a = start.p, b = end.p;
  const angleAt = (p: Vec2): number => Math.atan2(p.y - centre.y, p.x - centre.x);
  const aIn = angleAt(a), aOut = angleAt(b);
  // Round the side the arriving lane looks into: the far side of the circle.
  const ahead = { x: a.x + start.t.x * radius, y: a.y + start.t.y * radius };
  const back = angleAt(ahead);
  const wrap = (x: number): number => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ccwSweep = wrap(aOut - aIn);
  const sign = wrap(back - aIn) < ccwSweep ? 1 : -1;
  const sweep = sign > 0 ? ccwSweep : 2 * Math.PI - ccwSweep;
  // On the circle 45° in from each end, joined to the lanes by cubics tangent to both
  const lead = Math.min(Math.PI / 4, sweep / 3);
  const p1a = aIn + sign * lead, p2a = aIn + sign * (sweep - lead);
  const on = (ang: number): Vec2 => ({ x: centre.x + Math.cos(ang) * radius, y: centre.y + Math.sin(ang) * radius });
  const tangent = (ang: number): Vec2 => ({ x: -Math.sin(ang) * sign, y: Math.cos(ang) * sign });
  const cubic = (p0: Vec2, t0: Vec2, p3: Vec2, t3: Vec2, out: Vec2[]): void => {
    const h = 0.45 * Math.hypot(p3.x - p0.x, p3.y - p0.y);
    const c1 = addScaled(p0, t0, h), c2 = addScaled(p3, t3, -h);
    for (let i = out.length ? 1 : 0; i <= STEPS / 2; i++) {
      const t = i / (STEPS / 2), u = 1 - t;
      const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
      out.push({ x: w0 * p0.x + w1 * c1.x + w2 * c2.x + w3 * p3.x, y: w0 * p0.y + w1 * c1.y + w2 * c2.y + w3 * p3.y });
    }
  };
  const pts: Vec2[] = [];
  cubic(a, start.t, on(p1a), tangent(p1a), pts);
  const arcSteps = Math.max(4, Math.ceil(stepsIn((sweep - 2 * lead) * radius, 1)));
  for (let i = 1; i <= arcSteps; i++) pts.push(on(p1a + sign * ((sweep - 2 * lead) * i) / arcSteps));
  cubic(on(p2a), tangent(p2a), b, end.t, pts);
  const path = Polyline.fromPoints(pts);
  if (!surface || surface.empty) return { path, maxBodyClass: HEAVY };
  const maxBodyClass = ([HEAVY, 1, 0] as const).find((body) => turnFits(inCentre, path, outCentre, surface, body)) ?? -1;
  return { path, maxBodyClass };
}

/** The tightest a body of each class turns, on its centreline: AASHTO's design vehicles */
const CENTRE_TURN_RADIUS: readonly number[] = [m(3), m(6.4), m(11.6)];

/** A U-turn through an opening in the median (retorno) */
export function medianUturnPath(inCentre: Polyline, outCentre: Polyline, surface: JunctionSurface | null): TurnPathResult {
  const start = inCentre.sampleAt(inCentre.length), end = outCentre.sampleAt(0);
  const a = start.p, b = end.p, t = start.t;
  // Across, towards the departing lane; and how far along the road it starts from here.
  const across = { x: b.x - a.x, y: b.y - a.y };
  const ahead = across.x * t.x + across.y * t.y;
  const side = { x: across.x - t.x * ahead, y: across.y - t.y * ahead };
  const width = Math.hypot(side.x, side.y);
  if (width < GEO_EPS) return { path: Polyline.fromPoints([a, b]), maxBodyClass: -1 };
  const n = { x: side.x / width, y: side.y / width };
  const r = width / 2;
  // Straight on first where the departing lane begins further along (`ahead` > 0).
  const from = ahead > 0 ? addScaled(a, t, ahead) : a;
  const centre = addScaled(from, n, r);
  const pts: Vec2[] = ahead > GEO_EPS ? [a] : [];
  const steps = Math.max(12, Math.ceil(stepsIn(Math.PI * r, 0.5)));
  for (let i = 0; i <= steps; i++) {
    const phi = (Math.PI * i) / steps;
    // From `from` (angle -n), forward round the far side (+t), to the other lane (+n).
    const c = Math.cos(phi), s = Math.sin(phi);
    pts.push({ x: centre.x - n.x * r * c + t.x * r * s, y: centre.y - n.y * r * c + t.y * r * s });
  }
  if (ahead < -GEO_EPS) pts.push(b);
  const path = Polyline.fromPoints(pts);
  const maxBodyClass = ([HEAVY, 1, 0] as const).find((body) => r >= (CENTRE_TURN_RADIUS[body] ?? Infinity) - m(0.05) &&
    (!surface || surface.empty || turnFits(inCentre, path, outCentre, surface, body))) ?? -1;
  return { path, maxBodyClass };
}

/** Whether the selected movement contains a body of this size on its drawn surface. */
export function turnFits(inCentre: Polyline, path: Polyline, outCentre: Polyline,
  surface: JunctionSurface, body: BodyClass, ends: RoadEnds = NO_ROAD_ENDS): boolean {
  return sweep(surface, inCentre, path, outCentre, [], body, ends) !== null;
}

const makeChoice
 = (a: Polyline, b: Polyline, choice: TurnChoice): Polyline =>
  typeof choice === 'number' ? bezierTurn(a, b, choice) :
    twoPieceTurn(a, b, { x: choice.x, y: choice.y }, choice.share);

/** Two tangent-continuous cubics through a point inside the junction. */
function twoPieceTurn(inCentre: Polyline, outCentre: Polyline, middle: Vec2, share: number): Polyline {
  const start = inCentre.sampleAt(inCentre.length);
  const end = outCentre.sampleAt(0);
  const sum = { x: start.t.x + end.t.x, y: start.t.y + end.t.y };
  const tangent = normalize(len(sum) > GEO_EPS ? sum : sub(end.p, start.p));
  const cubic = (a: Vec2, b: Vec2, t0: Vec2, t1: Vec2): Vec2[] => {
    const reach = len(sub(b, a)) * share;
    const c0 = addScaled(a, t0, reach), c1 = addScaled(b, t1, -reach);
    const points: Vec2[] = [];
    for (let i = 0; i <= STEPS / 2; i++) {
      const t = i / (STEPS / 2), u = 1 - t;
      points.push({
        x: u * u * u * a.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * b.y,
      });
    }
    return points;
  };
  const first = cubic(start.p, middle, start.t, tangent);
  const second = cubic(middle, end.p, tangent, end.t);
  return Polyline.fromPoints([...first, ...second.slice(1)]);
}
/** Reach of the sweep along the approach and exit: half the largest body plus the heading chord. */
const LANE_REACH = BODY_ENVELOPE[HEAVY]!.length / 2 + HEADING_CHORD + SWEEP_STEP * 2;
/** Spacing of the samples a lane's digest is taken from, world units. */
const KEY_STEP = m(0.4);
const laneKeys = new WeakMap<Polyline, Map<string, string>>();

/** Digest of a lane near its end (`atEnd`) or its start, over `reach`. */
function laneEndKey(lane: Polyline, atEnd: boolean, reach = LANE_REACH): string {
  let byReach = laneKeys.get(lane);
  const tag = `${atEnd ? 'e' : 's'}${reach}`;
  const cached = byReach?.get(tag);
  if (cached) return cached;
  const digest = new Digest();
  digest.add(lane.length);
  for (let d = 0; d <= reach; d += KEY_STEP) {
    const f = lane.sampleAt(atEnd ? Math.max(0, lane.length - d) : Math.min(lane.length, d));
    digest.point(f.p);
  }
  const end = lane.sampleAt(atEnd ? lane.length : 0).t;
  digest.point(end);
  const value = digest.value();
  if (!byReach) laneKeys.set(lane, (byReach = new Map()));
  byReach.set(tag, value);
  return value;
}


/** The handle `turnPath` settles on, by sweeping the candidates. */
export function chooseTurn(inCentre: Polyline, outCentre: Polyline, surface: JunctionSurface,
  waiting: readonly WaitingLane[], ends: RoadEnds): { choice: TurnChoice; path: Polyline; body: BodyClass | -1 } {
  const queues = waiting.map(waitingBodies);
  const candidates = new Candidates(inCentre, outCentre);
  for (const body of [HEAVY, 1, 0] as const) {
    const choice = chooseTurnFor(candidates, surface, queues, body, ends);
    // This body fits the choice: every candidate `chooseTurnFor` returns is one its sweep kept on the surface
    if (choice !== null) return { ...choice, body };
  }
  // No size fits even the fallback, which every size swept first.
  return { choice: FALLBACK_HANDLE, path: candidates.handle(FALLBACK_HANDLE), body: -1 };
}

/** The interior waypoints `chooseTurnFor` tries, as offsets from the node: a 5 x 5 grid 2 m apart, nearest the node first. */
const WAYPOINTS: readonly Vec2[] = (() => {
  const offsets: Vec2[] = [];
  for (const dx of [-4, -2, 0, 2, 4].map(m)) for (const dy of [-4, -2, 0, 2, 4].map(m))
    offsets.push({ x: dx, y: dy });
  return offsets.sort((a, b) => a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y || a.x - b.x || a.y - b.y);
})();
const WAYPOINT_SHARES = [0.3, 0.4] as const;

/** DO NOT build them per body size again. */
class Candidates {
  private readonly handles = new Map<number, Polyline>();
  private readonly waypoints: (Polyline | undefined)[] = [];

  constructor(readonly inCentre: Polyline, readonly outCentre: Polyline) {}

  /** The single cubic with this handle (`bezierTurn`). */
  handle(handle: number): Polyline {
    let path = this.handles.get(handle);
    if (!path) this.handles.set(handle, (path = bezierTurn(this.inCentre, this.outCentre, handle)));
    return path;
  }

  /** The two cubics through waypoint `w` (of `WAYPOINTS`, `point` its place) at share `k`. */
  through(w: number, k: number, point: Vec2): Polyline {
    const slot = w * WAYPOINT_SHARES.length + k;
    return (this.waypoints[slot] ??= twoPieceTurn(this.inCentre, this.outCentre, point, WAYPOINT_SHARES[k]!));
  }
}

/** The handle for one body size; null when no candidate keeps that body on the surface. */
function chooseTurnFor(candidates: Candidates, surface: JunctionSurface,
  queues: readonly Queue[], body: BodyClass, ends: RoadEnds): { choice: TurnChoice; path: Polyline } | null {
  const { inCentre, outCentre } = candidates;
  const hint: FailHint = { at: -1 };
  const swept = (path: Polyline): number | null => sweep(surface, inCentre, path, outCentre, queues, body, ends, hint);
  const fallback = candidates.handle(FALLBACK_HANDLE);
  // The fallback is also the shape every movement was built with before
  const base = swept(fallback);
  if (base === null) {
    // Even the old shape overruns (a bus round a tight bend)
    for (const handle of SQUARER) {
      const path = candidates.handle(handle);
      if (swept(path) !== null) return { choice: handle, path };
    }
    let alternate: { choice: TurnChoice; path: Polyline; depth: number } | null = null;
    const consider = (choice: TurnChoice, path: Polyline): boolean => {
      const depth = swept(path);
      if (depth === null) return false;
      if (depth === 0) return true;
      if (!alternate || depth < alternate.depth) alternate = { choice, path, depth };
      return false;
    };
    // Or a rounder one: on a gentle bend of a wide road the old shape holds the outer lanes straight into the outer kerb
    for (const handle of HANDLES) {
      if (handle === FALLBACK_HANDLE) break;
      const path = candidates.handle(handle);
      if (consider(handle, path)) return { choice: handle, path };
    }
    // One cubic cannot thread every acute two-leg mouth
    for (let w = 0; w < WAYPOINTS.length; w++) {
      const offset = WAYPOINTS[w]!;
      const point = { x: surface.centre.x + offset.x, y: surface.centre.y + offset.y };
      if (!surface.contains(point)) continue;
      for (let k = 0; k < WAYPOINT_SHARES.length; k++) {
        const choice = { ...point, share: WAYPOINT_SHARES[k]! };
        const path = candidates.through(w, k, point);
        if (consider(choice, path)) return { choice, path };
      }
    }
    const found = alternate as { choice: TurnChoice; path: Polyline } | null;
    return found ? { choice: found.choice, path: found.path } : null;
  }
  for (const handle of HANDLES) {
    if (handle === FALLBACK_HANDLE) return { choice: FALLBACK_HANDLE, path: fallback };
    const path = candidates.handle(handle);
    const depth = swept(path);
    if (depth !== null && depth <= base) return { choice: handle, path };
  }
  return { choice: FALLBACK_HANDLE, path: fallback };
}
