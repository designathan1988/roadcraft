import type { RoadDoc, Restoration, RecordPart, ValuePart } from '@world/doc';
import type { DocChangeKind, JournalReader } from '@world/changes';
import type { NodeId, SegmentId } from '@world/ids';
import type { BuildingId } from '@world/buildings/types';
import { buildingChangesOf, trafficMapOf } from '../agents/trafficBuildings';
import { archetypeById, type Archetype } from '../vehicles/archetypes';
import type { KerbStop } from '../vehicles/kerbStops';
import type { PedView, PersonAgeClass } from '../people/view';
import type { VehicleFrames } from '../pose';
import type { SignalState } from '../signals/query';
import type { JunctionAnswer, TrafficCount } from './simAnswers';
import type { Casualty } from '../people/casualties';
import { FleetGrid, type GroundBox } from './fleetGrid';
import {
  C, H, P, PED_STRIDE, V, VEHICLE_STRIDE, headBase, makeSharedFrames, pedBase, vehicleBase,
  type FromSim, type SignalLayout, type SimAct, type SimAsk, type SimControls, type SimStats, type ToSim, type TrainState, type Wound,
} from './protocol';

/** THE PAGE'S SIDE OF THE SIMULATION'S WORKER (`simHost.ts`): the map's changes sent, the frame read, the panels' questions asked */

/** A vehicle as the page draws it: its numbers of the last tick and what it carries (`VehicleRich`). */
export interface VehicleView {
  readonly id: number;
  archetype: Archetype;
  color: string;
  doors: readonly number[];
  kerbStop: KerbStop | null;
  people: readonly number[];
  peopleAge: readonly (PersonAgeClass | undefined)[];
  seats: number;
  slain: boolean;
  age: number;
  v: number;
  readonly prev: { v: number };
  /** Off the road: its pose a tick ago and now, and the lot it stands on; null on a lane. */
  free: { px: number; py: number; pangle: number; x: number; y: number; angle: number; lot: number | null } | null;
  readonly frames: VehicleFrames;
  /** The road its lane belongs to (undefined on a junction's connector), and the road it came from on one. */
  segment: SegmentId | undefined;
  inSegment: SegmentId | undefined;
  indicator: -1 | 0 | 1;
  curvature: number;
  odometer: number;
}

/** A junction's signal heads and their lights as the worker last told them (`render/signals.ts`). */
export interface SignalFeed {
  /** The junctions whose heads moved since `serial` (null: every junction), and the serial now. */
  changesSince(serial: number): { readonly serial: number; readonly nodes: readonly NodeId[] | null };
  layout(node: NodeId): SignalLayout | undefined;
  /** A group's colour, and the junction's stage key (moves when any of its lights does). */
  state(node: NodeId, group: number): SignalState;
  stage(node: NodeId): string;
  nodes(): Iterable<NodeId>;
}

/** The kinds of the diary the worker's copy of the map follows, and what each carries. */
const RECORD_KINDS: Readonly<Partial<Record<DocChangeKind, readonly RecordPart[]>>> = {
  roads: ['nodes', 'segments'], traffic: ['nodes', 'segments'], lots: ['lots'],
};
const VALUE_KINDS: Readonly<Partial<Record<DocChangeKind, ValuePart>>> = { transit: 'transit' };
/** DO NOT send a building's record (nor its wear): the worker is sent its traffic record (`agents/trafficBuildings.ts`). */
const FOLLOWED: readonly DocChangeKind[] = [...Object.keys(RECORD_KINDS), ...Object.keys(VALUE_KINDS), 'lotKeys', 'buildings'] as DocChangeKind[];

