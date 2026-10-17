import { Rng } from '@core/rng';
import { JournalCursor } from '@world/derived';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { type Connector, type GraphChange, type JunctionTopology, type Lanelet, type LaneletId, LaneletGraph } from '@world/lanelets';
import { ChangeLog } from '@core/changeLog';
import { NetworkLength } from '@world/networkLength';
import { LaneGrid, lanesNear } from './agents/laneGrid';
import { LaneReaches } from './routing/laneReach';
import { RouteIndex } from './routing/routeIndex';
import { ConflictIndex, type BodyClass, WAITING } from '@world/conflictPoints';
import { type ChosenTurn, TurnPlan } from '@world/junctionTurns';
import type { PairMeasurer } from '@world/conflictTable';
import { SimClock } from './clock';
import { ClaimTable } from './intersections/claims';
import type { Vehicle, VehicleId } from './vehicles/state';
import { type SignalClock, type SignalController, type SignalDeps, createController, rebuildController, seekFixed } from './signals/fsm';
import { type CrossingId, makeCrossingId } from './signals/plan';
import type { AuditIssue } from './audit';
import { SidewalkGraph } from './peds/sidewalk';
import { SignalPostIndex } from './peds/signalPostIndex';
import { hasDownstreamStorage } from './intersections/spillback';
import { CrossingSpans } from './intersections/crossingSpans';
import { m } from '@world/units';
import { CellFiling } from '@world/cells';
import { vehiclePose } from './pose';
import { DT } from './params';

/** How far before its line a bus asks for priority, world units (V5). */
const BUS_REACH = m(90);
/** The micro simulation's window (`keepMicroWindow`): a junction this near a vehicle has its conflicts; 15 s ahead of a car at 70 km/h. */
const VEHICLE_WINDOW = m(300);
/** The cells the vehicles are gathered by for the window (`keepMicroWindow`): a cell's square reaches `VEHICLE_WINDOW` past it. */
const WINDOW_CELL = m(100);
/** The most of the window round the focus, where the scenery's cars are made (`AmbientWorld.traffic`). */
const FOCUS_WINDOW = m(600);
/** How far a vehicle's pose can lie outside its lane's bounds (`vehiclesNear`): the longest body (its rear axle still on the lane behind) and a lane change's sideways reach. */
const BODY_OFF_LANE = m(20);
/** Seconds of the city's time between moves of the window. */
const WINDOW_EVERY = 0.5;
/** What the filing holds for a junction: its id is the whole of it. */
const JUNCTION_FILED = {};

/** What the signals read of the world (`SignalDeps`), and the reservations by node, which wake a sleeping one (`SimWorld.signalsToStep`). */
export type WorldSignalDeps = SignalDeps & { readonly reserved: () => ReadonlyMap<NodeId, ReadonlySet<number>> };
import type { CrossingStates } from './crossings/state';
import type { PedView } from './people/view';
import type { PedestrianEngine } from './people/engine';
import { City } from './city/city';
import { AmbientWorld } from './ambient/ambient';
import { Walkways, type WalkGraph } from '@world/walkways';
import { mainRoadLegs, type SignalSettings } from '@world/roads/rules';
import { FlowStats } from './roads/flowStats';
import { type AutoControl, ControlAdvisor, QUIET_FLOW } from './roads/controlAdvisor';
import { rebuildWork } from '@world/rebuildWork';
import { type TrafficBuildings, docBuildings } from './agents/trafficBuildings';
/** The body class a signal plan is protected for: an ordinary car. */const CAR_CLASS: BodyClass = 1;

/** Nobody walks until an engine is installed (`SimWorld.usePedestrianEngine`). */
const NO_PEDESTRIANS: PedestrianEngine = {
  kind: 'people',
  beginTick() {}, dispatch() {}, step() {}, rebind() {}, publish() {}, audit() {}, reset() {},
  bridge: { hailable: () => null, board: () => null, alight: () => false, anyoneWithin: () => false },
};

/** A queue is counted this far back from the stop line. */
const DEMAND_QUEUE_REACH = m(80);
/** Moving vehicles are counted when they will arrive within this, seconds. */
const DEMAND_HORIZON = 12;
/** A head this close, or arriving within the passage time, keeps a green alive. */
const DEMAND_AT_LINE = m(8);
const DEMAND_PASSAGE = 3;
/** Seconds of waiting that double a queued vehicle's weight. */
const DEMAND_WAIT_WEIGHT = 30;

/** Vehicles occupying one lanelet, kept sorted by ascending arc position. */
export interface LaneletRuntime {
  readonly id: LaneletId;
  /** Ascending by `s`; index 0 is nearest the entry, last is nearest the exit. */
  order: VehicleId[];
  /** Vehicles whose body still overlaps this lane while they slide out of it. */
  shadows: VehicleId[];
  /** A retired lanelet still carrying agents: no new entries accepted. */
  ghost: boolean;
  /** Tick at which a ghost was created, so it can be force-collected. */
  ghostSince: number;
}

/** The world's random streams, one per consumer, forked by tag so a new consumer reshuffles no other (`core/rng.ts`). */
export interface SimStreams {
  readonly spawnVehicles: Rng;
  readonly spawnPeds: Rng;
  readonly driver: Rng;
  readonly route: Rng;
  readonly gap: Rng;
  readonly pedParams: Rng;
  readonly courtesy: Rng;
  readonly signalOffsets: Rng;
  /** The People engine's own stream (`people/people.ts`). */
  readonly people: Rng;
  readonly occupancy: Rng;
  /** The lots' cars (`agents/lotTraffic.ts`), the lorries (`agents/lorryTraffic.ts`) and the scenery's life (`ambient/ambient.ts`). */
  readonly lots: Rng;
  readonly lorries: Rng;
  readonly ambient: Rng;
  /** The meso traffic's cars made in the micro window (`meso/meso.ts`). */
  readonly meso: Rng;
}

/** The streams of a world seeded `seed`: what a new world starts with, and a reset starts again from. */
function forkStreams(seed: number): SimStreams {
  const root = new Rng(seed);
  return {
    spawnVehicles: root.fork('spawnVehicles'),
    spawnPeds: root.fork('spawnPeds'),
    driver: root.fork('driver'),
    route: root.fork('routeChoice'),
    gap: root.fork('gapAcceptance'),
    pedParams: root.fork('pedParams'),
    courtesy: root.fork('courtesy'),
    signalOffsets: root.fork('signalOffsets'),
    occupancy: root.fork('occupancy'),
    people: root.fork('people'),
    // DO NOT give the lots, the lorries or the scenery a fixed seed of their own again
    lots: root.fork('lots'),
    lorries: root.fork('lorries'),
    ambient: root.fork('ambient'),
    meso: root.fork('meso'),
  };
}

/** What `SimWorld.rt` answers for a lane nobody has been on: empty, not a ghost, frozen against writes. */
const NO_RUNTIME: LaneletRuntime = Object.freeze({
  id: '' as LaneletId,
  order: Object.freeze([]) as unknown as VehicleId[],
  shadows: Object.freeze([]) as unknown as VehicleId[],
  ghost: false,
  ghostSince: 0,
});

/** Everything the simulation owns. */
/** The meso traffic as the world steps it (`meso/meso.ts` Meso): declared here so the world never imports the meso, which reads the world. */
export interface MesoTraffic {
  step(w: SimWorld, traffic: boolean): void;
  reset(): void;
}

export class SimWorld {
  readonly clock = new SimClock();
  readonly graph = new LaneletGraph();
  readonly conflicts = new ConflictIndex();
  readonly sidewalks = new SidewalkGraph();
  /** The traffic signal posts by place, kept from the junctions' controls (`signalChangesSince`): the walkers keep clear of them. */
  readonly signalPosts = new SignalPostIndex();
  readonly claims = new ClaimTable();

