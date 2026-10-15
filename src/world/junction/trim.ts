import { MIN_RIBBON } from '@core/scalar';
import { MIN_DRIVABLE_RESERVE, RESERVE_CAP } from '../approach';
import type { Corner } from './corners';
import type { Leg } from './legs';

/** THE trim solver. */
export function computeTrims(legs: readonly Leg[], corners: readonly Corner[]): number[] {
  const n = legs.length;
  const trims = new Array<number>(n).fill(0);
  if (n < 2) return trims;

  for (const c of corners) {
    if (c.trimI > (trims[c.i] as number)) trims[c.i] = c.trimI;
    if (c.trimJ > (trims[c.j] as number)) trims[c.j] = c.trimJ;
  }

  for (let i = 0; i < n; i++) {
    trims[i] = Math.max(0, trims[i] as number);
  }
  return trims;
}

export interface SegmentTrimBudget {
  /** Trim demanded at the `a` end. */
  a: number;
  /** Trim demanded at the `b` end. */
  b: number;
  /** Arc length of the segment. */
  readonly length: number;
}

export interface ClampResult {
  readonly a: number;
  readonly b: number;
  /** Factor the two demands were scaled by; 1 when nothing was clamped. */
  readonly scale: number;
}

/** Reconciles the two ends of a segment against its own length. */
export function clampSegmentTrims(budget: SegmentTrimBudget): ClampResult {
  // Two things compete for a segment's length: the junctions at each end, and the drivable link between them.
  const reserve = Math.min(MIN_DRIVABLE_RESERVE, budget.length * RESERVE_CAP);
  const available = budget.length - Math.max(MIN_RIBBON, reserve);
  const total = budget.a + budget.b;
  if (available <= 0) {
    // Pathologically short segment: split what little there is.
    const half = Math.max(0, (budget.length - MIN_RIBBON) / 2);
    return { a: half, b: half, scale: 0 };
  }
  if (total <= available) return { a: budget.a, b: budget.b, scale: 1 };

  const k = available / total;
  return { a: budget.a * k, b: budget.b * k, scale: k };
}
