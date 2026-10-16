import { describe, expect, it, vi } from 'vitest';
import { type CoverBox, openRunsAlong } from '@world/growth/lotBoundaryRuns';
import { growCity } from '../world/cityAudit';

/** THE OPEN STRETCHES OF A LOT'S EDGE ARE THE OLD ONES (2026-10-14) */

interface Call { readonly args: [number, 'x' | 'y', number, readonly CoverBox[]]; readonly out: [number, number][] }
const calls = vi.hoisted((): Call[] => []);

vi.mock('@world/growth/lotBoundaryRuns', async (importOriginal) => {
  const real = await importOriginal<typeof import('@world/growth/lotBoundaryRuns')>();
  return {
    ...real,
    openRunsAlong: (...args: Parameters<typeof real.openRunsAlong>): [number, number][] => {
      const out = real.openRunsAlong(...args);
      calls.push({ args: [args[0], args[1], args[2], args[3]], out });
      return out;
    },
  };
});

/** The old walk, frozen: every sample against every box (`lotPlan.ts` before 2026-10-14). */
function referenceOpenRuns(len: number, along: 'x' | 'y', fixed: number, boxes: readonly CoverBox[]): [number, number][] {
  const covered = (px: number, py: number): boolean => {
    for (const b of boxes) {
      if (b.kind === 'centre') {
        if (Math.abs(px - b.cx) <= b.hw && Math.abs(py - b.cy) <= b.hd) return true;
      } else if (px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1) return true;
    }
    return false;
  };
  const at = (t: number): [number, number] => (along === 'x' ? [t, fixed] : [fixed, t]);
  const runs: [number, number][] = [];
  let from = -1;
  for (let t = 0.3; t <= len - 0.3 + 1e-6; t += 0.25) {
    const open = !covered(...at(t));
    if (open && from < 0) from = t;
    if ((!open || t + 0.25 > len - 0.3) && from >= 0) { const to = open ? t : t - 0.25; if (to - from >= 0.4) runs.push([Math.max(0, from - 0.25), Math.min(len, to + 0.25)]); from = -1; }
  }
  return runs;
}

const same = (a: readonly (readonly number[])[], b: readonly (readonly number[])[]): boolean =>
  a.length === b.length && a.every((r, i) => Object.is(r[0], b[i]![0]) && Object.is(r[1], b[i]![1]));

describe('lot boundary runs: the range search gives what the sample walk gave', () => {
  it('boxes whose edges fall exactly on samples, and anywhere else', () => {
    let state = 12345;
    const rnd = (): number => { state = (state * 1103515245 + 12345) >>> 0; return state / 2 ** 32; };
    // Sample positions, as the walk sums them, to put box edges right on them.
    const ts: number[] = [];
    for (let t = 0.3; t <= 80; t += 0.25) ts.push(t);
    const pick = (): number => (rnd() < 0.5 ? ts[Math.floor(rnd() * ts.length)]! : rnd() * 80);
    let differing = 0;
    for (let k = 0; k < 4000; k++) {
      const len = 1 + rnd() * 70, along = rnd() < 0.5 ? 'x' as const : 'y' as const, fixed = rnd() < 0.3 ? 0.15 : rnd() * 40;
      const boxes: CoverBox[] = [];
      for (let n = Math.floor(rnd() * 12); n > 0; n--) {
        if (rnd() < 0.5) {
          const c = pick(), h = rnd() < 0.3 ? Math.abs(pick() - c) : rnd() * 6;
          const across = rnd() < 0.3 ? fixed : rnd() * 40;
          boxes.push(along === 'x' ? { kind: 'centre', cx: c, cy: across, hw: h, hd: rnd() * 3 } : { kind: 'centre', cx: across, cy: c, hw: rnd() * 3, hd: h });
        } else {
          const a = pick(), b = a + rnd() * 20, c0 = rnd() < 0.3 ? fixed : rnd() * 40, c1 = c0 + rnd() * 10;
          boxes.push(along === 'x' ? { kind: 'span', x0: a, x1: b, y0: c0, y1: c1 } : { kind: 'span', x0: c0, x1: c1, y0: a, y1: b });
        }
      }
      if (!same(openRunsAlong(len, along, fixed, boxes), referenceOpenRuns(len, along, fixed, boxes))) differing++;
    }
    expect(differing).toBe(0);
  });

  for (const [seed, style] of [[1, 'blocks'], [3, 'organic']] as const) {
    it(`every edge of every lot of a grown small ${style} town (seed ${seed})`, () => {
      calls.length = 0;
      growCity({ seed, size: 'small', style });
      expect(calls.length).toBeGreaterThan(1000);
      let differing = 0, open = 0;
      for (const { args, out } of calls) {
        if (!same(out, referenceOpenRuns(...args))) differing++;
        open += out.length;
      }
      expect(open).toBeGreaterThan(0);
      expect(differing).toBe(0);
    });
  }
});
