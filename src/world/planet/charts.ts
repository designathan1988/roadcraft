import { FACE_HALF, PLANET_RADIUS, faceToSphereInto, type FacePoint, type Vec3 } from '@core/cubeSphere';
import { TILES, TILES_PER_SIDE, TILE_COUNT, onTile, sphereToTileInto, tileOfDirection, tileToSphereInto } from '@core/planetTiles';
import type { Vec2 } from '@core/vec2';
import { TILE_REACH, atlasToTileInto, tileCellOf, tileCentre, type TileLocal } from './atlas';

/**
 * THE PLANET'S CHARTS AND THEIR TRANSITION MAPS.
 *
 * A point of the world is a point of the sphere, written in the coordinates
 * of the piece that owns it (`atlas.ts`). Anything worked out from several
 * points - a road between two nodes, a junction and its legs, a gesture - is
 * worked out on ONE chart: the points are carried onto it through the sphere
 * (a chart's transition map, exact), whatever piece they are written on, and
 * the result is written on that chart. A chart's map goes on past its piece's
 * border, so a road or a junction is never cut.
 *
 * What is written on a chart must stay inside its cell of the atlas (within
 * half `ATLAS_PITCH` of its centre): the picture finds a vertex's chart by the
 * cell it lies in (`render/planet/bend.ts`).
 *
 * On the flat map there is one chart and every map is the identity.
 */

const local: TileLocal = { tile: 0, x: 0, y: 0 };

/**
 * Whether an edit is being worked out on one chart (`editor/planetFrame.ts`):
 * every point of its working copy is then written on that chart, past its
 * cell too, and the maps below are the identity - one plane, as the flat map.
 */
let oneChart = false;

/** Runs `work` with every point on one chart (the maps below the identity). */
export function onOneChart<T>(work: () => T): T {
  const was = oneChart;
  oneChart = true;
  try {
    return work();
  } finally {
    oneChart = was;
  }
}

/** Whether the maps are the identity: the flat map, or an edit on one chart. */
const identity = (): boolean => !__PLANET__ || oneChart;
const s3: Vec3 = { x: 0, y: 0, z: 0 };
const fp: FacePoint = { x: 0, y: 0 };

/** The chart an atlas point is written on: its cell's piece (0 on the flat map). */
export const chartAt = (x: number, y: number): number => (identity() ? 0 : tileCellOf(x, y));

/** The sphere direction of an atlas point (written on its cell's chart), into `out`. */
export function atlasToSphereInto(x: number, y: number, out: Vec3): Vec3 {
  atlasToTileInto(x, y, local);
  return tileToSphereInto(local.tile, local.x, local.y, out);
}

/**
 * THE PLANET'S GRID: one grid for the whole sphere, with no edge and no
 * corner anywhere - the azimuthal equidistant map about one fixed point of
 * the planet, the start of the map (`GRID_ORIGIN`, the piece at the atlas's
 * origin; Snyder, "Map Projections - A Working Manual", USGS PP 1395, pp.
 * 191-202, as every piece's own map is). Its lines are smooth curves over
 * the whole sphere: true to the metre along the way from the origin, a cell
 * stretched across it only by (d/R)/sin(d/R) far away (5% at 2 km). A grid
 * per cube face (the faces' equiangular metres) bent at every cube edge and
 * met three ways at the corners (the player, 2026-10-10: "o grid tem que
 * ficar contínuo"); no square grid covers a sphere without such seams or a
 * singular point, and this one's single point is the far side of the planet.
 */
export const GRID_ORIGIN = tileCellOf(0, 0);

/**
 * THE GRID'S ORIGIN WHERE THE PLAYER BUILDS. One grid for the whole sphere is
 * true near its origin only: a quarter of the way round its two directions
 * met at 80 degrees and turned 1.5 degrees in 70 m, and three roads drawn
 * side by side snapped to 141, 144 and 147 degrees (the player, 2026-10-10:
 * "a mesma via traçada com o mesmo ângulo tem ângulos diferentes"). As
 * Medieval Engineers builds on its planets (a local coordinate system where
 * a construction starts, its neighbours snapped to the nearest one), the
 * grid's origin is the place the building in view started (`setGridOrigin`,
 * `main.ts` from the map's own list): straight and square over a town. Its
 * centre, east and north (unit vectors of the planet's frame).
 */
