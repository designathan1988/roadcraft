import { readDerivedSome, writeDerivedMany } from '@core/derivedCache';
import { RoadDoc } from '@world/doc';
import { Network, type NetworkBake } from '@world/network';
import { type LotPlan, planLots } from '@world/lots';
import type { NodeId } from '@world/ids';
import { SimWorld, issuesSince } from '../world';
import { TrafficBuildingTable, type TrafficMap, takeTrafficMap, trafficChangesOf } from '../agents/trafficBuildings';
import { step } from '../pipeline';
import { Meso } from '../meso/meso';
import { MesoMemory } from '../meso/memory';
import { laneGrid } from '../agents/laneGrid';
import { useBayWorkers } from '../agents/parking';
import { BayPool } from '../../bayPool';
import { ConflictPool } from '../../conflictPool';
import { TopologyCatchUp } from '../topologyCatchUp';
import { PopulationGovernor } from '../populationGovernor';
import { type VehicleFrames, vehicleFramesInto } from '../pose';
import { WheelOdometer, indicatorSide, pathCurvature } from '../vehicleSignals';
import { signalStateFor } from '../signals/query';
import type { SignalController } from '../signals/fsm';
import { strandVehicle, type Vehicle } from '../vehicles/state';
import { ARCHETYPES } from '../vehicles/archetypes';
import { answer } from './simAnswers';
import { type Casualty, impactCasualties, takeWounds } from '../people/casualties';
import type { PedView } from '../people/view';
import {
  C, H, MAX_PEDS, MAX_VEHICLES, P, PED_STRIDE, V, VEHICLE_STRIDE, headBase, pedBase, vehicleBase,
  PARKED_STRIDE, PK, type FromSim, type ParkedChanges, type SimStats, type PedRich, type SignalLayout, type SignalLights, type SimAct, type SimAsk, type SimControls, type ToSim, type VehicleRich,
} from './protocol';

/** THE SIMULATION IN ITS OWN THREAD: the page sends the map's changes and the player's controls, the worker steps the city */

/** Most milliseconds of steps a frame: the worker's own core, a frame's time at 60 Hz (the page's share is gone). */
const STEP_BUDGET_MS = 14;

export class SimHost {
  /** The worker's copy of the map: the roads, the lots, the transit (no building records: `buildings`). */
  private doc = new RoadDoc();
  private net = new Network(this.doc);
  /** The buildings as traffic reads them, by the world's cells, written in the copy's diary. */
  private readonly buildings = new TrafficBuildingTable(this.doc.changes);
  private sim: SimWorld | null = null;
  /** The meso traffic and its micro window: made before the world, so a window told early is kept for it. */
  private readonly meso = new Meso();
  private topology: TopologyCatchUp | null = null;
  /** The page's job lanes for the bays and the conflict pairs (`lanes`, before `init`), and the pools made on them. */
  private lanes: { readonly bays: readonly MessagePort[]; readonly conflicts: readonly MessagePort[] } | null = null;
  private bayPool: BayPool | null = null;
  private conflictPool: ConflictPool | null = null;
  private readonly governor = new PopulationGovernor(1);
  private data: Float64Array | null = null;
  private control: Int32Array | null = null;
  private tick = 0;
  /** What each vehicle and person was last told with (`VehicleRich`, `PedRich`), by id: told again only when it changes. */
  private readonly vehicleSent = new Map<number, ToldVehicle>();
  private readonly pedSent = new Map<number, ToldPed>();
  /** The frames published so far: what each vehicle and person told was last written in (`ToldVehicle.seen`). */
  private published = 0;
  /** The junctions whose signal was stepped since the last frame (`SimWorld.takeSignalsStepped`), a list kept for it. */
  private readonly stepped: NodeId[] = [];
  private readonly odometer = new WheelOdometer();
  private readonly frames: VehicleFrames = { bx: 0, by: 0, bangle: 0, x: 0, y: 0, angle: 0, yawBefore: 0, yawNow: 0, jump: false };
  /** The signals' log read so far (`SimWorld.signalChangesSince`), and each junction's lights as last told. */
  private signalSerial = -1;
  private readonly lightsSent = new Map<NodeId, string>();
  private readonly plans = new WeakMap<object, number>();
  private planSerial = 0;
  private parkedSerial = -1;
  private issuesSent = 0;
  private measuredDue = 0;
  /** Where the conflict zones measured are kept for the next session (`init`); null: not kept. */
  private zonesPrefix: string | null = null;
  /** The casualties already told (the page keeps their clocks). */
  private readonly casualtiesSent = new WeakSet<Casualty>();