  /** @mapWide Every vehicle on the map; each filed by its route as it comes and goes (`routes`). */
  readonly vehicles = new VersionedMap<VehicleId, Vehicle>({
    set: (v, was) => { if (was && was !== v) this.routes.unfile(was); this.routes.file(v); },
    delete: (v) => this.routes.unfile(v),
    clear: () => this.routes.clear(),
  });
  /** The vehicles by the lanes and movements of their routes (`noteRoute`): those an edit reached (`vehiclesReached`). */
  readonly routes = new RouteIndex<Vehicle>();
  /** The lanes and movements the builds since the last rebind took or made again (`vehiclesReached`); `rebindAll` after a whole build. */
  private readonly rebindLanes = new Set<LaneletId>();
  private rebindAll = false;
  /** Whether the conflicts are kept only in the micro window (the game, `simHost.ts`); the specs keep every junction's. */
  private microWindow = false;
  /** The junctions by place, filed as each graph build changes them (`fileJunctions`). */
  private readonly junctionFiling = new CellFiling<NodeId, object>();
  private windowTick = -Infinity;
  private windowFleet = 0;
  /** The window the focus and the vehicles ask for, not moved to yet (`moveWindowSteps`). */
  private windowWanted: Set<NodeId> | null = null;
  /** What moves the people (`people/engine.ts`); everything else reaches them through it. */
  pedEngine: PedestrianEngine = NO_PEDESTRIANS;
  /** The vehicle model: Drive v2 (`drive/*`), the only one (the plain-IDM legacy model was taken out on 2026-10-08). */
  driveModel = 'v2' as const;
  /** @mapWide One per lanelet a vehicle (or its shadow) has been on; written only through `runtimeFor`. */
  readonly runtime = new Map<LaneletId, LaneletRuntime>();
  readonly controllers = new Map<NodeId, SignalController>();
  /** DOING LESS (phase 1) */
  doLess = true;
  /** Lanes with a vehicle on them: written only by `enterLanelet`/`exitLanelet`, the only writers of `order`. */
  readonly occupied = new Set<LaneletId>();
  /** What the car being integrated was clearing as its step began: integration's own scratch, filled per car (`integrate.ts`). */
  readonly clearancesAtStart = new Set<Vehicle['clearingConnectors'][number]>();
  /** DO NOT find them by walking the fleet: three passes over every vehicle of the map each tick */
  private readonly maybeHolders = new Set<Vehicle>();
  /** Runtime lanes no longer in the graph (an edit took them): stage 7's work list (`collectGhosts`). */
  readonly ghostCandidates = new Set<LaneletId>();
  /** Signals asleep (`signalsToStep`), by node: rested in green with nobody near on their last step. */
  private readonly asleep = new Map<NodeId, SignalController>();
  /** The passes of stage 1, one a tick (`pipeline.ts`): the clock every controller's time is read against (`SignalClock`). */
  readonly signalClock: SignalClock = { passes: 0 };

  /** @mapWide What vehicles, signals and the audit may know about the people at each crossing (`crossings/state.ts`). */
  readonly crossingStates: CrossingStates = new Map();
  /** @mapWide Every person as the renderer and the counters see them */
  readonly pedViews: PedView[] = [];
  /** @mapWide Every person on the map, by id. */
  readonly pedViewById = new Map<number, PedView>();
  /** Stretch of each zebra that each movement drives over. */
  readonly crossingSpans = new CrossingSpans();

  /** Tick at which each junction last admitted a vehicle. */
  readonly lastAdmission = new Map<NodeId, number>();
  /** The lane that last sent a vehicle into each lane two or more lanes merge into, for the zipper */
  readonly mergeTurn = new Map<LaneletId, LaneletId>();
  /** Cumulative link entries since the current simulation session began. */
  readonly segmentVolume = new Map<number, number>();
  /** Vehicles an hour into each junction from each leg, as a trend. */
  get flow(): FlowStats { return this.flowStats; }
  private flowStats = new FlowStats();
  /** The control each junction left on "automatic" gets from its flows. */
  get advisor(): ControlAdvisor { return this.controlAdvisor; }
  private controlAdvisor = new ControlAdvisor();

  /** The world's random streams, forked from its seed (`reset` forks them again). */
  get rng(): SimStreams { return this.streams; }
  private streams: SimStreams;

  nextVehicleId = 1;
  /** The next person's id, kept by the world as the vehicles' are */
  nextPersonId = 1;
  /** The summed length of the roads, kept by what each rebuild changed (`world/networkLength.ts`). */
  readonly roadLength = new NetworkLength();
  /** The lanes by place, kept by what each build of the lane graph changed (`agents/laneGrid.ts`). */
  readonly laneGrid = new LaneGrid();
  /** The road ends each lane reaches, per body class, kept by what each edit changed (`routing/laneReach.ts`). */
  readonly laneReaches = new LaneReaches();
  /** Per-world population timer; simulations must never influence each other. */
  vehicleSpawnClock = 0;
  /** Traffic waiting to come in at each boundary entry lane */
  /** Per entry: the next arrival, the rate it was drawn at, and the arrivals waiting outside. */
  readonly entryDemand = new Map<LaneletId, { next: number; rate: number; waiting: number[] }>();
  /** Arrivals turned away because an entry's outside queue was full. */
  entryDemandLost = 0;
  /** Vehicles that reached the boundary exit chosen for their trip. */
  completedTrips = 0;
  /** User-facing density multipliers; topology and physics remain unchanged. */
  trafficIntensity = 1;
  pedestrianIntensity = 1;
  /** How many cars and how many people on foot the player wants on the map (the panel's Traffic and People, `main.ts`). */
  trafficCount: number | null = null;
  pedestrianCount: number | null = null;
  /** The game's way (`main.ts`): the panel's Traffic and People are shares of the city's own density */
  followCity = false;
  /** Shared demand multiplier for the current simulation period. */
  demandMultiplier = 1;
  /** Traffic from outside: cars at the map's edge entries, people at doors and road ends (set by `City.step`). */
  edgeTraffic = true;
  /** The city's services - the time of day, the public transport (`sim/city/city.ts`) - stepped by the pipeline. */
  readonly city = new City();
  /** Each vehicle's reservation chain as last found valid (`pipeline.ts` reconcileReservedChain): walked again only when what it reads moved. */
  readonly reservationsChecked = new WeakMap<Vehicle, {
    readonly lanelet: LaneletId; readonly admitted: LaneletId | null; readonly reserved: readonly LaneletId[]; readonly reservedLength: number;
    readonly route: readonly LaneletId[]; readonly routeLength: number; readonly topology: object;
  }>();
  /** The life of the scenery: people and traffic made round the view (`sim/ambient`). */
  readonly ambient = new AmbientWorld();
  /** The meso traffic of the whole map and its micro window (`meso/meso.ts`): the game's (`simHost.ts`); off in the specs, the micro simulation everywhere. */
  meso: MesoTraffic | null = null;
  /** Share of the population ceilings this device carries (1, or `NARROW_SCREEN_SHARE` on a narrow screen). */
  populationShare = 1;
  /** Where the player is looking, world units */
  focus: {
    readonly x: number; readonly y: number; readonly r: number; readonly detail: boolean;
    /** Playing (`play.ts`), the camera looks along the ground from behind the player and sees far down the street, past `r` */
    readonly view?: { readonly ex: number; readonly ey: number; readonly dx: number; readonly dy: number; readonly cos: number; readonly far: number } | null;
  } | null = null;

  auditEnabled = false;
  auditLevel: 'cheap' | 'full' = 'cheap';
  /** Ticks between audits: every tick in the specs; the game checks once a second (`main.ts`). */
  auditEvery = 1;
  readonly issues: AuditIssue[] = [];

  /** Topology revision the indices were last built from. */
  topologyRevision = -1;
  /** Revision the vehicle half was last built from (`rebuildVehicleTopology`). */
  vehicleTopologyRevision = -1;
  constructor(
    readonly doc: RoadDoc,
    readonly net: Network,
    private readonly seed = 0x5eed,
    /** The buildings as traffic reads them: the document's own (a spec), or the worker's table of traffic records (`simHost.ts`). */
    readonly buildings: TrafficBuildings = docBuildings(doc),
  ) {
    this.streams = forkStreams(seed);
  }

