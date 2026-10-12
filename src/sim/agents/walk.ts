import { Heap } from '@core/heap';
import { chartAt, chartToChartInto } from '@world/planet/charts';
import type { Vec2 } from '@core/vec2';
import { newFrame } from '@core/polyline';
import type { WalkGraph, Walkway } from '@world/walkways';
import { m } from '@world/units';
import type { SegmentId } from '@world/ids';
import { DT, PED } from '../params';
import { newPose, vehiclePoseNowInto } from '../pose';
import type { SimWorld } from '../world';
import type { AuditIssue } from '../audit';
import { emptyCrossingState } from '../crossings/state';
import { indexReservations, mayEnterCrossing } from '../crossings/permission';
import { makeCrossingId, type CrossingId } from '../signals/plan';
import type { SidewalkEdge } from '../peds/sidewalk';
import { type BodyPart, type GestureKind, personHash, type PedView, type PersonAgeClass, type PersonGender, type Severable } from '../people/view';
import type { PedestrianEngine, PeopleBridge, ResidentWalk } from '../people/engine';
import { recordCasualty, recordWound } from '../people/casualties';
import type { FreePose, Vehicle } from '../vehicles/state';

/**
 * The agents' walking: people on lanes of the footways, as SUMO's striping
 * model walks them (sumo.dlr.de, "Pedestrians": a footway cut into stripes;
 * each person takes the stripe with the most room ahead, keeps right of
 * somebody coming the other way, and walks as fast as that room allows).
 *
 * The ground is `world/walkways.ts`: footways down the middle of each
 * footway's through zone, corners round each junction, crossings on the
 * zebras, each with the lateral room a walker may use either side of it
 * (`lo`/`hi`). A walker's route is a chain of those walkways found by
 * shortest path. Along it:
 *
 * - the stripe (`aim`, the offset left of the way walked) is the one with the
 *   most free distance ahead (the room to the next body in it, halved for
 *   somebody coming the other way), with a pull to the right; a walker held
 *   up steps aside into it, no faster than a person sidesteps;
 * - the speed is what the room ahead in its own stripe allows, a person
 *   following another at a step's distance;
 * - the body walks towards a point a step or so ahead on its route, in its
 *   stripe, turning at a person's turn rate and only ever moving the way it
 *   faces (a pure pursuit, the path follower of Reynolds' "Steering Behaviors
 *   for Autonomous Characters"): it never jumps, never slides sideways and
 *   never steps backwards, and it rounds a corner instead of snapping to it;
 * - at a zebra it stands at the kerb until the crossing is theirs by the rule
 *   every pedestrian keeps (`crossings/permission.ts`: the signal, or a gap in
 *   the traffic), and while on it is published to the vehicles
 *   (`SimWorld.crossingStates`), which stop for it;
 * - a car parked off the road (the scenery's, `sim/ambient`) is solid;
 * - somebody held still a long while (`JAM_AFTER`) is let through others
 *   slowly, as SUMO's jammed state does, so nobody is ever stuck for good.
 *
 * Who walks here is the scenery's life (`sim/ambient`): people coming in at
 * the ends of the roads and walking the footways. The residents, who walked
 * here from door to door and to and from their own cars, are kept apart in
 * `src/backup/residents`.
 */

/** Width of one stripe, world units: SUMO's default, a person's room abreast. */
const STRIPE = m(0.65);
/** A body's radius: two people closer than twice this, side by side, touch. */
const BODY = m(0.27);
/** Two people this far apart side by side pass each other, u. */
const SHOULDERS = m(0.5);
/** Fastest a body steps sideways, u/s. */
export const SIDESTEP = m(0.45);
/** How far ahead others are looked for. */
const LOOK = m(8);
/** Faster than this, somebody is walking (coming the other way, say), u/s. */
const MOVING = m(0.1);
/** The gap a walker keeps to the body ahead, and the time headway behind it. */
const KEEP = m(0.45);
const HEADWAY = 0.5;
/** Acceleration and braking of a walker, u/s². */
const ACCEL = m(1.2);
const BRAKE = m(2.5);
/** A new stripe must be this much better to be taken: no dithering between two. */
const SWITCH_GAIN = m(1.2);
/** Seconds a stripe just taken is kept, unless it shuts. */
const AIM_HOLD = 0.6;
/** Held still this long, a quarter of that will do. */
const HELD_SWITCH = 0.5;
/** Room given up for each unit across from where the body is: SUMO's LATERAL_PENALTY, a metre a stripe. */
const LATERAL_PENALTY = m(1) / STRIPE;
/** Held still this long, a walker is let through others slowly (SUMO's jamtime: 10 s on a crossing). */
const JAM_AFTER = 20;
const JAM_AFTER_CROSSING = 10;
/**
 * Where only one person fits abreast - a lot's path and its gate - SUMO's
 * `pedestrian.striping.jamtime.narrow`, 1 s: two people meeting there pass
 * each other slowly at once instead of standing nose to nose.
 */
const JAM_AFTER_NARROW = 1;
/**
 * Face to face and getting no further along the way for this long, s, a
 * walker is let through as jammed whatever its side steps do: in a group
 * coming the other way every step aside found another of them, each step
 * cleared the time held, and a walker danced 7 s on the spot (one-way-mix,
 * 2026-10-11). Progress is what `jamtime` measures in SUMO, not stillness.
 */
const JAM_NO_PROGRESS = JAM_AFTER_NARROW;
/** Getting this much further along the way is progress (`JAM_NO_PROGRESS`), u. */
const PROGRESS = m(0.1);
/** Speed of a jammed walker, as a share of their own. */
const JAM_SHARE = 0.25;
/** How far ahead on the route the body walks towards, u. */
const AHEAD = m(0.9);
/** How far ahead, at most, inside a lot and through its gate (`target`). */
const LOT_AHEAD = m(0.35);
/** Most a walker moves across towards its stripe, as a share of its forward speed (SUMO's LATERAL_SPEED_FACTOR). */
const LATERAL_SHARE = 0.4;
/**
 * Slower than this a walker faces the way its walk goes and steps aside
 * sideways, unless the point it walks to is more than `SHUFFLE_COS` round
 * (45 degrees): a corner. The defect counted standing or at a shuffle
 * (0.15 m/s, `defects.spec` fidgets); 0.25 m/s covers it.
 */
const SHUFFLE = m(0.25);
const SHUFFLE_COS = Math.SQRT1_2;
/** Fastest a body turns walking, and standing (on the spot), rad/s. */
const TURN_RATE = 3.5;
const TURN_STANDING = 6;
/** Extra cost of a crossing on a route, u: a zebra is walked to only when worth it. */
const CROSSING_COST = m(12);
/** Where a walker stands to wait: this far back from the kerb. */
const KERB_BACK = m(0.35);
/** A walker this far from the waiting place starts asking whether they may cross. */
const ASK_FROM = m(1.5);
/**
 * Behind somebody waiting for the zebra it is going to, this near its
 * waiting place, a walker is in the queue: waiting too (`queuedFor`), never
 * jammed through the crowd. Within this gap of the body ahead past `KEEP`.
 */
const QUEUE_REACH = m(6);
/**
 * Half the length of kerb people wait along at a zebra, u: past the zebra's
 * own width, as a crowd at a corner lines the kerb rather than standing
 * deep across the footway (SUMO's "wide queue").
 */
const WAIT_HALF = m(2.2);

const QUEUE_GAP = m(0.6);
/** How often a waiting walker asks whether they may cross, seconds. */
const ASK_EVERY = 0.25;
/**
 * Seconds a leave to cross holds for one standing still who has not yet
 * stepped onto the carriageway. Entering is a condition met when entering (SUMO: a pedestrian
 * crosses only if its time on the crossing does not meet an approaching
 * vehicle's), not once for good: a walker let on, then held still at the kerb
 * for seconds, stepped off later in front of a car admitted meanwhile, which
 * stood in the junction for it (`priorityBox.spec`, seed 3).
 */
const GRANT_LIFE = 1;
/** Farthest a door or a car may be from the walkways, by default. */
const REACH = m(30);
/** Somebody this near the spot a walker steps out onto keeps them inside a moment, u. */
const DOOR_CLEAR = m(0.8);
/** The end of a walk is reached this near it. */
const THERE = m(0.25);
/** Spatial cells for the walkers and for the walkways. */
/**
 * As wide as a walker looks ahead (`LOOK`): everybody it can see is in its
 * own cell or the next ones round, 9 cells read where 6 m cells needed 25.
 */
const CELL = LOOK;
const WAY_CELL = m(20);
/** Cells for the cars' zones (`zonesNear`). */
const ZONE_CELL = m(16);

/** Ground a walker keeps off: a car's body (and the way it holds), or a train's. */
interface CarZone {
  x0: number; y0: number; x1: number; y1: number;
  discs: { x: number; y: number; r: number }[];
  on: Set<number> | null;
  /** Its way kept off only by people crossing the carriageway (a car at the kerb, `crossesFootway`). */
  crossingOnly: boolean;
}
const NO_POINTS: readonly Vec2[] = [];

/**
 * A car's body as a zone: three discs along its length, half its width round.
 * Kept per car while it stands where it stood, so the town's parked cars are
 * not rebuilt as fresh objects every tick. Shared and read-only: a car on a
 * trip copies the discs before adding its way.
 */
const PARKED = new WeakMap<Vehicle, { x: number; y: number; angle: number; zone: CarZone }>();
function parkedZone(car: Vehicle, f: FreePose): CarZone {
  const hit = PARKED.get(car);
  if (hit && hit.x === f.x && hit.y === f.y && hit.angle === f.angle) return hit.zone;
  const r = car.archetype.width / 2;
  const reach = Math.max(0, car.archetype.length / 2 - r);
  const discs = [-1, 0, 1].map((k) => ({ x: f.x + Math.cos(f.angle) * reach * k, y: f.y + Math.sin(f.angle) * reach * k, r }));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of discs) { x0 = Math.min(x0, d.x - d.r); y0 = Math.min(y0, d.y - d.r); x1 = Math.max(x1, d.x + d.r); y1 = Math.max(y1, d.y + d.r); }
  const zone: CarZone = { x0, y0, x1, y1, discs, on: null, crossingOnly: false };
  PARKED.set(car, { x: f.x, y: f.y, angle: f.angle, zone });
  return zone;
}

interface Step {
  /** The walkway, or null for a straight stretch off it (to a door or a car). */
  readonly way: Walkway | null;
  /** +1 along the way from `a` to `b`, -1 the other way. */
  readonly dir: 1 | -1;
  /** Arc position on the way where the step starts, and where it ends. */
  readonly from: number;
  readonly to: number;
  /** Off the walkways: the straight line walked. */
  readonly a?: Vec2;
  readonly b?: Vec2;
  /**
   * A stretch inside a lot, between its door and its people's gate
   * (`agents/lotDoors.ts`): found round the walls, fences and parts of the
   * lot, so never planned again from where the body is (a straight line from
   * there would cross the fence); one walker abreast.
   */
  readonly lot?: true;
}

interface Walker {
  readonly id: number;
  readonly trip: number;
  readonly view: PedView;
  readonly pace: number;
  readonly steps: Step[];
  leg: number;
  /** Progress along this step, and the offset left of it: the body projected on it. */
  s: number;
  d: number;
  /** The stripe it walks in: offset left of the way walked. */
  aim: number;
  v: number;
  x: number; y: number; heading: number;
  prevX: number; prevY: number; prevHeading: number;
  turnV: number;
  age: number;
  /** Seconds held still while meaning to walk. */
  held: number;
  /** Where along its step it last made progress (`PROGRESS`), and how long ago, s. */
  progress?: { leg: number; s: number; since: number } | undefined;
  /**
   * The step it got jammed on (held past JAM_AFTER): it goes on at
   * JAM_SHARE through what blocks it until it leaves that step or the way
   * ahead clears (SUMO's jammed state). Ended as soon as it moved, it crept
   * 2 cm every 10 s and a car waiting for it waited for good.
   */
  jammedOn?: number | undefined;
  /** Age at which its stripe (`aim`) last changed (`AIM_HOLD`). */
  aimAt?: number | undefined;
  /** Waiting for a zebra: seconds waited, and the time to the next ask. */
  waited: number;
  asked: number;
  /** The zebra it has been let onto. */
  granted: CrossingId | null;
  /** When (its `age`) it was let onto it: a leave to step off now, not for good (`GRANT_LIFE`). */
  grantedAt?: number | undefined;
  /**
   * Not out yet: waiting inside the door (or the car) until the spot it steps
   * out onto is clear. As SUMO inserts a person only where there is room, a
   * crowd leaving one building comes out one after another.
   */
  inside: boolean;
  /** The zebra it is coming up to, and the one it stands waiting for. */
  zebra: Zebra | null;
  waiting: Zebra | null;
  done: boolean;
  /** Moved by the player's hand, not by its route (`movePlayerWalker`). */
  player: boolean;
  /** Stopped to do something a while (talk, fall down), facing a point: until `age` reaches `until`. */
  act: { readonly kind: GestureKind; readonly from: number; readonly until: number; readonly faceX: number; readonly faceY: number } | null;
  /** Running away from something: pace times `by` until `age` reaches `until`; then on to `goal`. */
  rush: { readonly by: number; readonly until: number; readonly goal: Vec2 } | null;
  /** Terrified (a blow, a robbery) until `age` reaches this: the face screams, zebras are not waited at. */
  fright?: number | undefined;
  /** When somebody running in panic trips and falls (age, seconds), once. */
  tripAt?: number | undefined;
  /** A limb lost to a blow (`PedView.maimed`). */
  maimed?: 'armL' | 'armR' | 'legL' | 'legR' | undefined;
  /** Health, 100 whole (`shot`); absent: never hurt. */
  hp?: number | undefined;
  /** Shots taken. */
  hits?: number | undefined;
  /** Shot open at the belly already (`shot`: the guts out once). */
  opened?: boolean | undefined;
  /** The walker they walk with (a companion keeps to their side, `stepWalkers`). */
  leader?: number | undefined;
  /** Down and to crawl off once the body is on hands and knees (`getUp` crawl). */
  crawlNext?: boolean | undefined;
  /** The last shot that struck them: where, how much it took, when (their age). */
  lastHit?: { part: BodyPart; damage: number; at: number } | undefined;
  /** Damage taken by each part, for a limb shot off once it has taken enough. */
  hurt?: Partial<Record<BodyPart, number>> | undefined;
  /** Every limb lost (`PedView.lost`). */
  lost?: Severable[] | undefined;
  /** The step its view's `stretch` was last spelt for (`publish`). */
  stretchOf?: Step | undefined;
  /** Health lost a second to a wound bleeding (a limb gone): they die of it. */
  bleeding?: number | undefined;
}

/**
 * Every field a walker may be given later, there from its birth and in one
 * order: added as things happened to each (a stripe taken, a leave granted,
 * a fright, a wound), in whatever order they came, they gave the walkers many
 * hidden classes, and the step's optimised code was thrown away on each new
 * one ("wrong map": 40 times in 40 s of a town, `stepWalkers` re-optimised
 * 15 times). V8 shares a hidden class only among objects given the same
 * properties in the same order (v8.dev/docs/hidden-classes). Spread last into
 * each walker's literal.
 */
const WALKER_SHAPE = {
  progress: undefined, jammedOn: undefined, aimAt: undefined, grantedAt: undefined, fright: undefined, tripAt: undefined,
  maimed: undefined, hp: undefined, hits: undefined, opened: undefined, leader: undefined, crawlNext: undefined,
  lastHit: undefined, hurt: undefined, lost: undefined, stretchOf: undefined, bleeding: undefined,
} as const satisfies { [K in keyof Walker]?: undefined };

interface State {
  graph: WalkGraph | null;
  builtFor: string;
  wayIndex: Map<number, number[]>;
  walkers: Walker[];
  byId: Map<number, Walker>;
  arrivals: number[];
  nextId: number;
  /**
   * For each car holding (or asking for) its way across the footway, the
   * walkers who were on that ground when it took it: they walk on off it;
   * everybody else keeps off it.
   */
  onCarWay: Map<number, Set<number>>;
  /**
   * Shocking events (as GTA's peds have them): where a blow fell or somebody
   * was shot, and the bodies lying there, for a while after - whoever comes
   * near one later runs from it too, instead of strolling past.
   */
  shocks: { x: number; y: number; radius: number; until: number }[];
  /** Seconds of walking stepped (the shocks' clock). */
  clock: number;
  /** When the walkers were last checked against the shocks. */
  shockLook: number;
  /** The walkers by cell for `anyoneWithin`, and the clock they were filed at (-1: again). */
  near: Map<number, Walker[]>;
  nearAt: number;
  /**
   * On the planet, the other charts each walkway's walkers are also filed on
   * (`ghostsOf`), by way id; the walkers and their ghost images as filed this
   * tick, and the tick they were made for.
   */
  wayGhosts: Map<number, readonly number[]>;
  imaged: Walker[];
  imagedAt: number;
  /** The vehicles by cell for `gapOpen`, filed once a tick when somebody first asks; the fastest of them. */
  traffic: Map<number, TrafficSeen[]>;
  trafficAt: number;
  fastest: number;
  /** The walkers by cell, filed again at the start of every step (`WalkerGrid`). */
  grid: WalkerGrid;
  /** The parked cars' zones by cell, kept while the same cars stand where they stood. */
  parkedCells: Map<number, CarZone[]>;
  /** The parked cars as last seen, in the scenery's order: where each stood, and its body (null: not standing). */
  parkedSeen: { car: Vehicle; x: number; y: number; angle: number; zone: CarZone | null }[];
}

