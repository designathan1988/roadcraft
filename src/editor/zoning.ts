import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { type Signature, bodySignature, madeToMeasure, signatureDistance } from '@world/buildings/procedural';
import type { Era } from '@world/buildings/architecture';
import { METERS_PER_UNIT } from '@world/units';
import { driveSide as driveSideOf, furnishLot, garageRamp, lotKind, planLot, yardRamp } from './lotPlan';
import { MAX_ELEMENTS, type Building, type BuildingElement, type Volume } from '@world/buildings/types';
import type { SiteContext } from '@world/buildings/validate';
import type { RoadDoc } from '@world/doc';
import { m, stepsIn } from '@world/units';
import { ZONE_CELL, ZONE_DEPTH, type ZoneCell, type ZoneGrid } from '@world/zoneGrid';
import type { ZoneDensity, ZoneMark, ZoneUse } from '@world/zones';
import { lotBuildFrame, lotCentre } from '@world/lots';
import { addBuildingRecord, type placeBuilding } from './buildings';
import { MIN_SIZE, buildingBounds, footprintRects } from '@world/buildings/geometry';
import { intersection } from '@core/clipper';
import { pointInPolygon } from '@core/polygon';
import { Level, halfWidth } from '@world/roadTypes';
import { rectAround, type ChangeRect } from '@world/changes';
import { groundElements } from '@world/buildings/elements';
import { AREA_EPS, overlapArea, validOutline } from '@world/buildings/footprints';
import { THRESHOLD } from '@world/buildings/foundation';
import { garageUnder, stepToSlope } from '@world/buildings/splitLevel';

const BOUNDARY_PARTS = new Set(['wall', 'fence', 'hedge', 'railing']);

/**
 * A grown building added, its boundary meeting the neighbours': where a
 * piece of its wall or fence stands against a neighbour's own building or
 * boundary - the neighbour's wall already closes that stretch, as on any
 * party line - the piece is left out and the building added again. The
 * boundary is closed whole on the lot's own side (`lotPlan.ts`), and a
 * neighbour standing on the line was refused the whole building for it.
 */
function addPlaced(ctx: SiteContext, record: Omit<Building, 'id'>): ReturnType<typeof placeBuilding> {
  const first = addBuildingRecord(ctx, record);
  if (first.ok || first.problem !== 'building') return first;
  const probe = { ...record, id: -1 } as unknown as Building;
  const box = buildingBounds(probe, m(2));
  const theirs: Vec2[][] = [];
  for (const o of ctx.doc.buildings.all()) {
    const ob = buildingBounds(o);
    if (ob.minX > box.maxX || ob.maxX < box.minX || ob.minY > box.maxY || ob.maxY < box.minY) continue;
    theirs.push(...footprintRects(o), ...groundElements(o));
  }
  const elements = (record.elements ?? []).filter((e) => {
    if (!BOUNDARY_PARTS.has(e.kind)) return true;
    const ring = groundElements({ ...probe, elements: [e] }, -m(0.05))[0];
    return !ring || !theirs.some((c) => overlapArea(ring, c) > AREA_EPS);
  });
  if (elements.length === (record.elements ?? []).length) return first;
  return addBuildingRecord(ctx, { ...record, elements });
}

/**
 * Where these zone cells lie, for the diary (`RoadDoc.zonesChanged`): only
 * that region is marked as changed, the whole map when there is none.
 */
function cellRects(points: readonly Vec2[]): readonly ChangeRect[] | null {
  const rect = rectAround(points, ZONE_CELL);
  return rect ? [rect] : null;
}

/**
 * Zoning, the way city builders do it (Cities: Skylines 1 and 2): the player
 * paints the cells of the street grid (`world/zoneGrid.ts`) with a use and a
 * density, and buildings GROW on them over time, one lot at a time, each on
 * whole cells, facing its street. Zoning is a plan for the land, not a stamp
 * that drops a row of houses where the pointer let go.
 */

/** Lot widths in cells, narrowest and widest, by zone. */
const LOT_COLUMNS: Record<ZoneUse, Record<ZoneDensity, readonly [number, number]>> = {
  residential: { low: [1, 2], medium: [2, 3], high: [3, 4] },
  commercial: { low: [1, 2], medium: [2, 3], high: [2, 4] },
  industrial: { low: [2, 4], medium: [3, 5], high: [4, 6] },
};

/**
 * How far a lot may grow on each side, along the street (world units). It
 * walks out from each side edge, at the front, the middle and the back of the
 * lot, until it meets something: a road's footway (the lot reaches it), a
 * building or another zoned lot (the lot reaches it when it is near), or
 * nothing within a cell and a quarter (free land, left for a lot of its own).
 */
