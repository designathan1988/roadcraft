import { Digest } from '@core/digest';
import type { BuildingId } from '@world/buildings/types';
import type { ChangeRect } from '@world/changes';
import type { SegmentId } from '@world/ids';
import type { LaneletId } from '@world/lanelets';
import { OWNER } from '@world/tiles';
import { type Bay, type BayLane, bayWork } from './bay';
import { LOT_READS, type TrafficBuilding, type TrafficBuildings } from './trafficBuildings';
import { BuildingsInOrder } from './buildingOrder';
import { type LaneGridWorld, laneChangesSince, laneGrid, lanesInBox, lanesNear } from './laneGrid';
export { laneChangesSince, lanesInBox };
import { type KerbBook, type KerbReads, type KerbWorld, followKerbs, newKerbBook } from './kerbBays';
import {
  type BayReads, type LotAsk, type LotExit, type WallRing, LANE_REACH, bayRows, baysOfShare, gateExits as lotGateExits, laneFor, shareOf,
} from './lotBays';
export { carGates, gatedProperty, stallFits, type LotExit } from './lotBays';

/** The parking bays of the city: where a resident's car stands when it is not on the road. */

/** How far from a point the lane beside it is looked for (`laneBeside`), u. */
export const LANE_BESIDE_REACH = LANE_REACH;

export type { Bay, BayLane } from './bay';

/** DO NOT import `SimWorld`: what the bays read of a world (the simulation's, or a tile's own roads and buildings where it is baked, `sim/tileBays.ts`). */
export interface BayWorld extends KerbWorld, LaneGridWorld {
  /** A lane's runtime now (`SimWorld.rt`): whether it is a ghost. */
  rt(id: LaneletId): { readonly ghost: boolean };
}

/** Every stall of every parking element, with the way out of its lot and the lane it is reached from */
export function collectBays(w: BayWorld): Bay[] {
  return townBays(baysNow(w)).map((bay) => ({ ...bay, car: null }));
}
/** How far round a change a lot's box grown by `LOT_READS` (`TrafficBuilding.reach`) may reach */
const LOT_REACHED = LOT_READS * 2;
/** What a building's bays are worked out from, as text, once per record */
const RECORD_READS = new WeakMap<TrafficBuilding, { lot?: number; walls?: readonly Wall[] }>();
function recordReads(b: TrafficBuilding): { lot?: number; walls?: readonly Wall[] } {
  let reads = RECORD_READS.get(b);
  if (!reads) RECORD_READS.set(b, reads = {});
  return reads;
}
/** What of a record its bays are worked out from (`lotBays.ts` LotRecord): its frame, its blocks and its parts. */
const OF_THE_LOT: ReadonlySet<string> = new Set(['id', 'x', 'y', 'rotation', 'volumes', 'elements']);
const notOfTheLot = (key: string): boolean => !OF_THE_LOT.has(key);
/** DO NOT key it by its JSON text: a string the size of the record held for every building with parking. */
function lotKey(b: TrafficBuilding): number {
  const reads = recordReads(b);
  reads.lot ??= new Digest().addPlain(b, notOfTheLot).value();
  return reads.lot;
}

const hasParking = (b: TrafficBuilding): boolean => (b.elements ?? []).some((el) => el.kind === 'parking');

/** What a lot's bays are worked out from: its record (`lotKey`), and the lanes and walls within reach, digested. */
interface LotSources { readonly lot: number; readonly key: number }
/** A lot's bays as last worked out, with what they were worked out from: its record */
interface LotBays extends LotSources { readonly bays: readonly Bay[] }

/** What works lots' bays out off the page (`bayPool.ts`): each lot asked, in order, as `bayRows` would on the page. */
export interface BayWorkers {
  work(asks: readonly LotAsk[]): Promise<readonly (readonly Bay[])[]>;
  /** Called while lots wait (`baysNow`): fails the workers if one with lots waiting has been silent too long. */
  check?(): void;
}
/** The workers a world's lots are worked out by (the game's, `main.ts`). */
export function useBayWorkers(w: BayWorld, workers: BayWorkers): void {
  bookOf(w).workers = workers;
}

/** A tile's bays as baked where it was written (`sim/tileBays.ts` TileBays): each lot's and street's, with what they were worked out from. */
export interface BakedBays {
  /** The lots and the streets it holds bays of. */
  lots(): Iterable<BuildingId>;
  kerbs(): Iterable<SegmentId>;
  /** A lot's bays, when baked from this very record (`lotKey`) and these lanes and walls (`lookAtLot`); null else. */
  lot(id: BuildingId, record: number, sources: number): readonly Bay[] | null;
  /** A street's bays, when baked from the very same (`kerbBays.ts` kerbKey); null else. */
  kerb(id: SegmentId, sources: number): readonly Bay[] | null;
}