export class SimClient implements JournalReader {
  /** The kinds the worker's copy follows: the diary keeps them until this client has sent them (`changes.follow`). */
  readonly kinds = FOLLOWED;
  private worker: Worker | null = null;
  private readonly frames = makeSharedFrames();
  private readonly data = new Float64Array(this.frames.data);
  private readonly control = new Int32Array(this.frames.control);
  /** The diary read up to (what the worker's copy of the map stands at), in the document it is of. */
  private seen = -1;
  private seenDoc: RoadDoc | null = null;
  private lotKeysSent = 0;
  /** The lot store's `keysRewritten` when the keys were last sent: unchanged, only the keys added since go. */
  private lotKeysRewritten = -1;
  /** A frame asked of the worker and not answered: the next waits, its wall time added up meanwhile. */
  private inFlight = false;
  /** The worker's last failure (`failed`), null while none. */
  failure: string | null = null;
  private wallOwed = 0;
  private readonly pending = new Map<number, (value: unknown) => void>();
  private nextAsk = 1;
  private readonly answers = new Map<string, unknown>();

  readonly vehicles = new Map<number, VehicleView>();
  /** The traffic and the cars parked in bays, whole; DO NOT walk them per frame or per query: ask by place (`vehiclesIn`). */
  readonly traffic: VehicleView[] = [];
  readonly parked: VehicleView[] = [];
  private readonly parkedById = new Map<number, VehicleView>();
  /** Each parked view's place in `parked` (taken out by swapping the last in, not by listing them all again). */
  private readonly parkedAt = new Map<VehicleView, number>();
  /** The traffic and the parked cars by 64 m cell, filed as the tick is decoded (`fleetGrid.ts`). */
  private readonly trafficGrid = new FleetGrid<VehicleView>();
  private readonly parkedGrid = new FleetGrid<VehicleView>();
  /** The longest step of the last tick (each axis): a pose drawn between the two ticks stands that far from the one filed at most. */
  private trafficSlack = 0;
  private parkedSlack = 0;
  /** The parked cars whose two poses differ (moved by the slot): settled on the next tick that tells no parked change, as before. */
  private readonly settling = new Set<VehicleView>();
  /** The traffic's speeds summed and how many stand (under 0.5), as the last tick's decode found them (the status, `main.ts`). */
  trafficSpeed = 0;
  trafficQueued = 0;
  readonly pedViews: PedView[] = [];
  /** Moves whenever a vehicle came or went (the casting forgets the people of those gone, `render/agents.ts`). */
  fleet = 0;
  /** Whether a view is one of the cars parked in their bays now. */
  isParked(view: VehicleView): boolean {
    return this.parkedById.get(view.id) === view;
  }

  /** The views that may be drawn in the box this frame, appended to `out` after clearing it: the traffic, then the parked cars (`which` keeps one of them). */
  vehiclesIn(box: Readonly<GroundBox>, out: VehicleView[], which: 'all' | 'traffic' | 'parked' = 'all'): VehicleView[] {
    out.length = 0;
    // Grown by the tick's longest step: the pose drawn lies between the two the frames hold (`framesPoseInto`).
    if (which !== 'parked') { const s = this.trafficSlack; this.trafficGrid.near(box.x0 - s, box.y0 - s, box.x1 + s, box.y1 + s, out); }
    if (which !== 'traffic') { const s = this.parkedSlack; this.parkedGrid.near(box.x0 - s, box.y0 - s, box.x1 + s, box.y1 + s, out); }
    return out;
  }

  private addParked(view: VehicleView): void {
    this.parkedById.set(view.id, view);
    this.parkedAt.set(view, this.parked.push(view) - 1);
  }

  private dropParked(view: VehicleView): void {
    this.parkedById.delete(view.id);
    const at = this.parkedAt.get(view);
    if (at !== undefined) {
      const last = this.parked.pop()!;
      if (at < this.parked.length) { this.parked[at] = last; this.parkedAt.set(last, at); }
      this.parkedAt.delete(view);
    }
    this.parkedGrid.remove(view);
    this.settling.delete(view);
  }

