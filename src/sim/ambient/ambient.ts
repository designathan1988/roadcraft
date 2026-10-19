import { Rng } from '@core/rng';
import { m, stepsIn } from '@world/units';
import { DT, FLEET_CEILING, PED_CEILING } from '../params';
import type { SimWorld } from '../world';
import { ARCHETYPES, bodyClassOfArchetype, type Archetype } from '../vehicles/archetypes';
import { chooseVehicleDestination } from '../routing/destination';
import { planFrom } from '../routing/router';
import { makeDriver } from '../vehicles/driver';
import { createVehicle, type FreePose, type StandingCar, type Vehicle } from '../vehicles/state';
import type { LaneletId } from '@world/lanelets';
import { spawnVehicleAt, trafficTarget } from '../vehicles/spawn';
import { vehiclePose } from '../pose';
import { joinsFootway, onLastStretch, removeWalker, walkerAlive, walkerOf, walkOn, walkThrough } from '../agents/walk';
import type { Walkway } from '@world/walkways';
import { bayChangesSince, baySources, baysOfSource, lanesInBox, stallFits, type Bay } from '../agents/parking';
import { type DoorWay, doorWay, personGates } from '../agents/lotDoors';
import type { PersonAgeClass } from '../people/view';
import { busy, CARS, outShare, PEOPLE, type Mix } from './demand';
import { BuildingMix, SightWalls, StreetLength, atRoll, spotKey } from './ambientIndex';
import { LotPlaces, PLACE_KINDS } from './lotPlaces';


/** The life of the scenery, as GTA makes it: nobody lives here. */

/** How far round a road end its footway points are looked for, u. */
const END_LOOK = m(16);
/** Most people on foot at once, and cars driving, and the cars driving when zoomed out. */
const MAX_WALKERS = 260;
const MAX_DRIVERS = 180;
const MAX_DRIVERS_FAR = 110;
/** Seconds between two looks at the budget. */
const LOOK_EVERY = 0.25;
/** Most walkers, and most drivers, taken away a look down to the machine's ceilings (`trimToCeilings`). */
const TRIM_PER_LOOK = 10;
/** Most made in one look: the population fills over a second or two. */
const MAKE_PER_LOOK = 8;
/** A map just opened is filled this many cars and people a tick, for at most this many ticks */
const OPEN_CARS = 2;
const OPEN_PEOPLE = 2;
const OPEN_TICKS = 600;

/** Share of the bays with a car in them. */
const PARKED = 0.62;

/** The kinds of car that stand in bays and join the traffic (buses run their lines, `sim/transit`). */
export const TRAFFIC: readonly (readonly [Archetype, number])[] = ARCHETYPES
  .filter((a) => a.id !== 'bus')
  .map((a) => [a, a.id === 'truck' ? a.weight * 0.4 : a.weight] as const);
const PARKED_KINDS = ARCHETYPES.filter((a) => a.id === 'hatch' || a.id === 'sedan' || a.id === 'suv' || a.id === 'van');

/** DO NOT stand a vehicle in every bay of the region: the scenery's car in a bay is this row of its place and look, a vehicle only when the lots drive it out (`release`) */
export interface SceneryCar extends StandingCar {
  free: FreePose;
  /** Its bay's place (`spotKey`). */
  readonly spot: number;
  /** The seed its look was drawn from (`stand`): its driver is drawn from it when it is driven out. */
  readonly seed: number;
  /** The lane its bay opened on when it was stood: the vehicle's first. */
  readonly lanelet: LaneletId;
}

export class AmbientWorld {
  /** On in the game (`main.ts`); off under test. */
  enabled = false;
  /** Where people and cars come from: round the view (GTA's way) or the ends of the roads. */
  source: 'view' | 'edges' = 'edges';
  /** The cars standing in bays: drawn, solid to walkers, never stepped; the scenery's as rows (`SceneryCar`). */
  readonly parked: StandingCar[] = [];
  /** The members of `parked` put there by the scenery or through `addParked` (`isParked`). */
  private readonly standing = new Set<StandingCar>();
  /** Each car's place in `parked`, for its removal in one step (`removeParked`). */
  private readonly parkedAt = new Map<StandingCar, number>();
  /** The cars of `parked` that may move while they stand in it: the vehicles put there through `addParked` (the scenery's rows never move) */
  readonly movers = new Set<Vehicle>();
  /** DO NOT make a reader compare the whole list every tick to find what changed: every parked car of the map, each tick. */
  private parkedLog: { readonly car: StandingCar; readonly added: boolean }[] = [];
  /** Entries of `parkedLog` before it are let go; `parkedBase` is the serial of the entry at it. */
  private parkedHead = 0;
  private parkedBase = 0;
  parkedSerial = 0;
  /** DO NOT forget the log for everybody when one reader lags: each reader's serial read up to (`parkedSince`), the log kept from the least of them. */
  private readonly parkedReaders = new Map<object, number>();
  /** The scenery's own cars standing in bays, by the bay's place (`spotKey`). */
  private readonly sceneryAt = new Map<number, SceneryCar>();
  /** Told the bay's place each time a scenery's car comes into a bay or leaves it (the lots' free bays, `lotTraffic.ts`); null: nobody. */
  sceneryWatch: ((spot: number) => void) | null = null;
  /** The scenery's cars by the source of their bays */
  private readonly carsBySource = new Map<string, Set<SceneryCar>>();
  private readonly sourceOf = new Map<SceneryCar, string>();
  /** The serial of the bays' changes last taken in (`bayChangesSince`); -1: none yet. */
  private baysSerial = -1;

  private readonly walkers = new Set<number>();
  private readonly drivers = new Set<number>();
  /** The drivers made here that may be on screen now: never taken off the road at a dead end (`vehicles/spawn.ts` stepDespawn). */
  readonly sighted = new Set<number>();
  private clock = 0;
  private nextTrip = 1 << 26;
  /** The lane graph's state the opening's lanes were listed at (`openingLanes`). */
  private lanesFor: object | null = null;
  private lanes: { id: string; length: number; x: number; y: number }[] = [];
  /** Each lane's end along all of them laid end to end, in the order of `lanes`: `lanesAt[k]` is the lengths of lanes 0..k summed. */
  private lanesAt = new Float64Array(0);
  /** A map just opened: the first fill may use the view (`reset`). */
  private fresh = true;
  /** Seconds the fresh fill may still use the view. */
  private freshFor = 4;
  /** Where people are placed while too far to be drawn: round the middle of the view. */
  private static readonly UNSEEN_REACH = m(170);
  /** The least radius people and cars live in round the view, metres */
  private static readonly LIVE_PEOPLE = m(150);
  private static readonly LIVE_CARS = m(200);

