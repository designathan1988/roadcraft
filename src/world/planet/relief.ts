import { PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { TILES, tileToSphereInto } from '@core/planetTiles';
import { RELIEF_EARTH, RELIEF_FLAT, RELIEF_NATURAL, type ReliefVersion } from '../terrain';
import { TILE_PLATE_HALF, TILE_REACH, atlasToTileInto, tileCellOf, type TileLocal } from './atlas';
import { TUNED_UNIT } from '../units';
import { FRONT_WIDTH, ICE_CUT, iceTopAt } from './ice';
import { SEA_LEVEL } from './seaLevel';

export { SEA_LEVEL };

/**
 * THE PLANET'S LAND: the same landforms as the flat map's (`terrain.ts`
 * `naturalRelief`, `baseRelief`), read at the POINT OF THE SPHERE rather than
 * at a face's own coordinates. A face's map ends at its border, but the
 * sphere does not: noise sampled in each face's coordinates gave two
 * different heights at every border, a step round the whole planet.
 * Sampled in three dimensions, both faces read the same ground at their
 * shared border (Catlike Coding, "Seamless Cube Sphere": noise at the 3-D
 * position, never per face).
 *
 * Deterministic and analytic, as the flat map's land is.
 */

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263) ^ Math.imul(z | 0, 2_246_822_519);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_648 - 1;
}

/** Smooth deterministic value noise in three dimensions, -1..1. */
export function valueNoise3(x: number, y: number, z: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  // No closure made per call: it runs some 25 times a point of land, a
  // hundred thousand points a piece.
  const x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
  const a00 = hash3(x0, y0, z0), a10 = hash3(x1, y0, z0), a01 = hash3(x0, y1, z0), a11 = hash3(x1, y1, z0);
  const b00 = hash3(x0, y0, z1), b10 = hash3(x1, y0, z1), b01 = hash3(x0, y1, z1), b11 = hash3(x1, y1, z1);
  const ay0 = a00 + (a10 - a00) * sx, ay1 = a01 + (a11 - a01) * sx;
  const by0 = b00 + (b10 - b00) * sx, by1 = b01 + (b11 - b01) * sx;
  const a = ay0 + (ay1 - ay0) * sy, b = by0 + (by1 - by0) * sy;
  return a + (b - a) * sz;
}

const smooth01 = (t: number): number => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

/** `naturalRelief` at a point of the sphere (world units from its centre). */
export function naturalRelief3(x: number, y: number, z: number): number {
  return naturalRelief3Tuned(x / TUNED_UNIT, y / TUNED_UNIT, z / TUNED_UNIT) * TUNED_UNIT;
}