  private clearParked(): void {
    this.parked.length = 0;
    this.parkedById.clear();
    this.parkedAt.clear();
    this.parkedGrid.clear();
    this.settling.clear();
    this.parkedSlack = 0;
  }
  private readonly pedById = new Map<number, PedView>();
  trains: readonly TrainState[] = [];
  /** The simulation's clock as last told: seconds, the city's minutes, the tick's share gone by (`alpha`). */
  time = 0;
  minutes = 0;
  alpha = 1;
  lastSteps = 0;
  lastStepMs = 0;
  stats: SimStats | null = null;
  /** The player's settings of the simulation, sent with every frame (`frame`). */
  readonly clock = { speed: 1, paused: false, client: this as SimClient, get time(): number { return this.client.time; } };
  trafficIntensity = 1;
  pedestrianIntensity = 1;
  demandMultiplier = 1;
  /** The simulation stopped by the player, as the last frame sent it. */
  get paused(): boolean { return this.clock.paused; }
  /** The simulation's own checks told so far (`sim/invariants.ts`), oldest first. */
  readonly issues: SimStats['issues'][number][] = [];
  /** The topology the worker's simulation stands at (the network's `trafficRevision` it caught up to). */
  get topologyRevision(): number { return this.stats?.topologyRevision ?? -1; }
  /** What the simulation must show in full round the view (`render/renderer.ts` sets it each frame; sent with the next frame). */
  focus: SimControls['focus'] = null;
  /** Called with each frame read (a tick written), and once the worker stands. */
  onTick: (() => void) | null = null;
  private readonly layouts = new Map<NodeId, SignalLayout>();
  private readonly lights = new Map<NodeId, { stage: string; states: Map<number, SignalState> }>();
  private readonly signalLog: NodeId[] = [];
  private signalBase = 0;
  private signalAll = 0;

  /** The frames read so far (a tick of the worker each). */
  tick = 0;
  /** The wounds told since the effects last took them (`takeWounds`), and the casualties of blows, their clocks kept here. */
  private wounds: Wound[] = [];
  private casualtyList: Casualty[] = [];

  constructor(readonly doc: RoadDoc) {}

  /** The wounds told since the last call, taken (`render/playEffects.ts`). */
  takeWounds(): Wound[] {
    const out = this.wounds;
    this.wounds = [];
    return out;
  }

  /** The casualties of blows, their clocks advanced by `dt`, a minute's worth kept (`people/casualties.ts` impactCasualties). */
  casualties(dt = 0): readonly Casualty[] {
    for (const c of this.casualtyList) c.t += dt;
    if (this.casualtyList.length && this.casualtyList[0]!.t > 60) this.casualtyList = this.casualtyList.filter((c) => c.t <= 60);
    return this.casualtyList;
  }

  /** The worker made and given the map; resolved once it stands. */
  start(seed: number, zones: ReadonlyMap<string, Float64Array | null>, zonesPrefix: string | null, ambient: 'view' | 'edges'): Promise<void> {
    const worker = new Worker(new URL('../sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    const ready = new Promise<void>((done) => {
      worker.onmessage = (event: MessageEvent<FromSim>) => {
        if (event.data.type === 'ready') { worker.onmessage = (e: MessageEvent<FromSim>) => this.receive(e.data); done(); return; }
        this.receive(event.data);
      };
    });
    this.markSent();
    this.send({ type: 'init', frames: this.frames, map: trafficMapOf(this.doc), seed, zones, zonesPrefix, ambient });
    return ready;
  }

  /** Another map (opened, generated, new): the worker's copy made whole again (only what traffic reads), the simulation started over. */
  load(): void {
    this.markSent();
    this.send({ type: 'load', map: trafficMapOf(this.doc) });
    this.clearViews();
  }

  /** The simulation started over on the same map. */
  reset(): void {
    this.send({ type: 'reset' });
  }

  /** A frame of the page: the map's changes since the last sent, then the wall time and the controls (one frame asked at a time). */
  frame(wall: number, hold: boolean, run: { readonly traffic: boolean; readonly pedestrians: boolean; readonly maxShare: number }): void {
    this.sendChanges();
    this.wallOwed += wall;
    if (this.inFlight || !this.worker) return;
    this.inFlight = true;
    const controls: SimControls = {
      speed: this.clock.speed, paused: this.clock.paused, traffic: run.traffic, pedestrians: run.pedestrians,
      trafficIntensity: this.trafficIntensity, pedestrianIntensity: this.pedestrianIntensity, demandMultiplier: this.demandMultiplier,
      maxShare: run.maxShare, focus: this.focus,
    };
    this.send({ type: 'frame', wall: this.wallOwed, hold, controls });
    this.wallOwed = 0;
  }