  /** A time of day the page asked for before the city could take it (`SimControls.clock`). */
  private clockAsked: number | null = null;

  constructor(private readonly post: (message: FromSim, transfer?: Transferable[]) => void) {}

  async handle(message: ToSim): Promise<void> {
    switch (message.type) {
      case 'init':
        this.meso.setLive(message.live);
        await this.init(message.map, message.seed, message.zones, message.frames.data, message.frames.control, message.zonesPrefix, message.ambient, message.bake ?? null);
        return;
      case 'load': this.meso.setLive(message.live); this.load(message.map, message.bake ?? null); return;
      // The replica made the map again by its differences (`RoadDoc.replaceWith`): the frame rebuilds what moved, the vehicles drive on (rebound where their lanes went).
      case 'resync': this.meso.setLive(message.live); takeTrafficMap(this.doc, this.buildings, message.map); return;
      case 'lanes': this.lanes = { bays: message.bays, conflicts: message.conflicts }; return;
      case 'laneLost': (message.service === 'bays' ? this.bayPool : this.conflictPool)?.lanesLost(message.why); return;
      case 'delta':
        this.doc.restore(message.delta);
        this.buildings.apply(trafficChangesOf(message.buildings));
        return;
      case 'reset': this.sim?.reset(); this.sim?.ambient.reset(this.sim); return;
      case 'window':
        this.meso.attach(new MesoMemory(message.meso));
        this.meso.want(message.x, message.y, message.r);
        return;
      case 'frame': this.frame(message.wall, message.hold, message.controls); return;
      case 'act': this.post({ type: 'acted', id: message.id, result: this.act(message.act) }); return;
      case 'ask': this.post({ type: 'answer', id: message.id, answer: this.ask(message.ask) }); return;
      case 'lotPlan': this.post({ type: 'answer', id: message.id, answer: this.lotPlan() }); return;
    }
  }

  private async init(map: TrafficMap, seed: number, zones: ReadonlyMap<string, Float64Array | null>, data: SharedArrayBuffer, control: SharedArrayBuffer,
    prefix: string | null, ambient: 'view' | 'edges', bake: NetworkBake | null): Promise<void> {
    this.data = new Float64Array(data);
    this.control = new Int32Array(control);
    takeTrafficMap(this.doc, this.buildings, map);
    // The page's junctions and ribbons, taken where their inputs are this copy's: DO NOT solve the whole map's junctions again (SIM-04).
    if (bake) this.net.offerBake(bake);
    this.net.rebuild({ full: true });
    const sim = new SimWorld(this.doc, this.net, seed, this.buildings);
    // Conflicts only where traffic is (the micro window), not every junction of the map.
    sim.useMicroWindow();
    // On the page's lanes when it handed them: DO NOT open a pool in this worker (`jobPool.ts` jobChannel).
    this.bayPool = new BayPool(this.lanes?.bays.length ? this.lanes.bays : null);
    useBayWorkers(sim, this.bayPool);
    sim.auditEnabled = true;
    sim.auditLevel = 'cheap';
    sim.auditEvery = 60;
    sim.conflicts.seed(zones);
    // The zones kept in earlier sessions read by the pairs a build needs (`ConflictIndex.lookup`), never all at the start.
    if (prefix) sim.conflicts.lookup = (keys) => readDerivedSome<Float64Array | null>(prefix, keys);
    this.zonesPrefix = prefix;
    sim.usePedestrianEngine((await import('../agents/walk')).createAgentWalkEngine());
    sim.followCity = true;
    sim.ambient.enabled = true;
    sim.ambient.source = ambient;
    // The whole map's traffic in the meso model; the micro simulation only in its window round the view (`meso/meso.ts`).
    sim.meso = this.meso;
    this.sim = sim;
    this.conflictPool = new ConflictPool(prefix, this.lanes?.conflicts.length ? this.lanes.conflicts : null);
    this.topology = new TopologyCatchUp(this.conflictPool);
    this.post({ type: 'ready' });
  }

  /** Another map: the replica made whole again, and nothing of the old simulation carried over. */
  private load(map: TrafficMap, bake: NetworkBake | null): void {
    takeTrafficMap(this.doc, this.buildings, map);
    if (bake) this.net.offerBake(bake);
    this.net.rebuild({ full: true });
    this.sim?.reset();
    if (this.sim) this.sim.ambient.reset(this.sim);
    this.vehicleSent.clear();
    this.pedSent.clear();
    this.lightsSent.clear();
    this.signalSerial = -1;
    this.parkedSerial = -1;
  }