const gridC: Vec3 = { x: 0, y: 0, z: 1 };
const gridE: Vec3 = { x: 1, y: 0, z: 0 };
const gridN: Vec3 = { x: 0, y: 1, z: 0 };
const gridListeners = new Set<() => void>();
{
  const t = TILES[GRID_ORIGIN]!;
  Object.assign(gridC, t.centre); Object.assign(gridE, t.east); Object.assign(gridN, t.north);
}
/** Puts the grid's origin at an atlas point, its north the planet's (the pole's way laid level there). */
export function setGridOrigin(x: number, y: number): void {
  const c: Vec3 = { x: 0, y: 0, z: 0 };
  atlasToSphereInto(x, y, c);
  // North: the pole (the planet frame's z) laid level; at a pole, the piece's own north.
  let nx = -c.z * c.x, ny = -c.z * c.y, nz = 1 - c.z * c.z;
  let l = Math.hypot(nx, ny, nz);
  if (l < 1e-6) { const t = TILES[tileCellOf(x, y)]!; nx = t.north.x; ny = t.north.y; nz = t.north.z; l = Math.hypot(nx, ny, nz); }
  nx /= l; ny /= l; nz /= l;
  if (Math.abs(gridC.x - c.x) + Math.abs(gridC.y - c.y) + Math.abs(gridC.z - c.z) < 1e-12) return;
  gridC.x = c.x; gridC.y = c.y; gridC.z = c.z;
  gridN.x = nx; gridN.y = ny; gridN.z = nz;
  // East = north x up.
  gridE.x = ny * c.z - nz * c.y; gridE.y = nz * c.x - nx * c.z; gridE.z = nx * c.y - ny * c.x;
  for (const listener of gridListeners) listener();
}
/** The grid's origin (centre, east, north; the planet's frame), and a call when it moves. */
export function gridOrigin(): { readonly c: Readonly<Vec3>; readonly e: Readonly<Vec3>; readonly n: Readonly<Vec3> } {
  return { c: gridC, e: gridE, n: gridN };
}
export function onGridOrigin(listener: () => void): () => void {
  gridListeners.add(listener);
  return () => gridListeners.delete(listener);
}
/** A unit sphere direction on the grid's map (azimuthal equidistant about its origin, world units), into `out`. */
function sphereToGridInto(d: Readonly<Vec3>, out: FacePoint): FacePoint {
  const ex = d.x * gridE.x + d.y * gridE.y + d.z * gridE.z;
  const ny = d.x * gridN.x + d.y * gridN.y + d.z * gridN.z;
  const across = Math.hypot(ex, ny);
  const arc = Math.atan2(across, d.x * gridC.x + d.y * gridC.y + d.z * gridC.z);
  const k = across > 1e-12 ? (arc * PLANET_RADIUS) / across : PLANET_RADIUS;
  out.x = ex * k; out.y = ny * k;
  return out;
}
/** A point of the grid's map back to its unit sphere direction, into `out`. */
function gridToSphereInto(x: number, y: number, out: Vec3): Vec3 {
  const d = Math.hypot(x, y);
  if (d < 1e-9) { out.x = gridC.x; out.y = gridC.y; out.z = gridC.z; return out; }
  const th = d / PLANET_RADIUS, c = Math.cos(th), s = Math.sin(th) / d;
  out.x = gridC.x * c + (gridE.x * x + gridN.x * y) * s;
  out.y = gridC.y * c + (gridE.y * x + gridN.y * y) * s;
  out.z = gridC.z * c + (gridE.z * x + gridN.z * y) * s;
  return out;
}

