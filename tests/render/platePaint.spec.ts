import { describe, expect, it } from 'vitest';
import { plateDabs } from '@render/flatAtlas';
import type { PaintDab } from '@world/terrainPaint';

/** THE DABS A PLATE LAYS (`flatAtlas.ts` plateDabs): a tile that left the page keeps its paint on the ground, one come back is laid once, a stroke takes off only what it undid */

const dab = (x: number): PaintDab => ({ kind: 'soil', x, y: 0, radius: 5, strength: 1 });

describe('the dabs a plate lays', () => {
  it('keeps what a tile that left laid, lays a tile come back once, and takes off only what a stroke undid', () => {
    const keys = new Set<string>();
    const a = dab(10), b = dab(20), c = dab(30);
    // The first look: the document's dabs.
    let laid = plateDabs([], keys, [a, b], null)!;
    expect(laid).toEqual([a, b]);
    // A tile loaded (c): after what was laid.
    laid = plateDabs(laid, keys, [a, b, c], [])!;
    expect(laid).toEqual([a, b, c]);
    // The tile of b let go: nothing to change, b stays laid.
    expect(plateDabs(laid, keys, [a, c], [])).toBeNull();
    // Back, as a new object of the same dab: not laid again.
    const b2 = dab(20);
    expect(plateDabs(laid, keys, [a, b2, c], [])).toBeNull();
    // A stroke lays d: after the rest; one that undid a (its rectangle round it): a off, the rest kept in order.
    const d = dab(40);
    laid = plateDabs(laid, keys, [a, b2, c, d], [[38, -2, 42, 2]])!;
    expect(laid).toEqual([a, b, c, d]);
    laid = plateDabs(laid, keys, [b2, c, d], [[7, -3, 13, 3]])!;
    expect(laid).toEqual([b, c, d]);
    // Once a is off, the same dab painted again is laid again.
    const a2 = dab(10);
    laid = plateDabs(laid, keys, [b2, c, d, a2], [[7, -3, 13, 3]])!;
    expect(laid).toEqual([b, c, d, a2]);
    // The diary cannot say: the document's dabs alone, laid again.
    laid = plateDabs(laid, keys, [b2, c, d, a2], null)!;
    expect(laid).toEqual([b2, c, d, a2]);
    expect(plateDabs(laid, keys, [b2, c, d, a2], null)).toBeNull();
  });
});
