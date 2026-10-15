import { Digest } from '@core/digest';
import { segSeg } from '@core/intersect';
import { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';
import { m } from './units';
import { HEADING_CHORD, chordHeading } from './heading';
import type { ChosenTurn, SurfaceRings, TurnAsk } from './junctionTurns';
import type { CornerMeasurer } from './walkingLines';

/**
 * WHERE TWO MOVEMENTS' BODIES MEET, measured from their sampled sweeps alone
 * (`conflictPoints.ts` keeps the sweeps, the caches and the index). Pure: no
 * graph, no lanelet, no document - a pair's table is a function of its two
 * sweeps' frames and three numbers each, so a worker measures it as well as
 * the page (`conflictTable.worker.ts`, `conflictPool.ts`). Moved out of
 * `conflictPoints.ts` unchanged (2026-10-14).
 */

/**
 * Size classes a conflict zone is measured for.
 *
 * World knows nothing about the fleet, so the classes are envelopes in metres
 * and the simulation maps each archetype to the smallest one containing it
 * (`bodyClassOf`); `tests/world/conflictZones.spec.ts` checks every archetype
 * fits. Three classes are enough to separate what matters: two cars in a pair
 * of turn lanes do not touch, two buses in the same pair do.
 */
export type BodyClass = 0 | 1 | 2;
export const BODY_CLASSES: readonly BodyClass[] = [0, 1, 2];
export const BODY_CLASS_NAMES = ['small', 'car', 'heavy'] as const;
export const BODY_ENVELOPE: readonly { readonly length: number; readonly width: number }[] = [
  { length: m(2.2), width: m(0.9) },
  { length: m(5.7), width: m(2.05) },
  { length: m(12.1), width: m(2.6) },
];
export const HEAVY: BodyClass = 2;

/**
 * Sampling step of the body centre along a movement, world units. Each sampled
 * rectangle is lengthened by half a step at both ends, so consecutive samples
 * overlap and a thin conflict cannot fall between two of them.
 */
export const SWEEP_STEP = m(0.4);
/**
 * How far behind its stop line the front of a waiting body is swept, world
 * units: vehicles stop a few units short of the line, and a long one turning
 * beside them swings over that much of the lane next to it (see `inRange`).
 */
const QUEUE_BACK = m(3.2);

/** A sweep's first sample and count: from a heavy body a little short of its stop line (`QUEUE_BACK`) to its rear past the movement's end (`length`). */
export function sweepSpan(length: number): { c0: number; count: number } {
  const heavy = BODY_ENVELOPE[HEAVY] as { length: number; width: number };
  const c0 = -heavy.length / 2 - QUEUE_BACK;
  const c1 = length + heavy.length / 2;
  return { c0, count: Math.max(2, Math.ceil((c1 - c0) / SWEEP_STEP) + 1) };
}

/** Clearance kept around every body, world units (6 cm). */
const SWEEP_MARGIN = m(0.06);
/** Broad-phase cell size, world units. */
const CELL = m(3.2);

/**
 * What one movement's sweep is sampled from, as plain numbers (`ConflictIndex.prepare` asks, a worker
 * answers by `sampleSweep`): the approach, the movement and the exit as flat x, y lists (`Polyline.xy`,
 * never changed once made: handed over as they are, copied once by the message), and where the samples
 * start and how many there are.
 */
export interface SweepAsk {
  readonly inXY: Float64Array;
  readonly crossXY: Float64Array;
  readonly outXY: Float64Array;
  readonly c0: number;
  readonly count: number;
}

/** A movement's sweep sampled (`sampleSweep`): its frame, and the digests the page keys it by. */
export interface SampledSweep {
  /** Per sample: centre x, y and unit tangent x, y (`SweepSamples.frame`). */
  readonly frame: Float64Array;
  readonly frameLengthSq: Float64Array;
  /** `lineDigest` of the approach, the movement and the exit. */
  readonly lines: readonly [number, number, number];
  /** `shapeDigest` of the frame and the movement's centreline. */
  readonly shape: number;
}

/** Digest of a centreline's points: part of a sweep's cache key (`conflictPoints.ts` `sweepOf`). */
export function lineDigest(xy: Float64Array): number {
  return new Digest().addAll(xy).value();
}

/**
 * Digest of a sweep's frame and its movement's centreline: what a pair's key is made of (`conflictPoints.ts`
 * `measureShape`). Only a key: a collision costs a recompute, never a wrong answer, because a hit is
 * confirmed by comparing the values. It was a plain FNV-1a over the bytes, which mirrored movements beat:
 * negating a double flips only its top bit, a multiply never carries a top bit down, and the flips
 * cancelled in pairs - so in a town laid out symmetrically about the origin every movement shared its key
 * with its mirror image, the two threw each other out of the cache, and every rebuild measured some six
 * hundred pairs again (a third of a second). `Digest` mixes its words.
 */
export function shapeDigest(frame: Float64Array, centre: Float64Array): number {
  return new Digest().addAll(frame).addAll(centre).value();
}

/**
 * The approach, the movement and the exit as one arc-length parameter.
 * Beyond either end the path continues straight along its end tangent, so a
 * very short approach still places the tail of a long body somewhere sensible.
 */
export function joinedPath(inbound: Polyline, crossing: Polyline, outbound: Polyline): { sampleAt(c: number): { p: Vec2; t: Vec2 } } {
  return {
    sampleAt(c: number): { p: Vec2; t: Vec2 } {
      if (c < 0) {
        const s = inbound.length + c;
        if (s >= 0) return inbound.sampleAt(s);
        const f = inbound.sampleAt(0);
        return { p: { x: f.p.x + f.t.x * s, y: f.p.y + f.t.y * s }, t: f.t };
      }
      if (c <= crossing.length) return crossing.sampleAt(c);
      const s = c - crossing.length;
      if (s <= outbound.length) return outbound.sampleAt(s);
      const f = outbound.sampleAt(outbound.length);
      const over = s - outbound.length;
      return { p: { x: f.p.x + f.t.x * over, y: f.p.y + f.t.y * over }, t: f.t };
    },
  };
}

/**
 * The frame of a sweep: `count` body centres `SWEEP_STEP` apart from `c0` along the joined path, each
 * pointed along the same chord the drawn body is (`HEADING_CHORD`). A function of the three centrelines
 * and the two numbers alone, so the page and a worker make the same one, bit for bit.
 */
export function sweepFrame(path: { sampleAt(c: number): { p: Vec2; t: Vec2 } }, c0: number, count: number): Float64Array {
  const frame = new Float64Array(count * 4);
  for (let i = 0; i < count; i++) {
    const at = c0 + i * SWEEP_STEP;
    const f = path.sampleAt(at);
    const t = chordHeading(path.sampleAt(at - HEADING_CHORD).p, path.sampleAt(at + HEADING_CHORD).p, f.t);
    frame[i * 4] = f.p.x;
    frame[i * 4 + 1] = f.p.y;
    frame[i * 4 + 2] = t.x;
    frame[i * 4 + 3] = t.y;
  }
  return frame;
}

/** Squared tangent length per sample of a frame (`SweepSamples.frameLengthSq`). */
export function frameLengthsOf(frame: Float64Array): Float64Array {
  const count = frame.length / 4;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const x = frame[i * 4 + 2]!, y = frame[i * 4 + 3]!;
    out[i] = x * x + y * y;
  }
  return out;
}

