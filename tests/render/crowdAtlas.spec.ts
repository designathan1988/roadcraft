import { describe, expect, it } from 'vitest';
import type { ClipFrames } from '@render/citizenBake';
import { buildClassAnimation } from '@render/people/crowdAnimation';

const clip = (frames: number, value: number): ClipFrames => ({
  data: new Float32Array(frames * 12).fill(value), frames, duration: 1, stride: 1, pelvisY: 0, pelvisX: 0, pelvisZ: 0, loop: true,
});

describe("a class's animation atlas", () => {
  it('keeps its texels only while three sends them, and makes the same ones again for a restore', () => {
    const anim = buildClassAnimation({ walk: clip(2, 1), idle: clip(3, 2) }, 1, true);
    const image = anim.atlas.image as { data: Float32Array | null; width: number; height: number };
    expect(anim.bytes).toBe(image.width * image.height * 16);
    // A send (three r186 `uploadTexture`): `image.data` read, more than once, then `onUpdate`.
    const sent = image.data!;
    expect(image.data).toBe(sent);
    const first = [...sent];
    expect(first.slice(0, 24)).toEqual(new Array(24).fill(1));
    expect(first.slice(24)).toEqual(new Array(36).fill(2));
    anim.atlas.onUpdate!(anim.atlas);
    const version = anim.atlas.version;
    anim.refill();
    expect(anim.atlas.version).toBeGreaterThan(version);
    // The next send's array is a new one, made from the clips again.
    const again = image.data!;
    expect(again).not.toBe(sent);
    expect([...again]).toEqual(first);
    expect(anim.rowOf('idle')).toBe(2);
  });

  it('keeps its texels when it is not GPU-only (the cooked citizens read them)', () => {
    const anim = buildClassAnimation({ walk: clip(1, 1) }, 1);
    expect(anim.atlas.onUpdate).toBeNull();
    anim.refill();
    expect((anim.atlas.image as { data: Float32Array }).data.length).toBe(12);
  });
});
