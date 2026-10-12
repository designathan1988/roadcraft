import { PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { TILES } from '@core/planetTiles';
import { earthHeight, HOME_TILE } from './planet/relief';
import { iceTopAt } from './planet/ice';
import { SEA_LEVEL } from './planet/seaLevel';
import { m } from './units';
import { RELIEF_EARTH, TerrainIndex, sampleTerrainHeight, type ReliefVersion } from './terrain';

/**
 * THE WHOLE EARTH ON THE FLAT MAP (docs/MAPA-PLANO-COMPLETO.md; the player,
 * 2026-10-11: "no modo plano tem que ter o mapa completo do mesmo tamanho que
 * é no globo"): the planet's land - continents, ocean, the ice on them - laid
 * on one plane in the EQUIRECTANGULAR projection, the plain world map: x east
 * the longitude, y north the latitude, both at the planet's radius, so the
 * equator is as long as on the globe (2 pi R, about 24 km) and the map half as
 * tall (pi R, 12 km), east and west meeting. Each point of the plane is a
 * direction on the sphere, read by the planet's own field (`planet/relief.ts`
 * `earthHeight`, `planet/ice.ts` `iceTopAt`): the same hill at the same place
 * in both modes. The poles are stretched into bands, as on every flat world map.
 *
 * The plane's origin is the place the planet's own town stands (`HOME_TILE`'s
 * centre): a flat map of the old size opens there.
 */

/** The sphere's radius the plane is measured at: the planet's (`core/cubeSphere.ts`). */
export const FLAT_EARTH_RADIUS = PLANET_RADIUS;
/** The plane's extent east-west (a whole turn of longitude) and north-south (pole to pole). */
export const FLAT_EARTH_WIDTH = 2 * Math.PI * FLAT_EARTH_RADIUS;
export const FLAT_EARTH_HEIGHT = Math.PI * FLAT_EARTH_RADIUS;

const home = TILES[HOME_TILE]!.centre;
/** The origin's longitude and latitude: the planet's town. */
export const FLAT_EARTH_ORIGIN = Object.freeze({ lon: Math.atan2(home.y, home.x), lat: Math.asin(Math.max(-1, Math.min(1, home.z))) });

/** The latitude of a point of the plane, held to the poles (radians). */
export function flatLatitude(y: number): number {
  return Math.max(-Math.PI / 2, Math.min(Math.PI / 2, FLAT_EARTH_ORIGIN.lat + y / FLAT_EARTH_RADIUS));
}

/** The sphere's unit direction under a point of the plane (x east, y north), into `out`. */
export function flatToSphereInto(x: number, y: number, out: Vec3): Vec3 {
  const lon = FLAT_EARTH_ORIGIN.lon + x / FLAT_EARTH_RADIUS;
  const lat = flatLatitude(y);
  const c = Math.cos(lat);
  out.x = c * Math.cos(lon);
  out.y = c * Math.sin(lon);
  out.z = Math.sin(lat);
  return out;
}

/** The point of the plane over a unit direction of the sphere (the longitude taken nearest the origin), into `out`. */
export function sphereToFlatInto(d: Readonly<Vec3>, out: { x: number; y: number }): { x: number; y: number } {
  let dLon = Math.atan2(d.y, d.x) - FLAT_EARTH_ORIGIN.lon;
  dLon -= 2 * Math.PI * Math.round(dLon / (2 * Math.PI));
  out.x = dLon * FLAT_EARTH_RADIUS;
  out.y = (Math.asin(Math.max(-1, Math.min(1, d.z))) - FLAT_EARTH_ORIGIN.lat) * FLAT_EARTH_RADIUS;
  return out;
}

const s: Vec3 = { x: 0, y: 0, z: 0 };

/** The Earth's ground at a point of the plane: the land, the ice standing on it - as the planet draws it there. */
export function flatEarthGround(x: number, y: number): number {
  flatToSphereInto(x, y, s);
  return iceTopAt(earthHeight(s.x, s.y, s.z), s.x, s.y, s.z);
}

/**
 * THE PLATES OF THE FLAT EARTH: the plane laid in squares of the old flat
 * map's own plate (1.92 km), centred on whole multiples of it from the origin
 * - the old map is the plate at the origin, its roads where they were - over
 * the whole Earth, pole to pole and round. Each is a region of the world
 * (`bounds.ts` MAP_REGIONS) and a plate of ground (`render/flatAtlas.ts`).
 */
export const FLAT_PLATE = m(1_920);
const SOUTH = (-Math.PI / 2 - FLAT_EARTH_ORIGIN.lat) * FLAT_EARTH_RADIUS;
const NORTH = (Math.PI / 2 - FLAT_EARTH_ORIGIN.lat) * FLAT_EARTH_RADIUS;
const KX0 = Math.floor(-FLAT_EARTH_WIDTH / 2 / FLAT_PLATE + 0.5);
const KX1 = Math.ceil(FLAT_EARTH_WIDTH / 2 / FLAT_PLATE - 0.5);
const KY0 = Math.floor(SOUTH / FLAT_PLATE + 0.5);
const KY1 = Math.ceil(NORTH / FLAT_PLATE - 0.5);
export const FLAT_COLUMNS = KX1 - KX0 + 1;
export const FLAT_ROWS = KY1 - KY0 + 1;
export const FLAT_PLATES = FLAT_COLUMNS * FLAT_ROWS;
/** The world's extent, plate edge to plate edge. */
export const FLAT_WORLD = Object.freeze({
  minX: (KX0 - 0.5) * FLAT_PLATE, maxX: (KX1 + 0.5) * FLAT_PLATE,
  minY: (KY0 - 0.5) * FLAT_PLATE, maxY: (KY1 + 0.5) * FLAT_PLATE,
});
/** Which plate a point is on, held to the grid. */
export function flatPlateOf(x: number, y: number): number {
  const kx = Math.min(KX1, Math.max(KX0, Math.round(x / FLAT_PLATE)));
  const ky = Math.min(KY1, Math.max(KY0, Math.round(y / FLAT_PLATE)));
  return (ky - KY0) * FLAT_COLUMNS + (kx - KX0);
}
/** A plate's centre. */
export function flatPlateCentre(index: number): { x: number; y: number } {
  return { x: (KX0 + (index % FLAT_COLUMNS)) * FLAT_PLATE, y: (KY0 + Math.floor(index / FLAT_COLUMNS)) * FLAT_PLATE };
}

/** How far past the old map's plate its own relief gives way to the Earth's. */
export const FLAT_BLEND = m(480);

/**
 * The land of a map's relief anywhere on the whole flat Earth, world
 * coordinates. A map made on the Earth (`RELIEF_EARTH`) has the Earth's
 * everywhere. A map made before (a plain, the old fields) keeps its own land
 * on its own plate - its roads stand where they stood - and the Earth's beyond
 * it, the two eased together over `FLAT_BLEND` past the plate's edge
 * (docs/MAPA-PLANO-COMPLETO.md: an old map opens as a region of the world).
 */
export function flatGroundFor(relief: ReliefVersion): (x: number, y: number) => number {
  if (relief === RELIEF_EARTH) return flatEarthGround;
  const index = new TerrainIndex([], 0, relief);
  const half = FLAT_PLATE / 2;
  return (x, y) => {
    const out = Math.max(Math.abs(x), Math.abs(y)) - half;
    if (out <= 0) return sampleTerrainHeight(index, x, y);
    if (out >= FLAT_BLEND) return flatEarthGround(x, y);
    const t = out / FLAT_BLEND, w = t * t * (3 - 2 * t);
    return (1 - w) * sampleTerrainHeight(index, x, y) + w * flatEarthGround(x, y);
  };
}

/** How high over the sea a road's ground is held: a causeway's crest above the waves. */
export const ROAD_SEA_FREEBOARD = m(1.5);
/** Over this much water the sea holds a road up wholly. */
const HOLD_DEPTH = m(1);
/** Round an old map's plate, how far out the sea's hold eases in (its own valleys keep their roads). */
const HOLD_EDGE = m(40);
const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * The floor the sea sets a road's ground at over `land` (its height, world
 * units): the sea's level at the shoreline, rising to `ROAD_SEA_FREEBOARD`
 * over it within `HOLD_DEPTH` of water; the sea's level on land (which
 * `seaRoadGround` never lowers to). Continuous in the land.
 */
