import type { ChangeLog } from '@core/changeLog';
import { Digest } from '@core/digest';
import { IdSlots } from '@core/idSlots';
import { RunPool } from '@core/runPool';
import type { Vec2 } from '@core/vec2';
import type { BuildingId } from '@world/buildings/types';
import type { RoadDoc } from '@world/doc';
import type { SegmentId } from '@world/ids';
import type { GraphChange } from '@world/lanelets';
import type { Network } from '@world/network';
import { PARKING_PITCH } from '@world/parking';
import { parkingDigest, parkingLayout } from '@world/parkingLayout';
import { m } from '@world/units';
import type { BuildingDelta } from './buildingOrder';
import { type Bay, type BayLane, bayWork } from './bay';
import type { TrafficBuildings } from './trafficBuildings';

/** THE BAYS ALONG THE KERBS, KEPT BY STREET (`parking.ts` `collectBays` hands them out after the lots' stalls). */

/** DO NOT import `SimWorld`: the world reaches this file, and the type import closed an import cycle */
export interface KerbWorld {
  readonly doc: RoadDoc;
  readonly net: Network;
  readonly topologyLog: ChangeLog<GraphChange>;
  /** The buildings' entrances (`TrafficBuilding.entrances`). */
  readonly buildings: TrafficBuildings;
}

/** What a street's kerb bays read besides the network and the entrances, and what else is asked for them (`parking.ts`). */
export interface KerbReads {
  /** A building's place in the store's order: the entrances facing a street are read in it. */
  readonly rank: (id: BuildingId) => number;
  /** The lane beside a point of a street, on its kerb side (`parking.ts` `laneBeside`). */
  readonly laneAt: (x: number, y: number, segment: SegmentId) => BayLane | null;
  /** A street's link lanes as `laneAt` reads them, digested. */
  readonly linksKey: (segment: SegmentId) => number;
  /** The street's bays baked with its tile (`sim/tileBays.ts`) when they were worked out from the very same (`key`); null: none. */
  readonly baked?: (segment: SegmentId, key: number) => readonly Bay[] | null;
  /** Whether the street's tile's baked bays are on their way (`parking.ts` tileBaysWanted): it waits for them, as a lot waits for the workers. */
  readonly waits?: (segment: SegmentId) => boolean;
}

/** Ahead of a kerb bay, the place on the lane a car stops at to back in, and leaves for. */
const KERB_AHEAD = m(7);
/** The least a kerb bay's joining point may lie ahead of it, u. */
const KERB_MIN_AHEAD = m(4);
/** No lot: the bay stands on the street. */
const NO_LOT = -1 as BuildingId;

type Entrance = [Vec2, Vec2];
/** Past this beyond a street's half width, a lot's entrance keeps no bay off its kerb (`parkingLayout.ts` `frontagesOn`). */
const FRONTAGE_REACH = m(8);
/** Cell of the kerbs' and entrances' grids, world units. */
const KERB_CELL = m(64);
const kerbCell = (i: number, j: number): number => (i + 32768) * 65536 + (j + 32768);

