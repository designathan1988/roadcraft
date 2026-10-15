import type { Aabb } from '@core/aabb';
import { Polyline } from '@core/polyline';
import { Rng, type RngState } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import type { ChangeRect } from '@world/changes';
import { CellFiling } from '@world/cells';
import { type GroundPatch, PatchMiss, patchGround } from '@world/groundPatch';
import type { NodeId, SegmentId } from '@world/ids';
import { type PavingData, pavingReader } from '@world/paving';
import type { Lot } from '@world/lots';
import { Level, type SurfaceLevel } from '@world/roadTypes';
import type { RoadStructure } from '@world/structures';
import { BuildingGrid } from '@world/buildings/grid';
import { type Neighbour, type NeighbourSource, settledNeighbour } from '@world/buildings/neighbours';
import type { Building, BuildingId } from '@world/buildings/types';
import type { JunctionRing, RoadReach, RoadReachRibbon } from '@world/buildings/validate';
import { GROW_ON_REACH, type GrowthSite, designOnLot, lotStream, nearestLot } from './zoning';

/** THE GROWTH'S WORKER: a building grown on a lot - its plan, its body made to measure, its yards furnished, each try checked against its neighbours, its roads and its slope (`zoning.ts` `designOnLot`) - worked out off the page's thread (`growth.worker.ts`), the page only writing the record it gets back (`growthFeed.ts`). A city of 2,560 m grew 28.6 s of its 120 s of work on the page's thread, in the frame, and the town stuttered as it grew (profile of 2026-10-15). What the worker reads is kept here, sent by the page with each lot and kept in step by the document's diary (`growthFeed.ts`), never the document copied whole for a lot: - the buildings round the lots grown, as their neighbours read them (`neighbours.ts` `settledNeighbour`: their boxes, what they put on the ground, their looks and height), the records themselves let go; - the roads and junctions filed round the lots grown, as the checks read them (`validate.ts` `RoadReach`): each road's widths, structure and centreline, each junction's kerb ring, filed over the same rectangles as the page's network files them, so a question about a place finds the same; - the lot's ground at the terrain's corners (`world/groundPatch.ts`) and its street's paving at the points the growth reads it (`streetPointsOf`). Each request says where its lot reads (`growthReachOf`): a question asked outside it is a miss (`GrowthMiss`), answered so, and the page sends the lot again with more round it - never a building made on what the worker was not sent. Pure: no three, no DOM, no page. */

/** A road as the page's network has it (`validate.ts` `RoadReachRibbon`), filed over `rect` (`Network.segmentCells`). */
export interface RoadPiece {
  readonly id: number;
  readonly rect: ChangeRect;
  readonly width: number;
  readonly sidewalk: number;
  /** Its record's structure; null: the document has no record of it. */
  readonly structure: RoadStructure | null;
  /** Its whole centreline (`SegmentRibbon.full.xy`). */
  readonly xy: Float64Array;
}

/** A junction's kerb ring as the page's network has it, filed over `rect` (`Network.junctionCells`). */
export interface JunctionPiece {
  readonly node: number;
  readonly rect: ChangeRect;
  /** The ring flattened (`Ring.flatten`), x and y in turn. */
  readonly ring: Float64Array;
  readonly bbox: Aabb;
  readonly empty: boolean;
}

/** What changed of what the worker keeps since the last request (`growthFeed.ts`). */
export interface GrowthSync {
  readonly buildings: {
    /** Everything kept forgotten first (another map, the diary forgot). */
    readonly reset: boolean;
    readonly put: readonly Building[];
    readonly drop: readonly number[];
  };
  readonly roads: {
    readonly reset: boolean;
    readonly segments: readonly RoadPiece[];
    readonly dropSegments: readonly number[];
    readonly junctions: readonly JunctionPiece[];
    readonly dropJunctions: readonly number[];
  } | null;
}

