import { m } from '@world/units';
import { CellFiling } from '@world/cells';
import type { LaneletId } from '@world/lanelets';
import { segmentLine } from '@world/geometry';
import { OWNER } from '@world/tiles';
import { DT, FLEET_CEILING } from '../params';
import type { SimWorld } from '../world';
import { spawnVehicleAt, ENTRY_RATE } from '../vehicles/spawn';
import { TRAFFIC } from '../ambient/ambient';
import { MesoModel, type MesoLinkSpec } from './model';
import { DemandCells } from './demand';
import { MC, MESO_INSIDE, MESO_ONE_WAY, MESO_PRESENT, MESO_RECORD, MH, MICRO_RADIUS, ML, type MesoMemory } from './memory';
import { LINK_CROSSING, LINK_ONE_WAY, NODE_BULB, type TileLinks, linkId, linkSegment, reverseLink } from './tileLinks';
import type { TileLinkFeed } from './tileFeed';

/** THE MESO TRAFFIC IN THE SIMULATION: the world's flows (`model.ts`) over the page's tiles (the lane graph) and the stored tiles round them (`tileLinks.ts`), and the micro window they hand their cars to and take them back from */

/** Seconds of the city between two steps of the meso model. */
export const MESO_DT = 1;
/** A trip's mean length, for the share of a link's traffic that ends its trip on it and how often its street's lots send one out. */
const TRIP_LENGTH = m(3000);
/** Most cars made in the window a tick, as the edge entries admit them (`vehicles/spawn.ts` ADMIT_PER_TICK). */
const ADMIT_PER_TICK = 4;
/** How far ahead of a link's start a car handed in at its upstream end is made. */
const ENTRY_CLEARANCE = m(0.6);
/** The serial of a slot's line wraps here: a Float32 holds it whole (`memory.ts` ML.shape). */
const SHAPE_WRAP = (1 << 24) - 1;

/** What one directed road is made of in the lane graph: its link lanes the cars may take (not the buses' own). */
interface SlotLanes { readonly lanes: LaneletId[] }
/** A slot filed by its middle (`CellFiling` holds objects). */
interface Filed { readonly x: number; readonly y: number }
/** Where a slot's road runs: the nodes it joins and its segment. */
interface Ends { readonly from: number; readonly to: number; readonly segment: number }
/** A link of a tile's table behind a slot. */
interface Backing { readonly table: TileLinks; readonly index: number }
/** A change of the page's tiles, as the streamer tells it (`worldStreamer.ts` StreamerEvents). */
export type TileEvent = 'loaded' | 'letGo' | 'written';

export class Meso {
  model = new MesoModel(MESO_DT);
  private demand = new DemandCells();
  private memory: MesoMemory | null = null;
  /** The buffer the lines were last written to whole. */
  /** The slots of the buffer the lines were last written to whole (the page only ever makes a bigger one; a message's buffer is a new object each time, never the same one). */
  private published = 0;
  private clock = 0;
  private graphSeen: object | null = null;
  /** DO NOT index the model by a link's id: a tile's ids pass 2^51. Each link its dense slot, the slots freed taken again. */
  private readonly slotOf = new Map<number, number>();
  private readonly linkAt: number[] = [];
  private readonly freeSlots: number[] = [];
  /** Each link lane's slot, and each live slot's lanes (the page's tiles). */
  private readonly laneSlot = new Map<LaneletId, number>();
  private readonly slotLanes = new Map<number, SlotLanes>();
  /** Each slot's middle and its demand cell, its ends, its tile; the table link behind it (a tile the page does not hold). */
  private readonly middle = new Map<number, Filed>();
  private readonly cellOf = new Map<number, number>();
  private readonly ends = new Map<number, Ends>();
  private readonly tileOf = new Map<number, number>();
  private readonly slotsOfTile = new Map<number, Set<number>>();
  private readonly backing = new Map<number, Backing>();
  private readonly filing = new CellFiling<number, Filed>();
  /** The links leaving each node, the roads meeting at it (counted by their links), and the nodes that are turning circles or carry a crossing. */
  private readonly outAt = new Map<number, Set<number>>();
  private readonly roadsAt = new Map<number, Map<number, number>>();
  private readonly bulbs = new Set<number>();
  private readonly crossings = new Set<number>();
  /** Nodes whose links came or went since the last `settle`: their links' exits, signals and turns worked out again. */
  private touchedNodes = new Set<number>();
  /** Each slot's line (start, middle, end: x, y), whether its road is one-way, and the slots whose line the page has not had. */
  private lines = new Float32Array(0);
  private oneWay = new Uint8Array(0);
  private readonly linesDirty = new Set<number>();
  private shapeSerial = 0;
  /** The tiles the page's document holds; those it let go whose table has not come; the tables of the others; the tables come and not applied yet. */
  private readonly live = new Set<number>();
  private readonly awaiting = new Set<number>();
  private readonly tables = new Map<number, TileLinks>();
  private offered: TileLinks[] = [];
  /** Live tiles whose first link went live: what is left of their table and not in the document is dropped. */
  private readonly sweep = new Set<number>();
  private feed: TileLinkFeed | null = null;
  /** The camera's focus (the window's centre asked last): the reach of the tables is round it. */
  private focusAt: { x: number; y: number } | null = null;
  /** The micro window: where it stands, and where it was asked to go (`want`). */
  private micro = { x: 0, y: 0, r: 0 };
  private wanted: { x: number; y: number; r: number } | null = null;
  /** The vehicles the meso handed to the micro simulation: taken back when they drive out of the window. */
  readonly owned = new Set<number>();
  /** Slots with vehicles to make in the window, and how many of each to spread along it (handed with the window) rather than at its start. */
  private readonly pendingSlots = new Set<number>();
  private readonly fill = new Map<number, number>();
  /** Slots given a count of the micro vehicles last step. */
  private counted: number[] = [];

