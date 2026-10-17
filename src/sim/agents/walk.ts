import { Heap } from '@core/heap';
import type { Vec2 } from '@core/vec2';
import { newFrame } from '@core/polyline';
import type { WalkGraph, Walkway } from '@world/walkways';
import { m } from '@world/units';
import type { SegmentId } from '@world/ids';
import { SIGNAL_POST_RADIUS } from '@world/signalPosts';
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
import type { FreePose, StandingCar } from '../vehicles/state';

/** The agents' walking: people on lanes of the footways, as SUMO's striping model walks them */

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
/** Where only one person fits abreast - a lot's path and its gate - SUMO's `pedestrian.striping.jamtime.narrow`, 1 s */
const JAM_AFTER_NARROW = 1;
/** Face to face and getting no further along the way for this long, s */
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
/** Slower than this a walker faces the way its walk goes and steps aside sideways */
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
/** Behind somebody waiting for the zebra it is going to, this near its waiting place, a walker is in the queue */
const QUEUE_REACH = m(6);
/** Half the length of kerb people wait along at a zebra, u */
const WAIT_HALF = m(2.2);

const QUEUE_GAP = m(0.6);
/** How often a waiting walker asks whether they may cross, seconds. */
const ASK_EVERY = 0.25;
/** Seconds a leave to cross holds for one standing still who has not yet stepped onto the carriageway. */
const GRANT_LIFE = 1;
/** Farthest a door or a car may be from the walkways, by default. */
const REACH = m(30);
/** Somebody this near the spot a walker steps out onto keeps them inside a moment, u. */
const DOOR_CLEAR = m(0.8);
/** The end of a walk is reached this near it. */
const THERE = m(0.25);
/** Spatial cells for the walkers and for the walkways. */
/** As wide as a walker looks ahead (`LOOK`) */
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

/** A car's body as a zone: three discs along its length, half its width round. */
function parkedZone(car: StandingCar, f: FreePose): CarZone {
  const r = car.archetype.width / 2;
  const reach = Math.max(0, car.archetype.length / 2 - r);
  const discs = [-1, 0, 1].map((k) => ({ x: f.x + Math.cos(f.angle) * reach * k, y: f.y + Math.sin(f.angle) * reach * k, r }));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of discs) { x0 = Math.min(x0, d.x - d.r); y0 = Math.min(y0, d.y - d.r); x1 = Math.max(x1, d.x + d.r); y1 = Math.max(y1, d.y + d.r); }
  return { x0, y0, x1, y1, discs, on: null, crossingOnly: false };
}

/** The work of the walkers' derived products, counted (counts, not times: the same on every machine), for the scale specs */
export const walkWork = { hailLooked: 0, routeNodes: 0, parkedFiled: 0 };

interface ParkedEntry { readonly car: StandingCar; x: number; y: number; angle: number; zone: CarZone | null; readonly cells: number[]; seen: number }

/** The parked cars as their keeper tells their changes (`ambient/ambient.ts` AmbientWorld). */
export interface ParkedSource {
  /** The cars standing now. */
  readonly parked: readonly StandingCar[];
  /** The serial of the latest change of `parked`. */
  readonly parkedSerial: number;
  /** The cars that came (`added`) and went since `serial`, oldest first; null: `parked` is to be read whole. */
  parkedSince(serial: number): readonly { readonly car: StandingCar; readonly added: boolean }[] | null;
  /** The cars of `parked` that may move while standing in it. */
  readonly movers: ReadonlySet<StandingCar>;
}

/** DO NOT file every parked car again when one of them changes */
export class ParkedZoneIndex {
  /** The zones by cell, each in every cell its box reaches with a walker's look ahead round it. */
  readonly cells = new Map<number, CarZone[]>();
  /** What was seen, in the list's order. */
  private readonly list: ParkedEntry[] = [];
  private readonly byCar = new Map<StandingCar, ParkedEntry>();
  private pass = 0;
  /** The serial of the source last followed (`follow`); -1: never. */
  private serial = -1;

  /** Brought up to the cars standing, from what their keeper says changed */
  follow(source: ParkedSource): void {
    const changes = this.serial < 0 ? null : source.parkedSince(this.serial);
    this.serial = source.parkedSerial;
    // The order-kept list belongs to `sync`: a later `sync` finds it from the cars.
    this.list.length = 0;
    if (changes === null) {
      const now = new Set(source.parked);
      for (const [car, e] of [...this.byCar]) {
        if (now.has(car)) continue;
        this.unfile(e);
        this.byCar.delete(car);
      }
      for (const car of source.parked) this.keep(car);
    } else {
      for (const c of changes) {
        if (c.added) { this.keep(c.car); continue; }
        const e = this.byCar.get(c.car);
        if (!e) continue;
        this.unfile(e);
        this.byCar.delete(c.car);
      }
    }
    for (const car of source.movers) {
      const e = this.byCar.get(car);
      if (e && moved(e, car.free)) this.place(e, car.free);
    }
  }

  /** A car filed where it stands, if it is not, or again if it moved. */
  private keep(car: StandingCar): void {
    let e = this.byCar.get(car);
    if (!e) {
      e = { car, x: 0, y: 0, angle: 0, zone: null, cells: [], seen: 0 };
      this.byCar.set(car, e);
      this.place(e, car.free);
    } else if (moved(e, car.free)) this.place(e, car.free);
  }

