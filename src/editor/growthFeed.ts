import type { RngState } from '@core/rng';
import { type ChangeKind, type ChangeRect, rectAround } from '@world/changes';
import { JournalCursor } from '@world/derived';
import type { RoadDoc } from '@world/doc';
import { sampleGroundPatch } from '@world/groundPatch';
import type { PavingData, PavingSource } from '@world/paving';
import type { Lot } from '@world/lots';
import type { Network } from '@world/network';
import { Level } from '@world/roadTypes';
import { BuildingStore } from '@world/buildings/store';
import type { NodeId, SegmentId } from '@world/ids';
import type { Building, BuildingId } from '@world/buildings/types';
import { validateBuilding } from '@world/buildings/validate';
import type { GrowAnswer, GrowAsk, GrowthSync, JunctionPiece, RoadPiece } from './growthReplica';
import { commitGrown, growthReachOf, pickLot, streetPointsOf } from './zoning';

/**
 * THE GROWTH, THE PAGE'S SIDE: the lot picked (`zoning.ts` `pickLot`), sent
 * to the growth's worker with what it reads there (`growthReplica.ts`), and
 * the building it sends back written in the document (`commitGrown`) - the
 * same steps as `growOnLot`, the heavy one (`designOnLot`) off the page. One
 * lot at a time: the next lot and its stream depend on the building grown
 * before (the street fills along; the stream is seeded by the next id), so
 * the city grows exactly as it grew on the page.
 *
 * What the worker keeps is kept in step here, from the document's diary and
 * the network's changes, for the places it is sent: the buildings filed round
 * each lot (`BuildingStore.near`) sent once, then again only when the diary
 * names them (`changedSince`); the roads and junctions filed round each lot
 * (`Network.segmentCells`, `junctionCells`) the same way (`changesSince`);
 * the lot's own ground and paving read for it. DO NOT send the document or
 * the network whole for a lot: the copy of a town's records for every
 * building grown is the work this took off the page, made again.
 *
 * Written while the worker made it (a building put up, a road drawn, the
 * ground sculpted), the building is checked again on the page
 * (`validateBuilding`, the neighbours' rings already worked out) and asked
 * again if it no longer stands - never added unchecked against the document
 * as it is.
 */

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

/** What an answer came to: a building grown, the lot set aside, or a lot to ask for again (`ask`). */
export type GrowthOutcome =
  | { readonly kind: 'grown'; readonly id: number }
  | { readonly kind: 'refused' }
  | { readonly kind: 'again' }
  | { readonly kind: 'stale' };

/** The changes a building made off the page may have missed: its neighbours, its roads, its ground, its lot. */
const MOVES: readonly ChangeKind[] = ['buildings', 'roads', 'terrain', 'lots'];
/** More read round a lot each time the worker asked outside what it was sent (`GrowthMiss`), world units. */
const MISS_MARGIN = 32;
/** Misses before a lot is set aside: a lot that reads farther than this is not one the growth can build. */
const MOST_MISSES = 4;
/** How far round the street's points the roads are handed over (they are read at the points themselves). */
const STREET_PAD = 1;
/** Times a lot's building may be refused on the page, the document having moved, before the lot is set aside. */
const MOST_REFUSALS = 3;

interface Asked {
  readonly id: number;
  readonly lot: Lot;
  readonly rng: RngState;
  readonly refused: Set<number>;
  readonly extra: number;
  readonly misses: number;
  readonly netState: object | null;
}

export class GrowthSession {
  private nextAsk = 1;
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

  /**
   * Asks the worker for the next building (`pickLot`); false when no lot is
   * open (`refused` set aside) - or true, already asking, while one is made.
   */
  ask(refused: Set<number>, seed: number): boolean {
    if (this.asked) return true;
    const { doc, net } = this.host();
    // Read at every ask, a lot open or not: a cursor left unread keeps the diary's entries for it.
    this.readChanges(doc, net);
    const pick = pickLot(doc, refused, seed);
    if (!pick) return false;
    this.send(pick.lot, pick.rng.state(), refused, 0, 0);
    return true;
  }

  /**
   * The worker started again with nothing (it failed, `growthPool.ts`): all
   * is sent again as it is asked for, and the building being made asked for again.
   */
  restart(): void {
    this.sentBuildings.clear();
    this.staleBuildings.clear();
    this.resetBuildings = true;
    this.forgetRoads();
    const asked = this.asked;
    this.asked = null;
    if (asked) this.send(asked.lot, asked.rng, asked.refused, asked.extra, asked.misses);
  }