  /** One frame of the page: the topology brought up, the city stepped by the wall time, the frame written for the page. */
  private frame(wall: number, hold: boolean, controls: SimControls): void {
    if (controls.clock !== undefined) this.clockAsked = controls.clock;
    const sim = this.sim;
    if (!sim || !this.topology) return;
    // The time of day asked for, put once the city is there to take it.
    if (this.clockAsked !== null) { sim.city.setMinutes(sim, this.clockAsked); this.clockAsked = null; }
    sim.clock.speed = controls.speed;
    sim.clock.paused = controls.paused;
    sim.trafficIntensity = controls.trafficIntensity;
    sim.pedestrianIntensity = controls.pedestrianIntensity;
    sim.demandMultiplier = controls.demandMultiplier;
    if (controls.focus) sim.focus = controls.focus;
    this.governor.setMax(controls.maxShare);
    if (controls.startShare !== undefined) this.governor.start(controls.startShare);
    if (this.net.revision !== this.doc.revision) this.net.rebuild();
    const held = hold;
    // DO NOT stop the clock while a tile's topology is prepared (its lanes, turns and conflict pairs, on the workers): the city runs on the graph it has meanwhile, and takes the new one when it is ready.
    const catching = this.topology.step(sim, this.net.trafficRevision, false);
    if (!catching) this.topology.stepWindow(sim, this.net.trafficRevision);
    sim.topologyDeferred = catching;
    let alpha = 1;
    if (!held) {
      sim.walkwaysNow();
      laneGrid(sim);
      const topology = sim.topologyRevision;
      alpha = sim.clock.advance(wall, () => step(sim, { traffic: controls.traffic, pedestrians: controls.pedestrians }), STEP_BUDGET_MS);
      // DO NOT count a frame whose steps built the topology again (a tile came or went): walking the city thinned its streets to 30%.
      if (sim.topologyRevision === topology) sim.populationShare = this.governor.feed(sim.clock.lastSteps, sim.clock.lastStepMs, performance.now() / 1000, sim.vehicles.size, sim.pedViews.length);
    }
    // The blows' casualties aged by the wall time (the page keeps its own clocks of those it was told).
    impactCasualties(sim, wall);
    this.publish(alpha);
  }

