import { describe, expect, it } from 'vitest';
import { TIER_SPAN, cellPriority } from '@render/buildings/cellPool';
import { m } from '@world/units';

/** THE QUEUE'S ORDER FOR THE BUILDINGS' JOBS (`cellPool.ts` `cellPriority`): the detail near the eye first while the town is seen; behind the opening's curtain the coarse levels first, since they are what it shows (`renderer.ts` reveal) */
describe("a building job's place in the queue", () => {
  /** The far levels' band (`farLevels.ts` FAR_TIER): past the masses, before the summaries. */
  const farLevel = (away: number): number => 2.9 * TIER_SPAN + away;
  const near = m(50), far = m(9_000);

  it('seen: the detail near the eye before any mass or far level', () => {
    expect(cellPriority('cell', far, false, false)).toBeLessThan(cellPriority('mass', near, false, false));
    expect(cellPriority('facade', far, false, false)).toBeLessThan(cellPriority('massTile', near, false, false));
    expect(cellPriority('cell', far, false, false)).toBeLessThan(farLevel(near));
  });

  it('behind the curtain: every mass and far level before any detail, however near', () => {
    for (const coarse of ['mass', 'massTile', 'massPlate'] as const) {
      expect(cellPriority(coarse, far, false, true)).toBeLessThan(cellPriority('cell', near, false, true));
      expect(cellPriority(coarse, far, false, true)).toBeLessThan(cellPriority('facade', near, false, true));
    }
    expect(farLevel(far)).toBeLessThan(cellPriority('cell', near, false, true));
    // Within a band the nearest first, still.
    expect(cellPriority('cell', near, false, true)).toBeLessThan(cellPriority('cell', far, false, true));
  });

  it('a building cut open goes first either way', () => {
    expect(cellPriority('cell', far, true, true)).toBeLessThan(cellPriority('mass', near, false, true));
    expect(cellPriority('cell', far, true, false)).toBeLessThan(cellPriority('cell', near, false, false));
  });
});
