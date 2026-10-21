import type { Vec2 } from '@core/vec2';
import { IdSlots, grown } from '@core/idSlots';
import { RunPool } from '@core/runPool';
import { type RoadDoc, type SerializedDoc, savedNode, savedSegment } from '@world/doc';
import type { ChangeJournal, ChangeRect } from '@world/changes';
import { CELL } from '@world/cells';
import { hasTransit } from '@world/transit';
import type { Lot } from '@world/lots';
import { METERS_PER_UNIT, m } from '@world/units';
import { solidFootprints, storedBounds } from '@world/buildings/geometry';
import { streetDoors, type StreetDoor } from '@world/buildings/streetDoors';
import { lorryDocks, type LorryDock } from '@world/buildings/docks';
import { entrancesOf } from '@world/buildingGates';
import type { Building, BuildingElement, BuildingFunction, BuildingId, BuildingUse, Volume } from '@world/buildings/types';
import { type RecordRef, RecordTable, type TableReader, eachRecord, refOf } from '@world/buildings/recordTable';
import { type BuildingSections, eachSectionRef, sectionsSize } from '@world/buildings/sections';
import { type Mix, kindOf } from '../ambient/demand';
import type { LotPart } from './lotNav';
import { LANE_REACH, gatedProperty, personGates } from './lotBays';

/** THE BUILDINGS AS TRAFFIC READS THEM: what the simulation's worker is sent of each building, never the whole record */

/** How far a lot's bays read lanes and walls (`LANE_REACH`, the exits' reach), with a margin (`parking.ts`). */
export const LOT_READS = LANE_REACH + m(12);

interface TrafficBox { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }
/** What traffic reads of a block: its box in the building's frame, open (a lot) or built, its floor (`lotBays.ts` LotBlock). */
type TrafficBlock = Pick<Volume, 'x' | 'y' | 'w' | 'd' | 'open' | 'base'>;
/** What traffic reads of a part of a lot (`lotNav.ts` LotPart), and its id (a dock's element). */
export type TrafficPart = LotPart & Pick<BuildingElement, 'id'>;

/** A building as the simulation reads it: its frame, use, blocks and parts, and what the page works out of the whole record */
export interface TrafficBuilding {
  readonly id: BuildingId;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly use: BuildingUse;
  readonly function?: BuildingFunction;
  readonly volumes: readonly TrafficBlock[];
  /** Absent when the record has no parts at all (as `Building.elements`). */
  readonly elements?: readonly TrafficPart[];
  /** `storedBounds(b)`: its blocks and its parts, world. */
  readonly bounds: TrafficBox;
  /** `storedBounds(b, LOT_READS)`: the box its lot's bays read within. */
  readonly reach: TrafficBox;
  /** `solidFootprints(b)`: the world rings of its built ground blocks, what nobody drives or walks through. */
  readonly footprints: readonly (readonly Vec2[])[];
  /** `streetDoors(b)`: its doors straight onto the footway. */
  readonly doors: readonly StreetDoor[];
  /** `lorryDocks(b)`: its loading docks. */
  readonly docks: readonly LorryDock[];
  /** `entrancesOf(b)`: its car gates and the edges of its parking, where a kerb keeps no bay. */
  readonly entrances: readonly [Vec2, Vec2][];
}

const boxOf = (b: TrafficBox): TrafficBox => ({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });

function partOf(el: BuildingElement): TrafficPart {
  return { id: el.id, kind: el.kind, x: el.x, y: el.y, w: el.w, d: el.d, facing: el.facing, z: el.z, ...(el.angle !== undefined ? { angle: el.angle } : {}) };
}

function project(b: Building): TrafficBuilding {
  return {
    id: b.id, x: b.x, y: b.y, rotation: b.rotation, use: b.use,
    ...(b.function !== undefined ? { function: b.function } : {}),
    volumes: b.volumes.map((v) => ({ x: v.x, y: v.y, w: v.w, d: v.d, base: v.base, ...(v.open !== undefined ? { open: v.open } : {}) })),
    ...(b.elements ? { elements: b.elements.map(partOf) } : {}),
    bounds: boxOf(storedBounds(b)),
    reach: boxOf(storedBounds(b, LOT_READS)),
    footprints: solidFootprints(b),
    doors: streetDoors(b),
    docks: lorryDocks(b),
    entrances: entrancesOf(b),
  };
}

/** DO NOT keep it per record on the page (`identityMemo`): a copy of every building of the map held for as long as the map, ~6 KB each; worked out when it is sent, kept by the worker alone. */
export const trafficBuilding: (b: Building) => TrafficBuilding = project;

// ------------------------------------------------------------------ what is read of every building without its traffic record

