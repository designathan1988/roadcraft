import { Rng } from '@core/rng';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { type Connector, type Lanelet, type LaneletId, LaneletGraph } from '@world/lanelets';
import { ConflictIndex, type BodyClass, type WAITING } from '@world/conflictPoints';
import type { PairMeasurer } from '@world/conflictTable';
import { SimClock } from './clock';
import { ClaimTable } from './intersections/claims';
import type { Vehicle, VehicleId } from './vehicles/state';
import { type SignalController, type SignalDeps, createController, rebuildController, seekFixed } from './signals/fsm';
import { type CrossingId, makeCrossingId } from './signals/plan';
import type { AuditIssue } from './audit';
import { SidewalkGraph } from './peds/sidewalk';
import { hasDownstreamStorage } from './intersections/spillback';
import { CrossingSpans } from './intersections/crossingSpans';
import { m } from '@world/units';
import { DT } from './params';

/** How far before its line a bus asks for priority, world units (V5). */
const BUS_REACH = m(90);

/** What the signals read of the world (`SignalDeps`), and the reservations by node, which wake a sleeping one (`SimWorld.signalsAsleep`). */
export type WorldSignalDeps = SignalDeps & { readonly reserved: () => ReadonlyMap<NodeId, ReadonlySet<number>> };
import type { CrossingStates } from './crossings/state';
import type { PedView } from './people/view';
import type { PedestrianEngine } from './people/engine';
import { City } from './city/city';
import { AmbientWorld } from './ambient/ambient';
import { buildWalkways, walkwaySteps, type WalkGraph } from '@world/walkways';
import { mainRoadLegs } from '@world/roads/rules';
import { FlowStats } from './roads/flowStats';
import { type AutoControl, ControlAdvisor } from './roads/controlAdvisor';
import { rebuildWork } from '@world/rebuildWork';
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
  /**
   * Vehicles whose body still overlaps this lane while they slide out of it.
   * A lane change moves a vehicle's occupancy to the new lane at once, but its
   * body crosses the gap over the next second; until it has, anyone behind it
   * in the lane it is leaving must still see it. See `Vehicle.shadow`.
   */
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

/**
 * Everything the simulation owns.
 *
 * Read-only access to `world` topology, mutable agent state, and the indices
 * that make both cheap. Nothing here imports from `render`, `editor` or `ui`,
 * and a source scan in `tests/arch` enforces it.
 */
export class SimWorld {
  readonly clock = new SimClock();
  readonly graph = new LaneletGraph();
  readonly conflicts = new ConflictIndex();
  readonly sidewalks = new SidewalkGraph();
  readonly claims = new ClaimTable();

  /** @mapWide Every vehicle on the map. */
  readonly vehicles = new VersionedMap<VehicleId, Vehicle>();
  /**
   * What moves the people (`people/engine.ts`); everything else reaches them
   * through it. The game installs the agents' walking engine as it opens
   * (`main.ts`, `agents/walk.ts`); until one is installed nobody walks (the
   * null engine, Nystrom's "null service").
   */
  pedEngine: PedestrianEngine = NO_PEDESTRIANS;
  /**
   * The vehicle model: Drive v2 (`drive/*`), the only one (the plain-IDM
   * legacy model was taken out on 2026-10-08). Kept as a field so the specs
   * that set it still read as they did.
   */
  driveModel = 'v2' as const;
  /** @mapWide One per lanelet a vehicle (or its shadow) has been on; written only through `runtimeFor`. */
  readonly runtime = new Map<LaneletId, LaneletRuntime>();
  readonly controllers = new Map<NodeId, SignalController>();
  /**
   * DOING LESS (docs/relatorio-desempenho-mapas-enormes-2026-10-11.md 5.1,
   * phase 1): the work of a tick follows what moves, not the map. On, a tick
   * visits only the lanes that hold a vehicle (`occupied`), the lanes left
   * behind by an edit (`ghostCandidates`), and the signals that can change
   * (a junction with nobody near rests in its green). Off, every lane, every
   * junction and every signal each tick, as before: the oracle the result is
   * held to, tick by tick (`tests/sim/doLess.spec.ts`).
   */
  doLess = true;
  /** Lanes with a vehicle on them: written only by `enterLanelet`/`exitLanelet`, the only writers of `order`. */
  readonly occupied = new Set<LaneletId>();
  /** Runtime lanes no longer in the graph (an edit took them): stage 7's work list (`collectGhosts`). */
  readonly ghostCandidates = new Set<LaneletId>();
  /**
   * Signals asleep (`signalsAsleep`): rested in green with nobody near on
   * their last step. Stage 1 only keeps their time until somebody comes.
   */
  private readonly asleep = new Set<SignalController>();
  private asleepSince = { revision: -1, junctions: -1 };

