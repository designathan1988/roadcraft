import { TILE_COUNT } from '@core/planetTiles';
import { clamp } from '@core/scalar';
import type { Vec2 } from '@core/vec2';
import { TILE_PLATE_HALF, TILE_REACH, tileCellOf, tileCentre } from './planet/atlas';
import { FLAT_PLATE, FLAT_PLATES, FLAT_WORLD, flatPlateCentre, flatPlateOf } from './flatEarth';
import { m } from './units';

/**
 * How big the world is.
 *
 * The ground is a finite plate, and this is its size. It lived in
 * `render/terrain.ts`, which made it a fact about the PICTURE — so everything
 * that authored a position (a node, a pole) had no way to know where the world
 * ended, because `world` may not import `render`. The consequence was visible:
 * roads, poles and the street furniture hanging off them could be built past
 * the edge of the map, standing on nothing.
 *
 * It belongs here, where the document can see it.
 *
 * On the planet (`__PLANET__`) the world is its 96 pieces, each a flat map,
 * side by side in one plane (`planet/atlas.ts`): `MAP_SIZE` is then a piece's
 * plate, and `MAP_REGIONS` lists the plates.
 */
export const MAP_SIZE = __PLANET__ ? TILE_PLATE_HALF * 2 : FLAT_PLATE;
export const MAP_HALF = MAP_SIZE / 2;

/** One square plate of ground: its centre and half its side. */
export interface MapRegion {
  readonly cx: number;
  readonly cy: number;
  readonly half: number;
}

/**
 * Every plate the world has: the planet's pieces, or the whole flat Earth's
 * plates (`flatEarth.ts`; the player, 2026-10-11: "no modo plano tem que ter o
 * mapa completo do mesmo tamanho que é no globo"), the old map the one about
 * the origin.
 */
export const MAP_REGIONS: readonly MapRegion[] = Object.freeze(
  __PLANET__
    ? Array.from({ length: TILE_COUNT }, (_, t) => Object.freeze({ cx: tileCentre(t).x, cy: tileCentre(t).y, half: MAP_HALF }))
    : Array.from({ length: FLAT_PLATES }, (_, i) => { const c = flatPlateCentre(i); return Object.freeze({ cx: c.x, cy: c.y, half: MAP_HALF }); }),
);

/**
 * Half the side of the square about the origin that holds every plate (and
 * what reaches past them): `MAP_HALF` on the flat map. What is laid over the
 * whole world in one texture - the wear of the streets, the painted fog - is
 * laid over this.
 */
export const WORLD_HALF = __PLANET__
  ? Math.max(...MAP_REGIONS.map((r) => Math.max(Math.abs(r.cx), Math.abs(r.cy)) + r.half)) + TILE_REACH
  : Math.max(-FLAT_WORLD.minX, FLAT_WORLD.maxX, -FLAT_WORLD.minY, FLAT_WORLD.maxY);

/** The plate whose cell holds a point: the nearest one. */
export function regionAt(x: number, y: number): MapRegion {
  if (!__PLANET__) return MAP_REGIONS[flatPlateOf(x, y)] as MapRegion;
  return MAP_REGIONS[tileCellOf(x, y)] as MapRegion;
}

/**
 * How far past its plate's edge a thing may reach: nothing on the flat map;
 * on the planet, over the face's border onto the neighbour's ground
 * (`planet/atlas.ts` FACE_REACH).
 */
export const MAP_REACH = __PLANET__ ? TILE_REACH : 0;

/**
 * How far inside the edge anything the player builds is kept.
 *
 * Not zero, because a road is WIDE: a centreline exactly on the rim puts half
 * a carriageway, its footway and its casing out over the void. The widest road
 * in the game is under 30 units of casing half-width, and a junction between
 * two of them reaches further still, so this is that with room to spare.
 *
 * Zero on the planet: a face's border is no rim, the neighbour's ground goes on.
 */
export const MAP_MARGIN = __PLANET__ ? 0 : m(25.6);

/** Whether a point is on the world at all (on the flat map, inside the flat Earth's plates). */
export const insideMap = (p: Vec2, margin = 0): boolean =>
  // A sphere has no edge: every point of the planet is on the map.
  __PLANET__
    ? true
    : p.x >= FLAT_WORLD.minX + margin &&
      p.x <= FLAT_WORLD.maxX - margin &&
      p.y >= FLAT_WORLD.minY + margin &&
      p.y <= FLAT_WORLD.maxY - margin;

/**
 * The nearest point on the plate to `p`.
 *
 * Clamping rather than refusing, and deliberately: a drag that runs off the
 * edge should build a road up to the edge, which is what the player was
 * plainly asking for. Refusing it would make the last stretch of a drag do
 * nothing, with no explanation.
 */
export const clampToMap = (p: Vec2, margin = MAP_MARGIN): Vec2 =>
  // A sphere has no edge: a point is written on whatever chart the edit is
  // worked out on (`world/planet/charts.ts`), past its piece too.
  __PLANET__
    ? p
    : {
        x: clamp(p.x, FLAT_WORLD.minX + margin, FLAT_WORLD.maxX - margin),
        y: clamp(p.y, FLAT_WORLD.minY + margin, FLAT_WORLD.maxY - margin),
      };
