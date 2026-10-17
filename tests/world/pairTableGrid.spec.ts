import { describe, expect, it } from 'vitest';
import { BODY_CLASSES, BODY_ENVELOPE, HEAVY, TABLE_SIZE, type BodyClass, type SweepSamples, pairTable, sampleSweep, sweepSpan } from '@world/conflictTable';
import { m } from '@world/units';

/** A pair's table through the typed grid is the table the map-of-lists grid made, bit for bit (`pairTable`) */

const SWEEP_STEP = m(0.4), SWEEP_MARGIN = m(0.06), CELL = m(3.2);
const half = (cls: BodyClass): [number, number] => [BODY_ENVELOPE[cls]!.length / 2 + SWEEP_STEP / 2 + SWEEP_MARGIN, BODY_ENVELOPE[cls]!.width / 2 + SWEEP_MARGIN];

/** The table as `pairTable` made it before the typed grid: every pair of samples the old grid met, the same tests. */
function oldTable(a: SweepSamples, b: SweepSamples): Float64Array | null {
  const box = (s: SweepSamples): number[] => {
    const [hl, hw] = half(HEAVY);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < s.count; i++) {
      const x = s.frame[i * 4]!, y = s.frame[i * 4 + 1]!, tx = s.frame[i * 4 + 2]!, ty = s.frame[i * 4 + 3]!;
      const ex = Math.abs(tx) * hl + Math.abs(ty) * hw, ey = Math.abs(ty) * hl + Math.abs(tx) * hw;
      x0 = Math.min(x0, x - ex); x1 = Math.max(x1, x + ex); y0 = Math.min(y0, y - ey); y1 = Math.max(y1, y + ey);
    }
    return [x0, y0, x1, y1];
  };
  const [ax0, ay0, ax1, ay1] = box(a), [bx0, by0, bx1, by1] = box(b);
  if (ax1! < bx0! || bx1! < ax0! || ay1! < by0! || by1! < ay0!) return null;
  const [hl, hw] = half(HEAVY);
  const grid = new Map<number, number[]>();
  const key = (x: number, y: number): number => (x + 32768) * 65536 + (y + 32768);
  const cells = (s: SweepSamples, i: number, visit: (gx: number, gy: number) => void): void => {
    const x = s.frame[i * 4]!, y = s.frame[i * 4 + 1]!, tx = s.frame[i * 4 + 2]!, ty = s.frame[i * 4 + 3]!;
    const ex = Math.abs(tx) * hl + Math.abs(ty) * hw, ey = Math.abs(ty) * hl + Math.abs(tx) * hw;
    for (let gx = Math.floor((x - ex) / CELL); gx <= Math.floor((x + ex) / CELL); gx++) for (let gy = Math.floor((y - ey) / CELL); gy <= Math.floor((y + ey) / CELL); gy++) visit(gx, gy);
  };
  for (let j = 0; j < b.count; j++) cells(b, j, (gx, gy) => { const l = grid.get(key(gx, gy)); if (l) l.push(j); else grid.set(key(gx, gy), [j]); });
  const overlap = (i: number, ca: BodyClass, j: number, cb: BodyClass): boolean => {
    const [ahl, ahw] = half(ca), [bhl, bhw] = half(cb);
    const ax = a.frame[i * 4]!, ay = a.frame[i * 4 + 1]!, aux = a.frame[i * 4 + 2]!, auy = a.frame[i * 4 + 3]!;
    const bx = b.frame[j * 4]!, by = b.frame[j * 4 + 1]!, bux = b.frame[j * 4 + 2]!, buy = b.frame[j * 4 + 3]!;
    const dx = bx - ax, dy = by - ay, along = Math.abs(aux * bux + auy * buy), across = Math.abs(aux * buy - auy * bux);
    const aL = a.frameLengthSq[i]!, bL = b.frameLengthSq[j]!;
    return Math.abs(dx * aux + dy * auy) < ahl * aL + (bhl * along + bhw * across) && Math.abs(-dx * auy + dy * aux) < ahw * aL + (bhl * across + bhw * along)
      && Math.abs(dx * bux + dy * buy) < (ahl * along + ahw * across) + bhl * bL && Math.abs(-dx * buy + dy * bux) < (ahl * across + ahw * along) + bhw * bL;
  };
  const hits: number[] = [];
  for (let i = 0; i < a.count; i++) {
    const seen = new Set<number>();
    cells(a, i, (gx, gy) => { for (const j of grid.get(key(gx, gy)) ?? []) { if (seen.has(j)) continue; seen.add(j); if (overlap(i, HEAVY, j, HEAVY)) hits.push(i, j); } });
  }
  if (!hits.length) return null;
  const inRange = (s: SweepSamples, i: number, cls: BodyClass): boolean => { const c = s.c0 + i * SWEEP_STEP; return c >= s.c0 - 1e-9 && c <= s.length + BODY_ENVELOPE[cls]!.length / 2 + 1e-9; };
  const table = new Float64Array(TABLE_SIZE).fill(Number.NaN);
  const widen = (at: number, c: number): void => { const lo = table[at]!, hi = table[at + 1]!; table[at] = Number.isNaN(lo) ? c : Math.min(lo, c); table[at + 1] = Number.isNaN(hi) ? c : Math.max(hi, c); };
  for (let k = 0; k < hits.length; k += 2) {
    const i = hits[k]!, j = hits[k + 1]!;
    for (const ca of BODY_CLASSES) {
      if (!inRange(a, i, ca)) continue;
      for (const cb of BODY_CLASSES) {
        if (!inRange(b, j, cb)) continue;
        if ((ca !== HEAVY || cb !== HEAVY) && !overlap(i, ca, j, cb)) continue;
        widen((ca * 3 + cb) * 4, a.c0 + i * SWEEP_STEP);
        widen((ca * 3 + cb) * 4 + 2, b.c0 + j * SWEEP_STEP);
      }
    }
  }
  return table;
}

