import { describe, expect, it } from 'vitest';
import { DEFAULT_CITY } from '@world/cityGen/plan';
import { WHOLE_MAP_DEFAULTS, type WholeMapOptions, planWholeMap } from '@world/cityGen/wholeMap';
import { buildTileMap } from '@editor/wholeMapTile';
import { replayOnLot } from '@world/growth/zoning';
import type { Lot } from '@world/lots';

/** A GROWN BUILDING IS A FEW NUMBERS (`zoning.ts` `GrownChoice`, the city-game's record and versioned generator): every building of a generated tile made again from its choices alone (`replayOnLot`) is the record the generator wrote, member for member. */

const { size: _size, radius: _radius, ...base } = DEFAULT_CITY;
const options: WholeMapOptions = { ...base, ...WHOLE_MAP_DEFAULTS, seed: 1 };

describe('a grown building made again from its choices', () => {
  it('is the record the generator wrote, for every building of the densest tile round the origin', () => {
    const map = planWholeMap(options);
    let best: [number, number] = [0, 0], heat = -1;
    for (let j = -2; j < 2; j++) for (let i = -2; i < 2; i++) { const h = map.tile(i, j).heat; if (h > heat) { heat = h; best = [i, j]; } }
    const { data, choices } = buildTileMap(options, best[0], best[1]);
    const lotOf = new Map<number, Lot>();
    for (const lot of data.lots ?? []) if (lot.building !== undefined) lotOf.set(lot.building, lot);
    const buildings = data.buildings ?? [];
    expect(buildings.length).toBeGreaterThan(300);
    let compared = 0;
    for (const b of buildings) {
      const choice = choices.get(b.id);
      const lot = lotOf.get(b.id);
      expect(choice, `building ${b.id} has its choices`).toBeDefined();
      expect(lot, `building ${b.id} stands on a lot`).toBeDefined();
      const again = replayOnLot(lot!, choice!, () => 0);
      const { id: _id, builtAt: _b, decay: _d, lotPlan: _l, ...written } = b as typeof b & { builtAt?: number; decay?: number; lotPlan?: number };
      expect(JSON.parse(JSON.stringify(again))).toEqual(JSON.parse(JSON.stringify(written)));
      compared++;
    }
    expect(compared).toBe(buildings.length);
  }, 10_000);
});