/** The streets of the book whose reach meets the rectangle, found by their cells (not every street of the map), in id order. */
export function kerbStreetsIn(book: KerbBook, x0: number, y0: number, x1: number, y1: number): SegmentId[] {
  const out = new Set<SegmentId>();
  for (let i = Math.floor(x0 / KERB_CELL); i <= Math.floor(x1 / KERB_CELL); i++) {
    for (let j = Math.floor(y0 / KERB_CELL); j <= Math.floor(y1 / KERB_CELL); j++) {
      for (const id of book.streets.get(kerbCell(i, j)) ?? []) {
        const r = book.reach.get(id);
        if (r && r.x0 <= x1 && r.x1 >= x0 && r.y0 <= y1 && r.y1 >= y0) out.add(id);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** The bays along the kerbs of the streets that park (`RoadSegment.parking`), kept by street. */
export interface KerbBook {
  /** The network, its state and the lane graph's the streets were read at (`Network.changesSince`, `SimWorld.topologyLog`). */
  net: Network | null;
  netSeen: object | null;
  lanesSeen: object | null;
  /** The streets that park: each one's reach (its line's box, grown), and the streets by cell. */
  readonly reach: Map<SegmentId, { x0: number; y0: number; x1: number; y1: number }>;
  readonly streets: Map<number, SegmentId[]>;
  /** Each street's bays (ids from 0), and what they were worked out from (`kerbKey`). */
  readonly bays: Map<SegmentId, readonly Bay[]>;
  readonly keys: Map<SegmentId, number>;
  /** Streets waiting for their tile's baked bays (`KerbReads.waits`); streets to look at again at the next follow (their tile's bays landed). */
  readonly held: Set<SegmentId>;
  readonly redo: Set<SegmentId>;
  /** The entrances of each building that has any, and the buildings by cell (`EntranceBook`). */
  readonly entrances: EntranceBook;
}

export function newKerbBook(): KerbBook {
  return {
    net: null, netSeen: null, lanesSeen: null, reach: new Map(), streets: new Map(), bays: new Map(), keys: new Map(), held: new Set(), redo: new Set(),
    entrances: new EntranceBook(),
  };
}

interface Box { x0: number; y0: number; x1: number; y1: number }

/** THE BUILDINGS' ENTRANCES AS NUMBERS IN COLUMNS (`core/idSlots.ts`), NOT THEIR RECORDS' ARRAYS: each building's run of entrances (ends x, y, x, y) in one typed array, and the ids by cell. DO NOT hold each building's `entrances` list in a `Map` with a `Set` entry a cell: ~1.2 KB of the simulation's heap a building of the city (2026-10-21). */
export class EntranceBook {
  private readonly slots = new IdSlots(256);
  /** Each building's run of entrances at its slot, four numbers each (`RunPool`: a run let go stays until the dead outweigh the live). */
  private readonly runs = new RunPool();
  /** The buildings whose entrances' box reaches each cell (`KERB_CELL`). */
  readonly cells = new Map<number, number[]>();

  clear(): void {
    this.slots.clear();
    this.cells.clear();
    this.runs.clear();
  }

  /** Whether a building's entrances kept are these (none kept: `list` is empty). */
  same(id: BuildingId, list: readonly Entrance[]): boolean {
    const slot = this.slots.get(id);
    const n = slot < 0 ? 0 : this.runs.length(slot) / 4;
    if (n !== list.length) return false;
    const ends = this.runs.data;
    for (let i = 0, at = slot < 0 ? 0 : this.runs.start(slot); i < n; i++, at += 4) {
      const [p, q] = list[i]!;
      if (ends[at] !== p.x || ends[at + 1] !== p.y || ends[at + 2] !== q.x || ends[at + 3] !== q.y) return false;
    }
    return true;
  }

  /** The box of a building's entrances kept; null for none. */
  box(id: BuildingId): Box | null {
    const slot = this.slots.get(id);
    if (slot < 0) return null;
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const ends = this.runs.data;
    for (let at = this.runs.start(slot), end = at + this.runs.length(slot); at < end; at += 4) {
      box.x0 = Math.min(box.x0, ends[at]!, ends[at + 2]!); box.y0 = Math.min(box.y0, ends[at + 1]!, ends[at + 3]!);
      box.x1 = Math.max(box.x1, ends[at]!, ends[at + 2]!); box.y1 = Math.max(box.y1, ends[at + 1]!, ends[at + 3]!);
    }
    return box;
  }

  /** A building's entrances now (none: let go), filed by the cells their box reaches. */
  put(id: BuildingId, list: readonly Entrance[]): void {
    const was = this.box(id);
    if (was) this.file(id, was, false);
    const slot = this.slots.get(id);
    if (slot >= 0) { this.runs.drop(slot); this.slots.delete(id); }
    if (!list.length) return;
    const to = this.slots.take(id);
    let at = this.runs.put(to, list.length * 4);
    const ends = this.runs.data;
    for (const [p, q] of list) { ends[at++] = p.x; ends[at++] = p.y; ends[at++] = q.x; ends[at++] = q.y; }
    this.file(id, entranceBox(list), true);
  }

  /** Each of a building's entrances kept, ends (x, y) to (x, y). */
  each(id: BuildingId, visit: (px: number, py: number, qx: number, qy: number) => void): void {
    const slot = this.slots.get(id);
    if (slot < 0) return;
    const ends = this.runs.data;
    for (let at = this.runs.start(slot), end = at + this.runs.length(slot); at < end; at += 4) visit(ends[at]!, ends[at + 1]!, ends[at + 2]!, ends[at + 3]!);
  }

  /** Files (or unfiles) a building by the cells a box reaches. */
  private file(id: BuildingId, box: Box, add: boolean): void {
    for (let i = Math.floor(box.x0 / KERB_CELL); i <= Math.floor(box.x1 / KERB_CELL); i++) {
      for (let j = Math.floor(box.y0 / KERB_CELL); j <= Math.floor(box.y1 / KERB_CELL); j++) {
        const k = kerbCell(i, j);
        let cell = this.cells.get(k);
        if (add) {
          if (!cell) this.cells.set(k, cell = []);
          if (!cell.includes(id)) cell.push(id);
        } else if (cell) {
          const at = cell.indexOf(id);
          if (at >= 0) { cell[at] = cell[cell.length - 1]!; cell.pop(); }
          if (!cell.length) this.cells.delete(k);
        }
      }
    }
  }
}

function entranceBox(list: readonly Entrance[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [p, q] of list) {
    x0 = Math.min(x0, p.x, q.x); y0 = Math.min(y0, p.y, q.y);
    x1 = Math.max(x1, p.x, q.x); y1 = Math.max(y1, p.y, q.y);
  }
  return { x0, y0, x1, y1 };
}

/** DO NOT lay out every street of the town when the roads move: every road drawn laid out the town's kerbs again. */
export function followKerbs(w: KerbWorld, book: KerbBook, delta: BuildingDelta | null, reads: KerbReads): Set<SegmentId> {
  const dirty = new Set<SegmentId>();
  // The roads: what the network and the lane graph changed since the streets were read (null: read them all).
  const net = book.net === w.net && book.netSeen !== null ? w.net.changesSince(book.netSeen) : null;
  const lanes = w.topologyLog.since(book.lanesSeen);
  book.net = w.net;
  book.netSeen = w.net.state;
  book.lanesSeen = w.topologyLog.state;
  const streets = new Set<SegmentId>();
  if (net && lanes) {
    for (const id of net.segments) streets.add(id);
    for (const change of lanes) for (const id of change.segments) streets.add(id);
  }
  // The entrances: read whole when the diary cannot say what changed.
  if (delta === null) readEntrances(w, book);
  const touched: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const id of delta?.ids ?? []) {
    const now = w.buildings.entrances(id);
    if (book.entrances.same(id, now)) continue;
    const was = book.entrances.box(id);
    book.entrances.put(id, now);
    if (was) touched.push(was);
    if (now.length) touched.push(entranceBox(now));
  }
  const whole = net === null || lanes === null;
  const before = whole ? new Map(book.bays) : book.bays;
  const keysBefore = whole ? new Map(book.keys) : book.keys;
  const changed = new Set<SegmentId>();
  if (whole) readStreets(w, book);
  else {
    for (const id of streets) {
      unfileStreet(book, id);
      book.keys.delete(id);
      book.held.delete(id);
      if (book.bays.delete(id)) changed.add(id);
      fileStreet(w, book, id);
      if (book.reach.has(id)) dirty.add(id);
    }
  }
  // The streets whose tile's baked bays landed: looked at again, with them.
  for (const id of book.redo) if (book.reach.has(id)) dirty.add(id);
  book.redo.clear();
  if (whole || delta === null) {
    for (const id of book.reach.keys()) dirty.add(id);
  } else {
    for (const box of touched) {
      for (let i = Math.floor(box.x0 / KERB_CELL); i <= Math.floor(box.x1 / KERB_CELL); i++) {
        for (let j = Math.floor(box.y0 / KERB_CELL); j <= Math.floor(box.y1 / KERB_CELL); j++) {
          for (const id of book.streets.get(kerbCell(i, j)) ?? []) {
            const r = book.reach.get(id)!;
            if (box.x1 >= r.x0 && box.x0 <= r.x1 && box.y1 >= r.y0 && box.y0 <= r.y1) dirty.add(id);
          }
        }
      }
    }
  }
  for (const id of [...dirty].sort((a, b) => a - b)) {
    const was = before.get(id);
    if (reads.waits?.(id)) {
      // No bays until its tile's land (`parking.ts` tileBaysRead): DO NOT lay it out before them only to lay it out again after.
      book.held.add(id);
      book.bays.delete(id);
      book.keys.delete(id);
      if (was?.length) changed.add(id);
      continue;
    }
    book.held.delete(id);
    const entrances = entrancesFacing(book, book.reach.get(id)!, reads.rank);
    const key = kerbKey(w, id, entrances, reads);
    // Worked out from the same: the same bays; else its tile's baked bays when baked from the same; else laid out here.
    const now = was && keysBefore.get(id) === key ? was : reads.baked?.(id, key) ?? kerbBaysOf(w, id, entrances, reads.laneAt);
    book.bays.set(id, now);
    book.keys.set(id, key);
    if (!was || !sameBays(was, now)) changed.add(id);
  }
  // Streets that no longer park (or are gone): their bays went with them.
  if (whole) for (const id of before.keys()) if (!book.bays.has(id)) changed.add(id);
  return changed;
}

/** Whether two lists of a street's bays are the same bays, field by field. */
function sameBays(a: readonly Bay[], b: readonly Bay[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!, q = b[i]!;
    if (p.building !== q.building || p.x !== q.x || p.y !== q.y || p.ox !== q.ox || p.oy !== q.oy || p.depth !== q.depth ||
      p.room !== q.room || p.kerb !== q.kerb || p.via.length !== q.via.length) return false;
    for (let k = 0; k < p.via.length; k++) if (p.via[k]!.x !== q.via[k]!.x || p.via[k]!.y !== q.via[k]!.y) return false;
    const l = p.lane, m2 = q.lane;
    if (l === m2) continue;
    if (!l || !m2 || l.lanelet !== m2.lanelet || l.at !== m2.at || l.x !== m2.x || l.y !== m2.y || l.tx !== m2.tx || l.ty !== m2.ty ||
      l.entryAt !== m2.entryAt) return false;
  }
  return true;
}

/** @rebuild Every building's entrances, read whole: the first look, or when the diary cannot say what changed. */
function readEntrances(w: KerbWorld, book: KerbBook): void {
  book.entrances.clear();
  // By id and entrances alone (`TrafficBuildings.eachEntrances`): DO NOT work out every building's traffic record for them.
  w.buildings.eachEntrances((id, list) => { if (list.length) book.entrances.put(id, list); });
}

/** @rebuild The streets that park, read whole: the first look, a map opened, or roads further behind than the logs remember. */
function readStreets(w: KerbWorld, book: KerbBook): void {
  book.reach.clear();
  book.streets.clear();
  book.bays.clear();
  book.keys.clear();
  book.held.clear();
  for (const id of w.net.ribbons.keys()) fileStreet(w, book, id);
}

/** A street that parks filed: its reach (its line's box, grown) and the cells it covers. */
function fileStreet(w: KerbWorld, book: KerbBook, id: SegmentId): void {
  const ribbon = w.net.ribbons.get(id);
  if (!ribbon) return;
  const rt = ribbon.road;
  if (rt.parkingLeft <= 0 && rt.parkingRight <= 0) return;
  const pad = rt.width / 2 + FRONTAGE_REACH;
  const bb = ribbon.full.bbox;
  const reach = { x0: bb.minX - pad, y0: bb.minY - pad, x1: bb.maxX + pad, y1: bb.maxY + pad };
  book.reach.set(id, reach);
  for (let i = Math.floor(reach.x0 / KERB_CELL); i <= Math.floor(reach.x1 / KERB_CELL); i++) {
    for (let j = Math.floor(reach.y0 / KERB_CELL); j <= Math.floor(reach.y1 / KERB_CELL); j++) {
      const k = kerbCell(i, j);
      const list = book.streets.get(k);
      if (list) list.push(id); else book.streets.set(k, [id]);
    }
  }
}

/** A street taken out of the cells it was filed in. */
function unfileStreet(book: KerbBook, id: SegmentId): void {
  const reach = book.reach.get(id);
  if (!reach) return;
  book.reach.delete(id);
  for (let i = Math.floor(reach.x0 / KERB_CELL); i <= Math.floor(reach.x1 / KERB_CELL); i++) {
    for (let j = Math.floor(reach.y0 / KERB_CELL); j <= Math.floor(reach.y1 / KERB_CELL); j++) {
      const k = kerbCell(i, j);
      const list = book.streets.get(k);
      const at = list ? list.indexOf(id) : -1;
      if (at >= 0) list!.splice(at, 1);
      if (list && !list.length) book.streets.delete(k);
    }
  }
}

/** The entrances that may face a street (`frontagesOn`'s box test), in the store's order. */
function entrancesFacing(book: KerbBook, r: { x0: number; y0: number; x1: number; y1: number }, rank: (id: BuildingId) => number): Entrance[] {
  const ids = new Set<BuildingId>();
  for (let i = Math.floor(r.x0 / KERB_CELL); i <= Math.floor(r.x1 / KERB_CELL); i++) {
    for (let j = Math.floor(r.y0 / KERB_CELL); j <= Math.floor(r.y1 / KERB_CELL); j++) {
      for (const id of book.entrances.cells.get(kerbCell(i, j)) ?? []) ids.add(id as BuildingId);
    }
  }
  const out: Entrance[] = [];
  for (const id of [...ids].sort((a, b) => rank(a) - rank(b))) {
    // Those `frontagesOn` passes over (the same test on the same box) left out: a lot of the next tile in the cell is no part of the street's key.
    book.entrances.each(id, (px, py, qx, qy) => {
      if (Math.max(px, qx) < r.x0 || Math.min(px, qx) > r.x1 || Math.max(py, qy) < r.y0 || Math.min(py, qy) > r.y1) return;
      out.push([{ x: px, y: py }, { x: qx, y: qy }]);
    });
  }
  return out;
}

/** DO NOT leave out anything `kerbBaysOf` reads: what one street's kerb bays are worked out from, digested (its lay out's own reads, the entrances facing it, its lanes). */
function kerbKey(w: KerbWorld, id: SegmentId, entrances: readonly Entrance[], reads: KerbReads): number {
  const digest = parkingDigest(w.net, w.net.ribbons.get(id)!, new Digest().add(id));
  for (const [p, q] of entrances) digest.add(p.x).add(p.y).add(q.x).add(q.y);
  return digest.add(entrances.length).add(reads.linksKey(id)).value();
}

/** One street's kerb bays: laid out alone (`parkingLayout` over a network of this one street), against the entrances in front of it. */
function kerbBaysOf(w: KerbWorld, id: SegmentId, entrances: readonly Entrance[], laneAt: KerbReads['laneAt']): Bay[] {
  bayWork.kerbs++;
  const ribbon = w.net.ribbons.get(id)!;
  // The network as it is, with only this street in `ribbons`
  const one = Object.create(w.net, { ribbons: { value: new Map([[id, ribbon]]) } }) as Network;
  const out: Bay[] = [];
  for (const bay of parkingLayout(one, entrances).bays) {
    const f = bay.facing;
    const ahead = { x: bay.centre.x + f.x * KERB_AHEAD, y: bay.centre.y + f.y * KERB_AHEAD };
    const lane = laneAt(ahead.x, ahead.y, bay.segment);
    // The lane has to run the way the car faces: the traffic beside the bay; and its joining point
    const aligned = lane !== null && lane.tx * f.x + lane.ty * f.y > 0.7
      && (lane.x - bay.centre.x) * f.x + (lane.y - bay.centre.y) * f.y >= KERB_MIN_AHEAD;
    out.push({
      id: out.length, building: NO_LOT, x: bay.centre.x, y: bay.centre.y,
      // The car stands nose along the kerb: `o` points out of its tail.
      ox: -f.x, oy: -f.y, depth: PARKING_PITCH.parallel,
      lane: aligned ? lane : null, via: [], room: PARKING_PITCH.parallel / 2, car: null, kerb: true,
    });
  }
  return out;
}
