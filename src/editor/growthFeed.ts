import type { RngState } from '@core/rng';
import type { ChangeKind, ChangeRect } from '@world/changes';
import { JournalCursor } from '@world/derived';
import type { RoadDoc } from '@world/doc';
import { sampleGroundPatch } from '@world/groundPatch';
import type { PavingData, PavingSource } from '@world/paving';
import type { Lot } from '@world/lots';
import type { Network } from '@world/network';
import { Level } from '@world/roadTypes';
import { BuildingStore } from '@world/buildings/store';
import { type RecordRef, refOf } from '@world/buildings/recordTable';
import type { NodeId, SegmentId } from '@world/ids';
import type { Building, BuildingId } from '@world/buildings/types';
import { validateBuilding } from '@world/buildings/validate';
import type { GrowAnswer, GrowAsk, GrowthSync, JunctionPiece, RoadPiece } from './growthReplica';
import { LIKE_REACH, commitGrown, growthReachOf, pickLot, streetPointsOf } from './zoning';
import { lotCentre } from '@world/lots';

/** A rectangle grown by `pad` on every side. */
const grow = (r: ChangeRect, pad: number): ChangeRect => [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];

/** THE GROWTH, THE PAGE'S SIDE: the lot picked (`zoning.ts` `pickLot`), sent to the growth's worker with what it reads there (`growthReplica.ts`), and the building it sends back written in the document (`commitGrown`) - the same steps as `growOnLot`, the heavy one (`designOnLot`) off the page. One lot at a time: the next lot and its stream depend on the building grown before (the street fills along; the stream is seeded by the next id), so the city grows exactly as it grew on the page. What the worker keeps is kept in step here, from the document's diary and the network's changes, for the places it is sent: the buildings filed round each lot (`BuildingStore.near`) sent once, as where the worker reads them (`recordTable.ts` `refOf`: their tile's shared table and row, the one the cell jobs read; never the record copied), then again only when the diary names them (`changedSince`); the roads and junctions filed round each lot (`Network.segmentCells`, `junctionCells`) the same way (`changesSince`); the lot's own ground and paving read for it. DO NOT send the document or the network whole for a lot: the copy of a town's records for every building grown is the work this took off the page, made again. Written while the worker made it (a building put up, a road drawn, the ground sculpted), the building is checked again on the page (`validateBuilding`, the neighbours' rings already worked out) and asked again if it no longer stands - never added unchecked against the document as it is. */

/** Where the growth reads the document: the page's document, network and ground. */
export interface GrowthHost {
  readonly doc: RoadDoc;
  readonly net: Network | null;
  readonly groundAt: ((x: number, y: number) => number) | null;
  /** The paving's height; with `pack`, handed to the worker as the roads it reads from (`world/paving.ts`). */
  readonly pavedAt?: PavingSource;
  /** The side of the terrain's cells: the grid the lot's ground is read on (`world/groundPatch.ts`). */
  readonly cell: number;
}

/** Where the growth's worker answers (`growthPool.ts`; a spec's stand-in). */
export interface GrowthLane {
  /** `transfer`: buffers made for this ask alone, handed over rather than copied (MDN, "Transferable objects"). */
  post(ask: GrowAsk, transfer: readonly ArrayBuffer[]): void;
}

/** What an answer came to: the buildings written (their ids, in order), the lots set aside, and whether the rest was let go to be asked for again (the document moved under it, `ask`); or nothing (`stale`: not the ask waited for). */
export type GrowthOutcome =
  | { readonly kind: 'answered'; readonly grown: readonly number[]; readonly refused: number; readonly again: boolean }
  | { readonly kind: 'stale' };

/** Half the side of the region round the lot asked for whose open lots the growth goes on to in the worker (`GrowAsk.region`). */
const REGION_HALF = 160;
/** How far past the region its lots read the document: their frame, its margin (`growthReachOf`), a lot's size. */
const READ_PAD = 48;