  /** Walkers and drivers this world made, for the status bar. */
  counts(): { walkers: number; drivers: number; parked: number } {
    return { walkers: this.walkers.size, drivers: this.drivers.size, parked: this.parked.length };
  }

  /** Everything made is taken away (a new map). */
  reset(w: SimWorld): void {
    for (const id of this.walkers) removeWalker(w, id);
    for (const id of this.drivers) { const v = w.vehicles.get(id); if (v) w.removeVehicle(v); }
    this.walkers.clear();
    this.roaming.clear();
    this.places = newPlaces();
    this.drivers.clear();
    this.sighted.clear();
    this.parked.length = 0;
    this.standing.clear();
    this.parkedAt.clear();
    this.movers.clear();
    this.forgetParkedLog();
    this.sceneryAt.clear();
    this.carsBySource.clear();
    this.sourceOf.clear();
    this.baysSerial = -1;
    this.vacated.clear();
    // The lots' cars of the old map with it (`agents/lotTraffic.ts`).
    w.city.lots.reset();
    this.fresh = true;
    this.freshFor = 4;
    this.opening = true;
    this.openTicks = OPEN_TICKS;
    this.openSpots.length = 0;
    // DO NOT keep them going: the same map opened twice filled other streets with other people at other ticks.
    this.clock = 0;
    this.nextEdgeLook = 0;
    this.gateWalks.made = 0;
    this.gateWalks.fromGate = 0;
    this.gateWalks.toGate = 0;
  }

  step(w: SimWorld): void {
    if (!this.enabled) return;
    // Still walking, out on the street or waiting inside to step out (`walkerOf` sees only those out).
    for (const id of this.walkers) if (!walkerAlive(w, id)) this.walkers.delete(id);
    for (const id of this.drivers) if (!w.vehicles.has(id)) { this.drivers.delete(id); this.sighted.delete(id); }
    if (this.source === 'edges') {
      // A map just opened is filled at once, the panel's numbers on its streets
      if (this.opening) this.open(w);
      this.keepWalking(w);
    }
    this.clock += DT;
    if (this.clock < LOOK_EVERY) return;
    this.clock = 0;
    if (this.source === 'edges') {
      this.trimToCeilings(w);
      this.edgePeople(w);
      this.parking(w);
      return;
    }
    const focus = w.focus;
    if (!focus) return;
    if (this.fresh) { this.freshFor -= LOOK_EVERY; if (this.freshFor <= 0) this.fresh = false; }
    const hour = (w.city.minutes(w) % 1440) / 60;
    // Drawn, people live in a ring a little wider than the view; zoomed out (not drawn), round the middle of the view.
    const reach = focus.detail ? Math.max(focus.r * 1.3, AmbientWorld.LIVE_PEOPLE) : Math.min(focus.r, AmbientWorld.UNSEEN_REACH);
    const carReach = Math.max(focus.r * 1.35, AmbientWorld.LIVE_CARS);
    const mix = this.mixAround(w, focus.x, focus.y, focus.r);
    const road = this.roadAround(w, focus.x, focus.y, reach);
    const density = (table: Mix): number =>
      table.home * mix.home * busy('home', hour) + table.shop * mix.shop * busy('shop', hour)
      + table.work * mix.work * busy('work', hour) + table.civic * mix.civic * busy('civic', hour);
    const wantWalkers = Math.min(MAX_WALKERS, Math.round(stepsIn(road, 100) * density(PEOPLE)));
    this.people(w, focus, reach, wantWalkers);
    // With the meso traffic the cars round the view are its micro window's (`meso/meso.ts`): DO NOT measure the roads for drivers it does not make.
    if (!w.meso) {
      const carRoad = this.roadAround(w, focus.x, focus.y, carReach);
      const wantDrivers = Math.min(focus.detail ? MAX_DRIVERS : MAX_DRIVERS_FAR, Math.round(stepsIn(carRoad, 100) * Math.max(0.25, density(CARS))));
      this.traffic(w, focus, carReach, wantDrivers);
    }
    this.parking(w);
  }

  /** Down to the population the machine sustains (`SimWorld.populationShare`, `sim/populationGovernor.ts`) */
  private trimToCeilings(w: SimWorld): void {
    const focus = w.focus;
    let walkers = Math.min(TRIM_PER_LOOK, w.pedViews.length - Math.floor(PED_CEILING * w.populationShare));
    for (const id of this.walkers) {
      if (walkers <= 0) break;
      const at = walkerOf(w, id);
      if (!at || (focus && focus.detail && this.seen(w, focus, at.x, at.y, m(4)))) continue;
      removeWalker(w, id);
      this.walkers.delete(id);
      walkers--;
    }
    // A count chosen on the panel is not scaled by the machine (`trafficTarget`).
    if (w.trafficCount !== null) return;
    let drivers = Math.min(TRIM_PER_LOOK, w.vehicles.size - Math.floor(FLEET_CEILING * w.populationShare));
    for (const id of this.drivers) {
      if (drivers <= 0) break;
      const v = w.vehicles.get(id);
      const pose = v ? vehiclePose(w, v, 1) : null;
      if (!v || !pose || (focus && this.seen(w, focus, pose.p.x, pose.p.y, v.archetype.length))) continue;
      w.removeVehicle(v);
      this.drivers.delete(id);
      this.sighted.delete(id);
      drivers--;
    }
  }

  // ------------------------------------------------------------ on foot

  /** Whether a point may be on screen */
  private seen(w: SimWorld, focus: NonNullable<SimWorld['focus']>, x: number, y: number, pad: number): boolean {
    if (Math.hypot(x - focus.x, y - focus.y) < focus.r + pad) return true;
    const v = focus.view;
    if (!v) return false;
    const rx = x - v.ex, ry = y - v.ey, d = Math.hypot(rx, ry);
    if (d > v.far + pad) return false;
    if (d < pad) return true;
    if ((rx * v.dx + ry * v.dy) / d <= v.cos) return false;
    // In the cone, but behind a building: hidden, as GTA fills a street from behind the corners.
    return !this.behindWall(w, v.ex, v.ey, x, y, pad);
  }