/**
 * The grid point nearest an atlas point, written on the same chart, into
 * `out` (the grid above, drawn by `render/terrain.ts` uGrid). `offset` moves
 * the points into the cells' middles. The flat map's grid on the flat map and
 * in an edit on one chart.
 */
export function snapToFaceGridInto(x: number, y: number, step: number, offset: number, out: FacePoint): FacePoint {
  if (identity()) {
    out.x = Math.round((x - offset) / step) * step + offset;
    out.y = Math.round((y - offset) / step) * step + offset;
    return out;
  }
  const chart = tileCellOf(x, y);
  atlasToSphereInto(x, y, s3);
  sphereToGridInto(s3, fp);
  const gx = Math.round((fp.x - offset) / step) * step + offset;
  const gy = Math.round((fp.y - offset) / step) * step + offset;
  gridToSphereInto(gx, gy, s3);
  return sphereToChartInto(chart, s3, out);
}

/**
 * The point `step` world units from an atlas point towards the planet's north
 * pole (the planet frame's z, the axis the sun turns round, `sun.ts`), along
 * the ground and written on the same chart, into `out`: what a compass
 * points at. Up the map (+y) on the flat map, and at a pole itself, where
 * every way is south.
 */
export function towardsNorthInto(x: number, y: number, step: number, out: FacePoint): FacePoint {
  if (identity()) { out.x = x; out.y = y + step; return out; }
  const chart = tileCellOf(x, y);
  atlasToSphereInto(x, y, s3);
  // The pole's direction laid on the ground there: z less its part along the up.
  const nx = -s3.z * s3.x, ny = -s3.z * s3.y, nz = 1 - s3.z * s3.z;
  const n = Math.hypot(nx, ny, nz);
  if (n < 1e-9) { out.x = x; out.y = y + step; return out; }
  const a = step / PLANET_RADIUS, c = Math.cos(a), s = Math.sin(a) / n;
  s3.x = s3.x * c + nx * s;
  s3.y = s3.y * c + ny * s;
  s3.z = s3.z * c + nz * s;
  return sphereToChartInto(chart, s3, out);
}

const gridAt: FacePoint = { x: 0, y: 0 };
/**
 * The heading, on the chart an atlas point is written on, of the grid's line
 * through it (`snapToFaceGridInto`): along the grid's x (`axis` 0) or its y
 * (1). A piece's map is turned against the grid away from the origin: a road
 * snapped to the map's own axes ran across the grid drawn under it. 0 and
 * pi/2 on the flat map.
 */
export function faceGridHeading(x: number, y: number, axis: 0 | 1): number {
  if (identity()) return axis === 0 ? 0 : Math.PI / 2;
  const chart = tileCellOf(x, y);
  atlasToSphereInto(x, y, s3);
  sphereToGridInto(s3, gridAt);
  gridToSphereInto(gridAt.x + (axis === 0 ? 1 : 0), gridAt.y + (axis === 1 ? 1 : 0), s3);
  sphereToChartInto(chart, s3, gridAt);
  return Math.atan2(gridAt.y - y, gridAt.x - x);
}

/** A sphere direction on `chart`'s map, as atlas coordinates, into `out`. */
export function sphereToChartInto(chart: number, d: Readonly<Vec3>, out: FacePoint): FacePoint {
  sphereToTileInto(chart, d, fp);
  const c = tileCentre(chart);
  out.x = c.x + fp.x;
  out.y = c.y + fp.y;
  return out;
}

/**
 * An atlas point (written on its cell's chart) on `chart`'s map, into `out`:
 * the same ground, in that chart's coordinates - past its piece's border too.
 */
export function inChartInto(chart: number, x: number, y: number, out: FacePoint): FacePoint {
  if (identity()) { out.x = x; out.y = y; return out; }
  atlasToTileInto(x, y, local);
  if (local.tile === chart) { out.x = x; out.y = y; return out; }
  tileToSphereInto(local.tile, local.x, local.y, s3);
  return sphereToChartInto(chart, s3, out);
}

