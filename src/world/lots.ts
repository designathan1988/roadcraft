import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { Level, type SurfaceLevel, halfWidth } from './roadTypes';
import type { NodeId, SegmentId } from './ids';
import type { Junction } from './junction/build';
import type { NetworkDelta } from './networkDelta';
import type { SegmentRibbon } from './ribbons';
import { type MultiPoly, difference, union } from '@core/clipper';
import { levelRingsOf } from './surfaces';
import { hull, lotCentre, orientedBox, simplifyRing } from './lotRings';
import { offsetRing } from './buildings/footprints';
import { touchesRoad } from './buildings/validate';
import { m, stepsIn } from './units';
import { markPaved, pavedTester, quadsOverlap } from './zoneGrid';
import type { ZoneDensity, ZoneUse } from './zones';
import { rectAround, type Change, type ChangeRect } from './changes';
import { CellFiling, grow } from './cells';
import { lotBox } from './lotStore';
import { LAND, NEAR, PAVED } from './rasterGrid';
import type { BuildingId } from './buildings/types';
import { insideLot, type Lot } from './lotRecord';

/** Lots: the land cut into plots the player zones and buildings grow on, as a town's cadastre is. - A closed block */

/** Depth of a lot along an open street. */
export const LOT_DEPTH = m(32);
/** The frontage a lot aims at: a block's rows and a street's strip are cut into equal lots of about this width */
const LOT_FRONTAGE = m(22);
/** A block deeper than this is cut in two rows, back to back. */
const TWO_ROWS = m(44);
const MIN_LOT = m(10);
const RASTER = m(2);

export { lotCentre } from './lotRings';
export { insideLot, type Lot } from './lotRecord';

export function lotArea(l: Pick<Lot, 'corners'>): number {
  let a = 0;
  const q = l.corners;
  for (let i = 0; i < q.length; i++) { const p = q[i]!, r = q[(i + 1) % q.length]!; a += p.x * r.y - r.x * p.y; }
  return a / 2;
}

/** The lot's frame for a building: front middle, facing angle (along the front), width and depth. */
export function lotFrame(l: Pick<Lot, 'corners'>): { anchor: Vec2; rotation: number; width: number; depth: number } {
  const a = l.corners[0]!, b = l.corners[1]!;
  const width = Math.hypot(b.x - a.x, b.y - a.y);
  const u = { x: (b.x - a.x) / (width || 1), y: (b.y - a.y) / (width || 1) }, n = { x: -u.y, y: u.x };
  // Depth: how far the lot goes back from its front, at the quarter points of the front and its middle
  let depth = Infinity;
  for (const t of [0.25, 0.5, 0.75]) {
    const o = { x: a.x + (b.x - a.x) * t + n.x * 1e-3, y: a.y + (b.y - a.y) * t + n.y * 1e-3 };
    depth = Math.min(depth, rayExit(l.corners, o, n));
  }
  return { anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, rotation: Math.atan2(u.y, u.x), width, depth: Number.isFinite(depth) ? depth : 0 };
}

/** Where a building can stand on a lot */
export function lotBuildFrame(l: Pick<Lot, 'corners'>): { anchor: Vec2; rotation: number; width: number; depth: number } {
  const q = l.corners;
  const a = q[0]!, b = q[1]!;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, n = { x: -u.y, y: u.x };
  const local = q.map((p) => ({ s: (p.x - a.x) * u.x + (p.y - a.y) * u.y, t: (p.x - a.x) * n.x + (p.y - a.y) * n.y }));
  const tMin = Math.min(...local.map((p) => p.t)), tMax = Math.max(...local.map((p) => p.t));
  const N = Math.max(1, Math.min(160, Math.ceil(stepsIn(tMax - tMin, 0.5))));
  const h = (tMax - tMin) / N;
  const L: number[] = [], R: number[] = [];
  const xs: number[] = [];
  for (let k = 0; k < N; k++) {
    const t = tMin + (k + 0.5) * h;
    xs.length = 0;
    for (let i = 0; i < local.length; i++) {
      const p = local[i]!, r = local[(i + 1) % local.length]!;
      if ((p.t > t) === (r.t > t)) continue;
      xs.push(p.s + ((t - p.t) / (r.t - p.t)) * (r.s - p.s));
    }
    // Two crossings (a convex lot, most of them): put in order without a sort.
    if (xs.length === 2) { if (xs[0]! > xs[1]!) { const x = xs[0]!; xs[0] = xs[1]!; xs[1] = x; } } else xs.sort((x, y) => x - y);
    // The widest chord at this depth (a lot of any shape: the main body of it).
    let lo = 0, hi = -1;
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1]! - xs[i]! > hi - lo) { lo = xs[i]!; hi = xs[i + 1]!; }
    L.push(lo); R.push(hi);
  }
  let best = { score: -Infinity, s0: 0, s1: len, t0: 0, t1: 0 };
  // The deepest a rectangle may reach, for the bound below.
  const tEnd = tMin + N * h;
  for (let i = 0; i < N; i++) {
    let lo = -Infinity, hi = Infinity;
    const t0 = tMin + i * h, front = Math.max(0, t0);
    for (let j = i; j < N; j++) {
      lo = Math.max(lo, L[j]!); hi = Math.min(hi, R[j]!);
      if (hi - lo <= 0) break;
      const t1 = tMin + (j + 1) * h;
      const score = (hi - lo) * (t1 - t0) - (hi - lo) * front;
      if (score > best.score) best = { score, s0: lo, s1: hi, t0, t1 };
      // DO NOT walk on past what cannot win: deeper, the chord only narrows, so no later score passes this bound (padded well past rounding: an exact tie or better is still walked to).
      const bound = (hi - lo) * Math.max(0, tEnd - t0 - front);
      if (bound + Math.abs(bound) * 1e-9 + 1e-9 < best.score) break;
    }
  }
  const sm = (best.s0 + best.s1) / 2;
  return {
    anchor: { x: a.x + u.x * sm + n.x * best.t0, y: a.y + u.y * sm + n.y * best.t0 },
    rotation: Math.atan2(u.y, u.x),
    width: Math.max(0, best.s1 - best.s0),
    depth: Math.max(0, best.t1 - best.t0),
  };
}

/** How far a ray from inside a polygon runs before it leaves it. */
function rayExit(q: readonly Vec2[], o: Vec2, d: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!, r = q[(i + 1) % q.length]!;
    const ex = r.x - p.x, ey = r.y - p.y;
    const den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p.x - o.x) * ey - (p.y - o.y) * ex) / den;
    const s = ((p.x - o.x) * d.y - (p.y - o.y) * d.x) / den;
    if (t > 1e-6 && s >= 0 && s <= 1) best = Math.min(best, t);
  }
  return best;
}

interface Candidate { key: string; corners: Vec2[] }

/** The corners in the order a building reads its lot: front-start to front-end with the back on the LEFT of that direction */
function facingCorners<T extends readonly Vec2[]>(c: T): Vec2[] {
  // Counter-clockwise keeps the inside on the left of every side; reversed, the front side keeps its two corners, swapped.
  if (lotArea({ corners: c }) >= 0) return [...c];
  return [c[1]!, c[0]!, ...[...c.slice(2)].reverse()];
}

/** New lots for land with none yet, and the lots the paving now covers. */
export interface LotPlan {
  add: Candidate[];
  /** The land not cut into lots yet, by key (a key the document knows is left out). */
  keys: string[];
  drop: number[];
  /** Where the land of each key lies (`keys[i]`'s at `keyRects[i]`): a key new to the document is written in the diary there */
  keyRects?: ChangeRect[];
}

/** Each network's planner, following that network's changes and its document's lots (`LotPlanner`). */
const planners = new WeakMap<Network, LotPlanner>();

/** DO NOT plan the whole map again after an edit: the land the diaries say changed is planned again, the rest kept */
export function planLots(doc: RoadDoc, net: Network): LotPlan {
  let planner = planners.get(net);
  if (!planner || planner.doc !== doc) planners.set(net, planner = new LotPlanner(doc, net));
  return planner.update();
}

/** A network's planner let go (`planLots` makes it again when asked): a city generated once (`editor/smallCityMap.ts`), whose land is planned once while its network lives on for the growth - its rasters and blocks held for nothing (17 MB of the city of 25,000 buildings, 2026-10-22). */
export function forgetLotPlans(net: Network): void {
  planners.delete(net);
}

/** The work of the lots' plans: raster tiles made, land cells flooded, blocks and streets planned. A count for the scale specs. */
export const lotPlanWork = { tiles: 0, cells: 0, planned: 0 };

/** Side of a tile of the land's raster, in raster cells (128 m). */
const TILE = 64;
const TILE_SIDE = TILE * RASTER;
/** Land wider or deeper than this is open land, never a block: it bounds every flood of the land (a tile of the world's grid). */
const MAX_BLOCK = m(1024);
/** How far round a street's box its land is asked whether it is paved: a lot's depth and a street's width more. */
const PAD = LOT_DEPTH + m(20);
/** How far past a street's filed bounds its strip reads the land and the lots (`streetPlan`'s reach, with a margin). */
const STREET_GROW = LOT_DEPTH + m(6);
/** How far a piece of land too small for a block reaches at most: fewer cells than a block's least area holds. */
const SMALL_PIECE = (MIN_LOT * MIN_LOT * 2) / RASTER;
/** A cell's four neighbours. */
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
/** Side of the grid the proposed lots are filed in: a few lots wide. */
const FIT_CELL = m(64);