  /** Switches the model that moves the people. */
  usePedestrianEngine(engine: PedestrianEngine): void {
    this.crossingStates.clear();
    this.pedViews.length = 0;
    this.pedViewById.clear();
    this.pedEngine = engine;
    engine.rebind(this);
  }

  /** Forgets every agent and everything learned about the previous map. */
  reset(): void {
    this.vehicles.clear();
    this.rebindLanes.clear();
    this.rebindAll = false;
    this.maybeHolders.clear();
    this.runtime.clear();
    this.claims.clear();
    this.controllers.clear();
    this.planInputs.clear();
    // What was built from the graph is gone: the next rebuild builds it whole, as a new world's first.
    this.graph.forget();
    this.prepGraph?.forget();
    // The kerbs and zebras of the old map
    this.sidewalks.clear();
    this.walkSeen = null;
    this.signalPosts.reset();
    this.junctionsChanged(null);
    this.occupied.clear();
    this.ghostCandidates.clear();
    this.asleep.clear();
    this.awake.clear();
    this.signalsStepped.clear();
    this.signalClock.passes = 0;
    this.crossingStates.clear();
    this.pedViews.length = 0;
    this.pedViewById.clear();
    this.lastAdmission.clear();
    this.mergeTurn.clear();
    this.segmentVolume.clear();
    this.entryDemand.clear();
    this.entryDemandLost = 0;
    this.completedTrips = 0;
    this.vehicleSpawnClock = 0;
    this.issues.length = 0;
    this.topologyRevision = -1;
    this.vehicleTopologyRevision = -1;
    // DO NOT keep them: the advisor turned the new map's junctions to signals it had measured on the old one
    this.flowStats = new FlowStats();
    this.controlAdvisor = new ControlAdvisor();
    this.advised.clear();
    this.streams = forkStreams(this.seed);
    this.forgetSignals();
    this.pedEngine.reset(this);
    this.meso?.reset();
  }

  // ------------------------------------------------------------- accessors

  lanelet(id: LaneletId): Lanelet | undefined {
    return this.graph.lanelets.get(id);
  }

  requireLanelet(id: LaneletId): Lanelet {
    const l = this.graph.lanelets.get(id);
    if (!l) throw new Error(`SimWorld: unknown lanelet ${id}`);
    return l;
  }

  connector(id: string): Connector | undefined {
    return this.graph.connectors.get(id);
  }

  /** DO NOT create the runtime here: routing, lane changes and the inspector read every lane they look at through this */
  rt(id: LaneletId): LaneletRuntime {
    return this.runtime.get(id) ?? NO_RUNTIME;
  }

  /** A lane's runtime, made when a vehicle or its shadow first comes onto it: for `enterLanelet` and `addShadow` only. */
  private runtimeFor(id: LaneletId): LaneletRuntime {
    let r = this.runtime.get(id);
    if (!r) {
      r = { id, order: [], shadows: [], ghost: false, ghostSince: 0 };
      this.runtime.set(id, r);
      if (!this.graph.lanelets.has(id)) this.ghostCandidates.add(id);
    }
    return r;
  }

  veh(id: VehicleId): Vehicle | undefined {
    return this.vehicles.get(id);
  }

  controller(node: NodeId): SignalController | undefined {
    return this.controllers.get(node);
  }

  /** A vehicle's route written (`Vehicle.route`): for its writers, so an edit finds who drives over what it took (`routes`). */
  noteRoute(v: Vehicle): void {
    if (this.vehicles.get(v.id) === v) this.routes.file(v);
  }

  /** The vehicles the builds since the last call reached, in id order (null: every one, a whole build) */
  vehiclesReached(): readonly Vehicle[] | null {
    const all = this.rebindAll, lanes = this.rebindLanes;
    this.rebindAll = false;
    if (all) { lanes.clear(); return null; }
    const out = new Set<Vehicle>();
    const take = (id: VehicleId): void => { const v = this.vehicles.get(id); if (v) out.add(v); };
    for (const id of lanes) {
      const rt = this.runtime.get(id);
      if (rt) { for (const v of rt.order) take(v); for (const v of rt.shadows) take(v); }
      for (const v of this.routes.routing(id) ?? []) out.add(v);
    }
    // What a vehicle holds at a junction is not on its lane: the movements granted, reserved or being cleared.
    if (lanes.size) {
      for (const v of this.junctionHolders()) {
        if ((v.admittedConnector !== null && lanes.has(v.admittedConnector)) ||
            v.reservedConnectors.some((id) => lanes.has(id)) ||
            v.clearingConnectors.some((token) => lanes.has(token.connector))) out.add(v);
      }
    }
    lanes.clear();
    return [...out].sort((a, b) => a.id - b.id);
  }

  /** A vehicle that may now hold something at a junction (`maybeHolders`): for the writers of what it holds. */
  noteHolder(v: Vehicle): void {
    this.maybeHolders.add(v);
  }

  /** The vehicles holding or clearing a movement, or on a connector, now - in no set order */
  junctionHolders(): Vehicle[] {
    const out: Vehicle[] = [];
    for (const v of this.maybeHolders) {
      if (this.vehicles.get(v.id) !== v) { this.maybeHolders.delete(v); continue; }
      if (v.admittedConnector !== null || v.clearingConnectors.length > 0 || this.lanelet(v.lanelet)?.kind === 'connector') out.push(v);
      else this.maybeHolders.delete(v);
    }
    return out;
  }

  /** The vehicles on the lanes within `reach` of a point and a body's length and a lane's width more, in id order: DO NOT walk the fleet to find who is near. */
  vehiclesNear(x: number, y: number, reach: number): Vehicle[] {
    const out: Vehicle[] = [];
    for (const lane of lanesNear(this, x, y, reach + BODY_OFF_LANE)) {
      for (const id of this.rt(lane.id).order) {
        const v = this.vehicles.get(id);
        if (v) out.push(v);
      }
    }
    return out.sort((a, b) => a.id - b.id);
  }

  /** DO NOT sort the fleet again at each change of it */
  vehiclesInIdOrder(): readonly Vehicle[] {
    return this.vehicles.inKeyOrder();
  }

  /** Every junction in node order: for the readers of the whole map (doing everything, a whole layout), sorted when asked after a change. */
  junctionNodesInOrder(): readonly NodeId[] {
    return this.inNodeOrder().nodes;
  }

  /** The controllers of the signalised junctions in node order: every one, for doing everything and the specs. */
  signalisedControllers(): readonly SignalController[] {
    return this.inNodeOrder().signalised;
  }

  /** DO NOT sort and map every junction of the map for an edit: kept null by `junctionsChanged` until a reader of every junction asks. */
  private ordered: { readonly nodes: readonly NodeId[]; readonly signalised: readonly SignalController[] } | null = null;
  /** @rebuild The junctions and signals in node order, made again after a change when a reader of every one asks. */
  private inNodeOrder(): { readonly nodes: readonly NodeId[]; readonly signalised: readonly SignalController[] } {
    if (this.ordered) return this.ordered;
    const nodes = [...this.graph.junctions.keys()].sort((a, b) => a - b);
    const signalised: SignalController[] = [];
    for (const node of nodes) {
      const c = this.controllers.get(node);
      if (c && this.graph.junctions.get(node)!.signalised) signalised.push(c);
    }
    return this.ordered = { nodes, signalised };
  }

  /** The junctions or controllers that changed (null: every one): the orders forgotten, their signals woken. */
  private junctionsChanged(nodes: Iterable<NodeId> | null): void {
    this.ordered = null;
    if (nodes === null) this.wakeAll = true;
    else for (const node of nodes) this.wake.add(node);
  }
  private readonly wake = new Set<NodeId>();
  private wakeAll = true;

  /** The junction a lane is an approach of (in its `inbound`), from the graph: no map of every approach of the map to keep. */
  private junctionOfLane(id: LaneletId): NodeId | undefined {
    const lane = this.graph.lanelets.get(id);
    if (!lane || lane.kind !== 'link' || lane.to === undefined) return undefined;
    return this.graph.junctions.get(lane.to)?.inbound.includes(id) ? lane.to : undefined;
  }