/** `inChartInto`, allocating. */
export const inChart = (chart: number, p: Readonly<Vec2>): Vec2 => inChartInto(chart, p.x, p.y, { x: 0, y: 0 });

/**
 * A point carried onto the chart `ref` is written on, to be compared with
 * what is stored there: a query point (a pointer, a probe) against a shape
 * kept on its own piece's chart. Two points written on different charts are
 * tens of km apart in the atlas when they are neighbours on the sphere, so a
 * point-in-shape or a distance between them is meaningless until both are on
 * one chart. The point itself on the flat map, or when both share a chart.
 */
export function onChartOf(p: Readonly<Vec2>, ref: Readonly<Vec2>): Vec2 {
  if (identity()) return p as Vec2;
  const chart = tileCellOf(ref.x, ref.y);
  if (tileCellOf(p.x, p.y) === chart) return p as Vec2;
  return inChartInto(chart, p.x, p.y, { x: 0, y: 0 });
}

/**
 * A point of `chart`'s map (atlas coordinates about its centre, anywhere on
 * that map, past its cell too) written on the chart of the piece it lies on,
 * into `out`. The inverse of `inChartInto`.
 */
export function toOwnerInto(chart: number, x: number, y: number, out: FacePoint): FacePoint {
  if (!__PLANET__) { out.x = x; out.y = y; return out; }
  return ownerOfChartPointInto(chart, x, y, out);
}

/** `toOwnerInto` whatever chart an edit is worked out on: the sphere's own answer. */
export function ownerOfChartPointInto(chart: number, x: number, y: number, out: FacePoint): FacePoint {
  const c = tileCentre(chart);
  tileToSphereInto(chart, x - c.x, y - c.y, s3);
  return sphereToChartInto(tileOfDirection(s3), s3, out);
}

/**
 * A point of `chart`'s map written on the chart of the piece it lies on, as
 * it is to be kept - but as it is inside an edit worked out on one chart
 * (`onOneChart`), where every point stays on that chart until the edit is
 * left (`editor/planetFrame.ts` leaveFrame). The point itself on the flat map.
 */
export function onOwner(chart: number, p: Readonly<Vec2>): Vec2 {
  if (identity()) return { x: p.x, y: p.y };
  return toOwnerInto(chart, p.x, p.y, { x: 0, y: 0 });
}

/** `toOwnerInto`, allocating. */
export const toOwner = (chart: number, p: Readonly<Vec2>): Vec2 => toOwnerInto(chart, p.x, p.y, { x: 0, y: 0 });