/**
 * One movement's sweep sampled from plain numbers, as `conflictPoints.ts` `sweepOf` and `measureShape`
 * would on the page: what a worker does (`conflictTable.worker.ts`). `lines`: the centrelines already
 * made from the same lists, with their digests (a lane is the approach or exit of several movements).
 */
export function sampleSweep(ask: SweepAsk, lines?: Map<Float64Array, { line: Polyline; digest: number }>): SampledSweep {
  const lineOf = (xy: Float64Array): { line: Polyline; digest: number } => {
    let known = lines?.get(xy);
    if (!known) {
      known = { line: Polyline.fromFlat(xy), digest: lineDigest(xy) };
      lines?.set(xy, known);
    }
    return known;
  };
  const inbound = lineOf(ask.inXY), crossing = lineOf(ask.crossXY), outbound = lineOf(ask.outXY);
  const frame = sweepFrame(joinedPath(inbound.line, crossing.line, outbound.line), ask.c0, ask.count);
  return {
    frame,
    frameLengthSq: frameLengthsOf(frame),
    lines: [inbound.digest, crossing.digest, outbound.digest],
    shape: shapeDigest(frame, ask.crossXY),
  };
}

/** Where two movements' centrelines first cross, with the arc position on each. */
export interface Crossing {
  readonly sA: number;
  readonly sB: number;
  readonly at: Vec2;
}