/** The kinds of place a building is (`ambient/demand.ts` kindOf), in the order of the draws' classes and of `LotPlaces`' trees. */
export const TRAFFIC_KINDS: readonly (keyof Mix)[] = ['home', 'shop', 'work', 'civic'];
/** A building with a `parking` element: a lot whose stalls are bays (`parking.ts`). */
export const TRAIT_PARKING = 1;
/** A gated lot with docks: a lorry's yard (`lorryTraffic.ts`). */
export const TRAIT_YARD = 2;

/** What the walks over every building read of each (the order of the lots, the scenery's indexes, the meso's demand): numbers kept in columns in the worker (`TrafficBuildingTable`), no traffic record worked out for them. */
export interface TrafficFacts {
  readonly id: BuildingId;
  readonly x: number;
  readonly y: number;
  readonly kind: keyof Mix;
  /** `TRAIT_PARKING`, `TRAIT_YARD`. */
  readonly traits: number;
  /** The most frontage its way on foot can have (`frontageBound`). */
  readonly frontage: number;
  readonly bounds: TrafficBox;
  readonly reach: TrafficBox;
}

/** The most frontage a building's way on foot can have (`lotDoors.ts`): its blocks' width along its widest people's gate, or along its facade with none, 6 m at the least. */
export function frontageBound(b: Pick<TrafficBuilding, 'volumes' | 'elements'>): number {
  const gates = personGates(b);
  if (!gates.length) {
    let lo = Infinity, hi = -Infinity;
    for (const v of b.volumes) { lo = Math.min(lo, v.x); hi = Math.max(hi, v.x + v.w); }
    return Math.max(m(6), hi - lo);
  }
  let best = 0;
  for (const g of gates) {
    const alongY = g.facing === 1 || g.facing === 3;
    let ux = alongY ? 0 : 1, uy = alongY ? 1 : 0;
    if (g.angle) {
      const c = Math.cos(g.angle), s = Math.sin(g.angle);
      [ux, uy] = [ux * c - uy * s, ux * s + uy * c];
    }
    let lo = Infinity, hi = -Infinity;
    for (const v of b.volumes) {
      for (const [x, y] of [[v.x, v.y], [v.x + v.w, v.y], [v.x, v.y + v.d], [v.x + v.w, v.y + v.d]] as const) {
        const a = (x - g.x) * ux + (y - g.y) * uy;
        lo = Math.min(lo, a); hi = Math.max(hi, a);
      }
    }
    best = Math.max(best, Math.max(m(6), hi - lo));
  }
  return best;
}

const traitsOf = (b: TrafficBuilding): number =>
  ((b.elements ?? []).some((el) => el.kind === 'parking') ? TRAIT_PARKING : 0) | (gatedProperty(b) !== null && b.docks.length > 0 ? TRAIT_YARD : 0);

/** A traffic record's facts (`TrafficFacts`), worked out of it. */
export function factsOf(b: TrafficBuilding): TrafficFacts {
  return { id: b.id, x: b.x, y: b.y, kind: kindOf(b), traits: traitsOf(b), frontage: frontageBound(b), bounds: boxOf(b.bounds), reach: boxOf(b.reach) };
}

/** The buildings as the simulation asks for them: by id, all in the store's order, by place in the store's order. */
export interface TrafficBuildings {
  /** A building's traffic record (the worker works it out again from its row when it is not held: DO NOT ask it of every building). */
  get(id: BuildingId): TrafficBuilding | undefined;
  /** @rebuild Every traffic record in the store's order: DO NOT walk it in the worker, where each is worked out again (`ids` and `facts`). */
  all(): Iterable<TrafficBuilding>;
  /** Every building's id, in the order of `all()`, none read. */
  ids(): Iterable<BuildingId>;
  /** What the walks over every building read of one, no traffic record worked out (`TrafficFacts`). */
  facts(id: BuildingId): TrafficFacts | undefined;
  /** A building's entrances (`TrafficBuilding.entrances`), none read but them; none for a building not there. */
  entrances(id: BuildingId): readonly [Vec2, Vec2][];
  /** A building's footprints (`TrafficBuilding.footprints`), none read but them; none for a building not there. */
  footprints(id: BuildingId): readonly (readonly Vec2[])[];
  /** @rebuild Every building's facts, entrances or footprints in the store's order: DO NOT ask them id by id of every building (the page's store holds each record asked by id for a while: `TableRows.recent`). */
  eachFacts(visit: (b: TrafficFacts) => void): void;
  eachEntrances(visit: (id: BuildingId, entrances: readonly [Vec2, Vec2][]) => void): void;
  eachFootprints(visit: (id: BuildingId, footprints: readonly (readonly Vec2[])[]) => void): void;
  /** The buildings whose box may reach the rectangle, in the store's order. */
  near(minX: number, minY: number, maxX: number, maxY: number): TrafficBuilding[];
  /** The ids of `near`, none read. */
  nearIds(minX: number, minY: number, maxX: number, maxY: number): BuildingId[];
  /** The buildings `meets` keeps for one of `rects`, asked of those within `pad` of it, each once, in the store's order: their ids. */
  nearAny(rects: readonly (readonly [number, number, number, number])[], pad: number,
    meets: (b: TrafficFacts, rect: readonly [number, number, number, number]) => boolean): BuildingId[];
}