  /** Everything of the model forgotten (another map, the simulation started over): the window, the page's buffer, the tiles and their tables kept (applied again at the next step). */
  reset(): void {
    this.model = new MesoModel(MESO_DT);
    this.demand = new DemandCells();
    this.clock = 0;
    this.graphSeen = null;
    this.slotOf.clear();
    this.linkAt.length = 0;
    this.freeSlots.length = 0;
    this.laneSlot.clear();
    this.slotLanes.clear();
    this.middle.clear();
    this.cellOf.clear();
    this.ends.clear();
    this.tileOf.clear();
    this.slotsOfTile.clear();
    this.backing.clear();
    for (const id of [...this.filing.ids()]) this.filing.remove(id);
    this.outAt.clear();
    this.roadsAt.clear();
    this.bulbs.clear();
    this.crossings.clear();
    this.touchedNodes.clear();
    this.linesDirty.clear();
    this.published = 0;
    this.sweep.clear();
    this.owned.clear();
    this.pendingSlots.clear();
    this.fill.clear();
    this.counted = [];
    // The tables of the tiles round the page's stay right: put back over the new model.
    this.offered = [...this.tables.values(), ...this.offered];
    this.tables.clear();
    // The window stands where it was asked to: entered again over the new map's links at the next step.
    this.wanted ??= { ...this.micro };
    this.micro = { x: 0, y: 0, r: 0 };
  }

  /** The page's buffer the steps are written into (`render/densityCars.ts`). */
  attach(memory: MesoMemory): void {
    this.memory = memory;
  }

  /** The micro window asked to stand round (x, y): moved at the next step; the far tables' reach is round it too. */
  want(x: number, y: number, r = MICRO_RADIUS): void {
    this.wanted = { x, y, r };
    this.focusAt = { x, y };
  }

  /** The stored tiles round the camera read for the meso (`tileFeed.ts`): the tables of another world forgotten. */
  useTiles(feed: TileLinkFeed): void {
    this.feed = feed;
    for (const key of this.live) feed.loaded(key);
    for (const key of [...this.tables.keys()]) this.dropTable(key);
    this.offered = [];
  }

  /** The tiles the page's document holds (the map sent whole). */
  setLive(keys: Iterable<number>): void {
    this.live.clear();
    for (const key of keys) this.tileEvent('loaded', key, 0);
  }

  /** A tile of the page taken in, let go or written (`worldStreamer.ts` StreamerEvents)
   *  - taken in: its links handed to the lane graph as it builds them (the same slots, so their vehicles stay); let go: its links held as they are until its table comes, then the table's. */
  tileEvent(event: TileEvent, key: number, version: number): void {
    switch (event) {
      case 'loaded':
        this.live.add(key);
        this.awaiting.delete(key);
        this.tables.delete(key);
        this.offered = this.offered.filter((t) => t.key !== key);
        this.demand.dropFar(key);
        this.feed?.loaded(key);
        return;
      case 'letGo':
        this.live.delete(key);
        this.awaiting.add(key);
        this.feed?.letGo(key);
        return;
      case 'written':
        this.feed?.written(key, version);
        return;
    }
  }

  /** A tile's table to put in at the next step (the feed's, or a test's). */
  offerTable(table: TileLinks): void {
    this.offered.push(table);
  }