  /**
   * What vehicles, signals and the audit may know about the people at each
   * crossing (`crossings/state.ts`). Published by the pedestrian engine at the
   * end of its stage; the only pedestrian state read outside it.
   * @mapWide One per crossing of the map.
   */
  readonly crossingStates: CrossingStates = new Map();
  /**
   * Every person as the renderer and the counters see them (`people/view.ts`),
   * in id order, published at the end of each tick. The object for an id lives
   * as long as the person.
   * @mapWide Every person on the map.
   */
  readonly pedViews: PedView[] = [];
  /** @mapWide Every person on the map, by id. */
  readonly pedViewById = new Map<number, PedView>();
  /** Stretch of each zebra that each movement drives over. */
  readonly crossingSpans = new CrossingSpans();

  /**
   * Tick at which each junction last admitted a vehicle.
   *
   * This is what separates congestion from a wedge. A vehicle waiting its turn
   * at a junction that keeps admitting others is queued, and FIFO priority
   * guarantees its turn arrives. A junction that has admitted nobody for cycles
   * is genuinely stuck.
   */
  readonly lastAdmission = new Map<NodeId, number>();
  /**
   * The lane that last sent a vehicle into each lane two or more lanes merge
   * into, for the zipper (`zipperHolds` in `intersections/admission.ts`).
   */
  readonly mergeTurn = new Map<LaneletId, LaneletId>();
  /** Cumulative link entries since the current simulation session began. */
  readonly segmentVolume = new Map<number, number>();
  /** Vehicles an hour into each junction from each leg, as a trend (docs/VIAS.md V5). */
  get flow(): FlowStats { return this.flowStats; }
  private flowStats = new FlowStats();
  /** The control each junction left on "automatic" gets from its flows (docs/VIAS.md V5). */
  get advisor(): ControlAdvisor { return this.controlAdvisor; }
  private controlAdvisor = new ControlAdvisor();

  /** The world's random streams, forked from its seed (`reset` forks them again). */
  get rng(): SimStreams { return this.streams; }
  private streams: SimStreams;