const m3: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The chart a piece of geometry between two atlas points is worked out on:
 * the owner of the point of the sphere halfway between them (their
 * directions' mean). Both ends then lie within half the piece's length of
 * that chart's own piece.
 */
export function chartBetween(ax: number, ay: number, bx: number, by: number): number {
  if (identity()) return 0;
  atlasToSphereInto(ax, ay, m3);
  const mx = m3.x, my = m3.y, mz = m3.z;
  atlasToSphereInto(bx, by, m3);
  m3.x += mx; m3.y += my; m3.z += mz;
  return tileOfDirection(m3);
}

/** A point of chart `from`'s map (atlas coordinates, past its piece too) on chart `to`'s map, into `out`. */
export function chartToChartInto(from: number, to: number, x: number, y: number, out: FacePoint): FacePoint {
  if (identity() || from === to) { out.x = x; out.y = y; return out; }
  const c = tileCentre(from);
  tileToSphereInto(from, x - c.x, y - c.y, s3);
  return sphereToChartInto(to, s3, out);
}

/**
 * The chart the pointer's points are written on while a gesture holds one
 * (`Viewport.holdChart`), or -1: each point on its own piece's chart.
 */
let pointer = -1;

/** Sets the chart a gesture's points are read on (-1: none). */
export function setPointerChart(chart: number): void {
  pointer = chart;
}

/** The chart a pointer point `p` is written on. */
export const pointerChartOf = (x: number, y: number): number => (pointer >= 0 && !identity() ? pointer : chartAt(x, y));

/**
 * A pointer point written on its own piece's chart: what it POINTS AT, to be
 * compared with what is stored (`onChartOf`). A gesture's points are read on
 * the chart of the piece it started on (`Viewport.holdChart`), its map going
 * on past that piece - right for drawing a shape between two far points, and
 * ambiguous for pointing: three pieces out such a point lies in another
 * piece's cell of the atlas, and was taken for a point of that piece.
 */
export function ownPointer(p: Readonly<Vec2>, chart = pointerChartOf(p.x, p.y)): Vec2 {
  if (identity()) return { x: p.x, y: p.y };
  return toOwnerInto(chart, p.x, p.y, { x: 0, y: 0 });
}

/**
 * A shape drawn on `chart`'s map (a lot's corners from a gesture) written on
 * the chart of the piece that owns its middle: every vertex on that one chart,
 * as a stored shape must be (a shape is compared and drawn on one chart).
 */
export function ownShape(chart: number, points: readonly Vec2[]): Vec2[] {
  if (identity() || !points.length) return points.map((p) => ({ x: p.x, y: p.y }));
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  const middle = toOwnerInto(chart, cx / points.length, cy / points.length, { x: 0, y: 0 });
  const owner = chartAt(middle.x, middle.y);
  return points.map((p) => chartToChartInto(chart, owner, p.x, p.y, { x: 0, y: 0 }));
}

/** Points along each side of a piece's border in its territory's outline. */
const TERRITORY_STEPS = 16;
const territories = new Map<number, readonly (readonly [number, number])[]>();

/**
 * A piece's own ground on its chart's map (atlas coordinates): its border on
 * the sphere - the four arcs of its cell of the cube's face - sampled and
 * written on its chart, `margin` world units wider all round so two pieces'
 * drawings overlap by a hair instead of leaving one. What a chart draws is
 * cut to this, so every point of the sphere is drawn by exactly one chart.
 */
export function territory(chart: number, margin = 0.25): readonly (readonly [number, number])[] {
  const key = chart * 1000 + Math.round(margin * 100);
  const known = territories.get(key);
  if (known) return known;
  const t = TILES[chart]!;
  const step = (2 * FACE_HALF) / TILES_PER_SIDE;
  const x0 = -FACE_HALF + t.i * step, y0 = -FACE_HALF + t.j * step;
  const corners = [[x0, y0], [x0 + step, y0], [x0 + step, y0 + step], [x0, y0 + step]] as const;
  const c = tileCentre(chart);
  const ring: (readonly [number, number])[] = [];
  for (let side = 0; side < 4; side++) {
    const [ax, ay] = corners[side]!, [bx, by] = corners[(side + 1) % 4]!;
    for (let k = 0; k < TERRITORY_STEPS; k++) {
      const f = k / TERRITORY_STEPS;
      faceToSphereInto(t.face, ax + (bx - ax) * f, ay + (by - ay) * f, s3);
      sphereToTileInto(chart, s3, fp);
      const r = Math.hypot(fp.x, fp.y) || 1;
      const grow = (r + margin) / r;
      ring.push([c.x + fp.x * grow, c.y + fp.y * grow]);
    }
  }
  territories.set(key, ring);
  return ring;
}

/** Whether a point of `chart`'s map lies on that chart's own piece. */
export function onTerritory(chart: number, x: number, y: number): boolean {
  if (identity()) return true;
  const c = tileCentre(chart);
  return onTile(chart, x - c.x, y - c.y);
}

/**
 * The charts whose stored shapes may reach a box of `chart`'s map: its own,
 * and every neighbour whose piece lies within `TILE_REACH` of the box - a
 * shape kept on a piece's chart (a road, a lot, a building) can stand that
 * far past the piece's border. Just `chart` on the flat map.
 */
export function chartsReaching(chart: number, minX: number, minY: number, maxX: number, maxY: number): number[] {
  if (identity()) return [chart];
  const out = [chart];
  for (const other of chartsTouching(chart, minX - TILE_REACH, minY - TILE_REACH, maxX + TILE_REACH, maxY + TILE_REACH, reaching)) out.push(other);
  return out;
}
const reaching = new Set<number>();

/**
 * A run of points drawn point by point (a railway, a wall) as it is kept on
 * the planet: each stretch longer than `piece` cut into equal parts along the
 * line drawn - on its first point's chart, the second carried there - and
 * every new point kept on the chart of the piece it lies on, so a stretch
 * joins two neighbouring pieces at most (a road is cut so too,
 * `editor/commit.ts` cutLongRoads). The run between two of its points is then
 * always worked out on the first's chart, the second carried there
 * (`onChartOf`). The points themselves on the flat map.
 */
export function layRun(points: readonly Vec2[], piece: number): Vec2[] {
  if (identity() || points.length < 2) return points.map((p) => ({ x: p.x, y: p.y }));
  const out: Vec2[] = [{ x: points[0]!.x, y: points[0]!.y }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = onChartOf(points[i]!, a);
    const chart = chartAt(a.x, a.y);
    const parts = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / piece));
    for (let k = 1; k < parts; k++) out.push(toOwner(chart, { x: a.x + ((b.x - a.x) * k) / parts, y: a.y + ((b.y - a.y) * k) / parts }));
    out.push({ x: points[i]!.x, y: points[i]!.y });
  }
  return out;
}

