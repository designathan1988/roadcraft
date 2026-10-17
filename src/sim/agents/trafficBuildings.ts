import type { Vec2 } from '@core/vec2';
import { type RoadDoc, type SerializedDoc, savedNode, savedSegment } from '@world/doc';
import type { ChangeJournal, ChangeRect } from '@world/changes';
import { CellFiling, grow } from '@world/cells';
import { hasTransit } from '@world/transit';
import type { Lot } from '@world/lots';
import { METERS_PER_UNIT, m } from '@world/units';
import { solidFootprints, storedBounds } from '@world/buildings/geometry';
import { streetDoors, type StreetDoor } from '@world/buildings/streetDoors';
import { lorryDocks, type LorryDock } from '@world/buildings/docks';
import { entrancesOf } from '@world/parkingLayout';
import type { Building, BuildingElement, BuildingFunction, BuildingId, BuildingUse, Volume } from '@world/buildings/types';
import { type RecordRef, eachRecord, refOf } from '@world/buildings/recordTable';
import type { LotPart } from './lotNav';
import { LANE_REACH } from './lotBays';

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

/** The buildings as the simulation asks for them: by id, all in the store's order, by place in the store's order. */
export interface TrafficBuildings {
  get(id: BuildingId): TrafficBuilding | undefined;
  all(): Iterable<TrafficBuilding>;
  /** The buildings whose box may reach the rectangle, in the store's order. */
  near(minX: number, minY: number, maxX: number, maxY: number): TrafficBuilding[];
  /** The buildings `meets` keeps for one of `rects`, asked of those within `pad` of it, each once, in the store's order. */
  nearAny(rects: readonly (readonly [number, number, number, number])[], pad: number,
    meets: (b: TrafficBuilding, rect: readonly [number, number, number, number]) => boolean): TrafficBuilding[];
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
  return {
    get: (id) => {
      const b = doc.buildings.get(id);
      return b ? trafficBuilding(b) : undefined;
    },
    *all() {
      for (const b of doc.buildings.all()) yield trafficBuilding(b);
    },
    near: (minX, minY, maxX, maxY) => doc.buildings.near(minX, minY, maxX, maxY).map(trafficBuilding),
    nearAny: (rects, pad, meets) => doc.buildings.nearAny(rects, pad, (b, r) => meets(trafficBuilding(b), r)).map(trafficBuilding),
  };
}

/** A building's rectangle in the diary, as `BuildingStore` writes it: its box, or its anchor when it has none. */
function rectOf(b: TrafficBuilding): ChangeRect {
  const box = b.bounds;
  return Number.isFinite(box.minX) ? [box.minX, box.minY, box.maxX, box.maxY] : [b.x, b.y, b.x, b.y];
}

/** The rectangle a building is filed over: its box and its anchor (`BuildingGrid`); null when it is not a place. */
function fileRect(b: TrafficBuilding): ChangeRect | null {
  const box = b.bounds;
  const r: ChangeRect = [Math.min(box.minX, b.x), Math.min(box.minY, b.y), Math.max(box.maxX, b.x), Math.max(box.maxY, b.y)];
  return r.every(Number.isFinite) ? r : null;
}

/** A building of the page changed, as the worker is told it: its traffic record now, null when it is gone. */
export interface BuildingChange {
  readonly id: BuildingId;
  readonly value: TrafficBuilding | null;
}

/** The buildings in the simulation's worker: only their traffic records, filed by the world's 256 m cells */
export class TrafficBuildingTable implements TrafficBuildings {
  /** In the page store's order: a record put back where one stood keeps its place, a new one goes last. */
  private readonly items = new Map<BuildingId, TrafficBuilding>();
  private readonly ranks = new Map<BuildingId, number>();
  private nextRank = 0;
  private cells = new CellFiling<BuildingId, TrafficBuilding>();

  constructor(private readonly journal: ChangeJournal) {}