/** First intersection between two polylines, with arc positions on each (`conflictPoints.ts` keeps it with the pair). */
export function firstCrossing(a: readonly Vec2[], b: readonly Vec2[]): Crossing | null {
  let sA = 0;
  for (let i = 0; i + 1 < a.length; i++) {
    const a0 = a[i] as Vec2;
    const a1 = a[i + 1] as Vec2;
    const segA = Math.hypot(a1.x - a0.x, a1.y - a0.y);

    let sB = 0;
    for (let j = 0; j + 1 < b.length; j++) {
      const b0 = b[j] as Vec2;
      const b1 = b[j + 1] as Vec2;
      const segB = Math.hypot(b1.x - b0.x, b1.y - b0.y);
      const hit = segSeg(a0, a1, b0, b1);
      if (hit) {
        return { sA: sA + hit.t * segA, sB: sB + hit.u * segB, at: hit.point };
      }
      sB += segB;
    }
    sA += segA;
  }
  return null;
}

/** What `pairTable` reads of a movement's sweep (`conflictPoints.ts` `Sweep`), and the caches it keeps on it. */
export interface SweepSamples {
  /** First sampled centre arc position (negative: on the approach). */
  readonly c0: number;
  readonly count: number;
  /** The movement's own length (its crossing lanelet's): where a body's rear has left the box. */
  readonly length: number;
  /** Per sample: centre x, y and unit tangent x, y. */
  readonly frame: Float64Array;
  /** Squared tangent length per sample, shared by every pair using this sweep. */
  readonly frameLengthSq: Float64Array;
  /** A conservative bound around every sampled heavy-vehicle body. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /**
   * Broad phase of the HEAVY rectangles: cell key -> sample indices. Built
   * the first time a pair needs it (`gridOf`): a movement whose every pair is
   * answered from the cache never needs one.
   */
  grid: Map<number, number[]> | null;
  /** Body classes that may stand at each sampled centre, computed once. */
  range: Uint8Array | null;
}

function boundsOf(s: SweepSamples): { minX: number; minY: number; maxX: number; maxY: number } {
  if (s.bounds) return s.bounds;
  const [hl, hw] = halfExtent(HEAVY);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < s.count; i++) {
    const x = s.frame[i * 4] as number, y = s.frame[i * 4 + 1] as number;
    const tx = s.frame[i * 4 + 2] as number, ty = s.frame[i * 4 + 3] as number;
    const ex = Math.abs(tx) * hl + Math.abs(ty) * hw;
    const ey = Math.abs(ty) * hl + Math.abs(tx) * hw;
    minX = Math.min(minX, x - ex); maxX = Math.max(maxX, x + ex);
    minY = Math.min(minY, y - ey); maxY = Math.max(maxY, y + ey);
  }
  return (s.bounds = { minX, minY, maxX, maxY });
}

function gridOf(s: SweepSamples): Map<number, number[]> {
  if (s.grid) return s.grid;
  const grid = new Map<number, number[]>();
  const [hl, hw] = halfExtent(HEAVY);
  for (let i = 0; i < s.count; i++) {
    const x = s.frame[i * 4] as number;
    const y = s.frame[i * 4 + 1] as number;
    const tx = s.frame[i * 4 + 2] as number;
    const ty = s.frame[i * 4 + 3] as number;
    const ex = Math.abs(tx) * hl + Math.abs(ty) * hw;
    const ey = Math.abs(ty) * hl + Math.abs(tx) * hw;
    for (let gx = Math.floor((x - ex) / CELL); gx <= Math.floor((x + ex) / CELL); gx++) {
      for (let gy = Math.floor((y - ey) / CELL); gy <= Math.floor((y + ey) / CELL); gy++) {
        const key = cellKey(gx, gy);
        const list = grid.get(key);
        if (list) list.push(i);
        else grid.set(key, [i]);
      }
    }
  }
  s.grid = grid;
  return grid;
}

