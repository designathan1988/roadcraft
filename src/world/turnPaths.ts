import { type FrameOut, Polyline, newFrame } from '@core/polyline';
import { type Vec2, addScaled, dot, len, normalize, sub } from '@core/vec2';
import { GEO_EPS } from '@core/scalar';
import { type PolygonBands, insideBands, polygonBands } from '@core/polygonBands';
import type { NodeId, SegmentId } from './ids';
import type { Network } from './network';
import { Level, halfWidth } from './roadTypes';
import { mouthOverlapStrip } from './junction/mouthOverlap';
import { BODY_ENVELOPE, HEAVY, type BodyClass } from './conflictPoints';
import { m, stepsIn } from './units';
import { TurnDigest as Digest } from './turnDigest';
import { HEADING_CHORD, chordHeading } from './heading';
import { type Queue, type Rect, clearOfQueue, overlap, queueOf, rect } from './sweptBodies';
import type { JunctionTurns, TurnChoice } from './junctionTurns';

/**
 * The path a vehicle drives through a junction, as open as the kerbs allow.
 *
 * A turn used to be one cubic Bezier with handles of 0.65 of the chord for
 * every movement at every junction. Long handles hold the entry and exit
 * headings for most of the way and then bend hard in the middle, which is
 * what kept a bus's body off the kerb on the tightest right turn in the test
 * set - and it gave every OTHER turn the same hairpin. Measured on a crossroads
 * of avenues, the left turn's tightest radius was 7.7 m where the same chord
 * allows 17.8 m, and a right turn 5.1 m where 10.3 m fits; at a comfortable
 * lateral acceleration that is the difference between 15 and 25 km/h, and it
 * was the whole of "they slow right down to turn and crawl round the corner".
 *
 * Each movement now takes the SHORTEST handle (the widest, most circular
 * curve) for which the largest body in the fleet, swept along it, stays on the
 * carriageway or the kerb of this junction and its legs. Smaller bodies are
 * nested inside the largest at every centre position, so one sweep answers
 * for all of them. When nothing shorter fits, the old 0.65 is kept, so no
 * movement can come out tighter than it was.
 */

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
  /** Its edges by band (`core/polygonBands.ts`), made the first time a point is tested against it. */
  bands: PolygonBands | null;
}

/**
 * A ring's box and digest, kept with the ring's own point list. Every rebuild
 * asks every junction for its surface (its key decides whether the junction's
 * turns can be kept), and nearly every ring in it - a plate, a road's outline,
 * flattened once and kept by its `Ring` - is the same object as last time:
 * boxing and hashing it again on every rebuild was the greater part of the
 * graph's warm build.
 */
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
  const area: Area = { poly: points, box, hashA: digest.a, hashB: digest.b, bands: null };
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
const flat = (poly: Poly): Float64Array => Float64Array.from(poly.flatMap((p) => [p.x, p.y]));
const unflat = (xy: Float64Array): Vec2[] => Array.from({ length: xy.length / 2 }, (_, i) => ({ x: xy[i * 2]!, y: xy[i * 2 + 1]! }));

/** The drivable surface around one node: its junction plate and its legs. */
export class JunctionSurface {
  private readonly areas: Area[] = [];
  /** The ring that held the last point `contains` found (an index into `areas`). */
  private lastHit = 0;
  private readonly approaches = new Map<Polyline, ApproachPoses[]>();
  readonly centre: Vec2;
  /** Digest of every ring point, for `turnPath`'s memo. */
  readonly key: string;

