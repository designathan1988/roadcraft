import { describe, expect, it } from 'vitest';
import { TILES, sphereToTileInto, tileOfDirection } from '@core/planetTiles';
import { RELIEF_EARTH } from '@world/terrain';
import { HOME_TILE, tileGround } from '@world/planet/relief';
import { RELIEF_FLAT, RELIEF_NATURAL } from '@world/terrain';
import { SEA_LEVEL } from '@world/planet/seaLevel';
import {
  FLAT_EARTH_HEIGHT, FLAT_EARTH_RADIUS, FLAT_EARTH_WIDTH, FLAT_PLATE, ROAD_SEA_FREEBOARD, flatEarthGround, flatGroundFor,
  flatSeaFor, flatSeaHold, flatToSphereInto, seaRoadGround, sphereToFlatInto,
} from '@world/flatEarth';

/**
 * THE WHOLE EARTH ON THE FLAT MAP (`world/flatEarth.ts`,
 * docs/MAPA-PLANO-COMPLETO.md): the planet's land on one plane, the plain
 * world map - the same ground at the same place as the globe draws it.
 */

/** A deterministic stream in [0, 1). */
function stream(seed: number): () => number {
  let v = seed;
  return () => { v = (v * 16807) % 2147483647; return v / 2147483647; };
}

describe('the whole Earth on the flat map', () => {
  it('is the size of the globe: the equator as long, the map half as tall', () => {
    expect(FLAT_EARTH_WIDTH).toBeCloseTo(2 * Math.PI * FLAT_EARTH_RADIUS, 6);
    expect(FLAT_EARTH_HEIGHT).toBeCloseTo(Math.PI * FLAT_EARTH_RADIUS, 6);
    expect(FLAT_EARTH_WIDTH).toBeGreaterThan(20_000);
  });

  it("opens on the planet's own town", () => {
    const d = flatToSphereInto(0, 0, { x: 0, y: 0, z: 0 });
    const home = TILES[HOME_TILE]!.centre;
    expect(Math.hypot(d.x - home.x, d.y - home.y, d.z - home.z)).toBeLessThan(1e-9);
  });

  it('stands the same ground at the same place as the globe does', () => {
    const next = stream(3);
    const d = { x: 0, y: 0, z: 0 }, local = { x: 0, y: 0 };
    for (let i = 0; i < 400; i++) {
      const x = (next() - 0.5) * FLAT_EARTH_WIDTH, y = (next() - 0.5) * 0.98 * FLAT_EARTH_HEIGHT;
      flatToSphereInto(x, y, d);
      const tile = tileOfDirection(d);
      sphereToTileInto(tile, d, local);
      expect(flatEarthGround(x, y)).toBeCloseTo(tileGround(tile, RELIEF_EARTH)(local.x, local.y), 6);
    }
  });

  it('meets itself east and west, and goes there and back', () => {
    const next = stream(9);
    const p = { x: 0, y: 0 }, d = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 200; i++) {
      const x = (next() - 0.5) * 0.9 * FLAT_EARTH_WIDTH, y = (next() - 0.5) * 0.9 * FLAT_EARTH_HEIGHT;
      expect(flatEarthGround(x + FLAT_EARTH_WIDTH, y)).toBeCloseTo(flatEarthGround(x, y), 6);
      sphereToFlatInto(flatToSphereInto(x, y, d), p);
      expect(p.x).toBeCloseTo(x, 6);
      expect(p.y).toBeCloseTo(y, 6);
    }
  });

  it('is continuous: a metre apart, the ground a little apart', () => {
    const next = stream(17);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const x = (next() - 0.5) * FLAT_EARTH_WIDTH, y = (next() - 0.5) * 0.9 * FLAT_EARTH_HEIGHT;
      worst = Math.max(worst, Math.abs(flatEarthGround(x + 1, y) - flatEarthGround(x, y)), Math.abs(flatEarthGround(x, y + 1) - flatEarthGround(x, y)));
    }
    // Steeper than a cliff nowhere but at an ice front (a few metres a metre).
    expect(worst).toBeLessThan(8);
  });

  it('keeps an old map on its own plate and eases it into the Earth beyond, with no step', () => {
    for (const relief of [RELIEF_FLAT, RELIEF_NATURAL]) {
      const land = flatGroundFor(relief);
      const own = flatGroundFor(relief === RELIEF_FLAT ? RELIEF_FLAT : RELIEF_NATURAL);
      // On the plate: the old land exactly (its roads stand where they stood).
      expect(land(300, -420)).toBe(own(300, -420));
      // Across the plate's edge and the easing, a metre apart a little apart.
      let worst = 0;
      for (let y = -1500; y <= 1500; y += 37) for (let x = 900; x <= 1500; x += 1) worst = Math.max(worst, Math.abs(land(x + 1, y) - land(x, y)));
      expect(worst).toBeLessThan(2);
      // Far out, the Earth's.
      expect(land(9000, 2000)).toBe(flatEarthGround(9000, 2000));
    }
  });

  it("lays no sea on an old map's plate, and its coast is a contour of the land", () => {
    const sea = flatSeaFor(RELIEF_FLAT), land = flatGroundFor(RELIEF_FLAT);
    for (let i = 0; i < 400; i++) expect(sea(-900 + (i % 20) * 90, -900 + Math.floor(i / 20) * 90)).toBe(false);
    for (let y = -6000; y <= 6000; y += 97) for (let x = -12000; x <= 12000; x += 97) {
      if (Math.max(Math.abs(x), Math.abs(y)) <= FLAT_PLATE / 2) continue;
      expect(sea(x, y)).toBe(land(x, y) < SEA_LEVEL - 0.3);
    }
  });

  it('never lays a road under the sea, and the ground a road is solved on has no step', () => {
    for (const relief of [RELIEF_FLAT, RELIEF_NATURAL]) {
      const land = flatGroundFor(relief), sea = flatSeaFor(relief), hold = flatSeaHold(relief);
      const ground = (x: number, y: number): number => { const h = land(x, y); return seaRoadGround(h, hold(x, y, h)); };
      const added = (x: number, y: number, d: number): number => Math.abs(ground(x + d, y) - ground(x, y)) - Math.abs(land(x + d, y) - land(x, y));
      let worst = 0, at = { x: 0, y: 0 };
      for (let y = -2600; y <= 2600; y += 23) {
        for (let x = -2600; x <= 2600; x += 0.5) {
          if (sea(x, y) && Math.max(Math.abs(x), Math.abs(y)) > FLAT_PLATE / 2 + 40) expect(ground(x, y)).toBeGreaterThanOrEqual(SEA_LEVEL);
          const a = added(x, y, 0.5);
          if (a > worst) { worst = a; at = { x, y }; }
        }
      }
      // What the hold adds is a slope, never a step: where it adds most over
      // half a metre, it adds a hundredth of that over five millimetres.
      let fine = 0;
      for (let x = at.x; x <= at.x + 0.5; x += 0.005) fine = Math.max(fine, added(x, at.y, 0.005));
      expect(fine).toBeLessThan(Math.max(0.002, worst / 50));
      // Over deep water the crest stands the freeboard above the waves.
      expect(seaRoadGround(-20, 1)).toBeCloseTo(SEA_LEVEL + ROAD_SEA_FREEBOARD, 6);
      // On the old plate the land as it is, valleys under zero too.
      expect(ground(100, 100)).toBe(land(100, 100));
    }
  });
});
