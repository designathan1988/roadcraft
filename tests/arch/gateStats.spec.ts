import { describe, expect, it } from 'vitest';
import { mannWhitney, summarize } from '../../scripts/gate/compare.mjs';

/**
 * The gate's decision (`scripts/gate/compare.mjs`). At first it called a
 * metric worse when the candidate's median of three rounds passed the base's
 * by the A/A noise: the push of E3 was blocked on 41 + 73 metrics of scenes
 * whose code had not changed (docs/PROBLEMS.md R17).
 */
describe('the gate statistics', () => {
  it('gives the exact two-sided Mann-Whitney p of fully separated samples', () => {
    // C(n1 + n2, n1) splits, two of them as extreme: R's wilcox.test exact p.
    expect(mannWhitney([1, 2, 3], [4, 5, 6]).p).toBeCloseTo(2 / 20, 10);
    expect(mannWhitney([1, 2, 3, 4], [5, 6, 7, 8, 9]).p).toBeCloseTo(2 / 126, 10);
    expect(mannWhitney([1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]).p).toBeCloseTo(2 / 924, 10);
    expect(mannWhitney([1, 2, 3], [4, 5, 6]).delta).toBe(1);
    expect(mannWhitney([4, 5, 6], [1, 2, 3]).delta).toBe(-1);
  });

  it('counts ties at their mean rank and finds nothing in equal samples', () => {
    expect(mannWhitney([1, 1, 1], [1, 1, 1]).p).toBeCloseTo(1, 10);
    expect(mannWhitney([1, 1, 1], [1, 1, 1]).delta).toBe(0);
    // One interleaving: rank sums close to the mean.
    expect(mannWhitney([1, 3, 5, 7, 9, 11], [2, 4, 6, 8, 10, 12]).p).toBeGreaterThan(0.5);
  });

  it('never calls three rounds a side worse: they cannot reach p <= 0.01', () => {
    const a = [{ x: { p99: 10 } }, { x: { p99: 11 } }, { x: { p99: 12 } }];
    const b = [{ x: { p99: 30 } }, { x: { p99: 31 } }, { x: { p99: 32 } }];
    expect(summarize(a, b).find((r) => r.key === 'x.p99')?.verdict).toBe('igual');
  });

  it('calls six rounds worse only when separated, large and past the margin', () => {
    const side = (xs: number[]) => xs.map((v) => ({ s: { p99: v } }));
    const a = side([10, 11, 12, 10.5, 11.5, 12.5]);
    expect(summarize(a, side([20, 21, 22, 20.5, 21.5, 22.5]))[0]?.verdict).toBe('PIOR');
    // Separated but within the 2 ms margin of a frame time.
    expect(summarize(a, side([12.6, 12.7, 12.8, 12.9, 13.0, 13.1]))[0]?.verdict).toBe('igual');
    // Mostly above, one overlap: suspicious, more rounds decide.
    expect(summarize(a, side([20, 21, 22, 20.5, 21.5, 11.2]))[0]?.verdict).toBe('suspeito');
    expect(summarize(side([20, 21, 22, 20.5, 21.5, 22.5]), a)[0]?.verdict).toBe('melhor');
  });
});