  /** The junctions with a vehicle on one of their approaches, in node order: the only ones with a lane head to admit */
  junctionsApproached(): readonly NodeId[] {
    const out = this.approached, seen = this.approachedSeen;
    seen.clear();
    let n = 0;
    for (const lane of this.occupied) {
      const node = this.junctionOfLane(lane);
      if (node === undefined || seen.has(node)) continue;
      seen.add(node);
      out[n++] = node;
    }
    out.length = n;
    return out.sort((a, b) => a - b);
  }
  private readonly approached: NodeId[] = [];
  private readonly approachedSeen = new Set<NodeId>();

  /** The roads' and controls' changes the sleeping signals were woken by (`signalsToStep`). */
  private readonly signalRoadsSeen = new JournalCursor(['roads', 'traffic']);

  /** DO NOT walk every signal of the map a tick to pass over those asleep: their time keeps itself (`SignalClock`), only the awake are stepped */
  signalsToStep(deps: WorldSignalDeps): readonly SignalController[] {
    const asleep = this.asleep, awake = this.awake;
    const entries = this.signalRoadsSeen.read(this.doc.changes);
    if (!this.doLess) {
      this.wake.clear();
      this.wakeAll = true;
      return this.signalisedControllers();
    }
    // DO NOT wake every one on an edit: only those of the junctions it built again, and where the diary says it reached.
    if (this.wakeAll || entries === null || entries.some((e) => e.rects === null)) this.wakeEverySignal();
    else {
      for (const node of this.wake) {
        asleep.delete(node);
        awake.delete(node);
        const c = this.controllers.get(node);
        if (c && this.graph.junctions.get(node)?.signalised) awake.set(node, c);
      }
      for (const entry of entries) {
        for (const rect of entry.rects!) for (const node of this.junctionFiling.idsMeeting(rect)) this.wakeSignal(node);
      }
    }
    this.wake.clear();
    this.wakeAll = false;
    // Somebody near: on an approach or holding a reservation there (those at its crossings woke it as they were published, `signalAtCrossing`).
    if (asleep.size) {
      for (const lane of this.occupied) {
        const node = this.junctionOfLane(lane);
        if (node !== undefined) this.wakeSignal(node);
      }
      for (const node of deps.reserved().keys()) this.wakeSignal(node);
    }
    const out = this.stepping;
    out.length = 0;
    for (const c of awake.values()) out.push(c);
    return out.sort((a, b) => a.node - b.node);
  }
  private readonly stepping: SignalController[] = [];

  /** The signalised controllers not asleep: those stage 1 steps (`signalsToStep`). */
  private readonly awake = new Map<NodeId, SignalController>();

  /** @rebuild Every signalised controller awake: a whole build, or changes the diary cannot place. */
  private wakeEverySignal(): void {
    this.asleep.clear();
    this.awake.clear();
    for (const c of this.signalisedControllers()) this.awake.set(c.node, c);
  }

  /** Somebody at a crossing (`crossingStates`, as the walkers are published): the signal whose plan walks it woken. */
  signalAtCrossing(x: CrossingId): void {
    const node = crossingNode(x);
    const c = this.asleep.get(node);
    if (c && c.plan.stages.some((stage) => stage.pedWalk.includes(x))) this.wakeSignal(node);
  }

  private wakeSignal(node: NodeId): void {
    const c = this.asleep.get(node);
    if (!c) return;
    this.asleep.delete(node);
    this.awake.set(node, c);
  }

  /** The junctions whose signal stage 1 stepped since a reader last took them (`takeSignalsStepped`): only their lights may have changed (with those the signals' log names). */
  private readonly signalsStepped = new Set<NodeId>();

  /** A signal stepped by stage 1 (`pipeline.ts`). */
  noteSignalStepped(c: SignalController): void {
    this.signalsStepped.add(c.node);
  }

  /** The junctions whose signal was stepped since the last call, into `out`, and forgotten. */
  takeSignalsStepped(out: NodeId[]): NodeId[] {
    out.length = 0;
    for (const node of this.signalsStepped) out.push(node);
    this.signalsStepped.clear();
    return out;
  }

  /** A signal rested with nobody near (`stepController`): not stepped until something wakes it. */
  restSignal(c: SignalController): void {
    if (this.awake.get(c.node) !== c) return;
    this.awake.delete(c.node);
    this.asleep.set(c.node, c);
  }

  // -------------------------------------------------------------- topology

  /** @rebuild Rebuilds every derived index from the current network geometry. */
  rebuildTopology(): void {
    this.rebuildVehicleTopology();
    this.rebuildWalkTopology();
  }

  /** The first half of `rebuildTopology`: lanelets, conflict zones, claims and the signal controllers */
  /** A second lanelet graph, built from the same document, that is never run */
  private prepGraph: LaneletGraph | null = null;

  /** @rebuild The slow half of `rebuildVehicleTopology` ahead of time, in steps */
  *prepareVehicleTopology(measurer?: PairMeasurer): Generator<void | typeof WAITING, void> {
    const graph = this.prepGraph ??= new LaneletGraph();
    // DO NOT sweep them here: a generated city's turns held one frame 25 s (2026-10-15).
    const left = graph.turnPlan;
    if (left) left.recording = measurer?.chooseTurns !== undefined;
    graph.turnPlan = measurer?.chooseTurns ? left ?? new TurnPlan() : left;
    // DO NOT call `update` here: a whole build was one call.
    const changed = this.prepReach(yield* graph.updateSteps(this.doc, this.net, measurer ?? null));
    const plan = graph.turnPlan;
    if (plan && plan.asks.size > 0) {
      const keys = [...plan.asks.keys()];
      const answer: { turns?: readonly ChosenTurn[]; failed?: boolean } = {};
      measurer!.chooseTurns!(keys.map((k) => plan.asks.get(k)!), plan.surfaces).then(
        (turns) => { answer.turns = turns; },
        (error: unknown) => { console.warn('[traffic] the turn workers failed; the turns are chosen on the page', error); answer.failed = true; },
      );
      while (!answer.turns && !answer.failed) yield WAITING;
      keys.forEach((k, i) => { const turn = answer.turns?.[i]; if (turn) plan.chosen.set(k, turn); });
    }
    // The junctions that stood turns in, their movements shaped with them (none: nothing to do).
    graph.redoProvisional(this.doc, this.net);
    yield;
    // The new pairs of the junctions built again since a preparation last ran to its end
    yield* this.conflicts.prepare(graph, measurer, changed);
    yield;
    // The residents' walkways brought up to the network: only what the edit reached
    yield* this.walkways.updateSteps(this.net, measurer);
    this.prepReached = new Set();
  }

  /** DO NOT prepare only the last edit's: the junctions of the one given up had their pairs measured on the page at the swap. */
  private prepReached: Set<NodeId> | null = new Set();
  private prepReach(changed: GraphChange | null): ReadonlySet<NodeId> | null {
    if (changed === null || this.prepReached === null) this.prepReached = null;
    else for (const node of changed.junctions) this.prepReached.add(node);
    return this.prepReached;
  }

  /** The residents' walkways (`world/walkways.ts`), kept by what each edit changed. */
  private readonly walkways = new Walkways();
  /** The walkways of the network as it is now. */
  walkwaysNow(): WalkGraph {
    return this.walkways.update(this.net);
  }

  /** Builds the preparation graph with a map's load, so its first edit does not build it from nothing. */
  warmTopologyPrep(): void {
    const graph = this.prepGraph ??= new LaneletGraph();
    if (graph.current(this.net)) return;
    // A preparation's stand-in turns left (`prepareVehicleTopology`) are chosen here: no workers are asked.
    if (graph.turnPlan) graph.turnPlan.recording = false;
    this.prepReach(graph.update(this.doc, this.net));
    graph.redoProvisional(this.doc, this.net);
  }