const tileKey = (ti: number, tj: number): number => (ti + 32768) * 65536 + (tj + 32768);
const tileRect = (key: number): ChangeRect => {
  const ti = Math.floor(key / 65536) - 32768, tj = (key % 65536) - 32768;
  return [ti * TILE_SIDE, tj * TILE_SIDE, (ti + 1) * TILE_SIDE, (tj + 1) * TILE_SIDE];
};

/** Calls `visit` with every tile a rectangle reaches. */
function forTiles(rect: ChangeRect, visit: (key: number) => void): void {
  for (let ti = Math.floor(rect[0] / TILE_SIDE); ti <= Math.floor(rect[2] / TILE_SIDE); ti++) {
    for (let tj = Math.floor(rect[1] / TILE_SIDE); tj <= Math.floor(rect[3] / TILE_SIDE); tj++) visit(tileKey(ti, tj));
  }
}

/** Whether a rectangle reaches one of these tiles. */
function reachesTiles(rect: ChangeRect, tiles: ReadonlySet<number>): boolean {
  let found = false;
  forTiles(rect, (key) => { if (tiles.has(key)) found = true; });
  return found;
}

const meets = (a: ChangeRect, b: ChangeRect): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const meetsInside = (a: ChangeRect, b: ChangeRect): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const sameRect = (a: ChangeRect | undefined, b: ChangeRect | undefined): boolean =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]);
const spanOf = (a: ChangeRect, b: ChangeRect): ChangeRect =>
  [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** Whether a street's land is planned: a ground street with footways. */
const plannedStreet = (doc: RoadDoc, r: SegmentRibbon): boolean =>
  doc.segment(r.id)?.structure === 'ground' && carriesPedestrians(r.road);

/** Whether the paving covers a stored lot: its centre, or a corner a little in from it. */
function coveredBy(paved: (p: Vec2) => boolean, l: Lot): boolean {
  const c = lotCentre(l);
  return paved(c) || l.corners.some((q) => paved({ x: q.x + (c.x - q.x) * 0.15, y: q.y + (c.y - q.y) * 0.15 }));
}

/** DO NOT ask the paving of the whole map for each plan: the land's raster in tiles, each made once and asked again only where the network changed */
class LandPaving {
  /** Each tile's paved cells, a bit each; null: no planned street near it, all land. */
  private readonly tiles = new Map<number, Uint8Array | null>();
  private lastKey = Number.NaN;
  private lastBits: Uint8Array | null = null;

  constructor(private readonly doc: RoadDoc, private readonly net: Network) {}

  clear(): void {
    this.tiles.clear();
    this.lastKey = Number.NaN;
  }

  forget(key: number): void {
    this.tiles.delete(key);
    this.lastKey = Number.NaN;
  }

  /** Whether raster cell (ci, cj) is paved: its centre on a carriageway, a footway or a junction's plate (`markPaved`). */
  paved(ci: number, cj: number): boolean {
    const ti = Math.floor(ci / TILE), tj = Math.floor(cj / TILE);
    const key = tileKey(ti, tj);
    if (key !== this.lastKey) {
      this.lastBits = this.tile(ti, tj, key);
      this.lastKey = key;
    }
    const bits = this.lastBits;
    if (!bits) return false;
    const k = (cj - tj * TILE) * TILE + (ci - ti * TILE);
    return (bits[k >> 3]! & (1 << (k & 7))) !== 0;
  }

  /** A tile's paved cells: only the cells within a planned street's box are asked, the rest is land. */
  private tile(ti: number, tj: number, key: number): Uint8Array | null {
    const known = this.tiles.get(key);
    if (known !== undefined) return known;
    const { doc, net } = this;
    const minX = ti * TILE_SIDE, minY = tj * TILE_SIDE;
    const label = new Int32Array(TILE * TILE).fill(LAND);
    let near = false;
    for (const id of net.segmentCells.idsMeeting(grow([minX, minY, minX + TILE_SIDE, minY + TILE_SIDE], PAD))) {
      const ribbon = net.ribbons.get(id);
      if (!ribbon || !plannedStreet(doc, ribbon)) continue;
      const bb = ribbon.full.bbox;
      const i0 = Math.max(0, Math.floor((bb.minX - PAD - minX) / RASTER)), i1 = Math.min(TILE - 1, Math.floor((bb.maxX + PAD - minX) / RASTER));
      const j0 = Math.max(0, Math.floor((bb.minY - PAD - minY) / RASTER)), j1 = Math.min(TILE - 1, Math.floor((bb.maxY + PAD - minY) / RASTER));
      if (i0 > i1 || j0 > j1) continue;
      near = true;
      for (let j = j0; j <= j1; j++) label.fill(NEAR, j * TILE + i0, j * TILE + i1 + 1);
    }
    lotPlanWork.tiles++;
    let bits: Uint8Array | null = null;
    if (near) {
      const steps = markPaved(doc, net, { minX, minY, W: TILE, H: TILE, step: RASTER }, label);
      while (!steps.next().done) { /* the whole tile at once */ }
      bits = new Uint8Array((TILE * TILE) >> 3);
      for (let k = 0; k < label.length; k++) if (label[k] === PAVED) bits[k >> 3]! |= 1 << (k & 7);
    }
    this.tiles.set(key, bits);
    return bits;
  }
}

/** A piece of land: cells joined side to side, none paved. */
interface LandPiece {
  /** No block: wider or deeper than `MAX_BLOCK`, or joined to land that is. */
  open: boolean;
  count: number;
  ci0: number; ci1: number; cj0: number; cj1: number;
  /** Its first cell, row by row: the order the blocks are planned in. */
  firstI: number; firstJ: number;
  /** Each row's first and last cell. */
  readonly rows: Map<number, [number, number]>;
}

/** The land's pieces for one plan, labelled where asked: each piece flooded once, from the first of its cells asked */
class LandLabels {
  readonly pieces: LandPiece[] = [];
  /** Each tile's cells: their piece + 1, 0 while not labelled. */
  private readonly labels = new Map<number, Int32Array>();
  private lastKey = Number.NaN;
  private lastTile: Int32Array | undefined = undefined;

  constructor(private readonly paving: LandPaving) {}

  /** The piece a cell was labelled in, or -1. */
  label(ci: number, cj: number): number {
    const tile = this.tileOf(ci, cj, false);
    return tile ? tile[cellIndex(ci, cj)]! - 1 : -1;
  }

  /** The piece of land holding a cell, flooded the first time it is asked; -1 for a paved cell. */
  pieceAt(ci: number, cj: number): number {
    if (this.paving.paved(ci, cj)) return -1;
    const known = this.label(ci, cj);
    return known >= 0 ? known : this.flood(ci, cj);
  }

  /** The piece under a point (`pieceAt`). */
  pieceUnder(p: Vec2): number {
    return this.pieceAt(Math.floor(p.x / RASTER), Math.floor(p.y / RASTER));
  }

  /** The piece a point's cell was labelled in, never flooding: -1 when it is paved or not labelled. */
  labelUnder(p: Vec2): number {
    const ci = Math.floor(p.x / RASTER), cj = Math.floor(p.y / RASTER);
    return this.paving.paved(ci, cj) ? -1 : this.label(ci, cj);
  }

  /** Every piece with a cell in a tile flooded, each told to `visit` as it is made. */
  scanTile(key: number, visit: (id: number) => void): void {
    const ti = Math.floor(key / 65536) - 32768, tj = (key % 65536) - 32768;
    for (let j = 0; j < TILE; j++) {
      for (let i = 0; i < TILE; i++) {
        const ci = ti * TILE + i, cj = tj * TILE + j;
        if (this.label(ci, cj) < 0 && !this.paving.paved(ci, cj)) visit(this.flood(ci, cj));
      }
    }
  }

  private tileOf(ci: number, cj: number, make: boolean): Int32Array | undefined {
    const key = tileKey(Math.floor(ci / TILE), Math.floor(cj / TILE));
    if (key === this.lastKey && (this.lastTile || !make)) return this.lastTile;
    let tile = this.labels.get(key);
    if (!tile && make) this.labels.set(key, tile = new Int32Array(TILE * TILE));
    this.lastKey = key;
    this.lastTile = tile;
    return tile;
  }

  /** DO NOT flood without a bound: the open land round a town is the whole plane */
  private flood(ci0: number, cj0: number): number {
    const id = this.pieces.length;
    const piece: LandPiece = { open: false, count: 0, ci0, ci1: ci0, cj0, cj1: cj0, firstI: ci0, firstJ: cj0, rows: new Map() };
    this.pieces.push(piece);
    const cap = MAX_BLOCK / RASTER;
    const xs = [ci0], ys = [cj0];
    this.tileOf(ci0, cj0, true)![cellIndex(ci0, cj0)] = id + 1;
    fill: while (xs.length) {
      const ci = xs.pop()!, cj = ys.pop()!;
      lotPlanWork.cells++;
      piece.count++;
      if (ci < piece.ci0) piece.ci0 = ci;
      if (ci > piece.ci1) piece.ci1 = ci;
      if (cj < piece.cj0) piece.cj0 = cj;
      if (cj > piece.cj1) piece.cj1 = cj;
      if (cj < piece.firstJ || (cj === piece.firstJ && ci < piece.firstI)) { piece.firstJ = cj; piece.firstI = ci; }
      const row = piece.rows.get(cj);
      if (!row) piece.rows.set(cj, [ci, ci]);
      else { if (ci < row[0]) row[0] = ci; if (ci > row[1]) row[1] = ci; }
      if (piece.ci1 - piece.ci0 >= cap || piece.cj1 - piece.cj0 >= cap) { piece.open = true; break; }
      for (const [di, dj] of SIDES) {
        const ni = ci + di, nj = cj + dj;
        if (this.paving.paved(ni, nj)) continue;
        const other = this.label(ni, nj);
        if (other === id) continue;
        // Land already labelled is a piece cut short at the bound: open land, and this one with it.
        if (other >= 0) { piece.open = true; break fill; }
        this.tileOf(ni, nj, true)![cellIndex(ni, nj)] = id + 1;
        xs.push(ni); ys.push(nj);
      }
    }
    return id;
  }
}

/** A cell's place in its tile. */
const cellIndex = (ci: number, cj: number): number =>
  (cj - Math.floor(cj / TILE) * TILE) * TILE + (ci - Math.floor(ci / TILE) * TILE);

/** A place in the plan's order: blocks by their first cell, row by row, then streets by id (the order the whole map is planned in). */
type PlanOrder = readonly [number, number, number];
const compareOrder = (a: PlanOrder, b: PlanOrder): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** A lot the plan proposes, with its box. */
interface PlannedLot { readonly key: string; readonly corners: Vec2[]; readonly box: ChangeRect }

/** What a block or a street plans: its land's keys and the lots it proposes. */
interface Planned {
  /** Where what it plans reads the lots and the plan. */
  readonly reach: ChangeRect;
  /** A block's piece of land: its first cell and the rectangle of its cells; null for a street. */
  readonly piece: { readonly ci: number; readonly cj: number; readonly rect: ChangeRect } | null;
  readonly segment: SegmentId | null;
  readonly keys: readonly string[];
  readonly keyRects: readonly ChangeRect[];
  readonly made: readonly PlannedLot[];
}

/** A block or a street kept in the plan. */
interface PlanSource extends Planned {
  readonly id: number;
  readonly slot: string;
  readonly order: PlanOrder;
  /** Its lots' ids in the plan's filing. */
  readonly lotIds: readonly number[];
}

/** A proposed lot filed by place, with its place in the plan's order. */
interface FiledLot { readonly lot: PlannedLot; readonly order: PlanOrder; readonly index: number }

/** A block or a street to plan: a block by its piece (or, null, by its first cell asked again), a street by its id. */
interface PlanWork { readonly slot: string; readonly order: PlanOrder; block: number | null; readonly segment: SegmentId | null }

/** The work of planning a piece of land as a block, or null when it is no block (open, or too small). */
function blockWork(labels: LandLabels, id: number): PlanWork | null {
  const piece = labels.pieces[id]!;
  if (piece.open || piece.count * RASTER * RASTER < MIN_LOT * MIN_LOT * 2) return null;
  return { slot: `b${piece.firstJ},${piece.firstI}`, order: [0, piece.firstJ, piece.firstI], block: id, segment: null };
}
const streetWork = (id: SegmentId): PlanWork => ({ slot: `s${id}`, order: [1, id, 0], block: null, segment: id });
const workFor = (s: PlanSource): PlanWork => ({ slot: s.slot, order: s.order, block: null, segment: s.segment });

/** Whether two plans propose the same lots, corner for corner. */
const sameMade = (a: readonly PlannedLot[], b: readonly PlannedLot[]): boolean =>
  a.length === b.length && a.every((lot, i) => {
    const other = b[i]!;
    return lot.key === other.key && lot.corners.length === other.corners.length &&
      lot.corners.every((q, k) => q.x === other.corners[k]!.x && q.y === other.corners[k]!.y);
  });

/** DO NOT plan the whole map for each edit: the plan kept by block and by street, each planned again where the network or the lots changed */
class LotPlanner {
  private readonly paving: LandPaving;
  /** The network's state the plan stands on (`Network.changesSince`). */
  private netState: object | null = null;
  /** The diary's serial the plan has read the lots up to, -1 before the first plan; not followed: a plan left long unasked plans whole. */
  private seen = -1;
  private nextId = 1;
  private readonly slots = new Map<string, PlanSource>();
  private readonly byId = new Map<number, PlanSource>();
  /** The blocks and streets by where they read (`Planned.reach`, and a block's land). */
  private sourceCells = new CellFiling<number, PlanSource>();
  private readonly filed = new Map<number, FiledLot>();
  private lotCells = new CellFiling<number, FiledLot>(FIT_CELL);
  /** The blocks and streets with a key the document does not know yet: what the plan hands out. */
  private readonly unknown = new Set<PlanSource>();
  /** The stored lots the paving covers. */
  private readonly dropped = new Set<number>();

  constructor(readonly doc: RoadDoc, private readonly net: Network) {
    this.paving = new LandPaving(doc, net);
  }

  /** The plan for the land as it is now: planned again only where the network and the lots changed since the last. */
  update(): LotPlan {
    const delta = this.netState === null ? null : this.net.changesSince(this.netState);
    this.netState = this.net.state;
    const entries = this.seen < 0 ? null : this.doc.changes.since(this.seen, ['lots', 'lotKeys']);
    this.seen = this.doc.changes.version;
    if (delta === null || entries === null || entries.some((e) => e.rects === null || (e.kind === 'lots' && !e.ids))) this.planAll();
    else if (delta.segments.size || delta.nodes.size || delta.rects.length || entries.length) this.planChanged(delta, entries);
    return this.result();
  }

  /** @rebuild The whole map planned: the first plan, a map loaded, or a change the diaries cannot place. */
  private planAll(): void {
    const { doc, net } = this;
    this.paving.clear();
    this.slots.clear();
    this.byId.clear();
    this.filed.clear();
    this.unknown.clear();
    this.dropped.clear();
    this.sourceCells = new CellFiling<number, PlanSource>();
    this.lotCells = new CellFiling<number, FiledLot>(FIT_CELL);
    const paved = this.pavedTest();
    for (const lot of doc.lotStore.all()) if (coveredBy(paved, lot)) this.dropped.add(lot.id);
    const labels = new LandLabels(this.paving);
    const streets: SegmentId[] = [];
    const tiles = new Set<number>();
    for (const id of [...doc.segments.keys()].sort((a, b) => a - b)) {
      const ribbon = net.ribbons.get(id);
      if (!ribbon || !plannedStreet(doc, ribbon)) continue;
      streets.push(id);
      const bb = ribbon.full.bbox;
      forTiles([bb.minX - PAD, bb.minY - PAD, bb.maxX + PAD, bb.maxY + PAD], (key) => tiles.add(key));
    }
    // Every closed piece of land round the streets, in order, then every street
    const work: PlanWork[] = [];
    for (const key of tiles) labels.scanTile(key, (id) => { const w = blockWork(labels, id); if (w) work.push(w); });
    work.sort((a, b) => compareOrder(a.order, b.order));
    for (const id of streets) work.push(streetWork(id));
    this.run(work, labels, paved, false);
  }

  /** The blocks and streets the network's changes and the lots' entries reach, planned again in order */
  private planChanged(delta: NetworkDelta, entries: readonly Change[]): void {
    const { doc, net } = this;
    const store = doc.lotStore;
    // Where the paving may have moved: what the network built again, before and after
    const moved: ChangeRect[] = [...delta.rects];
    for (const id of delta.segments) { const r = net.segmentCells.rectOf(id); if (r) moved.push(r); }
    for (const id of delta.nodes) {
      const r = net.junctionCells.rectOf(id);
      if (r) moved.push(r);
      const node = doc.node(id);
      if (node) moved.push([node.x, node.y, node.x, node.y]);
    }
    // The tiles whose cells may have changed, and their neighbours'
    const tiles = new Set<number>();
    for (const r of moved) forTiles(grow(r, PAD + 2 * RASTER), (key) => tiles.add(key));
    for (const key of tiles) this.paving.forget(key);
    const paved = this.pavedTest();
    // The stored lots the paving or an edit reached: covered or not now
    const lotRects: ChangeRect[] = [];
    const keyRects: ChangeRect[] = [];
    const recheck = new Set<number>();
    for (const r of moved) for (const lot of doc.lotsIn(r)) recheck.add(lot.id);
    for (const e of entries) {
      if (e.kind === 'lotKeys') { keyRects.push(...e.rects!); continue; }
      lotRects.push(...e.rects!);
      for (const id of e.ids!) recheck.add(id);
    }
    for (const id of recheck) {
      const lot = store.get(id);
      const was = this.dropped.has(id), now = !!lot && coveredBy(paved, lot);
      if (now) this.dropped.add(id); else this.dropped.delete(id);
      if (lot && was !== now) lotRects.push(lotBox(lot));
    }
    const labels = new LandLabels(this.paving);
    const work = new Map<string, PlanWork>();
    const put = (w: PlanWork): void => {
      const known = work.get(w.slot);
      if (!known) work.set(w.slot, w);
      else if (w.block !== null) known.block = w.block;
    };
    const tileRects = [...tiles].map(tileRect);
    // The blocks whose land reaches those tiles, asked again from their first cell
    for (const sid of this.sourceCells.idsMeetingAny(tileRects)) {
      const s = this.byId.get(sid)!;
      if (s.piece && reachesTiles(s.piece.rect, tiles)) put(workFor(s));
    }
    // Every piece of land with a cell there: the blocks it holds now
    for (const key of tiles) labels.scanTile(key, (id) => { const w = blockWork(labels, id); if (w) put(w); });
    // The streets by those tiles (a small piece's land reaches past them), and those the network changed
    for (const id of net.segmentCells.idsMeetingAny(tileRects.map((r) => grow(r, STREET_GROW + SMALL_PIECE)))) put(streetWork(id));
    for (const id of delta.segments) put(streetWork(id));
    // Whatever reads the lots or the keys that changed
    const read = [...lotRects, ...keyRects];
    if (read.length) {
      for (const sid of this.sourceCells.idsMeetingAny(read)) {
        const s = this.byId.get(sid)!;
        if (read.some((r) => meets(s.reach, r))) put(workFor(s));
      }
    }
    this.run([...work.values()].sort((a, b) => compareOrder(a.order, b.order)), labels, paved, true);
  }

  /** Plans each block and street of `list` in order; `follow`: what a changed one reaches later in the order is planned again too */
  private run(list: PlanWork[], labels: LandLabels, paved: (p: Vec2) => boolean, follow: boolean): void {
    const queued = new Map<string, PlanWork>();
    for (const w of list) queued.set(w.slot, w);
    const enqueue = (w: PlanWork, after: PlanOrder): void => {
      if (compareOrder(w.order, after) <= 0) return;
      const known = queued.get(w.slot);
      if (known) {
        if (w.block !== null && known.block === null) known.block = w.block;
        return;
      }
      queued.set(w.slot, w);
      let lo = 0, hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareOrder(list[mid]!.order, w.order) <= 0) lo = mid + 1; else hi = mid;
      }
      list.splice(lo, 0, w);
    };
    for (let at = 0; at < list.length; at++) {
      const item = list[at]!;
      lotPlanWork.planned++;
      const old = this.slots.get(item.slot);
      const now = this.plan(item, old, labels, paved);
      if (old) this.uninstall(old);
      if (now && now.keys.length) this.install(item, now);
      if (!follow) continue;
      // A block that came, went or changed its land: the streets round it read whether that land is open
      if (item.segment === null && !sameRect(old?.piece?.rect, now?.piece?.rect)) {
        for (const rect of [old?.piece?.rect, now?.piece?.rect]) {
          if (rect) for (const id of this.net.segmentCells.idsMeeting(grow(rect, STREET_GROW))) enqueue(streetWork(id), item.order);
        }
      }
      // Lots proposed otherwise: the blocks and streets after it that fit round them
      const was = old?.made ?? [], made = now?.made ?? [];
      if (sameMade(was, made)) continue;
      const boxes = [...was, ...made].map((lot) => lot.box);
      for (const sid of this.sourceCells.idsMeetingAny(boxes)) {
        const s = this.byId.get(sid)!;
        if (boxes.some((r) => meets(s.reach, r))) enqueue(workFor(s), item.order);
      }
    }
  }

  /** What a block or a street plans now, or null when there is none there. */
  private plan(item: PlanWork, old: PlanSource | undefined, labels: LandLabels, paved: (p: Vec2) => boolean): Planned | null {
    if (item.segment !== null) return this.streetPlan(item.segment, item.order, labels, paved);
    const id = item.block ?? (old?.piece ? labels.pieceAt(old.piece.ci, old.piece.cj) : -1);
    if (id < 0) return null;
    const piece = labels.pieces[id]!;
    // A block is named by its first cell: a piece with another first cell is another block, planned in its own place
    if (piece.open || piece.firstJ !== item.order[1] || piece.firstI !== item.order[2]) return null;
    return this.blockPlan(item.order, id, labels, paved);
  }

  private install(item: PlanWork, planned: Planned): void {
    const lotIds: number[] = [];
    const source: PlanSource = { ...planned, id: this.nextId++, slot: item.slot, order: item.order, lotIds };
    planned.made.forEach((lot, index) => {
      const id = this.nextId++;
      const filed: FiledLot = { lot, order: item.order, index };
      lotIds.push(id);
      this.filed.set(id, filed);
      this.lotCells.file(id, filed, lot.box);
    });
    this.slots.set(source.slot, source);
    this.byId.set(source.id, source);
    this.sourceCells.file(source.id, source, source.piece ? spanOf(source.reach, source.piece.rect) : source.reach);
    if (source.keys.some((key) => !this.doc.lotStore.hasKey(key))) this.unknown.add(source);
  }

  private uninstall(source: PlanSource): void {
    this.slots.delete(source.slot);
    this.byId.delete(source.id);
    this.sourceCells.remove(source.id);
    this.unknown.delete(source);
    for (const id of source.lotIds) {
      this.filed.delete(id);
      this.lotCells.remove(id);
    }
  }

  /** The plan handed out: the land not cut yet and its proposed lots, in the plan's order, and the lots the paving covers. */
  private result(): LotPlan {
    const store = this.doc.lotStore;
    const add: Candidate[] = [], keys: string[] = [], keyRects: ChangeRect[] = [];
    for (const source of [...this.unknown].sort((a, b) => compareOrder(a.order, b.order))) {
      source.keys.forEach((key, i) => {
        if (store.hasKey(key)) return;
        keys.push(key);
        keyRects.push(source.keyRects[i]!);
      });
      for (const lot of source.made) add.push({ key: lot.key, corners: lot.corners });
    }
    const drop = [...this.dropped].filter((id) => store.has(id)).sort((a, b) => store.orderOf(a)! - store.orderOf(b)!);
    return { add, keys, drop, keyRects };
  }

  private pavedTest(): (p: Vec2) => boolean {
    const { onRoad, onPlate } = pavedTester(this.doc, this.net);
    return (p) => onRoad(p) || onPlate(p);
  }

  /** The lots a plan in `order` fits round in `box`: the kept lots in the store's order, the plan's earlier lots, then its own */
  private around(box: ChangeRect, order: PlanOrder, own: readonly PlannedLot[], keptOnly: boolean, inside: boolean): Vec2[][] {
    const store = this.doc.lotStore;
    const hit = inside ? meetsInside : meets;
    const out = this.doc.lotsIn(box).filter((l) => !this.dropped.has(l.id) && hit(lotBox(l), box))
      .sort((p, q) => store.orderOf(p.id)! - store.orderOf(q.id)!).map((l) => l.corners as Vec2[]);
    if (keptOnly) return out;
    const earlier = this.lotCells.idsMeeting(box).map((id) => this.filed.get(id)!)
      .filter((f) => compareOrder(f.order, order) < 0 && hit(f.lot.box, box))
      .sort((p, q) => compareOrder(p.order, q.order) || p.index - q.index);
    for (const f of earlier) out.push(f.lot.corners);
    for (const lot of own) if (hit(lot.box, box)) out.push(lot.corners);
    return out;
  }

  /** A new lot made to fit round the lots already there: what of it lies on one is cut away */
  private fitFree(corners: Vec2[], order: PlanOrder, own: readonly PlannedLot[]): Vec2[] | null {
    const box = rectAround(corners);
    if (!box) return null;
    const touching = this.around(box, order, own, false, true);
    if (!touching.length) return corners;
    const whole = Math.abs(lotArea({ corners }));
    let best: Vec2[] | null = null, bestArea = 0;
    for (const poly of difference([[corners.map((p) => [p.x, p.y])]], touching.map((q) => [q.map((p) => [p.x, p.y])]))) {
      const ring = (poly[0] ?? []).map(([x, y]) => ({ x: x!, y: y! }));
      const a = Math.abs(lotArea({ corners: ring }));
      if (ring.length >= 3 && a > bestArea) { bestArea = a; best = ring; }
    }
    if (!best || bestArea < whole * 0.6) return bestArea > whole - m(0.5) * m(0.5) ? corners : null;
    if (bestArea > whole - m(0.3) * m(0.3)) return corners;
    return facingCorners(withFront(simplifyRing(best, m(0.01)), [corners[0]!, corners[1]!]));
  }

  /** A closed piece of land planned as a block: its key, and its rows cut into lots round the lots already there */
  private blockPlan(order: PlanOrder, id: number, labels: LandLabels, paved: (p: Vec2) => boolean): Planned | null {
    const piece = labels.pieces[id]!;
    if (piece.count * RASTER * RASTER < MIN_LOT * MIN_LOT * 2) return null;
    // The hull of the piece's cell centres is the hull of each row's first and last
    const pts: Vec2[] = [];
    for (let j = piece.cj0; j <= piece.cj1; j++) {
      const row = piece.rows.get(j);
      if (!row) continue;
      const y = (j + 0.5) * RASTER;
      pts.push({ x: (row[0] + 0.5) * RASTER, y });
      if (row[1] !== row[0]) pts.push({ x: (row[1] + 0.5) * RASTER, y });
    }
    const box = orientedBox(hull(pts));
    const key = `b:${Math.round(stepsIn(box.c.x, 4))},${Math.round(stepsIn(box.c.y, 4))},${Math.round(stepsIn(box.L, 4))},${Math.round(stepsIn(box.D, 4))}`;
    // Grow the raster box by half a raster cell: its points are cell centres.
    const L = box.L + RASTER, D = box.D + RASTER;
    const at = (s: number, t: number): Vec2 => ({ x: box.c.x + box.u.x * s + box.v.x * t, y: box.c.y + box.u.y * s + box.v.y * t });
    const keyRect = rectAround([at(-L / 2, -D / 2), at(L / 2, -D / 2), at(L / 2, D / 2), at(-L / 2, D / 2)])!;
    const made: PlannedLot[] = [];
    const rect: ChangeRect = [piece.ci0 * RASTER, piece.cj0 * RASTER, (piece.ci1 + 1) * RASTER, (piece.cj1 + 1) * RASTER];
    // The block's box grown by a lot's reach past it: where its rows read the lots, and where its own lots lie
    const blockBox = grow(keyRect, m(4));
    const planned: Planned = { reach: blockBox, piece: { ci: piece.firstI, cj: piece.firstJ, rect }, segment: null, keys: [key], keyRects: [keyRect], made };
    if (this.doc.lotStore.hasKey(key)) return planned;
    const rows = D >= TWO_ROWS ? 2 : 1;
    const depth = D / rows;
    const columns = Math.max(1, Math.round(L / Math.max(MIN_LOT, Math.min(depth, LOT_FRONTAGE))));
    const width = L / columns;
    // The block's frame for a point: along its length (s) and across it (t).
    const frame = (q: Vec2): { s: number; t: number } => {
      const dx = q.x - box.c.x, dy = q.y - box.c.y;
      return { s: dx * box.u.x + dy * box.u.y, t: dx * box.v.x + dy * box.v.y };
    };
    // The kept lots over the block's box (a lot off it takes no span of it).
    const kept = this.around(blockBox, order, made, true, false);
    /** A row's lots, as spans along the block: the row cut in equal columns, except where stored lots already stand in it */
    const rowSpans = (r: number): [number, number][] => {
      const t0 = -D / 2 + r * depth, t1 = t0 + depth;
      const taken: [number, number][] = [];
      for (const corners of kept) {
        const q = corners.map((p) => frame(p));
        const lt0 = Math.min(...q.map((p) => p.t)), lt1 = Math.max(...q.map((p) => p.t));
        if (Math.min(lt1, t1) - Math.max(lt0, t0) < depth * 0.25) continue;
        const ls0 = Math.min(...q.map((p) => p.s)), ls1 = Math.max(...q.map((p) => p.s));
        if (ls1 > -L / 2 && ls0 < L / 2) taken.push([ls0, ls1]);
      }
      return cutSpans(freeSpans(-L / 2, L / 2, taken, MIN_LOT), width);
    };
    for (let r = 0; r < rows; r++) for (const [s0, s1] of rowSpans(r)) {
      const t0 = -D / 2 + r * depth, t1 = t0 + depth;
      // The front faces the street: the row's outer long edge (one row: the side nearer a street).
      const towardMinus = rows === 2 ? r === 0 : nearerStreet(at, s0, s1, -D / 2, D / 2, paved);
      // Reaching past the street sides (the front, a single row's back, the block's two ends) by a little
      const reach = m(2.5), edge = 1e-6;
      const a0 = s0 <= -L / 2 + edge ? s0 - reach : s0, a1 = s1 >= L / 2 - edge ? s1 + reach : s1;
      const b0 = towardMinus || rows === 1 ? t0 - reach : t0, b1 = !towardMinus || rows === 1 ? t1 + reach : t1;
      const corners: [Vec2, Vec2, Vec2, Vec2] = towardMinus
        ? [at(a1, b0), at(a0, b0), at(a0, b1), at(a1, b1)]
        : [at(a0, b1), at(a1, b1), at(a1, b0), at(a0, b0)];
      // Most of it on this block's land, and cut back to it: a block that is no rectangle
      let inside = 0, total = 0;
      for (let a = 0.1; a < 1; a += 0.2) for (let b = 0.1; b < 1; b += 0.2) {
        total++;
        if (labels.labelUnder(at(s0 + (s1 - s0) * a, t0 + (t1 - t0) * b)) === id) inside++;
      }
      if (inside / total < 0.5) continue;
      const land = landLot(this.net, corners);
      const fit = land && this.fitFree(land, order, made);
      if (fit) made.push({ key, corners: fit, box: rectAround(fit)! });
    }
    return planned;
  }

  /** Open land along a street: a continuous strip each side, cut in equal lots (no snap afterwards: each lot is cut to the land) */
  private streetPlan(segId: SegmentId, order: PlanOrder, labels: LandLabels, paved: (p: Vec2) => boolean): Planned | null {
    const { doc, net } = this;
    const ribbon = net.ribbons.get(segId);
    if (!ribbon || !plannedStreet(doc, ribbon)) return null;
    const line = ribbon.full;
    const face = halfWidth(ribbon.road, Level.Sidewalk) + m(0.3);
    const length = line.length;
    const keys: string[] = [], keyRects: ChangeRect[] = [], made: PlannedLot[] = [];
    // Open land: a piece of land that is no block.
    const open = (p: Vec2): boolean => {
      const id = labels.pieceUnder(p);
      return id >= 0 && labels.pieces[id]!.open;
    };
    for (const side of [1, -1] as const) {
      const point = (s: number, d: number): Vec2 => {
        const f = line.sampleAt(Math.max(0, Math.min(length, s)));
        return { x: f.p.x - f.t.y * side * d, y: f.p.y + f.t.x * side * d };
      };
      // Runs of street where the land just behind the footway is open land.
      const step = m(1);
      const runs: [number, number][] = [];
      let from = -1;
      for (let s = 0; s <= length; s += step) {
        const p = point(s, face + m(1.5)), q = point(s, face + LOT_DEPTH - m(1));
        const ok = open(p) && !paved(p) && !paved(q);
        if (ok && from < 0) from = s;
        if ((!ok || s + step > length) && from >= 0) { runs.push([from, ok ? s : s - step]); from = -1; }
      }
      for (const [s0, s1] of runs) {
        const len = s1 - s0;
        if (len < MIN_LOT) continue;
        const mid = point((s0 + s1) / 2, face);
        const key = `s:${Math.round(stepsIn(mid.x, 4))},${Math.round(stepsIn(mid.y, 4))},${Math.round(stepsIn(len, 4))}`;
        keys.push(key);
        // The strip's land: its two edges sampled along it (a bent street bulges).
        const edge: Vec2[] = [];
        for (let k = 0, n = Math.max(1, Math.ceil(len / LOT_FRONTAGE)); k <= n; k++) {
          const s = s0 + (len * k) / n;
          edge.push(point(s, face - m(1)), point(s, face + LOT_DEPTH));
        }
        keyRects.push(rectAround(edge)!);
        if (doc.lotStore.hasKey(key)) continue;
        // Cut in equal lots, round the lots already there: a corner lot of a cross street's strip, or a stored lot.
        const taken: [number, number][] = [];
        // The lots there (kept and planned before), by the strip's box: its two edges along the run, a lot's reach round them.
        const stripBox = grow(rectAround(edge)!, m(4));
        for (const corners of this.around(stripBox, order, made, false, false)) {
          let near = false, ls0 = Infinity, ls1 = -Infinity;
          for (const q of corners) {
            const c = line.closestPoint(q);
            const f = line.sampleAt(c.s);
            // Across the street, on this side: positive on the side's left.
            const across = ((q.x - f.p.x) * -f.t.y + (q.y - f.p.y) * f.t.x) * side;
            if (across > face - m(1) && across < face + LOT_DEPTH + m(1)) near = true;
            ls0 = Math.min(ls0, c.s); ls1 = Math.max(ls1, c.s);
          }
          // Inside the strip: a corner in its band, and not a lot merely touching its far end.
          if (near && ls1 > s0 + m(0.5) && ls0 < s1 - m(0.5)) taken.push([ls0, ls1]);
        }
        for (const [a, b] of cutSpans(freeSpans(s0, s1, taken, MIN_LOT), LOT_FRONTAGE)) {
          // Facing the street: front-start, front-end along the street's direction on its left, against it on its right.
          const corners: [Vec2, Vec2, Vec2, Vec2] = side === 1
            ? [point(a, face - m(1)), point(b, face - m(1)), point(b, face + LOT_DEPTH), point(a, face + LOT_DEPTH)]
            : [point(b, face - m(1)), point(a, face - m(1)), point(a, face + LOT_DEPTH), point(b, face + LOT_DEPTH)];
          const c = lotCentre({ corners });
          if (paved(c)) continue;
          const land = landLot(net, corners);
          const fit = land && this.fitFree(land, order, made);
          if (fit) made.push({ key, corners: fit, box: rectAround(fit)! });
        }
      }
    }
    // What its strips read: their land, its lots and the open land behind the footways
    const bb = line.bbox, r = face + LOT_DEPTH + m(5);
    return { reach: [bb.minX - r, bb.minY - r, bb.maxX + r, bb.maxY + r], piece: null, segment: segId, keys, keyRects, made };
  }
}