/** What a reader of the buildings by the diary reads: the document (its diary) and the buildings (`SimWorld`). */
export interface BuildingSource {
  readonly doc: RoadDoc;
  readonly buildings: TrafficBuildings;
}

/** A document's own buildings as traffic reads them (a world on the page or in a spec): each record's traffic record. */
export function docBuildings(doc: RoadDoc): TrafficBuildings {
  // Each record's traffic record kept for as long as this world reads it (a spec's world on the page), as the worker's table keeps its own.
  const known = new WeakMap<Building, TrafficBuilding>();
  const trafficBuilding = (b: Building): TrafficBuilding => {
    let t = known.get(b);
    if (!t) known.set(b, t = project(b));
    return t;
  };
  const facts = new WeakMap<TrafficBuilding, TrafficFacts>();
  const factsOfRecord = (b: Building): TrafficFacts => {
    const t = trafficBuilding(b);
    let f = facts.get(t);
    if (!f) facts.set(t, f = factsOf(t));
    return f;
  };
  return {
    get: (id) => {
      const b = doc.buildings.get(id);
      return b ? trafficBuilding(b) : undefined;
    },
    *all() {
      for (const b of doc.buildings.all()) yield trafficBuilding(b);
    },
    ids: () => doc.buildings.idList(),
    facts: (id) => {
      const b = doc.buildings.get(id);
      return b ? factsOfRecord(b) : undefined;
    },
    entrances: (id) => {
      const b = doc.buildings.get(id);
      return b ? trafficBuilding(b).entrances : [];
    },
    footprints: (id) => {
      const b = doc.buildings.get(id);
      return b ? trafficBuilding(b).footprints : [];
    },
    /** @rebuild Every record walked once (`TrafficBuildings.eachFacts`). */
    eachFacts: (visit) => { for (const b of doc.buildings.all()) visit(factsOfRecord(b)); },
    /** @rebuild Every record walked once (`TrafficBuildings.eachEntrances`). */
    eachEntrances: (visit) => { for (const b of doc.buildings.all()) visit(b.id, trafficBuilding(b).entrances); },
    /** @rebuild Every record walked once (`TrafficBuildings.eachFootprints`). */
    eachFootprints: (visit) => { for (const b of doc.buildings.all()) visit(b.id, trafficBuilding(b).footprints); },
    near: (minX, minY, maxX, maxY) => doc.buildings.near(minX, minY, maxX, maxY).map(trafficBuilding),
    nearIds: (minX, minY, maxX, maxY) => doc.buildings.near(minX, minY, maxX, maxY).map((b) => b.id),
    nearAny: (rects, pad, meets) => doc.buildings.nearAny(rects, pad, (b, r) => meets(factsOfRecord(b), r)).map((b) => b.id),
  };
}

/** A batch of the buildings' changes in the diary (`TrafficBuildingTable.apply`): its detail is this, then one letter an id - gone, kept in its place, or new (put last). */
export const BATCH_DETAIL = 'batch:';
export const BATCH_GONE = 'g';
export const BATCH_KEPT = 'k';
export const BATCH_NEW = 'n';

/** A building of the page changed, as the worker is told it: its traffic record now and where its record is read (`RecordRef`), null when it is gone. */
export interface BuildingChange {
  readonly id: BuildingId;
  readonly value: TrafficBuilding | null;
  readonly ref: RecordRef | null;
}

// ------------------------------------------------------------------ the worker's table

/** Traffic records held at once by the worker's table (`TrafficBuildingTable`), the last asked (a clock's second chance): ~6 KB each. */
export const HELD_RECORDS = 1024;

/** A building's cells (`CELL`) of the table's index, each a list of slots. */
interface CellList { slots: Int32Array; n: number }

const cellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