  /** What each build of the lane graph changed */
  readonly topologyLog = new ChangeLog<GraphChange>();
  /** The topology's state the kerbs, zebras and spans were brought up to (`walkTopologySteps`). */
  private walkSeen: object | null = null;

  /** The junctions a build changed filed again by place; every one for a graph built whole. */
  private fileJunctions(changed: GraphChange | null): void {
    const nodes = changed === null ? [...this.junctionFiling.ids(), ...this.graph.junctions.keys()] : changed.junctions;
    for (const node of nodes) {
      this.junctionFiling.remove(node);
      const at = this.graph.junctions.has(node) ? this.doc.node(node) : undefined;
      if (at) this.junctionFiling.file(node, JUNCTION_FILED, [at.x, at.y, at.x, at.y]);
    }
    this.windowTick = -Infinity;
  }

  /** The game's simulation keeps conflicts only where traffic is: round the focus and every vehicle (DO NOT build every junction's pairs of the map: 1.3 KB each, 63 MB in a 4,868-building city). */
  useMicroWindow(): void {
    this.microWindow = true;
    this.windowTick = -Infinity;
    if (this.conflicts.setWindow(this.graph, new Set())) this.claims.dropMissing(this.conflicts);
  }

  /** The window moved to the one asked for: the pairs of the junctions it reaches measured off the thread first (`measurer`, `conflictPool.ts`), then the swap (`TopologyCatchUp.stepWindow`). */
  *moveWindowSteps(measurer?: PairMeasurer): Generator<void | typeof WAITING, void> {
    const next = this.windowWanted;
    if (!next) return;
    this.windowWanted = null;
    const entering = this.conflicts.entering(this.graph, next);
    // DO NOT build them here unprepared: each new pair measured on the simulation's thread held it for minutes on a large city.
    if (entering.size) yield* this.conflicts.prepare(this.graph, measurer, entering, next);
    if (this.conflicts.setWindow(this.graph, next)) this.claims.dropMissing(this.conflicts);
  }

  /** Whether a window move is asked for. */
  get windowMoving(): boolean {
    return this.windowWanted !== null;
  }

  /** Stage 2 (`pipeline.ts`): the window asked for with the focus and the vehicles, each half second or when vehicles were made; moved off the step (`moveWindowSteps`). */
  keepMicroWindow(): void {
    if (!this.microWindow) return;
    const tick = this.clock.tick;
    if (tick - this.windowTick < Math.round(WINDOW_EVERY / DT) && this.vehicles.size <= this.windowFleet) return;
    this.windowTick = tick;
    this.windowFleet = this.vehicles.size;
    const next = new Set<NodeId>();
    const take = (x: number, y: number, r: number): void => {
      for (const node of this.junctionFiling.idsMeeting([x - r, y - r, x + r, y + r])) next.add(node);
    };
    const focus = this.focus;
    if (focus) take(focus.x, focus.y, Math.min(FOCUS_WINDOW, Math.max(focus.r * 1.35, m(200)) * 1.15 + m(100)));
    // DO NOT ask the junctions round each vehicle (a queue of a hundred cars asks the same square a hundred times): once per cell a vehicle stands in, the cell grown by the vehicles' reach.
    const cells = new Set<number>();
    for (const v of this.vehicles.values()) {
      const pose = vehiclePose(this, v, 1);
      if (pose) cells.add((Math.floor(pose.p.x / WINDOW_CELL) + 2 ** 20) * 2 ** 21 + (Math.floor(pose.p.y / WINDOW_CELL) + 2 ** 20));
    }
    for (const cell of cells) {
      const x0 = (Math.floor(cell / 2 ** 21) - 2 ** 20) * WINDOW_CELL, y0 = ((cell % 2 ** 21) - 2 ** 20) * WINDOW_CELL;
      for (const node of this.junctionFiling.idsMeeting([x0 - VEHICLE_WINDOW, y0 - VEHICLE_WINDOW, x0 + WINDOW_CELL + VEHICLE_WINDOW, y0 + WINDOW_CELL + VEHICLE_WINDOW])) next.add(node);
    }
    this.windowWanted = this.conflicts.holdsWindow(next) ? null : next;
  }

  /** @rebuild Called when the network's traffic revision moved. */
  rebuildVehicleTopology(): void {
    // DO NOT build the graph, the conflicts, the controllers and the lanes' runtimes of the whole map for an edit
    const prep = this.prepGraph;
    const changed = prep?.current(this.net) ? this.graph.adopt(prep, this.doc, this.net) : this.graph.update(this.doc, this.net);
    this.topologyLog.push(changed);
    // Each body's reach of the road ends follows the graph here, with the topology, not in the tick of the next vehicle made (`LaneReaches.follow`).
    this.laneReaches.follow(this);
    // What the next rebind looks at: nothing while no vehicle is out, as a vehicle made later is made on this graph.
    if (this.vehicles.size === 0) { this.rebindLanes.clear(); this.rebindAll = false; }
    else if (changed === null) this.rebindAll = true;
    else for (const id of changed.lanelets) this.rebindLanes.add(id);
    this.fileJunctions(changed);
    if (changed === null) this.conflicts.build(this.graph); else this.conflicts.update(this.graph, changed.junctions);
    this.claims.dropMissing(this.conflicts);
    this.syncControllers(changed?.junctions ?? null);
    for (const segment of changed ? [...changed.segments] : [...this.segmentVolume.keys()]) {
      rebuildWork.lanes++;
      if (!this.doc.segment(segment as SegmentId)) this.segmentVolume.delete(segment);
    }
    this.vehicleTopologyRevision = this.net.trafficRevision;
    // DO NOT leave this to stage 7: the mark only ever went on, and a lane given back would stay dead to routes, bays
    for (const id of changed ? changed.lanelets : this.runtime.keys()) {
      const rt = this.runtime.get(id);
      if (!rt) continue;
      rebuildWork.lanes++;
      if (!this.graph.lanelets.has(id)) this.ghostCandidates.add(id);
      else if (rt.ghost) { rt.ghost = false; rt.ghostSince = 0; }
    }
    this.junctionsChanged(changed?.junctions ?? null);
    // The controls the flows chose stay chosen across an edit (V5); a junction gone takes its own away.
    if (changed === null) {
      const nodes = new Set(this.graph.junctions.keys());
      rebuildWork.lanes += nodes.size;
      this.flow.keepOnly(nodes);
      this.advisor.forget(nodes);
      for (const node of nodes) this.advised.add(node);
    } else {
      const gone = new Set([...changed.junctions].filter((node) => !this.graph.junctions.has(node)));
      if (gone.size) { this.flow.drop(gone); this.advisor.drop(gone); }
      for (const node of changed.junctions) this.advised.add(node);
    }
    // DO NOT forget the log here: every road drawn anywhere had every junction's posts and heads placed again.
    this.noteJunctionsReached();
    if (this.applyAutoControl(changed?.junctions)) this.syncControllers(changed?.junctions ?? null);
  }

  /** DO NOT read a junction's control off `topologyRevision` alone */
  private signalLog: NodeId[] = [];
  private signalLogBase = 0;
  private signalSerial = 0;

  /** The junctions whose signal came or went since `serial` (`signalLog`), and the serial now; `nodes` null */
  signalChangesSince(serial: number): { readonly serial: number; readonly nodes: readonly NodeId[] | null } {
    if (serial < this.signalLogBase || serial > this.signalSerial) return { serial: this.signalSerial, nodes: null };
    return { serial: this.signalSerial, nodes: this.signalLog.slice(serial - this.signalLogBase) };
  }

  /** The junctions signalised when last noted: one that stops being so is noted once more (its heads and posts taken away). */
  private readonly signalised = new Set<NodeId>();

  private noteSignal(node: NodeId): void {
    if (this.graph.junctions.get(node)?.signalised) this.signalised.add(node); else this.signalised.delete(node);
    this.signalLog.push(node);
    this.signalSerial++;
    // DO NOT forget the whole log here: a reader that had just read was sent to read every junction again.
    const most = 2 * Math.max(64, this.graph.junctions.size);
    if (this.signalLog.length > most) {
      const drop = this.signalLog.length - most / 2;
      this.signalLog.splice(0, drop);
      this.signalLogBase += drop;
    }
  }