  /** The player's hand on the simulation, answered when the worker has done it. */
  act(act: SimAct): Promise<unknown> {
    const id = this.nextAsk++;
    return new Promise((done) => { this.pending.set(id, done); this.send({ type: 'act', id, act }); });
  }

  /** A panel's question: the last answer to it now (null before the first), a fresh one asked for the next refresh. */
  asked(ask: SimAsk): unknown {
    const key = JSON.stringify(ask);
    const id = this.nextAsk++;
    this.pending.set(id, (value) => { this.answers.set(key, value); });
    this.send({ type: 'ask', id, ask });
    return this.answers.get(key) ?? null;
  }

  /** A question answered when the worker has (the green wave). */
  ask(ask: SimAsk): Promise<unknown> {
    const id = this.nextAsk++;
    return new Promise((done) => { this.pending.set(id, done); this.send({ type: 'ask', id, ask }); });
  }

  segmentTraffic(id: SegmentId): TrafficCount | null {
    return this.asked({ kind: 'segment', id }) as TrafficCount | null;
  }

  junction(node: NodeId): JunctionAnswer | null {
    return this.asked({ kind: 'junction', node }) as JunctionAnswer | null;
  }

  /** The signalised junctions as the blows' posts read them (`world/signalPosts.ts`). */
  readonly signalJunctions = { junctions: new Map<NodeId, { readonly signalised: boolean; readonly groups: SignalLayout['groups'] }>() };

  readonly signals: SignalFeed = {
    changesSince: (serial) => {
      const now = this.signalBase + this.signalLog.length;
      if (serial < this.signalAll || serial < this.signalBase || serial > now) return { serial: now, nodes: null };
      return { serial: now, nodes: this.signalLog.slice(serial - this.signalBase) };
    },
    layout: (node) => this.layouts.get(node),
    state: (node, group) => this.lights.get(node)?.states.get(group) ?? 'red',
    stage: (node) => this.lights.get(node)?.stage ?? '',
    nodes: () => this.layouts.keys(),
  };

  private send(message: ToSim): void {
    this.worker?.postMessage(message);
  }

  /** What the worker's copy has been sent up to (`JournalReader`). */
  get seenSerial(): number {
    return this.seen;
  }

  private markSent(): void {
    this.seen = this.doc.changes.version;
    // DO NOT read the diary without following it: past 2 x KEPT entries of a kind it let them go, and the whole map was sent again each frame a city was laid out.
    if (this.seenDoc !== this.doc) this.doc.changes.follow(this);
    this.seenDoc = this.doc;
    this.lotKeysSent = this.doc.lotStore.keys.length;
    this.lotKeysRewritten = this.doc.lotStore.keysRewritten;
  }