  /** The surface round `node`; or, from its centre and flat rings (a worker's, `chooseTurnOf`), the same one, the same key. */
  constructor(from: Network | { readonly centre: Vec2; readonly rings: readonly Float64Array[] }, node?: NodeId) {
    const add = (ring: Poly): void => {
      if (ring.length < 3) return;
      this.areas.push(areaOf(ring));
    };
    if (!('ribbons' in from)) {
      this.centre = { x: from.centre.x, y: from.centre.y };
      for (const xy of from.rings) add(unflat(xy));
      this.key = surfaceKey(this.centre, this.areas);
      return;
    }
    const net = from;
    const at = net.doc.node(node!);
    this.centre = { x: at?.x ?? 0, y: at?.y ?? 0 };
    // A road's own outline and, on a curved road, the strips the drawn surface
    // lays across its mouths (`junction/mouthOverlap.ts`).
    const road = (segment: SegmentId, level: Level.Asphalt | Level.Curb, mouths: readonly NodeId[]): void => {
      const ribbon = net.ribbons.get(segment);
      if (!ribbon) return;
      const ring = ribbon.rings[level];
      if (ring && !ring.isEmpty) add(ring.flatten());
      const seg = net.doc.segments.get(segment);
      const trims = net.trims.get(segment);
      if (!seg?.curve || !trims) return;
      for (const end of mouths) {
        if (net.doc.degree(end) < 2) continue;
        const trim = (seg.a === end ? trims.a[level] : trims.b[level]) ?? 0;
        if (trim <= 0) continue;
        const strip = mouthOverlapStrip(ribbon.full, halfWidth(ribbon.road, level),
          seg.a === end ? trim : ribbon.full.length - trim);
        if (strip) add(strip);
      }
    };
    for (const level of [Level.Asphalt, Level.Curb] as const) {
      const junction = net.junctions.get(node!)?.get(level);
      for (const ring of junction?.rings ?? []) if (!ring.isEmpty) add(ring.flatten());
      for (const segment of net.doc.node(node!)?.incident ?? []) {
        // And the plate at the leg's far end: a body sweeps on past the
        // start of its exit lane, and where the leg is shorter than that it is
        // already crossing the next junction - drivable ground the sweep must
        // see (a swept path is checked over the whole manoeuvre). Left out,
        // a movement onto a short leg fitted no vehicle (fuzz
        // `turnOffSurface`, a 0.5-unit leg between two junctions).
        const seg = net.doc.segments.get(segment);
        const far = seg ? (seg.a === node! ? seg.b : seg.a) : undefined;
        road(segment, level, far === undefined || far === node ? [node!] : [node!, far]);
        if (far === undefined || far === node) continue;
        for (const farRing of net.junctions.get(far)?.get(level)?.rings ?? []) if (!farRing.isEmpty) add(farRing.flatten());
        // And the roads on beyond it: past a node with no plate (one road
        // bending on, a chain) the approach of a short leg is already the next
        // road's, and a body a length behind the stop line stands on it (fuzz
        // `turnOffSurface`, seed 36 of 60 operations: a 1.6-unit lane).
        for (const next of net.doc.node(far)?.incident ?? []) {
          if (next !== segment) road(next, level, [far]);
        }
      }
    }
    this.key = surfaceKey(this.centre, this.areas);
  }

  /** Its rings as flat x, y lists, in order: what a worker builds the same surface from. */
  flatRings(): Float64Array[] {
    return this.areas.map((a) => flat(a.poly));
  }

  /**
   * `approachPosesOf`, once per lane, body and starting point: every candidate
   * path of every movement out of that lane begins with the same positions.
   * DO NOT sweep them again per candidate - they were three in ten of all the
   * positions swept, each six containment tests, all repeating the first.
   */
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

  /**
   * Whether any of its rings holds `p`. The answer is the same whichever ring
   * is asked first, so the one that held the last point is asked first: a
   * sweep's points follow one another along the turn, mostly in one ring.
   */
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
  // A movement already aligned with both lanes is a straight line, and forcing
  // a curve through it only adds sampling error.
  const dir = normalize(chord);
  if (dot(dir, t0) > 0.9999 && dot(dir, t3) > 0.9999) return Polyline.fromPoints([a, b]);

