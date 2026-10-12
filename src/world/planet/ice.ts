import { PLANET_RADIUS } from '@core/cubeSphere';
import { m } from '../units';
import { SEA_LEVEL } from './seaLevel';

/**
 * THE PLANET'S ICE, as part of its relief: the polar caps are not a white
 * paint over the land and the sea but ice standing on them, as an elevation
 * model of the Earth carries them (NOAA's ETOPO 2022: an "Ice Surface"
 * version, the top of the Antarctic and Greenland sheets, beside the
 * "Bedrock" under them). Read at the point of the sphere (its unit
 * direction), so every piece's map and both sides of every border agree.
 *
 *  - Over the land, an ICE SHEET: a steep margin, then a dome thickening
 *    inland with the square root of the distance from the margin (Nye's
 *    profile, the limit of Vialov's for Glen's law).
 *  - Over the sea, a floating ICE SHELF: flat, gently rising inland, ending
 *    at the ICE FRONT, the cliff of its seaward face (NSIDC: 2 to 50 m over
 *    the sea; the Ross Ice Shelf's 15 to 50 m), nine tenths of it under the
 *    water (`ICE_DRAFT`).
 *
 * Heights are scaled as the planet's other relief is (mountains of 70 m on a
 * radius of 3.8 km). The edge wanders by a value noise with an INTEGER hash
 * (`iceNoise`, the same as `render/natureNoise.ts` natureNoise3), so the
 * shaders that draw it (`render/planet/iceField.ts`) find the same edge to a
 * hair: the paint and the cliff are where the relief puts them.
 *
 * Deterministic, no allocation.
 */

/** Where the ice begins, as |z| (the sine of the latitude, the axis is z) before its edge wanders: about 65 degrees. */
export const ICE_EDGE = 0.905;
/** The ice front's height over the sea, world units (the planet's relief is exaggerated: its mountains are 70 m). */
export const ICE_FRONT = m(10);
/**
 * How far the front rises, from the sea or the bare land to `ICE_FRONT` over
 * it: three cells of the terrain that draws it (6.4 m). A heightfield samples
 * the ground at its corners, and a front narrower than about two of them came
 * out as a staircase along the grid (seen 2026-10-11 at 9 m); the shaders draw
 * the steep band as the ice's face.
 */
export const FRONT_WIDTH = m(20);
/** The same for the far globe's coarse patches (`render/planet/globeGround.ts`, 62.5 m quads). */
export const FRONT_WIDTH_FAR = m(160);
/** How much the shelf rises inland past its front, and over what distance. */
const SHELF_RISE = m(2);
const SHELF_REACH = m(400);
/** The sheet's dome over the land at its thickest, and how far in from the margin it gets there. */
export const ICE_DOME = m(26);
const DOME_REACH = m(700);
/** Height of bare land over the sea over which the shelf becomes a grounded sheet. */
const GROUNDING = m(3);
/** How deep a floating shelf reaches under the sea: nine tenths of the ice is under the water (917 / 1027). */
export const ICE_DRAFT = (ICE_FRONT + SHELF_RISE) * 8;
/**
 * The belt of broken sea ice (pack ice) beyond the front, world units: narrow,
 * so from orbit the front stays a sharp line with a broken fringe, not a haze.
 */
export const PACK_REACH = m(380);

/**
 * The edge's wander: [scale (world units), amplitude (in |z|), salt]. Broad
 * lobes, then bays and tongues, then the front's ragged line.
 */
export const ICE_WANDER: readonly (readonly [number, number, number])[] = [
  [m(1800), 0.035, 61],
  [m(420), 0.012, 62],
  [m(110), 0.004, 63],
  [m(30), 0.0012, 64],
];
/** The most the edge can wander, in |z|. */
export const ICE_WANDER_MAX = ICE_WANDER.reduce((sum, w) => sum + w[1], 0);
/** World units of ground per unit of |z| at the edge's latitude (the arc's d|z|/ds = cos(latitude) / R). */
export const ICE_METRES_PER_Z = PLANET_RADIUS / Math.sqrt(1 - ICE_EDGE * ICE_EDGE);
/**
 * Under this |z| the edge is never within the pack ice's reach: `iceInside`
 * answers without the noise (an upper bound, still under -`PACK_REACH`).
 */
export const ICE_CUT = ICE_EDGE - ICE_WANDER_MAX - PACK_REACH / ICE_METRES_PER_Z - 0.01;