/** The changes a building made off the page may have missed: its neighbours, its roads, its ground, its lot. */
const MOVES: readonly ChangeKind[] = ['buildings', 'roads', 'terrain', 'lots'];
/** More read round a lot each time the worker asked outside what it was sent (`GrowthMiss`), world units. */
const MISS_MARGIN = 32;
/** Misses before a lot is set aside: a lot that reads farther than this is not one the growth can build. */
const MOST_MISSES = 4;
/** Times a lot's building may be refused on the page, the document having moved, before the lot is set aside. */
const MOST_REFUSALS = 3;

interface Asked {
  readonly id: number;
  readonly lot: Lot;
  /** Every lot sent, by id: the first and the region's (the records as they were, to tell a lot changed since). */
  readonly lots: ReadonlyMap<number, Lot>;
  readonly rng: RngState;
  readonly refused: Set<number>;
  readonly extra: number;
  readonly misses: number;
  readonly netState: object | null;
}

export class GrowthSession {
  private nextAsk = 1;
  /** The seed of the lots' streams, and the most lots an ask grows, as last asked with. */
  private seed = 0;
  private most = 1;
  private asked: Asked | null = null;
  /** The buildings the worker holds; those of them the diary named since they were sent; whether it is to forget them all. */
  private readonly sentBuildings = new Set<number>();
  private readonly staleBuildings = new Set<number>();
  private resetBuildings = true;
  private readonly buildingsRead = BuildingStore.cursor();
  /** The roads and junctions the worker holds, those of them the network changed since, and its state they were last read at. */
  private readonly sentRoads = new Set<number>();
  private readonly sentKerbs = new Set<number>();
  private readonly staleRoads = new Set<number>();
  private readonly staleKerbs = new Set<number>();
  private resetRoads = true;
  private roadsOf: Network | null = null;
  private roadsState: object | null = null;
  /** What changed while a building was being made (`MOVES`): read when it is asked for and when it comes. */
  private readonly moves = new JournalCursor(MOVES);
  /** Lots whose building was refused on the page, how many times. */
  private readonly refusals = new Map<number, number>();

  constructor(private readonly lane: GrowthLane, private readonly host: () => GrowthHost) {}

  /** Whether a building is being made. */
  get busy(): boolean {
    return this.asked !== null;
  }

  /** Asks the worker for the next building (`pickLot`); false when no lot is open (`refused` set aside) - or true, already asking, while one is made. */
  ask(refused: Set<number>, seed: number, most = 1): boolean {
    if (this.asked) return true;
    this.seed = seed;
    this.most = most;
    const { doc, net } = this.host();
    // Read at every ask, a lot open or not: a cursor left unread keeps the diary's entries for it.
    this.readChanges(doc, net);
    const pick = pickLot(doc, refused, seed);
    if (!pick) return false;
    this.send(pick.lot, pick.rng.state(), refused, 0, 0);
    return true;
  }

  /** The worker started again with nothing (it failed, `growthPool.ts`): all is sent again as it is asked for, and the building being made asked for again. */
  restart(): void {
    this.sentBuildings.clear();
    this.staleBuildings.clear();
    this.resetBuildings = true;
    this.forgetRoads();
    const asked = this.asked;
    this.asked = null;
    if (asked) this.send(asked.lot, asked.rng, asked.refused, asked.extra, asked.misses);
  }