  get(id: BuildingId): TrafficBuilding | undefined {
    return this.items.get(id);
  }

  all(): IterableIterator<TrafficBuilding> {
    return this.items.values();
  }

  /** @rebuild Another map: every record taken, the diary told the whole set changed. */
  load(list: readonly TrafficBuilding[]): void {
    this.items.clear();
    this.ranks.clear();
    this.nextRank = 0;
    this.cells = new CellFiling<BuildingId, TrafficBuilding>();
    for (const b of list) this.place(b);
    this.journal.record('buildings', null, { detail: 'loaded' });
  }

  /** The page's changes, each written in the diary as `BuildingStore.restore` writes it (`buildingOrder.ts` reads `restored`). */
  apply(changes: readonly BuildingChange[]): void {
    for (const { id, value } of changes) {
      const was = this.items.get(id);
      if (value === null) {
        if (!was) continue;
        this.items.delete(id);
        this.ranks.delete(id);
        this.cells.remove(id);
        this.journal.record('buildings', [rectOf(was)], { ids: [id], detail: 'restored' });
        continue;
      }
      this.place(value);
      this.journal.record('buildings', was ? [rectOf(was), rectOf(value)] : [rectOf(value)], { ids: was ? [id, id] : [id], detail: 'restored' });
    }
  }

  near(minX: number, minY: number, maxX: number, maxY: number): TrafficBuilding[] {
    return this.inOrder(this.cells.idsMeeting([minX, minY, maxX, maxY]));
  }

  nearAny(rects: readonly (readonly [number, number, number, number])[], pad: number,
    meets: (b: TrafficBuilding, rect: readonly [number, number, number, number]) => boolean): TrafficBuilding[] {
    const kept = new Set<BuildingId>();
    for (const r of rects) {
      for (const id of this.cells.idsMeeting(grow(r, pad))) {
        if (!kept.has(id) && meets(this.items.get(id)!, r)) kept.add(id);
      }
    }
    return this.inOrder(kept);
  }

  private place(b: TrafficBuilding): void {
    if (!this.items.has(b.id)) this.ranks.set(b.id, this.nextRank++);
    this.items.set(b.id, b);
    const rect = fileRect(b);
    if (rect) this.cells.file(b.id, b, rect); else this.cells.remove(b.id);
  }

  private inOrder(ids: Iterable<BuildingId>): TrafficBuilding[] {
    return [...ids].sort((a, b) => this.ranks.get(a)! - this.ranks.get(b)!).map((id) => this.items.get(id)!);
  }
}

/** A building of the page changed, as it is posted to the worker: where its record is read (`refOf`: its tile's shared table and row, or a table of its own), null when it is gone; DO NOT project it on the page. */
export interface BuildingSent {
  readonly id: BuildingId;
  readonly ref: RecordRef | null;
}

/** What the worker's copy of the map is made of: the roads and the transit, the lots and their keys, where each building's record is read. */
export interface TrafficMap {
  readonly doc: SerializedDoc;
  readonly lots: readonly Lot[];
  readonly lotKeys: readonly string[];
  readonly buildings: readonly RecordRef[];
}

/** The page's map as the worker is sent it whole (a map opened, generated, new): no terrain, paint or scenery, no building's record. */
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
    buildings: Array.from(doc.buildings.all(), (b) => refOf(b, false)),
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
  return sent.map((s) => ({ id: s.id, value: values.get(s) ?? null }));
}

/** The worker's copy made from a map sent whole (`trafficMapOf`), each building read from its row and worked out here. */
export function takeTrafficMap(doc: RoadDoc, buildings: TrafficBuildingTable, map: TrafficMap): void {
  doc.replaceFromJSON(map.doc, { repair: false });
  // DO NOT leave the lots to `fromJSON`: it keeps a lot's building only when the document holds it, and this one holds none.
  doc.lotStore.load(map.lots, map.lotKeys);
  buildings.load(Array.from(eachRecord(map.buildings), project));
}