/** A vehicle as `gapOpen` reads it: where it is, which way it faces, how fast it goes. */
interface TrafficSeen { readonly x: number; readonly y: number; readonly angle: number; readonly speed: number }
/** Cells for the vehicles near a crossing (`gapOpen`). */
const TRAFFIC_CELL = m(32);
/**
 * Out of the player's view (`SimWorld.focus`) a walker is stepped one tick in
 * this many, by as many ticks' time, without stepping round the others: their
 * route, the zebras and the waits go on as before, and nobody sees the rest.
 */
const COARSE = 4;

/**
 * A test bench's trace of what happens to chosen walkers (the weapons lab,
 * `traceWalkers`): every change of what they are doing or of their flight,
 * with why, from where (the call stack) and their state then. Off (and
 * free) unless somebody is traced.
 */
export interface WalkTrace {
  readonly tick: number;
  readonly id: number;
  readonly field: 'act' | 'rush' | 'route' | 'hit' | 'hp';
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly hp: number;
  readonly hits: number;
  readonly stack: string;
}
const traced = new Set<number>();
let traceSink: ((t: WalkTrace) => void) | null = null;
let traceTick = 0;
/** Traces these walkers' changes into `sink` (an empty list stops it). */
export function traceWalkers(ids: readonly number[], sink: ((t: WalkTrace) => void) | null): void {
  traced.clear();
  for (const id of ids) traced.add(id);
  traceSink = sink;
}
const actName = (a: Walker['act']): string => (a ? `${a.kind}(${(a.until - a.from).toFixed(1)}s)` : 'none');
const rushName = (r: Walker['rush']): string => (r ? `rush x${r.by.toFixed(2)}` : 'none');
function trace(p: Walker, field: WalkTrace['field'], from: string, to: string, reason: string): void {
  if (!traceSink || !traced.has(p.id)) return;
  const stack = (new Error().stack ?? '').split(String.fromCharCode(10)).slice(2, 7).map((l) => l.trim().replace(/https?:\/\/[^/]+\//, '').replace(/\?t=\d+/, '')).join(' < ');
  traceSink({ tick: traceTick, id: p.id, field, from, to, reason, hp: p.hp ?? 100, hits: p.hits ?? 0, stack });
}

/**
 * How a shot walker is hurt, from their health and what struck them: none,
 * light (most of their health left) or grave (half gone, or a limb lost).
 * The end of a reaction never makes them well again: the wound stays and
 * governs how they move for as long as they are on the street.
 */
function woundOf(p: Walker): { part: BodyPart; grave: boolean } | null {
  if (!p.lastHit) return null;
  return { part: p.lastHit.part, grave: (p.hp ?? 100) < 50 || (p.lost?.length ?? 0) > 0 };
}
/** A wounded walker's pace walking on, as a share of their own: slow, bent over the wound, never their own walk again. */
const WOUNDED_PACE = { light: 0.55, leg: 0.45, grave: 0.4 } as const;
/**
 * Getting away hurt, against their own pace: a run bent over the wound, as
 * GTA's shot peds flee clutching it (a hurried walk away read as somebody
 * walking on unhurt - the player, 2026-10-06); on a hurt leg, a hobble.
 */
const WOUNDED_RUSH = { light: 2.2, leg: 0.6, grave: 0.6 } as const;
/** Which of those a wound sets. */
function woundPace(wound: { part: BodyPart; grave: boolean }): 'light' | 'leg' | 'grave' {
  return wound.grave ? 'grave' : wound.part === 'legL' || wound.part === 'legR' ? 'leg' : 'light';
}

/** A first wound's reaction (`flinch`): struck, hunched over the wound standing, then on, wounded (seconds). */
export const FLINCH = 1.6;
/** A crawl's speed, u/s: the captured crawl's own (its feet and knees do not slide). */
const CRAWL_PACE = m(0.12);
/** Knocked down by a light wound: the longest they can be down before they are up (`getUp` sets the real end). */
const KNOCKED_MOST = 12;
/**
 * Struck by the round: a stagger of a couple of steps back, the way it went
 * (GTA's shot peds are knocked back; stood still where they were struck, a
 * shot person was never seen pushed - the player, 2026-10-06). Seconds, and
 * how far.
 */
export const STAGGER_TIME = 0.75;
/** It starts after the hit itself (the captured jerk, `render/agents.ts`). */
export const STAGGER_FROM = 0.3;
const STAGGER_DISTANCE = m(0.8);
/** The stagger's speed `t` seconds into a flinch: fast at first, slowing to a stop. */
export function staggerSpeed(t: number): number {
  const u = t - STAGGER_FROM;
  return u < 0 || u >= STAGGER_TIME ? 0 : (2 * STAGGER_DISTANCE / STAGGER_TIME) * (1 - u / STAGGER_TIME);
}

/** A shocking event's life (seconds), and the reach of a body lying in the street. */
const SHOCK_LIFE = 90;
const BODY_SHOCK = m(14);

function shock(s: State, x: number, y: number, radius: number, seconds = SHOCK_LIFE): void {
  s.shocks = s.shocks.filter((k) => k.until > s.clock);
  if (s.shocks.length > 64) s.shocks.shift();
  s.shocks.push({ x, y, radius, until: s.clock + seconds });
}

const STATES = new WeakMap<SimWorld, State>();
function stateOf(w: SimWorld): State {
  let s = STATES.get(w);
  if (!s) {
    s = { graph: null, builtFor: '', wayIndex: new Map(), walkers: [], byId: new Map(), arrivals: [], nextId: 1, onCarWay: new Map(),
      shocks: [], clock: 0, shockLook: 0, near: new Map(), nearAt: -1, wayGhosts: new Map(), imaged: [], imagedAt: -1, traffic: new Map(), trafficAt: -1, fastest: 0,
      grid: new WalkerGrid(), parkedCells: new Map(), parkedSeen: [] };
    STATES.set(w, s);
  }
  return s;
}

/**
 * Length of (x, y). `Math.hypot` guards against overflow past 1e154 (MDN),
 * which no distance on a map comes near, and in the browser's profile it was
 * most of the walkers' frame and distance arithmetic (2026-10-09).
 */
const hypot = (x: number, y: number): number => Math.sqrt(x * x + y * y);
/**
 * A grid cell as one number: a string key (`"x,y"`) cost a string built and
 * hashed for every one of the 25 cells every walker reads every tick, the
 * largest single cost of the step. Unique while |cy| < 2^15 cells (km away).
 */
const cell = (cx: number, cy: number): number => cx * 65536 + cy;
const cellKey = (x: number, y: number, size: number): number => cell(Math.floor(x / size), Math.floor(y / size));

// ------------------------------------------------------------------ ground

/** The walkways of the map as it is now, built again when the network changes. */
function ensureGraph(w: SimWorld, s: State): WalkGraph | null {
  const key = `${w.net.revision}:${w.topologyRevision}`;
  if (s.graph && s.builtFor === key) return s.graph;
  s.graph = w.walkwaysFor(w.net.revision);
  s.builtFor = key;
  s.wayGhosts = __PLANET__ ? wayGhostCharts(s.graph) : new Map();
  s.imagedAt = -1;
  s.wayIndex.clear();
  for (const way of s.graph.ways) {
    const bb = way.path.bbox;
    const pad = Math.max(Math.abs(way.lo), Math.abs(way.hi));
    for (let x = Math.floor((bb.minX - pad) / WAY_CELL); x <= Math.floor((bb.maxX + pad) / WAY_CELL); x++) {
      for (let y = Math.floor((bb.minY - pad) / WAY_CELL); y <= Math.floor((bb.maxY + pad) / WAY_CELL); y++) {
        const k = cell(x, y);
        const list = s.wayIndex.get(k);
        if (list) list.push(way.id); else s.wayIndex.set(k, [way.id]);
      }
    }
  }
  return s.graph;
}

/**
 * GHOST IMAGES ACROSS THE PLANET'S CHARTS. A walker's place is written on the
 * chart of the way it walks on (`carryOnto`), and at a junction across a
 * border between pieces the footways, the corners and the zebras are kept on
 * two or three charts, tens of km apart in the atlas: the people a few
 * steps away round the corner were in no cell near it, and walked through
 * each other there. As molecular dynamics finds neighbours across a periodic
 * or a processor's boundary (LAMMPS, "Communication": every atom within the
 * cutoff of the boundary is also kept, as a ghost, on the other side, its
 * coordinates already shifted to its image there - doc.lammps.org,
 * Developer_par_comm), each walker on a way whose neighbourhood holds ways of
 * other charts is also filed on those charts, at its place and heading
 * there; the ghost is the walker itself in all else (its prototype), and the
 * queries are unchanged.
 *
 * The neighbourhood: the ways within two steps of it in the graph - across a
 * corner from one footway to the next, or over a zebra - which holds every
 * way a walker within the look of the cells (`CELL`) can stand on near a
 * border. Worked out once a graph, as LAMMPS keeps who is a ghost where
 * until it builds its neighbour lists again.
 */
function wayGhostCharts(g: WalkGraph): Map<number, readonly number[]> {
  const out = new Map<number, readonly number[]>();
  const chartOf = (way: Walkway): number => chartAt(way.path.xy[0]!, way.path.xy[1]!);
  const atNode = new Map<number, Walkway[]>();
  for (const way of g.ways) {
    for (const n of [way.a, way.b]) {
      const list = atNode.get(n);
      if (list) list.push(way); else atNode.set(n, [way]);
    }
  }
  const around = (way: Walkway): Walkway[] => [...(atNode.get(way.a) ?? []), ...(atNode.get(way.b) ?? [])];
  for (const way of g.ways) {
    const own = chartOf(way);
    const charts = new Set<number>();
    for (const next of around(way)) {
      charts.add(chartOf(next));
      for (const far of around(next)) charts.add(chartOf(far));
    }
    charts.delete(own);
    if (charts.size) out.set(way.id, [...charts]);
  }
  return out;
}

/** Each walker's ghost images, made once and kept (one a chart it is seen on). */
const GHOSTS = new WeakMap<Walker, Walker[]>();

/**
 * The walkers out on the street and, on the planet, their ghost images on the
 * other charts round the way each walks (`wayGhostCharts`), made once a tick.
 */
function imagesOf(s: State): readonly Walker[] {
  if (!__PLANET__ || !s.wayGhosts.size) return s.walkers;
  if (s.imagedAt === s.clock) return s.imaged;
  s.imagedAt = s.clock;
  const out = s.imaged;
  out.length = 0;
  for (const p of s.walkers) {
    out.push(p);
    if (p.inside || p.done) continue;
    const way = p.steps[p.leg]?.way;
    const charts = way ? s.wayGhosts.get(way.id) : undefined;
    if (!charts) continue;
    const from = chartAt(p.x, p.y);
    let ghosts = GHOSTS.get(p);
    if (!ghosts) GHOSTS.set(p, ghosts = []);
    let k = 0;
    for (const chart of charts) {
      if (chart === from) continue;
      const ghost = ghosts[k] ?? (ghosts[k] = Object.create(p) as Walker);
      k++;
      ghost.heading = carryHeading(from, chart, p.x, p.y, p.heading);
      chartToChartInto(from, chart, p.x, p.y, carried);
      ghost.x = carried.x; ghost.y = carried.y;
      out.push(ghost);
    }
  }
  return out;
}

/** The walkway nearest a point within `reach` (crossings excluded: nobody starts on a zebra). */
function nearestWay(s: State, p: Vec2, reach: number): { way: Walkway; s: number; distance: number } | null {
  const g = s.graph;
  if (!g) return null;
  let best: { way: Walkway; s: number; distance: number } | null = null;
  const span = Math.ceil(reach / WAY_CELL);
  const cx = Math.floor(p.x / WAY_CELL), cy = Math.floor(p.y / WAY_CELL);
  const seen = new Set<number>();
  for (let x = cx - span; x <= cx + span; x++) {
    for (let y = cy - span; y <= cy + span; y++) {
      for (const id of s.wayIndex.get(cell(x, y)) ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const way = g.ways[id]!;
        if (way.kind === 'crossing') continue;
        const hit = way.path.closestPoint(p);
        if (hit.distance > reach) continue;
        if (!best || hit.distance < best.distance) best = { way, s: hit.s, distance: hit.distance };
      }
    }
  }
  return best;
}

/** The cost of walking a way: its length, and more for a zebra. */
const wayCost = (way: Walkway): number => way.path.length + (way.kind === 'crossing' ? CROSSING_COST : 0);

/**
 * The steps from one point on a way to another: the shortest chain of
 * walkways between them (Dijkstra over the walkway nodes).
 */
function route(g: WalkGraph, from: { way: Walkway; s: number }, to: { way: Walkway; s: number }): Step[] | null {
  if (from.way.id === to.way.id) {
    return [{ way: from.way, dir: to.s >= from.s ? 1 : -1, from: from.s, to: to.s }];
  }
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1);
  // A binary heap, and done once both ends of the goal way are settled: the
  // open list was scanned whole for every node taken and the search went on
  // over the whole graph, for every walker, when an edit moved them all onto
  // the new footways in one frame (docs/performance.md #27).
  const open = new Heap();
  const push = (node: number, d: number, way: number): void => {
    if (d >= dist[node]!) return;
    dist[node] = d;
    via[node] = way;
    open.push(node, d);
  };
  push(from.way.a, from.s, from.way.id);
  push(from.way.b, from.way.path.length - from.s, from.way.id);
  const done = new Uint8Array(n);
  let goals = to.way.a === to.way.b ? 1 : 2;
  while (open.size && goals > 0) {
    const node = open.pop();
    if (done[node]) continue;
    done[node] = 1;
    if (node === to.way.a || node === to.way.b) goals--;
    const d = dist[node]!;
    for (const wid of g.at.get(node) ?? []) {
      const way = g.ways[wid]!;
      if (way.id === from.way.id) continue;
      const other = way.a === node ? way.b : way.a;
      push(other, d + wayCost(way), way.id);
    }
  }
  const ends = [
    { node: to.way.a, total: dist[to.way.a]! + to.s },
    { node: to.way.b, total: dist[to.way.b]! + (to.way.path.length - to.s) },
  ].sort((p, q) => p.total - q.total);
  const end = ends[0]!;
  if (!Number.isFinite(end.total)) return null;
  // Back from the goal's end node to the start way.
  const chain: { way: Walkway; enter: number }[] = [];
  let node = end.node;
  let guard = 0;
  while (guard++ < n) {
    const wid = via[node]!;
    if (wid < 0) return null;
    const way = g.ways[wid]!;
    if (way.id === from.way.id) break;
    chain.push({ way, enter: way.a === node ? way.b : way.a });
    node = way.a === node ? way.b : way.a;
  }
  chain.reverse();
  const steps: Step[] = [];
  // Off the start way at the end the route leaves it by.
  const leaveAtB = node === from.way.b;
  steps.push({ way: from.way, dir: leaveAtB ? 1 : -1, from: from.s, to: leaveAtB ? from.way.path.length : 0 });
  for (const { way, enter } of chain) {
    const forward = enter === way.a;
    steps.push({ way, dir: forward ? 1 : -1, from: forward ? 0 : way.path.length, to: forward ? way.path.length : 0 });
  }
  const arriveAtA = end.node === to.way.a;
  steps.push({ way: to.way, dir: arriveAtA ? 1 : -1, from: arriveAtA ? 0 : to.way.path.length, to: to.s });
  return steps;
}


// ------------------------------------------------------------------ frames

const stepLength = (st: Step): number => st.way ? Math.abs(st.to - st.from) : hypot(st.b!.x - st.a!.x, st.b!.y - st.a!.y);

/** Point and walking tangent at `s` along a step; past either end it goes on straight. */
/** A place on a step and its way ahead (`frameInto`). */
interface StepFrame { x: number; y: number; tx: number; ty: number }
const newStepFrame = (): StepFrame => ({ x: 0, y: 0, tx: 1, ty: 0 });
/** The way's frame `frameInto` samples into: made once. */
const WAY_SAMPLE = newFrame();
/** The step frames of the hot callers, each its own (`project` runs inside `stepWalkers`' use of its own). */
const PROJECT_FRAME = newStepFrame();
const AIM_FRAME = newStepFrame();
const WALK_FRAME = newStepFrame();

function frame(st: Step, s: number): StepFrame {
  return frameInto(st, s, newStepFrame());
}

/**
 * `frame` into `out`: the walkers' step asks it several times a tick for
 * every walker, and the frame and the way's sample made anew each time were
 * some 300 MB in 10 s of a town with 400 people (the heap profiler,
 * 2026-10-11).
 */
function frameInto(st: Step, s: number, out: StepFrame): StepFrame {
  if (!st.way) {
    const len = Math.max(1e-6, stepLength(st));
    const tx = (st.b!.x - st.a!.x) / len, ty = (st.b!.y - st.a!.y) / len;
    out.x = st.a!.x + tx * s; out.y = st.a!.y + ty * s; out.tx = tx; out.ty = ty;
    return out;
  }
  const len = stepLength(st);
  const k = Math.max(0, Math.min(len, s));
  const path = st.way.path;
  const f = path.sampleAtInto(st.from + st.dir * k, WAY_SAMPLE);
  // The tangent blended along each piece from the tangent at its one end to
  // the tangent at the other (each the mean of the two pieces meeting there),
  // then made unit again - as Phong shading interpolates vertex normals - so
  // it turns smoothly through a corner's points. The piece's own tangent
  // jumped at every point of the line: a body standing on one stepped from
  // one frame to the other and back each tick, and the people in front of it
  // swung a step across - its stripe and its shoulders with them.
  const tan = path.tan, last = path.n - 2, i = f.i;
  const ax = i > 0 ? tan[i * 2 - 2]! + tan[i * 2]! : tan[i * 2]!, ay = i > 0 ? tan[i * 2 - 1]! + tan[i * 2 + 1]! : tan[i * 2 + 1]!;
  const bx = i < last ? tan[i * 2]! + tan[i * 2 + 2]! : tan[i * 2]!, by = i < last ? tan[i * 2 + 1]! + tan[i * 2 + 3]! : tan[i * 2 + 1]!;
  const al = hypot(ax, ay) || 1, bl = hypot(bx, by) || 1;
  let sx = (ax / al) * (1 - f.u) + (bx / bl) * f.u, sy = (ay / al) * (1 - f.u) + (by / bl) * f.u;
  const sl = hypot(sx, sy);
  if (sl > 1e-9) { sx /= sl; sy /= sl; } else { sx = f.t.x; sy = f.t.y; }
  const tx = sx * st.dir, ty = sy * st.dir;
  const over = s - k;
  out.x = f.p.x + tx * over; out.y = f.p.y + ty * over; out.tx = tx; out.ty = ty;
  return out;
}

/** The chart a step's ground is written on (`world/planet/charts.ts`). */
function stepChart(st: Step): number {
  if (st.way) return chartAt(st.way.path.xy[0]!, st.way.path.xy[1]!);
  return chartAt(st.a!.x, st.a!.y);
}

const carried = { x: 0, y: 0 };

/**
 * A walker carried onto the chart of the step it goes on to: on the planet a
 * footway is written on its segment's chart and the corner or zebra it walks
 * on into on its node's, tens of km apart in the atlas across a border
 * between pieces. Its place, the place it is blended from (`pedPose`) and
 * its headings go with it, as a floating origin shifts a body's interpolation
 * state along with the body - the same ground and the same way, on the other
 * chart. Nothing on the flat map, or where the charts are one.
 */
function carryOnto(p: Walker, st: Step): void {
  if (!__PLANET__) return;
  const to = stepChart(st);
  const from = chartAt(p.x, p.y);
  if (from !== to) {
    p.heading = carryHeading(from, to, p.x, p.y, p.heading);
    chartToChartInto(from, to, p.x, p.y, carried);
    p.x = carried.x; p.y = carried.y;
  }
  const before = chartAt(p.prevX, p.prevY);
  if (before !== to) {
    p.prevHeading = carryHeading(before, to, p.prevX, p.prevY, p.prevHeading);
    chartToChartInto(before, to, p.prevX, p.prevY, carried);
    p.prevX = carried.x; p.prevY = carried.y;
  }
}

/** A heading at a point of chart `from`'s map, on chart `to`'s map. */
function carryHeading(from: number, to: number, x: number, y: number, heading: number): number {
  chartToChartInto(from, to, x + Math.cos(heading), y + Math.sin(heading), carried);
  const ax = carried.x, ay = carried.y;
  chartToChartInto(from, to, x, y, carried);
  return Math.atan2(ay - carried.y, ax - carried.x);
}

/** `project` of a body that may stand on another chart than the step (`carryOnto`). */
function projectAcross(st: Step, x: number, y: number): { s: number; d: number } {
  if (!__PLANET__) return projectInto(st, x, y, ACROSS_PROJECTION);
  const from = chartAt(x, y), to = stepChart(st);
  if (from === to) return projectInto(st, x, y, ACROSS_PROJECTION);
  chartToChartInto(from, to, x, y, carried);
  return projectInto(st, carried.x, carried.y, ACROSS_PROJECTION);
}
/** `projectAcross`'s: read at once by its one caller in the walkers' step. */
const ACROSS_PROJECTION = { s: 0, d: 0 };

/** A body projected on a step: how far along it, and how far left of it. */
function project(st: Step, x: number, y: number): { s: number; d: number } {
  return projectInto(st, x, y, { s: 0, d: 0 });
}

/** Where `projectInto` reads the way's nearest point: made once. */
const NEAREST = { s: 0, distance: 0 };
/** The projections of the walkers' step and of `target`: made once (each read before the next is made). */
const STEP_PROJECTION = { s: 0, d: 0 };
const AIM_PROJECTION = { s: 0, d: 0 };

/** `project` into `out` (every walker, several times a tick). */
function projectInto(st: Step, x: number, y: number, out: { s: number; d: number }): { s: number; d: number } {
  if (!st.way) {
    const f = frameInto(st, 0, PROJECT_FRAME);
    out.s = (x - f.x) * f.tx + (y - f.y) * f.ty;
    out.d = -(x - f.x) * f.ty + (y - f.y) * f.tx;
    return out;
  }
  st.way.path.closestInto(x, y, NEAREST);
  let s = (NEAREST.s - st.from) * st.dir;
  const f = frameInto(st, s, PROJECT_FRAME);
  s += (x - f.x) * f.tx + (y - f.y) * f.ty;
  out.s = s;
  out.d = -(x - f.x) * f.ty + (y - f.y) * f.tx;
  return out;
}

/**
 * The lateral room of a step in its own walking frame, [low, high], left
 * positive, for a body's centre. Round the inside of a corner a walker keeps
 * within half its radius: farther in, the line would fold back on itself.
 */
function room(st: Step): readonly [number, number] {
  let kept = ROOMS.get(st);
  if (!kept) ROOMS.set(st, kept = Object.freeze(roomOf(st)));
  return kept;
}
/**
 * Each step's room, worked out once (it depends on the step alone): asked
 * several times a tick for every walker, it was made anew each time. Frozen:
 * a caller that widens it for itself copies it first (`stepWalkers`' span).
 */
const ROOMS = new WeakMap<Step, readonly [number, number]>();

function roomOf(st: Step): [number, number] {
  if (!st.way) return [0, 0];
  let lo = st.way.lo + BODY, hi = st.way.hi - BODY;
  if (st.way.kind === 'corner') {
    // By the tightest bend of the line, not its average: a corner eases off
    // each footway straight and turns in a tighter arc between, and a body
    // kept within half the average radius stood past the arc's centre - its
    // nearest point on the line jumped to and fro between the two ends of the
    // arc, and so did where it was going (a parallel curve folds into a cusp
    // where the offset reaches the radius of curvature).
    // Only round the inside of the corner's own turn: outwards the line
    // never folds, and the small counter-bends where a corner eases off its
    // footways narrowed it to single file both ways.
    const r = bendRadii(st.way);
    if (r.turn > 0.2) hi = Math.min(hi, r.left * 0.5);
    else if (r.turn < -0.2) lo = Math.max(lo, -r.right * 0.5);
    // Never past the fold itself on either side, counter-bends and corners
    // that barely turn end to end included (an S across the top of a T): a
    // walker put 1.9 m inside a bend of 1.5 m radius spun round on the spot
    // for 13 s, its nearest point on the line jumping across the cusp
    // (`defects.spec` mixed-T milling, P101).
    hi = Math.min(hi, r.left * FOLD_SHARE);
    lo = Math.max(lo, -r.right * FOLD_SHARE);
  }
  if (st.dir === -1) [lo, hi] = [-hi, -lo];
  if (lo > hi) lo = hi = (lo + hi) / 2;
  return [lo, hi];
}

/** Share of a bend's radius a walker may be inside it on a counter-bend: short of the fold. */
const FOLD_SHARE = 0.8;
/** Share of a corner's stripes, and most width, left to those coming the other way (SUMO's defaults). */
const RESERVE_ONCOMING = 0.34;
const RESERVE_MAX = m(1.28);
/** Penalty of a stripe a walker must not take (SUMO's INAPPROPRIATE_PENALTY, as room ahead). */
const INAPPROPRIATE = m(1000);
/** Penalty of the leftmost stripe while somebody comes the other way in it (SUMO's ONCOMING_CONFLICT_PENALTY, -1000). */
const ONCOMING_CONFLICT = m(50);
/** The width at the left of a step, in the way walked, left to those coming the other way: corners only. */
function reservedFor(st: Step): number {
  if (st.way?.kind !== 'corner') return 0;
  const stripes = Math.floor(st.way.width / STRIPE);
  return Math.min(Math.floor(stripes * RESERVE_ONCOMING), Math.floor(RESERVE_MAX / STRIPE)) * STRIPE;
}

/** Arc over which a line's bend is measured, u. */
const BEND_WINDOW = m(1);
const BENDS = new WeakMap<Walkway, { left: number; right: number; turn: number }>();
/**
 * The tightest radius of a walkway's line turning left and turning right
 * (along it from `a` to `b`): the turn over every stretch of `BEND_WINDOW`.
 * Infinity for a side it never turns to (by more than 0.2 rad a stretch).
 * `turn`: its whole turn, end to end, left positive.
 */
function bendRadii(way: Walkway): { left: number; right: number; turn: number } {
  let r = BENDS.get(way);
  if (r) return r;
  const xy = way.path.xy, cum = way.path.cum, n = way.path.n;
  const heading = (i: number): number => Math.atan2(xy[i * 2 + 3]! - xy[i * 2 + 1]!, xy[i * 2 + 2]! - xy[i * 2]!);
  const whole = n >= 2 ? heading(n - 2) - heading(0) : 0;
  r = { left: Infinity, right: Infinity, turn: Math.atan2(Math.sin(whole), Math.cos(whole)) };
  for (let i = 0, j = 0; i < n - 1; i++) {
    if (j < i) j = i;
    while (j < n - 2 && cum[j + 1]! - cum[i]! < BEND_WINDOW) j++;
    const arc = cum[j + 1]! - cum[i]!;
    if (j === i || arc < 1e-6) continue;
    let turn = 0;
    for (let k = i; k < j; k++) {
      const d = heading(k + 1) - heading(k);
      turn += Math.atan2(Math.sin(d), Math.cos(d));
    }
    if (Math.abs(turn) < 0.2 * (arc / BEND_WINDOW)) continue;
    const radius = arc / Math.abs(turn);
    if (turn > 0) r.left = Math.min(r.left, radius); else r.right = Math.min(r.right, radius);
  }
  BENDS.set(way, r);
  return r;
}

// Read by index, not unpacked: a pattern in a parameter walks the array's
// iterator, and made an iterator and its results on every call (24 MB in
// 10 s of 400 walkers, the heap profiler, 2026-10-11).
const clamp = (v: number, r: readonly [number, number]): number => Math.max(r[0], Math.min(r[1], v));

/** How far a footway's walking line is from its kerb (where a crossing's end meets the road). */
const kerbInset = (way: Walkway | null | undefined): number =>
  !way || way.kind === 'crossing' ? 0 : way.kerb < 0 ? -way.lo : way.hi;

// ------------------------------------------------------------------ crossings

/**
 * A crossing on a walker's way: a zebra as the vehicles and the signals know
 * it (`edge`), or a crossing with no zebra (`edge` null: the end of a road that
 * leads nowhere, `Walkway.unmarked`), where the walker takes a gap.
 */
interface Zebra { readonly id: CrossingId; readonly edge: SidewalkEdge | null; readonly way: Walkway }

function crossingOf(w: SimWorld, way: Walkway | null | undefined): Zebra | null {
  if (!way || way.kind !== 'crossing' || way.node === undefined || way.segment === undefined) return null;
  // Kept per walkway for the topology it was read in: every walker asked it
  // several times a tick, each a string id built and a fresh object.
  const known = ZEBRAS.get(way);
  if (known && known.revision === w.topologyRevision) return known.zebra;
  const id = makeCrossingId(way.node, way.segment);
  const edge = way.unmarked ? null : w.sidewalks.crossingEdge(id) ?? null;
  const zebra = edge || way.unmarked ? { id, edge, way } : null;
  ZEBRAS.set(way, { revision: w.topologyRevision, zebra });
  return zebra;
}
const ZEBRAS = new WeakMap<Walkway, { revision: number; zebra: Zebra | null }>();
/** Each vehicle's pose as `gapOpen` files it, written in place. */
const TRAFFIC_POSE = newPose();

/** Margin of clear road a walker wants beyond their own time across, s; after `IMPATIENT` waiting, none. */
const GAP_MARGIN = 2;
const IMPATIENT = 30;
/** A vehicle this near the crossing keeps a walker on the kerb whatever it is doing, u. */
const GAP_NEAR = m(6);

/**
 * Whether a walker may step onto a crossing with no zebra: no vehicle near
 * it, and none coming that would reach it before they are across and a
 * margin more (gap acceptance, as SUMO's pedestrians take a crossing without
 * priority). Nothing stops for them there.
 */
function gapOpen(w: SimWorld, s: State, z: Zebra, pace: number, waited: number): boolean {
  const path = z.way.path;
  const time = path.length / Math.max(pace, m(0.5)) + (waited < IMPATIENT ? GAP_MARGIN : 0);
  // The vehicles by cell, filed once this tick (their poses were worked out
  // for every vehicle at every ask): only those within reach of the
  // crossing - the nearest, or the fastest's distance in that time - are read.
  if (s.trafficAt !== s.clock) {
    s.trafficAt = s.clock;
    s.traffic.clear();
    s.fastest = 0;
    const file = (x: number, y: number, angle: number, speed: number): void => {
      const k = cellKey(x, y, TRAFFIC_CELL);
      const seen: TrafficSeen = { x, y, angle, speed };
      const list = s.traffic.get(k);
      if (list) list.push(seen); else s.traffic.set(k, [seen]);
    };
    const pose = TRAFFIC_POSE;
    for (const v of w.vehicles.values()) {
      if (!vehiclePoseNowInto(w, v, pose)) continue;
      file(pose.p.x, pose.p.y, pose.angle, v.v);
      if (v.v > s.fastest) s.fastest = v.v;
      // On the planet, a ghost image (`wayGhostCharts`) on the chart of the
      // junction it drives into, whose zebras are kept there: a lane coming
      // from a node across a border is written on that node's chart.
      if (!__PLANET__) continue;
      const lane = w.lanelet(v.lanelet);
      const ahead = lane?.kind === 'link' ? lane.to : lane?.toLane !== undefined ? w.lanelet(lane.toLane)?.to : undefined;
      const node = ahead !== undefined ? w.doc.node(ahead) : undefined;
      if (!node) continue;
      const from = chartAt(pose.p.x, pose.p.y), to = chartAt(node.x, node.y);
      if (from === to) continue;
      const angle = carryHeading(from, to, pose.p.x, pose.p.y, pose.angle);
      chartToChartInto(from, to, pose.p.x, pose.p.y, carried);
      file(carried.x, carried.y, angle, v.v);
    }
  }
  const reach = Math.max(GAP_NEAR, s.fastest * time);
  const box = path.bbox;
  const gx0 = Math.floor((box.minX - reach) / TRAFFIC_CELL), gx1 = Math.floor((box.maxX + reach) / TRAFFIC_CELL);
  const gy0 = Math.floor((box.minY - reach) / TRAFFIC_CELL), gy1 = Math.floor((box.maxY + reach) / TRAFFIC_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
    for (const v of s.traffic.get(cell(gx, gy)) ?? NO_TRAFFIC) {
      const hit = path.closestPoint(v);
      if (hit.distance < GAP_NEAR) return false;
      if (v.speed < m(0.5) || hit.distance > v.speed * time) continue;
      // Coming towards it, not going away.
      if ((hit.point.x - v.x) * Math.cos(v.angle) + (hit.point.y - v.y) * Math.sin(v.angle) > 0) return false;
    }
  }
  return true;
}
const NO_TRAFFIC: readonly TrafficSeen[] = [];

/**
 * The zebra a walker is coming up to and has not been let onto, and the
 * distance along its route to where it waits for it (a step back from the
 * kerb); null when none is ahead on this step or the next.
 */
function zebraAhead(w: SimWorld, p: Walker): { zebra: Zebra; stop: number } | null {
  const st = p.steps[p.leg]!;
  const here = crossingOf(w, st.way);
  if (here) {
    const kerb = kerbInset(p.steps[p.leg - 1]?.way);
    if (p.granted === here.id || p.s >= kerb) return null;
    return { zebra: here, stop: kerb - KERB_BACK - p.s };
  }
  const next = p.steps[p.leg + 1];
  const ahead = crossingOf(w, next?.way);
  if (!ahead || p.granted === ahead.id) return null;
  return { zebra: ahead, stop: stepLength(st) - p.s + kerbInset(st.way) - KERB_BACK };
}

/** Whether a walker is out on a zebra's carriageway, kerb to kerb. */
function onZebra(w: SimWorld, p: Walker): Zebra | null {
  const st = p.steps[p.leg]!;
  const z = crossingOf(w, st.way);
  if (!z) return null;
  const from = kerbInset(p.steps[p.leg - 1]?.way), to = stepLength(st) - kerbInset(p.steps[p.leg + 1]?.way);
  return p.s >= from && p.s <= to ? z : null;
}

// ------------------------------------------------------------------ engine

const wayKeys = new WeakMap<Walkway, string>();
/** A walkway by what it is and where it runs: the same on both sides of an edit that left it as it was. */
function wayKey(way: Walkway): string {
  let key = wayKeys.get(way);
  if (key === undefined) {
    const points = way.path.toPoints().map((q) => `${q.x.toFixed(3)},${q.y.toFixed(3)}`).join(';');
    key = `${way.kind}|${way.segment ?? ''}|${way.node ?? ''}|${way.kerb}|${way.structure}|${way.unmarked ? 1 : 0}|`
      + `${way.lo.toFixed(4)}|${way.hi.toFixed(4)}|${points}`;
    wayKeys.set(way, key);
  }
  return key;
}

/** How far from a lane's centre somebody on the footway may be hailed from (`hailable`). */
const HAIL_REACH = m(9);
/** How far from the door the walkway somebody gets out onto may be (`alight`). */
const ALIGHT_SNAP = m(4);
/** Ways tried for somebody getting out of a car (`alight`). */
const ALIGHT_TRIES = 4;

export function createAgentWalkEngine(): PedestrianEngine {
  const bridge: PeopleBridge = {
    // A car stopping at the kerb for somebody (`vehicles/kerbStops.ts`): a
    // grown-up walking on the footway on the kerb side of the lane, between
    // `s0` and `s1` along it, the nearest the car first. Stubs since this
    // engine came in: nobody was ever picked up but a lorry's own mate.
    hailable(w, lanelet, s0, s1, exclude) {
      const lane = w.lanelet(lanelet);
      if (!lane) return null;
      let best: { id: number; s: number } | null = null;
      for (const p of stateOf(w).walkers) {
        if (p.done || p.inside || p.player || p.act || p.rush || (p.fright ?? 0) > p.age) continue;
        if (p.view.ageClass === 'child' || p.view.ground !== 'footway' || exclude?.has(p.id)) continue;
        const hit = lane.centre.closestPoint({ x: p.x, y: p.y });
        if (hit.s < s0 || hit.s > s1 || hit.distance > HAIL_REACH) continue;
        // The kerb side: right of the way the lane runs (`kerbStops.ts` kerbSide).
        const f = lane.centre.sampleAt(hit.s);
        if ((p.x - f.p.x) * f.t.y - (p.y - f.p.y) * f.t.x <= 0) continue;
        if (!best || hit.s < best.s) best = { id: p.id, s: hit.s };
      }
      return best;
    },
    // Into the car: off the street, as they stand, if they are still free
    // and within `reach` of the door.
    board(w, id, door, reach) {
      const s = stateOf(w);
      const p = s.byId.get(id);
      if (!p || p.done || p.inside || p.player || hypot(p.x - door.x, p.y - door.y) > reach) return null;
      const boarder = { seed: p.id, gender: p.view.gender, ageClass: p.view.ageClass, footX: p.x, footY: p.y, footHeading: p.heading };
      finish(s, p, false);
      prune(s);
      return boarder;
    },
    // Somebody out of a car at the kerb (`vehicles/kerbStops.ts`): a walker
    // from where they stand by the door, off along the footways to somewhere
    // 60 to 200 m away. It was a stub since this engine came in (2026-10-05):
    // nobody dropped off ever stepped onto the pavement (`kerbStops.spec`).
    // The way is drawn from the person's seed: `sim` never calls Math.random.
    alight(w, person) {
      const s = stateOf(w);
      ensureGraph(w, s);
      const h = personHash(person.seed);
      // Out onto the walkway nearest the door, not the point by the door off
      // it: begun there, the walker stood on the open ground (the terrain's
      // height) a step and then rose onto the footway.
      const at = nearestWay(s, { x: person.footX, y: person.footY }, ALIGHT_SNAP);
      const foot = at ? at.way.path.sampleAt(at.s).p : { x: person.footX, y: person.footY };
      const walk = (to: { readonly x: number; readonly y: number }): boolean =>
        startWalk(w, { trip: -1, fromX: foot.x, fromY: foot.y, toX: to.x, toY: to.y, seed: person.seed, ageClass: person.ageClass, reach: m(6) }) !== null;
      for (let k = 0; k < ALIGHT_TRIES; k++) {
        const a = (((h >>> (k * 5)) & 0x3ff) / 0x400) * Math.PI * 2;
        const d = m(60) + (((h >>> (k * 3 + 7)) & 0xff) / 0xff) * m(140);
        const hit = nearestWay(s, { x: person.footX + Math.cos(a) * d, y: person.footY + Math.sin(a) * d }, m(30));
        if (hit && walk(hit.way.path.sampleAt(hit.s).p)) return true;
      }
      // Nowhere 60 to 200 m off is reached on foot from here (a footway cut
      // off from the rest, a street no car reached before): along the walkway
      // they stand on, then. The passenger vanished at the door
      // (`kerbStops.spec`, the player's map: 4 of 16 set down).
      if (at) {
        const length = at.way.path.length;
        for (const ds of [m(25), -m(25), m(8), -m(8)]) {
          const s2 = Math.max(0, Math.min(length, at.s + ds));
          if (Math.abs(s2 - at.s) >= m(2) && walk(at.way.path.sampleAt(s2).p)) return true;
        }
      }
      return false;
    },
    anyoneWithin(w, x, y, radius, except) {
      // The walkers by cell, filed once a tick (every walker was read at every ask).
      const s = stateOf(w);
      if (s.nearAt !== s.clock) {
        s.nearAt = s.clock;
        s.near.clear();
        for (const p of imagesOf(s)) {
          if (p.inside || p.done) continue;
          const k = cellKey(p.x, p.y, CELL);
          const list = s.near.get(k);
          if (list) list.push(p); else s.near.set(k, [p]);
        }
      }
      // A cell's margin: anybody moved since they were filed is still found.
      const r = radius + CELL;
      const gx0 = Math.floor((x - r) / CELL), gx1 = Math.floor((x + r) / CELL);
      const gy0 = Math.floor((y - r) / CELL), gy1 = Math.floor((y + r) / CELL);
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
        for (const p of s.near.get(cell(gx, gy)) ?? []) if (!p.inside && !p.done && p.id !== except && hypot(p.x - x, p.y - y) < radius) return true;
      }
      return false;
    },
  };
  const engine: PedestrianEngine = {
    kind: 'people',
    bridge,
    beginTick(w) {
      for (const p of stateOf(w).walkers) { p.prevX = p.x; p.prevY = p.y; p.prevHeading = p.heading; }
    },
    dispatch() {},
    step(w) { stepWalkers(w); },
    rebind(w) {
      const s = stateOf(w);
      const before = s.graph;
      const g = ensureGraph(w, s);
      // The walkways themselves unchanged (a building's doors, say): every
      // route stands as it is.
      if (g && g === before) return;
      // The walkways the edit left as they were, by what they are and where
      // they run: a walker whose route is all on those goes on with it; only
      // the others look for a way again (each a search of the walkways).
      const kept = new Map<string, Walkway>();
      if (g && before) for (const way of g.ways) kept.set(wayKey(way), way);
      for (const p of s.walkers) {
        if (kept.size && p.steps.every((st) => !st.way || kept.has(wayKey(st.way)))) {
          for (let i = 0; i < p.steps.length; i++) {
            const st = p.steps[i]!;
            if (st.way) p.steps[i] = { ...st, way: kept.get(wayKey(st.way))! };
          }
          continue;
        }
        // Found again from where they are, through a lot's gate when the walk runs through one (`reroute`).
        if (!reroute(w, s, p, lastOf(p))) finish(s, p);
      }
      prune(s);
    },
    publish(w) { publish(w); },
    audit(_w: SimWorld, _out: AuditIssue[]) {},
    reset(w) {
      const s = stateOf(w);
      s.walkers.length = 0;
      s.byId.clear();
      s.arrivals.length = 0;
      s.graph = null;
      s.builtFor = '';
      s.shocks.length = 0;
    },
    walkTrip(w, trip) { return startWalk(w, trip); },
    takeArrivals(w) {
      const s = stateOf(w);
      const out = s.arrivals.slice();
      s.arrivals.length = 0;
      return out;
    },
    impact(w, x, y, kill, scare) {
      // A blow (`editor` strike): killed within `kill` - off the street for
      // good, a body for the renderer to throw (`render/ragdoll.ts`), torn
      // apart right under it; knocked down within twice that, up again where
      // the body comes to rest (`getUp`); everybody within `scare` runs.
      const s = stateOf(w);
      let dead = 0;
      for (const p of [...s.walkers]) {
        if (p.inside || p.done) continue;
        const d = hypot(p.x - x, p.y - y);
        if (d >= kill * 2) continue;
        const v = p.view;
        const who = { x: p.x, y: p.y, heading: p.heading, t: 0, id: p.id, gender: v.gender, ageClass: v.ageClass,
          party: { id: v.party.id, size: v.party.size, archetype: v.party.archetype, hasChild: v.party.hasChild }, blastX: x, blastY: y };
        if (d < kill && !p.player) {
          // Right under it: burnt black and torn limb from limb; further off,
          // killed, an arm, a leg or the head often blown off.
          const roll = personHash(p.id ^ 0x5eed);
          const torn = d < kill * 0.4;
          const all: Severable[] = ['head', 'armL', 'armR', 'legL', 'legR'];
          const severed = torn ? all.filter((_, i) => ((roll >> i) & 1) === 1 || i === (roll >>> 8) % 5)
            : (roll & 3) !== 0 ? [all[1 + ((roll >>> 4) % 4)]!, ...((roll & 12) === 12 ? ['head' as const] : [])] : [];
          // Burnt black, everybody it kills (only those right under it were:
          // a charred body was hardly ever seen - the player, 2026-10-06).
          recordCasualty(w, { ...who, kind: torn ? 'torn' : 'dead', power: 1 - d / kill, severed, lost: severed, charred: true });
          finish(s, p, false);
          dead++;
          continue;
        }
        p.act = { kind: 'fall', from: p.age, until: p.age + 14, faceX: x, faceY: y };
        p.v = 0;
        // Near the blow, some lose an arm or a leg and go on without it.
        if (d < kill * 1.5 && !p.maimed && (personHash(p.id ^ 0x3c1) & 3) !== 0) {
          p.maimed = (['armL', 'armR', 'legL', 'legR'] as const)[personHash(p.id ^ 0x77) & 3]!;
        }
        const maimedNow = p.maimed !== undefined && !(p.lost ?? []).includes(p.maimed);
        if (maimedNow) { (p.lost ??= []).push(p.maimed!); p.bleeding = 1.2; }
        // A leg gone: down for good, dragging themself off and bleeding out, as from a shot.
        const legGone = (p.lost ?? []).some((l) => l === 'legL' || l === 'legR');
        if (legGone) { p.act = { ...p.act, until: p.age + 600 }; p.bleeding = 2.2; }
        recordCasualty(w, { ...who, kind: 'knocked', power: Math.max(0, 1 - (d - kill) / kill), lost: [...(p.lost ?? [])],
          ...(maimedNow ? { severed: [p.maimed!] } : {}), ...(legGone ? { lieFor: 600, crawl: true } : {}) });
      }
      prune(s);
      startle(w, x, y, scare, 26, null);
      shock(s, x, y, Math.min(scare, m(45)));
      return dead;
    },
    shot(w, id, part, fromX, fromY) {
      const s = stateOf(w);
      const p = s.byId.get(id);
      if (!p || p.done || p.inside || p.player) return null;
      // As GTA's peds take it: a shot to the head kills; to the body a third
      // of their health; to an arm or a leg a fifth, the limb gone at the
      // second; each hit staggers them or knocks them down, and they run.
      // A head shot kills and leaves the head on: it comes off only to more
      // shots into the body (`render/ragdoll.ts` shootBody). One pistol
      // round took it off (recorded 2026-10-06).
      const DAMAGE: Record<BodyPart, number> = { head: 100, torso: 34, armL: 20, armR: 20, legL: 20, legR: 20 };
      const hpBefore = p.hp ?? 100;
      p.hp = (p.hp ?? 100) - DAMAGE[part];
      p.hurt ??= {};
      p.hurt[part] = (p.hurt[part] ?? 0) + DAMAGE[part];
      p.lost ??= p.maimed ? [p.maimed] : [];
      // Already down (`fall`): shot where they lie, a limb hit comes off at once.
      const wasDown = p.act?.kind === 'fall';
      let severed: Severable | null = null;
      if (part !== 'torso' && part !== 'head' && !p.lost.includes(part) && (p.hurt[part]! >= 40 || wasDown)) {
        severed = part;
        p.lost.push(part);
        p.maimed ??= part;
        // A limb shot off takes a good share of the blood with it.
        p.hp -= 15;
      }
      const v = p.view;
      // A grave trunk wound opens the belly, the guts out: always at the third
      // round in the trunk, now and then at the second - never at the first
      // (the player, 2026-10-06: organs from one shot are absurd; in grave
      // cases they come out).
      const trunkHits = Math.round((p.hurt.torso ?? 0) / DAMAGE.torso);
      const opened = part === 'torso' && !p.opened && (trunkHits >= 3 || (trunkHits === 2 && (personHash(p.id ^ 0x0b1e) & 255) < 102));
      if (opened) p.opened = true;
      // The hole and the blood on their clothes (`render/agents.ts`).
      recordWound(w, p.id, part, fromX, fromY);
      p.lastHit = { part, damage: hpBefore - p.hp, at: p.age };
      trace(p, 'hit', `hp ${hpBefore}`, `hp ${p.hp} ${part}${severed ? ` severed ${severed}` : ''}`, 'shot');
      if (p.hp <= 0) {
        recordCasualty(w, { x: p.x, y: p.y, heading: p.heading, t: 0, id: p.id, gender: v.gender, ageClass: v.ageClass,
          party: { id: v.party.id, size: v.party.size, archetype: v.party.archetype, hasChild: v.party.hasChild },
          blastX: fromX, blastY: fromY, kind: 'dead', power: 0.25, lost: [...p.lost], struck: part, ...(severed ? { severed: [severed] } : {}),
          ...(opened ? { opened } : {}) });
        finish(s, p, false);
        prune(s);
        mourn(s, p);
        startle(w, p.x, p.y, m(45), 18, null);
        shock(s, p.x, p.y, BODY_SHOCK);
        return { killed: true, severed };
      }
      // Hurt, not killed. As GTA's shot peds take it (NaturalMotion's
      // euphoria: a stagger with a hand to the wound, a leg shot dropping them
      // onto their knees and hands): a leg wound puts them down, a trunk
      // wound half the time, and they get up and away hurt; otherwise a
      // stagger back, a hand to it, and away. Hurt badly - a second wound, a
      // limb gone, already down - they go down and stay down: writhing where
      // they lie, bleeding.
      p.hits = (p.hits ?? 0) + 1;
      const legGone = p.lost.includes('legL') || p.lost.includes('legR');
      // Incapacitated (`woundOf` grave: half their health gone or a limb lost),
      // or shot again while already down: they go down and stay down. A
      // lighter wound - however many - is taken on their feet.
      const grave = woundOf(p)?.grave ?? false;
      if (!wasDown && !grave) {
        const before = actName(p.act);
        const leg = part === 'legL' || part === 'legR';
        if (leg || (part === 'torso' && (personHash(p.id ^ (p.hits * 0x2f9b)) & 255) < 128)) {
          // Knocked down (`render/ragdoll.ts`: a leg gives way and they go
          // onto their knees and hands, a round in the trunk throws them back),
          // a moment on the ground, then up (`getUp`, which sets when) and away.
          p.act = { kind: 'fall', from: p.age, until: p.age + KNOCKED_MOST, faceX: fromX, faceY: fromY };
          trace(p, 'act', before, actName(p.act), `shot: light wound (hp ${p.hp}), knocked down`);
          recordCasualty(w, { x: p.x, y: p.y, heading: p.heading, t: 0, id: p.id, gender: v.gender, ageClass: v.ageClass,
            party: { id: v.party.id, size: v.party.size, archetype: v.party.archetype, hasChild: v.party.hasChild },
            blastX: fromX, blastY: fromY, kind: 'knocked', power: 0.1, lost: [...p.lost],
            lieFor: 1.2 + ((personHash(p.id ^ 0x1e4) & 255) / 255) * 1.6, struck: part });
        } else {
          p.act = { kind: 'flinch', from: p.age, until: p.age + FLINCH, faceX: fromX, faceY: fromY };
          trace(p, 'act', before, actName(p.act), `shot: light wound (hp ${p.hp}), taken standing`);
        }
        p.v = 0;
        p.fright = p.age + 30;
        mourn(s, p);
        startle(w, p.x, p.y, m(45), 18, null);
        shock(s, p.x, p.y, BODY_SHOCK);
        return { killed: false, severed };
      }
      const beforeFall = actName(p.act);
      p.act = { kind: 'fall', from: p.age, until: p.age + 600, faceX: fromX, faceY: fromY };
      trace(p, 'act', beforeFall, actName(p.act), wasDown ? 'shot while down' : `shot: incapacitated (hp ${p.hp}${severed ? `, ${severed} lost` : ''})`);
      p.bleeding = Math.max(p.bleeding ?? 0, legGone ? 3 : severed ? 1.6 : 0.9);
      recordCasualty(w, { x: p.x, y: p.y, heading: p.heading, t: 0, id: p.id, gender: v.gender, ageClass: v.ageClass,
        party: { id: v.party.id, size: v.party.size, archetype: v.party.archetype, hasChild: v.party.hasChild },
        blastX: fromX, blastY: fromY, kind: 'knocked', power: severed ? 0.35 : 0.15, lost: [...p.lost],
        lieFor: 600, crawl: true, struck: part, ...(severed ? { severed: [severed] } : {}), ...(opened ? { opened } : {}) });
      p.v = 0;
      p.fright = p.age + 30;
      mourn(s, p);
      startle(w, p.x, p.y, m(45), 18, null);
      shock(s, p.x, p.y, BODY_SHOCK);
      return { killed: false, severed };
    },
    getUp(w, id, x, y, heading, seconds, crawl) {
      // Up where the body came to rest (the walkway nearest it), facing the
      // way it rises, the fall held until the getting-up is over.
      const s = stateOf(w);
      const p = s.byId.get(id);
      if (!p || p.done) return;
      // Moved to where the body lies: the walkers are filed again (`anyoneWithin`).
      s.nearAt = -1;
      if (p.player) {
        // The player gets up where their body lies, and is held down exactly until up (`ambient/play.ts`).
        p.x = p.prevX = x; p.y = p.prevY = y; p.heading = p.prevHeading = heading;
        if (p.act?.kind === 'fall') p.act = { ...p.act, until: p.age + seconds };
        return;
      }
      {
        // Exactly where the body lies (they were put on the nearest walkway,
        // metres off: a jump the moment they stood), walking back onto the
        // walkways from there.
        const goal = p.rush?.goal ?? lastOf(p);
        p.x = p.prevX = x; p.y = p.prevY = y;
        replan(w, s, p, goal);
        p.heading = p.prevHeading = heading;
      }
      // The body says when they are up: exactly then.
      if (p.act?.kind === 'fall') p.act = { ...p.act, until: p.age + seconds };
      if (crawl) {
        // Onto hands and knees, then crawling off the way the head points.
        p.crawlNext = true;
        replan(w, s, p, { x: x + Math.cos(heading) * m(25), y: y + Math.sin(heading) * m(25) });
      }
      if (p.rush) p.rush = { ...p.rush, until: Math.max(p.rush.until, p.age + seconds + 6) };
    },
    walkableNear(w, x, y, reach) {
      const s = stateOf(w);
      ensureGraph(w, s);
      const hit = nearestWay(s, { x, y }, reach);
      return hit ? hit.way.path.sampleAt(hit.s).p : null;
    },
  };
  // For probes in the page: what each walker is doing (`inspectAgentWalkers`).
  (engine as PedestrianEngine & { inspect?: typeof inspectAgentWalkers }).inspect = inspectAgentWalkers;
  return engine;
}