function sideReach(
  ctx: SiteContext,
  grid: ZoneGrid,
  marks: Map<string, { mark: ZoneMark; index: number }>,
  anchor: Vec2,
  rotation: number,
  width: number,
  depth: number,
  own: readonly ZoneCell[],
): { left: number; right: number } {
  const { doc, net } = ctx;
  if (!net) return { left: 0, right: 0 };
  const ex = { x: Math.cos(rotation), y: Math.sin(rotation) };
  const ey = { x: -ex.y, y: ex.x };
  const ownIds = new Set(own.map((cell) => cell.id));
  const ribbons = [...net.ribbons.values()].filter((r) => doc.segment(r.id)?.structure === 'ground');
  const near = [...doc.buildings.all()].filter((b) => {
    const bb = buildingBounds(b);
    return Math.hypot((bb.minX + bb.maxX) / 2 - anchor.x, (bb.minY + bb.maxY) / 2 - anchor.y) < width + depth + m(60);
  }).map((b) => footprintRects(b));
  const LIMIT = ZONE_CELL * 1.25, STEP = m(0.25), NEAR = m(3);
  const blocked = (q: Vec2): 'road' | 'thing' | null => {
    for (const r of ribbons) if (r.full.distanceTo(q) < halfWidth(r.road, Level.Sidewalk) - m(0.02)) return 'road';
    for (const rects of near) for (const rect of rects) if (pointInPolygon(q, rect)) return 'thing';
    const cell = grid.cellAt(q);
    if (cell && !ownIds.has(cell.id) && marks.has(cell.id)) return 'thing';
    return null;
  };
  const out = { left: 0, right: 0 };
  for (const [key, sign] of [['left', -1], ['right', 1]] as const) {
    let found: { d: number; what: 'road' | 'thing' } | null = null;
    for (let d = STEP; d <= LIMIT && !found; d += STEP) {
      for (const y of [m(0.3), depth / 2, depth - m(0.3)]) {
        const along = sign * (width / 2 + d);
        const q = { x: anchor.x + ex.x * along + ey.x * y, y: anchor.y + ex.y * along + ey.y * y };
        const what = blocked(q);
        if (what) { found = { d: d - STEP, what }; break; }
      }
    }
    // Up to a neighbour exactly (party wall to party wall); a hair short of a road's footway.
    if (found && (found.what === 'road' || found.d <= NEAR)) out[key] = Math.max(0, found.d - (found.what === 'road' ? m(0.1) : JOINT));
  }
  return out;
}

/** How close a stored mark has to be to a cell's centre to be that cell's. */
/** The joint left between two neighbouring lots: a hair, so their party walls meet without overlapping. */
const JOINT = 0;
/**
 * A lot's side in metres, to the millimetre, for the plans made in metres
 * (`planLot`, `madeToMeasure`, `furnishLot`): they choose by whole metres and
 * bays, and the same lot read 20.400000000000002 m at 0.4 m a unit and
 * 20.400000000000006 at 1 - a shrub more along its front, another house.
 */
const metresOf = (units: number): number => Math.round(units * METERS_PER_UNIT * 1000) / 1000;
const MATCH = ZONE_CELL / 2;

/** Every cell's mark at once (one pass over the marks, not one per cell). */
export function marksByCell(doc: RoadDoc, grid: ZoneGrid): Map<string, { mark: ZoneMark; index: number }> {
  const out = new Map<string, { mark: ZoneMark; index: number }>();
  const dist = new Map<string, number>();
  doc.zoneMarks.forEach((mark, index) => {
    const cell = grid.cellAt(mark) ?? grid.cellsNear(mark, MATCH)[0];
    if (!cell) return;
    const d = Math.hypot(mark.x - cell.centre.x, mark.y - cell.centre.y);
    if (d >= MATCH || d >= (dist.get(cell.id) ?? Infinity)) return;
    dist.set(cell.id, d);
    out.set(cell.id, { mark, index });
  });
  return out;
}

/**
 * The buildings that stand on marks no longer matching what the player wants
 * there go: a cell rezoned or dezoned under a grown building demolishes it,
 * and frees every other cell it stood on.
 */
function demolishGrown(doc: RoadDoc, ids: ReadonlySet<number>): void {
  if (!ids.size) return;
  for (const id of ids) {
    if (doc.buildings.has(id as Parameters<typeof doc.buildings.has>[0])) {
      doc.buildings.remove(id as Parameters<typeof doc.buildings.remove>[0]);
    }
  }
  for (let i = 0; i < doc.zoneMarks.length; i++) {
    const mark = doc.zoneMarks[i] as ZoneMark;
    if (mark.building !== undefined && ids.has(mark.building)) {
      const { building: _gone, ...free } = mark;
      doc.zoneMarks[i] = free;
    }
  }
}

/**
 * Paints cells with a use and density, or clears them (`zone` null). Returns
 * how many cells changed. A cell already zoned the same way keeps its building.
 */
export function paintCells(
  doc: RoadDoc,
  grid: ZoneGrid,
  cells: readonly ZoneCell[],
  zone: { use: ZoneUse; density: ZoneDensity } | null,
): number {
  const marks = marksByCell(doc, grid);
  const doomed = new Set<number>();
  const drop = new Set<number>();
  const add: ZoneMark[] = [];
  let changed = 0;
  for (const cell of cells) {
    const found = marks.get(cell.id);
    if (zone && found && found.mark.use === zone.use && found.mark.density === zone.density) continue;
    if (!zone && !found) continue;
    changed++;
    if (found) {
      drop.add(found.index);
      if (found.mark.building !== undefined) doomed.add(found.mark.building);
    }
    if (zone) add.push({ x: cell.centre.x, y: cell.centre.y, use: zone.use, density: zone.density });
  }
  if (!changed) return 0;
  const touched: Vec2[] = [...add, ...[...drop].map((index) => doc.zoneMarks[index]!)];
  const kept = doc.zoneMarks.filter((_, index) => !drop.has(index));
  doc.zoneMarks.splice(0, doc.zoneMarks.length, ...kept, ...add);
  demolishGrown(doc, doomed);
  doc.zonesChanged(cellRects(touched), zone ? 'zona pintada' : 'zona apagada');
  return changed;
}

/** Every cell of the street side a cell belongs to: the Fill tool's block. */
export function blockOf(grid: ZoneGrid, cell: ZoneCell): ZoneCell[] {
  return grid.cells.filter((other) => other.segment === cell.segment && other.side === cell.side);
}

/**
 * Grows at most one building on the zoned land. Picks the first free lot in a
 * stable order from a seeded walk, so a city zoned the same way grows the same
 * way. Returns the new building's id, or null when nothing could grow.
 *
 * `refused` remembers lots whose building did not fit (a slope, a building the
 * player put there), so a frame is not spent trying them again; the caller
 * clears it when the land changes.
 */
export function growOne(ctx: SiteContext, grid: ZoneGrid, refused: Set<string>, seed: number): number | null {
  // A refused start makes the column after it a start of its own: look again
  // (a few times) rather than report the land full while it is not.
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = refused.size;
    const id = growOnce(ctx, grid, refused, seed);
    if (id !== null || refused.size === before) return id;
  }
  return null;
}