/** Buildings asked for: the first lot (picked by the page, `pickLot`) and the stream it is made with, then the lots the growth goes on to (`nearestLot`) while they are in `region` - the street filling along - and what they read. */
export interface GrowAsk {
  readonly id: number;
  readonly sync: GrowthSync;
  readonly lot: Lot;
  readonly rng: RngState;
  /** The seed of the lots' streams (`lotStream`). */
  readonly seed: number;
  /** Most lots grown for this ask (`BATCH_MOST` at most): 1, a lot at a time (the zones' growth, paced by the city's clock). */
  readonly most: number;
  /** The id the first building will take (its draft's, for the checks); the next ones take the ids after it. */
  readonly nextId: number;
  /** How many lots are open, `lot` among them (`OpenLots.count`). */
  readonly count: number;
  /** Where the building grown last stands (`OpenLots.lastGrown`), or null. */
  readonly last: { readonly x: number; readonly y: number } | null;
  /** The open lots whose centre is in `rect`, in the lots' order, `lot` not among them. */
  readonly region: { readonly rect: ChangeRect; readonly lots: readonly Lot[] };
  /** Where the lots read the document: `lot`, the ground, the roads, the paving and the buildings they meet; `around`, the buildings they look at. */
  readonly reach: { readonly lot: ChangeRect; readonly around: ChangeRect };
  /** The ground at the terrain's corners over `reach.lot`; null: no ground (the slope is not checked). */
  readonly ground: GroundPatch | null;
  /** The paving over `reach.lot` (`world/paving.ts` `PavingSource.pack`), read here as the page reads it; null: none handed over. */
  readonly paving: PavingData | null;
  /** The paving's height at each of `streetPointsOf(lot)` (the first lot's), x, y, height in turn, read by the page: where there is no `paving` to hand over, or a point of it the page must answer (asked again after a miss); null: none. */
  readonly paved: Float64Array | null;
  /** Whether there is paving to read at all (a grown building's street floor). */
  readonly pavedRead: boolean;
  /** Whether the roads are checked (a network on the page). */
  readonly roads: boolean;
}

/** A lot grown: the building made for it, null when nothing fits it. */
export interface Grown {
  readonly lot: number;
  readonly record: Omit<Building, 'id'> | null;
}

export type GrowAnswer =
  /** The lots grown, in order (the first the one asked for); `miss`: the next one read outside what was sent. */
  | { readonly id: number; readonly grown: readonly Grown[]; readonly miss?: string; readonly ms: number }
  | { readonly id: number; readonly error: string };

/** Most lots grown for one ask: the page writes them in one go, and each is drawn after it (a few frames' worth, never the town). */
export const BATCH_MOST = 32;

/** A question asked outside where the request said its lot reads: the page sends it again with more round it. */
export class GrowthMiss extends Error {}

/** Whether rectangle `a` lies within `b`. */
const within = (a: ChangeRect, b: ChangeRect): boolean => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];

/** The buildings round the lots grown, as their neighbours read them. */
class NeighbourReplica implements NeighbourSource {
  private readonly items = new Map<BuildingId, Neighbour>();
  private grid = new BuildingGrid<Neighbour>([], (n) => n.bounds);
  /** Where the request being answered reads them. */
  covered: readonly ChangeRect[] = [];

  /** The buildings this replica grew itself, not yet sent back by the page (written there or not). */
  private readonly own = new Set<BuildingId>();

  /** A building grown here, read by the next lots of the same ask. */
  grew(b: Building): void {
    this.own.add(b.id);
    this.put(b);
  }

  private put(b: Building): void {
    const n = settledNeighbour(b);
    if (this.items.has(n.id)) this.grid.update(n); else this.grid.insert(n);
    this.items.set(n.id, n);
  }

  apply(sync: GrowthSync['buildings']): void {
    // What it grew itself goes first: the page sends back what it wrote of it, under the ids it took.
    for (const id of this.own) {
      this.items.delete(id);
      this.grid.delete(id);
    }
    this.own.clear();
    if (sync.reset) {
      this.items.clear();
      this.grid = new BuildingGrid<Neighbour>([], (n) => n.bounds);
    }
    for (const id of sync.drop) {
      this.items.delete(id as BuildingId);
      this.grid.delete(id as BuildingId);
    }
    for (const b of sync.put) this.put(b);
  }