/** The steps from a point to a point: to the walkways, along them, and off to the end. */
function plan(w: SimWorld, s: State, from: Vec2, to: Vec2, reach: number): Step[] | null {
  const g = ensureGraph(w, s);
  if (!g) return null;
  const a = nearestWay(s, from, reach);
  const b = nearestWay(s, to, reach);
  if (!a || !b) return null;
  const along = route(g, a, b);
  if (!along) return null;
  const steps: Step[] = [];
  const onA = a.way.path.sampleAt(a.s).p;
  if (hypot(onA.x - from.x, onA.y - from.y) > m(0.3)) steps.push({ way: null, dir: 1, from: 0, to: 0, a: from, b: onA });
  steps.push(...along.filter((st) => Math.abs(st.to - st.from) > 1e-6));
  const onB = b.way.path.sampleAt(b.s).p;
  if (hypot(onB.x - to.x, onB.y - to.y) > m(0.3)) steps.push({ way: null, dir: 1, from: 0, to: 0, a: onB, b: to });
  return steps.length ? steps : [{ way: null, dir: 1, from: 0, to: 0, a: from, b: to }];
}

/** The straight stretches through a lot along `points` (a door to a gate's foot, or back). */
function lotSteps(points: readonly Vec2[]): Step[] {
  const out: Step[] = [];
  for (let i = 1; i < points.length; i++) out.push({ way: null, dir: 1, from: 0, to: 0, a: points[i - 1]!, b: points[i]!, lot: true });
  return out;
}

