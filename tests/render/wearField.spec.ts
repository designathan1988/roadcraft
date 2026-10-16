import { describe, expect, it } from 'vitest';
import { RGFormat, UnsignedByteType, type DataTexture } from 'three';
import { createWearField, RANGE_STRIDE, WEAR_RES } from '@render/wear';
import { m } from '@world/units';

/** The streets' and footways' wear (`render/wear.ts`): one RG8 array that is the field and the texture, in a window round the view */

const bytesOf = (texture: DataTexture): Uint8Array => texture.image.data as Uint8Array;
const sum = (a: Uint8Array, channel: 0 | 1): number => { let s = 0; for (let i = channel; i < a.length; i += 2) s += a[i]!; return s; };

describe('wear field', () => {
  it('is one RG8 texture whose data is the field: no float copy beside it', () => {
    const field = createWearField();
    const texture = field.texture as DataTexture;
    expect(texture.format).toBe(RGFormat);
    expect(texture.type).toBe(UnsignedByteType);
    expect(bytesOf(texture).length).toBe(WEAR_RES * WEAR_RES * 2);
    field.wheels(m(10), m(10), 0, 0, 30);
    expect(sum(bytesOf(texture), 0)).toBeGreaterThan(0);
    expect(sum(bytesOf(texture), 1)).toBe(0);
    field.dispose();
  });

  it('keeps the mean of wear smaller than a byte step (stochastic rounding)', () => {
    const field = createWearField(12345);
    // 2,000 frames of a walker standing still: 2000 * (1/60) * 0.02 = 0.667 of full wear, 170 steps of 255.
    for (let i = 0; i < 2000; i++) field.feet(m(52), m(52), 1 / 60);
    const got = sum(bytesOf(field.texture as DataTexture), 1);
    expect(got).toBeGreaterThan(130);
    expect(got).toBeLessThan(210);
  });

  it('sends only the rows that changed, a texel as four of three r186 components', () => {
    const field = createWearField();
    const texture = field.texture as DataTexture;
    texture.clearUpdateRanges();
    field.feet(m(52), m(52), 100);
    field.tick(3);
    expect(texture.updateRanges.length).toBe(1);
    const range = texture.updateRanges[0]!;
    expect(range.count).toBe(RANGE_STRIDE);
    // The pixel three uploads is the one written.
    const pixel = range.start / RANGE_STRIDE;
    expect(bytesOf(texture)[pixel * 2 + 1]).toBe(255);
  });

  it('follows the view anywhere on the world, clearing what it leaves, and wears there', () => {
    const field = createWearField();
    const texture = field.texture as DataTexture;
    field.wheels(m(20), m(20), 0, 0, 30);
    expect(sum(bytesOf(texture), 0)).toBeGreaterThan(0);
    const far = m(1_000_000);
    field.follow(far, -far);
    expect(sum(bytesOf(texture), 0)).toBe(0);
    expect(field.window.value.x).toBeLessThan(far);
    expect(field.window.value.x + field.window.value.z).toBeGreaterThan(far);
    field.wheels(far + m(7), -far + m(3), 0, 0, 30);
    expect(sum(bytesOf(texture), 0)).toBeGreaterThan(0);
    // Off the window: nothing.
    const before = sum(bytesOf(texture), 0);
    field.wheels(0, 0, 0, 0, 30);
    expect(sum(bytesOf(texture), 0)).toBe(before);
  });
});
