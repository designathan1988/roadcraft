import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { groundDigest } from '@render/buildings/layerCells';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/** THE GROUND UNDER A BUILDING, FINGERPRINTED FROM ITS STORED BOX (`layerCells.ts` `groundDigest`) */
describe('the ground fingerprint of a building', () => {
  it('reads the box kept for the record, never one worked out again', () => {
    const source = readFileSync('src/render/buildings/layerCells.ts', 'utf8');
    expect(source).not.toMatch(/\bbuildingBounds\(/);
    expect(source).toMatch(/storedBounds\(b, b\.module \* 2\)/);
  });

  it('still changes with the ground under the building, and only with it', () => {
    const doc = new RoadDoc();
    const b = doc.buildings.add({ ...JSON.parse(JSON.stringify(BLUEPRINTS[0]!.body)), x: m(100), y: m(50), rotation: 0.3 });
    const flat = (): number => 0;
    const bump = (x: number, y: number): number => (Math.hypot(x - m(100), y - m(50)) < m(3) ? m(1) : 0);
    const far = (x: number, y: number): number => (Math.hypot(x - m(900), y - m(900)) < m(3) ? m(1) : 0);
    expect(groundDigest(b, flat)).toBe(groundDigest(b, flat));
    expect(groundDigest(b, far)).toBe(groundDigest(b, flat));
    expect(groundDigest(b, bump)).not.toBe(groundDigest(b, flat));
  });
});
