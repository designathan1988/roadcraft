import { describe, expect, it } from 'vitest';
import { edgeFrame } from '@world/buildings/footprints';
import type { Volume } from '@world/buildings/types';

/** A BLOCK'S SIDE FRAMES KEPT ON IT (`footprints.ts` `edgeFrame`): the same frame asked again, a new one once the block moved in place */
const block = (): Volume => ({ id: 1, x: 2, y: 3, w: 10, d: 6, base: 0, storeys: [], roof: 'flat' } as unknown as Volume);

describe("a block's side frames", () => {
  it('are kept, read only, and worked out again when the block is moved or resized in place (the editor\'s operations)', () => {
    const v = block();
    const first = edgeFrame(v, 1);
    expect(edgeFrame(v, 1)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toEqual(edgeFrame(block(), 1));
    // Scaled in place, as `opScalePlan` does: the frame of the block as it is now.
    v.w *= 2; v.x += 1;
    const moved = edgeFrame(v, 1);
    expect(moved).not.toBe(first);
    expect(moved).toEqual(edgeFrame({ ...block(), w: 20, x: 3 } as Volume, 1));
    // An outline given: its frames.
    const shaped = { ...block(), outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] } as Volume;
    expect(edgeFrame(shaped, 2).length).toBeCloseTo(Math.hypot(5, 6), 9);
  });
});