/**
 * THE BUILDINGS IN THE SIMULATION'S WORKER AS NUMBERS IN COLUMNS, NOT AS OBJECTS (report "Arquitetura para cidades grandes", "colunas
 * binárias"): each building at a slot (`IdSlots`) with its place, boxes, kind and traits, its entrances and footprints in runs of one
 * typed array each (`RunPool`), its row (where its record is read again), and its place in the store's order; the slots filed by the
 * world's 256 m cells in typed lists. A traffic record is worked out again from its row when asked (`get`), the last asked held
 * (`HELD_RECORDS`) and any still held elsewhere found again (`WeakRef`, MDN): a record asked twice is one object while anyone holds it.
 * DO NOT keep every building's traffic record: ~10.7 KB of the worker's heap a building (2.1 GB at 200,000, 2026-10-21).
 */
export class TrafficBuildingTable implements TrafficBuildings {
  private readonly slots = new IdSlots(1024);
  private idAt = new Float64Array(16);
  private xs = new Float64Array(16);
  private ys = new Float64Array(16);
  /** `bounds` then `reach`, four numbers each, eight a slot. */
  private boxes = new Float64Array(16 * 8);
  private frontages = new Float64Array(16);
  private kinds = new Uint8Array(16);
  private traits = new Uint8Array(16);
  /** Whether the slot is filed in the cells (its box and anchor are numbers). */
  private filed = new Uint8Array(16);
  /** Where its record is read: a table of `buffers` and its row. */
  private bufferAt = new Int32Array(16);
  private rows = new Int32Array(16);
  /** Its place in `order`: its rank in the store's order. */
  private orderAt = new Int32Array(16);
  /** Each query's mark on the slots it met (`meeting`). */
  private marks = new Int32Array(16);
  private mark = 0;
  /** Entrances (x, y, x, y each) and footprints (rings: their count, then each one's points' count and its x, y). */
  private readonly entranceRuns = new RunPool();
  private readonly footprintRuns = new RunPool();
  /** The ids in the store's order, NaN where one was taken out (packed when they outweigh the rest). */
  private order = new Float64Array(16);
  private orderLength = 0;
  private orderGone = 0;
  private cells = new Map<number, CellList>();
  /** The tables the records are read from, how many slots read each, and a reader each (made when first asked). */
  private buffers: (ArrayBufferLike | null)[] = [];
  private bufferUses: number[] = [];
  private bufferIndex = new Map<ArrayBufferLike, number>();
  private readers: (TableReader | null)[] = [];
  private freeBuffers: number[] = [];
  /** The traffic records held (a clock of `HELD_RECORDS`) and those that may still live elsewhere. */
  private held: (TrafficBuilding | undefined)[] = [];
  private heldAt = new Int32Array(16).fill(-1);
  private readonly clock: Int32Array;
  private readonly used: Uint8Array;
  private hand = 0;
  private readonly alive = new Map<number, WeakRef<TrafficBuilding>>();
  private readonly gone = new FinalizationRegistry<number>((slot) => { if (this.alive.get(slot)?.deref() === undefined) this.alive.delete(slot); });

  /** `holding`: the traffic records held at once (`HELD_RECORDS`; fewer in a spec, to make it work them out again). */
  constructor(private readonly journal: ChangeJournal, private readonly holding = HELD_RECORDS) {
    this.clock = new Int32Array(holding).fill(-1);
    this.used = new Uint8Array(holding);
  }

  get size(): number {
    return this.slots.size;
  }

  get(id: BuildingId): TrafficBuilding | undefined {
    const slot = this.slots.get(id);
    return slot < 0 ? undefined : this.record(slot);
  }

  *all(): IterableIterator<TrafficBuilding> {
    for (const id of this.ids()) yield this.get(id)!;
  }

  *ids(): IterableIterator<BuildingId> {
    for (let i = 0; i < this.orderLength; i++) {
      const id = this.order[i]!;
      if (!Number.isNaN(id)) yield id as BuildingId;
    }
  }

  facts(id: BuildingId): TrafficFacts | undefined {
    const slot = this.slots.get(id);
    return slot < 0 ? undefined : this.factsAt(slot);
  }

  entrances(id: BuildingId): readonly [Vec2, Vec2][] {
    const slot = this.slots.get(id);
    const runs = this.entranceRuns, n = slot < 0 ? 0 : runs.length(slot);
    const out: [Vec2, Vec2][] = [];
    for (let at = runs.start(slot), end = at + n, d = runs.data; at < end; at += 4) out.push([{ x: d[at]!, y: d[at + 1]! }, { x: d[at + 2]!, y: d[at + 3]! }]);
    return out;
  }

  eachFacts(visit: (b: TrafficFacts) => void): void {
    for (const id of this.ids()) visit(this.factsAt(this.slots.get(id)));
  }

  eachEntrances(visit: (id: BuildingId, entrances: readonly [Vec2, Vec2][]) => void): void {
    for (const id of this.ids()) visit(id, this.entrances(id));
  }

