import type { Vec2 } from '@core/vec2';
import type { ZoneDensity, ZoneUse } from './zones';

/*
 * A lot's record and the test of a point in it (`lots.ts` re-exports both).
 * Their own file: the lots' store (`lotStore.ts`, `openLots.ts`) reads them,
 * and importing them from `lots.ts`, which reaches the document and the
 * network, closed an import cycle (`tests/arch/imports.spec.ts`).
 */

export interface Lot {
  readonly id: number;
  /**
   * The boundary, counter-clockwise (the inside on the left of each side):
   * any polygon - four corners as generated, more where the player drew one,
   * many along a curved side. The first side (corners 0 -> 1) is the front,
   * on the street.
   */
  readonly corners: readonly Vec2[];
  readonly use?: ZoneUse;
  readonly density?: ZoneDensity;
  /** The building that grew on it, while it stands. */
  readonly building?: number;
}

export function insideLot(point: Vec2, l: Pick<Lot, 'corners'>): boolean {
  let inside = false;
  const q = l.corners;
  if (!q.length) return false;
  const p = point;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i]!, b = q[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