  /** Stage 2 (`pipeline.ts`): the links brought up to the lane graph and the tables, cars made in the window, and each `MESO_DT` a step of the model. */
  step(w: SimWorld, traffic: boolean): void {
    if (!traffic) return;
    this.scale = w.trafficIntensity * w.demandMultiplier;
    this.sync(w);
    this.takeTables();
    this.settle(w);
    if (this.wanted) this.moveWindow(w, this.wanted);
    this.admit(w);
    this.clock += DT;
    if (this.clock + 1e-9 < MESO_DT) return;
    this.clock -= MESO_DT;
    this.takeBack(w);
    this.countMicro(w);
    this.rates(w);
    this.model.step();
    // DO NOT make only the cars handed when a link came into the window: those that drove in since are made too.
    for (const slot of this.model.handed) this.pendingSlots.add(slot);
    this.publish(w);
  }

  /** The slot of a link lane, if it has one. */
  slotOfLane(id: LaneletId): number | undefined {
    return this.laneSlot.get(id);
  }

  /** The slot of a link (`tileLinks.ts` linkId), if it is in the model. */
  slotOfLink(link: number): number | undefined {
    return this.slotOf.get(link);
  }

  /** The link a slot holds (NaN: none). */
  linkOfSlot(slot: number): number {
    return this.linkAt[slot] ?? Number.NaN;
  }

  // ------------------------------------------------------------ slots

  private slotFor(link: number): number {
    let slot = this.slotOf.get(link);
    if (slot !== undefined) return slot;
    slot = this.freeSlots.pop() ?? this.linkAt.length;
    this.slotOf.set(link, slot);
    this.linkAt[slot] = link;
    return slot;
  }

  private isLive(slot: number): boolean {
    return this.slotLanes.has(slot);
  }

  /** A slot's road filed at its nodes (the joins, the turns), its tile noted. */
  private placeEnds(slot: number, ends: Ends, tile: number): void {
    const was = this.ends.get(slot);
    if (!was || was.from !== ends.from || was.to !== ends.to || was.segment !== ends.segment) {
      if (was) this.unplaceEnds(slot, was);
      this.ends.set(slot, ends);
      let outs = this.outAt.get(ends.from);
      if (!outs) this.outAt.set(ends.from, outs = new Set());
      outs.add(slot);
      for (const node of [ends.from, ends.to]) {
        let roads = this.roadsAt.get(node);
        if (!roads) this.roadsAt.set(node, roads = new Map());
        roads.set(ends.segment, (roads.get(ends.segment) ?? 0) + 1);
        this.touchedNodes.add(node);
      }
    }
    const tileWas = this.tileOf.get(slot);
    if (tileWas === tile) return;
    if (tileWas !== undefined) this.slotsOfTile.get(tileWas)?.delete(slot);
    this.tileOf.set(slot, tile);
    let set = this.slotsOfTile.get(tile);
    if (!set) this.slotsOfTile.set(tile, set = new Set());
    set.add(slot);
  }

  private unplaceEnds(slot: number, ends: Ends): void {
    this.ends.delete(slot);
    const outs = this.outAt.get(ends.from);
    outs?.delete(slot);
    if (outs && !outs.size) this.outAt.delete(ends.from);
    for (const node of [ends.from, ends.to]) {
      const roads = this.roadsAt.get(node);
      if (roads) {
        const n = (roads.get(ends.segment) ?? 0) - 1;
        if (n > 0) roads.set(ends.segment, n); else roads.delete(ends.segment);
        if (!roads.size) { this.roadsAt.delete(node); this.bulbs.delete(node); this.crossings.delete(node); }
      }
      this.touchedNodes.add(node);
    }
  }

  private touchEnds(slot: number): void {
    const ends = this.ends.get(slot);
    if (ends) { this.touchedNodes.add(ends.from); this.touchedNodes.add(ends.to); }
  }

  /** A slot's place: its middle filed for the window, its demand cell, its line for the page. */
  private placeLine(slot: number, line: readonly number[], oneWay: boolean): void {
    const filed = { x: line[2]!, y: line[3]! };
    this.middle.set(slot, filed);
    this.cellOf.set(slot, this.demand.cellOf(filed.x, filed.y));
    this.filing.file(slot, filed, [filed.x, filed.y, filed.x, filed.y]);
    if (this.lines.length < (slot + 1) * 6) {
      const grown = new Float32Array(Math.max((slot + 1) * 6, this.lines.length * 2, 6 * 64));
      grown.set(this.lines);
      this.lines = grown;
      const flags = new Uint8Array(grown.length / 6);
      flags.set(this.oneWay);
      this.oneWay = flags;
    }
    this.lines.set(line, slot * 6);
    this.oneWay[slot] = oneWay ? 1 : 0;
    this.linesDirty.add(slot);
  }

