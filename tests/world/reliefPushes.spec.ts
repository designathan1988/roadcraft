import { describe, expect, it } from 'vitest';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { bayLayout, reliefAt } from '@world/buildings/geometry';
import type { Building, Relief } from '@world/buildings/types';

/** A BAY'S RELIEF WRITTEN ONCE A SIDE (`geometry.ts` `reliefPushes`): each bay pushed as `reliefAt` finds it, the last relief listed winning */

describe("a building's bays", () => {
  it("stand out by the relief `reliefAt` finds for them, overlapping and past the side's ends included", () => {
    const b = JSON.parse(JSON.stringify(BLUEPRINTS.find((bp) => bp.body.volumes[0]!.storeys.length >= 3)!.body)) as Building;
    const v = b.volumes[0]!;
    // Overlapping reliefs, one reaching past the last bay and storey, one a single bay.
    const reliefs: Relief[] = [
      { side: 0, bay0: 0, bay1: 2, storey0: 0, storey1: 1, depth: 0.4 },
      { side: 0, bay0: 1, bay1: 99, storey0: 1, storey1: 99, depth: -0.3 },
      { side: 2, bay0: 1, bay1: 1, storey0: 2, storey1: 2, depth: 0.6 },
    ];
    const built = { ...b, volumes: [{ ...v, reliefs }, ...b.volumes.slice(1)] };
    const bays = bayLayout(built).filter((bay) => bay.volume === v.id);
    expect(bays.length).toBeGreaterThan(0);
    let pushed = 0;
    for (const bay of bays) {
      const want = reliefAt(built.volumes[0]!, bay.side, bay.index, bay.storey)?.depth ?? 0;
      expect(bay.push, `${bay.side}/${bay.index}/${bay.storey}`).toBe(want);
      if (want !== 0) pushed++;
    }
    expect(pushed).toBeGreaterThan(3);
  });
});