  eachFootprints(visit: (id: BuildingId, footprints: readonly (readonly Vec2[])[]) => void): void {
    for (const id of this.ids()) visit(id, this.footprints(id));
  }

  footprints(id: BuildingId): readonly (readonly Vec2[])[] {
    const slot = this.slots.get(id);
    const runs = this.footprintRuns;
    if (slot < 0 || !runs.length(slot)) return [];
    const d = runs.data;
    let at = runs.start(slot);
    const out: Vec2[][] = [];
    for (let r = 0, rings = d[at++]!; r < rings; r++) {
      const ring: Vec2[] = [];
      for (let k = 0, n = d[at++]!; k < n; k++, at += 2) ring.push({ x: d[at]!, y: d[at + 1]! });
      out.push(ring);
    }
    return out;
  }

  /** @rebuild Another map: every record read from its row, the diary told the whole set changed. DO NOT hold a record read here: each one's columns alone. */
  load(sections: BuildingSections): void {
    for (let slot = 0; slot < this.held.length; slot++) this.unhold(slot);
    this.slots.clear();
    this.alive.clear();
    this.hand = 0;
    this.cells = new Map();
    this.order = new Float64Array(Math.max(16, sectionsSize(sections)));
    this.orderLength = 0;
    this.orderGone = 0;
    this.entranceRuns.clear();
    this.footprintRuns.clear();
    this.buffers = []; this.bufferUses = []; this.bufferIndex = new Map(); this.readers = []; this.freeBuffers = [];
    // The columns sized to the map at once (DO NOT let them double their way up: as much again as the map needs, empty).
    const size = sectionsSize(sections);
    this.grow(size);
    this.entranceRuns.reserve(size);
    this.footprintRuns.reserve(size);
    // One reader a table for the load, let go after it (`eachRecord`).
    const reading = new Map<ArrayBufferLike, TableReader>();
    for (const ref of eachSectionRef(sections)) {
      let reader = reading.get(ref.buffer);
      if (!reader) reading.set(ref.buffer, reader = new RecordTable(ref.buffer).reader());
      this.place(project(reader.record(ref.row)), ref);
    }
    this.journal.record('buildings', null, { detail: 'loaded' });
  }

  /** The page's changes, written in the diary as ONE entry (DO NOT write one a building: a tile's ~1,500 pushed every reader past what the diary keeps): each building's id once, in order, and what became of it (`BATCH_DETAIL`, `buildingOrder.ts`). */
  apply(changes: readonly BuildingChange[]): void {
    const ids: BuildingId[] = [];
    const rects: ChangeRect[] = [];
    let ops = '';
    for (const { id, value, ref } of changes) {
      const was = this.slots.get(id);
      if (value === null || ref === null) {
        if (was < 0) continue;
        rects.push(this.rectAt(was));
        this.remove(id, was);
        ids.push(id); ops += BATCH_GONE;
        continue;
      }
      if (was >= 0) rects.push(this.rectAt(was));
      const slot = this.place(value, ref);
      this.hold(slot, value);
      ids.push(id);
      rects.push(this.rectAt(slot));
      ops += was >= 0 ? BATCH_KEPT : BATCH_NEW;
    }
    if (ids.length) this.journal.record('buildings', rects, { ids, detail: `${BATCH_DETAIL}${ops}` });
  }

  near(minX: number, minY: number, maxX: number, maxY: number): TrafficBuilding[] {
    return this.inOrder(this.meeting([minX, minY, maxX, maxY])).map((slot) => this.record(slot));
  }

  nearIds(minX: number, minY: number, maxX: number, maxY: number): BuildingId[] {
    return this.inOrder(this.meeting([minX, minY, maxX, maxY])).map((slot) => this.idAt[slot]! as BuildingId);
  }

  nearAny(rects: readonly (readonly [number, number, number, number])[], pad: number,
    meets: (b: TrafficFacts, rect: readonly [number, number, number, number]) => boolean): BuildingId[] {
    const kept = new Set<number>();
    for (const r of rects) {
      // In the order of their ids, as a filing's `idsMeeting` answers.
      const met = this.meeting([r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad]).sort((a, b) => this.idAt[a]! - this.idAt[b]!);
      for (const slot of met) if (!kept.has(slot) && meets(this.factsAt(slot), r)) kept.add(slot);
    }
    return this.inOrder([...kept]).map((slot) => this.idAt[slot]! as BuildingId);
  }

  // ---------------------------------------------------------------- the columns

