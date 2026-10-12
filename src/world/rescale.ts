import { FACE_HALF, PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { TILES, TILE_HALF, sphereToTileInto, tileOfDirection, tileToSphereInto } from '@core/planetTiles';
import { ATLAS_COLUMNS, ATLAS_ROWS, atlasToTileInto, tileToAtlas, type TileLocal } from './planet/atlas';
import type { SerializedDoc } from './doc';
import { METERS_PER_UNIT } from './units';

/**
 * A map saved under another world unit, brought to this build's
 * (docs/ESCALA.md). Until 2026-10-10 a world unit was 0.4 m and no map said
 * so: a document without `unit` is a 0.4 m map.
 *
 * Every length is multiplied by `factor` (old metres per unit over the new):
 * positions, widths, heights, radii, a building's every measure. Angles,
 * counts, ids, shares (0..1), times and money are left alone.
 *
 * Positions on the flat map scale about the origin, the map's centre. On the
 * planet a position is an address in the atlas (a piece's centre plus a point
 * of its map, `planet/atlas.ts`): pieces keep their size in units while the
 * town shrinks in units, so the town is shrunk about ONE point of the sphere
 * (the middle of its roads, on the map of the piece holding it, an azimuthal
 * equidistant chart, `core/planetTiles.ts`) and every point is written back
 * on the piece that then owns it. Scaling each point about its own piece's
 * centre would tear every road crossing a border in two.
 */

/** The unit every map saved before the field existed was made in. */
export const LEGACY_METERS_PER_UNIT = 0.4;

/** What a stored length is worth in this build's units, for a map saved with `unit`. */
export const unitFactor = (unit: unknown): number =>
  (typeof unit === 'number' && Number.isFinite(unit) && unit > 0 ? unit : LEGACY_METERS_PER_UNIT) / METERS_PER_UNIT;

type Loose = Record<string, unknown>;
const isRecord = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Positions of the map: the transform a document's points go through. */
export type PlaceFn = (x: number, y: number) => { x: number; y: number };

/** A copy of `record` with the named fields times `factor` (those that are numbers). */
function lengths<T>(record: T, factor: number, keys: readonly string[]): T {
  if (!isRecord(record)) return record;
  const out: Loose = { ...record };
  for (const key of keys) if (finite(out[key])) out[key] = (out[key] as number) * factor;
  return out as T;
}

/** A copy of `record` with its `x`/`y` (or the named pair) moved by `place`. */
function placed<T>(record: T, place: PlaceFn, xKey = 'x', yKey = 'y'): T {
  if (!isRecord(record) || !finite(record[xKey]) || !finite(record[yKey])) return record;
  const p = place(record[xKey] as number, record[yKey] as number);
  return { ...record, [xKey]: p.x, [yKey]: p.y } as T;
}

const list = <T>(v: readonly T[] | undefined, f: (item: T) => T): T[] | undefined => (Array.isArray(v) ? v.map(f) : undefined);

/** A stored building (any schema) in the new unit: its place moved, its measures scaled. */
export function rescaleBuilding(raw: unknown, factor: number, place: PlaceFn | null): unknown {
  if (!isRecord(raw)) return raw;
  const b: Loose = place ? placed(raw, place) : { ...raw };
  for (const key of ['module', 'groundHeight', 'storeyHeight']) if (finite(b[key])) b[key] = (b[key] as number) * factor;
  if (Array.isArray(b.levels)) b.levels = b.levels.map((v) => (finite(v) ? v * factor : v));
  // Schema 1 measured its plan in cells of `module`: scaling the module scales it.
  const inUnits = finite(b.schema) && b.schema >= 2;
  const plan = inUnits ? factor : 1;
  if (Array.isArray(b.volumes)) {
    b.volumes = b.volumes.map((raw) => {
      if (!isRecord(raw)) return raw;
      const v = lengths(raw, plan, ['x', 'y', 'w', 'd']);
      // Terrace and lift are heights in world units in every schema that has them.
      for (const key of ['terrace', 'lift', 'ramp']) if (finite(v[key])) v[key] = (v[key] as number) * factor;
      if (Array.isArray(v.outline)) v.outline = v.outline.map((p) => lengths(p, plan, ['x', 'y']));
      if (Array.isArray(v.roofDetails)) v.roofDetails = v.roofDetails.map((d) => lengths(d, factor, ['x', 'y', 'w', 'd', 'h']));
      if (Array.isArray(v.reliefs)) v.reliefs = v.reliefs.map((r) => lengths(r, factor, ['depth']));
      if (isRecord(v.facadeGeometry)) {
        const g: Loose = {};
        for (const [face, value] of Object.entries(v.facadeGeometry)) g[face] = lengths(value, factor, ['sill', 'pierWidth', 'pierDepth']);
        v.facadeGeometry = g;
      }
      if (Array.isArray(v.storeys)) {
        v.storeys = v.storeys.map((s) => (isRecord(s) && Array.isArray(s.spaces)
          ? { ...s, spaces: s.spaces.map((space) => lengths(space, plan, ['x', 'y', 'w', 'd'])) } : s));
      }
      return v;
    });
  }
  if (Array.isArray(b.elements)) b.elements = b.elements.map((e) => lengths(e, factor, ['x', 'y', 'w', 'd', 'z', 'h']));
  if (Array.isArray(b.cores)) b.cores = b.cores.map((c) => lengths(c, plan, ['x', 'y']));
  if (isRecord(b.furnishing)) {
    const f: Loose = {};
    for (const [level, items] of Object.entries(b.furnishing)) f[level] = Array.isArray(items) ? items.map((it) => lengths(it, factor, ['x', 'y'])) : items;
    b.furnishing = f;
  }
  return b;
}

const sphere: Vec3 = { x: 0, y: 0, z: 0 };
const local: TileLocal = { tile: 0, x: 0, y: 0 };
const chart = { x: 0, y: 0 };

/**
 * The planet's transform: about the middle of `anchors` (atlas points), on
 * the map of the piece that holds it, then back into the atlas.
 */
function planetPlace(anchors: readonly { x: number; y: number }[], factor: number): PlaceFn {
  // The middle: the mean direction of the anchors on the sphere.
  let sx = 0, sy = 0, sz = 0;
  for (const p of anchors) {
    atlasToTileInto(p.x, p.y, local);
    tileToSphereInto(local.tile, local.x, local.y, sphere);
    sx += sphere.x; sy += sphere.y; sz += sphere.z;
  }
  const home = tileOfDirection({ x: sx, y: sy, z: sz });
  // The middle on that piece's map: the mean of the anchors there.
  let ax = 0, ay = 0;
  for (const p of anchors) {
    atlasToTileInto(p.x, p.y, local);
    tileToSphereInto(local.tile, local.x, local.y, sphere);
    sphereToTileInto(home, sphere, chart);
    ax += chart.x; ay += chart.y;
  }
  ax /= anchors.length; ay /= anchors.length;
  return (x, y) => {
    atlasToTileInto(x, y, local);
    tileToSphereInto(local.tile, local.x, local.y, sphere);
    sphereToTileInto(home, sphere, chart);
    tileToSphereInto(home, ax + (chart.x - ax) * factor, ay + (chart.y - ay) * factor, sphere);
    const owner = tileOfDirection(sphere);
    sphereToTileInto(owner, sphere, chart);
    return tileToAtlas(owner, chart.x, chart.y);
  };
}

/**
 * The planet's size every map was made on before the field existed: faces of
 * 3 000 units (the planet grew 2.5x on 2026-10-10, to faces of 6 km).
 */
export const LEGACY_PLANET_HALF = 3000;

/**
 * An atlas point of a planet of another size (`half`: its FACE_HALF) saved
 * at another unit (`unit`, metres a unit) as a sphere direction, into `out`.
 * The pieces are the same angles of the sphere whatever its size
 * (`core/planetTiles.ts`, equiangular), so only their maps' scale and the
 * atlas's spacing change with it: `planet/atlas.ts` ATLAS_PITCH, from the
 * widest piece and its reach, in THAT build's units (a reach of 120 m on a
 * grid of 160 m with 80 m to spare - 300, 400 and 200 at 0.4 m a unit, as
 * every build before the switch had them).
 */
function oldAtlasToSphereInto(half: number, unit: number, x: number, y: number, out: Vec3): Vec3 {
  const k = half / FACE_HALF;
  const grid = 160 / unit;
  const pitch = Math.ceil((2 * (TILE_HALF * k + 120 / unit) + 80 / unit) / grid) * grid;
  const col = Math.min(ATLAS_COLUMNS - 1, Math.max(0, Math.round(x / pitch) + ATLAS_COLUMNS / 2));
  const row = Math.min(ATLAS_ROWS - 1, Math.max(0, Math.round(y / pitch) + ATLAS_ROWS / 2));
  const tile = row * ATLAS_COLUMNS + col;
  const lx = x - (col - ATLAS_COLUMNS / 2) * pitch, ly = y - (row - ATLAS_ROWS / 2) * pitch;
  // The piece's own map at that planet's radius (`tileToSphereInto` at another R).
  const t = TILES[tile]!, r = Math.hypot(lx, ly);
  if (r < 1e-9) { out.x = t.centre.x; out.y = t.centre.y; out.z = t.centre.z; return out; }
  const theta = r / (PLANET_RADIUS * k), c = Math.cos(theta), sn = Math.sin(theta) / r;
  out.x = c * t.centre.x + sn * (lx * t.east.x + ly * t.north.x);
  out.y = c * t.centre.y + sn * (lx * t.east.y + ly * t.north.y);
  out.z = c * t.centre.z + sn * (lx * t.east.z + ly * t.north.z);
  return out;
}

/**
 * The transform of a map made on a planet of another size (`half`), its town
 * kept the same size: about the middle of its anchors, each point's offset
 * from it measured on the middle's piece's map at the old radius and laid at
 * the same offset (times `factor`) on that map at the new one.
 */
function resizedPlanetPlace(anchors: readonly { x: number; y: number }[], half: number, unit: number, factor: number): PlaceFn {
  const k = half / FACE_HALF;
  let sx = 0, sy = 0, sz = 0;
  for (const p of anchors) {
    oldAtlasToSphereInto(half, unit, p.x, p.y, sphere);
    sx += sphere.x; sy += sphere.y; sz += sphere.z;
  }
  const home = tileOfDirection({ x: sx, y: sy, z: sz });
  // A direction on `home`'s map at the old radius (the map scales with it).
  const oldChart = (d: Vec3): { x: number; y: number } => {
    sphereToTileInto(home, d, chart);
    return { x: chart.x * k, y: chart.y * k };
  };
  let ax = 0, ay = 0;
  for (const p of anchors) {
    const c = oldChart(oldAtlasToSphereInto(half, unit, p.x, p.y, sphere));
    ax += c.x; ay += c.y;
  }
  ax /= anchors.length; ay /= anchors.length;
  // The middle's place on the new planet: the same direction (the mean of
  // the points on the old map, not the map of their mean direction - on a
  // planet a few km round the two differed by 10 cm), on the new map, whose
  // scale is the old one's over k. With the planet the same size in metres
  // every point then lands exactly where it was.
  const mx = ax / k, my = ay / k;
  return (x, y) => {
    const c = oldChart(oldAtlasToSphereInto(half, unit, x, y, sphere));
    tileToSphereInto(home, mx + (c.x - ax) * factor, my + (c.y - ay) * factor, sphere);
    const owner = tileOfDirection(sphere);
    sphereToTileInto(owner, sphere, chart);
    return tileToAtlas(owner, chart.x, chart.y);
  };
}

/**
 * A point of the atlas a planet of faces `half` units saved at `unit` metres
 * a unit, in this build's atlas: the same direction of the sphere, on the
 * piece that owns it now. What a saved camera looks at goes through this; a
 * map's points go through `resizedPlanetPlace`, which also keeps its town's
 * size when the planet's changed.
 */
export function planetPointInUnit(x: number, y: number, half: number, unit: number): { x: number; y: number } {
  oldAtlasToSphereInto(half, unit, x, y, sphere);
  const owner = tileOfDirection(sphere);
  sphereToTileInto(owner, sphere, chart);
  return tileToAtlas(owner, chart.x, chart.y);
}

/** The size of the planet a saved map was made on (`planetHalf`; none: the first one). */
export const savedPlanetHalf = (data: unknown): number => {
  const said = isRecord(data) ? data.planetHalf : undefined;
  return finite(said) && said > 0 ? said : LEGACY_PLANET_HALF;
};

/** The positions' transform for a map in the new unit: flat about the origin, the planet about its town. */
export function placeFor(anchors: readonly { x: number; y: number }[], factor: number): PlaceFn {
  if (!__PLANET__ || anchors.length === 0) return (x, y) => ({ x: x * factor, y: y * factor });
  return planetPlace(anchors, factor);
}

/** Every point a document has that can stand for where its town is. */
function anchorsOf(data: SerializedDoc): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const n of data.nodes ?? []) if (finite(n.x) && finite(n.y)) out.push(n);
  if (out.length === 0) for (const b of (data.buildings ?? []) as unknown[]) if (isRecord(b) && finite(b.x) && finite(b.y)) out.push(b as { x: number; y: number });
  if (out.length === 0) for (const s of data.terrain ?? []) if (finite(s.x) && finite(s.y)) out.push(s);
  return out;
}

