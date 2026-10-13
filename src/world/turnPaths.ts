import { Polyline } from '@core/polyline';
import { pointInPolygon } from '@core/polygon';
import { type Vec2, addScaled, dot, len, normalize, sub } from '@core/vec2';
import { GEO_EPS } from '@core/scalar';
import type { NodeId, SegmentId } from './ids';
import type { Network } from './network';
import { Level, halfWidth } from './roadTypes';
import { mouthOverlapStrip } from './junction/mouthOverlap';
import { BODY_ENVELOPE, HEAVY, type BodyClass } from './conflictPoints';
import { m, stepsIn } from './units';
import { HEADING_CHORD, chordHeading } from './heading';

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
interface Area { readonly poly: Poly; readonly box: Box; readonly hashA: number; readonly hashB: number }

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
  const area = { poly: points, box, hashA: digest.a, hashB: digest.b };
  areas.set(points, area);
  return area;
}

/** The drivable surface around one node: its junction plate and its legs. */
export class JunctionSurface {
  private readonly areas: Area[] = [];
  readonly centre: Vec2;
  /** Digest of every ring point, for `turnPath`'s memo. */
  readonly key: string;

  constructor(net: Network, node: NodeId) {
    const at = net.doc.node(node);
    this.centre = { x: at?.x ?? 0, y: at?.y ?? 0 };
    const add = (ring: Poly): void => {
      if (ring.length < 3) return;
      this.areas.push(areaOf(ring));
    };
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
      const junction = net.junctions.get(node)?.get(level);
      for (const ring of junction?.rings ?? []) if (!ring.isEmpty) add(ring.flatten());
      for (const segment of net.doc.node(node)?.incident ?? []) {
        // And the plate at the leg's far end: a body sweeps on past the
        // start of its exit lane, and where the leg is shorter than that it is
        // already crossing the next junction - drivable ground the sweep must
        // see (a swept path is checked over the whole manoeuvre). Left out,
        // a movement onto a short leg fitted no vehicle (fuzz
        // `turnOffSurface`, a 0.5-unit leg between two junctions).
        const seg = net.doc.segments.get(segment);
        const far = seg ? (seg.a === node ? seg.b : seg.a) : undefined;
        road(segment, level, far === undefined || far === node ? [node] : [node, far]);
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
    const digest = new Digest();
    digest.point(this.centre);
    for (const a of this.areas) digest.mix(a.hashA, a.hashB);
    this.key = digest.value();
  }

  get empty(): boolean {
    return this.areas.length === 0;
  }

  contains(p: Vec2): boolean {
    for (const a of this.areas) {
      if (p.x < a.box.minX || p.x > a.box.maxX || p.y < a.box.minY || p.y > a.box.maxY) continue;
      if (pointInPolygon(p, a.poly)) return true;
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

interface Rect { cx: number; cy: number; ux: number; uy: number; hl: number; hw: number; r: number }

const rect = (p: Vec2, t: Vec2, length: number, width: number): Rect =>
  ({ cx: p.x, cy: p.y, ux: t.x, uy: t.y, hl: length / 2, hw: width / 2, r: Math.hypot(length, width) / 2 });

/** Separating-axis test between two oriented rectangles. */
function overlap(a: Rect, b: Rect): boolean {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  if (dx * dx + dy * dy > (a.r + b.r) * (a.r + b.r)) return false;
  for (const [ax, ay] of [[a.ux, a.uy], [-a.uy, a.ux], [b.ux, b.uy], [-b.uy, b.ux]] as const) {
    const d = Math.abs(dx * ax + dy * ay);
    const ra = a.hl * Math.abs(a.ux * ax + a.uy * ay) + a.hw * Math.abs(-a.uy * ax + a.ux * ay);
    const rb = b.hl * Math.abs(b.ux * ax + b.uy * ay) + b.hw * Math.abs(-b.uy * ax + b.ux * ay);
    if (d >= ra + rb) return false;
  }
  return true;
}

/** Car-sized bodies standing in a waiting lane, front at the line and further back. */
function waitingBodies(lane: WaitingLane): Rect[] {
  const car = BODY_ENVELOPE[1]!;
  const out: Rect[] = [];
  for (let back = car.length / 2; back <= QUEUE_REACH; back += SWEEP_STEP) {
    const f = lane.centre.sampleAt(Math.max(0, lane.centre.length - back));
    out.push(rect(f.p, f.t, car.length, car.width));
  }
  return out;
}

/**
 * Sweeps the largest body along the path. Null when it leaves the surface;
 * otherwise how far behind another approach's stop line the FRONT of a car
 * waiting there would have to stand to stay clear of it (0 when at the line
 * is clear already).
 */
function sweep(surface: JunctionSurface, inCentre: Polyline, path: Polyline, outCentre: Polyline,
  waiting: readonly Rect[][], body: BodyClass = HEAVY, ends: RoadEnds = NO_ROAD_ENDS): number | null {
  const { length, width } = BODY_ENVELOPE[body]!;
  const half = length / 2;
  const frameAt = (c: number) =>
    c < 0 ? inCentre.sampleAt(Math.max(0, inCentre.length + c))
      : c <= path.length ? path.sampleAt(c)
        : outCentre.sampleAt(Math.min(outCentre.length, c - path.length));
  // Where a lane begins or ends at the end of a road, the body is never
  // beyond it: traffic comes into the map with its tail at the lane's start
  // and leaves it with its nose at the lane's end (`sim/vehicles/spawn.ts`).
  // A position past that end, clamped onto it, is a body standing half on the
  // grass where none ever stands - and on a stub the plate took nearly all
  // of, every movement through it fitted no body (fuzz `turnOffSurface`, seed
  // 10, a 0.3-unit lane left of a 14.6-unit stub).
  const first = ends.fromRoadEnd ? Math.max(-half, half - inCentre.length) : -half;
  const last = ends.toRoadEnd ? Math.min(path.length + half, path.length + outCentre.length - half) : path.length + half;
  let depth = 0;
  // Bodies already swept along the turn, to find a path that folds back on
  // itself: two of this size following one another on it, a car length and
  // a gap apart along it, would stand inside each other (an acute hairpin).
  const behind: { c: number; body: Rect }[] = [];
  // And the one following still on the approach, a body and a gap behind the
  // line: a path that hooks back towards its own approach puts the turning
  // body on top of the next car in that lane (a right turn passing 1.3 units
  // from its approach, fuzz `bodyOverlap`, seed 16). The swept path is the
  // whole manoeuvre, the queue behind it included.
  // Only where the approach really is: on one shorter than that, a position
  // clamped to its start is not a body a length behind.
  const queueFrom = Math.max(-half - length - FOLLOW_GAP, ends.fromRoadEnd ? half - inCentre.length : -inCentre.length);
  for (let c = queueFrom; c < -half; c += SWEEP_STEP) {
    const at = frameAt(c);
    behind.push({ c, body: rect(at.p, at.t, length, width) });
  }
  // Every SWEEP_STEP, and the last position itself: the body with its nose at
  // a road's end is where it stands before it leaves, and a step that fell
  // 0.6 short of it missed a corner 0.32 units over the side of a curved
  // stub (fuzz `turnOffSurface`, seed 12 of 60 operations).
  for (let c = first; c <= last; c = c < last ? Math.min(last, c + SWEEP_STEP) : Infinity) {
    const at = frameAt(c);
    const f = { p: at.p, t: chordHeading(frameAt(c - HEADING_CHORD).p, frameAt(c + HEADING_CHORD).p, at.t) };
    for (const along of [-0.5, 0, 0.5]) {
      for (const across of [-0.5, 0.5]) {
        const p = {
          x: f.p.x + f.t.x * along * length - f.t.y * across * width,
          y: f.p.y + f.t.y * along * length + f.t.x * across * width,
        };
        if (!surface.contains(p)) return null;
      }
    }
    // Only once the body has started to turn: behind its own line it is in its
    // own lane, and a car beside it in the next lane is lane discipline.
    const body = rect(f.p, f.t, length, width);
    if (c < 0) {
      if (c >= -inCentre.length) behind.push({ c, body });
      continue;
    }
    for (const earlier of behind) {
      if (c - earlier.c >= length + FOLLOW_GAP && overlap(body, earlier.body)) return null;
    }
    behind.push({ c, body });
    for (const lane of waiting) {
      for (let i = lane.length - 1; i >= 0; i--) {
        if (!overlap(body, lane[i]!)) continue;
        depth = Math.max(depth, (i + 1) * SWEEP_STEP);
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
  waiting: readonly WaitingLane[] = [], ends: RoadEnds = NO_ROAD_ENDS): TurnPathResult {
  if (!surface || surface.empty) return {
    path: bezierTurn(inCentre, outCentre, FALLBACK_HANDLE), maxBodyClass: HEAVY,
  };
  // Every rebuild re-derives every movement of every junction, and nearly all
  // of them are unchanged by an edit elsewhere. The chosen handle depends only
  // on the geometry the sweep reads - the approach and exit near the junction,
  // the waiting lanes, the surface, whether a lane meets a road's end - so it
  // is memoised on a digest of exactly that, and the path rebuilt from it is
  // the same one a cold build makes.
  const key = `${laneEndKey(inCentre, true)}|${laneEndKey(outCentre, false)}|${surface.key}|` +
    `${ends.fromRoadEnd ? 1 : 0}${ends.toRoadEnd ? 1 : 0}|` +
    waiting.map((lane) => laneEndKey(lane.centre, true, QUEUE_REACH)).join(',');
  const known = memo.get(key);
  if (known !== undefined) return {
    path: makeChoice(inCentre, outCentre, known.choice), maxBodyClass: known.maxBodyClass,
  };
  if (memo.size > MEMO_LIMIT) memo.clear();
  const choice = chooseTurn(inCentre, outCentre, surface, waiting, ends);
  const path = makeChoice(inCentre, outCentre, choice);
  const maxBodyClass = ([HEAVY, 1, 0] as const).find((body) =>
    turnFits(inCentre, path, outCentre, surface, body, ends)) ?? -1;
  memo.set(key, { choice, maxBodyClass });
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
export const CENTRE_TURN_RADIUS: readonly number[] = [m(3), m(6.4), m(11.6)];

/**
 * A U-turn through an opening in the median (docs/VIAS.md V8, retorno): a
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

type TurnChoice = number | { x: number; y: number; share: number };
const memo = new Map<string, { choice: TurnChoice; maxBodyClass: BodyClass | -1 }>();
const MEMO_LIMIT = 50_000;
const makeChoice = (a: Polyline, b: Polyline, choice: TurnChoice): Polyline =>
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

/** FNV-1a over numbers quantised to 1e-5, as two 32-bit lanes. */
class Digest {
  a = 0x811c9dc5;
  b = 0x01000193;
  /** Folds in another digest's two lanes. */
  mix(a: number, b: number): void {
    this.a = Math.imul(this.a ^ a, 0x01000193) >>> 0;
    this.b = Math.imul(this.b ^ b, 0x5bd1e995) >>> 0;
    this.b = (this.b ^ (this.b >>> 13)) >>> 0;
  }
  add(n: number): void {
    const q = Math.round(n * 1e5);
    this.a = Math.imul(this.a ^ (q & 0xffff), 0x01000193) >>> 0;
    this.a = Math.imul(this.a ^ ((q >>> 16) & 0xffff), 0x01000193) >>> 0;
    this.b = Math.imul(this.b ^ q, 0x5bd1e995) >>> 0;
    this.b = (this.b ^ (this.b >>> 13)) >>> 0;
  }
  point(p: Vec2): void {
    this.add(p.x);
    this.add(p.y);
  }
  value(): string {
    return `${this.a.toString(36)}${this.b.toString(36)}`;
  }
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
function chooseTurn(inCentre: Polyline, outCentre: Polyline, surface: JunctionSurface,
  waiting: readonly WaitingLane[], ends: RoadEnds): TurnChoice {
  const queues = waiting.map(waitingBodies);
  for (const body of [HEAVY, 1, 0] as const) {
    const choice = chooseTurnFor(inCentre, outCentre, surface, queues, body, ends);
    if (choice !== null) return choice;
  }
  return FALLBACK_HANDLE;
}

/** The handle for one body size; null when no candidate keeps that body on the surface. */
function chooseTurnFor(inCentre: Polyline, outCentre: Polyline, surface: JunctionSurface,
  queues: readonly Rect[][], body: BodyClass, ends: RoadEnds): TurnChoice | null {
  const fallback = bezierTurn(inCentre, outCentre, FALLBACK_HANDLE);
  // The fallback is also the shape every movement was built with before, so a
  // movement that fits at no shorter handle is exactly as it was - and no
  // rounder path may swing a body further over a waiting queue than it did.
  const base = sweep(surface, inCentre, fallback, outCentre, queues, body, ends);
  if (base === null) {
    // Even the old shape overruns (a bus round a tight bend): a squarer path
    // holds the lane longer before it turns, which is how a long vehicle is
    // actually driven round such a corner.
    for (const handle of SQUARER) {
      const path = bezierTurn(inCentre, outCentre, handle);
      if (sweep(surface, inCentre, path, outCentre, queues, body, ends) !== null) return handle;
    }
    let alternate: { choice: TurnChoice; depth: number } | null = null;
    const consider = (choice: TurnChoice, path: Polyline): boolean => {
      const depth = sweep(surface, inCentre, path, outCentre, queues, body, ends);
      if (depth === null) return false;
      if (depth === 0) return true;
      if (!alternate || depth < alternate.depth) alternate = { choice, depth };
      return false;
    };
    // Or a rounder one: on a gentle bend of a wide road the old shape holds the
    // outer lanes straight into the outer kerb, where an even curve keeps a car
    // in its lane all the way round.
    for (const handle of HANDLES) {
      if (handle === FALLBACK_HANDLE) break;
      if (consider(handle, bezierTurn(inCentre, outCentre, handle))) return handle;
    }
    // One cubic cannot thread every acute two-leg mouth: in a seeded 72-degree
    // bend even the motorcycle's centreline left the asphalt by 2.7 units.
    // Search a small, deterministic grid of interior waypoints only for those
    // otherwise impossible movements. Every candidate retains the inlet and
    // outlet tangents; the same swept-body test decides if it is safe.
    const offsets: Vec2[] = [];
    for (const dx of [-4, -2, 0, 2, 4].map(m)) for (const dy of [-4, -2, 0, 2, 4].map(m))
      offsets.push({ x: dx, y: dy });
    offsets.sort((a, b) => a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y || a.x - b.x || a.y - b.y);
    for (const offset of offsets) {
      const point = { x: surface.centre.x + offset.x, y: surface.centre.y + offset.y };
      if (!surface.contains(point)) continue;
      for (const share of [0.3, 0.4]) {
        const choice = { ...point, share };
        if (consider(choice, twoPieceTurn(inCentre, outCentre, point, share))) return choice;
      }
    }
    return (alternate as { choice: TurnChoice } | null)?.choice ?? null;
  }
  for (const handle of HANDLES) {
    if (handle === FALLBACK_HANDLE) return FALLBACK_HANDLE;
    const path = bezierTurn(inCentre, outCentre, handle);
    const depth = sweep(surface, inCentre, path, outCentre, queues, body, ends);
    if (depth !== null && depth <= base) return handle;
  }
  return FALLBACK_HANDLE;
}