  /** Brings the cells up to `cars`, the cars standing now (`AmbientWorld.parked`). */
  sync(cars: readonly StandingCar[]): void {
    const list = this.list;
    const n = Math.min(cars.length, list.length);
    let i = 0;
    for (; i < n; i++) {
      const e = list[i]!;
      if (e.car !== cars[i]) break;
      if (moved(e, e.car.free)) this.place(e, e.car.free);
    }
    if (i === cars.length && i === list.length) return;
    // The list changed from `i` on (a car came or went): the rest by car.
    const pass = ++this.pass;
    for (let k = 0; k < i; k++) list[k]!.seen = pass;
    const tail = list.slice(i);
    for (let k = i; k < cars.length; k++) {
      const car = cars[k]!;
      let e = this.byCar.get(car);
      if (!e) {
        e = { car, x: 0, y: 0, angle: 0, zone: null, cells: [], seen: 0 };
        this.byCar.set(car, e);
        this.place(e, car.free);
      } else if (moved(e, car.free)) this.place(e, car.free);
      e.seen = pass;
      list[k] = e;
    }
    list.length = cars.length;
    for (const e of tail) {
      if (e.seen === pass || this.byCar.get(e.car) !== e) continue;
      this.unfile(e);
      this.byCar.delete(e.car);
    }
  }

  private place(e: ParkedEntry, f: FreePose | null | undefined): void {
    this.unfile(e);
    if (!f) return;
    e.x = f.x; e.y = f.y; e.angle = f.angle;
    const z = e.zone = parkedZone(e.car, f);
    const gx0 = Math.floor((z.x0 - LOOK) / ZONE_CELL), gx1 = Math.floor((z.x1 + LOOK) / ZONE_CELL);
    const gy0 = Math.floor((z.y0 - LOOK) / ZONE_CELL), gy1 = Math.floor((z.y1 + LOOK) / ZONE_CELL);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const k = cell(gx, gy);
      const at = this.cells.get(k);
      if (at) at.push(z); else this.cells.set(k, [z]);
      e.cells.push(k);
    }
    walkWork.parkedFiled++;
  }

  private unfile(e: ParkedEntry): void {
    const z = e.zone;
    if (z) {
      for (const k of e.cells) {
        const at = this.cells.get(k);
        if (!at) continue;
        const j = at.indexOf(z);
        if (j >= 0) at.splice(j, 1);
        if (!at.length) this.cells.delete(k);
      }
      walkWork.parkedFiled++;
    }
    e.cells.length = 0;
    e.zone = null;
  }
}

/** Whether a car stands otherwise than when it was filed (came, went, or moved). */
const moved = (e: ParkedEntry, f: FreePose | null | undefined): boolean =>
  f ? e.zone === null || f.x !== e.x || f.y !== e.y || f.angle !== e.angle : e.zone !== null;

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
  /** A stretch inside a lot, between its door and its people's gate (`agents/lotDoors.ts`) */
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
  /** The step it got jammed on (held past JAM_AFTER) */
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
  /** Not out yet: waiting inside the door (or the car) until the spot it steps out onto is clear. */
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

/** Every field a walker may be given later, there from its birth and in one order: added as things happened to each */
const WALKER_SHAPE = {
  progress: undefined, jammedOn: undefined, aimAt: undefined, grantedAt: undefined, fright: undefined, tripAt: undefined,
  maimed: undefined, hp: undefined, hits: undefined, opened: undefined, leader: undefined, crawlNext: undefined,
  lastHit: undefined, hurt: undefined, lost: undefined, stretchOf: undefined, bleeding: undefined,
} as const satisfies { [K in keyof Walker]?: undefined };

interface State {
  graph: WalkGraph | null;
  /** The graph's state its index was brought up to (`WalkGraph.changesSince`). */
  graphState: object | null;
  wayIndex: Map<number, number[]>;
  walkers: Walker[];
  byId: Map<number, Walker>;
  arrivals: number[];
  /** For each car holding (or asking for) its way across the footway, the walkers who were on that ground when it took it */
  onCarWay: Map<number, Set<number>>;
  /** Shocking events (as GTA's peds have them) */
  shocks: { x: number; y: number; radius: number; until: number }[];
  /** Seconds of walking stepped (the shocks' clock). */
  clock: number;
  /** When the walkers were last checked against the shocks. */
  shockLook: number;
  /** The walkers by cell for the cars' questions */
  near: WalkerGrid;
  nearAt: number;
  /** The vehicles by cell for `gapOpen`, filed once a tick when somebody first asks; the fastest of them. */
  traffic: Map<number, TrafficSeen[]>;
  trafficAt: number;
  fastest: number;
  /** The walkers by cell, filed again at the start of every step (`WalkerGrid`). */
  grid: WalkerGrid;
  /** The parked cars' zones by cell, kept as the cars come, go and move (`ParkedZoneIndex`). */
  parked: ParkedZoneIndex;
  /** DO NOT find them in `walkers`: every walker of the map, for each companion made. */
  parties: Map<number, Walker[]>;
}

/** A vehicle as `gapOpen` reads it: where it is, which way it faces, how fast it goes. */
interface TrafficSeen { readonly x: number; readonly y: number; readonly angle: number; readonly speed: number }
/** Cells for the vehicles near a crossing (`gapOpen`). */
const TRAFFIC_CELL = m(32);

/** A test bench's trace of what happens to chosen walkers (the weapons lab, `traceWalkers`) */
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

/** How a shot walker is hurt, from their health and what struck them: none, light (most of their health left) or grave */
function woundOf(p: Walker): { part: BodyPart; grave: boolean } | null {
  if (!p.lastHit) return null;
  return { part: p.lastHit.part, grave: (p.hp ?? 100) < 50 || (p.lost?.length ?? 0) > 0 };
}
/** A wounded walker's pace walking on, as a share of their own: slow, bent over the wound, never their own walk again. */
const WOUNDED_PACE = { light: 0.55, leg: 0.45, grave: 0.4 } as const;
/** Getting away hurt, against their own pace: a run bent over the wound, as GTA's shot peds flee clutching it */
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
/** Struck by the round: a stagger of a couple of steps back, the way it went */
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
    s = { graph: null, graphState: null, wayIndex: new Map(), walkers: [], byId: new Map(), arrivals: [], onCarWay: new Map(),
      shocks: [], clock: 0, shockLook: 0, near: new WalkerGrid(), nearAt: -1, traffic: new Map(), trafficAt: -1, fastest: 0,
      grid: new WalkerGrid(), parked: new ParkedZoneIndex(), parties: new Map() };
    STATES.set(w, s);
  }
  return s;
}