const cellKey = (x: number, y: number): number => (x + 32768) * 65536 + (y + 32768);

/** Half length and half width of each class's swept rectangle, built once. */
const HALF_EXTENT: readonly (readonly [number, number])[] = BODY_CLASSES.map((cls) => {
  const e = BODY_ENVELOPE[cls] as { length: number; width: number };
  return [e.length / 2 + SWEEP_STEP / 2 + SWEEP_MARGIN, e.width / 2 + SWEEP_MARGIN] as const;
});

function halfExtent(cls: BodyClass): readonly [number, number] {
  return HALF_EXTENT[cls] as readonly [number, number];
}

/** Whether sample `i` is a legal centre for a body of this class. */
/**
 * Whether a sample is a place a body of this class can be on the movement.
 *
 * The far end is where its rear has left the exit of the box. The near end
 * used to be where its FRONT reaches the stop line, so a body standing behind
 * its line was never inside any zone - and a car does stand behind its line,
 * a few units short of it, or further back in the queue. A bus turning right
 * off a short link swings its rear across the lane beside it well behind the
 * line; the car waiting there was outside every zone, so nothing held the bus
 * for it and nothing held it short of the bus, and the two bodies overlapped.
 * Every class is now swept from where the sweep starts: the front of the
 * longest body `QUEUE_BACK` short of the line.
 */
function inRange(s: SweepSamples, i: number, cls: BodyClass): boolean {
  const half = (BODY_ENVELOPE[cls] as { length: number }).length / 2;
  const c = s.c0 + i * SWEEP_STEP;
  return c >= s.c0 - 1e-9 && c <= s.length + half + 1e-9;
}

function rangeOf(s: SweepSamples): Uint8Array {
  if (s.range) return s.range;
  const range = new Uint8Array(s.count);
  for (let i = 0; i < s.count; i++) {
    let mask = 0;
    for (const cls of BODY_CLASSES) if (inRange(s, i, cls)) mask |= 1 << cls;
    range[i] = mask;
  }
  return (s.range = range);
}

function overlap(
  a: SweepSamples, i: number, ca: BodyClass,
  b: SweepSamples, j: number, cb: BodyClass,
): boolean {
  const [ahl, ahw] = halfExtent(ca);
  const [bhl, bhw] = halfExtent(cb);
  const ax = a.frame[i * 4] as number, ay = a.frame[i * 4 + 1] as number;
  const aux = a.frame[i * 4 + 2] as number, auy = a.frame[i * 4 + 3] as number;
  const bx = b.frame[j * 4] as number, by = b.frame[j * 4 + 1] as number;
  const bux = b.frame[j * 4 + 2] as number, buy = b.frame[j * 4 + 3] as number;
  const dx = bx - ax, dy = by - ay;
  // The four SAT axes are the two bodies' own frames. Their self-projections
  // are just the squared frame lengths, while the cross-projections share one
  // dot and one determinant. Reuse these instead of twenty dot products and
  // four helper calls for every candidate sample pair.
  const dot = aux * bux + auy * buy;
  const cross = aux * buy - auy * bux;
  const along = Math.abs(dot), across = Math.abs(cross);
  const aLength = a.frameLengthSq[i]!;
  const bLength = b.frameLengthSq[j]!;
  return Math.abs(dx * aux + dy * auy) < ahl * aLength + (bhl * along + bhw * across)
    && Math.abs(-dx * auy + dy * aux) < ahw * aLength + (bhl * across + bhw * along)
    && Math.abs(dx * bux + dy * buy) < (ahl * along + ahw * across) + bhl * bLength
    && Math.abs(-dx * buy + dy * bux) < (ahl * across + ahw * along) + bhw * bLength;
}