/** How far a planned lot stands back from the paving: a hair, so what grows on it is never on the footway */
const LAND_CLEARANCE = m(0.08);

/** A proposed lot (four corners, the front first) cut back to the land: the paving taken off */
function landLot(net: Network, corners: readonly Vec2[]): Vec2[] | null {
  const land = onLand(net, corners, false, LAND_CLEARANCE);
  if (!land) return null;
  if (Math.abs(lotArea({ corners: land })) < Math.abs(lotArea({ corners })) * 0.5) return null;
  // Land within a road's reach though off its paving
  if (touchesRoad(net, offsetRing(land, -m(0.016)))) return null;
  return facingCorners(withFront(simplifyRing(land, m(0.01)), [corners[0]!, corners[1]!]));
}

/** The parts of `from..to` not under any of `taken`, each at least `min` long. */
function freeSpans(from: number, to: number, taken: readonly (readonly [number, number])[], min: number): [number, number][] {
  const out: [number, number][] = [];
  let at = from;
  for (const [a, b] of [...taken].sort((p, q) => p[0] - q[0])) {
    if (a - at >= min) out.push([at, Math.min(a, to)]);
    at = Math.max(at, b);
    if (at >= to) break;
  }
  if (to - at >= min) out.push([at, to]);
  return out;
}