  /** The frame written into the slot neither the page reads nor was written last (a triple buffer), then made the latest. */
  private publish(alpha: number): void {
    const sim = this.sim!, data = this.data!, control = this.control!;
    const latest = Atomics.load(control, C.latest), reading = Atomics.load(control, C.reading);
    let slot = 0;
    while (slot === latest || slot === reading) slot++;
    const vehicles: [number, VehicleRich][] = [];
    const peds: [number, PedRich][] = [];
    const frame = ++this.published;
    let n = 0;
    const vb = vehicleBase(slot);
    const writeVehicle = (v: Vehicle, parked: boolean): void => {
      if (n >= MAX_VEHICLES || !vehicleFramesInto(sim, v, this.frames)) return;
      const f = this.frames, at = vb + n * VEHICLE_STRIDE;
      const lane = v.free ? undefined : sim.lanelet(v.lanelet);
      data[at + V.id] = v.id;
      data[at + V.free] = parked ? 2 : v.free ? 1 : 0;
      data[at + V.bx] = f.bx; data[at + V.by] = f.by; data[at + V.bangle] = f.bangle;
      data[at + V.x] = f.x; data[at + V.y] = f.y; data[at + V.angle] = f.angle;
      data[at + V.yawBefore] = f.yawBefore; data[at + V.yawNow] = f.yawNow; data[at + V.jump] = f.jump ? 1 : 0;
      data[at + V.v] = v.v; data[at + V.prevV] = v.prev.v; data[at + V.age] = v.age;
      data[at + V.segment] = lane?.segment ?? -1;
      data[at + V.inSegment] = lane?.segment ?? (lane ? sim.connector(lane.id)?.inSegment ?? -1 : -1);
      data[at + V.indicator] = v.free ? 0 : indicatorSide(sim, v);
      data[at + V.curvature] = v.free ? 0 : pathCurvature(sim, v);
      data[at + V.odometer] = this.odometer.advance(v);
      data[at + V.seats] = v.seats;
      data[at + V.slain] = v.slain ? 1 : 0;
      data[at + V.lot] = v.free?.lot ?? -1;
      n++;
      // Doors and a kerb stop move every tick while they last: told each tick then. DO NOT make a key a vehicle a frame to compare.
      const busy = v.doors.length > 0 || v.kerbStop !== null;
      const was = this.vehicleSent.get(v.id);
      if (was && !busy && !was.busy && was.color === v.color && was.archetype === v.archetype.id && sameList(was.people, v.people) && sameList(was.peopleAge, v.peopleAge)) {
        was.seen = frame;
        return;
      }
      // The kerb stop as it is: posted below in this same call, the message copies it (DO NOT copy it a second time, a vehicle a frame).
      const rich: VehicleRich = { color: v.color, archetype: v.archetype.id, doors: v.doors.slice(), kerbStop: v.kerbStop,
        people: v.people.slice(), peopleAge: v.peopleAge.slice(), freeLot: v.free?.lot ?? null };
      this.vehicleSent.set(v.id, { color: rich.color, archetype: rich.archetype, busy, people: rich.people, peopleAge: rich.peopleAge, seen: frame });
      vehicles.push([v.id, rich]);
    };
    for (const v of sim.vehiclesInIdOrder()) writeVehicle(v, false);
    // The parked cars that moved this tick (driven in or out of a bay): only the movers can (the scenery's rows stand); those standing are told once (`parked`).
    for (const v of sim.ambient.movers) {
      const f = v.free;
      if (f && (f.px !== f.x || f.py !== f.y || f.pangle !== f.angle)) writeVehicle(v, true);
    }
    for (const [id, told] of this.vehicleSent) if (told.seen !== frame) this.vehicleSent.delete(id);
    let m = 0;
    const pb = pedBase(slot);
    for (const p of sim.pedViews) {
      if (m >= MAX_PEDS) break;
      const at = pb + m * PED_STRIDE;
      data[at + P.id] = p.id; data[at + P.x] = p.x; data[at + P.y] = p.y; data[at + P.heading] = p.heading;
      data[at + P.px] = p.prev.x; data[at + P.py] = p.prev.y; data[at + P.pheading] = p.prev.heading;
      data[at + P.v] = p.v; data[at + P.turnV] = p.turnV; data[at + P.age] = p.age;
      data[at + P.segment] = p.segment ?? -1; data[at + P.walking] = p.walking ? 1 : 0; data[at + P.kerbWait] = p.kerbWait; data[at + P.rank] = p.rank;
      m++;
      // DO NOT make a key a person a frame to compare: the fields read against what was told, a key made only when one changed.
      const was = this.pedSent.get(p.id);
      if (was && !pedDiffers(p, was.key)) { was.seen = frame; continue; }
      this.pedSent.set(p.id, { key: pedRichKey(p), seen: frame });
      peds.push([p.id, pedRich(p)]);
    }
    for (const [id, told] of this.pedSent) if (told.seen !== frame) this.pedSent.delete(id);
    const h = headBase(slot);
    data[h + H.tick] = ++this.tick; data[h + H.time] = sim.clock.time; data[h + H.vehicles] = n; data[h + H.peds] = m;
    data[h + H.alpha] = alpha; data[h + H.steps] = sim.clock.lastSteps; data[h + H.stepMs] = sim.clock.lastStepMs; data[h + H.minutes] = sim.city.minutes(sim);
    Atomics.store(control, C.latest, slot);
    const parked = this.parked();
    this.post({
      type: 'tick', slot, vehicles, peds, ...this.signals(), trains: sim.city.transit.trains().map((t) => ({ colour: t.colour, metro: t.metro, cars: t.cars })),
      parked, stats: this.stats(), wounds: takeWounds(sim),
      casualties: impactCasualties(sim, 0).filter((c) => !this.casualtiesSent.has(c) && (this.casualtiesSent.add(c), true)),
    }, parked ? [parked.cars.buffer] : undefined);
  }

