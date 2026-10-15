import { describe, expect, it } from 'vitest';

import { Rng } from '@core/rng';
import { fitSize } from '@render/signs';

/**
 * THE SIZE A PLATE'S WORDS ARE WRITTEN AT (`signs.ts` fitSize): the size the
 * old walk found - down 2 px at a time from the top, measuring each size,
 * until the words fit or the size is at or under 10 - for words whose width
 * grows with their size, in proportion or not, with two or three measures
 * instead of one per size.
 */
function walked(max: number, size: number, widthAt: (px: number) => number): number {
  let px = size;
  while (widthAt(px) > max && px > 10) px -= 2;
  return px;
}

describe('the size a plate is written at', () => {
  it('is the size stepping down from the top finds, with a few measures', () => {
    const rng = new Rng(0xf17);
    let measures = 0, steps = 0;
    for (let i = 0; i < 20_000; i++) {
      const size = 9 + Math.floor(rng.float() * 140);
      const max = 4 + rng.float() * 300;
      const letters = 1 + Math.floor(rng.float() * 40);
      // Widths that grow with the size: in proportion, faster, slower, and rounded to whole pixels (hinting).
      const shape = Math.floor(rng.float() * 4);
      const per = 0.4 + rng.float() * 0.3;
      const widthAt = (px: number): number => {
        const w = letters * per * px;
        return shape === 0 ? w : shape === 1 ? letters * per * px ** 1.08 : shape === 2 ? letters * per * px ** 0.93 + 3 : Math.round(w);
      };
      let n = 0;
      const want = walked(max, size, widthAt);
      expect(fitSize(max, size, (px) => { n++; return widthAt(px); }), `size ${size}, max ${max}`).toBe(want);
      measures += n;
      steps += (size - want) / 2 + 1;
    }
    // A few measures a plate, not one per size.
    expect(measures / 20_000).toBeLessThan(3.5);
    expect(steps / 20_000).toBeGreaterThan(measures / 20_000);
  });
});