/** Each span cut into equal parts as near `target` long as a whole number of them allows. */
function cutSpans(spans: readonly (readonly [number, number])[], target: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of spans) {
    const n = Math.max(1, Math.round((b - a) / target));
    const w = (b - a) / n;
    for (let k = 0; k < n; k++) out.push([a + k * w, a + (k + 1) * w]);
  }
  return out;
}

/** Stores a plan: the covered lots removed, the new ones added, the land's keys kept. */
export function applyLots(doc: RoadDoc, plan: LotPlan): boolean {
  const store = doc.lotStore;
  if (!plan.add.length && !plan.drop.length && plan.keys.every((k) => store.hasKey(k))) return false;
  // DO NOT go back to filtering the list of every lot for the few dropped: it was the whole town per plan applied.
  store.apply({ remove: plan.drop, add: plan.add.map((c) => ({ corners: c.corners })) }, 'lots planned');
  // The land of each key new to the document, as `lotKeys`: DO NOT write it as a change of the lots
  store.addKeys(plan.keys, plan.keyRects, 'land cut into lots');
  return true;
}

// ------------------------------------------------------------------ editing

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const near = (p: Vec2, q: Vec2, d = m(1.2)): boolean => Math.hypot(p.x - q.x, p.y - q.y) < d;

/** The part of a polygon on the left of the line a -> b (Sutherland-Hodgman against one half-plane). */
function clipLeft(q: readonly Vec2[], a: Vec2, b: Vec2): Vec2[] {
  const side = (p: Vec2): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const out: Vec2[] = [];
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!, r = q[(i + 1) % q.length]!;
    const sp = side(p), sr = side(r);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sr >= 0)) { const t = sp / (sp - sr); out.push(lerp(p, r, t)); }
  }
  // Points the cut put on top of each other merged.
  return out.filter((p, i) => !near(p, out[(i + 1) % out.length]!, 1e-6));
}