/** A movement through a junction: in along `from`, a curve, out along `to`, crossing near the middle (seeded). */
function sweep(seed: number, from: number, to: number): SweepSamples {
  let s = seed;
  const rnd = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const line = (x0: number, y0: number, angle: number, length: number): Float64Array => {
    const out: number[] = [];
    for (let k = 0; k <= 8; k++) out.push(x0 + Math.cos(angle) * length * k / 8, y0 + Math.sin(angle) * length * k / 8);
    return Float64Array.from(out);
  };
  const ox = (rnd() - 0.5) * m(6), oy = (rnd() - 0.5) * m(6);
  const inXY = line(ox - Math.cos(from) * m(40), oy - Math.sin(from) * m(40), from, m(32));
  const ex = inXY[inXY.length - 2]!, ey = inXY[inXY.length - 1]!;
  const cross: number[] = [];
  const tx = ox + Math.cos(to) * m(8), ty = oy + Math.sin(to) * m(8);
  for (let k = 0; k <= 12; k++) { const t = k / 12; cross.push((1 - t) * (1 - t) * ex + 2 * t * (1 - t) * ox + t * t * tx, (1 - t) * (1 - t) * ey + 2 * t * (1 - t) * oy + t * t * ty); }
  const crossXY = Float64Array.from(cross);
  const outXY = line(tx, ty, to, m(30));
  let length = 0;
  for (let k = 2; k < crossXY.length; k += 2) length += Math.hypot(crossXY[k]! - crossXY[k - 2]!, crossXY[k + 1]! - crossXY[k - 1]!);
  const { c0, count } = sweepSpan(length);
  const sampled = sampleSweep({ inXY, crossXY, outXY, c0, count });
  return { c0, count, length, frame: sampled.frame, frameLengthSq: sampled.frameLengthSq, bounds: null, grid: null, range: null };
}

describe('a pair table through the typed grid', () => {
  it('is the table the old grid made, bit for bit, over many movements', () => {
    const sweeps: SweepSamples[] = [];
    for (let k = 0; k < 24; k++) sweeps.push(sweep(k + 1, (k * 0.83) % (2 * Math.PI), ((k * 2.11) + 1) % (2 * Math.PI)));
    let met = 0;
    for (let p = 0; p < sweeps.length; p++) {
      for (let q = 0; q < sweeps.length; q++) {
        if (p === q) continue;
        const want = oldTable(sweeps[p]!, sweeps[q]!), got = pairTable(sweeps[p]!, sweeps[q]!);
        if (want) met++;
        expect(got === null ? null : [...new Uint8Array(got.buffer)]).toEqual(want === null ? null : [...new Uint8Array(want.buffer)]);
      }
    }
    expect(met).toBeGreaterThan(100);
  });
});