/** Length of (x, y). */
const hypot = (x: number, y: number): number => Math.sqrt(x * x + y * y);
/** A grid cell as one number: a string key */
const cell = (cx: number, cy: number): number => cx * 65536 + cy;
const cellKey = (x: number, y: number, size: number): number => cell(Math.floor(x / size), Math.floor(y / size));

// ------------------------------------------------------------------ ground

/** DO NOT index every walkway again when the network changes: every road drawn filed the town's walkways again. */
function ensureGraph(w: SimWorld, s: State): WalkGraph | null {
  const g = w.walkwaysNow();
  const changes = s.graph === g && s.graphState ? g.changesSince(s.graphState) : null;
  if (changes === null) {
    // @rebuild A walk state new (a map opened, a world reset) or further behind than the graph remembers.
    s.wayIndex.clear();
    for (const way of g.ways) if (way) fileWay(s, way, true);
  } else {
    for (const change of changes) {
      for (const way of change.removed) fileWay(s, way, false);
      for (const way of change.added) fileWay(s, way, true);
    }
  }
  s.graph = g;
  s.graphState = g.state;
  return g;
}

/** A walkway filed in (or out of) the cells its usable width reaches. */
function fileWay(s: State, way: Walkway, add: boolean): void {
  const bb = way.path.bbox;
  const pad = Math.max(Math.abs(way.lo), Math.abs(way.hi));
  for (let x = Math.floor((bb.minX - pad) / WAY_CELL); x <= Math.floor((bb.maxX + pad) / WAY_CELL); x++) {
    for (let y = Math.floor((bb.minY - pad) / WAY_CELL); y <= Math.floor((bb.maxY + pad) / WAY_CELL); y++) {
      const k = cell(x, y);
      const list = s.wayIndex.get(k);
      if (add) {
        if (list) list.push(way.id); else s.wayIndex.set(k, [way.id]);
      } else if (list) {
        const i = list.indexOf(way.id);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) s.wayIndex.delete(k);
      }
    }
  }
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