  near(minX: number, minY: number, maxX: number, maxY: number): readonly Neighbour[] {
    const q: ChangeRect = [minX, minY, maxX, maxY];
    if (!this.covered.some((c) => within(q, c))) throw new GrowthMiss(`buildings asked over [${q.join(', ')}], not sent`);
    return this.grid.near(minX, minY, maxX, maxY).map((id) => this.items.get(id)!);
  }
}

/** A road's structure as `RoadReach.doc` answers it. */
interface Structured { readonly structure: RoadStructure }

/** The roads and junctions round the lots grown, as the checks read them (`RoadReach`). */
class RoadReplica implements RoadReach {
  private readonly roads = new Map<SegmentId, RoadReachRibbon>();
  private readonly records = new Map<SegmentId, Structured>();
  private readonly roadCells = new CellFiling<SegmentId, RoadReachRibbon>();
  private readonly kerbs = new Map<NodeId, ReadonlyMap<SurfaceLevel, { readonly ring: JunctionRing }>>();
  private readonly kerbCells = new CellFiling<NodeId, object>();
  /** Where the request being answered reads them. */
  covered: ChangeRect = [0, 0, 0, 0];

  readonly doc = { segment: (id: SegmentId): Structured | undefined => this.records.get(id) };
  readonly ribbons: { get(id: SegmentId): RoadReachRibbon | undefined } = this.roads;
  readonly junctions: { get(node: NodeId): ReadonlyMap<SurfaceLevel, { readonly ring: JunctionRing }> | undefined } = this.kerbs;
  readonly segmentCells = { idsMeeting: (rect: ChangeRect): SegmentId[] => this.roadCells.idsMeeting(this.check(rect)) };
  readonly junctionCells = { idsMeeting: (rect: ChangeRect): NodeId[] => this.kerbCells.idsMeeting(this.check(rect)) };

  ribbonsMeeting(rect: ChangeRect): RoadReachRibbon[] {
    const out: RoadReachRibbon[] = [];
    for (const id of this.segmentCells.idsMeeting(rect)) {
      const ribbon = this.roads.get(id);
      if (ribbon) out.push(ribbon);
    }
    return out;
  }

  private check(rect: ChangeRect): ChangeRect {
    if (!within(rect, this.covered)) throw new GrowthMiss(`roads asked over [${rect.join(', ')}], not sent`);
    return rect;
  }

  apply(sync: NonNullable<GrowthSync['roads']>): void {
    if (sync.reset) {
      for (const id of [...this.roads.keys()]) this.dropRoad(id);
      for (const node of [...this.kerbs.keys()]) this.dropKerb(node);
    }
    for (const id of sync.dropSegments) this.dropRoad(id as SegmentId);
    for (const node of sync.dropJunctions) this.dropKerb(node as NodeId);
    for (const piece of sync.segments) {
      const id = piece.id as SegmentId;
      // Made again from the page's own numbers: the same centreline, the same widths.
      const ribbon: RoadReachRibbon = { id, road: { width: piece.width, sidewalk: piece.sidewalk }, full: Polyline.fromFlat(piece.xy) };
      this.roads.set(id, ribbon);
      if (piece.structure === null) this.records.delete(id); else this.records.set(id, { structure: piece.structure });
      this.roadCells.file(id, ribbon, piece.rect);
    }
    for (const piece of sync.junctions) {
      const node = piece.node as NodeId;
      const points: Vec2[] = [];
      for (let k = 0; k + 1 < piece.ring.length; k += 2) points.push({ x: piece.ring[k]!, y: piece.ring[k + 1]! });
      const ring: JunctionRing = { isEmpty: piece.empty, bbox: piece.bbox, flatten: () => points };
      const byLevel = new Map<SurfaceLevel, { readonly ring: JunctionRing }>([[Level.Curb, { ring }]]);
      this.kerbs.set(node, byLevel);
      this.kerbCells.file(node, byLevel, piece.rect);
    }
  }