/**
 * `render/natureNoise.ts` natureNoise3: value noise over the sphere's points
 * (world units) with an integer hash, 0..1 - so a shader reading it
 * (`iceField.ts`, uint arithmetic wrapping as Math.imul does) gets the same.
 */
export function iceNoise(x: number, y: number, z: number, scale: number, salt: number): number {
  const gx = x / scale, gy = y / scale, gz = z / scale;
  const x0 = Math.floor(gx), y0 = Math.floor(gy), z0 = Math.floor(gz);
  const fx = gx - x0, fy = gy - y0, fz = gz - z0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const a = iceLayer(x0, y0, z0, sx, sy, salt);
  return a + (iceLayer(x0, y0, z0 + 1, sx, sy, salt) - a) * sz;
}

function iceHash(a: number, b: number, c: number, salt: number): number {
  let v = Math.imul(a, 374_761_393) ^ Math.imul(b, 668_265_263) ^ Math.imul(c, 1_440_670_441) ^ Math.imul(salt, 2_246_822_519);
  v = Math.imul(v ^ (v >>> 13), 1_274_126_177);
  return ((v ^ (v >>> 16)) >>> 0) / 4_294_967_296;
}

function iceLayer(x0: number, y0: number, c: number, sx: number, sy: number, salt: number): number {
  const h00 = iceHash(x0, y0, c, salt), h10 = iceHash(x0 + 1, y0, c, salt);
  const h01 = iceHash(x0, y0 + 1, c, salt), h11 = iceHash(x0 + 1, y0 + 1, c, salt);
  const top = h00 + (h10 - h00) * sx;
  const bottom = h01 + (h11 - h01) * sx;
  return top + (bottom - top) * sy;
}

/**
 * How far within the ice's edge a unit direction lies, world units along the
 * ground (about): positive under the ice, negative outside it.
 */
export function iceInside(sx: number, sy: number, sz: number): number {
  const lat = Math.abs(sz);
  if (lat < ICE_CUT) return (lat + ICE_WANDER_MAX - ICE_EDGE) * ICE_METRES_PER_Z;
  const x = sx * PLANET_RADIUS, y = sy * PLANET_RADIUS, z = sz * PLANET_RADIUS;
  let wander = 0;
  for (const [scale, amplitude, salt] of ICE_WANDER) wander += amplitude * (2 * iceNoise(x, y, z, scale, salt) - 1);
  return (lat + wander - ICE_EDGE) * ICE_METRES_PER_Z;
}

const smooth01 = (t: number): number => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

/**
 * The ground's top at a point `inside` world units within the ice's edge
 * (`iceInside`), over bare ground `bed`: the bed itself outside the ice; over
 * the sea a shelf floating `ICE_FRONT` and more over it; over the land the
 * sheet's margin and dome draped on the bed.
 */
export function iceTop(bed: number, inside: number, frontWidth = FRONT_WIDTH): number {
  if (inside <= 0) return bed;
  const rise = smooth01(inside / frontWidth);
  const front = ICE_FRONT * rise;
  const shelf = SHELF_RISE * smooth01(inside / SHELF_REACH);
  const grounded = smooth01((bed - SEA_LEVEL) / GROUNDING);
  // Nye's square root, eased in over the front: its infinite slope at the
  // margin is a cliff no corner grid can draw.
  const dome = ICE_DOME * Math.sqrt(Math.min(1, inside / DOME_REACH)) * rise * grounded;
  return Math.max(bed, SEA_LEVEL) + front + shelf + dome;
}

/** The ground's top with its ice at a unit direction, over bare ground `bed`. */
export function iceTopAt(bed: number, sx: number, sy: number, sz: number, frontWidth = FRONT_WIDTH): number {
  return Math.abs(sz) < ICE_CUT ? bed : iceTop(bed, iceInside(sx, sy, sz), frontWidth);
}

/**
 * Whether the ice at `inside` over bare ground `bed` floats (a shelf over the
 * sea, the sea running on under it) rather than standing on land: by the bed,
 * never by the ice's top - near its margin a sheet on a low strand is as low
 * as a shelf, and read by its top it was taken for one and the sea was drawn
 * over the land there.
 */
export function iceFloats(bed: number, inside: number): boolean {
  return inside > 0 && bed < SEA_LEVEL;
}