  nextVehicleId = 1;
  /** Per-world population timer; simulations must never influence each other. */
  vehicleSpawnClock = 0;
  /**
   * Traffic waiting to come in at each boundary entry lane: when its next
   * arrival is due, and the arrival times of vehicles held outside the map
   * because the entry was full (`sim/vehicles/spawn.ts`).
   */
  /** Per entry: the next arrival, the rate it was drawn at, and the arrivals waiting outside. */
  readonly entryDemand = new Map<LaneletId, { next: number; rate: number; waiting: number[] }>();
  /** Arrivals turned away because an entry's outside queue was full. */
  entryDemandLost = 0;
  /** Vehicles that reached the boundary exit chosen for their trip. */
  completedTrips = 0;
  /** User-facing density multipliers; topology and physics remain unchanged. */
  trafficIntensity = 1;
  pedestrianIntensity = 1;
  /**
   * How many cars and how many people on foot the player wants on the map
   * (the panel's Traffic and People, `main.ts`). Set, a map opened is filled
   * with them at once (`ambient/ambient.ts` open); then they come in at the
   * ends of the roads and out of the lots, and leave at a road's end or into
   * a lot (`vehicles/spawn.ts` stepDispatch, `agents/lotTraffic.ts`,
   * `ambient/ambient.ts` edgePeople);
   * null (tests, harnesses), the arrival rates of `trafficIntensity` and the
   * density ceiling rule as before.
   */
  trafficCount: number | null = null;
  pedestrianCount: number | null = null;
  /**
   * The game's way (`main.ts`): the panel's Traffic and People are shares of
   * the city's own density (`trafficIntensity`, `pedestrianIntensity`, 1 =
   * 100 %), and the map is kept at the numbers they make, as with a count -
   * one car per `TRAFFIC_DENSITY` of road times the demand, the lots' street
   * tables for people (`vehicles/spawn.ts` chosenTraffic, `ambient.ts`
   * peopleTarget). A fixed count of 10 left every city empty whatever its
   * size (docs/investigacao-populacao.md, 2026-10-11): the numbers follow
   * the city now, with no ceiling but the engine's.
   */
  followCity = false;
  /** Shared demand multiplier for the current simulation period. */
  demandMultiplier = 1;
  /**
   * Traffic from outside: cars at the map's edge entries, people at doors and
   * road ends (set by `City.step`).
   */
  edgeTraffic = true;
  /** The city's services - the time of day, the public transport (`sim/city/city.ts`) - stepped by the pipeline. */
  readonly city = new City();
  /** The life of the scenery: people and traffic made round the view (`sim/ambient`). */
  readonly ambient = new AmbientWorld();
  /**
   * Share of the population ceilings this device carries (1, or
   * `NARROW_SCREEN_SHARE` on a narrow screen). SET BY THE COMPOSITION ROOT:
   * the spawners used to read `window.innerWidth` themselves, which put the
   * DOM inside `sim` and made the same seed grow a different city on a phone.
   */
  populationShare = 1;
  /**
   * Where the player is looking, world units, and whether people there are
   * drawn large enough to see how they step round each other. SET BY THE
   * RENDERER each frame; null (tests, harnesses) simulates everybody in full.
   * Out of it, people still follow their routes and keep off walls, but skip
   * negotiating with each other (`sim/people`): nobody can see that, and it
   * was most of a frame's simulation in a town.
   */
  focus: {
    readonly x: number; readonly y: number; readonly r: number; readonly detail: boolean;
    /**
     * Playing (`play.ts`), the camera looks along the ground from behind the
     * player and sees far down the street, past `r`: its eye, the way it
     * looks (unit), the cosine of half its width with a margin, and how far
     * anybody is still drawn big enough to notice. What is made or taken away
     * (`ambient/ambient.ts`) is made or taken away outside this cone, as GTA
     * spawns and culls off screen. Null in the view from above.
     */
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
  ) {
    this.streams = forkStreams(seed);
  }

  /**
   * Switches the model that moves the people. Everybody walking is dropped:
   * the two engines share no state, only what they publish.
   */
  usePedestrianEngine(engine: PedestrianEngine): void {
    this.crossingStates.clear();
    this.pedViews.length = 0;
    this.pedViewById.clear();
    this.pedEngine = engine;
    engine.rebind(this);
  }