  /** The map's changes the worker's copy follows, since the last sent: by the records the diary names, or the whole map. */
  private sendChanges(): void {
    if (!this.worker) return;
    const changes = this.doc.changes;
    if (this.seenDoc !== this.doc) { this.load(); return; }
    if (changes.version === this.seen) return;
    const entries = changes.since(this.seen, FOLLOWED);
    if (entries === null) { this.load(); return; }
    this.seen = changes.version;
    if (!entries.length) return;
    const named = new Map<RecordPart, Set<number>>();
    const buildings = new Set<BuildingId>();
    const values = new Set<ValuePart>();
    let keys = false;
    for (const e of entries) {
      if (e.kind === 'buildings') {
        // A change of buildings that does not say which: the worker's copy made whole again.
        if (!e.ids) { this.load(); return; }
        for (const id of e.ids) buildings.add(id as BuildingId);
        continue;
      }
      const parts = RECORD_KINDS[e.kind as DocChangeKind];
      if (parts) {
        // A change of records that does not say which: the worker's copy made whole again.
        if (!e.ids) { this.load(); return; }
        for (const part of parts) {
          let set = named.get(part);
          if (!set) named.set(part, set = new Set());
          for (const id of e.ids) set.add(id);
        }
      }
      const value = VALUE_KINDS[e.kind as DocChangeKind];
      if (value) values.add(value);
      if (e.kind === 'lotKeys') keys = true;
    }
    const records: Restoration['records'][number][] = [];
    for (const [part, ids] of named) for (const id of ids) records.push({ part, id, value: recordOf(this.doc, part, id) });
    const lists: Restoration['lists'][number][] = [];
    if (keys) {
      const store = this.doc.lotStore, all = store.keys;
      // DO NOT send every key at each lot laid: the city's layout sent the whole list once per lot (O(lots²) copied).
      if (store.keysRewritten === this.lotKeysRewritten && all.length >= this.lotKeysSent) lists.push({ part: 'lotKeys', start: this.lotKeysSent, remove: 0, items: all.slice(this.lotKeysSent) });
      else lists.push({ part: 'lotKeys', start: 0, remove: this.lotKeysSent, items: all.slice() });
      this.lotKeysSent = all.length;
      this.lotKeysRewritten = store.keysRewritten;
    }
    this.send({
      type: 'delta', delta: { records, lists, values: [...values].map((part) => ({ part, value: this.doc.valueOf(part) })) },
      buildings: buildingChangesOf(this.doc, buildings),
    });
  }

  private receive(message: FromSim): void {
    switch (message.type) {
      case 'tick': this.readTick(message); return;
      case 'acted': case 'answer': {
        const done = this.pending.get(message.id);
        this.pending.delete(message.id);
        done?.(message.type === 'acted' ? message.result : message.answer);
        return;
      }
      case 'ready': return;
      // DO NOT stay silent: the frame asked of it never comes, and the city would stand still with no word.
      case 'failed':
        // Told once (each frame after may fail the same way), the last kept for the probes.
        if (this.failure === null) console.error("[sim] the simulation's worker failed:", message.message);
        this.failure = message.message;
        this.inFlight = false;
        return;
    }
  }