  /** The worker's answer, its buildings written in order (`onGrown` told of each as it is, before the next) while each still stands where it was made - checked again first when the document moved meanwhile; the rest let go at the first that does not, to be asked for again. */
  receive(answer: GrowAnswer, onGrown: (id: number) => void = () => {}): GrowthOutcome {
    const asked = this.asked;
    if (!asked || answer.id !== asked.id) return { kind: 'stale' };
    this.asked = null;
    const { doc, net, groundAt, pavedAt } = this.host();
    const changes = this.moves.read(doc.changes);
    // Not read again until the next ask: an idle cursor keeps nothing of the diary (`JournalReader`).
    this.moves.reset();
    // Moved by someone else while the worker made them (what is written below is in the order it assumed).
    const moved = changes === null || changes.length > 0 || (net?.state ?? null) !== asked.netState;
    const open = doc.openLots;
    const grown: number[] = [];
    let refused = 0;
    if ('error' in answer) {
      // A fault of the growth itself, told; the lot set aside so the growth goes on.
      console.error(`[growth] lot ${asked.lot.id} failed in the growth's worker: ${answer.error}`);
      open.count(asked.refused);
      if (this.lotOpen(doc, asked.lot, asked.refused)) { open.refuse(asked.lot, asked.refused); refused++; }
      return { kind: 'answered', grown, refused, again: false };
    }
    for (const g of answer.grown) {
      open.count(asked.refused);
      const lot = asked.lots.get(g.lot)!;
      // The lot changed or took a building meanwhile: the next lot is picked again.
      if (!this.lotOpen(doc, lot, asked.refused)) return { kind: 'answered', grown, refused, again: true };
      if (g.record === null) {
        // Nothing fits it as it was; the land may have changed under it since.
        if (moved) return { kind: 'answered', grown, refused, again: true };
        open.refuse(lot, asked.refused);
        refused++;
        continue;
      }
      if (moved && validateBuilding({ doc, net, groundAt, ...(pavedAt ? { pavedAt } : {}) }, { ...g.record, id: doc.buildings.nextId } as Building) !== null) {
        const times = (this.refusals.get(lot.id) ?? 0) + 1;
        this.refusals.set(lot.id, times);
        if (times >= MOST_REFUSALS) {
          this.refusals.delete(lot.id);
          open.refuse(lot, asked.refused);
          refused++;
        }
        // What came after was made beside it: let go with it.
        return { kind: 'answered', grown, refused, again: true };
      }
      this.refusals.delete(lot.id);
      const id = commitGrown(doc, lot, g.record);
      grown.push(id);
      onGrown(id);
    }
    if (answer.miss !== undefined && answer.grown.length === 0) {
      // The first lot read outside what was sent: the same lot and stream, with more round it.
      open.count(asked.refused);
      const lot = asked.lot;
      if (!this.lotOpen(doc, lot, asked.refused)) return { kind: 'answered', grown, refused, again: true };
      if (asked.misses + 1 >= MOST_MISSES) {
        console.warn(`[growth] lot ${lot.id} set aside: ${answer.miss}`);
        open.refuse(lot, asked.refused);
        return { kind: 'answered', grown, refused: refused + 1, again: false };
      }
      this.readChanges(doc, net);
      this.send(lot, asked.rng, asked.refused, asked.extra + MISS_MARGIN, asked.misses + 1);
    }
    return { kind: 'answered', grown, refused, again: false };
  }

  /** Whether `lot` is still the document's, zoned, with no building standing and not set aside. */
  private lotOpen(doc: RoadDoc, lot: Lot, refused: ReadonlySet<number>): boolean {
    return doc.lot(lot.id) === lot && lot.use !== undefined && !refused.has(lot.id)
      && !(lot.building !== undefined && doc.buildings.has(lot.building as BuildingId));
  }

  /** What changed of what the worker holds, from the buildings' diary and the network's changes: those it holds marked to be sent again, everything when they cannot say (another map, entries forgotten, a load). */
  private readChanges(doc: RoadDoc, net: Network | null): void {
    const changed = doc.buildings.changedFor(this.buildingsRead);
    if (changed === null) {
      this.sentBuildings.clear();
      this.staleBuildings.clear();
      this.resetBuildings = true;
    } else for (const id of changed) if (this.sentBuildings.has(id)) this.staleBuildings.add(id);
    if (!net) return;
    const delta = this.roadsOf === net && this.roadsState !== null ? net.changesSince(this.roadsState) : null;
    if (delta === null) this.forgetRoads();
    else {
      for (const id of delta.segments) if (this.sentRoads.has(id)) this.staleRoads.add(id);
      for (const node of delta.nodes) if (this.sentKerbs.has(node)) this.staleKerbs.add(node);
    }
    this.roadsOf = net;
    this.roadsState = net.state;
  }