  /**
   * Forgets every agent and everything learned about the previous map.
   *
   * For loading a DIFFERENT document (open, import, new map). Lanelet and
   * footway ids are built from small integers and coincide between maps, so
   * rebinding after a load kept old vehicles - with their routes, claims and
   * kerb stops - on unrelated roads of the new map, and carried issues,
   * volumes and trip counts across. Undo and redo keep rebinding: they edit
   * the same map. The world is then a new world with the same seed
   * (`tests/sim/resetLikeNew.spec.ts`; the scenery's own reset is
   * `AmbientWorld.reset`), but for three things kept on purpose: the
   * settings, the clock (the city's hour, `City.minutes`) and the ids still
   * to give (`nextVehicleId`: the renderer keeps a car's look by its id, and
   * an id given again would dress a new car as an old one).
   */
  reset(): void {
    this.vehicles.clear();
    this.runtime.clear();
    this.claims.clear();
    this.controllers.clear();
    this.junctionsVersion++;
    this.occupied.clear();
    this.ghostCandidates.clear();
    this.asleep.clear();
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
    // As a new world with the same seed: the junctions' flows and the
    // controls chosen from them were the old map's (node ids coincide between
    // maps), and the random streams start again from the seed. DO NOT keep
    // them: the advisor turned the new map's junctions to signals it had
    // measured on the old one, and the same map opened twice ran two
    // different cities.
    this.flowStats = new FlowStats();
    this.controlAdvisor = new ControlAdvisor();
    this.streams = forkStreams(this.seed);
    this.pedEngine.reset(this);
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

  /**
   * A lane's occupants, to read. A lane nobody has been on answers the
   * shared empty runtime (`NO_RUNTIME`, Nystrom's null service): frozen, so
   * a write through it throws instead of being lost. DO NOT create the
   * runtime here: routing, lane changes and the inspector read every lane
   * they look at through this, and each read used to leave a runtime behind
   * (a lane id gone from the graph a ghost candidate too) - the map grew to
   * one per lane looked at, all of them walked by the full cleanup and audit.
   * Writers go through `runtimeFor` (TC39 upsert: `get` reads, `getOrInsert` writes).
   */
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

  /** Deterministic iteration order for any pass with cross-agent effects. */
  //
  // Sorted once per change of the fleet, not on every call: a tick asked for
  // it about ten times, each a copy and a sort. The array handed out is never
  // changed afterwards - a change of the fleet makes a new one - so a pass
  // that adds or removes vehicles while walking it walks what it was given.
  vehiclesInIdOrder(): readonly Vehicle[] {
    if (this.vehicleOrder.version !== this.vehicles.version) {
      this.vehicleOrder = { version: this.vehicles.version, list: [...this.vehicles.values()].sort((a, b) => a.id - b.id) };
    }
    return this.vehicleOrder.list;
  }
  private vehicleOrder: { version: number; list: readonly Vehicle[] } = { version: -1, list: [] };

  junctionNodesInOrder(): readonly NodeId[] {
    if (this.junctionOrder.version !== this.junctionsVersion) this.refreshJunctionOrder();
    return this.junctionOrder.nodes;
  }

  /** The controllers stage 1 runs, in node order: those of the signalised junctions. */
  signalisedControllers(): readonly SignalController[] {
    if (this.junctionOrder.version !== this.junctionsVersion) this.refreshJunctionOrder();
    return this.junctionOrder.signalised;
  }

  /**
   * Moves whenever the junctions or their controllers do (a topology rebuild,
   * a control the advisor switched): the node order and the signalised list
   * were sorted and looked up afresh every tick, for every junction of the map.
   */
  private junctionsVersion = 0;
  private junctionOrder: {
    version: number; nodes: readonly NodeId[]; signalised: readonly SignalController[];
    /** The junction each approach lane leads into (`junctionsApproached`). */
    junctionOf: ReadonlyMap<LaneletId, NodeId>;
    /** The signal each approach lane and each crossing of a plan belongs to: what wakes it (`signalsAsleep`). */
    approachOf: ReadonlyMap<LaneletId, SignalController>; crossingOf: ReadonlyMap<CrossingId, readonly SignalController[]>;
  } = { version: -1, nodes: [], signalised: [], junctionOf: new Map(), approachOf: new Map(), crossingOf: new Map() };
  private refreshJunctionOrder(): void {
    const nodes = [...this.graph.junctions.keys()].sort((a, b) => a - b);
    rebuildWork.lanes += nodes.length;
    const signalised: SignalController[] = [];
    const junctionOf = new Map<LaneletId, NodeId>();
    const approachOf = new Map<LaneletId, SignalController>();
    const crossingOf = new Map<CrossingId, SignalController[]>();
    for (const node of nodes) {
      const c = this.controllers.get(node);
      const junction = this.graph.junctions.get(node);
      for (const lane of junction?.inbound ?? []) junctionOf.set(lane, node);
      if (!c || !junction?.signalised) continue;
      signalised.push(c);
      for (const lane of junction.inbound) approachOf.set(lane, c);
      for (const stage of c.plan.stages) {
        for (const x of stage.pedWalk) {
          const of = crossingOf.get(x);
          if (!of) crossingOf.set(x, [c]);
          else if (!of.includes(c)) of.push(c);
        }
      }
    }
    this.junctionOrder = { version: this.junctionsVersion, nodes, signalised, junctionOf, approachOf, crossingOf };
  }

  /**
   * The junctions with a vehicle on one of their approaches, in node order:
   * the only ones with a lane head to admit (`laneHead` reads `order`, which
   * only `occupied` lanes have). Stage 5 looked at every approach of every
   * junction of the map each tick (phase 1). Written into one list, kept.
   */
  junctionsApproached(): readonly NodeId[] {
    if (this.junctionOrder.version !== this.junctionsVersion) this.refreshJunctionOrder();
    const { junctionOf } = this.junctionOrder;
    const out = this.approached, seen = this.approachedSeen;
    seen.clear();
    let n = 0;
    for (const lane of this.occupied) {
      const node = junctionOf.get(lane);
      if (node === undefined || seen.has(node)) continue;
      seen.add(node);
      out[n++] = node;
    }
    out.length = n;
    return out.sort((a, b) => a - b);
  }
  private readonly approached: NodeId[] = [];
  private readonly approachedSeen = new Set<NodeId>();

  /**
   * The signals stage 1 lets sleep this tick (SUMO schedules an actuated
   * signal's next look instead of asking it every step,
   * `MSActuatedTrafficLightLogic::trySwitch`). Asleep: it rested in green
   * with nobody near (`stepController` true), and nothing its rest reads
   * has changed since - every answer of `junctionQuiet`, every crossing it
   * reads (`pedestriansCrossing`), its settings. Woken here, from what is
   * busy rather than from the map: a vehicle on one of its approaches
   * (`occupied`), somebody on or at one of its crossings (`crossingStates`
   * holds only those), a reservation for it; and all of them by an edit or a
   * rebuilt topology. Off (`doLess` false), none sleeps.
   */
  signalsAsleep(deps: WorldSignalDeps): Set<SignalController> {
    const asleep = this.asleep;
    if (!this.doLess || this.asleepSince.revision !== this.doc.revision || this.asleepSince.junctions !== this.junctionsVersion) {
      asleep.clear();
      this.asleepSince = { revision: this.doc.revision, junctions: this.junctionsVersion };
    }
    if (asleep.size === 0) return asleep;
    if (this.junctionOrder.version !== this.junctionsVersion) this.refreshJunctionOrder();
    const { approachOf, crossingOf } = this.junctionOrder;
    for (const lane of this.occupied) {
      const c = approachOf.get(lane);
      if (c) asleep.delete(c);
    }
    for (const x of this.crossingStates.keys()) {
      for (const c of crossingOf.get(x) ?? []) asleep.delete(c);
    }
    for (const node of deps.reserved().keys()) {
      const c = this.controllers.get(node);
      if (c) asleep.delete(c);
    }
    return asleep;
  }

  // -------------------------------------------------------------- topology

  /**
   * Rebuilds every derived index from the current network geometry.
   * @rebuild Called when the network's traffic revision moved.
   */
  rebuildTopology(): void {
    this.rebuildVehicleTopology();
    this.rebuildWalkTopology();
  }

  /**
   * The first half of `rebuildTopology`: lanelets, conflict zones, claims and
   * the signal controllers - what the vehicles run on.
   *
   * The two halves can run in consecutive frames while the simulation is held
   * (`main.ts`), so an edit is never one long stall of both: measured on the
   * player map, the conflict zones and the footway graph each cost up to about
   * 110 ms. The world is not stepped until the second half has run.
   */
  /**
   * A second lanelet graph, built from the same document, that is never run:
   * `prepareVehicleTopology` measures the conflict zones of an edit on it
   * while this world keeps the graph its agents are bound to. It keeps its
   * own caches, so building it again after an edit costs what the edit
   * touched.
   */
  private prepGraph: LaneletGraph | null = null;

  /**
   * The slow half of `rebuildVehicleTopology` ahead of time, in steps: the
   * conflict zones of every new pair of movements measured into the caches
   * (`ConflictIndex.prepare`). Nothing the agents read changes; the rebuild
   * that follows reads every pair back. A new crossroads used to stall the
   * frame of its rebuild about a tenth of a second.
   * @rebuild Run while the topology is behind the network (`frameLoop.ts` `TopologyCatchUp`).
   */
  *prepareVehicleTopology(measurer?: PairMeasurer): Generator<void | typeof WAITING, void> {
    const graph = this.prepGraph ??= new LaneletGraph();
    yield* graph.buildSteps(this.doc, this.net);
    yield;
    // The new pairs measured by `measurer`'s workers when there are some (`conflictPool.ts`).
    yield* this.conflicts.prepare(graph, measurer);
    yield;
    // The residents' walkways of the network (`walkways`), in a frame of their
    // own: built in the frame that rebinds the walkers, with the footway graph
    // and the crossings, they made it a stall of 170 ms in the default town
    // (docs/performance.md #11).
    if (!this.walkwaysCache || this.walkwaysCache.revision !== this.net.revision) {
      const revision = this.net.revision;
      const graph = yield* walkwaySteps(this.net);
      this.walkwaysCache = { revision, graph };
    }
  }

  private walkwaysCache: { revision: number; graph: WalkGraph } | null = null;
  /** The walkways of the network at `revision` (`world/walkways.ts`), built once per revision. */
  walkwaysFor(revision: number): WalkGraph {
    if (!this.walkwaysCache || this.walkwaysCache.revision !== revision) {
      this.walkwaysCache = { revision, graph: buildWalkways(this.net) };
    }
    return this.walkwaysCache.graph;
  }

  /** Builds the preparation graph with a map's load, so its first edit does not build it from nothing. */
  warmTopologyPrep(): void {
    const graph = this.prepGraph ??= new LaneletGraph();
    if (graph.revision !== this.net.revision) graph.build(this.doc, this.net);
  }

  /** @rebuild Called when the network's traffic revision moved. */
  rebuildVehicleTopology(): void {
    // The links and junctions the preparation turned (`prepareVehicleTopology`).
    if (this.prepGraph && this.prepGraph.revision === this.net.revision) this.graph.seedCaches(this.prepGraph);
    this.graph.build(this.doc, this.net);
    this.conflicts.build(this.graph);
    this.claims.dropMissing(this.conflicts);
    this.syncControllers();
    for (const segment of [...this.segmentVolume.keys()]) {
      rebuildWork.lanes++;
      if (!this.doc.segment(segment as SegmentId)) this.segmentVolume.delete(segment);
    }
    this.vehicleTopologyRevision = this.net.trafficRevision;
    // The lanes the edit took, kept while vehicles still drive on them
    // (`collectGhosts`); and a ghost whose id is in the graph again (an undo
    // gives the same road the same lane ids) is a lane again, before the
    // vehicles are rebound and routed onto it. DO NOT leave this to stage 7:
    // the mark only ever went on, and a lane given back would stay dead to
    // routes, bays, lane changes, entry and spawning for good - and the
    // rebind right after this plans every route round a lane still marked.
    // (Today a vehicle on a lane gone is removed before stage 7 can mark it -
    // `rebindVehicles`, `integrateAll`, `stepDespawn` - so this is the guard
    // for the day one is kept, as the ghost's own comment intends.)
    for (const [id, rt] of this.runtime) {
      rebuildWork.lanes++;
      if (!this.graph.lanelets.has(id)) this.ghostCandidates.add(id);
      else if (rt.ghost) { rt.ghost = false; rt.ghostSince = 0; }
    }
    this.junctionsVersion++;
    // The controls the flows chose stay chosen across an edit (V5).
    const nodes = new Set(this.graph.junctions.keys());
    rebuildWork.lanes += nodes.size;
    this.flow.keepOnly(nodes);
    this.advisor.forget(nodes);
    if (this.applyAutoControl()) this.syncControllers();
  }

  /**
   * The control a junction on "automatic" runs (docs/VIAS.md V5): the
   * advisor's choice once it has spoken, else the game's geometric default
   * (`lanelets.ts` `shouldSignalise`). True when a junction's signal came or went.
   */
  private applyAutoControl(): boolean {
    let changed = false;
    for (const [node, junction] of this.graph.junctions) {
      rebuildWork.lanes++;
      if (this.doc.node(node)?.control !== 'auto') continue;
      const choice = this.advisor.choice(node);
      if (!choice) continue;
      const signalised = choice === 'signal';
      if (junction.signalised === signalised) continue;
      this.graph.junctions.set(node, { ...junction, signalised });
      this.junctionsVersion++;
      changed = true;
    }
    return changed;
  }

  /**
   * Stage 0's measuring of the junctions (docs/VIAS.md V5): the flows aged,
   * and every so often each junction on "automatic" given the control its
   * trend warrants. A change of signal rebuilds that junction's controller.
   */
  stepControlAdvisor(dt: number): void {
    this.flow.step(dt);
    if (!this.advisor.tick(dt)) return;
    let changed = false;
    for (const [node, junction] of this.graph.junctions) {
      const n = this.doc.node(node);
      if (!n || n.control !== 'auto' || n.incident.length < 3) continue;
      const main = mainRoadLegs(this.doc, node);
      let major = 0, minorMax = 0, minorTotal = 0;
      for (const seg of n.incident) {
        const rate = this.flow.rate(node, seg);
        if (main?.includes(seg)) major += rate;
        else { minorMax = Math.max(minorMax, rate); minorTotal += rate; }
      }
      const initial: AutoControl = junction.signalised ? 'signal' : 'priority';
      changed = this.advisor.evaluate(node, major, minorMax, minorTotal, initial, this.flow.measured) || changed;
    }
    if (changed && this.applyAutoControl()) this.syncControllers();
  }

  /**
   * The second half: the footway graph and its crossings, and the controllers
   * again, which give crossings their pedestrian phases. Completes the
   * topology for `topologyRevision`.
   */
  rebuildWalkTopology(): void {
    const steps = this.walkTopologySteps();
    let step = steps.next();
    while (!step.done) step = steps.next();
  }

  /**
   * `rebuildWalkTopology` in steps (`SidewalkGraph.buildSteps`); the world is held until the last.
   * @rebuild Run while the topology is behind the network (`frameLoop.ts` `TopologyCatchUp`).
   */
  *walkTopologySteps(): Generator<void, void, void> {
    if (this.vehicleTopologyRevision !== this.net.trafficRevision) this.rebuildVehicleTopology();
    yield* this.sidewalks.buildSteps(this.doc, this.net, this.graph);
    yield;
    this.crossingSpans.build(this);
    this.syncControllers();
    this.topologyRevision = this.net.trafficRevision;
  }

  /** Crossing ids at a node, one per incident segment. */
  crossingsAt(node: NodeId): CrossingId[] {
    const n = this.doc.node(node);
    // A junction, or a mid-block crossing (a two-road node the player put one
    // on): without it a signal crossing's plan held no crossing at all, and its
    // single stage never stopped the cars for anybody.
    if (!n || (n.incident.length < 3 && !(n.crossing && n.incident.length === 2))) return [];
    return n.incident
      .slice()
      .sort((a, b) => a - b)
      .map((seg) => makeCrossingId(node, seg))
      .filter((id) => this.sidewalks.crossings.has(id));
  }

  /**
   * What the signal controllers read about the world, for one pass over them.
   *
   * Its answers made afresh at the top of every step (`pipeline.ts`), before
   * anything else moves, so answers that only read the world can be kept for
   * the rest of the pass. They are: the controllers asked for the same
   * demand, per stage and per group, over and over, and the reservation
   * question scanned the whole fleet on every one of those asks. Nothing here
   * is keyed on the clock, which does not advance when a test drives `step`
   * directly. The object and its functions are kept: only the answers go
   * (phase 1, nothing made per step that a step does not need).
   */
  signalDeps(): WorldSignalDeps {
    const kept = (this.keptSignalDeps ??= this.makeSignalDeps());
    kept.fresh();
    return kept.deps;
  }
  private keptSignalDeps: { readonly deps: WorldSignalDeps; readonly fresh: () => void } | null = null;

  private makeSignalDeps(): { readonly deps: WorldSignalDeps; readonly fresh: () => void } {
    // Kept by the node and the very arrays asked about (a plan's stages hand
    // the same `greenGroups` and `demandMovements` every time): a key string
    // joined from them on every ask was most of the controllers' time on a
    // quiet map (audit, 2026-10-09). An array made afresh by a caller only
    // misses the memo; the answer is the same.
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
      for (const vehicle of this.vehicles.values()) {
        const lane = this.lanelet(vehicle.lanelet);
        const ownsAllocation =
          vehicle.admittedConnector !== null ||
          vehicle.clearingConnectors.length > 0 ||
          lane?.kind === 'connector';
        if (!ownsAllocation) continue;
        // A soft Banker's intent does not occupy its future junctions. Only
        // expedite the movement the physical holder must acquire next;
        // advertising the whole chain starves unrelated stages several nodes
        // before the vehicle can reach them.
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
      // Each stage's yellow is timed for the fastest approach it releases
      // (ITE kinematic equation, `plan.ts` `withAmbers`).
      approachSpeed: (lane: string) => this.graph.lanelets.get(lane)?.speedLimit ?? 0,
      // Conflicts between two CARS. A tail swing only a bus or a truck can
      // make is serialised by the claim table as the bus arrives; letting it
      // split two approaches into separate stages would halve their green for
      // a vehicle that is one in forty.
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

  /**
   * What a green for these groups would actually serve right now.
   *
   * The detector used to be "is any vehicle anywhere on an approach link",
   * which on a 400-unit block is true almost always: no stage ever gapped out,
   * every stage ran to its target, and every cycle was the same length however
   * light the traffic. This reads the queue the way a loop detector and a
   * driver's eye do:
   *
   *   - `active`: the head of some lane is at the line or will reach it within
   *     the passage time, wants a movement this green serves, and has room to
   *     leave on the far side. While this is zero a green is wasted;
   *   - `score`: queue length, time already waited, and arrivals weighted by how
   *     soon they will be there. Used to pick which stage runs next.
   *
   * Vehicles whose exit is full do not count: a green for them discharges
   * nobody (capacity after the junction).
   */
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

  /**
   * Whether a bus is on an approach of `node`, within reach of its line,
   * bound for a movement of one of these signal groups (V5, bus priority).
   * Read from the vehicles on the junction's approaches (the links into it,
   * `inbound`), not the whole fleet: asked by every bus-priority signal at
   * every tick (phase 1, docs/relatorio-desempenho-mapas-enormes-2026-10-11.md).
   */
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

  private syncControllers(): void {
    const deps = this.signalDeps();

    for (const [node, junction] of this.graph.junctions) {
      rebuildWork.signals++;
      const crossings = this.crossingsAt(node);
      const existing = this.controllers.get(node);
      const settings = this.doc.node(node)?.signal;
      if (existing) {
        rebuildController(existing, junction, crossings, deps);
        // A fixed-time signal back where the common clock says, with its offset (V5).
        if (settings?.mode === 'fixed') seekFixed(existing, settings, this.tickCount() * DT);
      } else {
        // A deterministic per-node offset so neighbouring junctions do not all
        // switch together.
        const offset = (node * 7.317) % 60;
        const created = createController(junction, crossings, deps, offset);
        if (settings?.mode === 'fixed') seekFixed(created, settings, this.tickCount() * DT);
        this.controllers.set(node, created);
      }
    }

    for (const node of [...this.controllers.keys()]) {
      if (!this.graph.junctions.has(node)) {
        this.controllers.delete(node);
      }
    }
    this.junctionsVersion++;
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

  /**
   * Every body in a lane with its front arc position there: the occupants, the
   * vehicles still sliding out of it, projected onto its centreline, and the
   * tails of vehicles whose front has already moved on to the next lanelet.
   */
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
    this.clearShadow(v);
    this.exitLanelet(v, v.lanelet);
    this.claims.releaseAll(v.id);
    this.vehicles.delete(v.id);
  }

  report(issue: AuditIssue): void {
    this.issues.push(issue);
    if (this.issues.length > 512) this.issues.shift();
  }
}

/** A Map that counts its changes of membership, for caches over it (`vehiclesInIdOrder`). */
export class VersionedMap<K, V> extends Map<K, V> {
  version = 0;
  override set(key: K, value: V): this {
    this.version++;
    return super.set(key, value);
  }
  override delete(key: K): boolean {
    this.version++;
    return super.delete(key);
  }
  override clear(): void {
    this.version++;
    super.clear();
  }
}
