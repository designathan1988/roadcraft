import type { Vec2 } from '@core/vec2';
import type { BuildingId } from '@world/buildings/types';
import type { SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { PARKING_PITCH } from '@world/parking';
import { entrancesOf, parkingLayout } from '@world/parkingLayout';
import { m } from '@world/units';
import type { SimWorld } from '../world';
import type { BuildingDelta } from './buildingOrder';
import type { Bay, BayLane } from './parking';

/**
 * THE BAYS ALONG THE KERBS, KEPT BY STREET (`parking.ts` `collectBays` hands
 * them out after the lots' stalls). A street's bays are laid out from its line
 * and the entrances of the lots in front of it; a building change lays out
 * again only the streets an entrance of it faces.
 */

/** The lane beside a point of a street, on its kerb side (`parking.ts` `laneBeside`). */
type LaneAt = (x: number, y: number, segment: SegmentId) => BayLane | null;

/** Ahead of a kerb bay, the place on the lane a car stops at to back in, and leaves for. */
const KERB_AHEAD = m(7);
/** The least a kerb bay's joining point may lie ahead of it, u. */
const KERB_MIN_AHEAD = m(4);
/** No lot: the bay stands on the street. */
const NO_LOT = -1 as BuildingId;

type Entrance = [Vec2, Vec2];
/** The narrowest gate a car is driven through (a person's is 1.2 m); `parkingLayout.ts` `CAR_GATE_WIDTH`. */
export const CAR_GATE = m(2.2);
/** Past this beyond a street's half width, a lot's entrance keeps no bay off its kerb (`parkingLayout.ts` `frontagesOn`). */
const FRONTAGE_REACH = m(8);
/** Cell of the kerbs' and entrances' grids, world units. */
const KERB_CELL = m(64);
const kerbCell = (i: number, j: number): number => (i + 32768) * 65536 + (j + 32768);

/**
 * The bays along the kerbs of the streets that park (`RoadSegment.parking`),
 * kept by street. A street's bays are laid out (`parkingLayout`) from its
 * line and the entrances of the lots in front of it, which keep their kerb
 * clear; they were laid out for every street of the town against every
 * entrance of the town on each pass (`lotEntrances` walks every building).
 */
export interface KerbBook {
  /** The network, its state and the lane graph's the streets were read at (`Network.changesSince`, `SimWorld.topologyLog`). */
  net: Network | null;
  netSeen: object | null;
  lanesSeen: object | null;
  /** The streets that park: each one's reach (its line's box, grown), and the streets by cell. */
  readonly reach: Map<SegmentId, { x0: number; y0: number; x1: number; y1: number }>;
  readonly streets: Map<number, SegmentId[]>;
  /** Each street's bays (ids from 0). */
  readonly bays: Map<SegmentId, readonly Bay[]>;
  /** The entrances of each building that has any, and the entrances by cell. */
  readonly entrances: Map<BuildingId, readonly Entrance[]>;
  readonly entranceCells: Map<number, Set<BuildingId>>;
}

export function newKerbBook(): KerbBook {
  return { net: null, netSeen: null, lanesSeen: null, reach: new Map(), streets: new Map(), bays: new Map(), entrances: new Map(), entranceCells: new Map() };
}

function entranceBox(list: readonly Entrance[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [p, q] of list) {
    x0 = Math.min(x0, p.x, q.x); y0 = Math.min(y0, p.y, q.y);
    x1 = Math.max(x1, p.x, q.x); y1 = Math.max(y1, p.y, q.y);
  }
  return { x0, y0, x1, y1 };
}

function sameEntrances(a: readonly Entrance[], b: readonly Entrance[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const [p, q] = a[i]!, [r, s] = b[i]!;
    if (p.x !== r.x || p.y !== r.y || q.x !== s.x || q.y !== s.y) return false;
  }
  return true;
}

/** Files (or unfiles) a building's entrances by the cells their box reaches. */
function fileEntrances(book: KerbBook, id: BuildingId, list: readonly Entrance[], add: boolean): void {
  if (!list.length) return;
  const box = entranceBox(list);
  for (let i = Math.floor(box.x0 / KERB_CELL); i <= Math.floor(box.x1 / KERB_CELL); i++) {
    for (let j = Math.floor(box.y0 / KERB_CELL); j <= Math.floor(box.y1 / KERB_CELL); j++) {
      const k = kerbCell(i, j);
      let cell = book.entranceCells.get(k);
      if (add) {
        if (!cell) book.entranceCells.set(k, cell = new Set());
        cell.add(id);
      } else if (cell) {
        cell.delete(id);
        if (!cell.size) book.entranceCells.delete(k);
      }
    }
  }
}

/**
 * The kerbs brought up to date: the streets the network changed and those
 * whose lanes the lane graph built again laid out again (a street's bays read
 * its own line, its own ends and its own lanes, `kerbBaysOf`), and the
 * streets an entrance changed in front of (a lot's gate or car park drawn,
 * moved or taken away). The streets whose bays changed - laid out otherwise,
 * or gone - for whoever keeps something by street (`parking.ts`
 * bayChangesSince). DO NOT lay out every street of the town when the roads
 * move: every road drawn laid out the town's kerbs again.
 */
export function followKerbs(w: SimWorld, book: KerbBook, delta: BuildingDelta | null, rank: (id: BuildingId) => number, laneAt: LaneAt): Set<SegmentId> {
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
    const b = w.doc.buildings.get(id);
    const now = b ? entrancesOf(b) : [];
    const was = book.entrances.get(id) ?? [];
    if (sameEntrances(was, now)) continue;
    fileEntrances(book, id, was, false);
    fileEntrances(book, id, now, true);
    if (now.length) book.entrances.set(id, now); else book.entrances.delete(id);
    if (was.length) touched.push(entranceBox(was));
    if (now.length) touched.push(entranceBox(now));
  }
  const whole = net === null || lanes === null;
  const before = whole ? new Map(book.bays) : book.bays;
  const changed = new Set<SegmentId>();
  if (whole) readStreets(w, book);
  else {
    for (const id of streets) {
      unfileStreet(book, id);
      if (book.bays.delete(id)) changed.add(id);
      fileStreet(w, book, id);
      if (book.reach.has(id)) dirty.add(id);
    }
  }
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
    const now = kerbBaysOf(w, book, id, rank, laneAt);
    book.bays.set(id, now);
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
function readEntrances(w: SimWorld, book: KerbBook): void {
  book.entrances.clear();
  book.entranceCells.clear();
  for (const b of w.doc.buildings.all()) {
    const list = entrancesOf(b);
    if (!list.length) continue;
    book.entrances.set(b.id, list);
    fileEntrances(book, b.id, list, true);
  }
}

/** @rebuild The streets that park, read whole: the first look, a map opened, or roads further behind than the logs remember. */
function readStreets(w: SimWorld, book: KerbBook): void {
  book.reach.clear();
  book.streets.clear();
  book.bays.clear();
  for (const id of w.net.ribbons.keys()) fileStreet(w, book, id);
}

/** A street that parks filed: its reach (its line's box, grown) and the cells it covers. */
function fileStreet(w: SimWorld, book: KerbBook, id: SegmentId): void {
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
      for (const id of book.entranceCells.get(kerbCell(i, j)) ?? []) ids.add(id);
    }
  }
  const out: Entrance[] = [];
  for (const id of [...ids].sort((a, b) => rank(a) - rank(b))) out.push(...book.entrances.get(id)!);
  return out;
}