/**
 * A walk that begins by coming out through a lot (`head`: from its door to
 * its gate's foot on the footway) or ends by going in through one (`tail`:
 * from a gate's foot to the door), or both; the walkways between. The walker
 * waits inside the door until the spot is clear, as anybody made does, and
 * goes in (is done) at the door. `trip.from`/`to` are the door's points.
 */
export function walkThrough(w: SimWorld, trip: ResidentWalk, head: readonly Vec2[], tail: readonly Vec2[]): number | null {
  return startWalk(w, trip, head, tail);
}

/** Farthest a gate's foot may be from the walkway it is joined to. */
const GATE_JOIN = m(4);

/**
 * A lot's way (door ... gate, foot) joined to the footway: its foot moved to
 * the walkway point nearest it, so the walk turns off the walkway and goes
 * straight on through the gate (the foot lies square out from the gate, and
 * so does the nearest point of the footway along the lot). Kept at the foot,
 * a walkway nearer the lot than the foot (measured: 0.26 m from the boundary,
 * the foot 0.5 m out) made the walk step out past the walkway and back.
 */
function joinFootway(s: State, way: readonly Vec2[], footFirst: boolean): readonly Vec2[] {
  if (way.length < 2) return way;
  const foot = footFirst ? way[0]! : way[way.length - 1]!;
  const hit = nearestWay(s, foot, GATE_JOIN);
  if (!hit) return way;
  const q = hit.way.path.sampleAt(hit.s).p;
  return footFirst ? [{ x: q.x, y: q.y }, ...way.slice(1)] : [...way.slice(0, -1), { x: q.x, y: q.y }];
}