export const seaFloorOver = (land: number): number => SEA_LEVEL + ROAD_SEA_FREEBOARD * smooth((SEA_LEVEL - land) / HOLD_DEPTH);

/**
 * The ground a road is solved on over `land` with the sea's hold `hold`
 * (0..1): never under the sea's surface where it holds (a road at grade over
 * the sea is a causeway, the ground filled up to it; a bridge a bridge).
 */
export const seaRoadGround = (land: number, hold: number): number => {
  const floor = seaFloorOver(land);
  return floor > land && hold > 0 ? land + (floor - land) * hold : land;
};

/**
 * How much the sea holds a road up at a point (0..1) over `land`: on the
 * Earth's land, wholly. Round an old map: none on its plate (its own valleys
 * keep their roads), easing in over `HOLD_EDGE` past its edge, and there
 * wholly over the sea (`FLAT_SHORE` deep and more) and as the land
 * eases into the Earth's elsewhere - every factor continuous, so the ground
 * a road is solved on has no step anywhere.
 */
export function flatSeaHold(relief: ReliefVersion): (x: number, y: number, land: number) => number {
  if (relief === RELIEF_EARTH) return () => 1;
  const half = FLAT_PLATE / 2;
  return (x, y, land) => {
    const out = Math.max(Math.abs(x), Math.abs(y)) - half;
    if (out <= 0) return 0;
    // Wholly where the sea is drawn (`flatSeaFor`: `FLAT_SHORE` deep), from nothing at the waterline.
    const water = smooth((SEA_LEVEL - land) / FLAT_SHORE);
    return smooth(out / HOLD_EDGE) * Math.max(smooth(out / FLAT_BLEND), water);
  };
}

/** How far under sea level an old map's eased land must lie to be sea: its coast a contour of the land, not a hair's dip. */
export const FLAT_SHORE = m(0.3);

/**
 * Where the sea may stand on the whole flat Earth for a map's relief. On the
 * Earth's land, wherever it lies under sea level. Round an old map, past its
 * own plate (its own land dips under zero in valleys that never held the
 * sea) where the land - the old map's eased into the Earth's - lies
 * `FLAT_SHORE` under the sea: the coast is a contour of the land drawn, so it
 * never follows the plate's edge. An old plain stands at the sea's own level;
 * with the sea set by the Earth's land alone, or by a hair's dip, the band
 * round the plate read as sea bed - bare soil, a wash of foam - in the
 * plate's square (the player, 2026-10-11).
 */
export function flatSeaFor(relief: ReliefVersion): (x: number, y: number) => boolean {
  const over = flatSeaOver(relief), land = flatGroundFor(relief);
  return (x, y) => over(x, y, land(x, y));
}

/** `flatSeaFor` with the land's height there given (read already: a plate's corners), not worked out again. */
export function flatSeaOver(relief: ReliefVersion): (x: number, y: number, land: number) => boolean {
  if (relief === RELIEF_EARTH) return () => true;
  const half = FLAT_PLATE / 2;
  return (x, y, land) => Math.max(Math.abs(x), Math.abs(y)) > half && land < SEA_LEVEL - FLAT_SHORE;
}