  /** A link gone from the world (or out of the meso's reach): what was on it leaves the model, its slot free. */
  private dropSlot(slot: number): void {
    const ends = this.ends.get(slot);
    if (ends) this.unplaceEnds(slot, ends);
    this.model.dropLink(slot);
    for (const id of this.slotLanes.get(slot)?.lanes ?? []) this.laneSlot.delete(id);
    this.slotLanes.delete(slot);
    this.backing.delete(slot);
    const tile = this.tileOf.get(slot);
    if (tile !== undefined) this.slotsOfTile.get(tile)?.delete(slot);
    this.tileOf.delete(slot);
    this.middle.delete(slot);
    this.cellOf.delete(slot);
    this.filing.remove(slot);
    this.pendingSlots.delete(slot);
    this.fill.delete(slot);
    this.linesDirty.delete(slot);
    const link = this.linkAt[slot];
    if (link !== undefined && !Number.isNaN(link)) this.slotOf.delete(link);
    this.linkAt[slot] = Number.NaN;
    this.freeSlots.push(slot);
  }

  // ------------------------------------------------------------ the links of the page's tiles, by the lane graph's log

  /** DO NOT read every lane of the map for an edit: only those the topology's log names. */
  private sync(w: SimWorld): void {
    if (this.graphSeen === w.topologyLog.state) return;
    const changes = w.topologyLog.since(this.graphSeen);
    this.graphSeen = w.topologyLog.state;
    const lanes = new Set<LaneletId>();
    if (changes === null) {
      // @rebuild The lane graph built whole: every lane, those known and those there now.
      for (const id of this.laneSlot.keys()) lanes.add(id);
      for (const id of w.graph.lanelets.keys()) lanes.add(id);
    } else {
      for (const change of changes) {
        for (const id of change.lanelets) lanes.add(id);
        for (const node of change.junctions) this.touchedNodes.add(node);
      }
    }
    // The land use of the hour, for the new links' first cars (`relink`).
    this.demand.sync(w.buildings, w.doc.changes);
    this.demand.atHour((w.city.minutes(w) % 1440) / 60);
    const touched = new Set<number>();
    for (const id of lanes) {
      const was = this.laneSlot.get(id);
      if (was !== undefined) {
        touched.add(was);
        this.laneSlot.delete(id);
        const list = this.slotLanes.get(was);
        if (list) { const at = list.lanes.indexOf(id); if (at >= 0) list.lanes.splice(at, 1); }
      }
      const lane = w.graph.lanelets.get(id);
      if (!lane || lane.kind !== 'link' || lane.segment === undefined || lane.use === 'bus') continue;
      const seg = w.doc.segment(lane.segment);
      if (!seg) continue;
      const slot = this.slotFor(linkId(lane.segment, seg.a === lane.from ? 0 : 1));
      this.laneSlot.set(id, slot);
      let list = this.slotLanes.get(slot);
      if (!list) this.slotLanes.set(slot, list = { lanes: [] });
      list.lanes.push(id);
      touched.add(slot);
    }
    for (const slot of [...touched].sort((a, b) => a - b)) this.relink(w, slot);
    for (const key of this.sweep) this.sweepTile(w, key);
    this.sweep.clear();
  }

