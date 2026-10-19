import { describe, expect, it } from 'vitest';
import type { ClipFrames } from '@render/citizenBake';
import { appendClip, citizenAtlas } from '@render/citizenPlays';
import { PACKED_BONE_FLOATS } from '@render/citizenPalette';

/** A cooked body's atlas is laid once: a clip baked on first use goes into its room, the clips laid before never move */

const BONES = 3;
const WIDTH = BONES * 3 * 4;
/** A clip of `frames` intervals, every float its own row's number plus `mark`. */
function clip(frames: number, mark: number): ClipFrames {
  const rows = frames + 2;
  const data = new Float32Array(rows * BONES * PACKED_BONE_FLOATS);
  for (let r = 0; r < rows; r++) data.fill(mark + r, r * BONES * PACKED_BONE_FLOATS, (r + 1) * BONES * PACKED_BONE_FLOATS);
  return { data, frames, duration: 1, stride: 1, pelvisY: 1, pelvisX: 0, pelvisZ: 0, loop: true } as ClipFrames;
}
const texels = (atlas: ReturnType<typeof citizenAtlas>): Float32Array => atlas.anim.atlas.image.data as Float32Array;

describe("a cooked body's atlas", () => {
  it('lays each clip once, in order, with room past them', () => {
    const a = clip(4, 100), b = clip(2, 200);
    const atlas = citizenAtlas([a, b, a, undefined], BONES);
    expect(atlas.rowOf.get(a)).toBe(0);
    expect(atlas.rowOf.get(b)).toBe(6);
    expect(atlas.rows).toBe(10);
    expect(atlas.anim.atlas.image.height).toBeGreaterThan(10);
    expect(texels(atlas)[6 * WIDTH]).toBe(200);
  });

  it('takes a clip baked since into its room: only its rows sent, the texture kept, every other clip where it was', () => {
    const a = clip(4, 100);
    const atlas = citizenAtlas([a, clip(14, 300)], BONES);
    const texture = atlas.anim.atlas;
    // Sent up whole once, as three tells it (`onUpdate`): ranges from now on.
    texture.onUpdate?.(texture);
    texture.clearUpdateRanges();
    const late = clip(1, 500);
    expect(appendClip(atlas, late)).toBe(false);
    expect(atlas.anim.atlas).toBe(texture);
    expect(atlas.rowOf.get(a)).toBe(0);
    expect(atlas.rowOf.get(late)).toBe(22);
    expect(texels(atlas)[22 * WIDTH]).toBe(500);
    expect(texels(atlas)[24 * WIDTH]).toBe(502);
    expect(texture.updateRanges.map((r) => r.start)).toEqual([22, 23, 24].map((r) => r * WIDTH));
  });

  it('doubles past its room, the rows laid before copied as they were', () => {
    const a = clip(2, 100);
    const atlas = citizenAtlas([a], BONES);
    const height = atlas.anim.atlas.image.height;
    const big = clip(height * 2, 700);
    expect(appendClip(atlas, big)).toBe(true);
    expect(atlas.anim.atlas.image.height).toBeGreaterThanOrEqual(4 + height * 2 + 2);
    expect(texels(atlas)[0]).toBe(100);
    expect(texels(atlas)[3 * WIDTH]).toBe(103);
    expect(texels(atlas)[4 * WIDTH]).toBe(700);
  });

  it('puts no range on a texture not yet sent: a clip after one that grew it leaves the new texture to go up whole (AGT-16)', () => {
    const atlas = citizenAtlas([clip(2, 100)], BONES);
    const height = atlas.anim.atlas.image.height;
    // Just past its room (a clip is its frames and two rows): it doubles, room left after it.
    expect(appendClip(atlas, clip(height - atlas.rows, 700))).toBe(true);
    const grown = atlas.anim.atlas;
    // Not drawn since (no upload): the next clip adds no range, or only its rows would go up, the rest zero on the GPU.
    expect(appendClip(atlas, clip(1, 900))).toBe(false);
    expect(atlas.anim.atlas).toBe(grown);
    expect(grown.updateRanges.length).toBe(0);
  });
});