/** A piece of a cut lot with its front set: the side lying along the old front, or else the side nearest it */
function withFront(piece: readonly Vec2[], front: readonly [Vec2, Vec2]): Vec2[] {
  const [fa, fb] = front;
  const len = Math.hypot(fb.x - fa.x, fb.y - fa.y) || 1;
  const off = (p: Vec2): number => Math.abs((fb.x - fa.x) * (p.y - fa.y) - (fb.y - fa.y) * (p.x - fa.x)) / len;
  let best = 0, bestScore = Infinity;
  for (let i = 0; i < piece.length; i++) {
    const p = piece[i]!, r = piece[(i + 1) % piece.length]!;
    const l = Math.hypot(r.x - p.x, r.y - p.y);
    if (l < m(1)) continue;
    // Along the front direction (parallel) and near the front line.
    const parallel = Math.abs(((r.x - p.x) * (fb.x - fa.x) + (r.y - p.y) * (fb.y - fa.y)) / (l * len));
    const score = off(lerp(p, r, 0.5)) + (1 - parallel) * m(40);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return [...piece.slice(best), ...piece.slice(0, best)];
}

export type LotCut =
  /** Across the front, into `parts` lots side by side, each on the street. */
  | { readonly kind: 'vertical'; readonly parts: number }
  /** Parallel to the front, into `parts` lots one behind the other. */
  | { readonly kind: 'horizontal'; readonly parts: number }
  /** Along a line the player drew, from `a` to `b`, into two. */
  | { readonly kind: 'line'; readonly a: Vec2; readonly b: Vec2 };

/** The cut lines of a cut on a lot, each as two points: the preview the tool draws. */
export function cutLines(l: Pick<Lot, 'corners'>, cut: LotCut): [Vec2, Vec2][] {
  if (cut.kind === 'line') return [[cut.a, cut.b]];
  const a = l.corners[0]!, b = l.corners[1]!;
  const w = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const u = { x: (b.x - a.x) / w, y: (b.y - a.y) / w }, n = { x: -u.y, y: u.x };
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (const q of l.corners) {
    const s = (q.x - a.x) * u.x + (q.y - a.y) * u.y, t = (q.x - a.x) * n.x + (q.y - a.y) * n.y;
    s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
  }
  const P = (s: number, t: number): Vec2 => ({ x: a.x + u.x * s + n.x * t, y: a.y + u.y * s + n.y * t });
  const lines: [Vec2, Vec2][] = [];
  for (let k = 1; k < cut.parts; k++) {
    if (cut.kind === 'vertical') {
      // Equal widths along the front itself (the front may be shorter than the lot).
      const s = k / cut.parts * w;
      lines.push([P(s, t1 + m(1)), P(s, t0 - m(1))]);
    } else {
      const t = t0 + (t1 - t0) * k / cut.parts;
      lines.push([P(s0 - m(1), t), P(s1 + m(1), t)]);
    }
  }
  return lines;
}

/** Cuts a lot by `cut`; false when nothing worth a lot is left on both sides. */
export function splitLot(doc: RoadDoc, id: number, cut: LotCut): boolean {
  const lot = doc.lot(id);
  if (!lot) return false;
  const front: [Vec2, Vec2] = [lot.corners[0]!, lot.corners[1]!];
  let pieces: Vec2[][] = [[...lot.corners]];
  for (const [a, b] of cutLines(lot, cut)) {
    const next: Vec2[][] = [];
    for (const piece of pieces) {
      const left = clipLeft(piece, a, b), right = clipLeft(piece, b, a);
      for (const half of [left, right]) if (half.length >= 3 && Math.abs(lotArea({ corners: half })) > MIN_LOT * MIN_LOT / 4) next.push(half);
    }
    pieces = next;
  }
  if (pieces.length < 2) return false;
  // The pieces are new lots, last in the order (`LotStore` ORDER).
  const made = pieces.map((piece) => ({ corners: facingCorners(withFront(piece, front)), ...(lot.use ? { use: lot.use, density: lot.density ?? 'low' as const } : {}) }));
  doc.lotStore.apply({ remove: [id], add: made }, 'lot split');
  return true;
}

/** Joins two lots that share a side into one: the two boundaries walked round, the shared stretch left out. */
export function joinLots(doc: RoadDoc, idA: number, idB: number): boolean {
  const lotA = doc.lot(idA), lotB = doc.lot(idB);
  if (!lotA || !lotB || idA === idB) return false;
  const A = lotA.corners, B = lotB.corners;
  const onB = A.map((p) => B.findIndex((q) => near(p, q)));
  // A side of A whose two corners are both corners of B.
  let start = -1;
  for (let i = 0; i < A.length; i++) if (onB[i]! >= 0 && onB[(i + 1) % A.length]! >= 0) { start = i; break; }
  if (start < 0) return false;
  // Walk A from just after the shared run, round to its start; then B the same way.
  let i0 = start;
  while (onB[(i0 - 1 + A.length) % A.length]! >= 0 && (i0 - 1 + A.length) % A.length !== start) i0 = (i0 - 1 + A.length) % A.length;
  let i1 = (start + 1) % A.length;
  while (onB[(i1 + 1) % A.length]! >= 0 && (i1 + 1) % A.length !== i0) i1 = (i1 + 1) % A.length;
  const ring: Vec2[] = [];
  for (let k = i1; ; k = (k + 1) % A.length) { ring.push(A[k]!); if (k === i0) break; }
  const j0 = onB[i0]!, j1 = onB[i1]!;
  for (let k = (j0 + 1) % B.length; k !== j1; k = (k + 1) % B.length) ring.push(B[k]!);
  if (ring.length < 3) return false;
  // The front stays the first lot's: the ring started at the end of the shared run
  const fa = lotA.corners[0]!, fb = lotA.corners[1]!;
  let f = ring.findIndex((p, k) => near(p, fa) && near(ring[(k + 1) % ring.length]!, fb));
  if (f < 0) f = ring.findIndex((p) => near(p, fa));
  const ordered = f > 0 ? [...ring.slice(f), ...ring.slice(0, f)] : ring;
  // A new lot, last in the order (`LotStore` ORDER).
  doc.lotStore.apply({ remove: [idA, idB], add: [{ corners: facingCorners(ordered), ...(lotA.use ? { use: lotA.use, density: lotA.density ?? 'low' } : {}) }] }, 'lots joined');
  return true;
}

export function deleteLot(doc: RoadDoc, id: number): boolean {
  if (!doc.lotStore.has(id)) return false;
  doc.lotStore.apply({ remove: [id] }, 'lot deleted');
  return true;
}

/** The rectangle from `a` to `b` square to `angle` (a street's direction), counter-clockwise; null when too small. */
export function lotRect(a: Vec2, b: Vec2, angle: number): Vec2[] | null {
  const u = { x: Math.cos(angle), y: Math.sin(angle) }, v = { x: -u.y, y: u.x };
  const ds = (b.x - a.x) * u.x + (b.y - a.y) * u.y, dt = (b.x - a.x) * v.x + (b.y - a.y) * v.y;
  if (Math.abs(ds) < MIN_LOT / 2 || Math.abs(dt) < MIN_LOT / 2) return null;
  const p = (s: number, t: number): Vec2 => ({ x: a.x + u.x * s + v.x * t, y: a.y + u.y * s + v.y * t });
  const s0 = Math.min(0, ds), s1 = Math.max(0, ds), t0 = Math.min(0, dt), t1 = Math.max(0, dt);
  return [p(s0, t0), p(s1, t0), p(s1, t1), p(s0, t1)];
}

/** DO NOT go back to the union of the whole map's footways, made again at each network revision */
function pavingNear(net: Network, box: ChangeRect, grow = 0): MultiPoly | null {
  const ribbons = net.ribbonsMeeting(box);
  const junctions: [NodeId, ReadonlyMap<SurfaceLevel, Junction>][] = [];
  for (const id of net.junctionCells.idsMeeting(box)) {
    const byLevel = net.junctions.get(id);
    if (byLevel) junctions.push([id, byLevel]);
  }
  if (!ribbons.length && !junctions.length) return null;
  const paving = union(levelRingsOf(net, Level.Sidewalk, ribbons, junctions));
  if (grow === 0) return paving;
  return paving.map((raw) => raw.map((ring, k) => {
    const pts = ring.map(([x, y]) => ({ x: x!, y: y! }));
    // Grown all round: outer counter-clockwise, holes (the blocks) clockwise, so the right-hand offset grows the paving.
    const oriented = (k === 0) === (lotArea({ corners: pts }) > 0) ? pts : [...pts].reverse();
    return offsetRing(oriented, grow).map((p) => [p.x, p.y]);
  }));
}

/** Room round a lot's box the paving is read over: past the clearance, so the cut inside the box is the whole map's. */
const PAVING_MARGIN = m(2);

/** Area a road takes off a lot under which it counts as crossing it: less is the paving's own outline round the lot, not a road through it. */
const CROSSED_AREA = m(1) * m(1);

/** A ROAD EDIT CUTS THE LOTS IT CROSSES (`main.ts` mutateBuilt, beside the buildings it razes): each lot the changed paving (`rects`; null, every lot) takes land from is replaced by the pieces of it left on land, each a lot of its zone where it is big enough, the rest let go - DO NOT leave a lot whole over a new road (its zone painted over the asphalt and nothing grown there, 2026-10-18). In the edit's own undo step. The lots cut. */
export function cutLotsByRoads(doc: RoadDoc, net: Network, rects: readonly ChangeRect[] | null): number {
  if (!net.ribbons.size || rects?.length === 0) return 0;
  const seen = new Set<number>();
  const lots = rects === null ? [...doc.lotStore.all()] : rects.flatMap((r) => doc.lotsIn(r));
  let cut = 0;
  for (const lot of lots) {
    if (seen.has(lot.id)) continue;
    seen.add(lot.id);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of lot.corners) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const paving = pavingNear(net, [x0 - PAVING_MARGIN, y0 - PAVING_MARGIN, x1 + PAVING_MARGIN, y1 + PAVING_MARGIN]);
    if (!paving?.length) continue;
    const pieces: Vec2[][] = [];
    let left = 0;
    for (const poly of difference([[lot.corners.map((p) => [p.x, p.y])]], paving)) {
      const ring = (poly[0] ?? []).map(([x, y]) => ({ x: x!, y: y! }));
      if (ring.length < 3) continue;
      const area = Math.abs(lotArea({ corners: ring }));
      left += area;
      if (area >= MIN_LOT * MIN_LOT / 2) pieces.push(ring);
    }
    // The paving meets the lot's outline only: not crossed.
    if (Math.abs(lotArea(lot)) - left < CROSSED_AREA) continue;
    const front: [Vec2, Vec2] = [lot.corners[0]!, lot.corners[1]!];
    const made = pieces.map((piece) => ({ corners: facingCorners(withFront(piece, front)), ...(lot.use ? { use: lot.use, density: lot.density ?? 'low' as const } : {}) }));
    doc.lotStore.apply({ remove: [lot.id], add: made }, 'lot cut by a road');
    cut++;
  }
  return cut;
}

