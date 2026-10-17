import { describe, expect, it } from 'vitest';
import { createFogField, createFogTexture } from '@render/fogLayer';
import type { FogDab } from '@world/fogPaint';
import { m } from '@world/units';

/** The painted fog's map is kept by the rectangles that changed (`fogLayer.ts` `createFogField`) */

const dab = (x: number, y: number, radius: number): FogDab =>
  ({ x, y, radius, strength: 0.8, height: m(20), speed: m(2) }) as FogDab;

describe('fog field', () => {
  it('rasters nothing while there is no fog, and the whole window at the first dab, as a window laid with it', () => {
    let asked = 0;
    const ground = (x: number, y: number): number => { asked++; return Math.sin(x / m(300)) * m(10) + y / m(500); };
    const kept = createFogTexture();
    const field = createFogField(kept);
    expect(field.whole([], ground).any).toBe(false);
    expect(field.follow(m(3000), m(2000), [], ground)?.any ?? false).toBe(false);
    expect(asked).toBe(0);
    const dabs = [dab(m(3000), m(2000), m(150))];
    const laid = field.update(dabs, ground, [[m(2850), m(1850), m(3150), m(2150)]]);
    const fresh = createFogTexture();
    const other = createFogField(fresh);
    other.follow(m(3000), m(2000), [], ground);
    const whole = other.whole(dabs, ground);
    expect(laid.any).toBe(true);
    expect(laid.window).toEqual(whole.window);
    expect(Array.from(kept.image.data as Uint16Array)).toEqual(Array.from(fresh.image.data as Uint16Array));
  });

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

  it('follows the view anywhere on the world, writing only the texels that came in, as a whole window laid there', () => {
    const ground = (x: number, y: number): number => Math.sin(x / m(300)) * m(10) + y / m(500);
    const far = m(250_000);
    const dabs = [dab(far + m(2600), m(300), m(180)), dab(m(-800), m(400), m(150))];
    const kept = createFogTexture();
    const field = createFogField(kept);
    field.whole(dabs, ground);
    // A step under its hold: the window stays.
    expect(field.follow(m(500), 0, dabs, ground)).toBeNull();
    // Far out, then on a little: the second move writes the bands that came in only.
    field.follow(far, 0, dabs, ground);
    const moved = field.follow(far + m(2000), m(-1500), dabs, ground)!;
    expect(moved.window[0]).toBeLessThan(far + m(2000));
    expect(moved.window[0] + moved.window[2]).toBeGreaterThan(far + m(2000));

    // A fresh field: the same window laid whole (a jump past its side writes all of it).
    const fresh = createFogTexture();
    const other = createFogField(fresh);
    const laid = other.follow(far + m(2000), m(-1500), dabs, ground)!;
    expect(laid.window).toEqual(moved.window);
    expect(Array.from(kept.image.data as Uint16Array)).toEqual(Array.from(fresh.image.data as Uint16Array));
    expect(moved.any).toBe(true);
    // A row written in part reads the rest of its slab back from the half floats: to their step.
    expect(moved.low).toBeCloseTo(laid.low, 1);
    expect(moved.high).toBeCloseTo(laid.high, 1);
  });
});
