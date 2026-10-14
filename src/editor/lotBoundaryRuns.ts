/**
 * THE OPEN STRETCHES OF A LOT'S EDGE (`lotPlan.ts`, the boundary made whole):
 * the edge is sampled every 25 cm, a sample is covered when it lies in the
 * box of a boundary part (a wall, a fence, a hedge, a railing, a gate) or of
 * the building's own ground floor, and each run of uncovered samples long
 * enough is handed back to be closed.
 *
 * Each box covers ONE contiguous range of samples: its test along the edge is
 * monotone in the sample's position (`t - cx` and `t >= lo` only grow with
 * `t`, rounding included), so the first and the last sample it covers are
 * found by binary search (the leftmost index where a monotone predicate turns
 * true, Wikipedia "Binary search algorithm") and the range is marked in a
 * difference array. A side costs O(boxes log samples + samples).
 *
 * DO NOT go back to testing every sample against every part: that was
 * O(samples x parts) per side - both grow with the lot - and 1.8 s of a
 * 2 560 m town (2026-10-14). The tests below are the old ones, expression for
 * expression, so the same samples come out covered
 * (`tests/editor/lotBoundaryRunsEquivalence.spec.ts`).
 */

/**
 * A part's box, as the old test read it: `centre`, a boundary part covering
 * where `|px - cx| <= hw && |py - cy| <= hd`; `span`, a ground-floor volume
 * covering where `x0 <= px <= x1 && y0 <= py <= y1`.
 */
export type CoverBox =
  | { readonly kind: 'centre'; readonly cx: number; readonly cy: number; readonly hw: number; readonly hd: number }
  | { readonly kind: 'span'; readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number };

/** First sample from 0.3 and step between samples, m. */
const FIRST = 0.3, STEP = 0.25;

/** The first index of `ts` (ascending) at which `holds` is true, `ts.length` when never: `holds` false then true. */
function firstWhere(ts: readonly number[], holds: (t: number) => boolean): number {
  let lo = 0, hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (holds(ts[mid]!)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/**
 * The open stretches along an edge from 0 to `len`: the samples run along
 * `along` (x: the point is `[t, fixed]`; y: `[fixed, t]`). Each stretch is
 * `[from - 0.25, to + 0.25]` clamped to the edge, kept when at least 0.4 m of
 * samples are open.
 */
export function openRunsAlong(len: number, along: 'x' | 'y', fixed: number, boxes: readonly CoverBox[]): [number, number][] {
  // The samples exactly as the walk along the edge makes them (summed, not multiplied).
  const ts: number[] = [];
  for (let t = FIRST; t <= len - FIRST + 1e-6; t += STEP) ts.push(t);
  const n = ts.length;
  const cover = new Int32Array(n + 1);
  for (const b of boxes) {
    let first: number, end: number;
    if (b.kind === 'centre') {
      // |t - c| <= h is t - c >= -h and t - c <= h; the across test once.
      const [c, h, cAcross, hAcross] = along === 'x' ? [b.cx, b.hw, b.cy, b.hd] : [b.cy, b.hd, b.cx, b.hw];
      if (!(Math.abs(fixed - cAcross) <= hAcross)) continue;
      first = firstWhere(ts, (t) => t - c >= -h);
      end = firstWhere(ts, (t) => t - c > h);
    } else {
      const [lo, hi, loAcross, hiAcross] = along === 'x' ? [b.x0, b.x1, b.y0, b.y1] : [b.y0, b.y1, b.x0, b.x1];
      if (!(fixed >= loAcross && fixed <= hiAcross)) continue;
      first = firstWhere(ts, (t) => t >= lo);
      end = firstWhere(ts, (t) => t > hi);
    }
    if (first < end) { cover[first]!++; cover[end]!--; }
  }
  const runs: [number, number][] = [];
  let from = -1, depth = 0;
  for (let k = 0; k < n; k++) {
    const t = ts[k]!;
    depth += cover[k]!;
    const open = depth === 0;
    if (open && from < 0) from = t;
    if ((!open || t + STEP > len - FIRST) && from >= 0) {
      const to = open ? t : t - STEP;
      if (to - from >= 0.4) runs.push([Math.max(0, from - STEP), Math.min(len, to + STEP)]);
      from = -1;
    }
  }
  return runs;
}