/** A lot drawn over the street, cut back to the land: what falls on the paving is taken off, so the lot */
export function onLand(net: Network, points: readonly Vec2[], square = true, clearance = 0): Vec2[] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  // The paving round the lot's box alone (`pavingNear`).
  const margin = Math.abs(clearance) + PAVING_MARGIN;
  // A map with no street keeps the lot as drawn; one with streets, none near it, cuts it against nothing
  const near = net.ribbons.size ? pavingNear(net, [x0 - margin, y0 - margin, x1 + margin, y1 + margin], clearance) ?? [] : null;
  if (!near) return [...points];
  let best: Vec2[] | null = null, bestArea = 0;
  for (const poly of difference([[points.map((p) => [p.x, p.y])]], near)) {
    const ring = (poly[0] ?? []).map(([x, y]) => ({ x: x!, y: y! }));
    const area = Math.abs(lotArea({ corners: ring }));
    if (ring.length >= 3 && area > bestArea) { bestArea = area; best = ring; }
  }
  if (!best || bestArea < MIN_LOT * MIN_LOT / 2) return null;
  return square ? squareCorners(best) : best;
}

/** A lot cut back to the footways, its corners made square */
function squareCorners(ring: Vec2[]): Vec2[] {
  const n = ring.length;
  const longSides: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!;
    if (Math.hypot(q.x - p.x, q.y - p.y) >= STRAIGHT_BACK) longSides.push(i);
  }
  if (longSides.length < 2) return ring;
  // The corners between each long side and the next: their shared point, or - with a curve's short sides between them
  const out: Vec2[] = [];
  for (let k = 0; k < longSides.length; k++) {
    const i = longSides[k]!, j = longSides[(k + 1) % longSides.length]!;
    const a = ring[i]!, b = ring[(i + 1) % n]!, c = ring[j]!, d = ring[(j + 1) % n]!;
    if ((i + 1) % n === j) { out.push(b); continue; }
    const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y;
    const den = ux * vy - uy * vx;
    const t = Math.abs(den) > 0.3 * Math.hypot(ux, uy) * Math.hypot(vx, vy) ? ((c.x - a.x) * vy - (c.y - a.y) * vx) / den : NaN;
    const x = { x: a.x + ux * t, y: a.y + uy * t };
    if (Number.isFinite(t) && Math.hypot(x.x - b.x, x.y - b.y) < m(8)) out.push(x);
    // Not a corner of two streets: the short sides kept as they are.
    else for (let r = (i + 1) % n; r !== (j + 1) % n; r = (r + 1) % n) out.push(ring[r]!);
  }
  return out.length >= 3 ? out : ring;
}