  /** DO NOT make it again on `buildings.revision` */
  private readonly walls = new SightWalls();

  /** True when a wall stands between the eye and (x, y), and between the eye and each side of it `pad` across. */
  private behindWall(w: SimWorld, ex: number, ey: number, x: number, y: number, pad: number): boolean {
    this.walls.sync(w.buildings, w.doc.changes);
    const dx = x - ex, dy = y - ey, d = Math.hypot(dx, dy) || 1;
    const sx = (-dy / d) * pad, sy = (dx / d) * pad;
    return this.walls.blocked(ex, ey, x + sx, y + sy) && this.walls.blocked(ex, ey, x - sx, y - sy);
  }

  private people(w: SimWorld, focus: NonNullable<SimWorld['focus']>, reach: number, want: number): void {
    // Drawn (`detail`), the view is the circle of radius `focus.r`: nobody is made or taken away inside it.
    const seen = focus.detail;
    const far = reach * 1.15;
    for (const id of [...this.walkers]) {
      const at = walkerOf(w, id);
      if (!at) { this.walkers.delete(id); continue; }
      const d = Math.hypot(at.x - focus.x, at.y - focus.y);
      // Never taken away where they may be seen; drawn from above, the view is the circle.
      const inSight = seen && this.seen(w, focus, at.x, at.y, m(4));
      if (!inSight && (d > far || this.walkers.size > want)) {
        removeWalker(w, id);
        this.walkers.delete(id);
      } else if (inSight) {
        // In sight on their last stretch: on to somewhere else, never ending where they are seen.
        const b = w.rng.ambient.float() * Math.PI * 2, e = reach * (0.3 + w.rng.ambient.float() * 0.7);
        walkOn(w, id, focus.x + Math.cos(b) * e, focus.y + Math.sin(b) * e, m(30));
      }
    }
    const engine = w.pedEngine;
    if (!engine.walkTrip || !engine.walkableNear) return;
    const anywhere = !seen || this.fresh;
    for (let made = 0; made < MAKE_PER_LOOK * (anywhere ? 4 : 1) && this.walkers.size < want; made++) {
      const a = w.rng.ambient.float() * Math.PI * 2;
      const d = anywhere ? reach * Math.sqrt(w.rng.ambient.float()) : focus.r * 1.05 + (reach - focus.r * 1.05) * w.rng.ambient.float();
      const from = engine.walkableNear.call(engine, w, focus.x + Math.cos(a) * d, focus.y + Math.sin(a) * d, m(30));
      if (!from || (seen && !this.fresh && this.seen(w, focus, from.x, from.y, m(6)))) continue;
      // Somewhere across the view: the walk passes through what is seen.
      const b = w.rng.ambient.float() * Math.PI * 2, e = reach * (0.3 + w.rng.ambient.float() * 0.9);
      const to = engine.walkableNear.call(engine, w, focus.x + Math.cos(b) * e, focus.y + Math.sin(b) * e, m(30));
      if (!to || Math.hypot(to.x - from.x, to.y - from.y) < m(40)) continue;
      const roll = w.rng.ambient.float();
      const ageClass: PersonAgeClass = roll < 0.12 ? 'child' : roll < 0.28 ? 'elder' : 'adult';
      const id = engine.walkTrip.call(engine, w, {
        trip: this.nextTrip++, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
        seed: Math.floor(w.rng.ambient.float() * 0x7fffffff), ageClass, reach: m(30),
      });
      if (id !== null) { this.walkers.add(id); this.company(w, id, ageClass, from, to, false); }
    }
  }

  // ------------------------------------------------------------ on foot, from the road ends


  /** The network's state the road ends were brought up to (`roadEnds`). */
  private endsFor: object | null = null;
  /** The footway points at the end of each road, by the road end's node; each node's places in `ends`. */
  private ends: { node: number; x: number; y: number }[] = [];
  private readonly endSlots = new Map<number, number[]>();
  /** Walkers whose walk does not end at a road end (a map with one): sent on to one when they can be. */
  private readonly roaming = new Set<number>();
  private nextEdgeLook = 0;
  /** The buildings people walk into, by id, kept by the diary */
  private places = newPlaces();
  /** Walks made from the road ends, and how many of them came out of a lot's gate or went in at one. */
  readonly gateWalks = { made: 0, fromGate: 0, toGate: 0 };
  /** People come out of and go in at the lots' gates (off: everybody passes from road end to road end, for a measure). */
  gates = true;

  /** DO NOT look round every node of the map when the network moves: every road drawn probed the town's road ends again. */
  private roadEnds(w: SimWorld): { node: number; x: number; y: number }[] {
    if (this.endsFor === w.net.state) return this.ends;
    const engine = w.pedEngine;
    if (!engine.walkableNear) return this.ends;
    const delta = this.endsFor === null ? null : w.net.changesSince(this.endsFor);
    this.endsFor = w.net.state;
    const nodes = delta === null ? this.everyEnd(w) : new Set<number>();
    if (delta !== null) {
      for (const id of delta.nodes) nodes.add(id);
      for (const id of delta.segments) {
        const seg = w.doc.segment(id);
        if (seg) { nodes.add(seg.a); nodes.add(seg.b); }
      }
      // A walkway changed within reach of a road end's look (16 m round it) moves what it finds.
      for (const r of delta.rects) {
        for (const id of w.net.segmentCells.idsMeeting([r[0] - END_LOOK, r[1] - END_LOOK, r[2] + END_LOOK, r[3] + END_LOOK])) {
          const seg = w.doc.segment(id);
          if (seg) { nodes.add(seg.a); nodes.add(seg.b); }
        }
      }
      for (const id of nodes) this.dropEnds(id);
    }
    for (const id of [...nodes].sort((x, y) => x - y)) {
      const node = w.doc.node(id as never);
      if (!node || !w.doc.mapEdge(node.id)) continue;
      const found: { x: number; y: number }[] = [];
      // Round the end, out to past the widest footway: each side's walkway once.
      for (let k = 0; k < 16; k++) {
        const angle = (k / 16) * Math.PI * 2;
        for (const r of [m(4), m(8), m(12)]) {
          const q = engine.walkableNear.call(engine, w, node.x + Math.cos(angle) * r, node.y + Math.sin(angle) * r, m(3));
          if (!q || Math.hypot(q.x - node.x, q.y - node.y) > END_LOOK) continue;
          if (found.some((f) => Math.hypot(f.x - q.x, f.y - q.y) < m(3))) continue;
          found.push({ x: q.x, y: q.y });
        }
      }
      const slots: number[] = [];
      for (const q of found) { slots.push(this.ends.length); this.ends.push({ node: node.id, x: q.x, y: q.y }); }
      if (slots.length) this.endSlots.set(node.id, slots);
    }
    return this.ends;
  }