function startWalk(w: SimWorld, trip: ResidentWalk, head: readonly Vec2[] = NO_POINTS, tail: readonly Vec2[] = NO_POINTS): number | null {
  const s = stateOf(w);
  if (head.length || tail.length) {
    ensureGraph(w, s);
    head = joinFootway(s, head, false);
    tail = joinFootway(s, tail, true);
  }
  const from = head.length ? head[head.length - 1]! : { x: trip.fromX, y: trip.fromY };
  const to = tail.length ? tail[0]! : { x: trip.toX, y: trip.toY };
  const mid = plan(w, s, from, to, Math.max(trip.reach ?? 0, REACH));
  if (!mid) return null;
  const steps = head.length || tail.length ? [...lotSteps(head), ...mid, ...lotSteps(tail)] : mid;
  const id = trip.person ?? s.nextId++;
  const old = s.byId.get(id);
  if (old) finish(s, old, false);
  const gender: PersonGender = trip.person !== undefined ? ((personHash(trip.person) & 1) === 0 ? 'f' : 'm')
    : (trip.seed & 1) === 1 ? 'f' : 'm';
  const ageClass: PersonAgeClass = trip.ageClass;
  const h = personHash(id);
  // Walking with somebody: their pace, their group.
  const leader = trip.with !== undefined ? s.byId.get(trip.with) : undefined;
  const pace = leader ? leader.pace : Math.max(PED.minSpeed, Math.min(PED.maxSpeed,
    PED.meanSpeed + ((h % 1000) / 1000 - 0.5) * 2 * PED.speedSd)) * (ageClass === 'elder' ? 0.8 : ageClass === 'child' ? 0.9 : 1);
  const first = frame(steps[0]!, 0);
  const heading = Math.atan2(first.ty, first.tx);
  const view: PedView = {
    id, x: trip.fromX, y: trip.fromY, heading, prev: { x: trip.fromX, y: trip.fromY, heading },
    v: 0, turnV: 0, age: 0, ageClass, gender,
    party: { id, size: 1, archetype: 'solo', hasChild: false }, rank: 0,
    ground: 'footway', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null, gesture: null,
  };
  const p: Walker = {
    id, trip: trip.trip, view, pace, steps, leg: 0, s: 0, d: 0, aim: 0, v: 0,
    x: trip.fromX, y: trip.fromY, heading, prevX: trip.fromX, prevY: trip.fromY, prevHeading: heading,
    turnV: 0, age: 0, held: 0, waited: 0, asked: 0, granted: null, done: false, waiting: null, zebra: null, inside: true,
    player: false, act: null, rush: null,
    ...WALKER_SHAPE,
  };
  if (leader) {
    // One group: the leader's id, its size, a child in it or not; a pair a couple, with a child a family.
    p.leader = leader.id;
    const members = s.walkers.filter((q) => !q.done && q.view.party.id === leader.view.party.id);
    const hasChild = ageClass === 'child' || members.some((q) => q.view.ageClass === 'child');
    const party = { id: leader.view.party.id, size: members.length + 1, archetype: hasChild ? 'family' as const : 'couple' as const, hasChild };
    for (const q of members) q.view.party = party;
    view.party = party;
    view.rank = members.length;
  }
  const pr = project(steps[0]!, p.x, p.y);
  p.s = pr.s; p.d = pr.d; p.aim = clamp(pr.d, room(steps[0]!));
  s.walkers.push(p);
  s.byId.set(id, p);
  return id;
}

function finish(s: State, p: Walker, arrived = true): void {
  p.done = true;
  s.byId.delete(p.id);
  if (arrived) s.arrivals.push(p.trip);
}

function prune(s: State): void {
  if (s.walkers.some((q) => q.done)) s.walkers = s.walkers.filter((q) => !q.done);
}

/** The point the body walks towards: a little ahead on its route, in its stripe. */
function target(p: Walker): { x: number; y: number } {
  let leg = p.leg;
  let st = p.steps[leg]!;
  // Through a lot and its gate, a short look ahead (Reynolds, as The Nature
  // of Code puts it: the distance ahead "should be dynamic"): the gate's
  // foot is 0.6 m out on the footway, and a point 0.9 m ahead cut the turn
  // from the footway into the gate across the fence beside it (10 cm from it,
  // measured). With it the body slows at the turn and turns there, as a
  // person turns in at a gate.
  let s = p.s + (st.lot ? LOT_AHEAD : AHEAD);
  while (s > stepLength(st) && leg + 1 < p.steps.length) {
    s -= stepLength(st);
    leg++;
    st = p.steps[leg]!;
    if (st.lot) s = Math.min(s, LOT_AHEAD);
  }
  if (leg === p.steps.length - 1) s = Math.min(s, stepLength(st));
  // In this step, towards its stripe, but no more across than SUMO lets a
  // walker move sideways for its forward speed (`MSPModel_Striping`
  // `PState::walk`: the lateral speed is capped at LATERAL_SPEED_FACTOR, 0.4,
  // of the walking speed, and the forward speed is never cut for it). The
  // point set on the stripe itself, 1.4 m across and 0.9 m ahead, was 57
  // degrees off: the speed fell to nothing (`want *= cos(err)...`), the body
  // stood turning towards it, and turned back as the stripe was set again on
  // the next step - the to and fro at the corners (`defects.spec`). In the
  // next step, where it is now across that one.
  const d = leg === p.leg ? p.d + Math.max(-LATERAL_SHARE * AHEAD, Math.min(LATERAL_SHARE * AHEAD, p.aim - p.d))
    : clamp(projectInto(st, p.x, p.y, AIM_PROJECTION).d, room(st));
  const f = frameInto(st, s, AIM_FRAME);
  TARGET.x = f.x - f.ty * d;
  TARGET.y = f.y + f.tx * d;
  return TARGET;
}
/** `target`'s point: made once, read by the walkers' step before it is asked again. */
const TARGET = { x: 0, y: 0 };

// ------------------------------------------------------------------ the step

/** Zones by cell: each in every cell its box reaches with a walker's look ahead round it. */
function fileZones(zones: readonly CarZone[]): Map<number, CarZone[]> {
  const cells = new Map<number, CarZone[]>();
  for (const z of zones) {
    const gx0 = Math.floor((z.x0 - LOOK) / ZONE_CELL), gx1 = Math.floor((z.x1 + LOOK) / ZONE_CELL);
    const gy0 = Math.floor((z.y0 - LOOK) / ZONE_CELL), gy1 = Math.floor((z.y1 + LOOK) / ZONE_CELL);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const k = cell(gx, gy);
      const list = cells.get(k);
      if (list) list.push(z); else cells.set(k, [z]);
    }
  }
  return cells;
}

/**
 * The walkers out on the street by cell of `CELL`, as Matthias Müller's dense
 * spatial hash files particles (Ten Minute Physics, "Spatial hashing": a table
 * twice the count, each cell's walkers counted, the counts summed into each
 * cell's start, the walkers written into one array behind them). A query
 * reads the cells round a point by index; a walker of another cell that
 * hashed to the same slot is told apart by the cell kept for it. Each walker
 * read 25 cells of a map of arrays every tick - a key hashed and an iterator
 * made for each, a third of the walkers' own time (profile, 2026-10-09).
 */
class WalkerGrid {
  readonly list: Walker[] = [];
  private cx = new Int32Array(0);
  private cy = new Int32Array(0);
  private start = new Int32Array(1);
  private entries = new Int32Array(0);
  private size = 1;

  private slot(x: number, y: number): number {
    return Math.abs(Math.imul(x, 92837111) ^ Math.imul(y, 689287499)) % this.size;
  }

  /** Files everybody out on the street (not inside, not done) where they are now. */
  build(walkers: readonly Walker[]): void {
    const list = this.list;
    list.length = 0;
    for (const p of walkers) if (!p.inside && !p.done) list.push(p);
    const n = list.length;
    if (this.cx.length < n) {
      const cap = Math.max(64, n * 2);
      this.cx = new Int32Array(cap);
      this.cy = new Int32Array(cap);
      this.entries = new Int32Array(cap);
    }
    this.size = Math.max(1, 2 * n);
    if (this.start.length < this.size + 1) this.start = new Int32Array(this.size * 2 + 1);
    const start = this.start;
    start.fill(0, 0, this.size + 1);
    for (let i = 0; i < n; i++) {
      const p = list[i]!;
      const x = Math.floor(p.x / CELL), y = Math.floor(p.y / CELL);
      this.cx[i] = x;
      this.cy[i] = y;
      start[this.slot(x, y)]!++;
    }
    let sum = 0;
    for (let h = 0; h < this.size; h++) { sum += start[h]!; start[h] = sum; }
    start[this.size] = sum;
    for (let i = 0; i < n; i++) {
      const h = this.slot(this.cx[i]!, this.cy[i]!);
      start[h]!--;
      this.entries[start[h]!] = i;
    }
  }

  /** Whether `fn` is true of anybody filed within `reach` cells of (x, y); stops at the first. */
  someNear(x: number, y: number, reach: number, fn: (q: Walker) => boolean): boolean {
    if (!this.list.length) return false;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    const start = this.start, entries = this.entries;
    for (let gx = cx - reach; gx <= cx + reach; gx++) for (let gy = cy - reach; gy <= cy + reach; gy++) {
      const h = this.slot(gx, gy);
      for (let k = start[h]!, end = start[h + 1]!; k < end; k++) {
        const i = entries[k]!;
        if (this.cx[i] !== gx || this.cy[i] !== gy) continue;
        if (fn(this.list[i]!)) return true;
      }
    }
    return false;
  }
}

// ---------------------------------------------------- the step's scratch
// What the walkers' step works with for each walker in turn, made once and
// written again: the bodies near it, the cars' zones in its cell, its span.
// Made anew for every walker every tick - the bodies as objects, the looks
// round them as closures, the zones joined into new arrays - they were some
// 260 MB in 10 s of a town with 400 people (the heap profiler, 2026-10-11).

/** A body near the walker, in its own frame (`addOther`). */
interface Other { along: number; lat: number; oncoming: boolean; r: number; waitFor: Zebra | null; facing: boolean }
const OTHERS: Other[] = [];
let othersN = 0;
function addOther(along: number, lat: number, oncoming: boolean, r: number, waitFor: Zebra | null, facing: boolean): void {
  let o = OTHERS[othersN];
  if (!o) OTHERS[othersN] = o = { along: 0, lat: 0, oncoming: false, r: 0, waitFor: null, facing: false };
  o.along = along; o.lat = lat; o.oncoming = oncoming; o.r = r; o.waitFor = waitFor; o.facing = facing;
  othersN++;
}

/** The walker looking round (`seeWalker`), and its frame. */
let seer: Walker | null = null;
let seerFrame: StepFrame = newStepFrame();
/** Another walker as `seer` sees it: one of its others if ahead within `LOOK`. */
function seeWalker(q: Walker): boolean {
  const p = seer!, f = seerFrame;
  if (q === p) return false;
  const rx = q.x - p.x, ry = q.y - p.y;
  const along = rx * f.tx + ry * f.ty;
  if (along <= 0 || along > LOOK) return false;
  const lat = p.d - rx * f.ty + ry * f.tx;
  const facing = Math.cos(q.heading) * f.tx + Math.sin(q.heading) * f.ty < -0.3;
  const oncoming = q.v > MOVING && facing;
  addOther(along, lat, oncoming, SHOULDERS - BODY, q.v < MOVING ? q.waiting : null, facing);
  return false;
}