/** DO NOT search without it: the scenery's people come in at the map's edge for the far side */
export function route(g: WalkGraph, from: { way: Walkway; s: number }, to: { way: Walkway; s: number }): Step[] | null {
  if (from.way.id === to.way.id) {
    return [{ way: from.way, dir: to.s >= from.s ? 1 : -1, from: from.s, to: to.s }];
  }
  const n = g.nodes.length;
  // The graph's own arrays, used again by every search on it: a node's entry counts only when its stamp is this search's
  const r = routeScratch(g);
  const { dist, via, stamp, done, open } = r;
  const gen = r.gen;
  const distOf = (node: number): number => (stamp[node] === gen ? dist[node]! : Infinity);
  const goalA = g.nodes[to.way.a], goalB = g.nodes[to.way.b];
  const restA = to.s, restB = to.way.path.length - to.s;
  const estimate = (node: number): number => {
    const p = g.nodes[node];
    if (!p || !goalA || !goalB) return 0;
    return Math.min(hypot(goalA.x - p.x, goalA.y - p.y) + restA, hypot(goalB.x - p.x, goalB.y - p.y) + restB);
  };
  // A binary heap, and done once both ends of the goal way are settled
  const push = (node: number, d: number, way: number): void => {
    if (d >= distOf(node)) return;
    if (stamp[node] !== gen) { stamp[node] = gen; walkWork.routeNodes++; }
    dist[node] = d;
    via[node] = way;
    open.push(node, d + estimate(node));
  };
  push(from.way.a, from.s, from.way.id);
  push(from.way.b, from.way.path.length - from.s, from.way.id);
  let goals = to.way.a === to.way.b ? 1 : 2;
  // The best way in found so far, by an end of the goal way settled: once nothing open can do better
  let best = Infinity;
  while (open.size && goals > 0 && open.peekKey() < best) {
    const node = open.pop();
    if (done[node] === gen) continue;
    done[node] = gen;
    if (node === to.way.a) { goals--; best = Math.min(best, dist[node]! + restA); }
    if (node === to.way.b && to.way.b !== to.way.a) { goals--; best = Math.min(best, dist[node]! + restB); }
    const d = dist[node]!;
    for (const wid of g.at.get(node) ?? []) {
      const way = g.ways[wid]!;
      if (way.id === from.way.id) continue;
      const other = way.a === node ? way.b : way.a;
      push(other, d + wayCost(way), way.id);
    }
  }
  const ends = [
    { node: to.way.a, total: distOf(to.way.a) + to.s },
    { node: to.way.b, total: distOf(to.way.b) + (to.way.path.length - to.s) },
  ].sort((p, q) => p.total - q.total);
  const end = ends[0]!;
  if (!Number.isFinite(end.total)) return null;
  // Back from the goal's end node to the start way.
  const chain: { way: Walkway; enter: number }[] = [];
  let node = end.node;
  let guard = 0;
  while (guard++ < n) {
    const wid = stamp[node] === gen ? via[node]! : -1;
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

/** DO NOT go back to `new Float64Array(n).fill(Infinity)` per search */
interface RouteScratch { dist: Float64Array; via: Int32Array; stamp: Uint32Array; done: Uint32Array; gen: number; open: Heap }
const ROUTE_SCRATCH = new WeakMap<WalkGraph, RouteScratch>();
/** The graph's search arrays, on a new generation, the heap empty. */
function routeScratch(g: WalkGraph): RouteScratch {
  const n = g.nodes.length;
  let r = ROUTE_SCRATCH.get(g);
  if (!r || r.stamp.length < n) {
    // The graph grows with the edits (`Walkways.update`)
    const room = Math.ceil(n * 1.5) + 512;
    r = { dist: new Float64Array(room), via: new Int32Array(room), stamp: new Uint32Array(room), done: new Uint32Array(room), gen: 0, open: new Heap() };
    ROUTE_SCRATCH.set(g, r);
  }
  // Every 2^32 searches the stamps start again from nought (none is then this generation).
  if (r.gen === 0xffffffff) { r.stamp.fill(0); r.done.fill(0); r.gen = 0; }
  r.gen++;
  r.open.clear();
  return r;
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

/** `frame` into `out`: the walkers' step asks it several times a tick for every walker */
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
  // The tangent blended along each piece from the tangent at its one end to the tangent at the other
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

/** `project` of a body onto a step. */
function projectAcross(st: Step, x: number, y: number): { s: number; d: number } {
  return projectInto(st, x, y, ACROSS_PROJECTION);
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

/** The lateral room of a step in its own walking frame, [low, high], left positive, for a body's centre. */
function room(st: Step): readonly [number, number] {
  let kept = ROOMS.get(st);
  if (!kept) ROOMS.set(st, kept = Object.freeze(roomOf(st)));
  return kept;
}
/** Each step's room, worked out once (it depends on the step alone) */
const ROOMS = new WeakMap<Step, readonly [number, number]>();

function roomOf(st: Step): [number, number] {
  if (!st.way) return [0, 0];
  let lo = st.way.lo + BODY, hi = st.way.hi - BODY;
  if (st.way.kind === 'corner') {
    // By the tightest bend of the line, not its average
    const r = bendRadii(st.way);
    if (r.turn > 0.2) hi = Math.min(hi, r.left * 0.5);
    else if (r.turn < -0.2) lo = Math.max(lo, -r.right * 0.5);
    // Never past the fold itself on either side, counter-bends and corners that barely turn end to end included
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
/** The tightest radius of a walkway's line turning left and turning right (along it from `a` to `b`) */
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

// Read by index, not unpacked: a pattern in a parameter walks the array's iterator
const clamp = (v: number, r: readonly [number, number]): number => Math.max(r[0], Math.min(r[1], v));

/** How far a footway's walking line is from its kerb (where a crossing's end meets the road). */
const kerbInset = (way: Walkway | null | undefined): number =>
  !way || way.kind === 'crossing' ? 0 : way.kerb < 0 ? -way.lo : way.hi;

// ------------------------------------------------------------------ crossings

/** A crossing on a walker's way: a zebra as the vehicles and the signals know it (`edge`), or a crossing with no zebra */
interface Zebra { readonly id: CrossingId; readonly edge: SidewalkEdge | null; readonly way: Walkway }

function crossingOf(w: SimWorld, way: Walkway | null | undefined): Zebra | null {
  if (!way || way.kind !== 'crossing' || way.node === undefined || way.segment === undefined) return null;
  // DO NOT key it by the topology's revision: every edit dropped every walkway's, the town's, for whatever it changed.
  const made = w.sidewalks.madeAt(way.node);
  const known = ZEBRAS.get(way);
  if (known && known.made === made) return known.zebra;
  const id = makeCrossingId(way.node, way.segment);
  const edge = way.unmarked ? null : w.sidewalks.crossingEdge(id) ?? null;
  const zebra = edge || way.unmarked ? { id, edge, way } : null;
  ZEBRAS.set(way, { made, zebra });
  return zebra;
}
const ZEBRAS = new WeakMap<Walkway, { made: object | undefined; zebra: Zebra | null }>();
/** Each vehicle's pose as `gapOpen` files it, written in place. */
const TRAFFIC_POSE = newPose();

/** Margin of clear road a walker wants beyond their own time across, s; after `IMPATIENT` waiting, none. */
const GAP_MARGIN = 2;
const IMPATIENT = 30;
/** A vehicle this near the crossing keeps a walker on the kerb whatever it is doing, u. */
const GAP_NEAR = m(6);

/** Whether a walker may step onto a crossing with no zebra */
function gapOpen(w: SimWorld, s: State, z: Zebra, pace: number, waited: number): boolean {
  const path = z.way.path;
  const time = path.length / Math.max(pace, m(0.5)) + (waited < IMPATIENT ? GAP_MARGIN : 0);
  // The vehicles by cell, filed once this tick (their poses were worked out for every vehicle at every ask)
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

/** The zebra a walker is coming up to and has not been let onto, and the distance along its route to where it waits for it */
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

/** How far from a lane's centre somebody on the footway may be hailed from (`hailable`). */
const HAIL_REACH = m(9);
/** How far from the door the walkway somebody gets out onto may be (`alight`). */
const ALIGHT_SNAP = m(4);
/** Ways tried for somebody getting out of a car (`alight`). */
const ALIGHT_TRIES = 4;

export function createAgentWalkEngine(): PedestrianEngine {
  const bridge: PeopleBridge = {
    // A car stopping at the kerb for somebody (`vehicles/kerbStops.ts`)
    hailable(w, lanelet, s0, s1, exclude) {
      const lane = w.lanelet(lanelet);
      if (!lane) return null;
      // DO NOT walk every walker of the map
      const c = lane.centre;
      const a = Math.max(0, s0), b = Math.min(c.length, s1);
      if (a > b) return null;
      const pa = c.sampleAt(a).p, pb = c.sampleAt(b).p;
      let x0 = Math.min(pa.x, pb.x), y0 = Math.min(pa.y, pb.y), x1 = Math.max(pa.x, pb.x), y1 = Math.max(pa.y, pb.y);
      const cum = c.cum, xy = c.xy;
      for (let i = 0; i < c.n; i++) {
        if (cum[i]! <= a || cum[i]! >= b) continue;
        const x = xy[i * 2]!, y = xy[i * 2 + 1]!;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      const pad = HAIL_REACH + CELL;
      const s = stateOf(w);
      let best: { id: number; s: number } | null = null;
      // Ties go to the earliest walker (`rank`, the order they walk in), as the walk over them all had it.
      let bestRank = -1;
      nearNow(s).someIn(Math.floor((x0 - pad) / CELL), Math.floor((y0 - pad) / CELL),
        Math.floor((x1 + pad) / CELL), Math.floor((y1 + pad) / CELL), (p, rank) => {
          walkWork.hailLooked++;
          if (p.done || p.inside || p.player || p.act || p.rush || (p.fright ?? 0) > p.age) return false;
          if (p.view.ageClass === 'child' || p.view.ground !== 'footway' || exclude?.has(p.id)) return false;
          const hit = c.closestPoint({ x: p.x, y: p.y });
          if (hit.s < s0 || hit.s > s1 || hit.distance > HAIL_REACH) return false;
          // The kerb side: right of the way the lane runs (`kerbStops.ts` kerbSide).
          const f = c.sampleAt(hit.s);
          if ((p.x - f.p.x) * f.t.y - (p.y - f.p.y) * f.t.x <= 0) return false;
          if (!best || hit.s < best.s || (hit.s === best.s && rank < bestRank)) { best = { id: p.id, s: hit.s }; bestRank = rank; }
          return false;
        });
      return best;
    },
    // Into the car: off the street, as they stand, if they are still free and within `reach` of the door.
    board(w, id, door, reach) {
      const s = stateOf(w);
      const p = s.byId.get(id);
      if (!p || p.done || p.inside || p.player || hypot(p.x - door.x, p.y - door.y) > reach) return null;
      const boarder = { seed: p.id, gender: p.view.gender, ageClass: p.view.ageClass, footX: p.x, footY: p.y, footHeading: p.heading };
      finish(s, p, false);
      prune(s);
      return boarder;
    },
    // Somebody out of a car at the kerb (`vehicles/kerbStops.ts`)
    alight(w, person) {
      const s = stateOf(w);
      ensureGraph(w, s);
      const h = personHash(person.seed);
      // Out onto the walkway nearest the door, not the point by the door off it
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
      // Nowhere 60 to 200 m off is reached on foot from here (a footway cut off from the rest, a street no car reached before)
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
      const r = radius + CELL;
      return nearNow(stateOf(w)).someIn(Math.floor((x - r) / CELL), Math.floor((y - r) / CELL),
        Math.floor((x + r) / CELL), Math.floor((y + r) / CELL),
        (p) => !p.inside && !p.done && p.id !== except && hypot(p.x - x, p.y - y) < radius);
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
      const g = ensureGraph(w, s);
      // DO NOT key every walkway of the map to find them: every edit read the town's walkways again.
      for (const p of s.walkers) {
        if (g && p.steps.every((st) => !st.way || g.holds(st.way))) continue;
        // Found again from where they are, through a lot's gate when the walk runs through one (`reroute`).
        if (!reroute(w, s, p, lastOf(p))) finish(s, p);
      }
      prune(s);
    },
    publish(w) { publish(w); },
    audit(_w: SimWorld, _out: AuditIssue[]) {},
    // Everybody gone and everything the walkers' step keeps made new
    reset(w) {
      STATES.delete(w);
    },
    walkTrip(w, trip) { return startWalk(w, trip); },
    takeArrivals(w) {
      const s = stateOf(w);
      const out = s.arrivals.slice();
      s.arrivals.length = 0;
      return out;
    },
    impact(w, x, y, kill, scare) {
      // A blow (`editor` strike): killed within `kill` - off the street for good, a body for the renderer to throw
      const s = stateOf(w);
      let dead = 0;
      for (const p of walkersWithin(s, x, y, kill * 2)) {
        if (p.inside || p.done) continue;
        const d = hypot(p.x - x, p.y - y);
        if (d >= kill * 2) continue;
        const v = p.view;
        const who = { x: p.x, y: p.y, heading: p.heading, t: 0, id: p.id, gender: v.gender, ageClass: v.ageClass,
          party: { id: v.party.id, size: v.party.size, archetype: v.party.archetype, hasChild: v.party.hasChild }, blastX: x, blastY: y };
        if (d < kill && !p.player) {
          // Right under it: burnt black and torn limb from limb; further off, killed, an arm, a leg or the head often blown off.
          const roll = personHash(p.id ^ 0x5eed);
          const torn = d < kill * 0.4;
          const all: Severable[] = ['head', 'armL', 'armR', 'legL', 'legR'];
          const severed = torn ? all.filter((_, i) => ((roll >> i) & 1) === 1 || i === (roll >>> 8) % 5)
            : (roll & 3) !== 0 ? [all[1 + ((roll >>> 4) % 4)]!, ...((roll & 12) === 12 ? ['head' as const] : [])] : [];
          // Burnt black, everybody it kills
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
      // As GTA's peds take it: a shot to the head kills; to the body a third of their health
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
      // A grave trunk wound opens the belly, the guts out: always at the third round in the trunk, now and then at the second
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
      // Hurt, not killed.
      p.hits = (p.hits ?? 0) + 1;
      const legGone = p.lost.includes('legL') || p.lost.includes('legR');
      // Incapacitated (`woundOf` grave: half their health gone or a limb lost), or shot again while already down
      const grave = woundOf(p)?.grave ?? false;
      if (!wasDown && !grave) {
        const before = actName(p.act);
        const leg = part === 'legL' || part === 'legR';
        if (leg || (part === 'torso' && (personHash(p.id ^ (p.hits * 0x2f9b)) & 255) < 128)) {
          // Knocked down : a leg gives way and they go onto their knees and hands, a round in the trunk throws them back, a moment
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
      // Up where the body came to rest (the walkway nearest it), facing the way it rises
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
        // Exactly where the body lies (they were put on the nearest walkway, metres off: a jump the moment they stood)
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

/** A walk that begins by coming out through a lot */
export function walkThrough(w: SimWorld, trip: ResidentWalk, head: readonly Vec2[], tail: readonly Vec2[]): number | null {
  return startWalk(w, trip, head, tail);
}

/** Farthest a gate's foot may be from the walkway it is joined to. */
const GATE_JOIN = m(4);

/** A lot's way (door ... gate, foot) joined to the footway */
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
  const id = trip.person ?? w.nextPersonId++;
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
    const members = (s.parties.get(leader.view.party.id) ?? []).filter((q) => !q.done);
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
  joinParty(s, p);
  return id;
}

/** `p` filed with its party (`State.parties`). */
function joinParty(s: State, p: Walker): void {
  const list = s.parties.get(p.view.party.id);
  if (list) list.push(p); else s.parties.set(p.view.party.id, [p]);
}

function finish(s: State, p: Walker, arrived = true): void {
  p.done = true;
  s.byId.delete(p.id);
  if (arrived) s.arrivals.push(p.trip);
  const party = s.parties.get(p.view.party.id);
  if (party) {
    const at = party.indexOf(p);
    if (at >= 0) party.splice(at, 1);
    if (!party.length) s.parties.delete(p.view.party.id);
  }
}

/** DO NOT walk `State.walkers` for a place: every walker of the map, for each blow and each look. */
function walkersWithin(s: State, x: number, y: number, radius: number): Walker[] {
  const r = radius + CELL;
  const found: { p: Walker; rank: number }[] = [];
  nearNow(s).someIn(Math.floor((x - r) / CELL), Math.floor((y - r) / CELL), Math.floor((x + r) / CELL), Math.floor((y + r) / CELL),
    (p, rank) => {
      if (!p.inside && !p.done && hypot(p.x - x, p.y - y) <= radius) found.push({ p, rank });
      return false;
    });
  found.sort((a, b) => a.rank - b.rank);
  return found.map((f) => f.p);
}

function prune(s: State): void {
  if (s.walkers.some((q) => q.done)) s.walkers = s.walkers.filter((q) => !q.done);
}

/** The point the body walks towards: a little ahead on its route, in its stripe. */
function target(p: Walker): { x: number; y: number } {
  let leg = p.leg;
  let st = p.steps[leg]!;
  // Through a lot and its gate, a short look ahead
  let s = p.s + (st.lot ? LOT_AHEAD : AHEAD);
  while (s > stepLength(st) && leg + 1 < p.steps.length) {
    s -= stepLength(st);
    leg++;
    st = p.steps[leg]!;
    if (st.lot) s = Math.min(s, LOT_AHEAD);
  }
  if (leg === p.steps.length - 1) s = Math.min(s, stepLength(st));
  // In this step, towards its stripe, but no more across than SUMO lets a walker move sideways for its forward speed
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

/** The walkers out on the street by cell of `CELL`, as Matthias Müller's dense spatial hash files particles */
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
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    return this.someIn(cx - reach, cy - reach, cx + reach, cy + reach, fn);
  }

  /** Whether `fn` is true of anybody filed in the cells [gx0, gx1] x [gy0, gy1]; stops at the first. */
  someIn(gx0: number, gy0: number, gx1: number, gy1: number, fn: (q: Walker, rank: number) => boolean): boolean {
    if (!this.list.length) return false;
    const start = this.start, entries = this.entries;
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const h = this.slot(gx, gy);
      for (let k = start[h]!, end = start[h + 1]!; k < end; k++) {
        const i = entries[k]!;
        if (this.cx[i] !== gx || this.cy[i] !== gy) continue;
        if (fn(this.list[i]!, i)) return true;
      }
    }
    return false;
  }
}

/** The walkers by cell for the cars' questions, filed at the first one after the walkers stepped (`State.near`) */
function nearNow(s: State): WalkerGrid {
  if (s.nearAt !== s.clock) {
    s.nearAt = s.clock;
    s.near.build(s.walkers);
  }
  return s.near;
}

// ---------------------------------------------------- the step's scratch What the walkers' step works with for each

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
  w.signalPosts.follow(w);
  indexReservations(w);
  // Who is where, a cell of a few metres each (`WalkerGrid`)
  const late: Walker[] = [];
  const enter = (p: Walker): void => { late.push(p); };
  const grid = s.grid;
  // Those coming near a shocking event (a blow, a body) run from it.
  s.clock += DT;
  if (s.shocks.length && s.clock >= s.shockLook) {
    s.shockLook = s.clock + 0.4;
    s.shocks = s.shocks.filter((k) => k.until > s.clock);
    // DO NOT walk every walker of the map against every shock.
    for (const k of s.shocks) {
      for (const p of walkersWithin(s, k.x, k.y, k.radius)) {
        if (p.inside || p.done || p.player || (p.fright ?? 0) > p.age || p.act) continue;
        const d = hypot(p.x - k.x, p.y - k.y);
        if (d > k.radius) continue;
        frighten(w, s, p, k.x, k.y, d, 18);
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
  grid.build(s.walkers);
  // Those running in panic who trip: down on the ground
  for (const p of s.walkers) {
    if (p.tripAt === undefined || p.age < p.tripAt || p.inside || p.done) continue;
    p.tripAt = undefined;
    if (p.act?.kind === 'fall') continue;
    p.act = { kind: 'fall', from: p.age, until: p.age + 3 + ((personHash(p.id) >> 3) & 3), faceX: p.x - Math.cos(p.heading), faceY: p.y - Math.sin(p.heading) };
    p.v = 0;
  }
  // The cars off the road: solid to a walker as a person is
  const carZones: CarZone[] = [];
  // The scenery's parked cars stand where they stand
  s.parked.follow(w.ambient);
  s.onCarWay.clear();
  // The trains at grade: solid as cars are (nobody walks across a level crossing under one).
  // Only the trains that can reach a walker (their box, with a walker's look ahead).
  let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity;
  for (const p of s.walkers) { if (p.x < wx0) wx0 = p.x; if (p.x > wx1) wx1 = p.x; if (p.y < wy0) wy0 = p.y; if (p.y > wy1) wy1 = p.y; }
  const walkersBox = [wx0 - LOOK, wy0 - LOOK, wx1 + LOOK, wy1 + LOOK] as const;
  for (const discs of s.walkers.length ? w.city.transit.trainZones(true, walkersBox) : []) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of discs) { x0 = Math.min(x0, d.x - d.r); y0 = Math.min(y0, d.y - d.r); x1 = Math.max(x1, d.x + d.r); y1 = Math.max(y1, d.y + d.r); }
    // `on` empty: whoever is on a train's ground walks off it (`inside` below).
    carZones.push({ x0, y0, x1, y1, discs, on: TRAIN_GROUND, crossingOnly: false });
  }
  // The zones by cell, each in every cell its box reaches with a walker's look ahead round it
  nearParked = s.parked.cells;
  nearMoving = fileZones(carZones);
  // DO NOT read `SimWorld.focus` here

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
    // The player's body goes where the player moves it (`movePlayerWalker`); what it does
    if (p.player) {
      if (p.act && p.age >= p.act.until) p.act = null;
      continue;
    }
    const dt = DT;
    // Stopped for something (a word, a fall): standing there, facing it.
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
        // Not for a fall or a wound: a shot person does not turn round on the spot to face the shot
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
    // On a zebra everybody keeps to their right half: those coming the other way are on the other half.
    const atKerb = crossingOf(w, st.way) !== null && p.waiting !== null && p.s < kerbInset(p.steps[p.leg - 1]?.way);
    if (crossingOf(w, st.way) && !atKerb) span[1] = Math.max(span[0], Math.min(span[1], BODY / 2));
    // And wider than the zebra, along the kerb (`WAIT_HALF`)
    if (atKerb) { span[0] = Math.min(span[0], -WAIT_HALF); span[1] = Math.max(span[1], WAIT_HALF); }
    const zebraRoom = room(st);
    const offZebra = !atKerb && crossingOf(w, st.way) !== null && p.s < kerbInset(p.steps[p.leg - 1]?.way)
      && (p.d < zebraRoom[0] - m(0.05) || p.d > zebraRoom[1] + m(0.05));

    // --- the others, in this walker's own frame: how far ahead, how far across, which way they go.
    othersN = 0;
    {
      // The others near it (a block: its cells are its own).
      seer = p; seerFrame = f;
      grid.someNear(p.x, p.y, 1, seeWalker);
      // Out of a door or a car this pass: within the same cells.
      const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
      for (let k = 0; k < late.length; k++) {
        const q = late[k]!;
        if (Math.abs(Math.floor(q.x / CELL) - cx) <= 1 && Math.abs(Math.floor(q.y / CELL) - cy) <= 1) seeWalker(q);
      }
    }
    // The cars and trains: kept off.
    const zonesN = zonesNearInto(p);
    for (let zi = 0; zi < zonesN; zi++) {
      const z = ZONES[zi]!;
      if (p.x < z.x0 - LOOK || p.x > z.x1 + LOOK || p.y < z.y0 - LOOK || p.y > z.y1 + LOOK) continue;
      // On it when the car took it, or inside the car's body (the car came to them): they walk on out of its way.
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
    // DO NOT leave them out: people queuing for the crossing stood inside the post.
    const posts = w.signalPosts.near(p.x, p.y, LOOK);
    for (let k = 0; k < posts.length; k++) {
      const post = posts[k]!;
      const rx = post.x - p.x, ry = post.y - p.y;
      const along = rx * f.tx + ry * f.ty - SIGNAL_POST_RADIUS + BODY;
      if (along + 2 * SIGNAL_POST_RADIUS <= 0 || along > LOOK) continue;
      addOther(Math.max(0.01, along), p.d - rx * f.ty + ry * f.tx, false, SIGNAL_POST_RADIUS, null, false);
    }

    // --- the stripe: the most room ahead, keeping to the right (SUMO's striping).
    if (span[1] > span[0]) {
      const right = span[0] + Math.min(span[1] - span[0], STRIPE * 0.5);
      // A metre less room for every stripe away from where the body is, unless its own stripe is shut or it is held
      const lateral = p.held === 0 && freeAhead(p.d) > m(0.05) ? LATERAL_PENALTY : 0;
      // Round a corner the leftmost stripes, in the way walked, are left to those coming the other way
      const leftEdge = span[1] - reservedFor(st);
      // Somebody coming the other way in the leftmost stripe: that stripe is theirs, and both keep right of each other
      const leftmost = span[1] - STRIPE;
      let oncomingLeft = false;
      // In that stripe: overlapping it, not anywhere to the left
      for (let k = 0; k < othersN; k++) {
        const o = OTHERS[k]!;
        if (o.oncoming && o.lat + o.r + BODY > leftmost && o.lat - o.r - BODY < span[1]) { oncomingLeft = true; break; }
      }
      const wide = span[1] - span[0] > STRIPE;
      // Held up, the stripe it holds is worth less than a free one
      const gain = p.held > HELD_SWITCH ? SWITCH_GAIN / 4 : SWITCH_GAIN;
      let best = p.aim, bestScore = freeAhead(p.aim) - (p.aim - right) * 0.15 - Math.abs(p.aim - p.d) * lateral + gain - reserveCost(p.aim, leftEdge, oncomingLeft, leftmost, wide) / 2;
      for (let c = span[0]; c <= span[1] + 1e-6; c += STRIPE / 2) {
        const score = freeAhead(c) - (c - right) * 0.15 - Math.abs(c - p.d) * Math.max(lateral, 0.2) - reserveCost(c, leftEdge, oncomingLeft, leftmost, wide);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      // A stripe just taken is kept a moment unless it shuts (`AIM_HOLD`)
      const next = clamp(best, span);
      if (Math.abs(next - p.aim) > 1e-6 && (p.age - (p.aimAt ?? -Infinity) >= AIM_HOLD || freeAhead(p.aim) < KEEP || p.held > HELD_SWITCH)) { p.aim = next; p.aimAt = p.age; }
    }
    p.aim = clamp(p.aim, span);

    // --- a zebra ahead: wait a step back from the kerb until it is theirs.
    if (p.granted !== null && p.v < MOVING && p.age - (p.grantedAt ?? p.age) > GRANT_LIFE && !onZebra(w, p)) p.granted = null;
    const zebra = zebraAhead(w, p);
    p.zebra = zebra?.zebra ?? null;
    p.waiting = null;
    // Held behind somebody waiting for the same zebra, within a few metres of it: in the queue, waiting too
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
      // Standing or at a shuffle (a crowd at a kerb, a queue, somebody slow ahead)
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
    // Jammed from the moment it has been held too long, until it is off this step or the way ahead is clear
    let nearGap = KEEP + QUEUE_GAP, nearest: Other | null = null;
    for (let k = 0; k < othersN; k++) {
      const o = OTHERS[k]!;
      if (Math.abs(o.lat - p.d) >= BODY + o.r) continue;
      if (o.along < nearGap) { nearGap = o.along; nearest = o; }
    }
    // Somebody waiting at a kerb for a zebra is a queue to wait behind - unless they face this walker
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
    // Wounded: the wound sets the pace, whatever they were told - fleeing, a hurt run (a hobble on a hurt leg)
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
      // Across the way itself, towards the stripe: its left normal runs on smoothly round a corner.
      let mx = -f.ty * ls * dt, my = f.tx * ls * dt;
      const hx = Math.cos(p.heading), hy = Math.sin(p.heading);
      const back = mx * hx + my * hy;
      if (back < 0) { mx -= hx * back; my -= hy * back; }
      p.x += mx;
      p.y += my;
      // Stepping aside is moving: but by the step really taken.
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
      // Onto or off a lot's way only at the turn itself: let on early, the body went for the gate from a step to the side of it.
      const arrived = st.lot === true && !!st.b && hypot(st.b.x - p.x, st.b.y - p.y) <= THERE;
      const ahead = p.s >= len - m(0.02) || arrived || (!st.lot && !next.lot && p.s > len - AHEAD && projectAcross(next, p.x, p.y).s >= 0);
      if (!ahead) break;
      p.leg++;
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
  // The list is written over in place; the map by id is made again only when somebody came out or went
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
      if (!state) { state = emptyCrossingState(edge.length); w.crossingStates.set(report.id, state); w.signalAtCrossing(report.id); }
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
    // Off the footways - the player, or a stretch of a route over open ground
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
  return walkersWithin(stateOf(w), x, y, radius).filter((p) => hypot(p.x - x, p.y - y) < radius).map(seen);
}

/** One walker, by id, or null when nobody of that id is out. */
export function walkerOf(w: SimWorld, id: number): WalkerSeen | null {
  const p = stateOf(w).byId.get(id);
  return p && !p.inside && !p.done ? seen(p) : null;
}

/** Puts somebody walking under the player's hand: they stop following their route. */
export function takeWalker(w: SimWorld, id: number): boolean {
  const s = stateOf(w);
  const p = s.byId.get(id);
  if (!p || p.done) return false;
  // Out on the street now, if not before: the walkers are filed again (`nearNow`).
  if (p.inside) s.nearAt = -1;
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
  joinParty(s, p);
  // Out on the street at once: the walkers are filed again (`nearNow`).
  s.nearAt = -1;
}

/** The player's body moved: where it is now, the way it faces, how fast it goes. */
export function movePlayerWalker(w: SimWorld, id: number, x: number, y: number, heading: number, v: number): void {
  const p = stateOf(w).byId.get(id);
  if (!p || !p.player) return;
  const turn = Math.atan2(Math.sin(heading - p.heading), Math.cos(heading - p.heading));
  p.turnV = turn / DT;
  p.x = x; p.y = y; p.heading = heading; p.v = v;
}

/** On their last stretch, a walk goes on to somewhere else instead of ending */
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
/** Whether a lot's way out ending at `p` reaches a footway a walker can join there (`joinFootway`, within `GATE_JOIN`) */
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

/** Everybody within `radius` of a fright */
export function startle(w: SimWorld, x: number, y: number, radius: number, seconds: number, except: number | null): number[] {
  const s = stateOf(w);
  const saw: number[] = [];
  for (const p of walkersWithin(s, x, y, radius)) {
    if (p.inside || p.done || p.player || p.id === except) continue;
    const d = hypot(p.x - x, p.y - y);
    if (d > radius) continue;
    saw.push(p.id);
    frighten(w, s, p, x, y, d, seconds);
  }
  return saw;
}

/** Those walking with somebody shot (`startWalk` with): down beside them, crying, a few seconds, then away */
function mourn(s: State, p: Walker): void {
  if (p.view.party.size < 2) return;
  for (const q of [...(s.parties.get(p.view.party.id) ?? [])]) {
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
    // In a stampede some trip over and go down, a second or a few in; some break down where they are, crouched and sobbing
    const stampede = seconds >= 20;
    if (!stampede && seconds >= 14 && after === 0) {
      // A shot (GTA V: everybody near a gunshot flees, some film it): first the head round to it
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
        // Far enough off to feel safe: they stop and hold a phone up at it a few seconds
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

/** A walker's route found again to `to`, keeping what runs through a lot (`Step.lot`) */
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

/** One walker as a test bench reads them (the weapons lab) */
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