  private forgetRoads(): void {
    this.sentRoads.clear();
    this.sentKerbs.clear();
    this.staleRoads.clear();
    this.staleKerbs.clear();
    this.resetRoads = true;
  }

  /** The ask for `lot` (picked here, `pickLot`, its stream `rng`) and the lots the growth may go on to in the worker: the open lots round it, with what they all read - the buildings, roads and ground round them, the paving there - sent once and kept in step (`syncBuildings`, `syncRoads`), the ground and the paving of the region read for this ask. */
  private send(lot: Lot, rng: RngState, refused: Set<number>, extra: number, misses: number): void {
    const host = this.host();
    const { doc, net } = host;
    const open = doc.openLots;
    const count = open.count(refused);
    const last = open.lastGrown();
    const base = growthReachOf(lot);
    const c = lotCentre(lot);
    const half = REGION_HALF + extra;
    const rect: ChangeRect = [c.x - half, c.y - half, c.x + half, c.y + half];
    const pad = READ_PAD + extra;
    const union = (a: ChangeRect, b: ChangeRect): ChangeRect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
    const lotRead = union([rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad], grow(base.lot, extra));
    const around = union([lotRead[0] - LIKE_REACH, lotRead[1] - LIKE_REACH, lotRead[2] + LIKE_REACH, lotRead[3] + LIKE_REACH], grow(base.around, extra));
    const reach = { lot: lotRead, around };
    // The open lots whose centre is in the region, in the lots' order (`OpenLots.near` answers in it).
    const lots = new Map<number, Lot>([[lot.id, lot]]);
    const regionLots = doc.lotsIn(rect).filter((l) => {
      if (l.id === lot.id || !this.lotOpen(doc, l, refused)) return false;
      const m = lotCentre(l);
      return m.x >= rect[0] && m.x <= rect[2] && m.y >= rect[1] && m.y <= rect[3];
    }).sort((a, b) => doc.lotStore.orderOf(a.id)! - doc.lotStore.orderOf(b.id)!);
    for (const l of regionLots) lots.set(l.id, l);
    const sync: GrowthSync = { buildings: this.syncBuildings(doc, reach), roads: net ? this.syncRoads(net, reach.lot) : null };
    // The paving the street floors read (`streetPointsOf`): the roads over the region handed over (`PavingSource.pack`, read in the worker as here); the first lot's points read here where nothing can be handed over, or asked again after a miss (a point the roads handed over cannot answer).
    let paved: Float64Array | null = null;
    let paving: PavingData | null = null;
    const transfer: ArrayBuffer[] = [];
    const pavedAt = host.pavedAt;
    if (pavedAt) {
      const packed = pavedAt.pack?.(reach.lot) ?? null;
      if (packed) { paving = packed.data; transfer.push(...packed.transfer); }
      if (!packed || misses > 0) {
        const points = streetPointsOf(lot);
        paved = new Float64Array(points.length * 3);
        points.forEach((p, k) => { paved![k * 3] = p.x; paved![k * 3 + 1] = p.y; paved![k * 3 + 2] = pavedAt(p.x, p.y); });
      }
    }
    const id = this.nextAsk++;
    // From here, what changes the buildings may have missed.
    this.moves.read(doc.changes);
    this.asked = { id, lot, lots, rng, refused, extra, misses, netState: net?.state ?? null };
    this.lane.post({
      id, sync, lot, rng, seed: this.seed, most: this.most, nextId: doc.buildings.nextId, count, last, region: { rect, lots: regionLots }, reach,
      ground: host.groundAt ? sampleGroundPatch(reach.lot, host.cell, host.groundAt) : null,
      paving, paved, pavedRead: pavedAt !== undefined, roads: net !== null,
    }, transfer);
  }

