import { describe, expect, it } from 'vitest';

import { spaceSeed } from '@render/buildings/lightSlots';

/** A SPACE'S SEED IS FNV-1a OF ITS KEY'S TEXT, HASHED WITHOUT WRITING THE TEXT (`lightSlots.ts`) */

/** The seed as it was worked out: the key written, then hashed. */
function fromText(building: number, level: number, volume: number, x: number, y: number): number {
  const key = `${building}:${level}:${volume}:${Math.round(x * 10)}:${Math.round(y * 10)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return (h >>> 0) % 65_536;
}

describe('a space\'s seed', () => {
  it('is the one its key\'s text gave, for every kind of number in it', () => {
    let s = 12345;
    const next = (): number => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
    const ids = [0, 1, 9, 10, 99, 100, 7_340_032, 2 ** 40 + 17, 999_999_999_999];
    for (let k = 0; k < 4000; k++) {
      const building = k < ids.length ? ids[k]! : Math.floor(next() * 1e12);
      const level = Math.floor(next() * 60), volume = Math.floor(next() * 12);
      const x = (next() - 0.5) * 80, y = (next() - 0.5) * 80;
      expect(spaceSeed(building, level, volume, x, y)).toBe(fromText(building, level, volume, x, y));
    }
    // A corner rounded to -0 is written "0".
    expect(spaceSeed(5, 1, 2, -0.04, 0.03)).toBe(fromText(5, 1, 2, -0.04, 0.03));
  });
});