  /** How many people on foot the panel asks for: its count, or, following the city */
  private peopleTarget(w: SimWorld): number {
    const street = this.roadAround(w, 0, 0, Infinity);
    const most = Math.floor(stepsIn(street, 8));
    if (w.pedestrianCount !== null || !w.followCity) return Math.min(Math.max(0, Math.round(w.pedestrianCount ?? 0)), most);
    const hour = (w.city.minutes(w) % 1440) / 60;
    const mix = this.mixAround(w, 0, 0, Infinity);
    const table = PEOPLE.home * mix.home * busy('home', hour) + PEOPLE.shop * mix.shop * busy('shop', hour)
      + PEOPLE.work * mix.work * busy('work', hour) + PEOPLE.civic * mix.civic * busy('civic', hour);
    const want = Math.round(stepsIn(street, 100) * table * w.pedestrianIntensity);
    return Math.min(Math.max(0, want), most, Math.floor(PED_CEILING * w.populationShare));
  }

  /** People on foot, up to the number chosen, from where people come from: a road end (from off the map) or a lot's gate */
  private edgePeople(w: SimWorld): void {
    const engine = w.pedEngine;
    if (!engine.walkTrip) return;
    this.refreshPlaces(w);
    const want = this.peopleTarget(w);
    // Everybody on foot counts (riders getting off a bus, the player too), not only those made here.
    const onFoot = Math.max(this.walkers.size, w.pedViews.length);
    if (onFoot >= want) return;
    const ends = this.roadEnds(w);
    const hour = (w.city.minutes(w) % 1440) / 60;
    // The lots' own people: how many the land use puts on its street at this hour
    let outW = 0, inW = 0;
    if (this.gates && (this.placesReady(w) || !ends.length)) {
      // By kind: the frontage of the lots of that kind that may be walked to
      const frontage = this.places.frontages();
      PLACE_KINDS.forEach((kind, k) => {
        const people = PEOPLE[kind] * busy(kind, hour) * (frontage[k]! / m(100));
        const out = outShare(kind, hour);
        outW += people * out;
        inW += people * (1 - out);
      });
    }
    if (!ends.length && outW <= 0) return;
    this.nextEdgeLook -= LOOK_EVERY;
    if (this.nextEdgeLook > 0) return;
    // Two a second at most: the street fills over a while, and each new body is built without a stall
    const batch = Math.min(want - onFoot, 2);
    this.nextEdgeLook = 1;
    // With no road end, everybody comes out of a lot.
    const local = ends.length ? Math.min(1, (outW + inW) / Math.max(1, want)) : 1;
    for (let made = 0, tries = 0; made < batch && tries < batch * 4; tries++) {
      // Out of a lot, into one, both (the other end in town as often as any end is), or neither.
      let fromLot: DoorWay | null = null;
      let toLot: DoorWay | null = null;
      if (outW + inW > 0 && w.rng.ambient.float() < local) {
        const out = !ends.length || w.rng.ambient.float() * (outW + inW) < outW;
        const first = this.pickPlace(w, hour, out, null);
        const second = first && w.rng.ambient.float() < local ? this.pickPlace(w, hour, !out, first) : null;
        if (out) { fromLot = first; toLot = second; } else { toLot = first; fromLot = second; }
      }
      let from: { node: number; x: number; y: number };
      if (fromLot) {
        const door = fromLot.out[0]!;
        from = { node: -1, x: door.x, y: door.y };
      } else {
        if (!ends.length) continue;
        from = ends[Math.floor(w.rng.ambient.float() * ends.length)]!;
        // Not onto somebody standing there (out of a door, they wait inside until it is clear).
        if (engine.bridge.anyoneWithin(w, from.x, from.y, m(1.5), null)) continue;
      }
      if (this.walkFrom(w, from, fromLot, toLot) !== null) made++;
    }
  }

  /** A walk from `from` (a road end, a lot's door with `fromLot`, a point on a footway) */
  private walkFrom(w: SimWorld, from: { node: number; x: number; y: number }, fromLot: DoorWay | null, toLot: DoorWay | null): number | null {
    const engine = w.pedEngine;
    if (!engine.walkTrip) return null;
    let to: { node: number; x: number; y: number };
    let roams = false;
    if (toLot) {
      const door = toLot.out[0]!;
      to = { node: -1, x: door.x, y: door.y };
    } else {
      const end = this.pickEnd(w, from.node);
      if (end) to = end;
      else {
        const p = this.across(w, from);
        if (!p) return null;
        to = { node: -1, x: p.x, y: p.y };
        roams = true;
      }
    }
    const roll = w.rng.ambient.float();
    const ageClass: PersonAgeClass = roll < 0.12 ? 'child' : roll < 0.28 ? 'elder' : 'adult';
    const head = fromLot ? fromLot.out : NO_WAY;
    const tail = toLot ? reversed(toLot) : NO_WAY;
    const trip = {
      trip: this.nextTrip++, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
      seed: Math.floor(w.rng.ambient.float() * 0x7fffffff), ageClass, reach: m(30),
    };
    const id = fromLot || toLot ? walkThrough(w, trip, head, tail) : engine.walkTrip.call(engine, w, trip);
    if (id === null) return null;
    this.walkers.add(id);
    if (roams) this.roaming.add(id);
    this.gateWalks.made++;
    if (fromLot) this.gateWalks.fromGate++;
    if (toLot) this.gateWalks.toGate++;
    this.company(w, id, ageClass, from, to, roams, head, tail);
    return id;
  }