  /** One slot made again from its lanes; with none left, its tile's table link takes it (the tile let go) or it goes. */
  private relink(w: SimWorld, slot: number): void {
    const list = this.slotLanes.get(slot);
    const lanes = list?.lanes.filter((id) => w.graph.lanelets.has(id)) ?? [];
    // Its ends' turns and exits worked out again (`settle`): a road of the page's roads or of a table's meets them now.
    this.touchEnds(slot);
    if (!lanes.length) {
      this.slotLanes.delete(slot);
      this.pendingSlots.delete(slot);
      this.fill.delete(slot);
      // Its micro cars went with the lanes: what was handed to it and not made is the model's again.
      if (this.model.isInside(slot)) this.model.leaveWindow(slot, 0);
      const back = this.backing.get(slot);
      if (back && !this.live.has(back.table.key)) { this.placeTableLink(slot, back); return; }
      const tile = this.tileOf.get(slot);
      // DO NOT drop the links of a tile let go before its table comes: their vehicles would be lost; held as they are.
      if (tile !== undefined && this.awaiting.has(tile) && this.model.has(slot)) return;
      this.dropSlot(slot);
      return;
    }
    lanes.sort();
    this.slotLanes.set(slot, { lanes });
    const first = w.graph.lanelets.get(lanes[0]!)!;
    const segment = first.segment as number;
    const seg = w.doc.segment(first.segment!)!;
    const a = w.doc.node(seg.a)!, b = w.doc.node(seg.b)!;
    const tile = OWNER.segment(a, b);
    // A table link of a tile now held by the page: the live link takes its slot and its vehicles (a tile let go keeps its table link for when the lanes go).
    if (this.live.has(tile) && this.backing.delete(slot)) this.sweep.add(tile);
    this.placeEnds(slot, { from: first.from as number, to: first.to as number, segment }, tile);
    for (const end of [a, b]) if (end.end === 'bulb') this.bulbs.add(end.id);
    const line = segmentLine({ x: a.x, y: a.y }, { x: b.x, y: b.y }, seg.curve);
    const mid = line.sampleAt(line.length / 2).p;
    this.placeLine(slot, [a.x, a.y, mid.x, mid.y, b.x, b.y], seg.direction !== 'both');
    this.setSpec(w, slot);
    const filed = this.middle.get(slot)!;
    const inside = this.inWindow(filed);
    if (inside && !this.model.isInside(slot)) this.enter(slot);
    else if (!inside && this.model.isInside(slot)) this.leave(w, slot);
  }

  /** The table links of a tile the page now holds that the lane graph will not take (their road is not in the document): gone. */
  private sweepTile(w: SimWorld, key: number): void {
    for (const slot of [...this.slotsOfTile.get(key) ?? []]) {
      if (this.isLive(slot) || !this.backing.has(slot)) continue;
      if (!w.doc.segment(linkSegment(this.linkAt[slot]!) as never)) this.dropSlot(slot);
    }
  }

  // ------------------------------------------------------------ the links of the other tiles, by their tables

  /** The tables come (the feed's, offered): put in over their tiles; the tiles gone out of reach dropped. */
  private takeTables(): void {
    const feed = this.feed;
    if (feed) {
      if (this.focusAt) feed.focus(this.focusAt.x, this.focusAt.y);
      for (const key of feed.gone()) this.dropTable(key);
      for (const table of feed.take()) this.offered.push(table);
    }
    if (!this.offered.length) return;
    const offered = this.offered;
    this.offered = [];
    for (const table of offered) if (!this.live.has(table.key)) this.applyTable(table);
  }

  /** A tile's table in place of what the meso had of it: the same links keep their slots and vehicles, those no longer in it go. */
  private applyTable(table: TileLinks): void {
    const key = table.key;
    this.tables.set(key, table);
    this.awaiting.delete(key);
    this.demand.setFar(key, table.cells);
    for (let k = 0; k < table.nodes.length; k++) if (table.nodeFlags[k]! & NODE_BULB) this.bulbs.add(table.nodes[k]!);
    const kept = new Set<number>();
    for (let k = 0; k < table.count; k++) {
      const slot = this.slotFor(table.link[k]!);
      kept.add(slot);
      const back = { table, index: k };
      this.backing.set(slot, back);
      // Still in the lane graph (the page let the tile go, the graph not caught up): the table takes it when its lanes go (`relink`).
      if (!this.isLive(slot)) this.placeTableLink(slot, back);
    }
    for (const slot of [...this.slotsOfTile.get(key) ?? []]) if (!kept.has(slot) && !this.isLive(slot)) this.dropSlot(slot);
  }

  /** A tile out of the meso's reach: its links and their vehicles leave the model. */
  private dropTable(key: number): void {
    this.tables.delete(key);
    this.awaiting.delete(key);
    this.demand.dropFar(key);
    if (this.live.has(key)) return;
    for (const slot of [...this.slotsOfTile.get(key) ?? []]) if (!this.isLive(slot)) this.dropSlot(slot);
  }

  /** A slot made from its table link: its ends, its line, its numbers; a new one starts as its street stands at this hour. */
  private placeTableLink(slot: number, back: Backing): void {
    const { table, index: k } = back;
    const ends = { from: table.from[k]!, to: table.to[k]!, segment: linkSegment(table.link[k]!) };
    this.placeEnds(slot, ends, table.key);
    if (table.flags[k]! & LINK_CROSSING) this.crossings.add(ends.to);
    this.placeLine(slot, Array.from(table.shape.subarray(k * 6, k * 6 + 6)), (table.flags[k]! & LINK_ONE_WAY) !== 0);
    // Never in the micro window: it has no lanes to make its cars on.
    if (this.model.isInside(slot)) this.model.leaveWindow(slot, 0);
    this.pendingSlots.delete(slot);
    this.fill.delete(slot);
    const had = this.model.has(slot);
    this.model.setLink(slot, this.tableSpec(table, k));
    if (!had) this.seedNew(slot, table.length[k]!);
    this.touchEnds(slot);
  }

