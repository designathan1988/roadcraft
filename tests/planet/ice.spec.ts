import { describe, expect, it } from 'vitest';

import { PLANET_RADIUS } from '@core/cubeSphere';
import { TILES, TILE_COUNT, tileToSphereInto } from '@core/planetTiles';
import { PLATE_CELL } from '@world/planet/atlas';
import {
  FRONT_WIDTH,
  FRONT_WIDTH_FAR,
  ICE_CUT,
  ICE_EDGE,
  ICE_FRONT,
  ICE_METRES_PER_Z,
  ICE_WANDER,
  PACK_REACH,
  iceFloats,
  iceInside,
  iceNoise,
  iceTop,
  iceTopAt,
} from '@world/planet/ice';
import { SEA_LEVEL, earthHeight, tileGround } from '@world/planet/relief';
import { RELIEF_EARTH } from '@world/terrain';
import { natureNoise3 } from '../../src/render/natureNoise';
import { PATCH } from '../../src/render/planet/globeGround';
import { U } from './_border';

/**
 * THE PLANET'S ICE (`world/planet/ice.ts`): part of the relief, not a paint
 * (PL30). The polar caps stand on the land and float on the sea with a front
 * the terrain's grid can draw, the shaders find the same edge (the noise is
 * the shaders' twin), nothing of it reaches the temperate land, and it costs
 * the pieces' ground next to nothing. Run with `vitest.planet.config.ts`.
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

/** `iceInside` without its shortcut: the whole noise everywhere. */
function insideFull(x: number, y: number, z: number): number {
  let wander = 0;
  for (const [scale, amplitude, salt] of ICE_WANDER) wander += amplitude * (2 * iceNoise(x * PLANET_RADIUS, y * PLANET_RADIUS, z * PLANET_RADIUS, scale, salt) - 1);
  return (Math.abs(z) + wander - ICE_EDGE) * ICE_METRES_PER_Z;
}

describe('the planet\'s ice', () => {
  const points = lattice(40_000);

  it('reads the same noise as the shaders\' twin (render/natureNoise natureNoise3, GLSL woodsNoise)', () => {
    for (const p of points.slice(0, 4000)) {
      for (const [scale, , salt] of ICE_WANDER) {
        const x = p.x * PLANET_RADIUS, y = p.y * PLANET_RADIUS, z = p.z * PLANET_RADIUS;
        expect(iceNoise(x, y, z, scale, salt)).toBe(natureNoise3(x, y, z, scale, salt));
      }
    }
  });

  it('never reaches the temperate land, and its shortcut changes nothing within the pack ice\'s reach', () => {
    for (const p of points) {
      const full = insideFull(p.x, p.y, p.z);
      if (Math.abs(p.z) < ICE_CUT) expect(full).toBeLessThan(-PACK_REACH);
      else expect(iceInside(p.x, p.y, p.z)).toBeCloseTo(full, 6);
    }
    // Every point under |z| 0.707 is off the cube's polar faces, where the shaders skip the ice.
    expect(ICE_CUT).toBeGreaterThan(Math.SQRT1_2);
  });

  it('covers both poles, a few percent of the globe', () => {
    let covered = 0, north = 0, south = 0;
    for (const p of points) {
      if (iceInside(p.x, p.y, p.z) <= 0) continue;
      covered++;
      if (p.z > 0) north++; else south++;
    }
    const share = covered / points.length;
    console.log(`ice ${(share * 100).toFixed(1)}% of the globe (north ${north}, south ${south})`);
    expect(share).toBeGreaterThan(0.06);
    expect(share).toBeLessThan(0.14);
    expect(north).toBeGreaterThan(0);
    expect(south).toBeGreaterThan(0);
  });

  it('stands over the sea as a shelf with a front, and over the land as a sheet thickening inland', () => {
    let shelves = 0, sheets = 0;
    for (const p of points) {
      const inside = iceInside(p.x, p.y, p.z);
      if (inside <= FRONT_WIDTH) continue;
      const bed = earthHeight(p.x, p.y, p.z);
      const top = iceTop(bed, inside);
      if (bed < SEA_LEVEL) {
        shelves++;
        // Floating: the front's height over the sea and a little more, whatever the sea's depth.
        expect(top).toBeGreaterThanOrEqual(SEA_LEVEL + ICE_FRONT - 1e-6);
        // (The shelf rises 2 m inland past its front.)
        expect(top).toBeLessThan(SEA_LEVEL + ICE_FRONT + 6 * U);
        expect(iceFloats(bed, inside)).toBe(true);
      } else {
        sheets++;
        expect(top).toBeGreaterThanOrEqual(bed + ICE_FRONT - 1e-6);
        expect(iceFloats(bed, inside)).toBe(false);
        // Thicker further in.
        expect(iceTop(bed, inside + 200 * U) - bed).toBeGreaterThanOrEqual(top - bed - 1e-6);
      }
    }
    console.log(`shelf points ${shelves}, sheet points ${sheets}`);
    expect(shelves).toBeGreaterThan(100);
    expect(sheets).toBeGreaterThan(100);
  });

  it('rises at its front over three cells of the grid that draws it, near and far (no staircase)', () => {
    expect(FRONT_WIDTH).toBeGreaterThanOrEqual(3 * PLATE_CELL - 1e-6);
    // The far globe's patches: a piece's side in PATCH quads.
    const patchQuad = (2 * Math.PI * PLANET_RADIUS) / 4 / Math.sqrt(TILE_COUNT / 6) / PATCH;
    expect(FRONT_WIDTH_FAR).toBeGreaterThanOrEqual(2.5 * patchQuad);
    // The rise is smooth: no step between two points a centimetre apart. (A
    // shelf's own step from the sea floor to the sea's surface, under the
    // water at its margin, is not drawn above it.)
    for (const bed of [-30 * U, 0, 5 * U]) {
      for (let inside = bed < SEA_LEVEL ? 0.01 : 0; inside < FRONT_WIDTH * 1.5; inside += 0.01) {
        expect(Math.abs(iceTop(bed, inside + 0.01) - iceTop(bed, inside))).toBeLessThan(0.02);
      }
    }
  });

  it('is what the pieces\' ground draws, the same on both sides of every border', () => {
    const s = { x: 0, y: 0, z: 0 };
    let polar = 0;
    for (let t = 0; t < TILE_COUNT; t++) {
      if (Math.abs(TILES[t]!.centre.z) < 0.8) continue;
      polar++;
      const g = tileGround(t, RELIEF_EARTH);
      for (const [x, y] of [[0, 0], [200 * U, -150 * U], [-240 * U, 240 * U]] as const) {
        tileToSphereInto(t, x, y, s);
        expect(g(x, y)).toBeCloseTo(iceTopAt(earthHeight(s.x, s.y, s.z), s.x, s.y, s.z), 6);
      }
    }
    expect(polar).toBeGreaterThan(20);
  });

  it('costs the polar pieces\' ground little', () => {
    const tile = TILES.findIndex((t) => t.centre.z > 0.95);
    const g = tileGround(tile, RELIEF_EARTH);
    const started = performance.now();
    let sum = 0;
    const count = 100_000;
    for (let i = 0; i < count; i++) sum += g((i % 317) * 1.6 - 250, Math.floor(i / 317) * 1.6 - 250);
    const usPerSample = ((performance.now() - started) * 1000) / count;
    console.log(`${usPerSample.toFixed(3)} us a polar sample (${sum.toFixed(0)})`);
    expect(usPerSample).toBeLessThan(4);
  });
});
