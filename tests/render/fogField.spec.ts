import { describe, expect, it } from 'vitest';
import { createFogField, createFogTexture } from '@render/fogLayer';
import type { FogDab } from '@world/fogPaint';
import { m } from '@world/units';

/** The painted fog's map is kept by the rectangles that changed (`fogLayer.ts` `createFogField`) */

const dab = (x: number, y: number, radius: number): FogDab =>
  ({ x, y, radius, strength: 0.8, height: m(20), speed: m(2) }) as FogDab;

describe('fog field', () => {
  it('lays a dab in its rectangle as the whole map would, and its slab with it', () => {
    const ground = (x: number, y: number): number => Math.sin(x / m(300)) * m(10) + y / m(500);
    const first = [dab(m(-800), m(400), m(150))];
    const second = [...first, dab(m(1200), m(-600), m(200))];

    const kept = createFogTexture();
    const field = createFogField(kept);
    field.whole(first, ground);
    const r = second[1]!;
    const step = field.update(second, ground, [[r.x - r.radius, r.y - r.radius, r.x + r.radius, r.y + r.radius]]);

    const fresh = createFogTexture();
    const whole = createFogField(fresh).whole(second, ground);

    expect(Array.from(kept.image.data as Uint16Array)).toEqual(Array.from(fresh.image.data as Uint16Array));
    expect(step.any).toBe(true);
    expect(step.low).toBeCloseTo(whole.low, 6);
    expect(step.high).toBeCloseTo(whole.high, 6);
  });
});
