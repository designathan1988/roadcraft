/** DO NOT go back to testing every sample against every part: that was O(samples x parts) per side */

/** A part's box, as the old test read it: `centre`, a boundary part covering where `|px - cx| <= hw && |py - cy| <= hd` */
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

/** The open stretches along an edge from 0 to `len`: the samples run along `along` */
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
