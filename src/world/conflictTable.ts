import { m } from './units';

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
/** Clearance kept around every body, world units (6 cm). */
const SWEEP_MARGIN = m(0.06);
/** Broad-phase cell size, world units. */
const CELL = m(3.2);

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
 * measures them on the page).
 */
export interface PairMeasurer {
  measure(pairs: readonly { readonly a: SweepSamples; readonly b: SweepSamples }[]): Promise<readonly (Float64Array | null)[]>;
}