  // ------------------------------------------------------------ the numbers and the turns

  /** A node where the world ends: one road, not a turning circle (`RoadDoc.mapEdge`), counted over the page's roads and the tables'. */
  private edgeAt(node: number): boolean {
    return (this.roadsAt.get(node)?.size ?? 0) === 1 && !this.bulbs.has(node);
  }

  private tableSpec(table: TileLinks, k: number): MesoLinkSpec {
    const to = table.to[k]!;
    // Its stop line by the roads met at its end over every tile there (a junction on a tile's edge counts both tiles' roads).
    const controlled = (this.roadsAt.get(to)?.size ?? 0) >= 3 || (table.flags[k]! & LINK_CROSSING) !== 0;
    return { to, lanes: table.lanes[k]!, length: table.length[k]!, vFree: table.vFree[k]!, controlled, exit: this.edgeAt(to) };
  }

  /** A live slot's numbers from its lanes (`lanelets.ts`); its exit over the roads met at its end in every tile. */
  private setSpec(w: SimWorld, slot: number): void {
    const lanes = this.slotLanes.get(slot)?.lanes;
    if (!lanes?.length) {
      const back = this.backing.get(slot);
      if (back && this.model.has(slot)) this.model.setLink(slot, this.tableSpec(back.table, back.index));
      return;
    }
    let length = 0, vFree = 0, controlled = false;
    for (const id of lanes) {
      const lane = w.graph.lanelets.get(id)!;
      length += lane.length;
      vFree = Math.max(vFree, lane.speedLimit);
      controlled ||= lane.controlled;
    }
    const to = w.graph.lanelets.get(lanes[0]!)!.to as number;
    const had = this.model.has(slot);
    this.model.setLink(slot, { to, lanes: lanes.length, length: length / lanes.length, vFree, controlled, exit: this.edgeAt(to) });
    if (!had) this.seedNew(slot, length / lanes.length);
  }

  /** A new link starts as a street of its land use stands at this hour (in free flow): the map is full from its first step. */
  private seedNew(slot: number, length: number): void {
    const n = this.demand.carsPer100m(this.cellOf.get(slot)!) * (length / m(100)) * this.scale;
    if (n > 0) this.model.seed(slot, n);
  }

  /** The demand's scale, as the simulation last set it (`rates`). */
  private scale = 1;

  /** The links whose ends' roads changed: their exits and signals, and their turns, worked out again. */
  private settle(w: SimWorld): void {
    if (!this.touchedNodes.size) return;
    const nodes = this.touchedNodes;
    this.touchedNodes = new Set();
    const ins = new Set<number>();
    for (const node of nodes) for (const i of this.model.inLinks(node)) ins.add(i);
    for (const i of ins) this.setSpec(w, i);
    for (const i of ins) this.returns(w, i);
  }

  /** A link's turns: on the page's roads, the links its lanes' movements lead onto (weighted by how many); at a node a table's road meets, every road leaving it by its lanes; a U-turn only when nothing else. */
  private returns(w: SimWorld, slot: number): void {
    if (!this.model.has(slot)) return;
    const node = this.model.toAt(slot);
    const outs = [...this.outAt.get(node) ?? []].filter((o) => this.model.has(o));
    const lanes = this.slotLanes.get(slot)?.lanes;
    const back = this.slotOf.get(reverseLink(this.linkAt[slot]!));
    const weight = new Map<number, number>();
    if (lanes?.length && outs.every((o) => this.isLive(o))) {
      for (const id of lanes) {
        for (const cid of w.graph.exitsOf(id)) {
          const c = w.connector(cid);
          const j = c ? this.laneSlot.get(c.toLane) : undefined;
          if (j === undefined) continue;
          weight.set(j, (weight.get(j) ?? 0) + 1);
        }
      }
    } else {
      const own = this.backing.get(slot);
      if (own && !lanes?.length && this.onlyTable(own.table, node, outs)) {
        // A node of one table's roads only: its turns as baked.
        const { table, index: k } = own;
        for (let t = table.turnStart[k]!; t < table.turnStart[k + 1]!; t++) {
          const j = this.slotOf.get(table.link[table.turnTo[t]!]!);
          if (j !== undefined) weight.set(j, table.turnWeight[t]!);
        }
      } else {
        for (const o of outs) weight.set(o, this.model.lanesAt(o));
      }
    }
    if (weight.size > 1 && back !== undefined) weight.delete(back);
    const to = [...weight.keys()].sort((a, b) => a - b);
    this.model.setTurns(slot, to, to.map((j) => weight.get(j)!));
  }

