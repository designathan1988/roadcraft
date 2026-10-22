import { describe, expect, it } from 'vitest';

import { buildSmallCityMap } from '@editor/smallCityMap';

/** FNV-1a over a string: the map's text as one number. */
function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * THE CITY A SEED MAKES, BIT FOR BIT: its roads, lots, zones and every grown building, as one hash. Any change of the generator's
 * output shows here in seconds; a change made on purpose updates the number in the same commit, and says why. The proof a split
 * generation must pass too (the same seed, the same hash as the serial one).
 */
describe('city golden', () => {
  it('the small city of seed 7 is made exactly as before', () => {
    const doc = buildSmallCityMap(7);
    const text = JSON.stringify(doc);
    expect({ hash: hashText(text), length: text.length }).toMatchInlineSnapshot(`
      {
        "hash": 2248681661,
        "length": 10470148,
      }
    `);
  });

  // The large city (8,102 buildings, ~20 s): `tests/scale/world/cityGoldenLarge.spec.ts`, with the counting suites.
});
