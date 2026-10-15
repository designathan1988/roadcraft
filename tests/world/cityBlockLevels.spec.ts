import { describe, expect, it } from 'vitest';
import { DEFAULT_CITY, planCity, type CityPlan } from '@world/cityGen/plan';
import { m } from '@world/units';

/** Every line of the 'blocks' grid is an avenue, a collector or a local street (`plan.ts` `blockGrid`) */
const BLOCK_LONG = m(120), BLOCK_SHORT = m(72);

/** The levels of the lines running north-south (constant x) and east-west (constant y). */
function levelsByDirection(plan: CityPlan): { northSouth: Set<number>; eastWest: Set<number> } {
  const { nodes, edges } = plan.graph;
  const northSouth = new Set<number>(), eastWest = new Set<number>();
  for (const e of edges) (Math.abs(nodes[e.a]!.x - nodes[e.b]!.x) < 1e-6 ? northSouth : eastWest).add(e.level);
  return { northSouth, eastWest };
}

/** A radius that gives `blocks` blocks of side `side` across the grid (`blockGrid`: floor(1.7 R / side)). */
const radiusFor = (blocks: number, side: number): number => (blocks + 0.5) * side / 1.7;

describe('the levels of a city of rectangular blocks', () => {
  for (const size of ['small', 'medium', 'large'] as const) {
    it(`${size}: both directions have avenues and collectors`, () => {
      const { northSouth, eastWest } = levelsByDirection(planCity({ ...DEFAULT_CITY, size, seed: 11 }));
      for (const levels of [northSouth, eastWest]) {
        expect(levels.has(0)).toBe(true);
        expect(levels.has(1)).toBe(true);
      }
    });
  }

  for (let blocks = 2; blocks <= 9; blocks++) {
    it(`${blocks} blocks across: a collector between the avenues`, () => {
      // Few long blocks east-west: the lines running north-south are `blocks` + 1.
      const wide = levelsByDirection(planCity({ ...DEFAULT_CITY, radius: radiusFor(blocks, BLOCK_LONG) }));
      expect(wide.northSouth.has(0)).toBe(true);
      expect(wide.northSouth.has(1)).toBe(true);
      // Few short blocks north-south: the lines running east-west are `blocks` + 1.
      const tall = levelsByDirection(planCity({ ...DEFAULT_CITY, radius: radiusFor(blocks, BLOCK_SHORT) }));
      expect(tall.eastWest.has(0)).toBe(true);
      expect(tall.eastWest.has(1)).toBe(true);
    });
  }
});