/** A new lot of any shape: the corners the player clicked, in order. */
export function addPolygonLot(doc: RoadDoc, points: readonly Vec2[], front: number): Lot | null {
  if (points.length < 3 || Math.abs(lotArea({ corners: points })) < MIN_LOT * MIN_LOT / 2) return null;
  const ring = [...points.slice(front), ...points.slice(0, front)];
  const corners = facingCorners(ring);
  // The lots there only (their boxes within the overlap test's margin), never every lot of the city.
  const box = rectAround(corners)!;
  if (doc.lotsIn(grow(box, m(0.5))).some((l) => quadsOverlap(corners, l.corners, m(0.5)) && overlapDeep(corners, l.corners))) return null;
  return doc.lotStore.apply({ add: [{ corners }] }, 'lot drawn')[0]!;
}

/** Makes one side of a lot its front - the side on the street, which the building grown there faces */
export function setLotFront(doc: RoadDoc, id: number, side: number): boolean {
  const lot = doc.lot(id);
  if (!lot) return false;
  const n = lot.corners.length;
  const k = ((side % n) + n) % n;
  if (k === 0) return false;
  if (lot.building !== undefined) doc.buildings.remove(lot.building as Parameters<typeof doc.buildings.remove>[0]);
  const { building: _gone, ...rest } = lot;
  doc.lotStore.apply({ put: [{ ...rest, corners: [...lot.corners.slice(k), ...lot.corners.slice(0, k)] }] }, 'lot front');
  return true;
}