  private grow(n: number): void {
    this.idAt = grown(this.idAt, n); this.xs = grown(this.xs, n); this.ys = grown(this.ys, n);
    this.boxes = grown(this.boxes, n * 8); this.frontages = grown(this.frontages, n);
    this.kinds = grown(this.kinds, n); this.traits = grown(this.traits, n); this.filed = grown(this.filed, n);
    this.bufferAt = grown(this.bufferAt, n); this.rows = grown(this.rows, n); this.orderAt = grown(this.orderAt, n);
    this.marks = grown(this.marks, n);
    const was = this.heldAt.length;
    this.heldAt = grown(this.heldAt, n);
    this.heldAt.fill(-1, was);
    // DO NOT write the held records at slots past the array's end: V8 turns such an array into a dictionary (`TableReader`).
    while (this.held.length < n) this.held.push(undefined);
  }

  private factsAt(slot: number): TrafficFacts {
    const b = this.boxes, at = slot * 8;
    return {
      id: this.idAt[slot]! as BuildingId, x: this.xs[slot]!, y: this.ys[slot]!, kind: TRAFFIC_KINDS[this.kinds[slot]!]!, traits: this.traits[slot]!,
      frontage: this.frontages[slot]!,
      bounds: { minX: b[at]!, minY: b[at + 1]!, maxX: b[at + 2]!, maxY: b[at + 3]! },
      reach: { minX: b[at + 4]!, minY: b[at + 5]!, maxX: b[at + 6]!, maxY: b[at + 7]! },
    };
  }

  /** A building's columns written from its traffic record, its row noted, filed by place: its slot. */
  private place(b: TrafficBuilding, ref: RecordRef): number {
    const known = this.slots.get(b.id);
    let slot: number;
    if (known >= 0) {
      slot = known;
      this.unfile(slot);
      this.release(slot);
      this.unhold(slot);
      this.alive.delete(slot);
    } else {
      slot = this.slots.take(b.id);
      // Half again when the columns are full: an edit's few buildings past a map's (`load` sizes them to the map).
      if (slot >= this.idAt.length) this.grow(Math.max(slot + 1, Math.ceil(this.idAt.length * 1.5)));
      this.append(b.id, slot);
    }
    this.idAt[slot] = b.id;
    this.xs[slot] = b.x; this.ys[slot] = b.y;
    const box = this.boxes, at = slot * 8;
    box[at] = b.bounds.minX; box[at + 1] = b.bounds.minY; box[at + 2] = b.bounds.maxX; box[at + 3] = b.bounds.maxY;
    box[at + 4] = b.reach.minX; box[at + 5] = b.reach.minY; box[at + 6] = b.reach.maxX; box[at + 7] = b.reach.maxY;
    this.kinds[slot] = TRAFFIC_KINDS.indexOf(kindOf(b));
    this.traits[slot] = traitsOf(b);
    this.frontages[slot] = frontageBound(b);
    this.putEntrances(slot, b.entrances);
    this.putFootprints(slot, b.footprints);
    this.keepRef(slot, ref);
    this.file(slot);
    return slot;
  }

  private remove(id: BuildingId, slot: number): void {
    this.unfile(slot);
    this.release(slot);
    this.unhold(slot);
    this.alive.delete(slot);
    this.entranceRuns.drop(slot);
    this.footprintRuns.drop(slot);
    this.order[this.orderAt[slot]!] = Number.NaN;
    this.orderGone++;
    this.slots.delete(id);
  }

  private putEntrances(slot: number, list: readonly [Vec2, Vec2][]): void {
    const runs = this.entranceRuns;
    let at = runs.put(slot, list.length * 4);
    const d = runs.data;
    for (const [p, q] of list) { d[at++] = p.x; d[at++] = p.y; d[at++] = q.x; d[at++] = q.y; }
  }

  private putFootprints(slot: number, rings: readonly (readonly Vec2[])[]): void {
    const runs = this.footprintRuns;
    if (!rings.length) { runs.drop(slot); return; }
    let n = 1;
    for (const ring of rings) n += 1 + ring.length * 2;
    let at = runs.put(slot, n);
    const d = runs.data;
    d[at++] = rings.length;
    for (const ring of rings) {
      d[at++] = ring.length;
      for (const p of ring) { d[at++] = p.x; d[at++] = p.y; }
    }
  }

  /** An id put last in the store's order (the gone packed out first when they outweigh the rest). */
  private append(id: number, slot: number): void {
    if (this.orderLength === this.order.length) {
      if (this.orderGone * 2 > this.orderLength) this.packOrder();
      if (this.orderLength === this.order.length) this.order = grown(this.order, Math.ceil(this.order.length * 1.5) + 16);
    }
    this.orderAt[slot] = this.orderLength;
    this.order[this.orderLength++] = id;
  }

  private packOrder(): void {
    let k = 0;
    for (let i = 0; i < this.orderLength; i++) {
      const id = this.order[i]!;
      if (Number.isNaN(id)) continue;
      this.order[k] = id;
      this.orderAt[this.slots.get(id)] = k++;
    }
    this.orderLength = k;
    this.orderGone = 0;
  }

