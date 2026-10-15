import { describe, expect, it } from 'vitest';

import { BLUEPRINTS } from '@world/buildings/blueprints';
import { type SiteBox, siteGrading } from '@world/buildings/siteGrading';
import type { BuildingStore } from '@world/buildings/store';
import type { Building, BuildingId } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/**
 * The sites and the town's platforms taken in a change at a time, by the ids
 * the diary gives (`BuildingStore.changedSince`, AUDITORIA C8): after any
 * edits they say what a grading that reads the whole store says - the same
 * box of changed sites, the same platforms, the same ground at every point.
 */
const slope = (x: number, y: number): number => x * 0.05 + y * 0.02;
const bank = (b: Building): SiteBox => [b.x - m(30), b.y - m(30), b.x + m(30), b.y + m(30)];

function body(i: number, x: number, y: number): Omit<Building, 'id'> {
  const bp = BLUEPRINTS[i % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), x, y, rotation: 0 } as Omit<Building, 'id'>;
}

/** The store as a reader that cannot tell which buildings changed sees it: it reads them all. */
const blind = (store: BuildingStore): BuildingStore => Object.create(store, { changedSince: { value: () => null } }) as BuildingStore;

describe('the sites graded, a change at a time', () => {
  it('say what a grading that reads the whole store says', () => {
    let seed = 9;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const doc = new RoadDoc();
    for (let i = 0; i < 25; i++) doc.buildings.add(body(i, (i % 5) * m(70), Math.floor(i / 5) * m(70)));
    const live = siteGrading(slope, undefined, m(9.6), bank);
    const whole = siteGrading(slope, undefined, m(9.6), bank);
    const store = doc.buildings, all = blind(store);
    live.changedSites(store); live.rebuild(store);
    whole.changedSites(all); whole.rebuild(all);
    for (let round = 0; round < 30; round++) {
      const ids = [...store.all()].map((b) => b.id);
      const pick = ids[Math.floor(rand() * ids.length)]! as BuildingId;
      const roll = rand();
      if (roll < 0.3) store.add(body(round, rand() * m(350), rand() * m(350)));
      else if (roll < 0.5) store.remove(pick);
      else if (roll < 0.8) { const b = store.get(pick)!; store.put({ ...b, x: b.x + (rand() - 0.5) * m(60) }); }
      else { const b = store.get(pick)!; store.put({ ...b, palette: (b.palette + 1) % 8 }); }
      const sorted = (list: readonly (readonly number[])[] | null): string[] => (list ?? []).map((q) => q.join(',')).sort();
      expect(sorted(live.changedSites(store))).toEqual(sorted(whole.changedSites(all)));
      live.rebuild(store);
      whole.rebuild(all);
      const a = live.pads!, b = whole.pads!;
      expect(a.count).toBe(b.count);
      const boxes = (p: typeof a): string[] => p.shapeBounds().map((q) => JSON.stringify(q)).sort();
      expect(boxes(a)).toEqual(boxes(b));
      for (let i = 0; i < 300; i++) {
        const x = rand() * m(400) - m(30), y = rand() * m(400) - m(30);
        expect(a.shapeAt(x, y, slope(x, y))).toEqual(b.shapeAt(x, y, slope(x, y)));
      }
    }
  });
});