  /** The buildings the worker holds that changed (`readChanges`), and those round this lot it does not hold yet: each as its row in a shared table (`refOf`). */
  private syncBuildings(doc: RoadDoc, reach: { readonly lot: ChangeRect; readonly around: ChangeRect }): GrowthSync['buildings'] {
    const store = doc.buildings;
    const reset = this.resetBuildings;
    const put: RecordRef[] = [];
    const drop: number[] = [];
    for (const id of this.staleBuildings) {
      const b = store.get(id as BuildingId);
      if (b) put.push(refOf(b));
      else { drop.push(id); this.sentBuildings.delete(id); }
    }
    this.staleBuildings.clear();
    this.resetBuildings = false;
    for (const r of [reach.lot, reach.around]) {
      for (const b of store.near(r[0], r[1], r[2], r[3])) {
        if (this.sentBuildings.has(b.id)) continue;
        this.sentBuildings.add(b.id);
        put.push(refOf(b));
      }
    }
    return { reset, put, drop };
  }

  /** The roads and junctions the worker holds that changed (`readChanges`), and those filed round this lot it does not hold yet. */
  private syncRoads(net: Network, rect: ChangeRect): NonNullable<GrowthSync['roads']> {
    const reset = this.resetRoads;
    const segments: RoadPiece[] = [], junctions: JunctionPiece[] = [];
    const dropSegments: number[] = [], dropJunctions: number[] = [];
    for (const id of this.staleRoads) {
      const piece = roadPiece(net, id as SegmentId);
      if (piece) segments.push(piece);
      else { dropSegments.push(id); this.sentRoads.delete(id); }
    }
    for (const node of this.staleKerbs) {
      const piece = junctionPiece(net, node as NodeId);
      if (piece) junctions.push(piece);
      else { dropJunctions.push(node); this.sentKerbs.delete(node); }
    }
    this.staleRoads.clear();
    this.staleKerbs.clear();
    this.resetRoads = false;
    for (const id of net.segmentCells.idsMeeting(rect)) {
      if (this.sentRoads.has(id)) continue;
      const piece = roadPiece(net, id);
      if (!piece) continue;
      this.sentRoads.add(id);
      segments.push(piece);
    }
    for (const node of net.junctionCells.idsMeeting(rect)) {
      if (this.sentKerbs.has(node)) continue;
      const piece = junctionPiece(net, node);
      if (!piece) continue;
      this.sentKerbs.add(node);
      junctions.push(piece);
    }
    return { reset, segments, dropSegments, junctions, dropJunctions };
  }
}

/** A road as the worker keeps it (`RoadPiece`), or null: no ribbon filed for it. */
function roadPiece(net: Network, id: SegmentId): RoadPiece | null {
  const ribbon = net.ribbons.get(id);
  const rect = net.segmentCells.rectOf(id);
  if (!ribbon || !rect) return null;
  return { id, rect, width: ribbon.road.width, sidewalk: ribbon.road.sidewalk, structure: net.doc.segment(id)?.structure ?? null, xy: ribbon.full.xy };
}

/** A junction's kerb ring as the worker keeps it (`JunctionPiece`), or null: none filed. */
function junctionPiece(net: Network, node: NodeId): JunctionPiece | null {
  const junction = net.junctions.get(node)?.get(Level.Curb);
  const rect = net.junctionCells.rectOf(node);
  if (!junction || !rect) return null;
  const flat = junction.ring.flatten();
  const ring = new Float64Array(flat.length * 2);
  flat.forEach((p, k) => { ring[k * 2] = p.x; ring[k * 2 + 1] = p.y; });
  const box = junction.ring.bbox;
  return { node, rect, ring, bbox: { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY }, empty: junction.ring.isEmpty };
}
