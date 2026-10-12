import { describe, expect, it } from 'vitest';

import { PLANET_RADIUS } from '@core/cubeSphere';
import { TILES, TILE_COUNT, tileToSphereInto } from '@core/planetTiles';
import { HOME_TILE, OCEAN_FLOOR, SEA_LEVEL, earthHeight, tileGround } from '@world/planet/relief';
import { RELIEF_EARTH } from '@world/terrain';
import { iceTopAt } from '@world/planet/ice';
import { U } from './_border';

/**
 * THE PLANET'S EARTH (`world/planet/relief.ts` `earthHeight`): oceans and
 * continents, as the Earth's - most of the globe sea, the land in a few
 * continents, the home continent under the camera's first place with room
 * to build, the plains gentle enough for a road, the ground the same on
 * both sides of every border, and fast enough to lay 864 pieces at once.
 * Run with `vitest.planet.config.ts`.
 */

/** Points spread evenly over the sphere (the Fibonacci lattice). */
function lattice(count: number): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const z = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - z * z);
    out.push({ x: Math.cos(golden * i) * r, y: Math.sin(golden * i) * r, z });
  }
  return out;
}

/** The ground's grade at a unit direction: the steepest rise over 3.2 m, both ways round. */
function grade(s: { x: number; y: number; z: number }): number {
  // Two tangents at s.
  const a = Math.abs(s.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  let tx = a.y * s.z - a.z * s.y, ty = a.z * s.x - a.x * s.z, tz = a.x * s.y - a.y * s.x;
  const l = Math.hypot(tx, ty, tz);
  tx /= l; ty /= l; tz /= l;
  const ux = s.y * tz - s.z * ty, uy = s.z * tx - s.x * tz, uz = s.x * ty - s.y * tx;
  const d = (4 * U) / PLANET_RADIUS;
  const at = (p: number, q: number): number => {
    const x = s.x + tx * p + ux * q, y = s.y + ty * p + uy * q, z = s.z + tz * p + uz * q;
    const k = Math.hypot(x, y, z);
    return earthHeight(x / k, y / k, z / k);
  };
  const gx = (at(d, 0) - at(-d, 0)) / (8 * U);
  const gy = (at(0, d) - at(0, -d)) / (8 * U);
  return Math.hypot(gx, gy);
}

const quantile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
};

describe('the planet as an Earth', () => {
  const points = lattice(20_000);
  const heights = points.map((p) => earthHeight(p.x, p.y, p.z));

  it('is mostly sea, with land enough to play on', () => {
    const land = heights.filter((h) => h > SEA_LEVEL).length / heights.length;
    console.log(`land share ${(land * 100).toFixed(1)}%`);
    expect(land).toBeGreaterThan(0.3);
    expect(land).toBeLessThan(0.45);
  });

  it('keeps its heights within a few percent of the radius, a round globe from orbit', () => {
    const lo = Math.min(...heights), hi = Math.max(...heights);
    console.log(`heights ${lo.toFixed(1)} .. ${hi.toFixed(1)}; land p50 ${quantile(heights.filter((h) => h > 0), 0.5).toFixed(1)} p95 ${quantile(heights.filter((h) => h > 0), 0.95).toFixed(1)}`);
    expect(lo).toBeGreaterThanOrEqual(OCEAN_FLOOR - 20 * U);
    expect(hi).toBeLessThan(PLANET_RADIUS * 0.06);
    // Deep ocean exists, not only a shelf.
    expect(heights.filter((h) => h < -100 * U).length / heights.length).toBeGreaterThan(0.2);
  });

  it('has mountains, but plains a road can climb on most of the land', () => {
    const landPoints = points.filter((_, i) => (heights[i] as number) > 2 * U);
    const grades = landPoints.slice(0, 3000).map(grade);
    const p50 = quantile(grades, 0.5), p80 = quantile(grades, 0.8), p99 = quantile(grades, 0.99);
    console.log(`land grades p50 ${(p50 * 100).toFixed(1)}% p80 ${(p80 * 100).toFixed(1)}% p99 ${(p99 * 100).toFixed(1)}%`);
    expect(p50).toBeLessThan(0.06);
    expect(quantile(grades, 0.65)).toBeLessThan(0.1);
    expect(heights.filter((h) => h > 100 * U).length).toBeGreaterThan(20);
  });

  it('opens on land, with a wide plain round the camera\'s first place', () => {
    const home = TILES[HOME_TILE]!;
    const s = { x: 0, y: 0, z: 0 };
    let land = 0, total = 0;
    const grades: number[] = [];
    for (let x = -600; x <= 600; x += 50) {
      for (let y = -600; y <= 600; y += 50) {
        tileToSphereInto(HOME_TILE, x * U, y * U, s);
        total++;
        if (earthHeight(s.x, s.y, s.z) > U) land++;
        grades.push(grade({ ...s }));
      }
    }
    console.log(`home land ${land}/${total}, grade p90 ${(quantile(grades, 0.9) * 100).toFixed(1)}% at ${JSON.stringify(home.centre)}`);
    expect(land).toBe(total);
    expect(quantile(grades, 0.9)).toBeLessThan(0.08);
  });

  it('reads the same ground on both sides of every border between pieces', () => {
    // A point of the sphere, read through each of two pieces' maps.
    const s = { x: 0, y: 0, z: 0 };
    for (let t = 0; t < TILE_COUNT; t += 37) {
      const g = tileGround(t, RELIEF_EARTH);
      const near = (t + 1) % TILE_COUNT;
      tileToSphereInto(t, 240 * U, -120 * U, s);
      const there = TILES[near]!;
      const along = s.x * there.centre.x + s.y * there.centre.y + s.z * there.centre.z;
      if (along < 0.9) continue;
      // The ground drawn is the land and its ice (`ice.ts`), the bed under it the Earth's.
      expect(g(240 * U, -120 * U)).toBeCloseTo(iceTopAt(earthHeight(s.x, s.y, s.z), s.x, s.y, s.z), 6);
    }
  });

  it('is fast enough to lay every piece of the planet at once', () => {
    const g = tileGround(HOME_TILE, RELIEF_EARTH);
    const started = performance.now();
    let sum = 0;
    const count = 100_000;
    for (let i = 0; i < count; i++) sum += g((i % 317) * 1.6 - 250, Math.floor(i / 317) * 1.6 - 250);
    const usPerSample = ((performance.now() - started) * 1000) / count;
    console.log(`${usPerSample.toFixed(3)} us a sample (${sum.toFixed(0)})`);
    expect(usPerSample).toBeLessThan(3);
  });
});