/** One street's kerb bays: laid out alone (`parkingLayout` over a network of this one street), against the entrances in front of it. */
function kerbBaysOf(w: SimWorld, book: KerbBook, id: SegmentId, rank: (id: BuildingId) => number, laneAt: LaneAt): Bay[] {
  const ribbon = w.net.ribbons.get(id)!;
  // The network as it is, with only this street in `ribbons`: each street's
  // bays are laid out from its own line, its own ends and the entrances near
  // it alone (`parkingLayout`), so one street is laid out as in the whole.
  const one = Object.create(w.net, { ribbons: { value: new Map([[id, ribbon]]) } }) as Network;
  const out: Bay[] = [];
  for (const bay of parkingLayout(one, entrancesFacing(book, book.reach.get(id)!, rank)).bays) {
    const f = bay.facing;
    const ahead = { x: bay.centre.x + f.x * KERB_AHEAD, y: bay.centre.y + f.y * KERB_AHEAD };
    const lane = laneAt(ahead.x, ahead.y, bay.segment);
    // The lane has to run the way the car faces: the traffic beside the bay;
    // and its joining point (kept `LANE_END` clear of the junctions) must lie
    // ahead of the bay. Near the end of a street it falls behind it, and the
    // car would turn round on the spot, its tail sweeping the footway.
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
