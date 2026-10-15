import { clamp } from '@core/scalar';
import type { Vec2 } from '@core/vec2';
import { m } from './units';

/** How big the world is: a square about 10 km on a side about the origin */
export const PLATE_SIZE = m(2_048);
/** Plates along each side of the map. Odd, so one plate is centred on the origin. */
const PLATES_PER_SIDE = 5;
export const MAP_SIZE = PLATE_SIZE * PLATES_PER_SIDE;
export const MAP_HALF = MAP_SIZE / 2;

/** One square plate of ground: its centre and half its side. */
export interface MapRegion {
  readonly cx: number;
  readonly cy: number;
  readonly half: number;
}

/** The plates' offsets from the middle one, in plates: -2 .. 2. */
const REACH = (PLATES_PER_SIDE - 1) / 2;

/** Every plate the world has, row by row from the south-west. */
export const MAP_REGIONS: readonly MapRegion[] = Object.freeze(
  Array.from({ length: PLATES_PER_SIDE * PLATES_PER_SIDE }, (_, i) => Object.freeze({
    cx: ((i % PLATES_PER_SIDE) - REACH) * PLATE_SIZE,
    cy: (Math.floor(i / PLATES_PER_SIDE) - REACH) * PLATE_SIZE,
    half: PLATE_SIZE / 2,
  })),
);

/** The index of the plate whose cell holds a point (held to the map). */
export function plateOf(x: number, y: number): number {
  const kx = clamp(Math.round(x / PLATE_SIZE), -REACH, REACH);
  const ky = clamp(Math.round(y / PLATE_SIZE), -REACH, REACH);
  return (ky + REACH) * PLATES_PER_SIDE + (kx + REACH);
}

/** The plate whose cell holds a point: the nearest one. */
export function regionAt(x: number, y: number): MapRegion {
  return MAP_REGIONS[plateOf(x, y)] as MapRegion;
}

/** How far inside the edge anything the player builds is kept. */
export const MAP_MARGIN = m(25.6);

/** Whether a point is on the world at all. */
export const insideMap = (p: Vec2, margin = 0): boolean =>
  Math.abs(p.x) <= MAP_HALF - margin && Math.abs(p.y) <= MAP_HALF - margin;

/** The nearest point on the world to `p`. */
export const clampToMap = (p: Vec2, margin = MAP_MARGIN): Vec2 => ({
  x: clamp(p.x, -MAP_HALF + margin, MAP_HALF - margin),
  y: clamp(p.y, -MAP_HALF + margin, MAP_HALF - margin),
});