/** The 3 x 3 class pairs' [enterA, exitA, enterB, exitB] (NaN: none), or null when even two heavy bodies never touch. */
export function pairTable(a: SweepSamples, b: SweepSamples): Float64Array | null {
  const aa = boundsOf(a), bb = boundsOf(b);
  if (aa.maxX < bb.minX || bb.maxX < aa.minX || aa.maxY < bb.minY || bb.maxY < aa.minY) return null;
  // Heavy against heavy, through the grid.
  const hits: number[] = [];
  // Which of b's samples this sample of a has already tested: a stamp per
  // sample instead of a set cleared per sample.
  const seen = new Int32Array(b.count);
  const grid = gridOf(b);
  const [hl, hw] = halfExtent(HEAVY);
  for (let i = 0; i < a.count; i++) {
    const x = a.frame[i * 4] as number, y = a.frame[i * 4 + 1] as number;
    const tx = a.frame[i * 4 + 2] as number, ty = a.frame[i * 4 + 3] as number;
    const ex = Math.abs(tx) * hl + Math.abs(ty) * hw;
    const ey = Math.abs(ty) * hl + Math.abs(tx) * hw;
    const stamp = i + 1;
    for (let gx = Math.floor((x - ex) / CELL); gx <= Math.floor((x + ex) / CELL); gx++) {
      for (let gy = Math.floor((y - ey) / CELL); gy <= Math.floor((y + ey) / CELL); gy++) {
        const cell = grid.get(cellKey(gx, gy));
        if (!cell) continue;
        for (const j of cell) {
          if (seen[j] === stamp) continue;
          seen[j] = stamp;
          if (overlap(a, i, HEAVY, b, j, HEAVY)) hits.push(i, j);
        }
      }
    }
  }
  if (!hits.length) return null;

  const rangeA = rangeOf(a), rangeB = rangeOf(b);

  // 3 x 3 class pairs x [enterA, exitA, enterB, exitB]; NaN = no overlap.
  const table = new Float64Array(36).fill(Number.NaN);
  // The four SAT axes and their body projections are identical for all nine
  // class pairs at a sampled pose pair. Compute them once, then vary extents.
  const projection = new Float64Array(20);
  for (let k = 0; k < hits.length; k += 2) {
    const i = hits[k] as number, j = hits[k + 1] as number;
    const ax = a.frame[i * 4] as number, ay = a.frame[i * 4 + 1] as number;
    const aux = a.frame[i * 4 + 2] as number, auy = a.frame[i * 4 + 3] as number;
    const bx = b.frame[j * 4] as number, by = b.frame[j * 4 + 1] as number;
    const bux = b.frame[j * 4 + 2] as number, buy = b.frame[j * 4 + 3] as number;
    const dx = bx - ax, dy = by - ay;
    for (let axis = 0; axis < 4; axis++) {
      const nx = axis === 0 ? aux : axis === 1 ? -auy : axis === 2 ? bux : -buy;
      const ny = axis === 0 ? auy : axis === 1 ? aux : axis === 2 ? buy : bux;
      const at = axis * 5;
      projection[at] = Math.abs(dx * nx + dy * ny);
      projection[at + 1] = Math.abs(aux * nx + auy * ny);
      projection[at + 2] = Math.abs(-auy * nx + aux * ny);
      projection[at + 3] = Math.abs(bux * nx + buy * ny);
      projection[at + 4] = Math.abs(-buy * nx + bux * ny);
    }
    const cA = a.c0 + i * SWEEP_STEP;
    const cB = b.c0 + j * SWEEP_STEP;
    const eligibleA = rangeA[i] as number, eligibleB = rangeB[j] as number;
    for (const ca of BODY_CLASSES) {
      if (!(eligibleA & (1 << ca))) continue;
      const [ahl, ahw] = halfExtent(ca);
      for (const cb of BODY_CLASSES) {
        if (!(eligibleB & (1 << cb))) continue;
        if (ca !== HEAVY || cb !== HEAVY) {
          const [bhl, bhw] = halfExtent(cb);
          let separate = false;
          for (let axis = 0; axis < 4; axis++) {
            const at = axis * 5;
            const ra = ahl * (projection[at + 1] as number) + ahw * (projection[at + 2] as number);
            const rb = bhl * (projection[at + 3] as number) + bhw * (projection[at + 4] as number);
            if ((projection[at] as number) >= ra + rb) { separate = true; break; }
          }
          if (separate) continue;
        }
        const at = (ca * 3 + cb) * 4;
        widen(table, at, cA);
        widen(table, at + 2, cB);
      }
    }
  }

  return table;
}