/** `naturalRelief3` in the unit its figures were tuned in (`TUNED_UNIT`). */
function naturalRelief3Tuned(x: number, y: number, z: number): number {
  const n = valueNoise3;
  const wx = n(x / 1400 + 3.1, y / 1400 - 7.4, z / 1400 + 1.7) * 420;
  const wy = n(x / 1400 - 11.2, y / 1400 + 2.6, z / 1400 - 4.9) * 420;
  const wz = n(x / 1400 + 6.3, y / 1400 + 9.8, z / 1400 + 12.4) * 420;
  const px = x + wx, py = y + wy, pz = z + wz;
  const continent = n(px / 1900, py / 1900, pz / 1900);
  const hilly = smooth01((n(px / 1300 + 17.3, py / 1300 - 5.9, pz / 1300 + 3.3) + 0.1) / 0.85);
  let ridge = 0;
  let weight = 0;
  let amplitude = 1;
  let frequency = 1 / 640;
  for (let octave = 0; octave < 4; octave++) {
    const r = 1 - Math.abs(n(px * frequency + octave * 13.7, py * frequency - octave * 9.1, pz * frequency + octave * 5.3));
    ridge += r * r * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  ridge /= weight;
  const rolling = n(px / 260 + 2.2, py / 260 - 8.8, pz / 260 + 0.7) * 0.65 + n(px / 110 + 4.4, py / 110 + 1.3, pz / 110 - 2.1) * 0.35;
  const micro = n(x / 38 - 6.6, y / 38 + 3.3, z / 38 + 8.1) * 0.6 + n(x / 17 + 9.9, y / 17 - 2.7, z / 17 - 5.5) * 0.4;
  return 55 * continent + hilly * (190 * ridge - 60) + 22 * rolling * (0.35 + 0.65 * hilly) + 1.6 * micro;
}

/** `baseRelief` at a point of the sphere. */
export function baseRelief3(x: number, y: number, z: number): number {
  return baseRelief3Tuned(x / TUNED_UNIT, y / TUNED_UNIT, z / TUNED_UNIT) * TUNED_UNIT;
}

/** `baseRelief3` in the unit its figures were tuned in (`TUNED_UNIT`). */
function baseRelief3Tuned(x: number, y: number, z: number): number {
  const n = valueNoise3;
  const broad = n(x / 620, y / 620, z / 620);
  const middle = n(x / 210 + 13.7, y / 210 - 4.1, z / 210 + 2.9);
  const fine = n(x / 88 - 7.3, y / 88 + 19.2, z / 88 - 6.4);
  const grain = n(x / 48 + 31.5, y / 48 - 12.8, z / 48 + 7.7);
  return 32 * (broad * 0.42 + middle * 0.29 + fine * 0.2 + grain * 0.09);
}

// ------------------------------------------------------------------ the Earth

/**
 * THE PLANET'S EARTH: continents and oceans, read at the point of the sphere
 * (its unit direction), so every piece's map and both sides of every border
 * agree.
 *
 * Built as Sebastian Lague builds his Earth-like planets ("Coding Adventure:
 * Procedural Moons and Planets", `EarthHeight.compute` in SebLague/Solar-System):
 * a low-frequency CONTINENT noise decides land and sea; under the sea a
 * smooth maximum holds the ocean floor; over the land a RIDGED noise raises
 * mountains where a third, slow MASK noise allows them. The continent noise
 * is DOMAIN-WARPED (Inigo Quilez, "Domain Warping": the noise read at a point
 * moved by another noise) so coasts wind into bays, peninsulas and capes
 * rather than the round blobs plain noise draws.
 *
 * Shaped after the Earth's two levels (continents and ocean floors) and its
 * margins (Wikipedia, "Continental shelf": a shelf of gentle gradient to a
 * break, then a steeper slope down to the abyssal plain): under the sea the
 * ground runs out as a shallow shelf - pale water over sand - before it falls
 * to the deep. On land the plains rise slowly from a low coast, so a town has
 * room to grow, and the mountains stand inland.
 *
 * Tuned in `TUNED_UNIT`s (0.4 m) and returned in world units; sea level is 0 (`SEA_LEVEL`). Mountains
 * and the floor stay within some 4% of the radius, so the globe's outline
 * stays round from orbit. No allocation; deterministic.
 */

/** The deepest the ocean floor goes, `TUNED_UNIT`s (60 m). */
const OCEAN_FLOOR_TUNED = -150;
/** The deepest the ocean floor goes, world units. */
export const OCEAN_FLOOR = OCEAN_FLOOR_TUNED * TUNED_UNIT;
/** The tallest a mountain range stands over its plain, `TUNED_UNIT`s (70 m). */
const MOUNTAIN_HEIGHT = 175;
/**
 * The continent noise's level at the coast: the share of the planet above it
 * is land (`tests/planet/earth.spec.ts` measures it).
 */
const COAST_LEVEL = 0.225;

/** The piece the game opens on (the camera's first place, atlas 0, 0): the home continent stands there. */
export const HOME_TILE = tileCellOf(0, 0);
const HOME = TILES[HOME_TILE]!.centre;
/** Within this arc of home (radians) the land is raised to a continent, fading out by `HOME_REACH`. */
const HOME_CORE = 0.2;
const HOME_REACH = 0.5;
/** How much the home continent lifts the continent noise. */
const HOME_LIFT = 0.55;
/** Within this arc of home the mountains are held down: room to build. */
const HOME_PLAIN = 0.32;
const cosCore = Math.cos(HOME_CORE);
const cosReach = Math.cos(HOME_REACH);
const cosPlain = Math.cos(HOME_PLAIN);

/** Fractal value noise, normalised to about -1..1: `octaves` layers, `lacunarity` times the frequency and `gain` the amplitude each. */
function fbm3(x: number, y: number, z: number, octaves: number, lacunarity: number, gain: number): number {
  let sum = 0, weight = 0, amplitude = 1, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise3(x * f + o * 17.31, y * f - o * 9.73, z * f + o * 5.19) * amplitude;
    weight += amplitude;
    amplitude *= gain;
    f *= lacunarity;
  }
  return sum / weight;
}