  /** The frame the worker wrote: read from its slot (marked as being read), its rich parts from the message. */
  private readTick(message: Extract<FromSim, { type: 'tick' }>): void {
    this.inFlight = false;
    const slot = Atomics.load(this.control, C.latest);
    Atomics.store(this.control, C.reading, slot);
    const data = this.data, h = headBase(slot);
    this.time = data[h + H.time]!;
    this.minutes = data[h + H.minutes]!;
    this.alpha = data[h + H.alpha]!;
    this.lastSteps = data[h + H.steps]!;
    this.lastStepMs = data[h + H.stepMs]!;
    const rich = new Map(message.vehicles);
    // The cars parked in bays, as told: come, gone, or the whole list.
    if (message.parked) {
      if (message.parked.some((p) => p.whole)) this.clearParked();
      for (const p of message.parked) {
        this.fleet++;
        if (p.gone) { const gone = this.parkedById.get(p.id); if (gone) this.dropParked(gone); continue; }
        const known = this.parkedById.get(p.id);
        const view = known ?? newView(p.id);
        view.archetype = archetypeById(p.archetype);
        view.color = p.color;
        view.free = { px: p.x, py: p.y, pangle: p.angle, x: p.x, y: p.y, angle: p.angle, lot: p.lot };
        view.v = 0; view.prev.v = 0; view.seats = 0;
        setFrames(view.frames, p.x, p.y, p.angle, p.x, p.y, p.angle);
        if (!known) this.addParked(view);
        this.parkedGrid.place(view);
      }
    } else {
      // The parked cars that moved last tick and not this one stand where they stopped: DO NOT walk every parked car for them.
      for (const view of this.settling) {
        const f = view.free;
        if (f && (f.px !== f.x || f.py !== f.y)) { f.px = f.x; f.py = f.y; f.pangle = f.angle; setFrames(view.frames, f.x, f.y, f.angle, f.x, f.y, f.angle); }
      }
      this.settling.clear();
    }
    const n = data[h + H.vehicles]!;
    const vb = vehicleBase(slot);
    this.traffic.length = 0;
    const seen = new Set<number>();
    let speed = 0, queued = 0, slack = 0;
    for (let k = 0; k < n; k++) {
      const at = vb + k * VEHICLE_STRIDE;
      const id = data[at + V.id]!;
      const parked = data[at + V.free] === 2;
      let view = parked ? this.parkedById.get(id) : this.vehicles.get(id);
      if (!view) {
        view = newView(id);
        this.fleet++;
        if (parked) this.addParked(view); else this.vehicles.set(id, view);
      }
      const r = rich.get(id);
      if (r) {
        view.archetype = archetypeById(r.archetype);
        view.color = r.color;
        view.doors = r.doors;
        view.kerbStop = r.kerbStop;
        view.people = r.people;
        view.peopleAge = r.peopleAge;
      }
      const f = view.frames;
      setFrames(f, data[at + V.bx]!, data[at + V.by]!, data[at + V.bangle]!, data[at + V.x]!, data[at + V.y]!, data[at + V.angle]!);
      f.yawBefore = data[at + V.yawBefore]!; f.yawNow = data[at + V.yawNow]!; f.jump = data[at + V.jump] === 1;
      const free = data[at + V.free]! > 0;
      const lot = data[at + V.lot]!;
      view.free = free ? { px: f.bx, py: f.by, pangle: f.bangle, x: f.x, y: f.y, angle: f.angle, lot: lot < 0 ? null : lot } : null;
      view.v = data[at + V.v]!; view.prev.v = data[at + V.prevV]!; view.age = data[at + V.age]!;
      const segment = data[at + V.segment]!, inSegment = data[at + V.inSegment]!;
      view.segment = segment < 0 ? undefined : segment as SegmentId;
      view.inSegment = inSegment < 0 ? undefined : inSegment as SegmentId;
      view.indicator = data[at + V.indicator]! as -1 | 0 | 1;
      view.curvature = data[at + V.curvature]!;
      view.odometer = data[at + V.odometer]!;
      view.seats = data[at + V.seats]!;
      view.slain = data[at + V.slain] === 1;
      if (parked) {
        this.parkedGrid.place(view);
        if (f.bx !== f.x || f.by !== f.y) this.settling.add(view);
        continue;
      }
      this.traffic.push(view);
      seen.add(id);
      this.trafficGrid.place(view);
      const step = f.jump ? 0 : Math.max(Math.abs(f.x - f.bx), Math.abs(f.y - f.by));
      if (step > slack) slack = step;
      speed += view.v;
      if (view.v < 0.5) queued++;
    }
    for (const [id, view] of this.vehicles) if (!seen.has(id)) { this.vehicles.delete(id); this.trafficGrid.remove(view); this.fleet++; }
    this.trafficSpeed = speed;
    this.trafficQueued = queued;
    this.trafficSlack = slack;
    // The parked cars between two poses are the moved ones, still settling.
    let parkedSlack = 0;
    for (const view of this.settling) {
      const fr = view.frames;
      if (!fr.jump) parkedSlack = Math.max(parkedSlack, Math.abs(fr.x - fr.bx), Math.abs(fr.y - fr.by));
    }
    this.parkedSlack = parkedSlack;
    // The people: their numbers from the slot, what they carry from the message (kept from the last time it changed).
    const pedRich = new Map(message.peds);
    const m = data[h + H.peds]!;
    const pb = pedBase(slot);
    this.pedViews.length = 0;
    const pedSeen = new Set<number>();
    for (let k = 0; k < m; k++) {
      const at = pb + k * PED_STRIDE;
      const id = data[at + P.id]!;
      const r = pedRich.get(id);
      let view = this.pedById.get(id);
      if (!view || r) {
        const base = r ?? view;
        if (!base) continue;
        const { id: _i, x: _x, y: _y, heading: _h, prev: _p, v: _v, turnV: _t, age: _a, segment: _s, walking: _w, kerbWait: _k, rank: _r, ...carried } = base as PedView;
        view = { ...carried, id, x: 0, y: 0, heading: 0, prev: { x: 0, y: 0, heading: 0 }, v: 0, turnV: 0, age: 0, segment: undefined, walking: false, kerbWait: 0, rank: 0 } as PedView;
        this.pedById.set(id, view);
      }
      const w = view as { -readonly [K in keyof PedView]: PedView[K] };
      w.x = data[at + P.x]!; w.y = data[at + P.y]!; w.heading = data[at + P.heading]!;
      const prev = view.prev as { x: number; y: number; heading: number };
      prev.x = data[at + P.px]!; prev.y = data[at + P.py]!; prev.heading = data[at + P.pheading]!;
      w.v = data[at + P.v]!; w.turnV = data[at + P.turnV]!; w.age = data[at + P.age]!;
      const segment = data[at + P.segment]!;
      w.segment = segment < 0 ? undefined : segment as SegmentId;
      w.walking = data[at + P.walking] === 1; w.kerbWait = data[at + P.kerbWait]!; w.rank = data[at + P.rank]!;
      this.pedViews.push(view);
      pedSeen.add(id);
    }
    for (const id of this.pedById.keys()) if (!pedSeen.has(id)) this.pedById.delete(id);
    Atomics.store(this.control, C.reading, -1);
    this.trains = message.trains;
    this.tick++;
    if (message.wounds.length) this.wounds.push(...message.wounds);
    if (message.casualties.length) this.casualtyList.push(...message.casualties);
    this.stats = message.stats;
    if (message.stats.issues.length) this.issues.push(...message.stats.issues);
    if (this.issues.length > 512) this.issues.splice(0, this.issues.length - 512);
    if (message.layout) {
      if (message.layout.all) { this.layouts.clear(); this.lights.clear(); this.signalJunctions.junctions.clear(); }
      for (const l of message.layout.junctions) {
        if (l.groups.length) { this.layouts.set(l.node, l); this.signalJunctions.junctions.set(l.node, { signalised: true, groups: l.groups }); }
        else { this.layouts.delete(l.node); this.lights.delete(l.node); this.signalJunctions.junctions.delete(l.node); }
        this.signalLog.push(l.node);
      }
      // Every junction told again: a reader of before places them all again (`changesSince` null).
      if (message.layout.all) this.signalAll = this.signalBase + this.signalLog.length;
      if (this.signalLog.length > 4096) { this.signalBase += this.signalLog.length; this.signalLog.length = 0; this.signalAll = this.signalBase; }
    }
    for (const s of message.signals) this.lights.set(s.node, { stage: s.stage, states: new Map(s.states) });
    this.onTick?.();
  }