  private inOrder(slots: number[]): number[] {
    return slots.sort((a, b) => this.orderAt[a]! - this.orderAt[b]!);
  }

  // ---------------------------------------------------------------- the rows

  private keepRef(slot: number, ref: RecordRef): void {
    let at = this.bufferIndex.get(ref.buffer);
    if (at === undefined) {
      at = this.freeBuffers.length ? this.freeBuffers.pop()! : this.buffers.length;
      this.buffers[at] = ref.buffer; this.bufferUses[at] = 0; this.readers[at] = null;
      this.bufferIndex.set(ref.buffer, at);
    }
    this.bufferUses[at]!++;
    this.bufferAt[slot] = at;
    this.rows[slot] = ref.row;
  }

  /** A slot's table let go of; the table itself when no slot reads it now. */
  private release(slot: number): void {
    const at = this.bufferAt[slot]!;
    if (--this.bufferUses[at]! > 0) return;
    this.bufferIndex.delete(this.buffers[at]!);
    this.buffers[at] = null;
    this.readers[at] = null;
    this.freeBuffers.push(at);
  }

  /** A slot's traffic record: held, still alive elsewhere, or worked out again from its row. */
  private record(slot: number): TrafficBuilding {
    const held = this.held[slot];
    if (held) { this.used[this.heldAt[slot]!] = 1; return held; }
    let b = this.alive.get(slot)?.deref();
    if (!b) {
      const at = this.bufferAt[slot]!;
      // A weak reader (`TableReader`): the members it decoded live only while a record read holds them.
      const reader = this.readers[at] ??= new RecordTable(this.buffers[at]!).reader(true);
      b = project(reader.record(this.rows[slot]!));
      this.alive.set(slot, new WeakRef(b));
      this.gone.register(b, slot);
    }
    this.hold(slot, b);
    return b;
  }

  /** A traffic record held at its slot (one asked longest ago let go for it). */
  private hold(slot: number, b: TrafficBuilding): void {
    if (this.heldAt[slot]! >= 0) {
      this.held[slot] = b;
      this.used[this.heldAt[slot]!] = 1;
      if (!this.alive.has(slot) || this.alive.get(slot)!.deref() !== b) { this.alive.set(slot, new WeakRef(b)); this.gone.register(b, slot); }
      return;
    }
    const clock = this.clock, used = this.used;
    let at = this.hand;
    for (;;) {
      if (clock[at] === -1) break;
      if (!used[at]) { this.unhold(clock[at]!); break; }
      used[at] = 0;
      at = (at + 1) % this.holding;
    }
    clock[at] = slot;
    used[at] = 1;
    this.heldAt[slot] = at;
    this.held[slot] = b;
    if (this.alive.get(slot)?.deref() !== b) { this.alive.set(slot, new WeakRef(b)); this.gone.register(b, slot); }
    this.hand = (at + 1) % this.holding;
  }

  private unhold(slot: number): void {
    const at = this.heldAt[slot] ?? -1;
    if (at < 0) return;
    this.clock[at] = -1;
    this.used[at] = 0;
    this.heldAt[slot] = -1;
    this.held[slot] = undefined;
  }

  // ---------------------------------------------------------------- the cells

  /** The rectangle a slot is filed over: its box and its anchor (`BuildingGrid`). */
  private fileRect(slot: number): ChangeRect {
    const b = this.boxes, at = slot * 8, x = this.xs[slot]!, y = this.ys[slot]!;
    return [Math.min(b[at]!, x), Math.min(b[at + 1]!, y), Math.max(b[at + 2]!, x), Math.max(b[at + 3]!, y)];
  }

  /** A slot's rectangle in the diary, as `BuildingStore` writes it: its box, or its anchor when it has none. */
  private rectAt(slot: number): ChangeRect {
    const b = this.boxes, at = slot * 8, x = this.xs[slot]!, y = this.ys[slot]!;
    return Number.isFinite(b[at]!) ? [b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!] : [x, y, x, y];
  }