/** A smooth maximum (Inigo Quilez, "Smooth minimum", the polynomial one): `a` and `b` blended over `k`. */
function smoothMax(a: number, b: number, k: number): number {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (a - b)) / k));
  return b + (a - b) * h + k * h * (1 - h);
}

/** The continent noise's first octaves alone (`continentAt` sets it): the land's broad rise inland, without the coast's detail. */
let broadLevel = 0;
/** Octaves of the continent noise: the coast's detail. */
const CONTINENT_OCTAVES = 6;
/** Of them, the broad ones the land's rise inland follows. */
const BROAD_OCTAVES = 2;

/**
 * How far into a continent a unit direction lies: positive on land (the
 * further inland, the larger), negative at sea, 0 on the coast.
 */
export function continentAt(sx: number, sy: number, sz: number): number {
  const n = valueNoise3;
  // The warp: a slow noise moving the point the continents are read at.
  const qx = sx * 1.55, qy = sy * 1.55, qz = sz * 1.55;
  const px = qx + 0.55 * n(qx * 1.3 + 3.1, qy * 1.3 - 7.4, qz * 1.3 + 1.7);
  const py = qy + 0.55 * n(qx * 1.3 - 11.2, qy * 1.3 + 2.6, qz * 1.3 - 4.9);
  const pz = qz + 0.55 * n(qx * 1.3 + 6.3, qy * 1.3 + 9.8, qz * 1.3 + 12.4);
  let sum = 0, weight = 0, amplitude = 1, f = 1, broad = 0;
  for (let o = 0; o < CONTINENT_OCTAVES; o++) {
    sum += n(px * f + o * 17.31, py * f - o * 9.73, pz * f + o * 5.19) * amplitude;
    weight += amplitude;
    if (o === BROAD_OCTAVES - 1) broad = sum;
    amplitude *= 0.5;
    f *= 2.03;
  }
  const home = HOME_LIFT * smooth01((sx * HOME.x + sy * HOME.y + sz * HOME.z - cosReach) / (cosCore - cosReach));
  broadLevel = broad / weight - COAST_LEVEL + home;
  return sum / weight - COAST_LEVEL + home;
}

/** The Earth's land at a unit direction of the sphere, world units over sea level. */
export function earthHeight(sx: number, sy: number, sz: number): number {
  return earthHeightTuned(sx, sy, sz) * TUNED_UNIT;
}

/** `earthHeight` in the unit its figures were tuned in (`TUNED_UNIT`). */
function earthHeightTuned(sx: number, sy: number, sz: number): number {
  const n = valueNoise3;
  const e = continentAt(sx, sy, sz);
  if (e < 0) {
    // The shelf, gentle, to some -9 off the coast; then the continental
    // slope to the floor, held there by a smooth maximum.
    // (A shelf 3.6 m deep under a plane at sea level was lost in the depth
    // buffer from any height: water and bed fought pixel by pixel.)
    const sea = e > -0.15 ? 400 * e : -60 + 900 * (e + 0.15);
    const floor = smoothMax(sea, OCEAN_FLOOR_TUNED, 40);
    // The floor's own hills, coming in off the shelf.
    return floor + 7 * n(sx * 40 + 1.3, sy * 40 - 2.2, sz * 40 + 7.7) * smooth01(-e / 0.2);
  }
  // The coast: a low strand rising gently off the water (the full noise,
  // its every bay); inland the land rises with the broad noise only, so the
  // plains are wide and gentle, never the coast's detail at a hill's height.
  const coast = 3 * smooth01(e / 0.15);
  const inland = smooth01(e / 0.12);
  const plateau = 26 * smooth01(broadLevel / 0.45) * inland;
  // Rolling ground, quiet at the shore so a beach stays a beach.
  const rolling = (2.6 * n(sx * 24 + 2.2, sy * 24 - 8.8, sz * 24 + 0.7) + 0.6 * n(sx * 90 + 4.4, sy * 90 + 1.3, sz * 90 - 2.1)) * inland;
  // Mountains: where the slow mask allows, inland, held down round the home site.
  const homePlain = smooth01((sx * HOME.x + sy * HOME.y + sz * HOME.z - cosPlain) / (cosCore - cosPlain));
  const mask = smooth01((fbm3(sx * 2.4 + 21.7, sy * 2.4 - 3.3, sz * 2.4 + 9.1, 3, 2.1, 0.5) + 0.02) / 0.22)
    * smooth01((e - 0.06) / 0.2) * (1 - 0.95 * homePlain);
  let mountains = 0;
  if (mask > 0) {
    let ridge = 0, weight = 0, amplitude = 1, f = 7.5;
    for (let o = 0; o < 5; o++) {
      const r = 1 - Math.abs(n(sx * f + o * 13.7, sy * f - o * 9.1, sz * f + o * 5.3));
      ridge += r * r * amplitude;
      weight += amplitude;
      amplitude *= 0.5;
      f *= 2.07;
    }
    ridge /= weight;
    mountains = MOUNTAIN_HEIGHT * mask * ridge * ridge;
  }
  return 0.4 + coast + plateau + rolling + mountains;
}