/** One lot's or street's bays as a bake keeps them (`bakeBays`): the record's digest (0 for a street) and the sources'. */
export interface BakedSource {
  readonly id: number;
  readonly record: number;
  readonly sources: number;
  readonly bays: readonly Bay[];
}

/** The bays of a world as last worked out, and what they were worked out from. */
interface BayBook {
  /** The bays' sources (`L<building>` a lot, `K<segment>` a street's kerb) whose bays changed since `logBase`, oldest first */
  log: string[];
  logBase: number;
  serial: number;
  /** `out` is to be put together again before it is handed out (`collectBays`). */
  outStale: boolean;
  /** The lots (buildings with a `parking` element), in the store's order. */
  readonly lots: BuildingsInOrder;
  readonly known: Map<BuildingId, LotBays>;
  /** The lots being worked out by the workers, with what from; until the answer lands a lot keeps its bays in `known` */
  readonly waiting: Map<BuildingId, LotSources>;
  readonly kerb: KerbBook;
  /** What works the lots out off the page (`useBayWorkers`); none: on the page. */
  workers: BayWorkers | null;
  /** The lanes' changes the lots were last worked out on (`LaneGrid.changes`). */
  lanesSeen: object | null;
  /** The town's list, ids in order. */
  out: readonly Bay[];
  /** The bays baked with the tiles held (`tileBaysRead`), by tile, and the tile's bake each lot and street is in: taken where worked out from the same. */
  readonly bakedTiles: Map<number, BakedBays>;
  readonly bakedLots: Map<BuildingId, BakedBays>;
  readonly bakedKerbs: Map<SegmentId, BakedBays>;
  /** The tiles whose baked bays are being read, with the read (`tileBaysWanted`): their streets wait for them. */
  readonly reading: Map<number, number>;
  /** What the kerbs read of this world (`kerbReads`), made once. */
  reads: KerbReads | null;
}
const BOOKS = new WeakMap<BayWorld, BayBook>();

/** A world's book, made empty the first time. */
function bookOf(w: BayWorld): BayBook {
  let book = BOOKS.get(w);
  if (!book) {
    book = { lots: new BuildingsInOrder(hasParking), known: new Map(), waiting: new Map(), kerb: newKerbBook(), workers: null, lanesSeen: null,
      out: [], log: [], logBase: 0, serial: 0, outStale: true, bakedTiles: new Map(), bakedLots: new Map(), bakedKerbs: new Map(), reading: new Map(),
      reads: null };
    BOOKS.set(w, book);
  }
  return book;
}

/** A tile's baked bays are being read (`simHost.ts` tileBuildings): its own streets wait for them (`KerbReads.waits`), as a lot waits for the workers. */
export function tileBaysWanted(w: BayWorld, tile: number, read: number): void {
  bookOf(w).reading.set(tile, read);
}

/** A tile's read landed: its baked bays (null: none stored, of another format, or not read) offered while that read is the tile's last, its streets looked at again. */
export function tileBaysRead(w: BayWorld, tile: number, read: number, bays: BakedBays | null): void {
  const book = bookOf(w);
  if (book.reading.get(tile) !== read) return;
  book.reading.delete(tile);
  if (bays) {
    dropBaked(book, tile);
    book.bakedTiles.set(tile, bays);
    for (const id of bays.lots()) book.bakedLots.set(id, bays);
    for (const id of bays.kerbs()) book.bakedKerbs.set(id, bays);
  }
  release(book);
}

/** A tile let go: its baked bays dropped, its streets no longer wait. */
export function tileBaysGone(w: BayWorld, tile: number): void {
  const book = bookOf(w);
  dropBaked(book, tile);
  if (book.reading.delete(tile)) release(book);
}

function dropBaked(book: BayBook, tile: number): void {
  const was = book.bakedTiles.get(tile);
  if (!was) return;
  book.bakedTiles.delete(tile);
  for (const id of was.lots()) if (book.bakedLots.get(id) === was) book.bakedLots.delete(id);
  for (const id of was.kerbs()) if (book.bakedKerbs.get(id) === was) book.bakedKerbs.delete(id);
}

/** The streets held for a tile's bays looked at again at the next follow (those whose tile still waits held again). */
function release(book: BayBook): void {
  for (const id of book.kerb.held) book.kerb.redo.add(id);
  book.kerb.held.clear();
}