  /** The roads' changes since the last rebuild (`noteJunctionsReached`). */
  private readonly roadsSeen = new JournalCursor(['roads']);

  /** The signalised junctions (now, or when last noted) at the ends of the segments the roads' changes reached, noted once each; the log forgotten when the diary cannot say.
   *  DO NOT note every junction a tile's square reaches: a junction with no signal has no heads nor posts, and one that gains or loses its controller is noted where that happens (`syncControllers`, `applyAutoControl`). */
  private noteJunctionsReached(): void {
    const entries = this.roadsSeen.read(this.doc.changes);
    if (entries === null || entries.some((e) => e.rects === null)) { this.forgetSignals(); return; }
    const noted = new Set<NodeId>();
    const note = (node: NodeId): void => {
      if (noted.has(node) || !(this.signalised.has(node) || this.graph.junctions.get(node)?.signalised)) return;
      noted.add(node);
      this.noteSignal(node);
    };
    for (const entry of entries) {
      for (const rect of entry.rects!) {
        for (const id of this.net.segmentCells.idsMeeting(rect)) {
          const segment = this.doc.segment(id);
          if (segment) { note(segment.a); note(segment.b); }
        }
      }
    }
    // A signalised junction whose roads all went: no segment reaches it, noted from what was signalised.
    for (const node of this.signalised) if (!this.graph.junctions.has(node) && !noted.has(node)) { noted.add(node); this.noteSignal(node); }
  }

  /** @rebuild The log forgotten (readers read every junction): the signalised ones listed again from the graph. */
  private forgetSignals(): void {
    this.signalLog = [];
    this.signalLogBase = ++this.signalSerial;
    this.signalised.clear();
    for (const [node, junction] of this.graph.junctions) if (junction.signalised) this.signalised.add(node);
  }

  /** The control a junction on "automatic" runs */
  private applyAutoControl(only?: Iterable<NodeId>): boolean {
    let changed = false;
    // The junctions built again keep no choice of the old graph's: only they are asked (`only`)
    const asked = only ? [...only].map((node) => [node, this.graph.junctions.get(node)] as const).filter((e): e is readonly [NodeId, JunctionTopology] => e[1] !== undefined) : this.graph.junctions;
    for (const [node, junction] of asked) {
      rebuildWork.lanes++;
      if (this.doc.node(node)?.control !== 'auto') continue;
      const choice = this.advisor.choice(node);
      if (!choice) continue;
      const signalised = choice === 'signal';
      if (junction.signalised === signalised) continue;
      this.graph.junctions.set(node, { ...junction, signalised });
      this.junctionsChanged([node]);
      this.noteSignal(node);
      changed = true;
    }
    return changed;
  }

  /** The junctions the advisor still looks at (`stepControlAdvisor`): built again, counted, or not yet at rest; the others cannot change. */
  private readonly advised = new Set<NodeId>();

  /** Stage 0's measuring of the junctions: DO NOT evaluate every junction of the map, only those whose control the flows can still change */
  stepControlAdvisor(dt: number): void {
    this.flow.step(dt);
    this.flow.takeCounted(this.advised);
    if (!this.advisor.tick(dt)) return;
    const changed = new Set<NodeId>();
    for (const node of this.advised) {
      const junction = this.graph.junctions.get(node);
      const n = this.doc.node(node);
      if (!junction || !n || n.control !== 'auto' || n.incident.length < 3) { this.advised.delete(node); continue; }
      // DO NOT judge a junction out of the micro window: its flows are not counted there (the meso drives it), and its lights would follow the camera. Kept as it stood until the window comes back.
      if (this.microWindow && !this.conflicts.inWindowOf(node)) continue;
      const main = mainRoadLegs(this.doc, node);
      let major = 0, minorMax = 0, minorTotal = 0;
      for (const seg of n.incident) {
        const rate = this.flow.rate(node, seg);
        if (main?.includes(seg)) major += rate;
        else { minorMax = Math.max(minorMax, rate); minorTotal += rate; }
      }
      const initial: AutoControl = junction.signalised ? 'signal' : 'priority';
      if (this.advisor.evaluate(node, major, minorMax, minorTotal, initial, this.flow.measured)) changed.add(node);
      // At rest and too quiet for any other control: the rates only fall until a vehicle is counted there again (`FlowStats.takeCounted`).
      if (this.advisor.choice(node) === 'priority' && major + minorTotal < QUIET_FLOW) this.advised.delete(node);
    }
    if (changed.size && this.applyAutoControl(changed)) this.syncControllers(changed);
  }

  /** The second half: the footway graph and its crossings, and the controllers again */
  rebuildWalkTopology(): void {
    if (this.vehicleTopologyRevision !== this.net.trafficRevision) this.rebuildVehicleTopology();
    // DO NOT build them, nor sync every controller, for the whole map on an edit: every road drawn made the town's again.
    const changes = this.topologyLog.since(this.walkSeen);
    this.walkSeen = this.topologyLog.state;
    let nodes: Set<NodeId> | null = null;
    if (changes) {
      nodes = new Set();
      for (const change of changes) for (const node of change.junctions) nodes.add(node);
    }
    this.sidewalks.update(this.doc, this.net, this.graph, changes);
    this.crossingSpans.update(this, nodes);
    this.syncControllers(nodes);
    this.topologyRevision = this.net.trafficRevision;
  }

  /** Crossing ids at a node, one per incident segment. */
  crossingsAt(node: NodeId): CrossingId[] {
    const n = this.doc.node(node);
    // A junction, or a mid-block crossing (a two-road node the player put one on)
    if (!n || (n.incident.length < 3 && !(n.crossing && n.incident.length === 2))) return [];
    return n.incident
      .slice()
      .sort((a, b) => a - b)
      .map((seg) => makeCrossingId(node, seg))
      .filter((id) => this.sidewalks.crossings.has(id));
  }

  /** What the signal controllers read about the world, for one pass over them. */
  signalDeps(): WorldSignalDeps {
    const kept = (this.keptSignalDeps ??= this.makeSignalDeps());
    kept.fresh();
    return kept.deps;
  }
  private keptSignalDeps: { readonly deps: WorldSignalDeps; readonly fresh: () => void } | null = null;