  /** The worker's answer, written in the document when it still stands there. */
  receive(answer: GrowAnswer): GrowthOutcome {
    const asked = this.asked;
    if (!asked || answer.id !== asked.id) return { kind: 'stale' };
    this.asked = null;
    const { doc, net, groundAt, pavedAt } = this.host();
    const changes = this.moves.read(doc.changes);
    // Not read again until the next ask: an idle cursor keeps nothing of the diary (`JournalReader`).
    this.moves.reset();
    const moved = changes === null || changes.length > 0 || (net?.state ?? null) !== asked.netState;
    const open = doc.openLots;
    open.count(asked.refused);
    const lot = asked.lot;
    if ('error' in answer) {
      // A fault of the growth itself, told; the lot set aside so the growth goes on.
      console.error(`[growth] lot ${lot.id} failed in the growth's worker: ${answer.error}`);
      if (this.lotOpen(doc, lot, asked.refused)) open.refuse(lot, asked.refused);
      return { kind: 'refused' };
    }
    if ('miss' in answer) {
      if (!this.lotOpen(doc, lot, asked.refused)) return { kind: 'again' };
      if (asked.misses + 1 >= MOST_MISSES) {
        console.warn(`[growth] lot ${lot.id} set aside: ${answer.miss}`);
        open.refuse(lot, asked.refused);
        return { kind: 'refused' };
      }
      // The same lot and stream, with more round it.
      this.readChanges(doc, net);
      this.send(lot, asked.rng, asked.refused, asked.extra + MISS_MARGIN, asked.misses + 1);
      return { kind: 'again' };
    }
    // The lot changed or took a building meanwhile: the next lot is picked again.
    if (!this.lotOpen(doc, lot, asked.refused)) return { kind: 'again' };
    if (answer.record === null) {
      // Nothing fits it as it was; the land may have changed under it since.
      if (moved) return { kind: 'again' };
      open.refuse(lot, asked.refused);
      return { kind: 'refused' };
    }
    if (moved && validateBuilding({ doc, net, groundAt, ...(pavedAt ? { pavedAt } : {}) }, { ...answer.record, id: doc.buildings.nextId } as Building) !== null) {
      const times = (this.refusals.get(lot.id) ?? 0) + 1;
      this.refusals.set(lot.id, times);
      if (times < MOST_REFUSALS) return { kind: 'again' };
      this.refusals.delete(lot.id);
      open.refuse(lot, asked.refused);
      return { kind: 'refused' };
    }
    this.refusals.delete(lot.id);
    return { kind: 'grown', id: commitGrown(doc, lot, answer.record) };
  }

  /** Whether `lot` is still the document's, zoned, with no building standing and not set aside. */
  private lotOpen(doc: RoadDoc, lot: Lot, refused: ReadonlySet<number>): boolean {
    return doc.lot(lot.id) === lot && lot.use !== undefined && !refused.has(lot.id)
      && !(lot.building !== undefined && doc.buildings.has(lot.building as BuildingId));
  }

  /**
   * What changed of what the worker holds, from the buildings' diary and the
   * network's changes: those it holds marked to be sent again, everything
   * when they cannot say (another map, entries forgotten, a load).
   */
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

  private send(lot: Lot, rng: RngState, refused: Set<number>, extra: number, misses: number): void {
    const host = this.host();
    const { doc, net } = host;
    const base = growthReachOf(lot);
    const grow = (r: ChangeRect): ChangeRect => [r[0] - extra, r[1] - extra, r[2] + extra, r[3] + extra];
    const reach = { lot: grow(base.lot), around: grow(base.around) };
    const sync: GrowthSync = { buildings: this.syncBuildings(doc, reach), roads: net ? this.syncRoads(net, reach.lot) : null };
    // The paving its street floors read (`streetPointsOf`): the roads round them handed over
    // (`PavingSource.pack`, read in the worker as here); read here only where none can be handed
    // over, or asked again after a miss (a point the roads handed over cannot answer).
    let paved: Float64Array | null = null;
    let paving: PavingData | null = null;
    const transfer: ArrayBuffer[] = [];
    const pavedAt = host.pavedAt;
    if (pavedAt) {
      const points = streetPointsOf(lot);
      const packed = misses === 0 ? pavedAt.pack?.(rectAround(points, STREET_PAD)!) ?? null : null;
      if (packed) { paving = packed.data; transfer.push(...packed.transfer); }
      else {
        paved = new Float64Array(points.length * 3);
        points.forEach((p, k) => { paved![k * 3] = p.x; paved![k * 3 + 1] = p.y; paved![k * 3 + 2] = pavedAt(p.x, p.y); });
      }
    }
    const id = this.nextAsk++;
    // From here, what changes the building may have missed.
    this.moves.read(doc.changes);
    this.asked = { id, lot, rng, refused, extra, misses, netState: net?.state ?? null };
    this.lane.post({
      id, sync, lot, rng, nextId: doc.buildings.nextId, reach,
      ground: host.groundAt ? sampleGroundPatch(reach.lot, host.cell, host.groundAt) : null,
      paving, paved, pavedRead: pavedAt !== undefined, roads: net !== null,
    }, transfer);
  }

  /** The buildings the worker holds that changed (`readChanges`), and those round this lot it does not hold yet. */
  private syncBuildings(doc: RoadDoc, reach: { readonly lot: ChangeRect; readonly around: ChangeRect }): GrowthSync['buildings'] {
    const store = doc.buildings;
    const reset = this.resetBuildings;
    const put: Building[] = [];
    const drop: number[] = [];
    for (const id of this.staleBuildings) {
      const b = store.get(id as BuildingId);
      if (b) put.push(b);
      else { drop.push(id); this.sentBuildings.delete(id); }
    }
    this.staleBuildings.clear();
    this.resetBuildings = false;
    for (const r of [reach.lot, reach.around]) {
      for (const b of store.near(r[0], r[1], r[2], r[3])) {
        if (this.sentBuildings.has(b.id)) continue;
        this.sentBuildings.add(b.id);
        put.push(b);
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