  /** The junctions whose heads moved (the signals' log) and those whose lights changed since the last frame. */
  private signals(): { layout: { all: boolean; junctions: SignalLayout[] } | null; signals: SignalLights[] } {
    const sim = this.sim!;
    const log = sim.signalChangesSince(this.signalSerial);
    this.signalSerial = log.serial;
    const layoutOf = (node: NodeId): SignalLayout => {
      const junction = sim.graph.junctions.get(node);
      const live = junction?.signalised && sim.controller(node);
      return { node, groups: live ? junction.groups.map((g) => ({ id: g.id, segments: [...g.segments] })) : [] };
    };
    const layout = log.nodes === null ? { all: true, junctions: sim.junctionNodesInOrder().map(layoutOf) }
      : log.nodes.length ? { all: false, junctions: [...new Set(log.nodes)].map(layoutOf) } : null;
    const signals: SignalLights[] = [];
    const tell = (node: NodeId, controller: SignalController): void => {
      const stage = `${this.planId(controller)}|${controller.stageIndex}|${controller.sub}`;
      if (this.lightsSent.get(node) === stage) return;
      this.lightsSent.set(node, stage);
      const junction = sim.graph.junctions.get(node);
      signals.push({ node, stage, states: (junction?.groups ?? []).map((g) => [g.id, signalStateFor(controller, g.id)] as const) });
    };
    // DO NOT read every junction's lights a frame: a light changes only where a signal was stepped or planned again (the signals' log).
    const stepped = sim.takeSignalsStepped(this.stepped);
    if (log.nodes === null) {
      this.lightsSent.clear();
      this.tellEvery(tell);
      return { layout, signals };
    }
    for (const list of [log.nodes, stepped]) {
      for (const node of list) {
        const controller = sim.controller(node);
        // A junction whose control went (its tile let go, its roads gone): its lights forgotten with it.
        if (controller) tell(node, controller); else this.lightsSent.delete(node);
      }
    }
    return { layout, signals };
  }

  /** @rebuild Every junction's lights told: the first frame, another map, or the signals' log forgotten. */
  private tellEvery(tell: (node: NodeId, controller: SignalController) => void): void {
    for (const [node, controller] of this.sim!.controllers) tell(node, controller);
  }

  private planId(c: SignalController): number {
    let id = this.plans.get(c.plan);
    if (id === undefined) this.plans.set(c.plan, id = ++this.planSerial);
    return id;
  }

  /** The cars come into a bay or gone from one since the last frame, each once as it stands now; null when nothing changed (every car standing, when the log was let go for this reader). */
  private parked(): ParkedChanges | null {
    const sim = this.sim!;
    const changes = sim.ambient.parkedSince(this.parkedSerial, this);
    const serial = sim.ambient.parkedSerialNow();
    if (changes !== null && changes.length === 0) return null;
    this.parkedSerial = serial;
    const whole = changes === null;
    // DO NOT tell a car once per entry: a bay's source stood again logs each of its cars out and in.
    const cars = whole ? sim.ambient.parked : [...new Set(changes.map((c) => c.car))];
    const out = new Float64Array(cars.length * PARKED_STRIDE);
    cars.forEach((car, k) => {
      const at = k * PARKED_STRIDE, f = car.free;
      out[at + PK.id] = car.id;
      out[at + PK.gone] = (whole || sim.ambient.isParked(car)) && f ? 0 : 1;
      out[at + PK.x] = f?.x ?? 0; out[at + PK.y] = f?.y ?? 0; out[at + PK.angle] = f?.angle ?? 0;
      out[at + PK.lot] = f?.lot ?? -1;
      out[at + PK.archetype] = archetypeIndex(car.archetype.id);
      out[at + PK.color] = parseInt(car.color.slice(1), 16);
    });
    return { whole, cars: out };
  }

  private stats(): SimStats {
    const sim = this.sim!;
    // The issues reported since the last frame, the last of them still kept (the list keeps 512).
    const issues = issuesSince(sim, this.issuesSent).map((i) => ({ code: i.code, subject: String(i.subject), detail: String(i.detail), tick: i.tick }));
    this.issuesSent = sim.issuesReported;
    // The zones measured since kept for the next session from here, as the conflicts' workers keep theirs: DO NOT pass them through the page to the store.
    if (++this.measuredDue % 300 === 0 && this.zonesPrefix) writeDerivedMany(this.zonesPrefix, sim.conflicts.takeMeasured());
    const measured: SimStats['measured'] = [];
    return {
      vehicles: sim.vehicles.size, people: sim.pedViews.length, completedTrips: sim.completedTrips, entryDemandLost: sim.entryDemandLost,
      controllers: sim.controllers.size, lotsMoving: sim.city.lots.moving(), topologyRevision: sim.topologyRevision, issues,
      populationShare: this.governor.share, stepMs: this.governor.stepMs, measured,
    };
  }