function growOnce(ctx: SiteContext, grid: ZoneGrid, refused: Set<string>, seed: number): number | null {
  const { doc } = ctx;
  if (!doc.zoneMarks.length) return null;
  const marks = marksByCell(doc, grid);
  const standing = (mark: ZoneMark): boolean =>
    mark.building !== undefined && doc.buildings.has(mark.building as Parameters<typeof doc.buildings.has>[0]);
  // Free, zoned front cells: where a lot can start.
  const starts = grid.cells.filter((cell) => {
    if (cell.row !== 0 || refused.has(cell.id)) return false;
    const found = marks.get(cell.id);
    if (!found || standing(found.mark)) return false;
    // Only the first free column of a run: lots then pack from one end of a
    // stretch to the other. Started anywhere, they left single columns between
    // them that no model fits, and the block stayed gappy.
    const before = grid.at(cell.segment, cell.side, cell.column - 1, 0);
    const prev = before && marks.get(before.id);
    return !(prev && !standing(prev.mark) && prev.mark.use === found.mark.use &&
      prev.mark.density === found.mark.density && !refused.has(before!.id));
  });
  if (!starts.length) return null;
  const rng = new Rng((seed ^ Math.imul(doc.buildings.nextId, 0x9e3779b1)) >>> 0);
  // Walk from a random start so growth spreads over the zoned streets.
  const first = rng.int(0, starts.length - 1);
  for (let k = 0; k < starts.length; k++) {
    const start = starts[(first + k) % starts.length] as ZoneCell;
    const zone = marks.get(start.id)!.mark;
    // A model of this zone, picked at random; the lot is as many columns as it
    // is wide, and always the zone's whole depth: what the building does not
    // cover becomes its garden, car park or yard - no zoned cell is left bare.
    // The lot: a width drawn for the zone, as deep as the zoned land goes.
    // Narrower widths are tried when the run is short, down to one column, so
    // no zoned cell is left bare; a building is then made for exactly that lot.
    const [narrow, wide] = LOT_COLUMNS[zone.use][zone.density];
    const want = rng.int(narrow, wide);
    const freeColumn = (column: number, depth: number): ZoneCell[] | null => {
      const cells: ZoneCell[] = [];
      for (let r = 0; r < depth; r++) {
        const cell = grid.at(start.segment, start.side, column, r);
        const found = cell && marks.get(cell.id);
        if (!cell || !found || found.mark.use !== zone.use || found.mark.density !== zone.density || standing(found.mark)) return null;
        cells.push(cell);
      }
      return cells;
    };
    let rows = 0;
    for (let depth = ZONE_DEPTH; depth >= 1 && !rows; depth--) if (freeColumn(start.column, depth)) rows = depth;
    if (!rows) { refused.add(start.id); continue; }
    // The free run from here, at that depth.
    let run = 0;
    while (run < wide + narrow && freeColumn(start.column + run, rows)) run++;
    // Take `want` columns, fewer if the run is short; and if what would be
    // left is narrower than any lot of this zone, take it too.
    let columns = Math.min(want, run);
    if (run - columns > 0 && run - columns < narrow) columns = run;
    // A cell trimmed on the subgrid at a block's end is too narrow for a lot
    // of its own: it goes with the next column, so the end is built on too.
    if (start.width < ZONE_CELL - 1e-6 && columns === 1 && run > 1) columns = 2;
    const lot: ZoneCell[] = [];
    for (let c = 0; c < columns; c++) lot.push(...freeColumn(start.column + c, rows)!);
    const margin = m(0.3);
    // Front middle of the grid lot, and the street's direction there.
    const fronts = lot.filter((cell) => cell.row === 0);
    // Cells trimmed on the 1 m subgrid at a block's edge (`ZoneCell.width`)
    // are part of the lot like any other: its width and its front middle are
    // read off the cells themselves, so no zoned strip is left unbuilt.
    fronts.sort((p, q) => p.column - q.column);
    const firstFront = fronts[0] as ZoneCell, lastFront = fronts[fronts.length - 1] as ZoneCell;
    const gridAnchor = {
      x: (firstFront.corners[0].x + lastFront.corners[1].x) / 2,
      y: (firstFront.corners[0].y + lastFront.corners[1].y) / 2,
    } as Vec2;
    const rotation = (fronts[Math.floor(fronts.length / 2)] as ZoneCell).rotation;
    // The full width of the cells: two lots side by side share their boundary
    // (the player's order of 2026-10-05: "qualquer construção não pode ter
    // vãos"). A margin taken off each side left a strip between neighbours.
    const gridW = fronts.reduce((sum, cell) => sum + cell.width, 0) - JOINT;
    // The land beside the lot that nobody else can use - the strip left at a
    // corner between the grid and the cross street's footway, a gap short of
    // the next building - joins the lot, so no bare strip is left along a
    // footway or between two properties.
    const fullReach = sideReach(ctx, grid, marks, gridAnchor, rotation, gridW, rows * ZONE_CELL - margin, lot);
    const lotD = rows * ZONE_CELL - margin;
    // Built on the widened lot; where that meets a corner's curved footway
    // and is refused, on half the gain, then on the grid lot alone.
    let result: ReturnType<typeof placeBuilding> = { ok: false, problem: 'overlap' } as ReturnType<typeof placeBuilding>;
    for (const k of [1, 0.5, 0]) {
      const reach = { left: fullReach.left * k, right: fullReach.right * k };
      if (k < 1 && fullReach.left + fullReach.right < m(0.5)) break;
      const lotW = gridW + reach.left + reach.right;
      const W = metresOf(lotW), D = metresOf(lotD);
      if (W < 4) continue;
      // The lot is planned first - front, sides, back, each for a purpose -
      // and the building is made for the envelope the plan leaves it.
      const plan = planLot(lotKind(zone.use, zone.density), W, D, rng);
      const env = plan.building;
      const made = madeToMeasure(zone.use, zone.density, {
        W: env.x1 - env.x0, D: env.y1 - env.y0,
        backDoor: plan.back.use !== 'none' && plan.back.use !== 'loading',
        character: (Number(start.segment) * 31 + (start.side === 1 ? 7 : 3)) >>> 0,
      }, rng);
      const body = made.body;
      const dx = m(env.x0 - W / 2), dy = m(env.y0);
      for (const v of body.volumes) { v.x += dx; v.y += dy; }
      for (const e of body.elements ?? []) { e.x += dx; e.y += dy; }
      for (const c of body.cores ?? []) { c.x += dx; c.y += dy; }
      // Nothing of the building past its lot's sides: a porch or an annex the
      // maker set a little wide stood into the neighbour's lot, and the
      // neighbour was then refused - the gap the player kept finding.
      for (const v of body.volumes) {
        if (v.outline) continue;
        const x0 = Math.max(v.x, -lotW / 2), x1 = Math.min(v.x + v.w, lotW / 2);
        if (x1 - x0 > m(1)) { v.x = x0; v.w = x1 - x0; }
        // A side standing on the lot's boundary is a party wall: blank, so
        // no shopfront, awning or door faces into the neighbour it joins.
        for (const [face, onEdge] of [[3, v.x <= -lotW / 2 + m(0.6)], [1, v.x + v.w >= lotW / 2 - m(0.6)]] as const) {
          if (!onEdge) continue;
          for (const storey of v.storeys) {
            storey.facade.sides = { ...(storey.facade.sides ?? {}), [face]: 'wall' };
            if (storey.facade.patterns) delete storey.facade.patterns[face];
            if (storey.facade.bays) for (const key of Object.keys(storey.facade.bays)) if (key.startsWith(`${face}:`)) delete storey.facade.bays[key];
          }
        }
      }
      if (!furnishLot(body, plan, made, rng)) continue;
      // The widened lot's front middle - the body's local origin - shifted
      // along the street by half of what one side gained over the other.
      const shift = (reach.right - reach.left) / 2;
      const anchor = { x: gridAnchor.x + Math.cos(rotation) * shift, y: gridAnchor.y + Math.sin(rotation) * shift };
      result = addPlaced(ctx, { ...body, x: anchor.x, y: anchor.y, rotation } as Omit<Building, 'id'>);
      if (result.ok) break;
    }
    if (!result.ok || result.id === undefined) { refused.add(start.id); continue; }
    const id = result.id as number;
    for (const cell of lot) {
      const found = marks.get(cell.id)!;
      doc.zoneMarks[found.index] = { ...found.mark, building: id };
    }
    doc.zonesChanged(cellRects(lot.map((cell) => cell.centre)), 'prédio cresceu na zona');
    return id;
  }
  return null;
}