  /** Whether every link into and out of `node` is a link of `table` held by no lanes. */
  private onlyTable(table: TileLinks, node: number, outs: readonly number[]): boolean {
    for (const s of [...this.model.inLinks(node), ...outs]) {
      if (this.isLive(s) || this.backing.get(s)?.table !== table) return false;
    }
    return true;
  }

  // ------------------------------------------------------------ the micro window

  private inWindow(p: Filed): boolean {
    const win = this.micro;
    return win.r > 0 && Math.hypot(p.x - win.x, p.y - win.y) < win.r;
  }

  /** DO NOT look at every link of the map: only those filed where the window was or will be. */
  private moveWindow(w: SimWorld, to: { x: number; y: number; r: number }): void {
    this.wanted = null;
    const was = this.micro;
    const look = new Set<number>();
    if (was.r > 0) for (const id of this.filing.idsMeeting([was.x - was.r, was.y - was.r, was.x + was.r, was.y + was.r])) look.add(id);
    if (to.r > 0) for (const id of this.filing.idsMeeting([to.x - to.r, to.y - to.r, to.x + to.r, to.y + to.r])) look.add(id);
    this.micro = { ...to };
    for (const slot of [...look].sort((a, b) => a - b)) {
      const p = this.middle.get(slot);
      if (!p || !this.model.has(slot)) continue;
      // Only the page's roads come into the window: a table's link has no lanes to make its cars on.
      const inside = this.inWindow(p) && this.isLive(slot);
      if (inside === this.model.isInside(slot)) continue;
      if (inside) this.enter(slot); else this.leave(w, slot);
    }
  }

  /** A link comes into the window: its cars are to be made along it. */
  private enter(slot: number): void {
    const n = this.model.enterWindow(slot);
    if (n <= 0) return;
    this.fill.set(slot, Math.floor(n));
    this.pendingSlots.add(slot);
  }

  /** A link leaves the window: the micro simulation's cars on it (those the meso made) taken off and counted on it again. */
  private leave(w: SimWorld, slot: number): void {
    let k = 0;
    for (const id of this.slotLanes.get(slot)?.lanes ?? []) {
      for (const vid of [...w.rt(id).order]) {
        const v = w.vehicles.get(vid);
        if (!v || !this.owned.has(vid) || v.lanelet !== id) continue;
        w.removeVehicle(v);
        this.owned.delete(vid);
        k++;
      }
    }
    this.pendingSlots.delete(slot);
    this.fill.delete(slot);
    this.model.leaveWindow(slot, k);
  }

  /** The cars handed to the window made, a few a tick (as the edge entries admit them), up to the fleet the machine carries. */
  private admit(w: SimWorld): void {
    if (!this.pendingSlots.size) return;
    const ceiling = Math.floor(FLEET_CEILING * w.populationShare);
    const rng = w.rng.meso;
    let tries = ADMIT_PER_TICK;
    for (const slot of this.pendingSlots) {
      if (tries <= 0 || w.vehicles.size >= ceiling) return;
      const lanes = this.slotLanes.get(slot)?.lanes;
      if (!lanes?.length || !this.model.isInside(slot)) { this.pendingSlots.delete(slot); this.fill.delete(slot); continue; }
      while (tries > 0 && this.model.pending(slot) >= 1 && w.vehicles.size < ceiling) {
        tries--;
        const lane = w.lanelet(lanes[rng.int(0, lanes.length - 1)]!);
        if (!lane) break;
        const arch = rng.weighted(TRAFFIC);
        const spread = (this.fill.get(slot) ?? 0) > 0;
        const room = lane.length - arch.length - m(0.8);
        if (room <= 0) break;
        const s = spread ? arch.length + m(0.4) + rng.float() * room : Math.min(lane.length - m(0.4), arch.length + ENTRY_CLEARANCE);
        const id = spawnVehicleAt(w, lane.id, s, arch);
        if (id === null) break;
        this.owned.add(id);
        this.model.takePending(slot, 1);
        if (spread) this.fill.set(slot, this.fill.get(slot)! - 1);
      }
      if (this.model.pending(slot) < 1) { this.pendingSlots.delete(slot); this.fill.delete(slot); }
    }
  }

