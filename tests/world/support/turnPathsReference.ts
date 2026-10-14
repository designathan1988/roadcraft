import { Polyline } from '@core/polyline';
import { pointInPolygon } from '@core/polygon';
import { type Vec2, addScaled, len, normalize, sub } from '@core/vec2';
import { GEO_EPS } from '@core/scalar';
import { BODY_ENVELOPE, HEAVY, type BodyClass } from '@world/conflictPoints';
import { HEADING_CHORD, chordHeading } from '@world/heading';
import { m } from '@world/units';
import { bezierTurn, type JunctionSurface, type RoadEnds, type WaitingLane } from '@world/turnPaths';

/**
 * The turn-shape search as it was before it was made fast (2026-10-14), kept
 * frozen as the oracle of `turnPathsEquivalence.spec.ts`: every candidate
 * swept position by position, every corner tested against every ring with
 * the plain crossings test, every body against every queued car, and the
 * chosen path swept again per body size for `maxBodyClass`. The fast search
 * must give the same paths and the same body class, bit for bit.
 * DO NOT "fix" or speed this file up: its whole value is being the old code.
 */

const HANDLES = [0.39, 0.44, 0.49, 0.54, 0.59, 0.65] as const;
const FALLBACK_HANDLE = 0.65;
const SQUARER = [0.72, 0.8] as const;
const STEPS = 48;
const SWEEP_STEP = m(0.6);
const FOLLOW_GAP = m(1);
const QUEUE_REACH = BODY_ENVELOPE[HEAVY]!.length * 1.5;
const NO_ROAD_ENDS: RoadEnds = { fromRoadEnd: false, toRoadEnd: false };

interface Box { minX: number; minY: number; maxX: number; maxY: number }
interface Ring { poly: readonly Vec2[]; box: Box }

/** The old `JunctionSurface.contains`: every ring, box first, then the crossings test. */
export class ReferenceSurface {
  private readonly rings: Ring[];
  readonly centre: Vec2;

  constructor(surface: JunctionSurface) {
    // The surface's rings, read from its private list (the oracle must not use its new index).
    const areas = (surface as unknown as { areas: { poly: readonly Vec2[]; box: Box }[] }).areas;
    this.rings = areas.map((a) => ({ poly: a.poly, box: a.box }));
    this.centre = surface.centre;
  }

  get empty(): boolean {
    return this.rings.length === 0;
  }

  contains(p: Vec2): boolean {
    for (const a of this.rings) {
      if (p.x < a.box.minX || p.x > a.box.maxX || p.y < a.box.minY || p.y > a.box.maxY) continue;
      if (pointInPolygon(p, a.poly)) return true;
    }
    return false;
  }
}

interface Rect { cx: number; cy: number; ux: number; uy: number; hl: number; hw: number; r: number }

const rect = (p: Vec2, t: Vec2, length: number, width: number): Rect =>
  ({ cx: p.x, cy: p.y, ux: t.x, uy: t.y, hl: length / 2, hw: width / 2, r: Math.hypot(length, width) / 2 });

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

function waitingBodies(lane: WaitingLane): Rect[] {
  const car = BODY_ENVELOPE[1]!;
  const out: Rect[] = [];
  for (let back = car.length / 2; back <= QUEUE_REACH; back += SWEEP_STEP) {
    const f = lane.centre.sampleAt(Math.max(0, lane.centre.length - back));
    out.push(rect(f.p, f.t, car.length, car.width));
  }
  return out;
}

function sweep(surface: ReferenceSurface, inCentre: Polyline, path: Polyline, outCentre: Polyline,
  waiting: readonly Rect[][], body: BodyClass = HEAVY, ends: RoadEnds = NO_ROAD_ENDS): number | null {
  const { length, width } = BODY_ENVELOPE[body]!;
  const half = length / 2;
  const frameAt = (c: number) =>
    c < 0 ? inCentre.sampleAt(Math.max(0, inCentre.length + c))
      : c <= path.length ? path.sampleAt(c)
        : outCentre.sampleAt(Math.min(outCentre.length, c - path.length));
  const first = ends.fromRoadEnd ? Math.max(-half, half - inCentre.length) : -half;
  const last = ends.toRoadEnd ? Math.min(path.length + half, path.length + outCentre.length - half) : path.length + half;
  let depth = 0;
  const behind: { c: number; body: Rect }[] = [];
  const queueFrom = Math.max(-half - length - FOLLOW_GAP, ends.fromRoadEnd ? half - inCentre.length : -inCentre.length);
  for (let c = queueFrom; c < -half; c += SWEEP_STEP) {
    const at = frameAt(c);
    behind.push({ c, body: rect(at.p, at.t, length, width) });
  }
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

/** The old `turnFits`. */
export function referenceTurnFits(inCentre: Polyline, path: Polyline, outCentre: Polyline,
  surface: ReferenceSurface, body: BodyClass, ends: RoadEnds = NO_ROAD_ENDS): boolean {
  return sweep(surface, inCentre, path, outCentre, [], body, ends) !== null;
}

type TurnChoice = number | { x: number; y: number; share: number };
const makeChoice = (a: Polyline, b: Polyline, choice: TurnChoice): Polyline =>
  typeof choice === 'number' ? bezierTurn(a, b, choice) :
    twoPieceTurn(a, b, { x: choice.x, y: choice.y }, choice.share);

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

function chooseTurn(inCentre: Polyline, outCentre: Polyline, surface: ReferenceSurface,
  waiting: readonly WaitingLane[], ends: RoadEnds): TurnChoice {
  const queues = waiting.map(waitingBodies);
  for (const body of [HEAVY, 1, 0] as const) {
    const choice = chooseTurnFor(inCentre, outCentre, surface, queues, body, ends);
    if (choice !== null) return choice;
  }
  return FALLBACK_HANDLE;
}

function chooseTurnFor(inCentre: Polyline, outCentre: Polyline, surface: ReferenceSurface,
  queues: readonly Rect[][], body: BodyClass, ends: RoadEnds): TurnChoice | null {
  const fallback = bezierTurn(inCentre, outCentre, FALLBACK_HANDLE);
  const base = sweep(surface, inCentre, fallback, outCentre, queues, body, ends);
  if (base === null) {
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
    for (const handle of HANDLES) {
      if (handle === FALLBACK_HANDLE) break;
      if (consider(handle, bezierTurn(inCentre, outCentre, handle))) return handle;
    }
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

/** The old `turnPath`, without its memo: the path and the largest body it fits. */
export function referenceTurnPath(inCentre: Polyline, outCentre: Polyline, surface: JunctionSurface | null,
  waiting: readonly WaitingLane[] = [], ends: RoadEnds = NO_ROAD_ENDS): { path: Polyline; maxBodyClass: BodyClass | -1 } {
  if (!surface || surface.empty) return { path: bezierTurn(inCentre, outCentre, FALLBACK_HANDLE), maxBodyClass: HEAVY };
  const ref = new ReferenceSurface(surface);
  const choice = chooseTurn(inCentre, outCentre, ref, waiting, ends);
  const path = makeChoice(inCentre, outCentre, choice);
  const maxBodyClass = ([HEAVY, 1, 0] as const).find((body) =>
    referenceTurnFits(inCentre, path, outCentre, ref, body, ends)) ?? -1;
  return { path, maxBodyClass };
}
