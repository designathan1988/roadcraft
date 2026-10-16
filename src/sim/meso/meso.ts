import { m } from '@world/units';
import { CellFiling } from '@world/cells';
import type { LaneletId } from '@world/lanelets';
import { DT, FLEET_CEILING } from '../params';
import type { SimWorld } from '../world';
import { spawnVehicleAt, ENTRY_RATE } from '../vehicles/spawn';
import { TRAFFIC } from '../ambient/ambient';
import { MesoModel } from './model';
import { DemandCells } from './demand';
import { MC, MESO_INSIDE, MESO_PRESENT, MESO_RECORD, MH, MICRO_RADIUS, ML, type MesoMemory } from './memory';

/** THE MESO TRAFFIC IN THE SIMULATION: the whole map's flows (`model.ts`), and the micro window they hand their cars to and take them back from */

/** Seconds of the city between two steps of the meso model. */
export const MESO_DT = 1;
/** A trip's mean length, for the share of a link's traffic that ends its trip on it and how often its street's lots send one out. */
const TRIP_LENGTH = m(3000);
/** Most cars made in the window a tick, as the edge entries admit them (`vehicles/spawn.ts` ADMIT_PER_TICK). */
const ADMIT_PER_TICK = 4;
/** How far ahead of a link's start a car handed in at its upstream end is made. */
const ENTRY_CLEARANCE = m(0.6);

/** What one directed road is made of in the lane graph: its link lanes the cars may take (not the buses' own). */
interface SlotLanes { readonly lanes: LaneletId[] }
/** A slot filed by its middle (`CellFiling` holds objects). */
interface Filed { readonly x: number; readonly y: number }

export class Meso {
  model = new MesoModel(MESO_DT);
  private demand = new DemandCells();
  private memory: MesoMemory | null = null;
  private clock = 0;
  private graphSeen: object | null = null;
  /** Each link lane's slot, and each slot's lanes. */
  private readonly laneSlot = new Map<LaneletId, number>();
  private readonly slotLanes = new Map<number, SlotLanes>();
  /** Each slot's middle and its demand cell, and the node it starts at. */
  private readonly middle = new Map<number, Filed>();
  private readonly cellOf = new Map<number, number>();
  private readonly fromOf = new Map<number, number>();
  private readonly filing = new CellFiling<number, Filed>();
  /** The micro window: where it stands, and where it was asked to go (`want`). */
  private window = { x: 0, y: 0, r: 0 };
  private wanted: { x: number; y: number; r: number } | null = null;
  /** The vehicles the meso handed to the micro simulation: taken back when they drive out of the window. */
  readonly owned = new Set<number>();
  /** Slots with vehicles to make in the window, and how many of each to spread along it (handed with the window) rather than at its start. */
  private readonly pendingSlots = new Set<number>();
  private readonly fill = new Map<number, number>();
  /** Slots given a count of the micro vehicles last step. */
  private counted: number[] = [];

  /** Everything forgotten (another map): the window and the page's buffer kept. */
  reset(): void {
    this.model = new MesoModel(MESO_DT);
    this.demand = new DemandCells();
    this.clock = 0;
    this.graphSeen = null;
    this.laneSlot.clear();
    this.slotLanes.clear();
    this.middle.clear();
    this.cellOf.clear();
    this.fromOf.clear();
    for (const id of [...this.filing.ids()]) this.filing.remove(id);
    this.owned.clear();
    this.pendingSlots.clear();
    this.fill.clear();
    this.counted = [];
    // The window stands where it was asked to: entered again over the new map's links at the next step.
    this.wanted ??= { ...this.window };
    this.window = { x: 0, y: 0, r: 0 };
  }

  /** The page's buffer the steps are written into (`render/densityCars.ts`). */
  attach(memory: MesoMemory): void {
    this.memory = memory;
  }

  /** The micro window asked to stand round (x, y): moved at the next step. */
  want(x: number, y: number, r = MICRO_RADIUS): void {
    this.wanted = { x, y, r };
  }