  private makeSignalDeps(): { readonly deps: WorldSignalDeps; readonly fresh: () => void } {
    // Kept by the node and the very arrays asked about
    const demands = new Map<NodeId, Map<readonly number[], Map<readonly string[] | undefined, { active: number; score: number }>>>();
    const demandOf = (node: NodeId, groups: readonly number[], movements?: readonly string[]) => {
      let byGroups = demands.get(node);
      if (!byGroups) demands.set(node, byGroups = new Map());
      let byMovements = byGroups.get(groups);
      if (!byMovements) byGroups.set(groups, byMovements = new Map());
      let value = byMovements.get(movements);
      if (!value) {
        value = this.signalDemand(node, groups, movements);
        byMovements.set(movements, value);
      }
      return value;
    };
    /** Signal groups some vehicle holding an allocation must acquire next, by node. */
    let reserved: Map<NodeId, Set<number>> | null = null;
    const reservedGroups = (): Map<NodeId, Set<number>> => {
      if (reserved) return reserved;
      reserved = new Map();
      for (const vehicle of this.junctionHolders()) {
        const lane = this.lanelet(vehicle.lanelet);
        const ownsAllocation =
          vehicle.admittedConnector !== null ||
          vehicle.clearingConnectors.length > 0 ||
          lane?.kind === 'connector';
        if (!ownsAllocation) continue;
        // A soft Banker's intent does not occupy its future junctions.
        const next = vehicle.reservedConnectors[0];
        if (!next) continue;
        const connector = this.connector(next);
        if (!connector) continue;
        let groups = reserved.get(connector.node);
        if (!groups) {
          groups = new Set();
          reserved.set(connector.node, groups);
        }
        groups.add(connector.group);
      }
      return reserved;
    };
    const deps: WorldSignalDeps = {
      tick: () => this.clock.tick,
      connectorsOf: (id: string) => this.graph.connectors.get(id),
      // Each stage's yellow is timed for the fastest approach it releases (ITE kinematic equation, `plan.ts` `withAmbers`).
      approachSpeed: (lane: string) => this.graph.lanelets.get(lane)?.speedLimit ?? 0,
      // Conflicts between two CARS.
      conflictsOf: (id: string) => this.conflicts.refs(id)
        .filter((ref) => this.conflicts.points[ref.point]?.zone(id, CAR_CLASS, CAR_CLASS))
        .map((ref) => ref.other),
      pedestriansCrossing: (_node, crossings) =>
        crossings.some((x) => (this.crossingStates.get(x)?.occupants.length ?? 0) > 0),
      demandOn: (node, groups, movements) => demandOf(node, groups, movements).score > 0,
      demand: (node, groups, movements) => demandOf(node, groups, movements),
      pedestrianWait: (_node, crossings) => {
        let longest = 0;
        for (const x of crossings) longest = Math.max(longest, this.crossingStates.get(x)?.longestWait ?? 0);
        return longest;
      },
      pedestrianDemandOn: (_node, crossings) => crossings.some((x) => this.crossingStates.get(x)?.demand ?? false),
      settings: (node) => this.doc.node(node)?.signal,
      busNear: (node, groups) => this.busNear(node, groups),
      quiet: (c) => this.doLess && this.junctionQuiet(c, reservedGroups),
      reserved: reservedGroups,
      reservationDemandOn: (node, groups) => {
        const here = reservedGroups().get(node);
        return !!here && groups.some((group) => here.has(group));
      },
    };
    return { deps, fresh: () => { demands.clear(); reserved = null; } };
  }

  /** What a green for these groups would actually serve right now. */
  signalDemand(node: NodeId, groups: readonly number[], movements?: readonly string[]): { active: number; score: number } {
    const junction = this.graph.junctions.get(node);
    let active = 0;
    let score = 0;
    for (const laneId of junction?.inbound ?? []) {
      // An empty approach serves nobody: read before its group is looked up.
      const order = this.runtime.get(laneId)?.order;
      if (!order?.length) continue;
      const lane = this.graph.lanelets.get(laneId);
      const segment = lane?.segment;
      if (!lane || segment === undefined) continue;
      const group = junction?.groups.find((g) => g.segments.includes(segment));
      if (!group || !groups.includes(group.id)) continue;
      for (let i = order.length - 1; i >= 0; i--) {
        const v = this.vehicles.get(order[i] as number);
        if (!v) continue;
        const d = lane.length - v.s;
        const arrival = d / Math.max(v.v, 0.5);
        if (d > DEMAND_QUEUE_REACH && arrival > DEMAND_HORIZON) break;
        const next = this.graph.connectors.get(v.route[1] ?? '');
        if (!next || next.fromLane !== laneId) continue;
        if (movements && !movements.includes(next.id)) continue;
        if (i === order.length - 1) {
          if (!hasDownstreamStorage(this, v, next)) break;
          if (d <= DEMAND_AT_LINE || arrival <= DEMAND_PASSAGE) active++;
        }
        score += v.v < 0.5 ? 1 + v.waited / DEMAND_WAIT_WEIGHT : Math.max(0, 1 - arrival / DEMAND_HORIZON);
      }
    }
    return { active, score };
  }

  /** Nobody near a signal's junction (`SignalDeps.quiet`): its approaches empty, nobody at its crossings, nothing reserved there. */
  private junctionQuiet(c: SignalController, reserved: () => ReadonlyMap<NodeId, ReadonlySet<number>>): boolean {
    const junction = this.graph.junctions.get(c.node);
    if (!junction) return false;
    for (const lane of junction.inbound) if ((this.runtime.get(lane)?.order.length ?? 0) > 0) return false;
    for (const stage of c.plan.stages) {
      for (const x of stage.pedWalk) {
        const at = this.crossingStates.get(x);
        if (at && (at.occupants.length > 0 || at.demand || at.waitingFrom > 0 || at.waitingTo > 0)) return false;
      }
    }
    return !reserved().has(c.node);
  }

  /** Whether a bus is on an approach of `node`, within reach of its line, bound for a movement of one of these signal groups */
  busNear(node: NodeId, groups: readonly number[]): boolean {
    for (const laneId of this.graph.junctions.get(node)?.inbound ?? []) {
      const order = this.runtime.get(laneId)?.order;
      if (!order?.length) continue;
      const lane = this.lanelet(laneId);
      if (!lane || lane.kind !== 'link' || lane.to !== node) continue;
      for (const id of order) {
        const v = this.vehicles.get(id);
        if (!v || v.archetype.shape !== 'bus' || lane.length - v.s > BUS_REACH) continue;
        const next = v.route[v.route.indexOf(v.lanelet) + 1];
        const conn = next ? this.connector(next) : undefined;
        if (conn && conn.node === node && groups.includes(conn.group)) return true;
      }
    }
    return false;
  }

  /** Ticks since the world began, the common clock of fixed-time signals (V5). */
  private tickCount(): number {
    return this.clock.tick;
  }

  /** DO NOT rebuild every controller here */
  private syncControllers(only: ReadonlySet<NodeId> | null = null): void {
    const deps = this.signalDeps();
    // The junctions an edit built again (`LaneletGraph.update`), or every one
    const asked = only ? [...only].map((node) => [node, this.graph.junctions.get(node)] as const).filter((e): e is readonly [NodeId, JunctionTopology] => e[1] !== undefined) : this.graph.junctions;
    for (const [node, junction] of asked) {
      const crossings = this.crossingsAt(node);
      const existing = this.controllers.get(node);
      const settings = this.doc.node(node)?.signal;
      const inputs = this.planInputsOf(junction, crossings, settings);
      if (existing) {
        const was = this.planInputs.get(node);
        if (was && samePlanInputs(was, inputs)) continue;
        rebuildWork.signals++;
        rebuildController(existing, junction, crossings, deps);
        this.noteSignal(node);
        // A fixed-time signal back where the common clock says, with its offset (V5).
        if (settings?.mode === 'fixed') seekFixed(existing, settings, this.tickCount() * DT);
      } else {
        rebuildWork.signals++;
        // A deterministic per-node offset so neighbouring junctions do not all switch together.
        const offset = (node * 7.317) % 60;
        const created = createController(junction, crossings, deps, offset, this.signalClock);
        if (settings?.mode === 'fixed') seekFixed(created, settings, this.tickCount() * DT);
        this.controllers.set(node, created);
        this.noteSignal(node);
      }
      this.planInputs.set(node, inputs);
    }

    for (const node of only ? [...only] : [...this.controllers.keys()]) {
      if (this.controllers.has(node) && !this.graph.junctions.has(node)) {
        this.controllers.delete(node);
        this.planInputs.delete(node);
        this.noteSignal(node);
      }
    }
    this.junctionsChanged(only);
  }

  /** What each controller's plan was made from (`syncControllers`). */
  private readonly planInputs = new Map<NodeId, PlanInputs>();

  /** What a junction's plan is made from (`signals/plan.ts` buildSignalPlan): its approach groups and connectors */
  private planInputsOf(junction: JunctionTopology, crossings: readonly CrossingId[], settings: SignalSettings | undefined): PlanInputs {
    return {
      groups: junction.groups,
      connectors: junction.connectors.map((id) => this.graph.connectors.get(id)),
      signalised: junction.signalised,
      crossings: crossings.join(','),
      settings: settingsKey(settings),
    };
  }

  // ----------------------------------------------------------- lane order