function widen(table: Float64Array, at: number, c: number): void {
  const lo = table[at] as number;
  const hi = table[at + 1] as number;
  table[at] = Number.isNaN(lo) ? c : Math.min(lo, c);
  table[at + 1] = Number.isNaN(hi) ? c : Math.max(hi, c);
}

/**
 * Measures many pairs' tables somewhere else - the browser's workers
 * (`conflictPool.ts`) - each as `pairTable` would here, answered in the
 * order asked; rejected when it cannot (`ConflictIndex.prepare` then
 * measures them on the page). The same workers round the walkways' corners (`CornerMeasurer`).
 */
export interface PairMeasurer extends CornerMeasurer {
  /** `key`: the pair's key, under which a measurer that `keeps` stores its table for the next session. */
  measure(pairs: readonly { readonly a: SweepSamples; readonly b: SweepSamples; readonly key?: string }[]): Promise<readonly (Float64Array | null)[]>;
  /**
   * Whether it keeps the tables it measures for the next session itself (where it measures them): the
   * page then does not (`ConflictIndex.takeMeasured`). DO NOT keep them from the page: the structured
   * clone of a city's tables in one write held a frame 0.9 s (2026-10-15).
   */
  readonly keeps?: boolean;
  /**
   * Chooses many junction turns somewhere else, each as `turnPaths.ts` `chooseTurnOf` would here, answered
   * in the order asked; rejected when it cannot (the turns are then chosen on the page,
   * `LaneletGraph.redoProvisional`). Absent: every turn is chosen on the page.
   */
  chooseTurns?(asks: readonly TurnAsk[], surfaces: ReadonlyMap<string, SurfaceRings>): Promise<readonly ChosenTurn[]>;
  /**
   * Samples many movements' sweeps somewhere else, each as `sampleSweep` would here, answered in the
   * order asked; rejected when it cannot (`ConflictIndex.prepare` then samples them on the page). Absent:
   * every sweep is sampled on the page.
   */
  sampleSweeps?(asks: readonly SweepAsk[]): Promise<readonly SampledSweep[]>;
  /**
   * Finds many pairs' centreline crossings somewhere else, each as `firstCrossing` would here on the two
   * movements' own point lists (`Polyline.xy`), answered in the order asked; rejected when it cannot
   * (the conflict index then finds them on the page, `ConflictIndex.build`). Absent: found on the page.
   */
  crossings?(pairs: readonly { readonly a: Float64Array; readonly b: Float64Array }[]): Promise<readonly (Crossing | null)[]>;
}

// ------------------------------------------------------------------ zones

/**
 * `cross`: the two centrelines intersect. `merge`: both end in the same lane.
 * `swept`: the centrelines never meet, but the BODIES driven along them do —
 * opposing left turns that pass too close, a bus swinging its tail across the
 * lane beside it.
 */
export type ConflictKind = 'cross' | 'merge' | 'swept';

/**
 * Centre-arc interval over which a body of one class on one movement overlaps
 * the swept area of a body of another class on the other movement.
 *
 * Arc positions are of the BODY CENTRE along the movement, measured from the
 * stop line: negative while the centre is still on the approach, beyond the
 * connector length once it is on the exit lane.
 */
export interface Zone {
  readonly enter: number;
  readonly exit: number;
}

/** A connector's id (`lanelets.ts` `ConnectorId`), named here without importing the graph. */
type ConnectorId = string;

export interface ConflictRef {
  readonly point: number;
  /** Earliest front arc position of the zone, for ordering. */
  readonly s: number;
  readonly other: ConnectorId;
  readonly kind: ConflictKind;
  /**
   * Body-centre arc position past which a vehicle of each class has cleared
   * the zone against ANY vehicle on the other movement. -Infinity when that
   * class never touches it.
   */
  readonly exit: readonly number[];
}

/** Two movements out of the same lane: resolved by car-following, not claims. */
export interface Diverge {
  readonly other: ConnectorId;
  /** Centre arc past which a body of class `mine` on the OTHER movement is clear of `theirs` on this one. */
  otherExit(mine: BodyClass, theirs: BodyClass): number;
}