  private file(slot: number): void {
    const r = this.fileRect(slot);
    if (!r.every(Number.isFinite)) { this.filed[slot] = 0; return; }
    this.filed[slot] = 1;
    this.eachCell(r, (key) => {
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, list = { slots: new Int32Array(8), n: 0 });
      if (list.n === list.slots.length) list.slots = grown(list.slots, list.n * 2);
      list.slots[list.n++] = slot;
    });
  }

  private unfile(slot: number): void {
    if (!this.filed[slot]) return;
    this.filed[slot] = 0;
    this.eachCell(this.fileRect(slot), (key) => {
      const list = this.cells.get(key);
      if (!list) return;
      const s = list.slots;
      for (let i = 0; i < list.n; i++) {
        if (s[i] !== slot) continue;
        s[i] = s[--list.n]!;
        break;
      }
      if (!list.n) this.cells.delete(key);
    });
  }

  private eachCell(r: ChangeRect, visit: (key: number) => void): void {
    const cx0 = Math.floor(r[0] / CELL), cx1 = Math.floor(r[2] / CELL), cy0 = Math.floor(r[1] / CELL), cy1 = Math.floor(r[3] / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) visit(cellKey(cx, cy));
  }

  /** The slots whose filed rectangle meets `rect` (touching counts), each once. */
  private meeting(rect: ChangeRect): number[] {
    // The marks begun again before they pass what a column of 32-bit numbers holds.
    if (this.mark === 0x7fffffff) { this.marks.fill(0); this.mark = 0; }
    const mark = ++this.mark, marks = this.marks, b = this.boxes, xs = this.xs, ys = this.ys;
    const out: number[] = [];
    this.eachCell(rect, (key) => {
      const list = this.cells.get(key);
      if (!list) return;
      const s = list.slots;
      for (let i = 0; i < list.n; i++) {
        const slot = s[i]!;
        if (marks[slot] === mark) continue;
        marks[slot] = mark;
        const at = slot * 8, x = xs[slot]!, y = ys[slot]!;
        if (Math.min(b[at]!, x) <= rect[2] && Math.max(b[at + 2]!, x) >= rect[0] && Math.min(b[at + 1]!, y) <= rect[3] && Math.max(b[at + 3]!, y) >= rect[1]) out.push(slot);
      }
    });
    return out;
  }
}

/** A building of the page changed, as it is posted to the worker: where its record is read (`refOf`: its tile's shared table and row, or a table of its own), null when it is gone; DO NOT project it on the page. */
export interface BuildingSent {
  readonly id: BuildingId;
  readonly ref: RecordRef | null;
}

/** What the worker's copy of the map is made of: the roads and the transit, the lots and their keys, the buildings as the document's own buffers (`BuildingSections`: its table, shared, and the records written over it). */
export interface TrafficMap {
  readonly doc: SerializedDoc;
  readonly lots: readonly Lot[];
  readonly lotKeys: readonly string[];
  readonly buildings: BuildingSections;
}

/** The page's map as the worker is sent it whole (a map opened, generated, new): no terrain, paint or scenery, no building's record - the buildings' table posted as a handle (shared memory), never copied record by record. */
export function trafficMapOf(doc: RoadDoc): TrafficMap {
  return {
    doc: {
      version: 1, unit: METERS_PER_UNIT,
      nodes: [...doc.nodes.values()].map(savedNode),
      segments: [...doc.segments.values()].map(savedSegment),
      ...(hasTransit(doc.transit) ? { transit: doc.transit } : {}),
    },
    lots: doc.lotStore.toJSON(),
    lotKeys: [...doc.lotStore.keys],
    // DO NOT decode every building to send where it is read (`refOf` of each record): the table itself, and the few records written over it.
    buildings: doc.buildings.sections(),
  };
}

/** The buildings the diary named, as the worker is sent them: each record's place (`refOf`, not kept on the page), never its traffic record worked out here. */
export function buildingChangesOf(doc: RoadDoc, ids: Iterable<BuildingId>): BuildingSent[] {
  const out: BuildingSent[] = [];
  for (const id of ids) {
    const b = doc.buildings.get(id);
    out.push({ id, ref: b ? refOf(b, false) : null });
  }
  return out;
}

/** In the worker: the buildings sent (`buildingChangesOf`) read from their rows and worked out as traffic reads them. */
export function trafficChangesOf(sent: readonly BuildingSent[]): BuildingChange[] {
  const there = sent.filter((s) => s.ref !== null);
  const read = eachRecord(there.map((s) => s.ref!));
  const values = new Map<BuildingSent, TrafficBuilding>();
  for (const s of there) values.set(s, project(read.next().value as Building));
  return sent.map((s) => ({ id: s.id, value: values.get(s) ?? null, ref: s.ref }));
}

/** The worker's copy made from a map sent whole (`trafficMapOf`), each building read from its row and worked out here. */
export function takeTrafficMap(doc: RoadDoc, buildings: TrafficBuildingTable, map: TrafficMap): void {
  doc.replaceFromJSON(map.doc, { repair: false });
  // DO NOT leave the lots to `fromJSON`: it keeps a lot's building only when the document holds it, and this one holds none.
  doc.lotStore.load(map.lots, map.lotKeys);
  buildings.load(map.buildings);
}