  /** The player's hand: a shot, a blow, a vehicle taken away; what the simulation answers. */
  private act(act: SimAct): unknown {
    const sim = this.sim;
    if (!sim) return null;
    switch (act.kind) {
      case 'shot': return sim.pedEngine.shot?.(sim, act.ped, act.part, act.fromX, act.fromY) ?? null;
      case 'impact': return sim.pedEngine.impact?.(sim, act.x, act.y, act.kill, act.scare) ?? 0;
      case 'removeVehicle': {
        const v = sim.vehicles.get(act.id as never);
        if (v) sim.removeVehicle(v);
        return v ? 1 : 0;
      }
      case 'strand': {
        const v = sim.vehicles.get(act.id as never);
        if (v) strandVehicle(v);
        return v ? 1 : 0;
      }
      case 'getUp': sim.pedEngine.getUp?.(sim, act.id, act.x, act.y, act.heading, act.seconds, act.crawl); return null;
      case 'removeVehiclesNear': {
        let n = 0;
        for (const v of [...sim.vehicles.values()]) {
          const f = v.free ?? null;
          const frames = this.frames;
          if (!f && !vehicleFramesInto(sim, v, frames)) continue;
          const x = f ? f.x : frames.x, y = f ? f.y : frames.y;
          if (Math.hypot(x - act.x, y - act.y) > act.r) continue;
          sim.removeVehicle(v);
          n++;
        }
        return n;
      }
    }
  }

  /** THE ZONING TOOL'S PROPOSAL (`editor/lotTool.ts`): the land along the streets cut into lots on this copy of the region, which the page's diary keeps as the page has it (sent before the question, `SimClient.lotPlan`) - planned again only where the roads and the lots changed (`world/lots.ts` LotPlanner, one for this network), DO NOT plan it on the page. Null while a tile's network is being read (its junctions would be solved here): asked again. */
  private lotPlan(): LotPlan | null {
    if (!this.sim) return null;
    // Brought up to the diary sent before the question (nothing to do when the frame built it: the build reads what changed).
    this.net.rebuild();
    return planLots(this.doc, this.net);
  }

  /** The panels' questions, answered off the simulation as it stands (`simAnswers.ts`). */
  private ask(ask: SimAsk): unknown {
    const sim = this.sim;
    if (!sim) return null;
    return answer(sim, this.doc, this.net, ask);
  }
}

/** What a vehicle was last told with (`VehicleRich`), and the frame it was last written in. */
interface ToldVehicle {
  readonly color: string;
  readonly archetype: string;
  /** Doors open or a kerb stop under way: told each frame while they last, and once after. */
  readonly busy: boolean;
  readonly people: readonly number[];
  readonly peopleAge: readonly unknown[];
  seen: number;
}

/** What a person was last told with (`pedRichKey`), and the frame it was last written in. */
interface ToldPed {
  readonly key: readonly unknown[];
  seen: number;
}

/** Two lists the same, item by item. */
function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** What a person is told with, by reference: told again when any of these changes. */
const PED_RICH = ['panic', 'maimed', 'lost', 'bleeding', 'wound', 'style', 'hand', 'carry', 'ageClass', 'gender', 'party', 'ground', 'stretch', 'waitingFor', 'gesture'] as const satisfies readonly (keyof PedView)[];

function pedRichKey(p: PedView): readonly unknown[] {
  return PED_RICH.map((field) => p[field]);
}

/** Whether a person differs from its key (`pedRichKey`), field by field, with no key made. */
function pedDiffers(p: PedView, key: readonly unknown[]): boolean {
  for (let i = 0; i < PED_RICH.length; i++) if (p[PED_RICH[i]!] !== key[i]) return true;
  return false;
}

/** DO NOT copy it a second time: posted in the same call (`publish`), the message copies it. */
function pedRich(p: PedView): PedRich {
  const { id: _id, x: _x, y: _y, heading: _h, prev: _p, v: _v, turnV: _t, age: _a, segment: _s, walking: _w, kerbWait: _k, rank: _r, ...rich } = p;
  return rich;
}

/** Each kind of vehicle's place in `ARCHETYPES`, as the parked cars' numbers carry it (`PK.archetype`). */
const ARCHETYPE_AT = new Map(ARCHETYPES.map((a, k) => [a.id, k]));
function archetypeIndex(id: string): number {
  return ARCHETYPE_AT.get(id) ?? 1;
}
