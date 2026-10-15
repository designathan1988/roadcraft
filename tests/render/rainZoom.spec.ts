import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import { advanceRain, createRain, createRainField, dropAt, type RainField } from '@render/rain';
import { m } from '@world/units';

/**
 * The rain must not jump when the zoom changes (`rain.ts`): the drops'
 * places come from `dropAt`, the function the vertex shader mirrors.
 */

function seedsOf(count: number): Vector3[] {
  const rain = createRain();
  const seeds = rain.object.geometry.getAttribute('position');
  const out: Vector3[] = [];
  for (let i = 0; i < count; i++) out.push(new Vector3(seeds.getX(i * 2), seeds.getY(i * 2), seeds.getZ(i * 2)));
  rain.dispose();
  return out;
}

const places = (field: RainField, seeds: Vector3[]): Vector3[] => seeds.map((s) => dropAt(field, s, 0, 0, new Vector3()));

/** The share-th smallest move of a drop between two sets of places. */
function moved(before: Vector3[], after: Vector3[], share: number): number {
  const d = before.map((p, i) => p.distanceTo(after[i]!)).sort((a, b) => a - b);
  return d[Math.floor(d.length * share)]!;
}

describe('rain', () => {
  const seeds = seedsOf(2000);
  // Far from the world's origin, after a minute and a half of rain.
  const ground = new Vector3(m(4000), 0, m(-3000));
  const wind = new Vector2(m(2), m(1));

  it('does not jump when the zoom changes a little', () => {
    const field = createRainField();
    let span = m(300);
    for (let f = 0; f < 6000; f++) advanceRain(field, ground, span, wind, 1 / 60);
    const before = places(field, seeds);
    span *= 1.01;
    advanceRain(field, ground, span, wind, 1 / 60);
    // A frame's fall (1.6 box heights a second) plus half the box's change.
    const limit = m(300) * 1.1 * 0.55 * 1.6 / 60 + m(300) * 1.1 * 0.02;
    expect(moved(before, places(field, seeds), 0.9)).toBeLessThan(limit);
  });

  it('moves the drops as much in a frame of zooming as in a frame of falling, a wheel turn at a time', () => {
    const field = createRainField();
    let span = m(150);
    for (let f = 0; f < 600; f++) advanceRain(field, ground, span, wind, 1 / 60);
    // Zooming out by a tenth a frame for a second: each frame's move stays a
    // frame's fall plus the box's own change (its sides half of it, its top
    // 0.92 of it: the box hangs from 0.08 of its height under the ground to
    // 0.92 over it), never a reshuffle.
    for (let f = 0; f < 60; f++) {
      const before = places(field, seeds);
      const box = field.box.clone();
      span *= 1.1;
      advanceRain(field, ground, span, wind, 1 / 60);
      const grown = field.box.clone().sub(box);
      const limit = Math.hypot(field.velocity.x, field.velocity.y, field.velocity.z) / 60
        + Math.hypot(grown.x * 0.5, grown.y * 0.92, grown.z * 0.5);
      expect(moved(before, places(field, seeds), 0.9), `frame ${f}`).toBeLessThanOrEqual(limit * 1.01);
    }
  });

  it('keeps the drops where they are in the world when the view pans', () => {
    const field = createRainField();
    for (let f = 0; f < 600; f++) advanceRain(field, ground, m(300), wind, 1 / 60);
    const before = places(field, seeds);
    // Panned by a few metres, no time passing: a drop still in view stays put.
    advanceRain(field, ground.clone().add(new Vector3(m(3), 0, m(2))), m(300), wind, 0);
    expect(moved(before, places(field, seeds), 0.9)).toBeLessThan(1e-6 * m(300));
  });

  it('hands the shader the field it places the drops by', () => {
    const rain = createRain();
    rain.update(1, ground, m(300), wind, 1 / 60);
    const u = (rain.object.material as unknown as { uniforms: Record<string, { value: unknown }> }).uniforms;
    const field = createRainField();
    advanceRain(field, ground, m(300), wind, 1 / 60);
    expect((u['uBox']!.value as Vector3).toArray()).toEqual(field.box.toArray());
    expect((u['uCentre']!.value as Vector3).toArray()).toEqual(field.centre.toArray());
    expect((u['uLattice']!.value as Vector3).toArray()).toEqual(field.lattice.toArray());
    expect((u['uVelocity']!.value as Vector3).toArray()).toEqual(field.velocity.toArray());
    rain.dispose();
  });
});