/**
 * The version of the lot generator (`lotPlan.ts`, the yards, walls and
 * facades of grown buildings), stamped on each building grown (`main.ts`).
 * Bumped when it changes.
 */
export const LOT_PLAN_VERSION = 12;

/**
 * The ground floor a grown building on a lot will have: its street's paving
 * along the lot's front, and a threshold over it (`foundation.ts`
 * `floorOver`). With no paving to read, the land at the front less the drop
 * the roads shape it by. `front`: how far the plan is set back from the
 * lot's front (a try's margin, `growOnLot`) - the street is read beyond the
 * lot, not beyond the plan.
 */
function streetFloor(ctx: SiteContext, local: (lx: number, ly: number) => Vec2, width: number, ground: (x: number, y: number) => number, front = 0): number {
  let best = -Infinity;
  if (ctx.pavedAt) {
    for (const k of [-0.3, 0, 0.3]) {
      const p = local(width * k, -front - m(0.6));
      const h = ctx.pavedAt(p.x, p.y);
      if (Number.isFinite(h)) best = Math.max(best, h);
    }
  }
  if (Number.isFinite(best)) return best + THRESHOLD;
  const p = local(0, m(0.5));
  return ground(p.x, p.y) + m(0.6);
}

/**
 * Grows one building on a zoned lot without one (`world/lots.ts`): the lot is
 * planned first - front, sides, back - and the building made for the envelope
 * the plan leaves, as on a grid lot (`growOnce`), but on the lot the player
 * drew: its front middle, its facing, its width and depth.
 */
/** Candidates made for a lot, the least like its neighbours kept (Mitchell's best candidate). */
const CANDIDATES = 4;
/** How far round a lot the buildings it should not look like are read: the 100 m of the rule it answers (`tests/world/variety.spec.ts`; at 90 m a twin 95 m off went unseen). */
const LIKE_REACH = m(100);
/** How near the last building grown an open lot must be to grow next (the street filling along). */
const GROW_ON_REACH = m(70);

/** Each record's signature, worked out once (a record is replaced when its building changes). */
const SIGNATURES = new WeakMap<Building, Signature>();
const signatureOfRecord = (b: Building): Signature => {
  let s = SIGNATURES.get(b);
  if (!s) SIGNATURES.set(b, s = bodySignature(b));
  return s;
};

