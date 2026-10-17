import { describe, expect, it } from 'vitest';
import type { ClipFrames } from '@render/citizenBake';
import { citizenAtlas } from '@render/citizenPlays';
import { PACKED_BONE_FLOATS } from '@render/citizenPalette';

/** A CLIP BAKED LATER GOES INTO THE ATLAS THERE IS (plan 9.6): the same rows as an atlas laid with it, the same texture while there is room, no new pass */
const BONES = 4;
function clip(frames: number, seed: number): ClipFrames {
  const data = new Float32Array((frames + 2) * BONES * PACKED_BONE_FLOATS);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(seed * 31 + i * 0.7);
  return { data, frames, duration: frames / 30, stride: 1, pelvisY: 1, pelvisX: 0, pelvisZ: 0, loop: true } as ClipFrames;
}
const rowOf = (atlas: ReturnType<typeof citizenAtlas>, c: ClipFrames): number => atlas.rowOf.get(c)!;
const rows = (atlas: ReturnType<typeof citizenAtlas>, c: ClipFrames): Float32Array => {
  const width = BONES * 3 * 4;
  const data = atlas.anim.atlas.image.data as Float32Array;
  return data.subarray(rowOf(atlas, c) * width, (rowOf(atlas, c) + c.frames + 2) * width);
};

describe('a clip baked after the atlas was laid', () => {
  it('lands in the room left, the texture kept, only its rows sent up', () => {
    const a = clip(6, 1), b = clip(9, 2), later = clip(5, 3);
    const atlas = citizenAtlas([a, b], BONES, 20);
    const texture = atlas.anim.atlas;
    atlas.add(7, later);
    expect(atlas.anim.atlas).toBe(texture);
    expect(texture.updateRanges.length).toBe(later.frames + 2);
    expect([...rows(atlas, later)]).toEqual([...later.data]);
    // The clips laid first are where they were.
    expect([...rows(atlas, a)]).toEqual([...a.data]);
    expect([...rows(atlas, b)]).toEqual([...b.data]);
  });

  it('doubles the room when it is full, every clip where an atlas laid with it has it', () => {
    const a = clip(6, 4), later = clip(30, 5), last = clip(3, 6);
    const atlas = citizenAtlas([a], BONES);
    const first = atlas.anim.atlas;
    atlas.add(3, later);
    expect(atlas.anim.atlas).not.toBe(first);
    const grown = atlas.anim.atlas;
    expect(grown.image.height).toBeGreaterThanOrEqual(2 * (a.frames + 2));
    atlas.add(9, last);
    for (const c of [a, later, last]) expect([...rows(atlas, c)]).toEqual([...c.data]);
    // The same clip asked again is laid once.
    const at = rowOf(atlas, last);
    atlas.add(9, last);
    expect(rowOf(atlas, last)).toBe(at);
  });
});