/**
 * A serialized document in this build's unit. Returns `data` itself when it
 * already is; otherwise a copy, every length scaled (see the file's comment).
 */
export function rescaleSerializedDoc(data: SerializedDoc): SerializedDoc {
  const factor = unitFactor((data as { unit?: unknown }).unit);
  // On the planet: the size of the planet it was made on (none: the first, `LEGACY_PLANET_HALF`).
  const half = __PLANET__ ? savedPlanetHalf(data) : FACE_HALF;
  const resized = __PLANET__ && Math.abs(half - FACE_HALF) > 1e-6;
  if (factor === 1 && !resized) return data;
  const anchors = anchorsOf(data);
  // On the planet the atlas it was saved in is read with that build's own
  // measures (its unit and its planet), whatever changed.
  const oldUnit = METERS_PER_UNIT * factor;
  const place = __PLANET__ && anchors.length ? resizedPlanetPlace(anchors, half, oldUnit, factor) : placeFor(anchors, factor);
  const at = <T>(r: T): T => placed(r, place);
  const scale = <T>(keys: readonly string[]) => (r: T): T => lengths(at(r), factor, keys);
  const out: Loose = { ...data, unit: METERS_PER_UNIT, ...(__PLANET__ ? { planetHalf: FACE_HALF } : {}) };
  out.nodes = data.nodes.map((n) => lengths(at(n), factor, ['heightOffset']));
  out.segments = data.segments.map((s) => {
    const seg: Loose = { ...s };
    if (isRecord(s.curve)) seg.curve = lengths(s.curve, factor, ['h']);
    if (finite(s.dashOrigin)) seg.dashOrigin = s.dashOrigin * factor;
    if (isRecord(s.section)) seg.section = lengths(s.section, factor, ['laneWidth', 'sidewalk', 'sidewalkLeft', 'sidewalkRight', 'median']);
    return seg;
  });
  out.terrain = list(data.terrain, (stamp) => {
    // A stamp's strength is a height (raise, lower, river); a flatten's is a rate, read against a height too (`terrain.ts`).
    // Its noise's origin (`ox`, `oy`) is a place of the map, moved as the stamp is.
    return lengths(placed(at(stamp), place, 'ox', 'oy'), factor, ['radius', 'strength', 'level']);
  });
  out.paint = list(data.paint, scale(['radius']));
  if (isRecord(data.fog)) {
    out.fog = { ...data.fog, dabs: list((data.fog as { dabs?: unknown[] }).dabs, scale(['radius', 'height', 'speed'])) };
  }
  if (isRecord(data.gullies)) {
    out.gullies = { ...data.gullies, dabs: list((data.gullies as { dabs?: unknown[] }).dabs, scale(['radius'])) };
  }
  out.clouds = list(data.clouds, scale(['height', 'size']));
  out.elements = list(data.elements, scale(['size']));
  out.trees = list(data.trees, scale(['height']));
  out.treeClearings = list(data.treeClearings, scale(['radius']));
  out.poles = list(data.poles, at);
  out.landscape = list(data.landscape, at);
  out.barriers = list(data.barriers, (b) => (isRecord(b) && Array.isArray(b.points) ? { ...b, points: b.points.map(at) } : b));
  out.buildings = list(data.buildings as unknown[] | undefined, (b) => rescaleBuilding(b, factor, place)) as SerializedDoc['buildings'];
  out.zones = list(data.zones, (z) => {
    if (!isRecord(z) || ![z.x0, z.y0, z.x1, z.y1].every(finite)) return z;
    const a = place(z.x0 as number, z.y0 as number), b = place(z.x1 as number, z.y1 as number);
    return { ...z, x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  });
  out.zoneMarks = list(data.zoneMarks, at);
  out.lots = list(data.lots, (lot) => (isRecord(lot) && Array.isArray(lot.corners) ? { ...lot, corners: lot.corners.map(at) } : lot));
  if (isRecord(data.transit)) {
    const t = data.transit as Loose;
    out.transit = {
      ...t,
      stops: list(t.stops as unknown[] | undefined, (s) => {
        const stop = at(s);
        return isRecord(stop) && isRecord(stop.entrance) ? { ...stop, entrance: at(stop.entrance) } : stop;
      }),
      tracks: list(t.tracks as unknown[] | undefined, (k) => (isRecord(k) && Array.isArray(k.points) ? { ...k, points: k.points.map(at) } : k)),
    };
  }
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out as unknown as SerializedDoc;
}