/** Free distance ahead in a stripe centred `c` across the step. */
function freeAhead(c: number): number {
  let gap = LOOK;
  for (let k = 0; k < othersN; k++) {
    const o = OTHERS[k]!;
    if (Math.abs(o.lat - c) >= BODY + o.r) continue;
    const g = o.oncoming ? o.along / 2 : o.along;
    if (g < gap) gap = g;
  }
  return gap;
}

/** Whether the nearest body ahead in its own stripe (`d` across), near, stands waiting for `z`. */
function queuedForZebra(z: Zebra, d: number): boolean {
  let gap = KEEP + QUEUE_GAP, at: Zebra | null = null;
  for (let k = 0; k < othersN; k++) {
    const o = OTHERS[k]!;
    if (Math.abs(o.lat - d) >= BODY + o.r || o.oncoming) continue;
    if (o.along < gap) { gap = o.along; at = o.waitFor; }
  }
  return at === z;
}

/** What a stripe centred `c` costs for lying in the stripes kept for those coming the other way. */
function reserveCost(c: number, leftEdge: number, oncomingLeft: boolean, leftmost: number, wide: boolean): number {
  return (c > leftEdge + 1e-6 ? INAPPROPRIATE : 0) + (oncomingLeft && c > leftmost + 1e-6 && wide ? ONCOMING_CONFLICT : 0);
}

/** Whether (x, y) is within `margin` of any of the first `count` discs. */
function insideDiscs(discs: readonly { x: number; y: number; r: number }[], count: number, x: number, y: number, margin: number): boolean {
  const n = Math.min(count, discs.length);
  for (let i = 0; i < n; i++) {
    const c = discs[i]!;
    if (hypot(c.x - x, c.y - y) < c.r + margin) return true;
  }
  return false;
}

/** The cars' zones by cell this tick (`stepWalkers`), and the ones in a walker's cell (`zonesNearInto`). */
let nearParked: ReadonlyMap<number, CarZone[]> = new Map();
let nearMoving: ReadonlyMap<number, CarZone[]> = new Map();
const ZONES: CarZone[] = [];
/** The zones in `p`'s cell, the standing cars' first, into `ZONES`; how many. */
function zonesNearInto(p: Walker): number {
  const k = cellKey(p.x, p.y, ZONE_CELL);
  const standing = nearParked.get(k), moving = nearMoving.get(k);
  let n = 0;
  if (standing) for (let i = 0; i < standing.length; i++) ZONES[n++] = standing[i]!;
  if (moving) for (let i = 0; i < moving.length; i++) ZONES[n++] = moving[i]!;
  return n;
}

/** How many legs a walker has lost (a hobble on one, no walking on none). */
function legsLostOf(p: Walker): number {
  let n = 0;
  if (p.lost) { for (const l of p.lost) if (l === 'legL' || l === 'legR') n++; }
  else if (p.maimed === 'legL' || p.maimed === 'legR') n++;
  return n;
}

/** The walker's span across its step, widened at a kerb or on a zebra: its own copy of the step's room. */
const SPAN: [number, number] = [0, 0];

function stepWalkers(w: SimWorld): void {
  traceTick++;
  const s = stateOf(w);
  if (!s.walkers.length) return;
  ensureGraph(w, s);
  indexReservations(w);
  // Who is where, a cell of a few metres each (`WalkerGrid`); those who come
  // out of a door or a car during the pass are read from `late`.
  const late: Walker[] = [];
  const enter = (p: Walker): void => { late.push(p); };
  const grid = s.grid;
  // Those coming near a shocking event (a blow, a body) run from it.
  s.clock += DT;
  if (s.shocks.length && s.clock >= s.shockLook) {
    s.shockLook = s.clock + 0.4;
    s.shocks = s.shocks.filter((k) => k.until > s.clock);
    for (const p of s.walkers) {
      if (p.inside || p.done || p.player || (p.fright ?? 0) > p.age || p.act) continue;
      for (const k of s.shocks) {
        const d = hypot(p.x - k.x, p.y - k.y);
        if (d > k.radius) continue;
        frighten(w, s, p, k.x, k.y, d, 18);
        break;
      }
    }
  }
  // The wounded bleeding: their health running out, dead where they are.
  let bled = false;
  for (const p of s.walkers) {
    if (!p.bleeding || p.done || p.inside) continue;
    p.hp = (p.hp ?? 100) - p.bleeding * DT;
    if (p.hp > 0) continue;
    const v = p.view;
    recordCasualty(w, { x: p.x, y: p.y, heading: p.heading, t: 0, id: p.id, gender: v.gender, ageClass: v.ageClass,
      party: { id: v.party.id, size: v.party.size, archetype: v.party.archetype, hasChild: v.party.hasChild },
      blastX: p.x, blastY: p.y, kind: 'dead', power: 0, lost: [...(p.lost ?? [])], faded: true });
    shock(s, p.x, p.y, BODY_SHOCK);
    finish(s, p, false);
    bled = true;
  }
  if (bled) prune(s);
  grid.build(imagesOf(s));
  // Those running in panic who trip: down on the ground (the renderer throws
  // the body, `ragdoll.trip`), up again and running after.
  for (const p of s.walkers) {
    if (p.tripAt === undefined || p.age < p.tripAt || p.inside || p.done) continue;
    p.tripAt = undefined;
    if (p.act?.kind === 'fall') continue;
    p.act = { kind: 'fall', from: p.age, until: p.age + 3 + ((personHash(p.id) >> 3) & 3), faceX: p.x - Math.cos(p.heading), faceY: p.y - Math.sin(p.heading) };
    p.v = 0;
  }
  // The cars off the road: solid to a walker as a person is (the body three
  // discs along its length, half its width round: a walker's own body is the
  // margin, so a car in the road by the kerb does not close the kerb-side
  // stripe). Somebody already inside one walks on out of it.
  const carZones: CarZone[] = [];
  // The scenery's parked cars stand where they stand (the residents' own
  // cars, which drove across the footway in and out of their bays, were kept
  // apart with them, `src/backup/residents`). Their bodies are made again
  // only when a car came, went or moved: compared car by car with what was
  // seen last tick, plain fields read in order - a look-up of every one of
  // the town's ~220 parked cars in the zone cache each tick was 2 % of the
  // main thread with the test city running (audit, 2026-10-09).
  const parkedCars = w.ambient.parked;
  let sameParked = parkedCars.length === s.parkedSeen.length;
  for (let i = 0; sameParked && i < parkedCars.length; i++) {
    const car = parkedCars[i]!, seen = s.parkedSeen[i]!, f = car.free;
    sameParked = car === seen.car && (f ? f.x === seen.x && f.y === seen.y && f.angle === seen.angle : seen.zone === null);
  }
  s.onCarWay.clear();
  // The trains at grade: solid as cars are (nobody walks across a level crossing under one).
  for (const discs of w.city.transit.trainZones()) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of discs) { x0 = Math.min(x0, d.x - d.r); y0 = Math.min(y0, d.y - d.r); x1 = Math.max(x1, d.x + d.r); y1 = Math.max(y1, d.y + d.r); }
    // `on` empty: whoever is on a train's ground walks off it (`inside` below).
    carZones.push({ x0, y0, x1, y1, discs, on: TRAIN_GROUND, crossingOnly: false });
  }
  // The zones by cell, each in every cell its box reaches with a walker's look
  // ahead round it: a walker reads its own cell instead of every car in town
  // (the town's parked cars made that the step's second largest cost). A zone
  // a walker could see or touch is always in the walker's cell. The parked
  // cars' are filed again only when a car came, went or moved; the moving
  // ones' and the trains' every tick.
  if (!sameParked) {
    s.parkedSeen = parkedCars.map((car) => {
      const f = car.free;
      return f ? { car, x: f.x, y: f.y, angle: f.angle, zone: parkedZone(car, f) } : { car, x: 0, y: 0, angle: 0, zone: null };
    });
    s.parkedCells = fileZones(s.parkedSeen.flatMap((p) => (p.zone ? [p.zone] : [])));
  }
  const zoneCells = fileZones(carZones);
  const parkedCells = s.parkedCells;
  nearParked = parkedCells;
  nearMoving = zoneCells;
  // Where the player looks (`SimWorld.focus`, set by the renderer; null in the
  // specs: everybody in full). Out of it, a walker steps one tick in `COARSE`;
  // stepping round the others only where people are seen big enough to see it.
  const focus = w.focus;
  const tick = Math.round(s.clock / DT);
  const watched = (p: Walker): boolean => {
    if (!focus || hypot(p.x - focus.x, p.y - focus.y) <= focus.r) return true;
    const view = focus.view;
    if (!view) return false;
    const ex = p.x - view.ex, ey = p.y - view.ey, l = hypot(ex, ey);
    return l <= view.far && ex * view.dx + ey * view.dy >= view.cos * l;
  };


  for (const p of s.walkers) {
    p.age += DT;
    if (p.inside) {
      // Out when nobody is on the spot; then the next one waits for them to move off it.
      let clear = !grid.someNear(p.x, p.y, 1, (q) => hypot(q.x - p.x, q.y - p.y) < DOOR_CLEAR);
      for (let k = 0; clear && k < late.length; k++) if (hypot(late[k]!.x - p.x, late[k]!.y - p.y) < DOOR_CLEAR) clear = false;
      // Nor while a car holds the ground they would step onto: they wait for it to pass.
      if (clear) {
        const n = zonesNearInto(p);
        for (let zi = 0; clear && zi < n; zi++) if (insideDiscs(ZONES[zi]!.discs, ZONES[zi]!.discs.length, p.x, p.y, BODY)) clear = false;
      }
      if (clear) { p.inside = false; p.prevX = p.x; p.prevY = p.y; p.prevHeading = p.heading; enter(p); }
      continue;
    }
    // The player's body goes where the player moves it (`movePlayerWalker`);
    // what it does (a punch, a fall) ends in its time as anybody's does, or
    // a knocked-down player lies half risen for ever.
    if (p.player) {
      if (p.act && p.age >= p.act.until) p.act = null;
      continue;
    }
    // Out of the view: a step one tick in `COARSE`, by as many ticks' time.
    const seen = watched(p);
    if (!seen && ((tick + p.id) % COARSE + COARSE) % COARSE !== 0) continue;
    const dt = seen ? DT : COARSE * DT;
    // Stepping round the others where people are seen, and big enough to see it.
    const crowded = seen && (!focus || focus.detail);
    // Stopped for something (a word, a fall): standing there, facing it.
    // (Crawling is moving: on below, at a crawl.)
    if (p.act && p.act.kind !== 'crawl') {
      if (p.age < p.act.until) {
        p.v = 0;
        if (p.act.kind === 'flinch') {
          // Knocked back the way the round went (away from where it came from).
          const back = staggerSpeed(p.age - p.act.from);
          const ax = p.x - p.act.faceX, ay = p.y - p.act.faceY, l = hypot(ax, ay);
          if (back > 0 && l > 1e-6) { p.x += (ax / l) * back * dt; p.y += (ay / l) * back * dt; }
        }
        const want = Math.atan2(p.act.faceY - p.y, p.act.faceX - p.x);
        // Not for a fall or a wound: a shot person does not turn round on the
        // spot to face the shot (recorded 2026-10-06: a 180-degree spin, back
        // to the camera for 1.3 s, then a spin back to walk on).
        if (hypot(p.act.faceX - p.x, p.act.faceY - p.y) > m(0.1) && p.act.kind !== 'fall' && p.act.kind !== 'flinch') {
          const err = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
          p.heading += Math.max(-TURN_STANDING * dt, Math.min(TURN_STANDING * dt, err));
        }
        continue;
      }
      {
        const wound = woundOf(p);
        trace(p, 'act', actName(p.act), 'none', `act timer ran out (age ${p.age.toFixed(2)} >= until ${p.act.until.toFixed(2)}): `
          + (wound ? `moving on wounded (${woundPace(wound)}, ${wound.part}), at most ${WOUNDED_RUSH[woundPace(wound)]} of their pace fleeing, ${WOUNDED_PACE[woundPace(wound)]} walking` : 'walking resumes'));
      }
      // On from where the stagger left them, not from where they were struck.
      if (p.act.kind === 'flinch') replan(w, s, p, lastOf(p));
      p.act = null;
      // On hands and knees: crawling off till they bleed out.
      if (p.crawlNext) {
        p.crawlNext = false;
        p.act = { kind: 'crawl', from: p.age, until: p.age + 600, faceX: p.x, faceY: p.y };
        trace(p, 'act', 'none', 'crawl', 'down, gravely hurt: crawling off');
      }
    }
    // A run from danger over: on again to where they were going.
    if (p.rush && p.age >= p.rush.until) {
      const goal = p.rush.goal;
      trace(p, 'rush', rushName(p.rush), 'none', 'rush timer ran out: back to their own route');
      p.rush = null;
      replan(w, s, p, goal);
    }
    let st = p.steps[p.leg]!;
    const f = frameInto(st, p.s, WALK_FRAME);
    // Its own copy: widened below at a kerb or on a zebra.
    const kept = room(st);
    const span = SPAN;
    span[0] = kept[0]; span[1] = kept[1];
    // On a zebra everybody keeps to their right half: those coming the other
    // way are on the other half. Waiting at its kerb, the whole width: SUMO's
    // people "wait in front of crossings in a wide queue"
    // (sumo.dlr.de/docs/Simulation/Pedestrians.html). Kept to half, the
    // crowd of a long red stood three and four deep, back across the
    // footway's through zone, and held up everybody walking past the corner
    // (`defects.spec`, P101).
    const atKerb = crossingOf(w, st.way) !== null && p.waiting !== null && p.s < kerbInset(p.steps[p.leg - 1]?.way);
    if (crossingOf(w, st.way) && !atKerb) span[1] = Math.max(span[0], Math.min(span[1], BODY / 2));
    // And wider than the zebra, along the kerb (`WAIT_HALF`): on a narrow
    // footway the second and third rows of a crowd filled its whole width.
    // Let on, one standing past the zebra's edge steps along the kerb into it
    // before stepping off (`offZebra` below): beside the dropped kerb they
    // stepped down its 15 cm in one frame (`walkHeight.spec`).
    if (atKerb) { span[0] = Math.min(span[0], -WAIT_HALF); span[1] = Math.max(span[1], WAIT_HALF); }
    const zebraRoom = room(st);
    const offZebra = !atKerb && crossingOf(w, st.way) !== null && p.s < kerbInset(p.steps[p.leg - 1]?.way)
      && (p.d < zebraRoom[0] - m(0.05) || p.d > zebraRoom[1] + m(0.05));

    // --- the others, in this walker's own frame: how far ahead, how far across, which way they go.
    othersN = 0;
    if (crowded) {
      seer = p; seerFrame = f;
      grid.someNear(p.x, p.y, 1, seeWalker);
      // Out of a door or a car this pass: within the same cells.
      const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
      for (let k = 0; k < late.length; k++) {
        const q = late[k]!;
        if (Math.abs(Math.floor(q.x / CELL) - cx) <= 1 && Math.abs(Math.floor(q.y / CELL) - cy) <= 1) seeWalker(q);
      }
    }
    // The cars and trains: kept off wherever anybody can see it.
    const zonesN = seen ? zonesNearInto(p) : 0;
    for (let zi = 0; zi < zonesN; zi++) {
      const z = ZONES[zi]!;
      if (p.x < z.x0 - LOOK || p.x > z.x1 + LOOK || p.y < z.y0 - LOOK || p.y > z.y1 + LOOK) continue;
      // On it when the car took it, or inside the car's body (the car came to
      // them): they walk on out of its way.
      const inside = insideDiscs(z.discs, z.discs.length, p.x, p.y, 0);
      if (inside && (z.on === TRAIN_GROUND || z.on?.has(p.id) || insideDiscs(z.discs, 3, p.x, p.y, 0))) continue;
      if (!inside) z.on?.delete(p.id);
      const crossingNow = st.way?.kind === 'crossing';
      for (let i = 0; i < z.discs.length; i++) {
        const c = z.discs[i]!;
        // Past the body (`i >= 3`), a kerb car's way is only for those crossing.
        if (i >= 3 && z.crossingOnly && !crossingNow) break;
        const rx = c.x - p.x, ry = c.y - p.y;
        const along = rx * f.tx + ry * f.ty - c.r + BODY;
        if (along + 2 * c.r <= 0 || along > LOOK) continue;
        addOther(Math.max(0.01, along), p.d - rx * f.ty + ry * f.tx, false, c.r, null, false);
      }
    }

    // --- the stripe: the most room ahead, keeping to the right (SUMO's striping).
    if (span[1] > span[0]) {
      const right = span[0] + Math.min(span[1] - span[0], STRIPE * 0.5);
      // A metre less room for every stripe away from where the body is, unless
      // its own stripe is shut or it is held (SUMO's LATERAL_PENALTY, applied
      // while `distance[current] > 0` and the walker is not waiting,
      // `MSPModel_Striping`). A fifth of a unit a unit - an eighth of SUMO's -
      // let a standing walker swap between stripes a metre apart every tick,
      // turning its shoulders to each (`defects.spec`, four-way-avenues).
      const lateral = p.held === 0 && freeAhead(p.d) > m(0.05) ? LATERAL_PENALTY : 0;
      // Round a corner the leftmost stripes, in the way walked, are left to
      // those coming the other way (SUMO reserves 0.34 of a walking area's
      // stripes, at most 1.28 m: `getReserved`,
      // `pedestrian.striping.reserve-oncoming.junctions`): never taken, and
      // left by one standing in them (half the penalty, as SUMO's current
      // stripe). Two people meeting on a corner each kept to whichever side
      // the other was not, and swapped sides every tick, face to face.
      const leftEdge = span[1] - reservedFor(st);
      // Somebody coming the other way in the leftmost stripe: that stripe is
      // theirs, and both keep right of each other (SUMO's
      // ONCOMING_CONFLICT_PENALTY on the leftmost stripe, `walk`). Without it
      // two people meeting on a narrow footway stood nose to nose, each
      // stepping towards the side the other was taking.
      const leftmost = span[1] - STRIPE;
      let oncomingLeft = false;
      // In that stripe: overlapping it, not anywhere to the left (somebody on
      // the far side of the street is in nobody's stripe here).
      for (let k = 0; k < othersN; k++) {
        const o = OTHERS[k]!;
        if (o.oncoming && o.lat + o.r + BODY > leftmost && o.lat - o.r - BODY < span[1]) { oncomingLeft = true; break; }
      }
      const wide = span[1] - span[0] > STRIPE;
      // Held up, the stripe it holds is worth less than a free one: SWITCH_GAIN
      // keeps a walker from dithering between two, not standing behind a crowd
      // with a stripe a metre freer beside it (P101).
      const gain = p.held > HELD_SWITCH ? SWITCH_GAIN / 4 : SWITCH_GAIN;
      let best = p.aim, bestScore = freeAhead(p.aim) - (p.aim - right) * 0.15 - Math.abs(p.aim - p.d) * lateral + gain - reserveCost(p.aim, leftEdge, oncomingLeft, leftmost, wide) / 2;
      for (let c = span[0]; c <= span[1] + 1e-6; c += STRIPE / 2) {
        const score = freeAhead(c) - (c - right) * 0.15 - Math.abs(c - p.d) * Math.max(lateral, 0.2) - reserveCost(c, leftEdge, oncomingLeft, leftmost, wide);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      // A stripe just taken is kept a moment unless it shuts (`AIM_HOLD`): a
      // couple's second walker swapped between two stripes five times a
      // second, stepping left and right (`defects.spec` flips, P101).
      const next = clamp(best, span);
      if (Math.abs(next - p.aim) > 1e-6 && (p.age - (p.aimAt ?? -Infinity) >= AIM_HOLD || freeAhead(p.aim) < KEEP || p.held > HELD_SWITCH)) { p.aim = next; p.aimAt = p.age; }
    }
    p.aim = clamp(p.aim, span);

    // --- a zebra ahead: wait a step back from the kerb until it is theirs.
    // A leave not used in its time - held still short of the carriageway -
    // is asked for again; one walking on to the kerb keeps it.
    if (p.granted !== null && p.v < MOVING && p.age - (p.grantedAt ?? p.age) > GRANT_LIFE && !onZebra(w, p)) p.granted = null;
    const zebra = zebraAhead(w, p);
    p.zebra = zebra?.zebra ?? null;
    p.waiting = null;
    // Held behind somebody waiting for the same zebra, within a few metres of
    // it: in the queue, waiting too (SUMO's "wide queue" in front of a
    // crossing) - asking, standing, never pushing through the crowd.
    const queued = zebra !== null && zebra.stop < QUEUE_REACH && queuedForZebra(zebra.zebra, p.d);
    if (zebra && (zebra.stop < ASK_FROM || queued)) {
      p.waiting = zebra.zebra;
      p.waited += dt;
      p.asked -= dt;
      if (p.asked <= 0) {
        p.asked = ASK_EVERY;
        const open = zebra.zebra.edge ? mayEnterCrossing(w, zebra.zebra.edge, p.waited) : gapOpen(w, s, zebra.zebra, p.pace, p.waited);
        if (open || (p.fright ?? 0) > p.age) { p.granted = zebra.zebra.id; p.grantedAt = p.age; p.waited = 0; p.waiting = null; }
      }
    }
    const kerbStop = Math.max(0, kerbInset(p.steps[p.leg - 1]?.way) - KERB_BACK - p.s);
    const stop = p.waiting ? Math.max(0, zebra!.stop) : offZebra ? kerbStop : Infinity;

    // --- where it is going, and the turn towards it.
    const t = target(p);
    const tx = t.x - p.x, ty = t.y - p.y;
    let err = 0;
    // Crawling drags on straight the way the head points, not round the walkways.
    const crawling = p.act?.kind === 'crawl';
    if (crawling) p.turnV = 0;
    else if (hypot(tx, ty) > m(0.05)) {
      // Standing or at a shuffle (a crowd at a kerb, a queue, somebody slow
      // ahead): facing the way the walk goes, the step aside taken sideways
      // (`SIDESTEP` below) - as a person in a crowd steps aside without
      // turning round. Turned to the point ahead, each shuffle across swung
      // the head to and fro (`defects.spec` fidgets, P101). Not where the
      // point ahead is well round a turn: that is a corner to turn.
      const along = Math.atan2(f.ty, f.tx), ahead = Math.atan2(ty, tx);
      const want = p.v < SHUFFLE && Math.cos(ahead - along) > SHUFFLE_COS ? along : ahead;
      err = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
      const rate = (p.v < m(0.3) ? TURN_STANDING : TURN_RATE) * dt;
      const turn = Math.max(-rate, Math.min(rate, err));
      p.heading += turn;
      p.turnV = turn / dt;
      err -= turn;
    } else p.turnV = 0;

    // --- the speed: the room ahead in its own stripe, the wait, and the turn still to make.
    const crossing = crossingOf(w, st.way) !== null;
    // Jammed from the moment it has been held too long, until it is off this
    // step or the way ahead is clear (`Walker.jammedOn`).
    // Nose to nose: the nearest body in its own stripe faces it, standing as
    // it stands (a moving one is `oncoming` and the stripes sort them out).
    // Two people meeting so stood until the jam rule's 20 s - each the other's
    // only way - at a busy corner, between the queue for a zebra and the
    // stripe kept for those coming the other way (busy-crossroads, P101).
    // They squeeze past each other slowly at once, as SUMO has two people
    // do where only one fits abreast (`jamtime.narrow`, JAM_AFTER_NARROW).
    // The nearest body in its own stripe faces it, standing or walking (who
    // stops it for good: `JAM_NO_PROGRESS`); standing, nose to nose.
    // As far ahead as a queue is read (`queuedForZebra`): the one it stops for.
    let nearGap = KEEP + QUEUE_GAP, nearest: Other | null = null;
    for (let k = 0; k < othersN; k++) {
      const o = OTHERS[k]!;
      if (Math.abs(o.lat - p.d) >= BODY + o.r) continue;
      if (o.along < nearGap) { nearGap = o.along; nearest = o; }
    }
    // Somebody waiting at a kerb for a zebra is a queue to wait behind -
    // unless they face this walker: they wait to cross towards it, and it
    // is the one coming off that zebra into where they stand (a child stood
    // 10 s at the end of a zebra before the jam rule let it by, five-leg,
    // 2026-10-11).
    const notQueue = nearest?.waitFor == null || nearest.waitFor !== p.waiting;
    const facingAhead = !!nearest?.facing && notQueue;
    const noseToNose = facingAhead && !nearest!.oncoming;
    if (p.held > (st.lot || noseToNose ? JAM_AFTER_NARROW : crossing ? JAM_AFTER_CROSSING : JAM_AFTER)
      || (facingAhead && (p.progress?.since ?? 0) > JAM_NO_PROGRESS)) p.jammedOn = p.leg;
    else if (p.jammedOn !== undefined && (p.jammedOn !== p.leg || freeAhead(p.d) > KEEP)) p.jammedOn = undefined;
    const jammed = p.jammedOn === p.leg;
    // A leg lost: a hobble; both: no walking at all.
    const legsLost = legsLostOf(p);
    let want = p.pace * (crossing ? 1.15 : 1) * (p.rush?.by ?? 1) * (legsLost >= 2 ? 0 : legsLost === 1 ? 0.22 : 1);
    // Wounded: the wound sets the pace, whatever they were told - fleeing, a
    // hurt run (a hobble on a hurt leg); after, a slow hurt walk: the
    // reaction's end is not a recovery.
    const wound = woundOf(p);
    if (wound) want = Math.min(want, p.pace * (p.rush !== null && p.age < p.rush.until ? WOUNDED_RUSH : WOUNDED_PACE)[woundPace(wound)]);
    // Crawling: the capture's own pace (CMU 111_03, half a metre in four seconds).
    if (p.act?.kind === 'crawl') want = Math.min(want, CRAWL_PACE);
    // Walking with somebody: level with them - a little faster behind, slower ahead.
    if (p.leader !== undefined && !p.rush) {
      const lead = s.byId.get(p.leader);
      if (lead && !lead.done && !lead.act) {
        const ahead = (lead.x - p.x) * Math.cos(p.heading) + (lead.y - p.y) * Math.sin(p.heading);
        if (hypot(lead.x - p.x, lead.y - p.y) < m(6)) want *= ahead > m(0.5) ? 1.2 : ahead < -m(0.5) ? 0.8 : 1;
      }
    }
    if (jammed) want *= JAM_SHARE;
    else want = Math.min(want, Math.max(0, (freeAhead(p.d) - KEEP) / HEADWAY));
    if (stop < Infinity) want = Math.min(want, Math.sqrt(2 * BRAKE * stop));
    want *= Math.max(0, (Math.cos(err) - 0.5) / 0.5);
    p.v = want > p.v ? Math.min(want, p.v + ACCEL * dt) : Math.max(want, p.v - BRAKE * dt);
    const meansToGo = !(stop < m(0.1)) && !(queued && p.waiting);
    p.held = meansToGo && p.v < m(0.1) ? p.held + dt : 0;
    p.x += Math.cos(p.heading) * p.v * dt;
    p.y += Math.sin(p.heading) * p.v * dt;
    // Held up, or slow, a person steps aside into their stripe when it is free.
    const aside = p.aim - p.d;
    if (!crawling && Math.abs(aside) > m(0.02) && freeAhead(p.aim) > KEEP) {
      const ls = Math.max(-SIDESTEP, Math.min(SIDESTEP, aside / 0.25)) * Math.max(0, 1 - p.v / (0.6 * p.pace));
      // Across the way itself, towards the stripe: its left normal runs on
      // smoothly round a corner. Square to the body instead, the side was
      // the sign of the body against the way, which flips as a body turns
      // across a tight corner - the step went to and fro and people swayed
      // and spun at the corners (`defects.spec`, the corner walkways). Never
      // a step back: what of it goes against the body's heading is dropped.
      let mx = -f.ty * ls * dt, my = f.tx * ls * dt;
      const hx = Math.cos(p.heading), hy = Math.sin(p.heading);
      const back = mx * hx + my * hy;
      if (back < 0) { mx -= hx * back; my -= hy * back; }
      p.x += mx;
      p.y += my;
      // Stepping aside is moving: but by the step really taken. With all of
      // it against the body (a turn across a corner), none was taken and
      // the walker stood, yet was never counted as held - so never let
      // through as jammed: 10 s on the end of a zebra (mixed-lanes, P101).
      if (hypot(mx, my) > m(0.05) * dt) p.held = 0;
    }

    // --- where that left it on its route; on to the next step past the end of this one.
    let pr = projectInto(st, p.x, p.y, STEP_PROJECTION);
    p.s = pr.s; p.d = pr.d;
    if (!p.progress || p.progress.leg !== p.leg || p.s > p.progress.s + PROGRESS) p.progress = { leg: p.leg, s: p.s, since: 0 };
    else p.progress.since += dt;
    for (;;) {
      st = p.steps[p.leg]!;
      const len = stepLength(st);
      if (p.leg === p.steps.length - 1) {
        if (len - p.s <= THERE || hypot(t.x - p.x, t.y - p.y) <= THERE && len - p.s <= AHEAD) finish(s, p);
        break;
      }
      const next = p.steps[p.leg + 1]!;
      // Onto or off a lot's way only at the turn itself: let on early, the
      // body went for the gate from a step to the side of it.
      // A lot's stretch is also done once the body has ARRIVED at its turn
      // (within `THERE`, Reynolds' "arrival", GDC 1999): a body a little
      // aside of a short stretch steered for its end at more than 60°, stood,
      // turned, and circled it at 4 rad/s, never reaching the end's exact `s`
      // (in a back yard by a barbecue, 2026-10-10).
      const arrived = st.lot === true && !!st.b && hypot(st.b.x - p.x, st.b.y - p.y) <= THERE;
      const ahead = p.s >= len - m(0.02) || arrived || (!st.lot && !next.lot && p.s > len - AHEAD && projectAcross(next, p.x, p.y).s >= 0);
      if (!ahead) break;
      p.leg++;
      carryOnto(p, next);
      pr = projectInto(next, p.x, p.y, STEP_PROJECTION);
      p.s = pr.s; p.d = pr.d;
      p.aim = clamp(pr.d, room(next));
      if (!crossingOf(w, next.way)) p.granted = null;
    }
  }
  prune(s);
}