  const handle = handleFraction * d;
  const p1 = addScaled(a, t0, handle);
  const p2 = addScaled(b, t3, -handle);
  const pts: Vec2[] = [];
  for (let i = 0; i <= STEPS; i++) {
    // Cosine spacing: a polyline's tangent at its very end is the direction of
    // its last chord, so clustering samples at both ends keeps the entry and
    // exit headings exact without extra points.
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

/**
 * Another inbound lane - of another approach, or the one beside this
 * movement's own - where a vehicle stands waiting at its stop line.
 * A turn must not swing a body over it: nothing there has been admitted to
 * anything, so no claim can protect it (`ConflictIndex.queueIntrusions`).
 */
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

/**
 * Where, in its sequence of positions, the last candidate swept for a body
 * left the surface (`sweep`); -1 before any did.
 */
interface FailHint { at: number }

/** Frames `sweep` samples into, made once (`Polyline.sampleAtInto`). */
const atFrame = newFrame(), behindFrame = newFrame(), aheadFrame = newFrame();
const corner = { x: 0, y: 0 };

/**
 * The body at `c` along the manoeuvre, headed along the chord about it, or
 * null when a corner or a side's middle is off the surface.
 */
function poseAt(surface: JunctionSurface, frameAt: (c: number, out: FrameOut) => FrameOut,
  c: number, length: number, width: number): Rect | null {
  const at = frameAt(c, atFrame);
  const t = chordHeading(frameAt(c - HEADING_CHORD, behindFrame).p, frameAt(c + HEADING_CHORD, aheadFrame).p, at.t);
  const px = at.p.x, py = at.p.y, tx = t.x, ty = t.y;
  for (const a of CORNER_ALONG) {
    for (const b of CORNER_ACROSS) {
      corner.x = px + tx * a * length - ty * b * width;
      corner.y = py + ty * a * length + tx * b * width;
      if (!surface.contains(corner)) return null;
    }
  }
  return rect({ x: px, y: py }, { x: tx, y: ty }, length, width);
}

/**
 * A body's positions on an approach lane, before its heading chord reaches
 * the turn: `sweep`'s first positions, from `first` on by SWEEP_STEP, up to
 * `next`, the first one whose chord reaches past the stop line (or the one
 * that left the surface).
 */
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

/**
 * Sweeps the largest body along the path. Null when it leaves the surface;
 * otherwise how far behind another approach's stop line the FRONT of a car
 * waiting there would have to stand to stay clear of it (0 when at the line
 * is clear already).
 *
 * The answer is "null if ANY position leaves the surface or folds onto a body
 * behind it, else the deepest queue it reaches" - it does not depend on the
 * order the positions are looked at. So it is asked in the order that costs
 * least: every position's corners first, then the bodies following one
 * another, then the waiting queues. Most candidates `chooseTurnFor` sweeps
 * leave the surface (108 282 of 128 206 sweeps in a 1 280 m city), and
 * those now stop before any body-against-body test. DO NOT fold the three
 * passes back into one loop: interleaved, every position of a sweep that
 * later leaves the kerb paid ~50 rectangle tests against the queues first
 * (158 M of them in that city, for nothing).
 */
function sweep(surface: JunctionSurface, inCentre: Polyline, path: Polyline, outCentre: Polyline,
  waiting: readonly Queue[], body: BodyClass = HEAVY, ends: RoadEnds = NO_ROAD_ENDS, hint?: FailHint): number | null {
  const { length, width } = BODY_ENVELOPE[body]!;
  const half = length / 2;
  const frameAt = (c: number, out: FrameOut): FrameOut =>
    c < 0 ? inCentre.sampleAtInto(Math.max(0, inCentre.length + c), out)
      : c <= path.length ? path.sampleAtInto(c, out)
        : outCentre.sampleAtInto(Math.min(outCentre.length, c - path.length), out);
  // Where a lane begins or ends at the end of a road, the body is never
  // beyond it: traffic comes into the map with its tail at the lane's start
  // and leaves it with its nose at the lane's end (`sim/vehicles/spawn.ts`).
  // A position past that end, clamped onto it, is a body standing half on the
  // grass where none ever stands - and on a stub the plate took nearly all
  // of, every movement through it fitted no body (fuzz `turnOffSurface`, seed
  // 10, a 0.3-unit lane left of a 14.6-unit stub).
  const first = ends.fromRoadEnd ? Math.max(-half, half - inCentre.length) : -half;
  const last = ends.toRoadEnd ? Math.min(path.length + half, path.length + outCentre.length - half) : path.length + half;
  // 1. The body's corners at every position, on the drawn surface.
  // Every SWEEP_STEP, and the last position itself: the body with its nose at
  // a road's end is where it stands before it leaves, and a step that fell
  // 0.6 short of it missed a corner 0.32 units over the side of a curved
  // stub (fuzz `turnOffSurface`, seed 12 of 60 operations).
  const poses: Rect[] = [];
  const along: number[] = [];
  let c = first;
  // The positions still wholly on the approach are the same for every
  // candidate path of this movement, and for every movement out of this lane:
  // they are found once (`approachPoses`) and taken from there. They are
  // the positions this loop would reach with them too, as long as it gets past
  // them before it stops (`next <= last`).
  const approach = surface.approachPoses(inCentre, body, first);
  if (approach.next <= last) {
    if (approach.offSurface) return null;
    for (let k = 0; k < approach.poses.length; k++) { poses.push(approach.poses[k]!); along.push(approach.along[k]!); }
    c = approach.next;
  }
  // The position where the last candidate left the surface, first: the
  // candidates of one movement differ a little in shape, and most of those
  // that leave it do so where the one before did. Its `c` is walked to with
  // the loop's own steps, so it is a position the loop below visits, and if
  // the body is off the surface there the sweep's answer is already null.
  if (hint && hint.at > poses.length) {
    let k = poses.length, probe = c;
    while (k < hint.at && probe <= last) { probe = probe < last ? Math.min(last, probe + SWEEP_STEP) : Infinity; k++; }
    if (probe <= last && !poseAt(surface, frameAt, probe, length, width)) return null;
  }
  for (; c <= last; c = c < last ? Math.min(last, c + SWEEP_STEP) : Infinity) {
    const pose = poseAt(surface, frameAt, c, length, width);
    if (!pose) {
      if (hint) hint.at = poses.length;
      return null;
    }
    poses.push(pose);
    along.push(c);
  }
  // 2. Bodies already swept along the turn, to find a path that folds back on
  // itself: two of this size following one another on it, a car length and
  // a gap apart along it, would stand inside each other (an acute hairpin).
  // And the one following still on the approach, a body and a gap behind the
  // line: a path that hooks back towards its own approach puts the turning
  // body on top of the next car in that lane (a right turn passing 1.3 units
  // from its approach, fuzz `bodyOverlap`, seed 16). The swept path is the
  // whole manoeuvre, the queue behind it included.
  // Only where the approach really is: on one shorter than that, a position
  // clamped to its start is not a body a length behind.
  const behind: Rect[] = [];
  const behindAt: number[] = [];
  const queueFrom = Math.max(-half - length - FOLLOW_GAP, ends.fromRoadEnd ? half - inCentre.length : -inCentre.length);
  for (let c = queueFrom; c < -half; c += SWEEP_STEP) {
    const at = frameAt(c, atFrame);
    behind.push(rect(at.p, at.t, length, width));
    behindAt.push(c);
  }
  const reach = length + FOLLOW_GAP;
  for (let k = 0; k < poses.length; k++) {
    const c = along[k]!, pose = poses[k]!;
    // Only once the body has started to turn: behind its own line it is in its
    // own lane, and a car beside it in the next lane is lane discipline.
    if (c < 0) {
      if (c >= -inCentre.length) { behind.push(pose); behindAt.push(c); }
      continue;
    }
    // `behindAt` rises, so `c - behindAt[j]` only falls: the bodies a length
    // and a gap back are a prefix of the list, and the first one nearer ends it.
    for (let j = 0; j < behind.length && c - behindAt[j]! >= reach; j++) {
      if (overlap(pose, behind[j]!)) return null;
    }
    behind.push(pose);
    behindAt.push(c);
  }
  // 3. The deepest a waiting queue has to stand back. A car no further back
  // than the depth already found cannot deepen it, so each queue is read from
  // its back only down to there - and not at all when the body's bounding
  // circle is clear of the box its cars stand in.
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

/**
 * The widest turn path whose swept body stays on the junction's surface.
 *
 * `surface` null (a node with no drawn plate, such as a tunnel) keeps the
 * conservative handle.
 */
export interface TurnPathResult {
  readonly path: Polyline;
  /** Largest physical body whose swept corners fit; -1 if even a small body cannot. */
  readonly maxBodyClass: BodyClass | -1;
}

/**
 * Whether the arriving lane begins, or the departing lane ends, at the end of
 * a road (`RoadDoc.mapEdge`), where traffic comes into the map or leaves it.
 */
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
  // A junction rebuilt for a change that did not move this movement (its
  // control, a ban, a lane link) asks for the same turn again. The chosen
  // handle depends only on the geometry the sweep reads - the approach and
  // exit near the junction, the waiting lanes, the surface, whether a lane
  // meets a road's end - so the junction keeps it under a digest of exactly
  // that (`JunctionTurns`), and the path rebuilt from it is the same one a
  // cold build makes.
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
  // The search already knows the largest body the chosen path fits: it is the
  // one the path was chosen for (see `chooseTurn`). DO NOT sweep the chosen
  // path again, class by class, to find it: that was one to three more full
  // sweeps for every movement, each answering what the search had just
  // measured.
  const { choice, path, body: maxBodyClass } = chooseTurn(inCentre, outCentre, surface, waiting, ends);
  turns?.keep(key, { choice, maxBodyClass });
  return { path, maxBodyClass };
}

/**
 * Turning round in a turning circle at a road's end (`junction/bulb.ts`):
 * from the arriving lane on into the circle, round it the far way at
 * `radius` from its centre, and out along the departing lane - as a car or a
 * bus turns in a cul-de-sac, keeping to its own side. A curve straight
 * across between two lanes a few metres apart fits no body; this one is
 * swept like any other turn for the largest that fits.
 */
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
  // On the circle 45° in from each end, joined to the lanes by cubics tangent to both: entered
  // further round, a bus swung its side out past the kerb return (measured, 60°: 0.7 m out).
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

/**
 * The tightest a body of each class turns, on its centreline: AASHTO's design
 * vehicles (Green Book Table 2-2b, via Iowa DOT 6A-2 and TxDOT Table 4-1) -
 * a car 21 ft, a city bus 37.8 ft, a single-unit lorry 38 ft; a motorcycle
 * about 3 m.
 */
const CENTRE_TURN_RADIUS: readonly number[] = [m(3), m(6.4), m(11.6)];

/**
 * A U-turn through an opening in the median (docs/source/VIAS.md V8, retorno): a
 * half circle from the end of the arriving lane round to the start of the
 * departing one, as wide as the two lanes are apart. A body takes it only if
 * it turns that tight (`CENTRE_TURN_RADIUS`) and stays on the road: a car
 * needs 12.8 m from lane to lane - the FHWA's median U-turn minimum from the
 * inner lane to the far one (18 ft of median, 12 ft lanes) - a bus 23 m.
 */
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


/**
 * The handle `turnPath` settles on, by sweeping the candidates.
 *
 * Shaped for the largest body that can make the movement at all: the bus
 * first, then a car, then a motorcycle - each movement its own design vehicle,
 * as a junction is designed for the large vehicles that turn there (SUMO's
 * `NBNodeShapeComputer::getDefaultRadius` sizes it only by the pairs that
 * admit one). The search used to ask for the bus alone and, when no candidate
 * fitted one, keep the old 0.65 handle - which on a 50-degree bend of an
 * avenue fitted not even a motorcycle, while a rounder curve fitted a car
 * (fuzz `turnOffSurface`, `open-bus-leaves-kerb-on-acute-turn`). Where the bus
 * fits, nothing here changed.
 */
export function chooseTurn(inCentre: Polyline, outCentre: Polyline, surface: JunctionSurface,
  waiting: readonly WaitingLane[], ends: RoadEnds): { choice: TurnChoice; path: Polyline; body: BodyClass | -1 } {
  const queues = waiting.map(waitingBodies);
  const candidates = new Candidates(inCentre, outCentre);
  for (const body of [HEAVY, 1, 0] as const) {
    const choice = chooseTurnFor(candidates, surface, queues, body, ends);
    // This body fits the choice: every candidate `chooseTurnFor` returns is one
    // its sweep kept on the surface (the waiting queues only grade a fit, they
    // never refuse one). And no larger body does: the candidates are the same
    // for every size, the same paths made the same way, and for each larger
    // body every one of them, this one included, left the surface.
    if (choice !== null) return { ...choice, body };
  }
  // No size fits even the fallback, which every size swept first.
  return { choice: FALLBACK_HANDLE, path: candidates.handle(FALLBACK_HANDLE), body: -1 };
}

/**
 * The interior waypoints `chooseTurnFor` tries, as offsets from the node:
 * a 5 x 5 grid 2 m apart, nearest the node first.
 */
const WAYPOINTS: readonly Vec2[] = (() => {
  const offsets: Vec2[] = [];
  for (const dx of [-4, -2, 0, 2, 4].map(m)) for (const dy of [-4, -2, 0, 2, 4].map(m))
    offsets.push({ x: dx, y: dy });
  return offsets.sort((a, b) => a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y || a.x - b.x || a.y - b.y);
})();
const WAYPOINT_SHARES = [0.3, 0.4] as const;

/**
 * The candidate paths of one movement, each made the first time it is asked
 * for and then kept: the bus, the car and the motorcycle are tried on the
 * same candidates (`chooseTurn`), and a movement that fits no bus asked for
 * every one of them three times over. DO NOT build them per body size again.
 */
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
  // The fallback is also the shape every movement was built with before, so a
  // movement that fits at no shorter handle is exactly as it was - and no
  // rounder path may swing a body further over a waiting queue than it did.
  const base = swept(fallback);
  if (base === null) {
    // Even the old shape overruns (a bus round a tight bend): a squarer path
    // holds the lane longer before it turns, which is how a long vehicle is
    // actually driven round such a corner.
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
    // Or a rounder one: on a gentle bend of a wide road the old shape holds the
    // outer lanes straight into the outer kerb, where an even curve keeps a car
    // in its lane all the way round.
    for (const handle of HANDLES) {
      if (handle === FALLBACK_HANDLE) break;
      const path = candidates.handle(handle);
      if (consider(handle, path)) return { choice: handle, path };
    }
    // One cubic cannot thread every acute two-leg mouth: in a seeded 72-degree
    // bend even the motorcycle's centreline left the asphalt by 2.7 units.
    // Search a small, deterministic grid of interior waypoints only for those
    // otherwise impossible movements. Every candidate retains the inlet and
    // outlet tangents; the same swept-body test decides if it is safe.
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