  private clearViews(): void {
    this.vehicles.clear();
    this.traffic.length = 0;
    this.trafficGrid.clear();
    this.trafficSlack = 0;
    this.trafficSpeed = 0;
    this.trafficQueued = 0;
    this.clearParked();
    this.pedViews.length = 0;
    this.pedById.clear();
    this.layouts.clear();
    this.lights.clear();
    this.signalJunctions.junctions.clear();
    this.signalBase += this.signalLog.length;
    this.signalLog.length = 0;
    this.signalAll = this.signalBase;
  }
}

function newView(id: number): VehicleView {
  return {
    id, archetype: archetypeById('car'), color: '#888888', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0, prev: { v: 0 },
    free: null, frames: { bx: 0, by: 0, bangle: 0, x: 0, y: 0, angle: 0, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0,
  };
}

function setFrames(f: VehicleFrames, bx: number, by: number, bangle: number, x: number, y: number, angle: number): void {
  f.bx = bx; f.by = by; f.bangle = bangle; f.x = x; f.y = y; f.angle = angle; f.yawBefore = 0; f.yawNow = 0; f.jump = false;
}

/** A record of the map by its part, for the worker's copy (never a building's: `buildingChangesOf`). */
function recordOf(doc: RoadDoc, part: RecordPart, id: number): unknown {
  switch (part) {
    case 'nodes': return doc.nodes.get(id as NodeId);
    case 'segments': return doc.segments.get(id as SegmentId);
    case 'lots': return doc.lotStore.get(id);
    default: return undefined;
  }
}