  /** A footway point somewhere across the map from `from`: 60 to 260 m off. */
  private across(w: SimWorld, from: { x: number; y: number }): { x: number; y: number } | null {
    const engine = w.pedEngine;
    for (let k = 0; k < 4; k++) {
      const a = w.rng.ambient.float() * Math.PI * 2, d = m(60) + w.rng.ambient.float() * m(200);
      const p = engine.walkableNear?.call(engine, w, from.x + Math.cos(a) * d, from.y + Math.sin(a) * d, m(30));
      if (p) return p;
    }
    return null;
  }

  /** The walkers whose walk does not end at a road end or at a lot's door, sent on before they get to its end */
  private keepWalking(w: SimWorld): void {
    if (!this.roaming.size) return;
    const hour = (w.city.minutes(w) % 1440) / 60;
    for (const id of [...this.roaming]) {
      if (!this.walkers.has(id)) { this.roaming.delete(id); continue; }
      if (!onLastStretch(w, id)) continue;
      const at = walkerOf(w, id);
      if (!at) continue;
      const lot = this.gates && this.placesReady(w) && w.rng.ambient.float() < 0.6 ? this.pickPlace(w, hour, false, null) : null;
      if (lot && walkOn(w, id, lot.out[0]!.x, lot.out[0]!.y, m(30), reversed(lot))) {
        this.roaming.delete(id);
        this.gateWalks.toGate++;
        continue;
      }
      const end = this.pickEnd(w, null);
      if (end && walkOn(w, id, end.x, end.y, m(30))) { this.roaming.delete(id); continue; }
      const p = this.across(w, at);
      if (p) walkOn(w, id, p.x, p.y, m(30));
    }
  }

  // ------------------------------------------------------------ a map just opened

  /** Filling a map just opened (`reset`), ticks of it left, and where people were put meanwhile. */
  private opening = true;
  private openTicks = OPEN_TICKS;
  private readonly openSpots: { x: number; y: number }[] = [];
  /** The walkways' state the footways below were read at (`WalkGraph.state`). */
  private footFor: object | null = null;
  private foot: { way: Walkway; at: number }[] = [];
  private footLength = 0;

  /** The panel's numbers put on the streets of a map just opened, a slice a tick (`OPEN_CARS`, `OPEN_PEOPLE`) */
  private open(w: SimWorld): void {
    // A map with no road (a new map): nothing to fill, and nothing filled later in sight
    if (!this.openingLanes(w).length) { this.endOpening(); return; }
    const cars = w.edgeTraffic && !w.meso ? trafficTarget(w) - w.vehicles.size : 0;
    const people = this.peopleTarget(w) - this.walkers.size;
    if (cars > 0) this.openCars(w, Math.min(cars, OPEN_CARS));
    if (people > 0) this.openPeople(w, Math.min(people, OPEN_PEOPLE));
    if (--this.openTicks <= 0 || (cars <= 0 && people <= 0)) this.endOpening();
  }

  private endOpening(): void {
    this.opening = false;
    this.openSpots.length = 0;
  }

  /** Cars on link lanes of the whole map, each lane drawn by its length */
  private openCars(w: SimWorld, n: number): void {
    const lanes = this.openingLanes(w);
    const at = this.lanesAt;
    const total = at.length ? at[at.length - 1]! : 0;
    const rng = w.rng.spawnVehicles;
    for (let made = 0, tries = 0; made < n && tries < n * 6; tries++) {
      // DO NOT walk the lanes subtracting lengths: that was every lane of the map per car made.
      const pick = lanes[atRoll(at, rng.float() * total)]!;
      const arch = rng.weighted(TRAFFIC);
      if (pick.length < arch.length + m(3)) continue;
      const s = arch.length + m(0.4) + rng.float() * (pick.length - arch.length - m(0.8));
      if (spawnVehicleAt(w, pick.id, s, arch) !== null) made++;
    }
  }

