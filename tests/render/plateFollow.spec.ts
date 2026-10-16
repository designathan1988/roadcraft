import { describe, expect, it } from 'vitest';

import { PlateFollow, type ShownPlate } from '@render/plateFollow';

/** A plate's own surface as a product reads it: one revision of its own. */
interface Surface { rev: number }
const plate = (cx: number, rev = 0): ShownPlate<Surface> => ({ surface: { rev }, cx, cy: 0 });

/** A follower that writes down which plates it took and let go, by centre. */
function recorder() {
  const follow = new PlateFollow<Surface, number>((s) => s.rev);
  const took: number[] = [], left: [number, number | undefined][] = [];
  const look = (parts: readonly ShownPlate<Surface>[]): number => {
    took.length = 0;
    left.length = 0;
    return follow.follow(parts, (part, was) => { took.push(part.cx); return (was ?? 0) + 1; }, (part, kept) => { left.push([part.cx, kept]); });
  };
  return { look, took, left };
}

describe('a product kept plate by plate', () => {
  it('takes each plate once, and again only when its own revision moves', () => {
    const { look, took, left } = recorder();
    const a = plate(0), b = plate(2048), c = plate(4096);
    const first = look([a, b, c]);
    expect(took).toEqual([0, 2048, 4096]);
    // Nothing changed: no plate taken again, the version where it was.
    expect(look([a, b, c])).toBe(first);
    expect(took).toEqual([]);
    // One plate's own revision moved: that plate alone.
    b.surface.rev++;
    expect(look([a, b, c])).toBeGreaterThan(first);
    expect(took).toEqual([2048]);
    expect(left).toEqual([]);
  });

  it('lets a plate that left go with what was kept of it, and a plate come in is taken alone', () => {
    const { look, took, left } = recorder();
    const a = plate(0), b = plate(2048), c = plate(4096);
    look([a, b]);
    // b taken twice: what it kept counts its takings.
    b.surface.rev++;
    look([a, b]);
    const before = look([a, b]);
    expect(look([a, c])).toBeGreaterThan(before);
    expect(left).toEqual([[2048, 2]]);
    expect(took).toEqual([4096]);
  });

  it('takes a plate made again (a new surface) anew, after letting the old one go', () => {
    const { look, took, left } = recorder();
    const old = plate(0, 5);
    look([old]);
    // The same plate, let go and made again: a new surface, even at the same revision.
    look([plate(0, 5)]);
    expect(left).toEqual([[0, 1]]);
    expect(took).toEqual([0]);
  });

  it('gives a version that moves with the plates shown, for a product keyed on them alone', () => {
    const follow = new PlateFollow((s: { readonly rev: number }) => s.rev);
    const a = plate(0), b = plate(2048);
    const v0 = follow.follow([a]);
    expect(follow.follow([a])).toBe(v0);
    const v1 = follow.follow([a, b]);
    expect(v1).toBeGreaterThan(v0);
    expect(follow.follow([a])).toBeGreaterThan(v1);
    expect(follow.follow([])).toBeGreaterThan(v1 + 1);
    expect(follow.follow([])).toBe(follow.version);
  });
});