  /** Inserts a vehicle into a lanelet's occupancy list, keeping it sorted. */
  enterLanelet(v: Vehicle, id: LaneletId, recordVolume = true): void {
    const rt = this.runtimeFor(id);
    if (!rt.order.includes(v.id)) rt.order.push(v.id);
    this.occupied.add(id);
    this.sortLane(rt);
    v.lanelet = id;
    const lane = this.lanelet(id);
    if (lane?.kind === 'connector') this.noteHolder(v);
    // Off a lane into a signal the stall counters are nought (stage 7 counts only on those, `updateStallCounters`).
    if (lane?.kind !== 'link' || !lane.controlled) { v.greenStall = 0; v.greenDenied = 0; }
    // A vehicle entering a junction's movement: the flow from its leg (V5).
    if (recordVolume && lane?.kind === 'connector' && lane.node !== undefined) {
      const from = this.lanelet(lane.fromLane ?? '')?.segment;
      if (from !== undefined) this.flow.record(lane.node, from);
    }
    if (recordVolume && lane?.kind === 'link' && lane.segment !== undefined) {
      this.segmentVolume.set(lane.segment, (this.segmentVolume.get(lane.segment) ?? 0) + 1);
    }
  }

  exitLanelet(v: Vehicle, id: LaneletId): void {
    const rt = this.runtime.get(id);
    if (!rt) return;
    const i = rt.order.indexOf(v.id);
    if (i >= 0) rt.order.splice(i, 1);
    if (rt.order.length === 0) this.occupied.delete(id);
  }

  sortLane(rt: LaneletRuntime): void {
    rt.order.sort((a, b) => {
      const va = this.vehicles.get(a);
      const vb = this.vehicles.get(b);
      return (va?.s ?? 0) - (vb?.s ?? 0) || a - b;
    });
  }

  /** The vehicle nearest the exit of a lanelet, or undefined. */
  laneHead(id: LaneletId): Vehicle | undefined {
    const order = this.rt(id).order;
    const last = order[order.length - 1];
    return last === undefined ? undefined : this.vehicles.get(last);
  }

  /** The vehicle nearest the entry of a lanelet, or undefined. */
  laneTail(id: LaneletId): Vehicle | undefined {
    const first = this.rt(id).order[0];
    return first === undefined ? undefined : this.vehicles.get(first);
  }

  /** Registers a vehicle's body as still occupying the lane it is leaving. */
  addShadow(v: Vehicle, lanelet: LaneletId, offset: number, clearAt: number): void {
    this.clearShadow(v);
    v.shadow = { lanelet, offset, clearAt };
    const rt = this.runtimeFor(lanelet);
    if (!rt.shadows.includes(v.id)) rt.shadows.push(v.id);
  }

  clearShadow(v: Vehicle): void {
    if (!v.shadow) return;
    const rt = this.runtime.get(v.shadow.lanelet);
    if (rt) {
      const i = rt.shadows.indexOf(v.id);
      if (i >= 0) rt.shadows.splice(i, 1);
    }
    v.shadow = null;
  }

  /** Every body in a lane with its front arc position there */
  bodiesIn(id: LaneletId): { vehicle: Vehicle; s: number }[] {
    const rt = this.rt(id);
    const out: { vehicle: Vehicle; s: number }[] = [];
    for (const vid of rt.order) {
      const v = this.vehicles.get(vid);
      if (v) out.push({ vehicle: v, s: v.s });
    }
    for (const vid of rt.shadows) {
      const v = this.vehicles.get(vid);
      if (v?.shadow?.lanelet === id) out.push({ vehicle: v, s: v.s + v.shadow.offset });
    }
    const lane = this.lanelet(id);
    if (lane) {
      for (const next of this.graph.exitsOf(id)) {
        for (const vid of this.rt(next).order) {
          const v = this.vehicles.get(vid);
          if (v && v.rearPath[0] === id && v.s < v.archetype.length) {
            out.push({ vehicle: v, s: lane.length + v.s });
          }
        }
      }
    }
    return out;
  }

  removeVehicle(v: Vehicle): void {
    this.maybeHolders.delete(v);
    this.clearShadow(v);
    this.exitLanelet(v, v.lanelet);
    this.claims.releaseAll(v.id);
    this.vehicles.delete(v.id);
  }

  /** Every issue ever reported, a serial that only grows: a reader keeps how far it has read (`simHost.ts`), DO NOT read the kept list's length, which stops at 512. */
  issuesReported = 0;

  report(issue: AuditIssue): void {
    this.issuesReported++;
    this.issues.push(issue);
    if (this.issues.length > 512) this.issues.shift();
  }
}

/** The issues reported since a reader had read `sent` of them (`SimWorld.issuesReported`): the last ones still kept, however many came. */
export function issuesSince(w: Pick<SimWorld, 'issues' | 'issuesReported'>, sent: number): readonly AuditIssue[] {
  const fresh = Math.min(Math.max(0, w.issuesReported - sent), w.issues.length);
  return w.issues.slice(w.issues.length - fresh);
}

/** The junction a crossing is at (`makeCrossingId`). */
const crossingNode = (id: CrossingId): NodeId => Number(id.slice(0, id.indexOf(':'))) as NodeId;

/** What a controller's plan was made from (`SimWorld.planInputsOf`). */
interface PlanInputs {
  readonly groups: JunctionTopology['groups'];
  readonly connectors: readonly (Connector | undefined)[];
  readonly signalised: boolean;
  readonly crossings: string;
  readonly settings: string;
}

/** The player's settings of a signal as one string, field by field (`SignalSettings`). */
function settingsKey(s: SignalSettings | undefined): string {
  if (!s) return '';
  return `${s.mode ?? '-'}|${s.greens?.join(',') ?? '-'}|${s.offset ?? '-'}|${s.busPriority ? 1 : 0}`;
}

function samePlanInputs(a: PlanInputs, b: PlanInputs): boolean {
  if (a.groups !== b.groups || a.signalised !== b.signalised || a.crossings !== b.crossings || a.settings !== b.settings) return false;
  if (a.connectors.length !== b.connectors.length) return false;
  for (let i = 0; i < a.connectors.length; i++) if (a.connectors[i] !== b.connectors[i]) return false;
  return true;
}

/** A Map that counts its changes of membership, for caches over it, and keeps its values in the order of their keys */
class VersionedMap<K extends number, V> extends Map<K, V> {
  version = 0;
  /** Told of each value put in, replaced (`was`) or taken out. */
  constructor(private readonly listener?: { set(value: V, was: V | undefined): void; delete(value: V): void; clear(): void }) {
    super();
  }
  private orderedKeys: K[] = [];
  private ordered: V[] = [];
  /** The list was handed out: the next change copies it first. */
  private shared = false;

  override set(key: K, value: V): this {
    this.version++;
    const had = super.has(key);
    const was = had ? super.get(key) : undefined;
    super.set(key, value);
    this.listener?.set(value, was);
    this.own();
    const keys = this.orderedKeys;
    const at = had ? slotOf(keys, key) : keys.length && keys[keys.length - 1]! >= key ? slotOf(keys, key) : keys.length;
    if (had) this.ordered[at] = value;
    else { keys.splice(at, 0, key); this.ordered.splice(at, 0, value); }
    return this;
  }
  override delete(key: K): boolean {
    this.version++;
    const was = super.get(key);
    const had = super.delete(key);
    if (had) {
      this.listener?.delete(was as V);
      this.own();
      const at = slotOf(this.orderedKeys, key);
      this.orderedKeys.splice(at, 1);
      this.ordered.splice(at, 1);
    }
    return had;
  }
  override clear(): void {
    this.version++;
    super.clear();
    this.listener?.clear();
    this.orderedKeys = [];
    this.ordered = [];
    this.shared = false;
  }

  /** The values in the order of their keys; the array is never changed after it is handed out. */
  inKeyOrder(): readonly V[] {
    this.shared = true;
    return this.ordered;
  }

  private own(): void {
    if (!this.shared) return;
    this.orderedKeys = this.orderedKeys.slice();
    this.ordered = this.ordered.slice();
    this.shared = false;
  }
}

/** Where `key` is, or would go, in ascending `keys` (the first not below it). */
function slotOf<K extends number>(keys: readonly K[], key: K): number {
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]! < key) lo = mid + 1; else hi = mid;
  }
  return lo;
}
