import { readDerivedSome } from '@core/derivedCache';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { NodeId } from '@world/ids';
import { SimWorld } from '../world';
import { TrafficBuildingTable, type TrafficMap, takeTrafficMap } from '../agents/trafficBuildings';
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
import { answer } from './simAnswers';
import { type Casualty, impactCasualties, takeWounds } from '../people/casualties';
import type { PedView } from '../people/view';
import {
  C, H, MAX_PEDS, MAX_VEHICLES, P, PED_STRIDE, V, VEHICLE_STRIDE, headBase, pedBase, vehicleBase,
  type FromSim, type ParkedCar, type SimStats, type PedRich, type SignalLayout, type SignalLights, type SimAct, type SimAsk, type SimControls, type ToSim, type VehicleRich,
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
  private readonly governor = new PopulationGovernor(1);
  private data: Float64Array | null = null;
  private control: Int32Array | null = null;
  private tick = 0;
  /** What each vehicle and person was last told with (`VehicleRich`, `PedRich`), by id: told again only when it changes. */
  private readonly vehicleSent = new Map<number, readonly unknown[]>();
  private readonly pedSent = new Map<number, readonly unknown[]>();
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
  /** The casualties already told (the page keeps their clocks). */
  private readonly casualtiesSent = new WeakSet<Casualty>();

  constructor(private readonly post: (message: FromSim) => void) {}

  async handle(message: ToSim): Promise<void> {
    switch (message.type) {
      case 'init': await this.init(message.map, message.seed, message.zones, message.frames.data, message.frames.control, message.zonesPrefix, message.ambient); return;
      case 'load': this.load(message.map); return;
      case 'delta':
        this.doc.restore(message.delta);
        this.buildings.apply(message.buildings);
        return;
      case 'reset': this.sim?.reset(); this.sim?.ambient.reset(this.sim); return;
      case 'window':
        this.meso.attach(new MesoMemory(message.meso));
        this.meso.want(message.x, message.y, message.r);
        return;
      case 'frame': this.frame(message.wall, message.hold, message.controls); return;
      case 'act': this.post({ type: 'acted', id: message.id, result: this.act(message.act) }); return;
      case 'ask': this.post({ type: 'answer', id: message.id, answer: this.ask(message.ask) }); return;
    }
  }

  private async init(map: TrafficMap, seed: number, zones: ReadonlyMap<string, Float64Array | null>, data: SharedArrayBuffer, control: SharedArrayBuffer,
    prefix: string | null, ambient: 'view' | 'edges'): Promise<void> {
    this.data = new Float64Array(data);
    this.control = new Int32Array(control);
    takeTrafficMap(this.doc, this.buildings, map);
    this.net.rebuild({ full: true });
    const sim = new SimWorld(this.doc, this.net, seed, this.buildings);
    // Conflicts only where traffic is (the micro window), not every junction of the map.
    sim.useMicroWindow();
    useBayWorkers(sim, new BayPool());
    sim.auditEnabled = true;
    sim.auditLevel = 'cheap';
    sim.auditEvery = 60;
    sim.conflicts.seed(zones);
    // The zones kept in earlier sessions read by the pairs a build needs (`ConflictIndex.lookup`), never all at the start.
    if (prefix) sim.conflicts.lookup = (keys) => readDerivedSome<Float64Array | null>(prefix, keys);
    sim.usePedestrianEngine((await import('../agents/walk')).createAgentWalkEngine());
    sim.followCity = true;
    sim.ambient.enabled = true;
    sim.ambient.source = ambient;
    // The whole map's traffic in the meso model; the micro simulation only in its window round the view (`meso/meso.ts`).
    sim.meso = this.meso;
    this.sim = sim;
    this.topology = new TopologyCatchUp(new ConflictPool(prefix));
    this.post({ type: 'ready' });
  }

  /** Another map: the replica made whole again, and nothing of the old simulation carried over. */
  private load(map: TrafficMap): void {
    takeTrafficMap(this.doc, this.buildings, map);
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
    const sim = this.sim;
    if (!sim || !this.topology) return;
    sim.clock.speed = controls.speed;
    sim.clock.paused = controls.paused;
    sim.trafficIntensity = controls.trafficIntensity;
    sim.pedestrianIntensity = controls.pedestrianIntensity;
    sim.demandMultiplier = controls.demandMultiplier;
    if (controls.focus) sim.focus = controls.focus;
    this.governor.setMax(controls.maxShare);
    if (this.net.revision !== this.doc.revision) this.net.rebuild();
    let held = hold;
    if (this.topology.step(sim, this.net.trafficRevision, false)) held = true;
    else this.topology.stepWindow(sim, this.net.trafficRevision);
    let alpha = 1;
    if (!held) {
      sim.walkwaysNow();
      laneGrid(sim);
      alpha = sim.clock.advance(wall, () => step(sim, { traffic: controls.traffic, pedestrians: controls.pedestrians }), STEP_BUDGET_MS);
      sim.populationShare = this.governor.feed(sim.clock.lastSteps, sim.clock.lastStepMs, performance.now() / 1000, sim.vehicles.size, sim.pedViews.length);
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
    let n = 0;
    const vb = vehicleBase(slot);
    const seen = new Set<number>();
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
      seen.add(v.id);
      const now = [v.color, v.archetype.id, v.doors.length ? [...v.doors] : null, v.kerbStop ? { ...v.kerbStop } : null, v.people.length, v.people.join(','), v.peopleAge.join(',')];
      const was = this.vehicleSent.get(v.id);
      // Doors and a kerb stop move every tick while they last: told each tick then.
      if (!was || now[2] !== null || now[3] !== null || was[2] !== null || was[3] !== null || now.some((x, i) => i !== 2 && i !== 3 && x !== was[i])) {
        this.vehicleSent.set(v.id, now);
        vehicles.push([v.id, { color: v.color, archetype: v.archetype.id, doors: v.doors.slice(), kerbStop: v.kerbStop ? structuredClone(v.kerbStop) : null,
          people: v.people.slice(), peopleAge: v.peopleAge.slice(), freeLot: v.free?.lot ?? null }]);
      }
    };
    for (const v of sim.vehiclesInIdOrder()) writeVehicle(v, false);
    // The parked cars that moved this tick (driven in or out of a bay); those standing are told once (`parked`).
    for (const v of sim.ambient.parked) {
      const f = v.free;
      if (f && (f.px !== f.x || f.py !== f.y || f.pangle !== f.angle)) writeVehicle(v, true);
    }
    for (const id of this.vehicleSent.keys()) if (!seen.has(id)) this.vehicleSent.delete(id);
    let m = 0;
    const pb = pedBase(slot);
    const pedSeen = new Set<number>();
    for (const p of sim.pedViews) {
      if (m >= MAX_PEDS) break;
      const at = pb + m * PED_STRIDE;
      data[at + P.id] = p.id; data[at + P.x] = p.x; data[at + P.y] = p.y; data[at + P.heading] = p.heading;
      data[at + P.px] = p.prev.x; data[at + P.py] = p.prev.y; data[at + P.pheading] = p.prev.heading;
      data[at + P.v] = p.v; data[at + P.turnV] = p.turnV; data[at + P.age] = p.age;
      data[at + P.segment] = p.segment ?? -1; data[at + P.walking] = p.walking ? 1 : 0; data[at + P.kerbWait] = p.kerbWait; data[at + P.rank] = p.rank;
      m++;
      pedSeen.add(p.id);
      const now = pedRichKey(p);
      const was = this.pedSent.get(p.id);
      if (!was || now.some((x, i) => x !== was[i])) {
        this.pedSent.set(p.id, now);
        peds.push([p.id, pedRich(p)]);
      }
    }
    for (const id of this.pedSent.keys()) if (!pedSeen.has(id)) this.pedSent.delete(id);
    const h = headBase(slot);
    data[h + H.tick] = ++this.tick; data[h + H.time] = sim.clock.time; data[h + H.vehicles] = n; data[h + H.peds] = m;
    data[h + H.alpha] = alpha; data[h + H.steps] = sim.clock.lastSteps; data[h + H.stepMs] = sim.clock.lastStepMs; data[h + H.minutes] = sim.city.minutes(sim);
    Atomics.store(control, C.latest, slot);
    this.post({
      type: 'tick', slot, vehicles, peds, ...this.signals(), trains: sim.city.transit.trains().map((t) => ({ colour: t.colour, metro: t.metro, cars: t.cars })),
      parked: this.parked(), stats: this.stats(), wounds: takeWounds(sim),
      casualties: impactCasualties(sim, 0).filter((c) => !this.casualtiesSent.has(c) && (this.casualtiesSent.add(c), true)),
    });
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
    if (log.nodes === null) this.lightsSent.clear();
    const signals: SignalLights[] = [];
    for (const [node, controller] of sim.controllers) {
      const stage = `${this.planId(controller)}|${controller.stageIndex}|${controller.sub}`;
      if (this.lightsSent.get(node) === stage) continue;
      this.lightsSent.set(node, stage);
      const junction = sim.graph.junctions.get(node);
      signals.push({ node, stage, states: (junction?.groups ?? []).map((g) => [g.id, signalStateFor(controller, g.id)] as const) });
    }
    return { layout, signals };
  }

  private planId(c: SignalController): number {
    let id = this.plans.get(c.plan);
    if (id === undefined) this.plans.set(c.plan, id = ++this.planSerial);
    return id;
  }

  /** The cars come into a bay or gone from one since the last frame; null when nothing changed (all, when the log was forgotten). */
  private parked(): ParkedCar[] | null {
    const sim = this.sim!;
    const changes = sim.ambient.parkedSince(this.parkedSerial);
    const serial = sim.ambient.parkedSerialNow();
    if (changes !== null && changes.length === 0) return null;
    this.parkedSerial = serial;
    const all = changes === null;
    const cars = all ? sim.ambient.parked : changes.map((c) => c.car);
    return cars.map((car): ParkedCar => {
      const standing = all || sim.ambient.isParked(car);
      const f = car.free;
      return { id: car.id, archetype: car.archetype.id, color: car.color, x: f?.x ?? 0, y: f?.y ?? 0, angle: f?.angle ?? 0, lot: f?.lot ?? null, gone: !standing || !f, whole: all };
    });
  }

  private stats(): SimStats {
    const sim = this.sim!;
    const issues = sim.issues.slice(this.issuesSent).map((i) => ({ code: i.code, subject: String(i.subject), detail: String(i.detail), tick: i.tick }));
    this.issuesSent = sim.issues.length;
    const measured = ++this.measuredDue % 300 === 0 ? [...sim.conflicts.takeMeasured()] : [];
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

  /** The panels' questions, answered off the simulation as it stands (`simAnswers.ts`). */
  private ask(ask: SimAsk): unknown {
    const sim = this.sim;
    if (!sim) return null;
    return answer(sim, this.doc, this.net, ask);
  }
}

/** What a person is told with, by reference: told again when any of these changes. */
function pedRichKey(p: PedView): readonly unknown[] {
  return [p.panic, p.maimed, p.lost, p.bleeding, p.wound, p.style, p.hand, p.carry, p.ageClass, p.gender, p.party, p.ground, p.stretch, p.waitingFor, p.gesture];
}

function pedRich(p: PedView): PedRich {
  const { id: _id, x: _x, y: _y, heading: _h, prev: _p, v: _v, turnV: _t, age: _a, segment: _s, walking: _w, kerbWait: _k, rank: _r, ...rich } = p;
  return structuredClone(rich);
}