/** `earthHeight` at a point of the sphere (world units from its centre). */
export function earthRelief3(x: number, y: number, z: number): number {
  const l = Math.hypot(x, y, z) || 1;
  return earthHeight(x / l, y / l, z / l);
}

/**
 * The land under one piece's map (`core/planetTiles.ts`): a point of it (its
 * own coordinates, about its centre) to the height of the planet's ground
 * there - the land and, round the poles, the ice standing on it (`ice.ts`:
 * what the terrain draws is the ice's top, as an elevation model's "ice
 * surface"; `earthHeight` stays the bed under it). `frontWidth`: how far
 * the ice's front rises, to suit the mesh drawing it (`ice.ts` FRONT_WIDTH).
 */
export function tileGround(tile: number, relief: ReliefVersion, frontWidth = FRONT_WIDTH): (x: number, y: number) => number {
  const s: Vec3 = { x: 0, y: 0, z: 0 };
  // A piece whose ground never comes near the ice reads no ice at all.
  const c = TILES[tile]!.centre;
  const frozen = Math.abs(c.z) > ICE_CUT - TILE_ICE_REACH;
  if (relief === RELIEF_FLAT) {
    if (!frozen) return () => 0;
    return (x, y) => {
      tileToSphereInto(tile, x, y, s);
      return iceTopAt(0, s.x, s.y, s.z, frontWidth);
    };
  }
  if (relief === RELIEF_EARTH) {
    return (x, y) => {
      tileToSphereInto(tile, x, y, s);
      const bed = earthHeight(s.x, s.y, s.z);
      return frozen ? iceTopAt(bed, s.x, s.y, s.z, frontWidth) : bed;
    };
  }
  const land = relief === RELIEF_NATURAL ? naturalRelief3 : baseRelief3;
  return (x, y) => {
    tileToSphereInto(tile, x, y, s);
    const bed = land(s.x * PLANET_RADIUS, s.y * PLANET_RADIUS, s.z * PLANET_RADIUS);
    return frozen ? iceTopAt(bed, s.x, s.y, s.z, frontWidth) : bed;
  };
}

/**
 * How far a piece's map reaches from its centre, as |z| on the sphere: half
 * its square's diagonal and the reach brought round it (a piece is 7.5
 * degrees across, 500 m; `atlas.ts` TILE_REACH 120 m), with room to spare.
 */
const TILE_ICE_REACH = (2 * TILE_PLATE_HALF + 2 * TILE_REACH) / PLANET_RADIUS;

const atAtlas: TileLocal = { tile: 0, x: 0, y: 0 };
const onSphere: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The planet's ground at an atlas point (read on the point's own piece), for a
 * relief, its ice on it: the analytic field, for what has no piece's terrain
 * at hand (the editor's tunnel test, `editor/commit.ts`).
 */
export function atlasGround(relief: ReliefVersion): (x: number, y: number) => number {
  return (x, y) => {
    atlasToTileInto(x, y, atAtlas);
    tileToSphereInto(atAtlas.tile, atAtlas.x, atAtlas.y, onSphere);
    const bed = relief === RELIEF_FLAT ? 0
      : relief === RELIEF_EARTH ? earthHeight(onSphere.x, onSphere.y, onSphere.z)
        : (relief === RELIEF_NATURAL ? naturalRelief3 : baseRelief3)(onSphere.x * PLANET_RADIUS, onSphere.y * PLANET_RADIUS, onSphere.z * PLANET_RADIUS);
    return iceTopAt(bed, onSphere.x, onSphere.y, onSphere.z);
  };
}
