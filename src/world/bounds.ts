import { clamp } from '@core/scalar';
import type { Vec2 } from '@core/vec2';
import { m } from './units';

/**
 * How big the world is: a square about 10 km on a side about the origin (the
 * player, 2026-10-13: "QUERO 10KM"), laid in square plates of ground of
 * `PLATE_SIZE`, each its own mesh (`render/flatAtlas.ts`). A plate is 320 of
 * the terrain's 6.4 m cells, the cell the grading of lots on a hillside was
 * tuned and tested at (`tests/world/steppedYards.spec.ts`; at 6.25 m or
 * 6.67 m earth rose over a terrace's paving): five of them make 10.24 km.
 * The maps made before stood within the plate about the origin, and stand
 * there still.
 *
 * It lived in `render/terrain.ts`, which made it a fact about the PICTURE —
 * so everything that authored a position (a node, a pole) had no way to know
 * where the world ended, because `world` may not import `render`. The
 * consequence was visible: roads, poles and the street furniture hanging off
 * them could be built past the edge of the map, standing on nothing.
 *
 * It belongs here, where the document can see it.
 */
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

/**
 * How far inside the edge anything the player builds is kept.
 *
 * Not zero, because a road is WIDE: a centreline exactly on the rim puts half
 * a carriageway, its footway and its casing out over the void. The widest road
 * in the game is under 30 units of casing half-width, and a junction between
 * two of them reaches further still, so this is that with room to spare.
 */
export const MAP_MARGIN = m(25.6);

/** Whether a point is on the world at all. */
export const insideMap = (p: Vec2, margin = 0): boolean =>
  Math.abs(p.x) <= MAP_HALF - margin && Math.abs(p.y) <= MAP_HALF - margin;

/**
 * The nearest point on the world to `p`.
 *
 * Clamping rather than refusing, and deliberately: a drag that runs off the
 * edge should build a road up to the edge, which is what the player was
 * plainly asking for. Refusing it would make the last stretch of a drag do
 * nothing, with no explanation.
 */
export const clampToMap = (p: Vec2, margin = MAP_MARGIN): Vec2 => ({
  x: clamp(p.x, -MAP_HALF + margin, MAP_HALF - margin),
  y: clamp(p.y, -MAP_HALF + margin, MAP_HALF - margin),
});