// ------------------------------------------------------------------ publish

function publish(w: SimWorld): void {
  const s = stateOf(w);
  w.crossingStates.clear();
  const views = w.pedViews;
  const byId = w.pedViewById;
  // The list is written over in place; the map by id is made again only when
  // somebody came out or went (each view object lives as long as its walker),
  // not for all 400 people every tick.
  const before = views.length;
  let count = 0, same = true;
  for (const p of s.walkers) {
    if (p.inside) continue;
    const st = p.steps[p.leg]!;
    const on = onZebra(w, p);
    // The vehicles' view of the zebras: who is on each, and who waits at it.
    const report = on ?? p.waiting;
    const edge = report?.edge;
    if (report && edge) {
      let state = w.crossingStates.get(report.id);
      if (!state) { state = emptyCrossingState(edge.length); w.crossingStates.set(report.id, state); }
      const hit = edge.path.closestPoint({ x: p.x, y: p.y });
      if (on) {
        const t = edge.path.sampleAt(hit.s).t;
        state.occupants.push({
          id: p.id, s: Math.max(0, Math.min(edge.length, hit.s)),
          forward: Math.cos(p.heading) * t.x + Math.sin(p.heading) * t.y >= 0,
          v: p.v, held: p.v < m(0.3) && p.held > 2,
        });
      } else {
        if (hit.s < edge.length / 2) state.waitingFrom++; else state.waitingTo++;
        state.demand = true;
        state.longestWait = Math.max(state.longestWait, p.waited);
      }
    }
    const v = p.view;
    v.x = p.x; v.y = p.y; v.heading = p.heading;
    v.prev.x = p.prevX; v.prev.y = p.prevY; v.prev.heading = p.prevHeading;
    v.v = p.v; v.turnV = p.turnV; v.age = p.age;
    // Off the footways - the player, or a stretch of a route over open
    // ground - the body stands on what is drawn under it, not at the height
    // of the nearest road (the player sank into the grass or floated over it).
    v.ground = on ? 'crossing' : p.player || !st.way ? 'open' : 'footway';
    v.segment = (st.way?.segment ?? undefined) as SegmentId | undefined;
    // Spelt out once a step, not a fresh string each tick.
    if (p.stretchOf !== st) { p.stretchOf = st; v.stretch = st.way ? `${st.way.id}:${st.dir}` : ''; }
    v.walking = p.v > m(0.1);
    v.gesture = p.act ? { kind: p.act.kind, phase: 'hold', t: p.age - p.act.from, hold: p.act.until - p.act.from,
      ...(p.act.kind === 'fall' ? { fromX: p.act.faceX, fromY: p.act.faceY } : {}) } : null;
    v.panic = (p.fright ?? 0) > p.age;
    if (p.maimed) v.maimed = p.maimed;
    if (p.lost?.length) v.lost = p.lost;
    if ((p.hp ?? 100) < 100) v.bleeding = true;
    const wound = woundOf(p);
    if (wound) v.wound = wound;
    v.kerbWait = p.waiting ? p.waited : 0;
    v.waitingFor = p.waiting ? p.waiting.id : null;
    if (same && (count >= before || views[count] !== v)) same = false;
    views[count++] = v;
  }
  views.length = count;
  if (!same || count !== before) {
    byId.clear();
    for (const v of views) byId.set(v.id, v);
  }
}

/** A read-only look at the walkers, for tests and diagnosis. */
export function inspectAgentWalkers(w: SimWorld): readonly {
  id: number; x: number; y: number; v: number; s: number; d: number; len: number;
  leg: number; legs: number; held: number; waited: number; kind: string;
  aim: number; heading: number; span: [number, number]; waiting: boolean; nextKind: string;
  /** Not out of the door yet. */
  inside: boolean;
  /** The walk comes out through a lot's gate (`fromLot`), goes in through one (`toLot`). */
  fromLot: boolean; toLot: boolean;
}[] {
  return stateOf(w).walkers.map((p) => ({
    id: p.id, x: p.x, y: p.y, v: p.v, s: p.s, d: p.d, len: stepLength(p.steps[p.leg]!),
    inside: p.inside, fromLot: p.steps[0]?.lot === true, toLot: p.steps[p.steps.length - 1]?.lot === true,
    leg: p.leg, legs: p.steps.length, held: p.held, waited: p.waited, kind: p.steps[p.leg]!.way?.kind ?? (p.steps[p.leg]!.lot ? 'lot' : 'off'),
    aim: p.aim, heading: p.heading, span: [...room(p.steps[p.leg]!)] as [number, number], waiting: p.waiting !== null,
    nextKind: (() => { const n = p.steps[p.leg + 1]; return !n ? 'end' : n.way?.kind ?? (n.lot ? 'lot' : 'off'); })(),
  }));
}