/** A pair of movements' zones as the conflict index reads them (`conflictPoints.ts` `ConflictIndex`), over the pair's table. */
export interface PairZones {
  /** Zone on `a` (`onB` false) or on `b` (true) for body `mine` against `theirs`. */
  get(mine: BodyClass, theirs: BodyClass, onB: boolean): Zone | null;
}

/** A pair's zones over its table (`pairTable`): what is kept between sessions. */
export function zonesOf(table: Float64Array): PairZones {
  return {
    get(mine, theirs, onB) {
      const at = onB ? (theirs * 3 + mine) * 4 + 2 : (mine * 3 + theirs) * 4;
      const enter = table[at] as number;
      if (Number.isNaN(enter)) return null;
      // Half a step either side covers the motion between two samples.
      return { enter: enter - SWEEP_STEP / 2, exit: (table[at + 1] as number) + SWEEP_STEP / 2 };
    },
  };
}

/**
 * What the index makes of a pair's zones for its conflict point (`ConflictIndex.add`) and its queue
 * intrusions (`recordIntrusions`): a function of the zones alone, so worked out once a pair and kept with
 * it (`CachedPair.facts`). DO NOT work them out again for each build: thirty zones a pair made and read
 * again, every pair of every junction built, were a fifth of a city's swap onto its new graph (2026-10-15).
 */
export interface PairFacts {
  readonly sA: number;
  readonly sB: number;
  /** Per class, the centre past which the body on `a` (`exitA`) or `b` is clear of any other body. Never changed. */
  readonly exitA: readonly number[];
  readonly exitB: readonly number[];
  /** The intrusions in the order `recordIntrusions` finds them: whose (`onB`) and the two classes. */
  readonly intrusions: readonly { readonly onB: boolean; readonly mine: BodyClass; readonly theirs: BodyClass }[];
}

export function pairFacts(zones: PairZones): PairFacts {
  const intrusions: { onB: boolean; mine: BodyClass; theirs: BodyClass }[] = [];
  for (const mine of BODY_CLASSES) {
    for (const theirs of BODY_CLASSES) {
      const onA = zones.get(mine, theirs, false);
      if (onA && onA.enter + (BODY_ENVELOPE[mine]?.length ?? 0) / 2 <= 0) intrusions.push({ onB: false, mine, theirs });
      const onB = zones.get(theirs, mine, true);
      if (onB && onB.enter + (BODY_ENVELOPE[theirs]?.length ?? 0) / 2 <= 0) intrusions.push({ onB: true, mine: theirs, theirs: mine });
    }
  }
  return { sA: earliestFront(zones, false), sB: earliestFront(zones, true), exitA: clearExits(zones, false), exitB: clearExits(zones, true), intrusions };
}

/** Earliest body-FRONT arc position at which any class enters the zone. */
function earliestFront(zones: PairZones, onB: boolean): number {
  let best = Infinity;
  for (const mine of BODY_CLASSES) {
    const z = zones.get(mine, HEAVY, onB);
    const half = (BODY_ENVELOPE[mine] as { length: number }).length / 2;
    if (z) best = Math.min(best, z.enter + half);
  }
  return best;
}

/** Per class, the centre past which the body is clear of any other body. */
function clearExits(zones: PairZones, onB: boolean): number[] {
  return BODY_CLASSES.map((mine) => {
    let exit = -Infinity;
    for (const theirs of BODY_CLASSES) {
      const z = zones.get(mine, theirs, onB);
      if (z) exit = Math.max(exit, z.exit);
    }
    return exit;
  });
}

export function pushDiverge(
  map: Map<ConnectorId, Diverge[]>,
  self: ConnectorId,
  other: ConnectorId,
  zones: PairZones,
  selfIsB: boolean,
): void {
  const entry: Diverge = {
    other,
    otherExit: (mine, theirs) => zones.get(mine, theirs, !selfIsB)?.exit ?? -Infinity,
  };
  const list = map.get(self);
  if (list) list.push(entry);
  else map.set(self, [entry]);
}

export function pushRef(
  map: Map<ConnectorId, ConflictRef[]>,
  key: ConnectorId,
  ref: ConflictRef,
): void {
  const list = map.get(key);
  if (list) list.push(ref);
  else map.set(key, [ref]);
}