  /** The meso's cars that drove out of the window, taken off the micro simulation onto the link they reached. */
  private takeBack(w: SimWorld): void {
    for (const id of [...this.owned]) {
      const v = w.vehicles.get(id as never);
      if (!v) { this.owned.delete(id); continue; }
      if (v.free) continue;
      const lane = w.lanelet(v.lanelet);
      if (!lane || lane.kind !== 'link') continue;
      const slot = this.laneSlot.get(lane.id);
      if (slot === undefined || !this.model.has(slot) || this.model.isInside(slot)) continue;
      w.removeVehicle(v);
      this.owned.delete(id);
      this.model.microExit(slot);
    }
  }

  /** The micro simulation's vehicles on each link inside the window (all of them: buses and the lots' cars take room too). */
  private countMicro(w: SimWorld): void {
    for (const slot of this.counted) this.model.setMicro(slot, 0);
    const counts = new Map<number, number>();
    for (const id of w.occupied) {
      const slot = this.laneSlot.get(id);
      if (slot === undefined || !this.model.isInside(slot)) continue;
      counts.set(slot, (counts.get(slot) ?? 0) + w.rt(id).order.length);
    }
    this.counted = [...counts.keys()];
    for (const [slot, n] of counts) this.model.setMicro(slot, n);
  }

  // ------------------------------------------------------------ demand

  /** Each link's trips: from off the world at an entry (`vehicles/spawn.ts` ENTRY_RATE a lane), and its street's own by the land use at this hour (the page's buildings and the tables'). */
  private rates(w: SimWorld): void {
    this.demand.sync(w.buildings, w.doc.changes);
    this.demand.atHour((w.city.minutes(w) % 1440) / 60);
    const model = this.model;
    for (let slot = 0; slot < model.slots; slot++) {
      if (!model.has(slot)) continue;
      const L = model.lengthAt(slot), lanes = model.lanesAt(slot), cell = this.cellOf.get(slot)!;
      const vFree = model.freeSpeedAt(slot);
      const from = this.ends.get(slot)?.from;
      const entry = from !== undefined && this.edgeAt(from) ? ENTRY_RATE * lanes : 0;
      // Balanced with the share ending here: the street holds the ambient's density in free flow.
      const local = this.demand.carsPer100m(cell) * (L / m(100)) * vFree / TRIP_LENGTH;
      model.setGeneration(slot, (entry + local) * this.scale);
      model.setSinkShare(slot, Math.min(1, L / TRIP_LENGTH) * this.demand.weight(cell));
    }
  }

  // ------------------------------------------------------------ the page's buffer

  /** Each link's numbers (and its line when it changed) into the page's buffer, then the step's serial (Atomics: the page reads a whole step's serial after its numbers). */
  private publish(w: SimWorld): void {
    const memory = this.memory;
    if (!memory) return;
    // A new buffer has no line yet: every slot's written.
    const whole = memory.capacity !== this.published;
    this.published = memory.capacity;
    const model = this.model, links = memory.links, n = Math.min(model.slots, memory.capacity);
    for (let slot = 0; slot < n; slot++) {
      const at = slot * MESO_RECORD;
      if (!model.has(slot)) { links[at + ML.flags] = 0; continue; }
      const inside = model.isInside(slot);
      links[at + ML.count] = model.count(slot);
      links[at + ML.queued] = model.queued(slot);
      links[at + ML.speed] = model.speed(slot);
      links[at + ML.length] = model.lengthAt(slot);
      links[at + ML.lanes] = model.lanesAt(slot);
      links[at + ML.flags] = MESO_PRESENT | (inside ? MESO_INSIDE : 0) | (this.oneWay[slot] ? MESO_ONE_WAY : 0);
      if (!whole && !this.linesDirty.has(slot)) continue;
      memory.ids[slot] = this.linkAt[slot]!;
      for (let k = 0; k < 6; k++) links[at + ML.ax + k] = this.lines[slot * 6 + k]!;
      this.shapeSerial = (this.shapeSerial % SHAPE_WRAP) + 1;
      links[at + ML.shape] = this.shapeSerial;
    }
    for (let slot = n; slot < memory.capacity; slot++) links[slot * MESO_RECORD + ML.flags] = 0;
    // The slots past the buffer keep their lines owed: the page makes a bigger buffer (`wanted`), written whole.
    for (const slot of this.linesDirty) if (slot < n) this.linesDirty.delete(slot);
    memory.head[MH.time] = w.clock.time;
    memory.head[MH.windowX] = this.micro.x;
    memory.head[MH.windowY] = this.micro.y;
    memory.head[MH.windowR] = this.micro.r;
    Atomics.store(memory.control, MC.wanted, model.slots);
    Atomics.add(memory.control, MC.serial, 1);
  }
}