  /** People on the footways of the whole map, each footway drawn by its length, never within 1.5 m of anybody */
  private openPeople(w: SimWorld, n: number): void {
    const engine = w.pedEngine;
    if (!engine.walkTrip) return;
    this.refreshPlaces(w);
    const graph = w.walkwaysNow();
    // @rebuild Read only while a map is opening (`OPEN_TICKS`), when the walkways change.
    if (graph.state !== this.footFor) {
      this.footFor = graph.state;
      this.foot = [];
      this.footLength = 0;
      for (const way of graph.ways) {
        if (!way || way.kind !== 'footway' || way.path.length < m(4)) continue;
        this.foot.push({ way, at: this.footLength });
        this.footLength += way.path.length;
      }
    }
    if (!this.foot.length) return;
    const rng = w.rng.spawnPeds;
    const hour = (w.city.minutes(w) % 1440) / 60;
    const SPACE = m(1.5);
    for (let made = 0, tries = 0; made < n && tries < n * 6; tries++) {
      const roll = rng.float() * this.footLength;
      let lo = 0, hi = this.foot.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.foot[mid]!.at <= roll) lo = mid; else hi = mid - 1; }
      const way = this.foot[lo]!.way;
      const f = way.path.sampleAt(Math.min(way.path.length, roll - this.foot[lo]!.at));
      // Across the footway, in its through zone, away from the kerb's edge.
      const across = way.lo + (way.hi - way.lo) * (0.3 + 0.4 * rng.float());
      const x = f.p.x - f.t.y * across, y = f.p.y + f.t.x * across;
      if (this.openSpots.some((q) => Math.hypot(q.x - x, q.y - y) < SPACE)) continue;
      if (engine.bridge.anyoneWithin(w, x, y, SPACE, null)) continue;
      // Into a lot by the hour's tables, as the walkers from the road ends.
      const toLot = this.gates && this.placesReady(w) && rng.float() < 0.6 ? this.pickPlace(w, hour, false, null) : null;
      const id = this.walkFrom(w, { node: -1, x, y }, null, toLot);
      if (id === null) continue;
      this.openSpots.push({ x, y });
      made++;
    }
  }

  /** The buildings people walk into, taken in from the diary */
  private refreshPlaces(w: SimWorld): void {
    this.places.sync(w.buildings, w.doc.changes);
  }

  /** Whether a lot may be walked to: one whose way is known to be walkable, or not yet worked out. */
  private placesReady(w: SimWorld): boolean {
    this.refreshPlaces(w);
    return this.places.ready();
  }

  /** A lot with a way to its door, at random by the people it has on its street now coming out (`out`) or going in */
  private pickPlace(w: SimWorld, hour: number, out: boolean, not: DoorWay | null): DoorWay | null {
    this.refreshPlaces(w);
    const coef = PLACE_KINDS.map((kind) => {
      const share = outShare(kind, hour);
      return PEOPLE[kind] * busy(kind, hour) * (out ? share : 1 - share);
    });
    return this.places.pick(w.rng.ambient, coef, not, (p) => joinsFootway(w, p), WALK_DECAY, m(40));
  }

  /** Now and then somebody walking with a walker just made (`walkTrip` with) */
  private company(w: SimWorld, leader: number, age: PersonAgeClass, from: { x: number; y: number }, to: { x: number; y: number }, roams: boolean,
    head: readonly { x: number; y: number }[] = NO_WAY, tail: readonly { x: number; y: number }[] = NO_WAY): void {
    const engine = w.pedEngine;
    if (!engine.walkTrip) return;
    const roll = w.rng.ambient.float();
    if (roll >= 0.4) return;
    const ageClass: PersonAgeClass = age === 'child' ? 'adult' : roll < 0.1 && age === 'adult' ? 'child' : age;
    // Out of the same door: after the first, when the spot is clear (`walk.ts` inside)
    const trip = {
      trip: this.nextTrip++, fromX: from.x + (head.length ? 0 : m(0.9)), fromY: from.y, toX: to.x, toY: to.y,
      seed: Math.floor(w.rng.ambient.float() * 0x7fffffff), ageClass, reach: m(30), with: leader,
    };
    const id = head.length || tail.length ? walkThrough(w, trip, head, tail) : engine.walkTrip.call(engine, w, trip);
    if (id === null) return;
    this.walkers.add(id);
    if (roams) this.roaming.add(id);
  }

  /** @rebuild The road ends forgotten, and every node to look round. */
  private everyEnd(w: SimWorld): Set<number> {
    this.ends = [];
    this.endSlots.clear();
    return new Set(w.doc.nodes.keys());
  }

  /** A road end's points taken out of `ends`, each place filled by the last point (its node's slot moved with it). */
  private dropEnds(node: number): void {
    const slots = this.endSlots.get(node);
    if (!slots) return;
    this.endSlots.delete(node);
    for (const slot of [...slots].sort((x, y) => y - x)) {
      const last = this.ends.pop()!;
      if (slot === this.ends.length) continue;
      this.ends[slot] = last;
      const moved = this.endSlots.get(last.node);
      if (moved) moved[moved.indexOf(this.ends.length)] = slot;
    }
  }

  /** Drawn among all of them, a draw of `not`'s own points falling to the next of the others */
  private pickEnd(w: SimWorld, not: number | null): { node: number; x: number; y: number } | null {
    const ends = this.roadEnds(w);
    const own = not === null ? [] : [...this.endSlots.get(not) ?? []].sort((x, y) => x - y);
    const others = ends.length - own.length;
    if (others <= 0) return null;
    // The k-th point of the others, in `ends` order: each of `not`'s points (few) at or before it steps it on.
    let at = Math.floor(w.rng.ambient.float() * others);
    for (const slot of own) if (slot <= at) at++;
    return ends[at]!;
  }

  // ------------------------------------------------------------ traffic

  private traffic(w: SimWorld, focus: NonNullable<SimWorld['focus']>, reach: number, want: number): void {
    const far = reach * 1.15;
    for (const id of [...this.drivers]) {
      const v = w.vehicles.get(id);
      if (!v) { this.drivers.delete(id); this.sighted.delete(id); continue; }
      const pose = vehiclePose(w, v, 1);
      const d = pose ? Math.hypot(pose.p.x - focus.x, pose.p.y - focus.y) : Infinity;
      const inSight = pose !== null && this.seen(w, focus, pose.p.x, pose.p.y, v.archetype.length);
      if (inSight) {
        this.sighted.add(id);
        // Near the end of its way (a road off the map), somewhere else instead: a car in sight drives on.
        const at = v.route.indexOf(v.lanelet);
        if (at >= 0 && v.route.length - at <= 5) {
          const next = chooseVehicleDestination(w, v.lanelet, bodyClassOfArchetype(v.archetype));
          if (next && next !== v.destination) { v.destination = next; planFrom(w, v); }
        }
      } else this.sighted.delete(id);
      if (!inSight && (d > far || this.drivers.size > want)) {
        w.removeVehicle(v);
        this.drivers.delete(id);
        this.sighted.delete(id);
      }
    }
    if (this.drivers.size >= want) return;
    // DO NOT draw from every lane of the map and throw away those far off
    const lanes = this.lanesAround(w, focus, reach);
    if (!lanes.length) return;
    // Cars are drawn at every zoom: only past the edge of the view, but for a map just opened.
    const anywhere = this.fresh;
    for (let tries = 0, made = 0; tries < 48 && made < MAKE_PER_LOOK * (anywhere ? 4 : 1) && this.drivers.size < want; tries++) {
      const pick = lanes[Math.floor(w.rng.ambient.float() * lanes.length)]!;
      // A lane wholly out of reach is not looked at further.
      if (Math.hypot(pick.x - focus.x, pick.y - focus.y) > reach + pick.length / 2) continue;
      const lane = w.lanelet(pick.id);
      if (!lane) continue;
      const arch = w.rng.ambient.weighted(TRAFFIC);
      const s = arch.length + m(0.4) + w.rng.ambient.float() * Math.max(0, lane.length - arch.length - m(0.8));
      const at = lane.centre.sampleAt(s).p;
      const d = Math.hypot(at.x - focus.x, at.y - focus.y);
      const ok = anywhere ? d < reach : d < reach && !this.seen(w, focus, at.x, at.y, arch.length + m(4));
      if (!ok) continue;
      const id = spawnVehicleAt(w, lane.id, s, arch);
      if (id !== null) { this.drivers.add(id); made++; }
    }
  }

  /** The link lanes whose bounds come within `reach` of the focus, each with its middle: where cars can join near the view. */
  private lanesAround(w: SimWorld, focus: { x: number; y: number }, reach: number): { id: string; length: number; x: number; y: number }[] {
    const out: { id: string; length: number; x: number; y: number }[] = [];
    for (const lane of lanesInBox(w, focus.x - reach, focus.y - reach, focus.x + reach, focus.y + reach)) {
      if (lane.kind !== 'link' || lane.length < m(12)) continue;
      const mid = lane.centre.sampleAt(lane.length / 2).p;
      out.push({ id: lane.id, length: lane.length, x: mid.x, y: mid.y });
    }
    return out;
  }

  /** The link lanes of the map, each with its middle, for the opening's cars drawn by length (`openCars`). */
  private openingLanes(w: SimWorld): { id: string; length: number; x: number; y: number }[] {
    if (w.topologyLog.state !== this.lanesFor) this.listLanes(w);
    return this.lanes;
  }

  /** @rebuild Listed only while a map is opening (`OPEN_TICKS`), when the lanes changed, with their running sum. */
  private listLanes(w: SimWorld): void {
    this.lanesFor = w.topologyLog.state;
    this.lanes = [];
    for (const lane of w.graph.lanelets.values()) {
      if (lane.kind !== 'link' || lane.length < m(12)) continue;
      const mid = lane.centre.sampleAt(lane.length / 2).p;
      this.lanes.push({ id: lane.id, length: lane.length, x: mid.x, y: mid.y });
    }
    this.lanesAt = new Float64Array(this.lanes.length);
    let sum = 0;
    this.lanes.forEach((l, k) => { sum += l.length; this.lanesAt[k] = sum; });
  }

  // ------------------------------------------------------------ parked cars

  /** Bays whose scenery car the lots drove out (`spotKey`): left empty when the bays are made again. */
  private readonly vacated = new Set<number>();

  /** A scenery's car handed to the lots' traffic (`agents/lotTraffic.ts`), which drives it out of its bay: the vehicle it stood for, made now */
  release(w: SimWorld, car: SceneryCar): Vehicle {
    this.leaveSource(car);
    this.vacated.add(car.spot);
    if (this.sceneryAt.get(car.spot) === car) {
      this.sceneryAt.delete(car.spot);
      this.sceneryWatch?.(car.spot);
    }
    this.removeParked(car);
    // Its driver drawn from the bay's seed after its look (`stand`: the share parked, the kind, the colour), as when it was stood.
    const r = new Rng(car.seed);
    r.float(); r.float(); r.float();
    const body = createVehicle(car.id, car.archetype, makeDriver(car.archetype, () => r.float()), car.color, car.lanelet, 0, w.clock.tick);
    body.seats = 0;
    body.free = { ...car.free };
    return body;
  }

  /** DO NOT ask `parked.includes` per car per tick: the list holds every parked car of the map. */
  isParked(body: StandingCar): boolean {
    return this.standing.has(body);
  }

  /** A car of the lots' (or anybody's) drawn with the cars standing in bays: one that may move there (`movers`). */
  addParked(body: Vehicle): void {
    if (this.standing.has(body)) return;
    this.standing.add(body);
    this.parkedAt.set(body, this.parked.length);
    this.parked.push(body);
    this.movers.add(body);
    this.logParked(body, true);
  }

  /** DO NOT `indexOf` and `splice` it out: every parked car of the map, for each car of the lots that drives out */
  removeParked(body: StandingCar): void {
    this.standing.delete(body);
    this.movers.delete(body as Vehicle);
    const at = this.parkedAt.get(body);
    if (at === undefined) return;
    const last = this.parked.pop()!;
    if (last !== body) { this.parked[at] = last; this.parkedAt.set(last, at); }
    this.parkedAt.delete(body);
    this.logParked(body, false);
  }

  /** The serial the parked cars' log stands at (what `parkedSince` reads from next). */
  parkedSerialNow(): number {
    return this.parkedSerial;
  }

  /** The cars that came into `parked` (`added`) and went since `serial`, oldest first; null: read it whole. `reader` has then read up to `parkedSerial`: what all readers read is let go. */
  parkedSince(serial: number, reader?: object): readonly { readonly car: StandingCar; readonly added: boolean }[] | null {
    const out = serial < this.parkedBase || serial > this.parkedSerial ? null : this.parkedLog.slice(this.parkedHead + serial - this.parkedBase);
    if (reader) { this.parkedReaders.set(reader, this.parkedSerial); this.trimParkedLog(); }
    return out;
  }

  private logParked(car: StandingCar, added: boolean): void {
    this.parkedLog.push({ car, added });
    this.parkedSerial++;
    this.trimParkedLog();
  }

  /** The log kept from the least serial its readers read up to; a lagging reader's part longer than the list itself (reading it whole is no dearer) let go for that reader alone. */
  private trimParkedLog(): void {
    // With no reader known yet, kept up to the bound alone.
    let least = this.parkedReaders.size ? this.parkedSerial : -Infinity;
    for (const serial of this.parkedReaders.values()) if (serial < least) least = serial;
    const floor = Math.max(least, this.parkedSerial - Math.max(64, this.parked.length));
    if (floor <= this.parkedBase) return;
    this.parkedHead += floor - this.parkedBase;
    this.parkedBase = floor;
    // The let-go head dropped once it is half the array: each entry moved a bounded number of times.
    if (this.parkedHead > 64 && this.parkedHead * 2 > this.parkedLog.length) {
      this.parkedLog = this.parkedLog.slice(this.parkedHead);
      this.parkedHead = 0;
    }
  }

  /** Everything logged forgotten: a reader of before reads `parked` whole (`parkedSince` null). */
  private forgetParkedLog(): void {
    this.parkedLog = [];
    this.parkedHead = 0;
    this.parkedReaders.clear();
    this.parkedBase = ++this.parkedSerial;
  }

  /** The scenery's own car standing in the bay at `spot` (`spotKey` of the bay), if one stands there. */
  sceneryCarAt(spot: number): SceneryCar | undefined {
    return this.sceneryAt.get(spot);
  }

  /** DO NOT stand every bay of the town again at each change: every bay of the map */
  private parking(w: SimWorld): void {
    const { serial, changed } = bayChangesSince(w, this.baysSerial, this);
    if (serial === this.baysSerial && changed !== null) return;
    this.baysSerial = serial;
    // The cars of the lots by where they stand, once for this look: DO NOT walk them all for each bay (`stand`).
    const movers = this.moverCells();
    if (changed === null) {
      for (const source of [...this.carsBySource.keys()]) this.standSource(w, source, false, movers);
      for (const source of baySources(w)) this.standSource(w, source, true, movers);
      return;
    }
    for (const source of new Set(changed)) this.standSource(w, source, true, movers);
  }

  /** The cars of the lots (`movers`) filed by `MOVER_CELL` cells of where they stand. */
  private moverCells(): Map<number, Vehicle[]> {
    const cells = new Map<number, Vehicle[]>();
    for (const car of this.movers) {
      if (!car.free) continue;
      const key = moverCell(Math.floor(car.free.x / MOVER_CELL), Math.floor(car.free.y / MOVER_CELL));
      const list = cells.get(key);
      if (list) list.push(car); else cells.set(key, [car]);
    }
    return cells;
  }

  /** The scenery's cars of one source of bays stood again: those there now off, a car in each of its bays now (`stand`) */
  private standSource(w: SimWorld, source: string, fill: boolean, movers: ReadonlyMap<number, readonly Vehicle[]>): void {
    const was = new Map<number, SceneryCar>();
    for (const car of [...(this.carsBySource.get(source) ?? [])]) {
      was.set(car.spot, car);
      this.takeScenery(car);
    }
    if (!fill) return;
    const cars: SceneryCar[] = [];
    for (const bay of baysOfSource(w, source)) {
      const car = this.stand(w, bay, was.get(spotKey(bay.x, bay.y)), movers);
      if (!car) continue;
      cars.push(car);
      this.sourceOf.set(car, source);
    }
    if (cars.length) this.carsBySource.set(source, new Set(cars));
  }

  /** A scenery car in a bay, or none (the bay left empty): the same row in the same bay each time, its look drawn from where the bay is. */
  private stand(w: SimWorld, bay: Bay, was: SceneryCar | undefined, movers: ReadonlyMap<number, readonly Vehicle[]>): SceneryCar | null {
    const spot = spotKey(bay.x, bay.y);
    // Left empty by a car the lots drove out (`release`), or held by one of theirs (those within a cell of it, `moverCells`).
    if (this.vacated.has(spot)) return null;
    const cx = Math.floor(bay.x / MOVER_CELL), cy = Math.floor(bay.y / MOVER_CELL);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (const car of movers.get(moverCell(i, j)) ?? []) if (Math.hypot(car.free!.x - bay.x, car.free!.y - bay.y) < MOVER_CELL) return null;
      }
    }
    // Seeded by where the bay is, in steps of 0.4 m: the same car in it at any world unit.
    const seed = 0x9e3779b9 ^ Math.imul(Math.round(stepsIn(bay.x, 0.4) * 7) + Math.round(stepsIn(bay.y, 0.4) * 13) * 4099, 2654435761);
    const r = new Rng(seed);
    if (r.float() >= PARKED) return null;
    // A body the stall holds whole (`stallFits`): a van's nose stood through the fence at the back of a car's stall.
    const fits = PARKED_KINDS.filter((kind) => stallFits(bay, kind.length));
    const pick = r.float();
    if (!fits.length) return null;
    const arch = fits[Math.floor(pick * fits.length)]!;
    const colour = arch.palette[Math.floor(r.float() * arch.palette.length)]!;
    // A bay that was there before keeps its car (same place, same body).
    const angle = Math.atan2(-bay.oy, -bay.ox);
    const free: FreePose = { x: bay.x, y: bay.y, angle, px: bay.x, py: bay.y, pangle: angle, lot: bay.building };
    let car: SceneryCar;
    if (was && was.free.x === bay.x && was.free.y === bay.y) {
      car = was;
      car.free = free;
    } else {
      car = { id: w.nextVehicleId++, archetype: arch, color: colour, free, spot, seed, lanelet: bay.lane?.lanelet ?? '' };
    }
    this.sceneryAt.set(spot, car);
    this.sceneryWatch?.(spot);
    this.standing.add(car);
    this.parkedAt.set(car, this.parked.length);
    this.parked.push(car);
    this.logParked(car, true);
    return car;
  }

  /** A scenery car taken out of its bay (the bays changed): off the cars standing, and out of its source. */
  private takeScenery(car: SceneryCar): void {
    this.leaveSource(car);
    if (this.sceneryAt.get(car.spot) === car) {
      this.sceneryAt.delete(car.spot);
      this.sceneryWatch?.(car.spot);
    }
    this.removeParked(car);
  }

  /** A scenery car no longer counted with its source of bays. */
  private leaveSource(car: SceneryCar): void {
    const source = this.sourceOf.get(car);
    if (source === undefined) return;
    this.sourceOf.delete(car);
    const list = this.carsBySource.get(source);
    if (!list) return;
    list.delete(car);
    if (!list.size) this.carsBySource.delete(source);
  }

  // ------------------------------------------------------------ the place

  /** DO NOT count every building again under a key with `buildings.revision` */
  private readonly buildingMix = new BuildingMix();

  private mixAround(w: SimWorld, x: number, y: number, r: number): Mix {
    this.buildingMix.sync(w.buildings, w.doc.changes);
    return this.buildingMix.around(x, y, r);
  }

  /** DO NOT put a one-slot cache back in front of it: three questions a look */
  private readonly street = new StreetLength();

  private roadAround(w: SimWorld, x: number, y: number, r: number): number {
    return this.street.around(w.net, x, y, r);
  }
}

/** Distance decay of a walk from one lot to another, u: the gravity model's negative exponential, e^(-d/L) */
const WALK_DECAY = m(470);
/** The buildings people walk into, by the lot's way (`lotDoors.ts`). */
const newPlaces = (): LotPlaces<DoorWay> => new LotPlaces<DoorWay>({ wayOf: doorWay, gatesOf: personGates });
const NO_WAY: readonly { x: number; y: number }[] = [];
const REVERSED = new WeakMap<DoorWay, readonly { x: number; y: number }[]>();
/** A lot's way the other way round: from the gate's foot on the footway in to the door. */
function reversed(way: DoorWay): readonly { x: number; y: number }[] {
  let back = REVERSED.get(way);
  if (!back) REVERSED.set(way, back = [...way.out].reverse());
  return back;
}

/** How near a car of the lots holds a bay (`AmbientWorld.stand`), and the cells they are filed by. */
const MOVER_CELL = m(1.5);
const moverCell = (i: number, j: number): number => (i + 2 ** 20) * 2 ** 21 + (j + 2 ** 20);