/** How far `a` is from `b`. */
function apart(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The buildings round a point: each one's signature and how far it stands. */
function nearSignatures(doc: RoadDoc, at: Vec2): { signature: Signature; distance: number }[] {
  const out: { signature: Signature; distance: number }[] = [];
  for (const b of doc.buildings.all()) {
    const d = apart(b, at);
    if (d < LIKE_REACH) out.push({ signature: signatureOfRecord(b), distance: d });
  }
  return out;
}

/**
 * How unlike its surroundings a building would be: its least distance in
 * looks to any of them, a building farther away counting as more unlike
 * (a twin across the town is no twin).
 */
function unlikeness(body: Building | Omit<Building, 'id' | 'x' | 'y' | 'rotation'>, near: readonly { signature: Signature; distance: number }[]): number {
  const mine = bodySignature(body);
  let least = Infinity;
  for (const n of near) least = Math.min(least, signatureDistance(mine, n.signature) + 2.5 * (n.distance / LIKE_REACH));
  return least;
}

/** Storeys of the buildings beside a lot's front (within its width and a little), tallest block each. */
function neighbourStoreys(doc: RoadDoc, anchor: Vec2, width: number): number[] {
  const out: number[] = [];
  for (const b of doc.buildings.all()) {
    if (apart(b, anchor) > width + m(12)) continue;
    const top = Math.max(0, ...b.volumes.filter((v) => !v.open).map((v) => v.base + v.storeys.length));
    if (top > 0) out.push(top);
  }
  return out;
}

/**
 * The side of a lot (`left`: along -u from the front's middle) with a street
 * just beyond it over most of its depth: a corner lot. Undefined for none,
 * or with no network to read.
 */
function cornerOf(ctx: SiteContext, anchor: Vec2, u: Vec2, n: Vec2, width: number, depth: number): 'left' | 'right' | undefined {
  const net = ctx.net;
  if (!net) return undefined;
  const ribbons = [...net.ribbons.values()].filter((r) => ctx.doc.segment(r.id)?.structure === 'ground');
  const onStreet = (p: Vec2): boolean => ribbons.some((r) => {
    const bb = r.full.bbox, reach = halfWidth(r.road, Level.Sidewalk) + m(0.6);
    if (p.x < bb.minX - reach || p.x > bb.maxX + reach || p.y < bb.minY - reach || p.y > bb.maxY + reach) return false;
    return r.full.distanceTo(p) < reach;
  });
  for (const [side, sign] of [['left', -1], ['right', 1]] as const) {
    const along = sign * (width / 2 + m(2));
    const hits = [0.35, 0.65].filter((k) => onStreet({ x: anchor.x + u.x * along + n.x * depth * k, y: anchor.y + u.y * along + n.y * depth * k })).length;
    if (hits === 2) return side;
  }
  return undefined;
}

/**
 * The street side and the quarter a lot belongs to, for its building's
 * style (`world/buildings/architecture.ts`): `character` the same for the
 * lots of one side of a street within some 60 m (one frontage reads as one),
 * `era` the same over a quarter of about 220 m - its period, old towards the
 * middle of the map more often, new towards the edges.
 */
function quarterOf(anchor: Vec2, n: Vec2): { character: number; era: Era } {
  const hash = (a: number, b: number, c: number): number => {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x3c6ef372);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return (h ^ (h >>> 13)) >>> 0;
  };
  const facing = Math.round(Math.atan2(n.y, n.x) / (Math.PI / 2));
  const cx = anchor.x, cy = anchor.y;
  const central = Math.hypot(anchor.x, anchor.y) < m(450);
  const character = hash(Math.floor(stepsIn(cx, 60)), Math.floor(stepsIn(cy, 60)), facing + 11);
  const q = hash(Math.floor(stepsIn(cx, 220)), Math.floor(stepsIn(cy, 220)), 5) / 4_294_967_296;
  const era: Era = central ? (q < 0.5 ? 0 : q < 0.8 ? 1 : 2) : (q < 0.15 ? 0 : q < 0.5 ? 1 : 2);
  return { character, era };
}