/** What a street's kerb bays read of the world, and its tile's bake (`kerbBays.ts` KerbReads). */
function kerbReads(w: BayWorld, book: BayBook): KerbReads {
  return {
    rank: (id) => book.lots.rank(id),
    laneAt: (x, y, segment) => laneBeside(w, x, y, segment),
    linksKey: (segment) => {
      // Every link lane of the street (`laneFor` reads no other for it), in id order.
      const grid = laneGrid(w);
      const digest = new Digest();
      for (const id of [...w.graph.linksOfSegment(segment)].sort(byText)) {
        const lane = w.graph.lanelet(id);
        if (lane) digest.add(grid.digest(lane)).add(w.rt(id).ghost ? 1 : 0);
      }
      return digest.value();
    },
    baked: (segment, key) => book.bakedKerbs.get(segment)?.kerb(segment, key) ?? null,
    waits: (segment) => book.reading.size > 0 && book.reading.has(streetTile(w, segment)),
  };
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The tile a street belongs to (`OWNER`: by the middle of its ends); NaN when it cannot be said. */
function streetTile(w: BayWorld, segment: SegmentId): number {
  const s = w.doc.segment(segment);
  const a = s && w.doc.node(s.a), b = s && w.doc.node(s.b);
  return a && b ? OWNER.segment(a, b) : Number.NaN;
}

/** @rebuild Every lot's and street's bays of a world worked out here and now (no workers), each with what it was worked out from: what a tile's bake keeps (`sim/tileBays.ts`). */
export function bakeBays(w: BayWorld): { readonly lots: readonly BakedSource[]; readonly kerbs: readonly BakedSource[] } {
  const book = baysNow(w);
  const lots: BakedSource[] = [];
  for (const id of book.lots.ids) {
    const known = book.known.get(id);
    if (known) lots.push({ id, record: known.lot, sources: known.key, bays: known.bays });
  }
  const kerbs: BakedSource[] = [];
  for (const id of streetsInOrder(book)) {
    const bays = book.kerb.bays.get(id), key = book.kerb.keys.get(id);
    if (bays && key !== undefined) kerbs.push({ id, record: 0, sources: key, bays });
  }
  return { lots, kerbs };
}

/** A lot asked of the workers, with what it is worked out from. */
interface Asked { readonly id: BuildingId; readonly sources: LotSources; readonly ask: LotAsk }

/** The bays brought up to date, from the diary: the lots a building change reaches worked out again, the others kept */
function baysNow(w: BayWorld): BayBook {
  const book = bookOf(w);
  // A worker silent too long with lots waiting fails its pool: they are worked out on the page.
  if (book.waiting.size) book.workers?.check?.();
  // DO NOT work out every lot of the town again when the roads move
  const grid = laneGrid(w);
  const lanes = grid.changes.since(book.lanesSeen);
  book.lanesSeen = grid.changes.state;
  const roadsMoved = lanes === null || lanes.length > 0;
  const delta = book.lots.update(w);
  for (const seg of followKerbs(w, book.kerb, delta, book.reads ??= kerbReads(w, book))) noteBays(book, `K${seg}`);
  if (!roadsMoved && delta !== null && delta.ids.length === 0) return book;

  // A lot whose reach neither a building change nor a lane that changed touched keeps its bays without reading anything
  const rects = lanes === null || delta === null ? null : [...delta.rects, ...lanes.flat()];
  // Read whole, the store's order may be another: the list is put together again.
  if (delta === null) book.outStale = true;
  if (delta === null) {
    for (const id of [...book.waiting.keys()]) if (!book.lots.has(id)) book.waiting.delete(id);
    for (const id of [...book.known.keys()]) if (!book.lots.has(id)) { book.known.delete(id); noteBays(book, `L${id}`); }
  } else {
    for (const id of delta.ids) {
      if (book.lots.has(id)) continue;
      book.waiting.delete(id);
      if (book.known.delete(id)) noteBays(book, `L${id}`);
    }
  }
  const walls = wallsOf(w);
  const workers = book.workers;
  const asked: Asked[] = [];
  const look = rects === null ? book.lots.ids : lotsReached(w, book.lots, rects, delta!.ids);
  for (const id of look) lookAtLot(w, book, w.buildings.get(id)!, rects, walls, workers ? asked : null);
  // The game's lots off the page; a world without workers worked them out above, on the page.
  if (workers && asked.length) {
    const asks = asked.map((a) => a.ask);
    workers.work(asks).then(
      (answers) => land(book, asked, answers),
      // No workers after all (they failed): the same lots, on the same data, here.
      () => land(book, asked, baysOfShare(shareOf(asks))),
    );
  }
  return book;
}

/** The workers' answers, each kept and logged if its lot still waits for those very sources. */
function land(book: BayBook, asked: readonly Asked[], answers: readonly (readonly Bay[])[]): void {
  asked.forEach(({ id, sources }, k) => {
    if (book.waiting.get(id) !== sources) return;
    book.waiting.delete(id);
    book.known.set(id, { lot: sources.lot, key: sources.key, bays: answers[k]! });
    noteBays(book, `L${id}`);
  });
}

/** A source's bays changed: logged, and the town's list to be put together again. */
function noteBays(book: BayBook, source: string): void {
  book.outStale = true;
  book.log.push(source);
  book.serial++;
  // Longer than every source read once: forgotten (its readers read every source).
  if (book.log.length > Math.max(256, book.known.size + book.kerb.reach.size)) {
    book.log = [];
    book.logBase = ++book.serial;
  }
}

/** The streets that park, in id order: the town's list puts their kerbs after the lots. */
const streetsInOrder = (book: BayBook): SegmentId[] => [...book.kerb.reach.keys()].sort((a, b) => a - b);

/** @rebuild The town's list of bays, put together again only after a change (`collectBays`). */
function townBays(book: BayBook): readonly Bay[] {
  if (!book.outStale) return book.out;
  const out: Bay[] = [];
  // A new lot the workers have not answered for yet has no bays.
  for (const id of book.lots.ids) for (const bay of book.known.get(id)?.bays ?? []) out.push({ ...bay, id: out.length });
  for (const id of streetsInOrder(book)) for (const bay of book.kerb.bays.get(id) ?? []) out.push({ ...bay, id: out.length });
  book.out = out;
  book.outStale = false;
  return out;
}

/** DO NOT read the town's list (`collectBays`) at every change: every bay of the town, for each building grown. */
export function bayChangesSince(w: BayWorld, serial: number): { readonly serial: number; readonly changed: readonly string[] | null } {
  const book = baysNow(w);
  if (serial < 0 || serial < book.logBase || serial > book.serial) return { serial: book.serial, changed: null };
  return { serial: book.serial, changed: book.log.slice(serial - book.logBase) };
}

/** @rebuild Every source of bays, in the town's order (the lots in the store's, then the streets by id): read whole. */
export function baySources(w: BayWorld): string[] {
  const book = baysNow(w);
  const out: string[] = [];
  for (const id of book.lots.ids) if (book.known.has(id)) out.push(`L${id}`);
  for (const id of streetsInOrder(book)) if (book.kerb.bays.get(id)?.length) out.push(`K${id}`);
  return out;
}

/** A source's bays now (`bayChangesSince`), as fresh copies (ids within the source); none when it has none. */
export function baysOfSource(w: BayWorld, source: string): Bay[] {
  const book = baysNow(w);
  const id = Number(source.slice(1));
  const bays = source[0] === 'L' ? book.known.get(id as BuildingId)?.bays : book.kerb.bays.get(id as SegmentId);
  return (bays ?? []).map((bay) => ({ ...bay, car: null }));
}

/** The lots whose reach (`LOT_READS`) meets one of the rectangles, and the lots named; found by place. */
function lotsReached(w: BayWorld, lots: BuildingsInOrder, rects: readonly ChangeRect[], named: readonly BuildingId[]): Set<BuildingId> {
  const out = new Set<BuildingId>();
  for (const id of named) if (lots.has(id)) out.add(id);
  // Every change in one look (`nearAny`): a change at a time read the cells they share again for each.
  for (const b of w.buildings.nearAny(rects, LOT_REACHED, (b, r) => lots.has(b.id) && meets(r, b.reach))) out.add(b.id);
  return out;
}

const meets = (r: ChangeRect, box: { minX: number; minY: number; maxX: number; maxY: number }): boolean =>
  r[0] <= box.maxX && r[2] >= box.minX && r[1] <= box.maxY && r[3] >= box.minY;

/** A lot looked at: kept as it is (or as it is being worked out) when its record and its reach are untouched */
function lookAtLot(w: BayWorld, book: BayBook, b: TrafficBuilding, rects: readonly ChangeRect[] | null, walls: Walls, asked: Asked[] | null): void {
  const was = book.known.get(b.id);
  const waiting = book.waiting.get(b.id);
  // What the lot's bays are, or will be once the workers answer.
  const aim = waiting ?? was;
  const box = b.reach;
  const lot = lotKey(b);
  if (rects && aim && aim.lot === lot && !rects.some((r) => meets(r, box))) return;
  const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
  // DO NOT digest a lane's line or a wall's ring here
  const digest = new Digest();
  const grid = laneGrid(w);
  // The link lanes alone: a lot's bays read no other (`lotBays.ts` laneFor, gateLane), and a junction's turns are no part of its key.
  const near = grid.near(cx, cy, Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2).filter((lane) => lane.kind === 'link');
  for (const lane of near) digest.add(grid.digest(lane)).add(w.rt(lane.id).ghost ? 1 : 0).add(bothWays(w, lane.segment) ? 1 : 0);
  const reached = walls.inBox(box.minX, box.minY, box.maxX, box.maxY);
  for (const wall of reached) digest.add(wall.digest);
  const key = digest.value();
  if (was && was.lot === lot && was.key === key) { book.waiting.delete(b.id); return; }
  if (waiting && waiting.lot === lot && waiting.key === key) return;
  // Its tile's baked bays, worked out from this very record, these lanes and walls (`sim/tileBays.ts`): taken, nothing worked out.
  const baked = book.bakedLots.get(b.id)?.lot(b.id, lot, key);
  if (baked) {
    book.waiting.delete(b.id);
    book.known.set(b.id, { lot, key, bays: baked });
    noteBays(book, `L${b.id}`);
    return;
  }
  bayWork.lots++;
  if (!asked) {
    book.known.set(b.id, { lot, key, bays: bayRows(pageReads(w, walls), b) });
    noteBays(book, `L${b.id}`);
    return;
  }
  // Everything the lot reads lies in its box (`LOT_READS`): the lanes and walls digested are what it is sent.
  const sources: LotSources = { lot, key };
  book.waiting.set(b.id, sources);
  asked.push({ id: b.id, sources, ask: {
    building: b,
    lanes: near.map((lane) => ({ lane, ghost: w.rt(lane.id).ghost, bothWays: bothWays(w, lane.segment) })),
    walls: reached,
  } });
}

/** Whether a street runs both ways (a gate onto a one-way street may face either kerb, `lotBays.ts` gateLane). */
const bothWays = (w: BayWorld, segment: SegmentId | undefined): boolean =>
  w.doc.segment(segment as SegmentId)?.direction === 'both';

/** The world as a lot's bays read it (`lotBays.ts` `BayReads`), on the page. */
function pageReads(w: BayWorld, walls: Walls): BayReads {
  return {
    lanesNear: (x, y, reach) => lanesNear(w, x, y, reach),
    ghost: (id) => w.rt(id).ghost,
    bothWays: (segment) => bothWays(w, segment),
    wallsIn: (x0, y0, x1, y1) => walls.inBox(x0, y0, x1, y1),
  };
}

/** The ways out of a gated lot (`lotBays.ts` `gateExits`), read on the page. */
export function gateExits(w: BayWorld, b: TrafficBuilding, property: { x: number; y: number; w: number; d: number }, walls: Walls): LotExit[] {
  return lotGateExits(pageReads(w, walls), b, property);
}

export interface Wall extends WallRing {
  /** Its building and its ring, digested: its part of a lot's key (`lookAtLot`). */
  readonly digest: number;
}

/** A record's solid footprints, with their bounds and digests, made once (`recordReads`) */
function recordWalls(b: TrafficBuilding): readonly Wall[] {
  const reads = recordReads(b);
  if (!reads.walls) {
    const made: Wall[] = [];
    for (const ring of b.footprints) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const digest = new Digest().add(b.id);
      for (const p of ring) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
        digest.add(p.x).add(p.y);
      }
      made.push({ building: b.id, ring, x0, y0, x1, y1, digest: digest.value() });
    }
    reads.walls = made;
  }
  return reads.walls;
}

/** DO NOT go back to a list of every building's walls: one change of one building made it again. */
export class Walls {
  constructor(private readonly store: TrafficBuildings) {}

  /** The walls whose bounds meet a box, in the store's order. */
  inBox(x0: number, y0: number, x1: number, y1: number): Wall[] {
    const out: Wall[] = [];
    for (const b of this.store.near(x0, y0, x1, y1)) {
      for (const wl of recordWalls(b)) if (wl.x1 >= x0 && wl.x0 <= x1 && wl.y1 >= y0 && wl.y0 <= y1) out.push(wl);
    }
    return out;
  }
}

/** The town's walls, by place. */
export function wallsOf(w: BayWorld): Walls {
  return new Walls(w.buildings);
}

/** The lane beside a point of a street (a bus stop): the nearest on the kerb side of that road, its point there. */
export function laneBeside(w: BayWorld, x: number, y: number, segment?: SegmentId): BayLane | null {
  return laneFor(pageReads(w, wallsOf(w)), x, y, undefined, segment);
}