  private dropRoad(id: SegmentId): void {
    this.roads.delete(id);
    this.records.delete(id);
    this.roadCells.remove(id);
  }

  private dropKerb(node: NodeId): void {
    this.kerbs.delete(node);
    this.kerbCells.remove(node);
  }
}

/** The paving's height as the page reads it: at the points it read for the lot (`paved`), else off the roads handed over (`pavingReader`, the page's numbers bit for bit); a point neither answers is a miss, and the page reads it itself in the lot asked again (`growthFeed.ts`). */
function pavedLookup(paved: Float64Array | null, paving: PavingData | null): (x: number, y: number) => number {
  const at = new Map<string, number>();
  if (paved) for (let k = 0; k + 2 < paved.length; k += 3) at.set(`${paved[k]},${paved[k + 1]}`, paved[k + 2]!);
  const read = paving ? pavingReader(paving) : null;
  return (x, y) => {
    const h = at.get(`${x},${y}`) ?? read?.(x, y);
    if (h === undefined) throw new GrowthMiss(`the paving asked at (${x}, ${y}), not sent`);
    return h;
  };
}

/** What the growth's worker keeps, and the buildings made for each ask (`handle`). */
export class GrowthReplica {
  private readonly neighbours = new NeighbourReplica();
  private readonly roads = new RoadReplica();

  /** One ask: what changed taken in; the first lot's building made, then the next lot's - the open lot nearest the building grown last, as `pickLot` finds it - and so on while that lot is one the ask sent (`region`), up to `BATCH_MOST`; each building grown read by the next lots as a neighbour. The growth stops where only the page can go on: no lot open, the last building too near the region's edge to know its nearest lot, none near (the next is drawn at random over the town), or a lot reading outside what was sent (`miss`). */
  handle(ask: GrowAsk): GrowAnswer {
    const started = performance.now();
    this.neighbours.apply(ask.sync.buildings);
    if (ask.sync.roads) this.roads.apply(ask.sync.roads);
    this.neighbours.covered = [ask.reach.lot, ask.reach.around];
    this.roads.covered = ask.reach.lot;
    const groundAt = ask.ground ? patchGround(ask.ground) : null;
    const pavedAt = ask.pavedRead ? pavedLookup(ask.paved, ask.paving) : undefined;
    const open = [...ask.region.lots];
    const [rx0, ry0, rx1, ry1] = ask.region.rect;
    const grown: Grown[] = [];
    let lot = ask.lot, rng = Rng.fromState(ask.rng), nextId = ask.nextId, count = ask.count, last = ask.last;
    for (;;) {
      const site: GrowthSite = { neighbours: this.neighbours, net: ask.roads ? this.roads : null, groundAt, ...(pavedAt ? { pavedAt } : {}), nextId: nextId as BuildingId };
      let record: Omit<Building, 'id'> | null;
      try {
        record = designOnLot(site, lot, rng);
      } catch (error) {
        if (!(error instanceof GrowthMiss || error instanceof PatchMiss)) throw error;
        return { id: ask.id, grown, miss: error.message, ms: performance.now() - started };
      }
      grown.push({ lot: lot.id, record });
      if (record) {
        this.neighbours.grew({ ...record, id: nextId as BuildingId } as Building);
        last = { x: record.x, y: record.y };
        nextId++;
      }
      count--;
      if (grown.length >= Math.min(ask.most, BATCH_MOST) || count <= 0 || !last) break;
      // The next lot as `pickLot` finds it, when the region holds every open lot it may be.
      if (last.x - GROW_ON_REACH < rx0 || last.x + GROW_ON_REACH > rx1 || last.y - GROW_ON_REACH < ry0 || last.y + GROW_ON_REACH > ry1) break;
      const next = nearestLot(open, last);
      if (!next) break;
      open.splice(open.indexOf(next), 1);
      rng = lotStream(ask.seed, nextId, count).rng;
      lot = next;
    }
    return { id: ask.id, grown, ms: performance.now() - started };
  }
}