/** Where the building grown last stands (the highest id grown on a lot), or null. */
function lastGrown(doc: RoadDoc): Vec2 | null {
  let best: Building | null = null;
  for (const l of doc.lots) {
    if (l.building === undefined) continue;
    const b = doc.buildings.get(l.building as Parameters<typeof doc.buildings.get>[0]);
    if (b && (!best || b.id > best.id)) best = b;
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** @perItem Runs once a building grown (`growSlice`, the 500 ms growth): nothing it reaches may walk the map. */
export function growOnLot(ctx: SiteContext, refused: Set<number>, seed: number): number | null {
  const { doc } = ctx;
  const standing = (b: number | undefined): boolean => b !== undefined && doc.buildings.has(b as Parameters<typeof doc.buildings.has>[0]);
  const open = doc.lots.filter((l) => l.use && !standing(l.building) && !refused.has(l.id));
  if (!open.length) return null;
  const rng = new Rng((seed ^ Math.imul(doc.buildings.nextId, 0x9e3779b1)) >>> 0);
  // The street fills along: the open lot nearest the last building grown,
  // when one is near (the player sees the street they zoned fill in, one
  // house after the next); anywhere else, a lot at random.
  let lot = open[rng.int(0, open.length - 1)]!;
  const last = lastGrown(doc);
  if (last) {
    let best = GROW_ON_REACH;
    // Nearer by a millimetre at least: two lots as near (a street's two
    // sides) are told apart by the list's order, not by rounding - which
    // took one at 0.4 m a unit and the other at 1.
    for (const l of open) {
      const d = apart(lotCentre(l), last);
      if (d < best - m(0.001)) { best = d; lot = l; }
    }
  }
  const use = lot.use!;
  const frame = lotBuildFrame(lot);
  // Every zoned lot gets a building, whatever its size or shape (the player,
  // 2026-10-05: "tem que aparecer sempre"). The building first made for the
  // whole lot; refused (its front over a corner's curved footway, a side over
  // a neighbour, a slope), it is made again set back from the front and the
  // sides, then narrower and shallower, then a density lower - until one fits.
  const u = { x: Math.cos(frame.rotation), y: Math.sin(frame.rotation) }, n = { x: -u.y, y: u.x };
  // A corner lot: a street along one of its sides too (the building then
  // looks onto it, `planLot`).
  const corner = cornerOf(ctx, frame.anchor, u, n, frame.width, frame.depth);
  const densities: ZoneDensity[] = lot.density === 'high' ? ['high', 'medium', 'low'] : lot.density === 'medium' ? ['medium', 'low'] : ['low'];
  // A handful of tries, each a building made: a few milliseconds apiece.
  const tries = [
    { front: 0, side: 0, shrink: 1 }, { front: m(1.5), side: 0, shrink: 1 }, { front: m(3), side: m(1), shrink: 0.9 },
    { front: m(3), side: m(1), shrink: 0.75 }, { front: m(4), side: m(1.5), shrink: 0.6 }, { front: m(4), side: m(1.5), shrink: 0.45 },
  ];
  for (const density of densities) for (const t of tries) {
    const lotW = (frame.width - JOINT - 2 * t.side) * t.shrink;
    const lotD = (frame.depth - m(0.3) - t.front) * t.shrink;
    const W = metresOf(lotW), D = metresOf(lotD);
    if (W < 4 || D < 4) continue;
    const plan = planLot(lotKind(use, density), W, D, rng, corner);
    const env = plan.building;
    const driveSide = plan.left.use === 'drive' || plan.left.use === 'drivePath' ? 'left' as const
      : plan.right.use === 'drive' || plan.right.use === 'drivePath' ? 'right' as const : undefined;
    const envelope = {
      W: env.x1 - env.x0, D: env.y1 - env.y0,
      backDoor: plan.back.use !== 'none' && plan.back.use !== 'loading',
      ...quarterOf(frame.anchor, n),
      ...(driveSide ? { driveSide } : {}),
      neighbours: neighbourStoreys(doc, frame.anchor, frame.width),
    };
    // Of a few candidates, the one least like the buildings round it
    // (Mitchell's best candidate, in the space of what a building looks
    // like): drawn at random, a street still came out with twins side by side.
    const near = nearSignatures(doc, frame.anchor);
    let made = madeToMeasure(use, density, envelope, rng);
    if (near.length) {
      let score = unlikeness(made.body, near);
      for (let k = 1; k < CANDIDATES; k++) {
        const other = madeToMeasure(use, density, envelope, rng);
        const s = unlikeness(other.body, near);
        if (s > score) { score = s; made = other; }
      }
    }
    const body = made.body;
    const dx = m(env.x0 - W / 2), dy = m(env.y0);
    for (const v of body.volumes) { v.x += dx; v.y += dy; }
    for (const e of body.elements ?? []) { e.x += dx; e.y += dy; }
    for (const c of body.cores ?? []) { c.x += dx; c.y += dy; }
    for (const v of body.volumes) {
      if (v.outline) continue;
      const x0 = Math.max(v.x, -lotW / 2), x1 = Math.min(v.x + v.w, lotW / 2);
      if (x1 - x0 > m(1)) { v.x = x0; v.w = x1 - x0; }
    }
    // The lot's front middle, set back by the try's front margin.
    const anchor = { x: frame.anchor.x + n.x * t.front, y: frame.anchor.y + n.y * t.front };
    // How the land falls or rises from the street to the middle of the back
    // yard, metres: a yard on a hillside is terraced (`furnishLot`).
    const ground = ctx.groundAt;
    const yardY = m(D - plan.back.depth / 2);
    const local = (lx: number, ly: number): Vec2 => ({ x: anchor.x + u.x * lx + n.x * ly, y: anchor.y + u.y * lx + n.y * ly });
    // The building follows its hillside (`splitLevel.ts`): its back a half or
    // a whole storey from the street floor where the ground under it calls
    // for it, as CityEngine moves each footprint to the terrain before the
    // ground is graded round it. A car park or a loading yard behind goes to
    // the back's level with it, its ground counted in the choice, and only
    // as far as its drive can reach as a ramp (`yardRamp`): the drive from
    // the street is level behind the gate, then a ramp no steeper than its
    // traffic takes.
    let split: { y: number; lift: number } | undefined;
    let garage: { x: number; y: number; w: number } | undefined;
    let landAt: ((x: number, y: number) => number) | undefined;
    const yardBack = plan.back.use === 'parking' || plan.back.use === 'loading';
    const ramp = yardBack ? yardRamp(plan) : null;
    if (ground && (!yardBack || ramp)) {
      const floor = streetFloor(ctx, local, lotW, ground, t.front);
      // The natural ground about the street floor at a point of the lot (metres, the lot's frame).
      landAt = (x, y) => { const p = local(m(x - W / 2), m(y)); return (ground(p.x, p.y) - floor) * METERS_PER_UNIT; };
      const step = stepToSlope(body, {
        groundAt: (lx, ly) => { const p = local(lx, ly); return ground(p.x, p.y); },
        floor, x0: m(env.x0 - W / 2), x1: m(env.x1 - W / 2),
        ...(ramp ? { yard: { x0: m(-W / 2), y0: m(ramp.end), x1: m(W / 2), y1: m(D) }, maxLift: m(ramp.grade * (ramp.end - ramp.start)) } : {}),
      });
      if (step) split = { y: step.y / m(1), lift: step.lift / m(1) };
      // A house a whole storey down its hillside, with a drive: its garage in
      // the lower ground floor, on the drive's side (`garageUnder`), when the
      // drive can go down that far as a ramp (`garageRamp`) and the garden
      // has room for the apron before the door.
      const way = step && step.steps === -2 ? garageRamp(plan) : null;
      const side = driveSideOf(plan);
      const hasGarage = body.volumes.some((v) => v.storeys.some((s) => Object.values(s.facade.bays ?? {}).includes('garageDoor') || s.facade.fill === 'garageDoor'));
      if (step && way && side && !hasGarage && plan.back.depth >= 7 && -step.lift <= m(way.grade * (way.end - way.start))) {
        const door = garageUnder(body, side);
        if (door) garage = { x: door.x / m(1) + W / 2, y: door.y / m(1), w: door.w / m(1) };
      }
    }
    // How the land falls across the back zone, from its front to the lot's back (a car park keeps a little of it).
    const backFall = ground && plan.back.depth > 0
      ? (ground(local(0, m(D - 0.5)).x, local(0, m(D - 0.5)).y) - ground(local(0, m(D - plan.back.depth)).x, local(0, m(D - plan.back.depth)).y)) * METERS_PER_UNIT
      : undefined;
    const hill = ground && plan.back.depth > 0
      ? { yard: (ground(anchor.x + n.x * yardY, anchor.y + n.y * yardY) - ground(anchor.x + n.x * m(0.5), anchor.y + n.y * m(0.5))) * METERS_PER_UNIT, ...(split ? { split } : {}), ...(backFall !== undefined ? { backFall } : {}), ...(garage ? { garage } : {}), ...(landAt ? { landAt } : {}) }
      : split ? { yard: split.lift, split } : undefined;
    if (!furnishLot(body, plan, made, rng, hill)) continue;
    // The lot in the building's frame: x along the front, y back into it.
    const ring = lot.corners.map((c) => ({ x: (c.x - anchor.x) * u.x + (c.y - anchor.y) * u.y, y: (c.x - anchor.x) * n.x + (c.y - anchor.y) * n.y }));
    // Set back from the street (a try's margin), its front still reaches the
    // street (`reachStreet`); the plan as laid is kept in case that is refused.
    const bare = t.front > 0 ? structuredClone({ volumes: body.volumes, elements: body.elements }) : null;
    if (bare) reachStreet(body, t.front, lotW);
    fitToLot(body, ring);
    const placed = (): Omit<Building, 'id'> => ({ ...body, x: anchor.x, y: anchor.y, rotation: frame.rotation }) as Omit<Building, 'id'>;
    let result = addPlaced(ctx, placed());
    if ((!result.ok || result.id === undefined) && bare) {
      // Refused with it (over a curved footway, a neighbour's yard): the plan alone, as before.
      body.volumes = bare.volumes;
      if (bare.elements) body.elements = bare.elements;
      else delete body.elements;
      fitToLot(body, ring);
      result = addPlaced(ctx, placed());
    }
    if (!result.ok || result.id === undefined) continue;
    const at = doc.lots.findIndex((l) => l.id === lot.id);
    doc.lots[at] = { ...lot, building: result.id as number };
    const where = rectAround(lot.corners);
    doc.lotsChanged(where ? [where] : null, 'prédio cresceu no lote');
    return result.id as number;
  }
  refused.add(lot.id);
  return null;
}


const BOUNDARY_KINDS = new Set(['wall', 'fence', 'hedge', 'railing', 'gate']);

/**
 * A plan set back `front` from its lot's front (a try's margin, `growOnLot`)
 * carried out to the street: each surface along the plan's front - the
 * forecourt, the garden, the drive - laid on across the strip, and paving
 * where none is (a building up to the plan's front). Left bare, the strip
 * hid the street from the building: with no paving in reach, its ground
 * floor stood on its highest ground (`foundation.ts` `floorOver`), and up a
 * hillside street a shop stood 4-5.6 m over the footway on a stone plinth.
 * A shopfront has its entrance at the footway's grade (form-based codes:
 * Fircrest's shopfront frontage, Santa Clara's first floor at 0 ft).
 */
function reachStreet(body: { volumes: Volume[]; elements?: BuildingElement[] }, front: number, width: number): void {
  // The surfaces along the plan's front, at the street's floor (a drive's
  // ramp keeps its own run: a strip is laid before it instead).
  const along = body.volumes.filter((v) => v.open && !v.outline && Math.abs(v.y) < m(0.05)
    && v.ramp === undefined && !v.terrace);
  const covered: [number, number][] = [];
  for (const v of along) {
    v.y -= front;
    v.d += front;
    covered.push([v.x, v.x + v.w]);
  }
  // And the paths from the gate, out to the footway.
  for (const el of body.elements ?? []) {
    if (el.kind !== 'pavement' || el.facing % 2 !== 0 || Math.abs(el.y - el.d / 2) > m(0.05)) continue;
    el.y -= front / 2;
    el.d += front;
  }
  covered.sort((a, b) => a[0] - b[0]);
  // Paving across the rest of the front, as deep as a surface may be (it
  // runs under the plan's front edge where the strip is narrower).
  let next = Math.max(0, ...body.volumes.map((v) => v.id)) + 1;
  const lay = (x0: number, x1: number): void => {
    if (x1 - x0 < MIN_SIZE) return;
    body.volumes.push({ id: next++, x: x0, y: -front, w: x1 - x0, d: Math.max(front, MIN_SIZE), base: 0,
      roof: 'flat', storeys: [{ facade: { fill: 'wall' } }], open: 'paving' } as Volume);
  };
  let x = -width / 2;
  for (const [a, b] of covered) {
    lay(x, Math.min(a, width / 2));
    x = Math.max(x, b);
  }
  lay(x, width / 2);
}

/**
 * A grown building made to its lot's own shape (the player, 2026-10-05: "as
 * construções devem seguir o formato dos lotes"). The plan was laid on the
 * lot's front rectangle; on a lot of another shape - a polygon, a curved
 * side, a lot narrowing or widening at the back:
 * - the ground of the whole lot is laid as a lawn (an open block with the
 *   lot's own outline), the plan's surfaces clipped to the lot over it;
 * - the boundary (walls, fences, hedges) is taken off the rectangle and run
 *   along the lot's own sides, all but the front;
 * - whatever of the plan falls outside the lot (a tree, a shed, a bench, a
 *   surface) is left out.
 * A rectangular lot is left as planned.
 */
function fitToLot(body: { volumes: Volume[]; elements?: BuildingElement[] }, ring: readonly Vec2[]): void {
  const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let area = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i]!, q = ring[(i + 1) % ring.length]!; area += p.x * q.y - q.x * p.y; }
  if (ring.length === 4 && Math.abs(area / 2) > (x1 - x0) * (y1 - y0) * 0.97) return;
  const inside = (p: Vec2): boolean => pointInPolygon(p, ring as Vec2[]);
  const elements = (body.elements ??= []);
  // The boundary's kind and height, from the plan's own.
  const old = elements.filter((e) => BOUNDARY_KINDS.has(e.kind) && e.kind !== 'gate');
  const front = elements.filter((e) => BOUNDARY_KINDS.has(e.kind) && Math.abs(e.y) < m(1.2));
  const kind = (old.find((e) => Math.abs(e.y) >= m(1.2))?.kind ?? old[0]?.kind ?? 'fence') as BuildingElement['kind'];
  const height = old.find((e) => e.kind === kind)?.h ?? m(1.4);
  const thick = kind === 'fence' ? m(0.12) : kind === 'hedge' ? m(0.7) : m(0.2);
  // Everything off the lot, and the side and back boundary, out.
  const kept = elements.filter((e) => (front.includes(e)) || (!BOUNDARY_KINDS.has(e.kind) && inside({ x: e.x, y: e.y })));
  let nextId = Math.max(0, ...elements.map((e) => e.id)) + 1;
  // The new boundary along every side but the front (side 0), in pieces of 20 m at most.
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const full = Math.hypot(b.x - a.x, b.y - a.y);
    if (full < m(0.5) + thick) continue;
    // Short of each corner by half its thickness: a square-ended piece met a
    // corner not quite square (a lot cut to a street a degree off its block)
    // a few millimetres over the line, into the neighbour's yard, and the
    // neighbour - or this lot - was refused (the bare corner lots).
    const ux = (b.x - a.x) / full, uy = (b.y - a.y) / full;
    const len = full - thick;
    const sx = a.x + ux * thick / 2, sy = a.y + uy * thick / 2;
    const pieces = Math.ceil(stepsIn(len, 20));
    const angle = Math.atan2(uy, ux);
    // Set in by half its thickness, so it stands on the lot's side of the line.
    const nx = -uy * thick / 2, ny = ux * thick / 2;
    for (let k = 0; k < pieces; k++) {
      const t = ((k + 0.5) / pieces) * len;
      kept.push({ id: nextId++, kind, x: sx + ux * t + nx, y: sy + uy * t + ny, facing: 0, w: len / pieces, d: thick, z: 0, h: height, angle });
    }
  }
  elements.splice(0, elements.length, ...kept.slice(0, MAX_ELEMENTS));
  // Surfaces clipped to the lot; volumes of the building itself kept where
  // they stand on it.
  const clip = (poly: Vec2[]): Vec2[] => {
    // The lot may be any simple polygon (cut back to a bent street, round a
    // corner): a boolean intersection, the largest piece kept. Clipping by
    // each side's half-plane is right only for a convex lot.
    let best: Vec2[] = [], bestArea = 0;
    for (const piece of intersection([[poly.map((p) => [p.x, p.y])]], [[ring.map((p) => [p.x, p.y])]])) {
      const r = (piece[0] ?? []).map(([x, y]) => ({ x: x!, y: y! }));
      let a = 0;
      for (let i = 0; i < r.length; i++) { const p = r[i]!, q = r[(i + 1) % r.length]!; a += p.x * q.y - q.x * p.y; }
      if (Math.abs(a) > bestArea) { bestArea = Math.abs(a); best = a < 0 ? r.reverse() : r; }
    }
    return best;
  };
  const asOutline = (v: Volume, poly: readonly Vec2[]): void => {
    const px = poly.map((p) => p.x), py = poly.map((p) => p.y);
    v.x = Math.min(...px); v.y = Math.min(...py); v.w = Math.max(...px) - v.x; v.d = Math.max(...py) - v.y;
    v.outline = poly.map((p) => ({ x: (p.x - v.x) / (v.w || 1), y: (p.y - v.y) / (v.d || 1) }));
  };
  const volumes: Volume[] = [];
  const nextVolume = Math.max(0, ...body.volumes.map((v) => v.id)) + 1;
  // The lawn under everything, the lot's own shape - laid first, drawn under the rest.
  const lawnTemplate = body.volumes.find((v) => v.open);
  // A surface cut to a sliver (under 2 m across, or an outline the model
  // cannot hold) is left out: kept, it made the whole building invalid and
  // the lot was left bare.
  const sound = (v: Volume): boolean => v.w >= MIN_SIZE && v.d >= MIN_SIZE && (!v.outline || validOutline(v.outline));
  if (lawnTemplate) {
    const lawn: Volume = { ...JSON.parse(JSON.stringify(lawnTemplate)) as Volume, id: nextVolume, open: 'grass' };
    asOutline(lawn, [...ring]);
    if (sound(lawn)) volumes.push(lawn);
  }
  for (const v of body.volumes) {
    const ringOf = v.outline ? v.outline.map((p) => ({ x: v.x + p.x * v.w, y: v.y + p.y * v.d }))
      : [{ x: v.x, y: v.y }, { x: v.x + v.w, y: v.y }, { x: v.x + v.w, y: v.y + v.d }, { x: v.x, y: v.y + v.d }];
    if (v.open) {
      const cut = clip(ringOf);
      if (cut.length < 3) continue;
      if (cut.length !== 4 || !ringOf.every((p) => inside({ x: p.x * 0.999 + (v.x + v.w / 2) * 0.001, y: p.y * 0.999 + (v.y + v.d / 2) * 0.001 }))) asOutline(v, cut);
      if (sound(v)) volumes.push(v);
    } else if (ringOf.some((p) => inside(p)) || inside({ x: v.x + v.w / 2, y: v.y + v.d / 2 })) volumes.push(v);
  }
  body.volumes.splice(0, body.volumes.length, ...volumes);
}