/**
 * A point as each chart round it reads it, for a search over shapes kept on
 * many charts (a road's ribbon on its segment's, `PolylineCache.chart`):
 * `view(chart)` is the point on `chart`'s map when that chart can keep
 * something within `reach` of it (`chartsReaching`), else null - the shape is
 * too far to matter, and no transform is paid for it. Each chart's point is
 * worked out once. The point itself for every chart on the flat map.
 */
export function pointViews(p: Readonly<Vec2>, reach: number): (chart: number) => Readonly<Vec2> | null {
  if (identity()) return () => p;
  const own = chartAt(p.x, p.y);
  const near = chartsReaching(own, p.x - reach, p.y - reach, p.x + reach, p.y + reach);
  const known = new Map<number, Vec2>();
  return (chart) => {
    if (chart === own) return p;
    const seen = known.get(chart);
    if (seen) return seen;
    if (!near.includes(chart)) return null;
    const q = chartToChartInto(own, chart, p.x, p.y, { x: 0, y: 0 });
    known.set(chart, q);
    return q;
  };
}

/**
 * A unit direction `d` at point `p` of chart `from`'s map, on chart `to`'s
 * map: two neighbouring charts are turned against each other (a quarter turn
 * across an edge of the cube), so a frame read on one is turned on the other.
 */
export function directionOnChart(from: number, to: number, p: Readonly<Vec2>, d: Readonly<Vec2>): Vec2 {
  if (identity() || from === to) return { x: d.x, y: d.y };
  const a = chartToChartInto(from, to, p.x, p.y, { x: 0, y: 0 });
  const b = chartToChartInto(from, to, p.x + d.x, p.y + d.y, { x: 0, y: 0 });
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
}

/**
 * Polygons (clipper's rings of [x, y]) and their ghost images: each one also
 * carried onto every other chart whose kept ground its box can reach
 * (`chartsReaching`), as molecular dynamics keeps the atoms near a boundary
 * on both sides of it, already at their image there (LAMMPS,
 * "Communication"). A point asked about on any chart then finds the paving
 * of the next piece too - a lot cut to the land by a border was laid over
 * the road kept on its neighbour's chart. Each polygon must lie in one
 * chart's cell (as everything kept does). The polygons themselves on the
 * flat map.
 */
