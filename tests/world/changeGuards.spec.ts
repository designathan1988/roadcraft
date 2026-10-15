import { describe, expect, it } from 'vitest';

import { ChangeJournal, type ChangeKind } from '@world/changes';
import { ChangeSweep } from '@world/derived';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { type SiteBox, siteGrading } from '@world/buildings/siteGrading';
import type { Building } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/**
 * WHAT CHANGED, READ BY PLACE AND BY ITEM:
 * - the diary's new entries are read once a frame for every parked car
 *   (`ChangeSweep`): a car caught up with the last sweep asks its cell, never
 *   the diary - cars x entries a frame was 30 s of a 2,560 m city's growing;
 * - two sites changed far apart are two small boxes to grade the ground in
 *   (`changedSites`), never the box round both - a city's scattered new
 *   buildings were the whole city to cut and fill.
 */
const KINDS: readonly ChangeKind[] = ['ground', 'buildings'];

describe('the parked cars reading the diary', () => {
  it('ask their cell, not the diary, once caught up with the sweep', () => {
    const j = new ChangeJournal();
    const sweep = new ChangeSweep(j, KINDS);
    sweep.advance();
    const seen = sweep.serial;
    for (let k = 0; k < 2_000; k++) j.record('buildings', [[k * 10, 0, k * 10 + 5, 5]], { ids: [k] });
    sweep.advance();
    let asked = 0;
    const since = j.since.bind(j), touches = j.touches.bind(j);
    j.since = ((...a: Parameters<typeof since>) => { asked++; return since(...a); }) as typeof j.since;
    j.touches = ((...a: Parameters<typeof touches>) => { asked++; return touches(...a); }) as typeof j.touches;
    let hits = 0;
    for (let car = 0; car < 1_000; car++) if (sweep.touches(seen, car * 37 % 25_000, car % 2 ? 2 : 900)) hits++;
    expect(asked).toBe(0);
    expect(hits).toBeGreaterThan(0);
  });
});

function body(i: number, x: number, y: number): Omit<Building, 'id'> {
  const bp = BLUEPRINTS[i % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), x, y, rotation: 0 } as Omit<Building, 'id'>;
}

describe('the sites changed', () => {
  it('are each its own box, not the box round them all', () => {
    const doc = new RoadDoc();
    const bank = (b: Building): SiteBox => [b.x - m(30), b.y - m(30), b.x + m(30), b.y + m(30)];
    const sites = siteGrading(() => 0, undefined, m(9.6), bank);
    sites.changedSites(doc.buildings);
    doc.buildings.add(body(0, m(-4000), m(-4000)));
    doc.buildings.add(body(1, m(4000), m(4000)));
    const boxes = sites.changedSites(doc.buildings)!;
    expect(boxes).toHaveLength(2);
    const area = (q: SiteBox): number => (q[2] - q[0]) * (q[3] - q[1]);
    // Each a site's bank, not the 8 km between them.
    for (const q of boxes) expect(area(q)).toBeLessThanOrEqual(m(60) * m(60) + 1e-6);
  });
});

describe('a reader asking whether a change reached it', () => {
  it('is answered from the entries of its kinds, no list made of them', () => {
    const j = new ChangeJournal();
    for (let k = 0; k < 3_000; k++) j.record(k % 2 ? 'ground' : 'buildings', [[k * 10, 0, k * 10 + 5, 5]]);
    let listed = 0;
    const since = j.since.bind(j);
    j.since = ((...a: Parameters<typeof since>) => { listed++; return since(...a); }) as typeof j.since;
    expect(j.touches(0, [29_990, 0, 29_995, 5], KINDS)).toBe(true);
    expect(j.touches(0, [-100, -100, -50, -50], KINDS)).toBe(false);
    // The building entry at 29,980 m is serial 2,999: not after it.
    expect(j.touches(2_999, [29_980, 0, 29_985, 5], ['ground', 'buildings'])).toBe(false);
    expect(listed).toBe(0);
  });
});