// ------------------------------------------------------------------ the player's hand

/** Somebody walking now, as the player and the police see them. */
export interface WalkerSeen {
  readonly id: number;
  readonly trip: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly v: number;
  readonly player: boolean;
  /** Knocked down, or stopped for something, and for how long yet (seconds). */
  readonly busy: number;
}

const seen = (p: Walker): WalkerSeen => ({ id: p.id, trip: p.trip, x: p.x, y: p.y, heading: p.heading, v: p.v, player: p.player,
  busy: p.act ? Math.max(0, p.act.until - p.age) : 0 });

/** The walkers within `radius` of a point, out on the street. */
export function walkersNear(w: SimWorld, x: number, y: number, radius: number): WalkerSeen[] {
  return stateOf(w).walkers.filter((p) => !p.inside && !p.done && hypot(p.x - x, p.y - y) < radius).map(seen);
}

/** One walker, by id, or null when nobody of that id is out. */
export function walkerOf(w: SimWorld, id: number): WalkerSeen | null {
  const p = stateOf(w).byId.get(id);
  return p && !p.inside && !p.done ? seen(p) : null;
}

/** Puts somebody walking under the player's hand: they stop following their route. */
export function takeWalker(w: SimWorld, id: number): boolean {
  const p = stateOf(w).byId.get(id);
  if (!p || p.done) return false;
  p.inside = false;
  p.player = true;
  p.act = null;
  p.rush = null;
  return true;
}

/** A body for the player to move, out at a point (stepping out of a door or a car). */
export function addPlayerWalker(w: SimWorld, id: number, x: number, y: number, heading: number,
  ageClass: PersonAgeClass, gender: PersonGender): void {
  const s = stateOf(w);
  const old = s.byId.get(id);
  if (old) finish(s, old, false);
  prune(s);
  const view: PedView = {
    id, x, y, heading, prev: { x, y, heading }, v: 0, turnV: 0, age: 0, ageClass, gender,
    party: { id, size: 1, archetype: 'solo', hasChild: false }, rank: 0,
    ground: 'footway', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null, gesture: null,
  };
  const p: Walker = {
    id, trip: -1, view, pace: PED.meanSpeed, steps: [{ way: null, dir: 1, from: 0, to: 0, a: { x, y }, b: { x, y } }], leg: 0,
    s: 0, d: 0, aim: 0, v: 0, x, y, heading, prevX: x, prevY: y, prevHeading: heading, turnV: 0, age: 0, held: 0,
    waited: 0, asked: 0, granted: null, done: false, waiting: null, zebra: null, inside: false, player: true, act: null, rush: null,
    ...WALKER_SHAPE,
  };
  s.walkers.push(p);
  s.byId.set(id, p);
}

/** The player's body moved: where it is now, the way it faces, how fast it goes. */
export function movePlayerWalker(w: SimWorld, id: number, x: number, y: number, heading: number, v: number): void {
  const p = stateOf(w).byId.get(id);
  if (!p || !p.player) return;
  const turn = Math.atan2(Math.sin(heading - p.heading), Math.cos(heading - p.heading));
  p.turnV = turn / DT;
  p.x = x; p.y = y; p.heading = heading; p.v = v;
}

/**
 * On their last stretch, a walk goes on to somewhere else instead of ending
 * (a passer-by in sight never vanishes where they stop, as GTA's peds wander
 * on): the route from where it would end to `to`, joined on. False when they
 * are not on their last stretch, or no way leads there.
 */
export function walkOn(w: SimWorld, id: number, toX: number, toY: number, reach: number,
  tail: readonly Vec2[] = NO_POINTS): boolean {
  const s = stateOf(w);
  const p = s.byId.get(id);
  if (!p || p.done || p.player || p.inside || p.leg !== p.steps.length - 1) return false;
  const last = p.steps[p.leg]!;
  // Going in at a door: in they go (on from the door, the way would cross the lot's fence).
  if (last.lot) return false;
  // On to a lot and in through its gate (`tail`: from the gate's foot to the door), as `walkThrough` ends.
  if (tail.length) { ensureGraph(w, s); tail = joinFootway(s, tail, true); }
  const goal = tail.length ? tail[0]! : { x: toX, y: toY };
  const end = frame(last, stepLength(last));
  const more = plan(w, s, { x: end.x, y: end.y }, goal, Math.max(reach, REACH));
  if (!more?.length) return false;
  p.steps.push(...more, ...lotSteps(tail));
  return true;
}

/** Whether a walker is still walking (out on the street, or waiting inside to step out). */
export function walkerAlive(w: SimWorld, id: number): boolean {
  const p = stateOf(w).byId.get(id);
  return !!p && !p.done;
}

/** Whether somebody out on the street is on the last stretch of their walk, where `walkOn` takes them on. */
export function onLastStretch(w: SimWorld, id: number): boolean {
  const p = stateOf(w).byId.get(id);
  return !!p && !p.done && !p.player && !p.inside && p.leg === p.steps.length - 1 && !p.steps[p.leg]!.lot;
}

/** Takes somebody off the street altogether (into a car, into a building): no arrival is told. */
/**
 * Whether a lot's way out ending at `p` reaches a footway a walker can join
 * there (`joinFootway`, within `GATE_JOIN`): a door that opens onto open
 * ground - a house set back from the road, with no lot - is not walked to
 * from the street (`ambient.ts`, `lotDoors.ts` `streetWay`).
 */
export function joinsFootway(w: SimWorld, p: Vec2): boolean {
  const s = stateOf(w);
  ensureGraph(w, s);
  return nearestWay(s, p, GATE_JOIN) !== null;
}

export function removeWalker(w: SimWorld, id: number): void {
  const s = stateOf(w);
  const p = s.byId.get(id);
  if (p) { finish(s, p, false); prune(s); }
}

/** Somebody stops a while to do something (talk, fall down), facing a point. */
export function walkerAct(w: SimWorld, id: number, kind: GestureKind, seconds: number, faceX: number, faceY: number): void {
  const p = stateOf(w).byId.get(id);
  if (!p || p.done) return;
  const before = actName(p.act);
  p.act = { kind, from: p.age, until: p.age + seconds, faceX, faceY };
  trace(p, 'act', before, actName(p.act), 'walkerAct');
  p.v = 0;
}

/** The ground of a train (its cars, the track just ahead): whoever is on it walks off it. */
const TRAIN_GROUND: Set<number> = new Set();

/** How much faster than their walk somebody runs away. */
const RUN = 2.4;
/** Running for their lives from a blow: a sprint. */
const PANIC_RUN = 3.4;

/**
 * Everybody within `radius` of a fright (a blow, a crash, a car on the
 * footway) runs off away from it for a while, then goes on where they were
 * going. Those knocked down get up first. Returns who saw it.
 */
export function startle(w: SimWorld, x: number, y: number, radius: number, seconds: number, except: number | null): number[] {
  const s = stateOf(w);
  const saw: number[] = [];
  for (const p of s.walkers) {
    if (p.inside || p.done || p.player || p.id === except) continue;
    const d = hypot(p.x - x, p.y - y);
    if (d > radius) continue;
    saw.push(p.id);
    frighten(w, s, p, x, y, d, seconds);
  }
  return saw;
}

/**
 * Those walking with somebody shot (`startWalk` with): down beside them,
 * crying, a few seconds, then away (`frighten` waits on it).
 */
function mourn(s: State, p: Walker): void {
  if (p.view.party.size < 2) return;
  for (const q of s.walkers) {
    if (q === p || q.done || q.inside || q.player || q.view.party.id !== p.view.party.id) continue;
    if (hypot(q.x - p.x, q.y - p.y) > m(12) || woundOf(q) || q.act?.kind === 'fall') continue;
    const hold = 3 + (personHash(q.id ^ 0x3e1) % 4);
    q.act = { kind: 'mourn', from: q.age, until: q.age + hold, faceX: p.x, faceY: p.y };
    q.v = 0;
    trace(q, 'act', 'none', 'mourn', `companion ${p.id} shot`);
  }
}

/** Somebody who saw a fright at (x, y), `d` off: running away from it, some tripping, crouching or fainting. */
function frighten(w: SimWorld, s: State, p: Walker, x: number, y: number, d: number, seconds: number): void {
  {
    const goal = p.rush?.goal ?? lastOf(p);
    // Away from it: to the walkway point some way off on the far side.
    const ax = d > 1e-6 ? (p.x - x) / d : Math.cos(p.heading), ay = d > 1e-6 ? (p.y - y) / d : Math.sin(p.heading);
    replan(w, s, p, { x: p.x + ax * m(40), y: p.y + ay * m(40) });
    // Busy with their own fall or wound: the fright waits till that is over.
    const after = p.act?.kind === 'fall' || p.act?.kind === 'flinch' || p.act?.kind === 'mourn' ? p.act.until - p.age : 0;
    // The wounded get away as the wound lets them: a hurt run, a hobble on a hurt leg.
    const wound = woundOf(p);
    const hurt = wound ? WOUNDED_RUSH[woundPace(wound)] : null;
    const rushBefore = rushName(p.rush);
    p.rush = { by: hurt ?? (seconds >= 14 ? PANIC_RUN : RUN), until: p.age + after + seconds * (0.7 + 0.6 * ((personHash(p.id) & 255) / 255)), goal };
    trace(p, 'rush', rushBefore, `${rushName(p.rush)} for ${(p.rush.until - p.age).toFixed(1)}s`, `frighten (startle ${seconds}s, ${(d / m(1)).toFixed(1)} m off)`);
    p.fright = p.rush.until;
    // In a stampede some trip over and go down, a second or a few in; some
    // break down where they are, crouched and sobbing; a few faint.
    // A blast's stampede (26 s of running): some trip, some crouch sobbing,
    // a few faint. A shot frightens without that: nobody far off drops as if
    // shot themself (the player, 2026-10-06) - those near crouch, others film.
    const stampede = seconds >= 20;
    if (!stampede && seconds >= 14 && after === 0) {
      // A shot (GTA V: everybody near a gunshot flees, some film it): first
      // the head round to it; near it, two in five drop where they are, both
      // hands over the head (`render/agents.ts` cower) and run after; farther
      // off some hold a phone up at it a few seconds; the rest run at once, a
      // few of those near tripping as they go. Stood looking, or running in
      // a plain run, a bystander read as somebody out jogging (2026-10-06).
      const roll = personHash(p.id ^ 0x7a11) & 255;
      const near = d < m(15);
      let hold: number;
      if (near && roll < 102) {
        hold = 2 + (roll % 4);
        p.act = { kind: 'crouch', from: p.age, until: p.age + hold, faceX: x, faceY: y };
      } else if (!near && roll >= 102 && roll < 140) {
        hold = 3 + (roll % 5);
        p.act = { kind: 'photo', from: p.age, until: p.age + hold, faceX: x, faceY: y };
      } else {
        hold = near ? 0.35 : 0.5 + (roll % 6) / 10;
        p.act = { kind: 'look', from: p.age, until: p.age + hold, faceX: x, faceY: y };
        if (near && (personHash(p.id ^ 0x51) & 255) < 26) p.tripAt = p.age + hold + 0.8 + (roll % 10) / 5;
      }
      p.v = 0;
      if (p.rush) p.rush = { ...p.rush, until: p.rush.until + hold };
      p.fright = p.rush?.until ?? p.fright;
    }
    if (stampede) {
      const roll = personHash(p.id ^ 0x7a11) & 255;
      if (roll < 60 && d < m(30)) p.tripAt = p.age + after + 0.8 + ((personHash(p.id ^ 0x51) & 255) / 255) * 4;
      else if (roll < 100 && after === 0) {
        p.act = { kind: 'crouch', from: p.age, until: p.age + 8 + (roll % 9), faceX: x, faceY: y };
        p.v = 0;
      } else if (roll < 118 && after === 0 && d < m(25)) {
        p.act = { kind: 'fall', from: p.age + 1.5, until: p.age + 14 + (roll % 7), faceX: p.x + Math.cos(p.heading), faceY: p.y + Math.sin(p.heading) };
        p.v = 0;
      } else if (roll < 150 && after === 0 && d > m(12)) {
        // Far enough off to feel safe: they stop and hold a phone up at it a
        // few seconds (as GTA's peds film a scene), then run all the same.
        const hold = 3 + (roll % 5);
        p.act = { kind: 'photo', from: p.age, until: p.age + hold, faceX: x, faceY: y };
        p.v = 0;
        if (p.rush) p.rush = { ...p.rush, until: p.rush.until + hold };
        p.fright = p.rush?.until ?? p.fright;
      }
    }
  }
}

/** Somebody sent running towards a point (a police officer after the player), their own route on the walkways. */
export function sendRunning(w: SimWorld, id: number, to: Vec2, by = RUN): void {
  const s = stateOf(w);
  const p = s.byId.get(id);
  if (!p || p.done || p.player) return;
  replan(w, s, p, to);
  p.rush = { by, until: p.age + 30, goal: to };
}

/** The end of a walker's route: where they are going. */
function lastOf(p: Walker): Vec2 {
  const last = p.steps[p.steps.length - 1]!;
  const end = frame(last, stepLength(last));
  return { x: end.x, y: end.y };
}

/** A walker's route made again from where they are to `to`. */
function replan(w: SimWorld, s: State, p: Walker, to: Vec2): void {
  reroute(w, s, p, to);
}

/**
 * A walker's route found again to `to`, keeping what runs through a lot
 * (`Step.lot`): the rest of the way out of the lot they are walking out of
 * is walked first and the way is found from its gate; going to the walk's own
 * end, the way into the lot there is kept and the way is found to its gate;
 * already on that way in, nothing changes (they are nearly indoors). Found
 * from the body, a straight line out of a lot crossed its fence. False when
 * no way leads there.
 */
function reroute(w: SimWorld, s: State, p: Walker, to: Vec2): boolean {
  const steps = p.steps;
  let tailFrom = steps.length;
  while (tailFrom > 0 && steps[tailFrom - 1]!.lot) tailFrom--;
  if (tailFrom < steps.length && p.leg >= tailFrom) return true;
  const end = lastOf(p);
  const keepTail = tailFrom < steps.length && hypot(to.x - end.x, to.y - end.y) < m(0.05);
  let headTo = p.leg;
  while (headTo < tailFrom && steps[headTo]!.lot) headTo++;
  const start = headTo > p.leg ? steps[headTo - 1]!.b! : { x: p.x, y: p.y };
  const mid = plan(w, s, start, keepTail ? steps[tailFrom]!.a! : to, REACH);
  if (!mid) return false;
  const next = [...steps.slice(p.leg, headTo), ...mid, ...(keepTail ? steps.slice(tailFrom) : [])];
  steps.length = 0;
  steps.push(...next);
  p.leg = 0;
  p.granted = null;
  const pr = project(steps[0]!, p.x, p.y);
  p.s = pr.s; p.d = pr.d; p.aim = clamp(pr.d, room(steps[0]!));
  return true;
}

/** Gives a body back from the player's hand, walking on to `to` (their home, say); null: off the street. */
export function releaseWalker(w: SimWorld, id: number, to: Vec2 | null): void {
  const s = stateOf(w);
  const p = s.byId.get(id);
  if (!p) return;
  p.player = false;
  if (!to) { finish(s, p, false); prune(s); return; }
  replan(w, s, p, to);
}

/**
 * One walker as a test bench reads them (the weapons lab, `src/weaponsLab.ts`):
 * where, how fast, what they are doing and for how long yet, how hurt.
 * Null once they are off the street (dead, arrived).
 */
export function walkerState(w: SimWorld, id: number): {
  x: number; y: number; heading: number; v: number; act: string | null; actLeft: number; hp: number; hits: number;
  bleeding: number; lost: readonly Severable[]; fleeing: boolean; frightened: boolean;
  rush: { by: number; left: number } | null; lastHit: { part: BodyPart; damage: number; ago: number } | null; age: number;
} | null {
  const p = stateOf(w).byId.get(id);
  if (!p || p.done) return null;
  return {
    x: p.x, y: p.y, heading: p.heading, v: p.v, act: p.act?.kind ?? null, actLeft: p.act ? Math.max(0, p.act.until - p.age) : 0,
    hp: p.hp ?? 100, hits: p.hits ?? 0, bleeding: p.bleeding ?? 0, lost: p.lost ?? [], fleeing: p.rush !== null && p.age < p.rush.until,
    frightened: (p.fright ?? 0) > p.age,
    rush: p.rush ? { by: p.rush.by, left: Math.max(0, p.rush.until - p.age) } : null,
    lastHit: p.lastHit ? { part: p.lastHit.part, damage: p.lastHit.damage, ago: p.age - p.lastHit.at } : null, age: p.age,
  };
}