/** Whether a corner or the middle of one polygon is well inside the other (the separating-axis test is only for convex shapes). */
function overlapDeep(p: readonly Vec2[], q: readonly Vec2[]): boolean {
  const inner = (a: readonly Vec2[], b: readonly Vec2[]): boolean => {
    const c = lotCentre({ corners: a });
    return [c, ...a.map((x) => lerp(x, c, 0.2))].some((x) => insideLot(x, { corners: b }));
  };
  return inner(p, q) || inner(q, p);
}

/** Moves a lot corner to `to`, and every other lot's corner standing on the same point with it */
export function moveLotCorner(doc: RoadDoc, from: Vec2, to: Vec2): boolean {
  const reach = m(0.8);
  const put: Lot[] = [];
  // The lots with a corner on the point: those whose box reaches it, never every lot of the city.
  for (const l of doc.lotsIn([from.x - reach, from.y - reach, from.x + reach, from.y + reach])) {
    let changed = false;
    const corners = l.corners.map((q) => {
      if (near(q, from, reach)) { changed = true; return { x: to.x, y: to.y }; }
      return q;
    });
    if (changed) put.push({ ...l, corners });
  }
  if (put.length) doc.lotStore.apply({ put }, 'lot corner moved');
  return put.length > 0;
}

/** Bends the side of a lot from corner `a` to corner `b` through `through`: a curve */
export function curveLotSide(doc: RoadDoc, a: Vec2, b: Vec2, through: Vec2): boolean {
  const control = { x: 2 * through.x - (a.x + b.x) / 2, y: 2 * through.y - (a.y + b.y) / 2 };
  const curve = (from: Vec2, to: Vec2): Vec2[] => {
    const out: Vec2[] = [];
    for (let k = 1; k < 12; k++) {
      const t = k / 12, s = 1 - t;
      out.push({ x: s * s * from.x + 2 * s * t * control.x + t * t * to.x, y: s * s * from.y + 2 * s * t * control.y + t * t * to.y });
    }
    return out;
  };
  const put: Lot[] = [];
  // The lots with a corner by `a` (each side bent has one): those whose box reaches it, never every lot.
  const reach = m(1.2);
  for (const l of doc.lotsIn([a.x - reach, a.y - reach, a.x + reach, a.y + reach])) {
    const q = l.corners;
    for (let k = 0; k < q.length; k++) {
      const p = q[k]!, r = q[(k + 1) % q.length]!;
      let inner: Vec2[] | null = null;
      if (near(p, a) && near(r, b)) inner = curve(a, b);
      else if (near(p, b) && near(r, a)) inner = curve(a, b).reverse();
      if (!inner) continue;
      put.push({ ...l, corners: [...q.slice(0, k + 1), ...inner, ...q.slice(k + 1)] });
      break;
    }
  }
  // The curve lies within the triangle of its ends and its control point, and can bulge past `through` along the side
  if (put.length) doc.lotStore.apply({ put, also: [rectAround([a, b, through, control])!] }, 'lot side curved');
  return put.length > 0;
}

/** Zones lots (or clears them, `zone` null). */
export function zoneLots(doc: RoadDoc, ids: readonly number[], zone: { use: ZoneUse; density: ZoneDensity } | null): boolean {
  const store = doc.lotStore;
  // DO NOT walk every lot of the city for a stroke.
  const lots = [...new Set(ids)].map((id) => store.get(id)).filter((l): l is Lot => l !== undefined)
    .sort((p, q) => store.orderOf(p.id)! - store.orderOf(q.id)!);
  const put: Lot[] = [];
  for (const l of lots) {
    if (zone ? l.use === zone.use && l.density === zone.density : !l.use) continue;
    const { use: _u, density: _d, building, ...rest } = l;
    if (zone) put.push({ ...rest, use: zone.use, density: zone.density, ...(building !== undefined ? { building } : {}) });
    else {
      // Taking the zone off takes what grew on it (the player, 2026-10-09): the land goes back to unzoned, empty.
      if (building !== undefined && doc.buildings.has(building as BuildingId)) doc.buildings.remove(building as BuildingId);
      put.push(rest);
    }
  }
  if (put.length) store.apply({ put }, zone ? 'lots zoned' : 'zone taken off the lots');
  return put.length > 0;
}

export function isLot(raw: unknown): raw is Lot {
  const v = raw as Partial<Lot> | null;
  return !!v && Number.isInteger(v.id) && Array.isArray(v.corners) && v.corners.length >= 3 &&
    v.corners.every((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y));
}

// ------------------------------------------------------------------ geometry

/** For a one-row block: whether the street is nearer its -v side than its +v side, at this column. */
function nearerStreet(at: (s: number, t: number) => Vec2, s0: number, s1: number, tMinus: number, tPlus: number,
  paved: (p: Vec2) => boolean): boolean {
  const s = (s0 + s1) / 2;
  for (let d = 0; d < m(12); d += m(1)) {
    const minus = paved(at(s, tMinus - d)), plus = paved(at(s, tPlus + d));
    if (minus !== plus) return minus;
  }
  return true;
}

/** An outline edge at least this long is a straight back of a footway; shorter ones are a corner's curve. */
const STRAIGHT_BACK = m(2);

/** The outline of the paving a building may stand against round a box: the union of the footways (`pavingNear`) */
function footwayEdgesNear(net: Network, box: ChangeRect): number[] {
  const edges: number[] = [];
  for (const poly of pavingNear(net, box) ?? []) for (const ring of poly) {
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k]!, q = ring[(k + 1) % ring.length]!;
      edges.push(p[0]!, p[1]!, q[0]!, q[1]!);
    }
  }
  return edges;
}

/** The lot snap: a point near a street is put on the outer edge of its footway as drawn */
export function lotSnapper(doc: RoadDoc, net: Network, lots?: readonly Pick<Lot, 'id' | 'corners'>[], apart?: Vec2): (p: Vec2, reach: number, skip?: number) => { p: Vec2; kind: 'corner' | 'street' | 'lot' | null } {
  return (p, reach, skip) => {
    let lotBest: Vec2 | null = null, lotD = reach * 0.7;
    const r = lotD;
    for (const l of lots ?? doc.lotsIn([p.x - r, p.y - r, p.x + r, p.y + r])) {
      if (l.id === skip) continue;
      for (const q of l.corners) {
        if (apart && Math.hypot(q.x - apart.x, q.y - apart.y) <= m(0.8)) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < lotD) { lotD = d; lotBest = q; }
      }
    }
    if (lotBest) return { p: { x: lotBest.x, y: lotBest.y }, kind: 'lot' };
    let best: Vec2 | null = null, bestD = reach;
    // The straight backs of the footways near the point (their curves round the corners left out)
    const backs: { d: number; x0: number; y0: number; dx: number; dy: number }[] = [];
    const span = reach * 1.5;
    // The outline round the point, read over the reach and a straight back's length more
    const around = span + STRAIGHT_BACK + PAVING_MARGIN;
    const edges = footwayEdgesNear(net, [p.x - around, p.y - around, p.x + around, p.y + around]);
    for (let e = 0; e < edges.length / 4; e++) {
      const x0 = edges[e * 4]!, y0 = edges[e * 4 + 1]!, x1 = edges[e * 4 + 2]!, y1 = edges[e * 4 + 3]!;
      const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - x0) * dx + (p.y - y0) * dy) / len2)) : 0;
      const qx = x0 + dx * t, qy = y0 + dy * t, d = Math.hypot(qx - p.x, qy - p.y);
      if (d < bestD) { bestD = d; best = { x: qx, y: qy }; }
      if (len2 >= STRAIGHT_BACK * STRAIGHT_BACK && d < span) backs.push({ d, x0, y0, dx, dy });
    }
    backs.sort((u, v) => u.d - v.d);
    let corner: Vec2 | null = null;
    const first = backs[0];
    if (first) {
      for (const other of backs) {
        const den = first.dx * other.dy - first.dy * other.dx;
        // Square enough to be two streets, not one back cut in two.
        if (Math.abs(den) < 0.3 * Math.hypot(first.dx, first.dy) * Math.hypot(other.dx, other.dy)) continue;
        const k = ((other.x0 - first.x0) * other.dy - (other.y0 - first.y0) * other.dx) / den;
        const x = { x: first.x0 + first.dx * k, y: first.y0 + first.dy * k };
        if (Math.hypot(x.x - p.x, x.y - p.y) < span) corner = x;
        break;
      }
    }
    if (corner) return { p: corner, kind: 'corner' };
    if (best) return { p: best, kind: 'street' };
    return { p, kind: null };
  };
}

