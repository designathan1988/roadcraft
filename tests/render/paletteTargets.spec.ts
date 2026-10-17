import { describe, expect, it } from 'vitest';
import { freeSlab, growSlab, takeSlab } from '@render/people/paletteTargets';

/** The palettes' shared targets: passes of one width in one page, each its own rows, none over another */

describe("the palettes' shared targets", () => {
  it('put passes of one width in one target, one after the other, and a pass of another width apart', () => {
    const a = takeSlab(280, 16), b = takeSlab(280, 32), c = takeSlab(400, 16);
    expect(b.page).toBe(a.page);
    expect([a.base, b.base]).toEqual([0, 16]);
    expect(c.page).not.toBe(a.page);
    expect(a.page.target.height).toBeGreaterThanOrEqual(48);
    for (const s of [a, b, c]) freeSlab(s);
  });

  it('grow a pass in place where the rows after it are free, and move it where they are not', () => {
    const a = takeSlab(320, 16), b = takeSlab(320, 16);
    // `b` is last: it grows where it is.
    growSlab(b, 64);
    expect(b.base).toBe(16);
    expect(b.page.target.height).toBeGreaterThanOrEqual(80);
    // `a` has `b` after it: moved past it, its old rows free for the next.
    growSlab(a, 32);
    expect(a.base).toBeGreaterThanOrEqual(80);
    const slabs = [a, b].sort((x, y) => x.base - y.base);
    expect(slabs[0]!.base + slabs[0]!.rows).toBeLessThanOrEqual(slabs[1]!.base);
    const c = takeSlab(320, 16);
    expect(c.base).toBe(0);
    for (const s of [a, b, c]) freeSlab(s);
  });

  it('give a pass wider than a page of rows its own target', () => {
    const big = takeSlab(360, 3000), small = takeSlab(360, 16);
    expect(big.page.target.height).toBe(3000);
    expect(small.page).not.toBe(big.page);
    freeSlab(big);
    freeSlab(small);
  });
});