export function withGhostImages<P extends readonly (readonly (readonly number[])[])[]>(polys: readonly P[]): P[] {
  if (identity()) return polys as P[];
  const out: P[] = [...polys];
  const at = { x: 0, y: 0 };
  for (const poly of polys) {
    const outer = poly[0];
    if (!outer || !outer.length) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of outer) { x0 = Math.min(x0, x!); y0 = Math.min(y0, y!); x1 = Math.max(x1, x!); y1 = Math.max(y1, y!); }
    const chart = chartAt((x0 + x1) / 2, (y0 + y1) / 2);
    for (const other of chartsReaching(chart, x0, y0, x1, y1)) {
      if (other === chart) continue;
      out.push(poly.map((ring) => ring.map(([x, y]) => { chartToChartInto(chart, other, x!, y!, at); return [at.x, at.y]; })) as unknown as P);
    }
  }
  return out;
}

/** Points of `from`'s map on `to`'s map (the same ground); the points themselves when the charts are one. */
export function carryPoints(from: number, to: number, points: readonly Vec2[]): Vec2[] {
  if (from === to || identity()) return points as Vec2[];
  return points.map((p) => chartToChartInto(from, to, p.x, p.y, { x: 0, y: 0 }));
}

/** How far past a piece's border its neighbours are looked for, world units. */
const NEIGHBOUR_PROBE = 8;
const neighbourLists = new Map<number, readonly number[]>();

/**
 * The pieces round `chart`'s on the sphere: every one sharing a side or a
 * corner with it (eight, or seven beside a corner of the cube), found just
 * outside its border - its territory grown by `NEIGHBOUR_PROBE`, the corners
 * pushed out diagonally into the pieces that touch them there.
 */
function neighbours(chart: number): readonly number[] {
  const known = neighbourLists.get(chart);
  if (known) return known;
  const found = new Set<number>();
  const c = tileCentre(chart);
  for (const [x, y] of territory(chart, NEIGHBOUR_PROBE)) {
    tileToSphereInto(chart, x - c.x, y - c.y, s3);
    const t = tileOfDirection(s3);
    if (t !== chart) found.add(t);
  }
  const list = [...found];
  neighbourLists.set(chart, list);
  return list;
}

const pieceBoxes = new Map<number, readonly [number, number, number, number]>();
const onMap: FacePoint = { x: 0, y: 0 };

/** The box round `other`'s piece on `chart`'s map (its territory carried there). */
function pieceBox(chart: number, other: number): readonly [number, number, number, number] {
  const key = chart * TILE_COUNT + other;
  const known = pieceBoxes.get(key);
  if (known) return known;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of territory(other)) {
    chartToChartInto(other, chart, x, y, onMap);
    minX = Math.min(minX, onMap.x); minY = Math.min(minY, onMap.y);
    maxX = Math.max(maxX, onMap.x); maxY = Math.max(maxY, onMap.y);
  }
  const box = [minX, minY, maxX, maxY] as const;
  pieceBoxes.set(key, box);
  return box;
}

/**
 * The other charts whose pieces may hold part of a box of `chart`'s map,
 * into `out`: every neighbour of `chart`'s piece whose ground's box meets
 * it. For a box smaller than a piece (a road's surface, a junction's plate),
 * which can only reach the pieces round its own; a chart that gets one it
 * does not reach cuts it away (`territory`), so more is never wrong.
 *
 * Not the pieces the box's corners - or a polygon's vertices - lie on: the
 * pieces are curved quadrilaterals turned on `chart`'s map, and the corner of
 * a neighbour can stand in the middle of a straight road's side with no
 * vertex on it. That neighbour was never given the road and `chart` cut it
 * away: a pinched gap in the asphalt where four pieces meet. It is why a
 * grid with corner lookups requires cells aligned with the box and larger
 * than it; with any other cells the box is tested against the cells round
 * its own (the "loose grid" of N's broad phase,
 * https://www.metanetsoftware.com/2016/n-tutorial-b-broad-phase-collision).
 */
export function chartsTouching(chart: number, minX: number, minY: number, maxX: number, maxY: number, out: Set<number>): Set<number> {
  out.clear();
  if (identity()) return out;
  for (const other of neighbours(chart)) {
    const [x0, y0, x1, y1] = pieceBox(chart, other);
    if (x0 <= maxX && x1 >= minX && y0 <= maxY && y1 >= minY) out.add(other);
  }
  return out;
}
