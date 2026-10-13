import { describe, expect, it } from 'vitest';
import { createExhaust } from '@render/exhaust';
import { m } from '@world/units';

/**
 * A CAR'S EXHAUST IS A FAINT PUFF OF ABOUT A METRE, LEAVING AT THE TAILPIPE'S
 * HEIGHT. The puff's size and height were written in steps of the old 0.4 m
 * unit and read as metres after the map moved to 1 m units: a 2.4 m puff
 * growing to 6 m at every car, two milliseconds of the GPU's frame in blended
 * smoke (measured 2026-10-13).
 */
describe('exhaust', () => {
  it('puffs at the size and height it was tuned at, in metres', () => {
    const exhaust = createExhaust();
    exhaust.tick(0, 400);
    // Pulling away at 10 m/s: about one puff every 1.4 s of 60 Hz frames.
    for (let frame = 0; frame < 120; frame++) exhaust.emit(0, 0, 0, 0, m(4.4), m(10), false);
    const geometry = exhaust.points.geometry;
    const born = geometry.getAttribute('aBorn').array;
    const size = geometry.getAttribute('aSize').array;
    const origin = geometry.getAttribute('position').array;
    const puffs = [...born.keys()].filter((i) => born[i]! > -1);
    expect(puffs.length).toBeGreaterThan(0);
    for (const i of puffs) {
      expect(size[i]).toBeCloseTo(m(0.96), 6);
      // Three's y is the world's height.
      expect(origin[i * 3 + 1]).toBeCloseTo(m(0.4), 6);
    }
    exhaust.dispose();
  });
});