  /** Stage 2 (`pipeline.ts`): the links brought up to the lane graph, cars made in the window, and each `MESO_DT` a step of the model. */
  step(w: SimWorld, traffic: boolean): void {
    if (!traffic) return;
    this.sync(w);
    if (this.wanted) this.moveWindow(w, this.wanted);
    this.admit(w);
    this.clock += DT;
    if (this.clock + 1e-9 < MESO_DT) return;
    this.clock -= MESO_DT;
    this.takeBack(w);
    this.countMicro(w);
    this.rates(w);
    this.model.step();
    this.publish(w);
  }

  /** The slot of a link lane, if it has one. */
  slotOfLane(id: LaneletId): number | undefined {
    return this.laneSlot.get(id);
  }

  // ------------------------------------------------------------ the links, by the lane graph's log

  /** DO NOT read every lane of the map for an edit: only those the topology's log names. */
  private sync(w: SimWorld): void {
    if (this.graphSeen === w.topologyLog.state) return;
    const changes = w.topologyLog.since(this.graphSeen);
    this.graphSeen = w.topologyLog.state;
    const lanes = new Set<LaneletId>();
    const nodes = new Set<number>();
    if (changes === null) {
      // @rebuild The lane graph built whole: every lane, those known and those there now.
      for (const id of this.laneSlot.keys()) lanes.add(id);
      for (const id of w.graph.lanelets.keys()) lanes.add(id);
    } else {
      for (const change of changes) {
        for (const id of change.lanelets) lanes.add(id);
        for (const node of change.junctions) nodes.add(node);
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
      const slot = lane.segment * 2 + (seg.a === lane.from ? 0 : 1);
      this.laneSlot.set(id, slot);
      let list = this.slotLanes.get(slot);
      if (!list) this.slotLanes.set(slot, list = { lanes: [] });
      list.lanes.push(id);
      touched.add(slot);
    }
    for (const slot of touched) this.relink(w, slot, nodes);
    // The turns of the links touched, and of every link into a node whose movements may have changed.
    const turns = new Set<number>(touched);
    for (const node of nodes) for (const i of this.model.inLinks(node)) turns.add(i);
    for (const slot of turns) this.returns(w, slot);
  }

  /** One slot made again from its lanes: its numbers, its place, inside the window or not. */
  private relink(w: SimWorld, slot: number, nodes: Set<number>): void {
    const list = this.slotLanes.get(slot);
    const lanes = list?.lanes.filter((id) => w.graph.lanelets.has(id)) ?? [];
    if (!lanes.length) {
      this.slotLanes.delete(slot);
      const from = this.fromOf.get(slot);
      if (from !== undefined) nodes.add(from);
      this.fromOf.delete(slot);
      this.middle.delete(slot);
      this.cellOf.delete(slot);
      this.filing.remove(slot);
      this.pendingSlots.delete(slot);
      this.fill.delete(slot);
      this.model.dropLink(slot);
      return;
    }
    lanes.sort();
    this.slotLanes.set(slot, { lanes });
    let length = 0, vFree = 0, controlled = false;
    for (const id of lanes) {
      const lane = w.graph.lanelets.get(id)!;
      length += lane.length;
      vFree = Math.max(vFree, lane.speedLimit);
      controlled ||= lane.controlled;
    }
    const first = w.graph.lanelets.get(lanes[0]!)!;
    const from = first.from as number, to = first.to as number;
    this.fromOf.set(slot, from);
    nodes.add(from);
    const mid = first.centre.sampleAt(first.length / 2).p;
    const filed = { x: mid.x, y: mid.y };
    this.middle.set(slot, filed);
    this.cellOf.set(slot, this.demand.cellOf(mid.x, mid.y));
    this.filing.file(slot, filed, [mid.x, mid.y, mid.x, mid.y]);
    const had = this.model.has(slot);
    this.model.setLink(slot, {
      to, lanes: lanes.length, length: length / lanes.length, vFree, controlled,
      exit: w.doc.mapEdge(first.to!),
    });
    // A new link starts as a street of its land use stands at this hour (in free flow): the map is full from its first step.
    if (!had) {
      const n = this.demand.carsPer100m(this.cellOf.get(slot)!) * (length / lanes.length / m(100)) * w.trafficIntensity * w.demandMultiplier;
      if (n > 0) this.model.seed(slot, n);
    }
    const inside = this.inWindow(filed);
    if (inside && !this.model.isInside(slot)) this.enter(slot);
    else if (!inside && this.model.isInside(slot)) this.leave(w, slot);
  }

  /** A link's turns: the links its lanes' movements lead onto, weighted by how many of them; a U-turn only when nothing else. */
  private returns(w: SimWorld, slot: number): void {
    const list = this.slotLanes.get(slot);
    if (!list || !this.model.has(slot)) return;
    const weight = new Map<number, number>();
    for (const id of list.lanes) {
      for (const cid of w.graph.exitsOf(id)) {
        const c = w.connector(cid);
        const j = c ? this.laneSlot.get(c.toLane) : undefined;
        if (j === undefined) continue;
        weight.set(j, (weight.get(j) ?? 0) + 1);
      }
    }
    if (weight.size > 1) weight.delete(slot ^ 1);
    const to = [...weight.keys()].sort((a, b) => a - b);
    this.model.setTurns(slot, to, to.map((j) => weight.get(j)!));
  }

  // ------------------------------------------------------------ the micro window

  private inWindow(p: Filed): boolean {
    const win = this.window;
    return win.r > 0 && Math.hypot(p.x - win.x, p.y - win.y) < win.r;
  }

  /** DO NOT look at every link of the map: only those filed where the window was or will be. */
  private moveWindow(w: SimWorld, to: { x: number; y: number; r: number }): void {
    this.wanted = null;
    const was = this.window;
    const look = new Set<number>();
    if (was.r > 0) for (const id of this.filing.idsMeeting([was.x - was.r, was.y - was.r, was.x + was.r, was.y + was.r])) look.add(id);
    if (to.r > 0) for (const id of this.filing.idsMeeting([to.x - to.r, to.y - to.r, to.x + to.r, to.y + to.r])) look.add(id);
    this.window = { ...to };
    for (const slot of [...look].sort((a, b) => a - b)) {
      const p = this.middle.get(slot);
      if (!p || !this.model.has(slot)) continue;
      const inside = this.inWindow(p);
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

  /** Each link's trips: from off the map at an entry (`vehicles/spawn.ts` ENTRY_RATE a lane), and its street's own by the land use at this hour. */
  private rates(w: SimWorld): void {
    this.demand.sync(w.buildings, w.doc.changes);
    this.demand.atHour((w.city.minutes(w) % 1440) / 60);
    const scale = w.trafficIntensity * w.demandMultiplier;
    const model = this.model;
    for (let slot = 0; slot < model.slots; slot++) {
      if (!model.has(slot)) continue;
      const L = model.lengthAt(slot), lanes = model.lanesAt(slot), cell = this.cellOf.get(slot)!;
      const vFree = model.freeSpeedAt(slot);
      const entry = this.isEntry(w, slot) ? ENTRY_RATE * lanes : 0;
      // Balanced with the share ending here: the street holds the ambient's density in free flow.
      const local = this.demand.carsPer100m(cell) * (L / m(100)) * vFree / TRIP_LENGTH;
      model.setGeneration(slot, (entry + local) * scale);
      model.setSinkShare(slot, Math.min(1, L / TRIP_LENGTH) * this.demand.weight(cell));
    }
  }

  private isEntry(w: SimWorld, slot: number): boolean {
    const from = this.fromOf.get(slot);
    return from !== undefined && w.doc.mapEdge(from as never);
  }

  // ------------------------------------------------------------ the page's buffer

  /** Each link's numbers into the page's buffer, then the step's serial (Atomics: the page reads a whole step's serial after its numbers). */
  private publish(w: SimWorld): void {
    const memory = this.memory;
    if (!memory) return;
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
      links[at + ML.flags] = MESO_PRESENT | (inside ? MESO_INSIDE : 0);
    }
    for (let slot = n; slot < memory.capacity; slot++) links[slot * MESO_RECORD + ML.flags] = 0;
    memory.head[MH.time] = w.clock.time;
    memory.head[MH.windowX] = this.window.x;
    memory.head[MH.windowY] = this.window.y;
    memory.head[MH.windowR] = this.window.r;
    Atomics.store(memory.control, MC.wanted, model.slots);
    Atomics.add(memory.control, MC.serial, 1);
  }
}
