import { Rng } from '@core/rng';
import { m, stepsIn } from '@world/units';
import type { Building } from '@world/buildings/types';
import { DT, FLEET_CEILING, PED_CEILING } from '../params';
import type { SimWorld } from '../world';
import { ARCHETYPES, bodyClassOfArchetype, type Archetype } from '../vehicles/archetypes';
import { chooseVehicleDestination } from '../routing/destination';
import { planFrom } from '../routing/router';
import { makeDriver } from '../vehicles/driver';
import { createVehicle, type Vehicle } from '../vehicles/state';
import { spawnVehicleAt, trafficTarget } from '../vehicles/spawn';
import { vehiclePose } from '../pose';
import { joinsFootway, onLastStretch, removeWalker, walkerAlive, walkerOf, walkOn, walkThrough } from '../agents/walk';
import type { Walkway } from '@world/walkways';
import { collectBays, stallFits, type Bay } from '../agents/parking';
import { type DoorWay, doorWay } from '../agents/lotDoors';
import type { PersonAgeClass } from '../people/view';
import { busy, CARS, kindOf, outShare, PEOPLE, type Mix } from './demand';
import { BuildingMix, SightWalls, StreetLength } from './ambientIndex';


/**
 * The life of the scenery, as GTA makes it: nobody lives here. People and
 * traffic are made where the camera is about to look and taken away where it
 * no longer does, within a fixed budget, at the density the place and the hour
 * call for (GTA's `popcycle`: per kind of zone and per hour, so many people
 * and so many cars).
 *
 * - NOTHING APPEARS OR VANISHES IN VIEW (the player's rule, 2026-10-05). Made
 *   outside the view, in a ring past its edge, and removed only past a wider
 *   ring (GTA IV: born out to ~105 m, culled 70-115 m and only off camera).
 *   Zoomed out past where people are drawn, the walkers are placed round the
 *   middle of the view where nobody can see them, so a zoom into the street
 *   finds it lived in. Only a map just opened is filled in view, as a game
 *   fills its world behind the loading screen.
 * - People walk the footways with the walking engine (`agents/walk.ts`):
 *   zebras, signals, cars, each other. They go from one place to another and
 *   go in when they get there.
 * - Cars join the lanes the same way and drive the traffic engine. Parked
 *   cars (GTA's car generators) stand in the bays of the whole map, the same
 *   car in the same bay every time: never simulated, so never made or taken
 *   away in sight; the renderer draws only those in view.
 * - Zoomed out past where a person can be seen, nobody is on foot at all.
 *
 * SET BY THE COMPOSITION ROOT (`enabled`) and fed by the renderer
 * (`SimWorld.focus`): with no focus (tests, harnesses) nothing is made.
 *
 * FED FROM THE ROAD ENDS AND THE LOTS (`source: 'edges'`, the game's way):
 * none of the above is made round the view.
 * - A map opened (a saved one, a file, a generated city) is lived in at once
 *   (the player, 2026-10-09: "sempre que abrir a cidade tem que já ter carros
 *   e pessoas", revoking "only at the road ends" for the opening): the
 *   panel's numbers (`SimWorld.trafficCount`, `pedestrianCount`) put on its
 *   lanes and footways in the first ticks (`open`), as a game fills its world
 *   behind the loading screen.
 * - From then on cars come in at the road ends (`vehicles/spawn.ts`
 *   stepDispatch) and out of the lots' bays (`agents/lotTraffic.ts`), and
 *   leave at a road end or into a lot; people come in on the footways at the
 *   road ends and out of the lots' gates, and leave at a road end or in at a
 *   gate (`edgePeople`, `keepWalking`) - never anywhere else, so a town with
 *   no road end keeps its numbers on its lots alone.
 */

/** Most people on foot at once, and cars driving, and the cars driving when zoomed out. */
export const MAX_WALKERS = 260;
export const MAX_DRIVERS = 180;
const MAX_DRIVERS_FAR = 110;
/** Seconds between two looks at the budget. */
const LOOK_EVERY = 0.25;
/** Most walkers, and most drivers, taken away a look down to the machine's ceilings (`trimToCeilings`). */
const TRIM_PER_LOOK = 10;
/** Most made in one look: the population fills over a second or two. */
const MAKE_PER_LOOK = 8;
/**
 * A map just opened is filled this many cars and people a tick, for at most
 * this many ticks: 400 of each in 200 ticks, under four seconds of the
 * simulation, 40 of each in a third of a second. Each car costs a route and
 * each person a walk, about a millisecond apiece in node on a generated town
 * of 1 500 buildings and two to three in the browser: 8 of each a tick made
 * opening frames of 100 to 460 ms in the browser (the clock runs up to
 * `MAX_SUBSTEPS` ticks a frame); 2 of each keep a tick to a few milliseconds.
 * A count, not a time budget, so the same map fills the same way everywhere.
 */
const OPEN_CARS = 2;
const OPEN_PEOPLE = 2;
const OPEN_TICKS = 600;

/** Share of the bays with a car in them. */
const PARKED = 0.62;

/** The kinds of car that stand in bays and join the traffic (buses run their lines, `sim/transit`). */
const TRAFFIC: readonly (readonly [Archetype, number])[] = ARCHETYPES
  .filter((a) => a.id !== 'bus')
  .map((a) => [a, a.id === 'truck' ? a.weight * 0.4 : a.weight] as const);
const PARKED_KINDS = ARCHETYPES.filter((a) => a.id === 'hatch' || a.id === 'sedan' || a.id === 'suv' || a.id === 'van');

export class AmbientWorld {
  /** On in the game (`main.ts`); off under test. */
  enabled = false;
  /** Where people and cars come from: round the view (GTA's way) or the ends of the roads. */
  source: 'view' | 'edges' = 'edges';
  /** The cars standing in bays near the view: drawn, solid to walkers, never stepped. */
  readonly parked: Vehicle[] = [];

  private readonly rng = new Rng(0xa3b1e7);
  private readonly walkers = new Set<number>();
  private readonly drivers = new Set<number>();
  /** The drivers made here that may be on screen now: never taken off the road at a dead end (`vehicles/spawn.ts` stepDespawn). */
  readonly sighted = new Set<number>();
  private readonly bays = new Map<number, Vehicle>();
  private clock = 0;
  private nextTrip = 1 << 26;
  private lanesFor = '';
  private lanes: { id: string; length: number; x: number; y: number }[] = [];
  private baysFor = '';
  private bayList: Bay[] = [];
  /** A map just opened: the first fill may use the view (`reset`). */
  private fresh = true;
  /** Seconds the fresh fill may still use the view. */
  private freshFor = 4;
  /** Where people are placed while too far to be drawn: round the middle of the view. */
  private static readonly UNSEEN_REACH = m(170);
  /**
   * The least radius people and cars live in round the view, metres: as GTA
   * keeps its population ~100 m round the player whatever the camera sees,
   * so a close view still has a street's worth of life round it, coming in.
   */
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
    this.places = [];
    this.placesFor = -1;
    this.placesRoads = -1;
    this.drivers.clear();
    this.sighted.clear();
    this.bays.clear();
    this.parked.length = 0;
    this.baysFor = '';
    this.vacated.clear();
    // The lots' cars of the old map with it (`agents/lotTraffic.ts`).
    w.city.lots.reset();
    this.fresh = true;
    this.freshFor = 4;
    this.opening = true;
    this.openTicks = OPEN_TICKS;
    this.openSpots.length = 0;
  }

  step(w: SimWorld): void {
    if (!this.enabled) return;
    // The walks that ended: in through a door.
    const engine = w.pedEngine;
    engine.takeArrivals?.(w);
    // Still walking, out on the street or waiting inside to step out (`walkerOf` sees only those out).
    for (const id of this.walkers) if (!walkerAlive(w, id)) this.walkers.delete(id);
    for (const id of this.drivers) if (!w.vehicles.has(id)) { this.drivers.delete(id); this.sighted.delete(id); }
    if (this.source === 'edges') {
      // A map just opened is filled at once, the panel's numbers on its
      // streets, as a game fills its world behind the loading screen.
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
    // Drawn, people live in a ring a little wider than the view; zoomed out
    // (not drawn), round the middle of the view.
    const reach = focus.detail ? Math.max(focus.r * 1.3, AmbientWorld.LIVE_PEOPLE) : Math.min(focus.r, AmbientWorld.UNSEEN_REACH);
    const carReach = Math.max(focus.r * 1.35, AmbientWorld.LIVE_CARS);
    const mix = this.mixAround(w, focus.x, focus.y, focus.r);
    const road = this.roadAround(w, focus.x, focus.y, reach);
    const carRoad = this.roadAround(w, focus.x, focus.y, carReach);
    const density = (table: Mix): number =>
      table.home * mix.home * busy('home', hour) + table.shop * mix.shop * busy('shop', hour)
      + table.work * mix.work * busy('work', hour) + table.civic * mix.civic * busy('civic', hour);
    const wantWalkers = Math.min(MAX_WALKERS, Math.round(stepsIn(road, 100) * density(PEOPLE)));
    const wantDrivers = Math.min(focus.detail ? MAX_DRIVERS : MAX_DRIVERS_FAR,
      Math.round(stepsIn(carRoad, 100) * Math.max(0.25, density(CARS))));
    this.people(w, focus, reach, wantWalkers);
    this.traffic(w, focus, carReach, wantDrivers);
    this.parking(w);
  }

  /**
   * Down to the population the machine sustains (`SimWorld.populationShare`,
   * `sim/populationGovernor.ts`): over the ceilings it sets, walkers and
   * drivers made here are taken away out of sight, `TRIM_PER_LOOK` a look,
   * as the view's own life takes away who is past its reach (`people`,
   * `traffic`). Without it a cut kept every walker and car until its trip
   * ended, minutes later, and the cost stayed the full town's (measured
   * 2026-10-13). People are out of sight
   * when not drawn (`focus.detail`) or out of the view; cars are drawn at
   * every zoom. The hour's own thinning is still left to the trips' ends.
   */
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

  /**
   * Whether a point may be on screen: in the circle of the view from above,
   * or, playing, near the player or inside the camera's cone this side of how
   * far anything is noticed (`SimWorld.focus.view`).
   */
  private seen(w: SimWorld, focus: NonNullable<SimWorld['focus']>, x: number, y: number, pad: number): boolean {
    if (Math.hypot(x - focus.x, y - focus.y) < focus.r + pad) return true;
    const v = focus.view;
    if (!v) return false;
    const rx = x - v.ex, ry = y - v.ey, d = Math.hypot(rx, ry);
    if (d > v.far + pad) return false;
    if (d < pad) return true;
    if ((rx * v.dx + ry * v.dy) / d <= v.cos) return false;
    // In the cone, but behind a building: hidden, as GTA fills a street from
    // behind the corners. The point grown by `pad` must be hidden whole.
    return !this.behindWall(w, v.ex, v.ey, x, y, pad);
  }

  /**
   * The walls of the buildings in a grid kept by the diary, for the line of
   * sight (`ambientIndex.ts`). DO NOT make it again on `buildings.revision`:
   * the town's ageing moves that every few seconds, and every wall of the
   * map was gathered again, then walked twice a look per person and car.
   */
  private readonly walls = new SightWalls();

  /** True when a wall stands between the eye and (x, y), and between the eye and each side of it `pad` across. */
  private behindWall(w: SimWorld, ex: number, ey: number, x: number, y: number, pad: number): boolean {
    this.walls.sync(w.doc.buildings, w.doc.changes);
    const dx = x - ex, dy = y - ey, d = Math.hypot(dx, dy) || 1;
    const sx = (-dy / d) * pad, sy = (dx / d) * pad;
    return this.walls.blocked(ex, ey, x + sx, y + sy) && this.walls.blocked(ex, ey, x - sx, y - sy);
  }

  private people(w: SimWorld, focus: NonNullable<SimWorld['focus']>, reach: number, want: number): void {
    // Drawn (`detail`), the view is the circle of radius `focus.r`: nobody is
    // made or taken away inside it. Not drawn, nothing is seen: they are kept
    // round the middle, `reach`, made and taken away anywhere.
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
        const b = this.rng.float() * Math.PI * 2, e = reach * (0.3 + this.rng.float() * 0.7);
        walkOn(w, id, focus.x + Math.cos(b) * e, focus.y + Math.sin(b) * e, m(30));
      }
    }
    const engine = w.pedEngine;
    if (!engine.walkTrip || !engine.walkableNear) return;
    const anywhere = !seen || this.fresh;
    for (let made = 0; made < MAKE_PER_LOOK * (anywhere ? 4 : 1) && this.walkers.size < want; made++) {
      const a = this.rng.float() * Math.PI * 2;
      const d = anywhere ? reach * Math.sqrt(this.rng.float()) : focus.r * 1.05 + (reach - focus.r * 1.05) * this.rng.float();
      const from = engine.walkableNear.call(engine, w, focus.x + Math.cos(a) * d, focus.y + Math.sin(a) * d, m(30));
      if (!from || (seen && !this.fresh && this.seen(w, focus, from.x, from.y, m(6)))) continue;
      // Somewhere across the view: the walk passes through what is seen.
      const b = this.rng.float() * Math.PI * 2, e = reach * (0.3 + this.rng.float() * 0.9);
      const to = engine.walkableNear.call(engine, w, focus.x + Math.cos(b) * e, focus.y + Math.sin(b) * e, m(30));
      if (!to || Math.hypot(to.x - from.x, to.y - from.y) < m(40)) continue;
      const roll = this.rng.float();
      const ageClass: PersonAgeClass = roll < 0.12 ? 'child' : roll < 0.28 ? 'elder' : 'adult';
      const id = engine.walkTrip.call(engine, w, {
        trip: this.nextTrip++, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
        seed: Math.floor(this.rng.float() * 0x7fffffff), ageClass, reach: m(30),
      });
      if (id !== null) { this.walkers.add(id); this.company(w, id, ageClass, from, to, false); }
    }
  }

  // ------------------------------------------------------------ on foot, from the road ends

  private endsFor = '';
  /** The footway points at the end of each road, by the road end's node. */
  private ends: { node: number; x: number; y: number }[] = [];
  /** Walkers whose walk does not end at a road end (a map with one): sent on to one when they can be. */
  private readonly roaming = new Set<number>();
  private nextEdgeLook = 0;
  /**
   * The lots with a people's gate (`agents/lotDoors.ts`), with what kind of
   * place each is and its way from the door to the footway: undefined until
   * worked out (a few a look), null when it has none that can be walked.
   */
  /** `footless`: a street door with no footway at its foot (`joinsFootway`), looked at again when the roads change. */
  private places: { b: Building; kind: keyof Mix; way: DoorWay | null | undefined; footless?: boolean }[] = [];
  private placesFor = -1;
  private placesRoads = -1;
  /** Walks made from the road ends, and how many of them came out of a lot's gate or went in at one. */
  readonly gateWalks = { made: 0, fromGate: 0, toGate: 0 };
  /** People come out of and go in at the lots' gates (off: everybody passes from road end to road end, for a measure). */
  gates = true;

  /** Where people come in and leave: the footways round every road end (a node with one road). */
  private roadEnds(w: SimWorld): { node: number; x: number; y: number }[] {
    const key = `${w.topologyRevision}:${w.net.revision}`;
    if (key === this.endsFor) return this.ends;
    this.endsFor = key;
    this.ends = [];
    const engine = w.pedEngine;
    if (!engine.walkableNear) return this.ends;
    for (const node of w.doc.nodes.values()) {
      if (!w.doc.mapEdge(node.id)) continue;
      const found: { x: number; y: number }[] = [];
      // Round the end, out to past the widest footway: each side's walkway once.
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        for (const r of [m(4), m(8), m(12)]) {
          const p = engine.walkableNear.call(engine, w, node.x + Math.cos(a) * r, node.y + Math.sin(a) * r, m(3));
          if (!p || Math.hypot(p.x - node.x, p.y - node.y) > m(16)) continue;
          if (found.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < m(3))) continue;
          found.push({ x: p.x, y: p.y });
        }
      }
      for (const p of found) this.ends.push({ node: node.id, x: p.x, y: p.y });
    }
    return this.ends;
  }

  /**
   * How many people on foot the panel asks for: its count, or, following the
   * city (`SimWorld.followCity`), the lots' street tables over the whole map
   * at this hour (`PEOPLE` x `busy` a 100 m of street, by the mix of its
   * buildings - the view's own model) times the panel's share. Past one per
   * 8 m of street they would only stand in each other's way.
   */
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

  /**
   * People on foot, up to the number chosen, from where people come from: a
   * road end (from off the map) or a lot's gate (out of a building). Each
   * walks to another road end and leaves there, or to a lot and goes in
   * (`walk.ts` ends the walk on arrival), by the lots' tables of the hour. A
   * town with no road end lives on its lots alone; one with a single road end
   * sends them somewhere across the map and on (`keepWalking`).
   */
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
    // The lots' own people: how many the land use puts on its street at this
    // hour (the density of the view's model, `PEOPLE` x `busy`, over each
    // lot's frontage); that share of the walkers comes out of a lot's gate or
    // goes in at one, the rest pass through from road end to road end.
    let outW = 0, inW = 0;
    // Only once most lots' ways are worked out: the first few would take everybody.
    if (this.gates && (this.placesReady() || !ends.length)) {
      for (const p of this.places) {
        if (!p.way) continue;
        const people = PEOPLE[p.kind] * busy(p.kind, hour) * (p.way.frontage / m(100));
        const out = outShare(p.kind, hour);
        outW += people * out;
        inW += people * (1 - out);
      }
    }
    if (!ends.length && outW <= 0) return;
    this.nextEdgeLook -= LOOK_EVERY;
    if (this.nextEdgeLook > 0) return;
    // Two a second at most: the street fills over a while, and each new body
    // is built without a stall (`render/agents.ts` builds one at a time).
    const batch = Math.min(want - onFoot, 2);
    this.nextEdgeLook = 1;
    // With no road end, everybody comes out of a lot.
    const local = ends.length ? Math.min(1, (outW + inW) / Math.max(1, want)) : 1;
    for (let made = 0, tries = 0; made < batch && tries < batch * 4; tries++) {
      // Out of a lot, into one, both (the other end in town as often as any end is), or neither.
      let fromLot: DoorWay | null = null;
      let toLot: DoorWay | null = null;
      if (outW + inW > 0 && this.rng.float() < local) {
        const out = !ends.length || this.rng.float() * (outW + inW) < outW;
        const first = this.pickPlace(hour, out, null);
        const second = first && this.rng.float() < local ? this.pickPlace(hour, !out, first) : null;
        if (out) { fromLot = first; toLot = second; } else { toLot = first; fromLot = second; }
      }
      let from: { node: number; x: number; y: number };
      if (fromLot) {
        const door = fromLot.out[0]!;
        from = { node: -1, x: door.x, y: door.y };
      } else {
        if (!ends.length) continue;
        from = ends[Math.floor(this.rng.float() * ends.length)]!;
        // Not onto somebody standing there (out of a door, they wait inside until it is clear).
        if (engine.bridge.anyoneWithin(w, from.x, from.y, m(1.5), null)) continue;
      }
      if (this.walkFrom(w, from, fromLot, toLot) !== null) made++;
    }
  }

  /**
   * A walk from `from` (a road end, a lot's door with `fromLot`, a point on a
   * footway): into `toLot` when given, else to another road end, else
   * somewhere across the map, sent on from there (`roaming`). Its id, or null.
   */
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
    const roll = this.rng.float();
    const ageClass: PersonAgeClass = roll < 0.12 ? 'child' : roll < 0.28 ? 'elder' : 'adult';
    const head = fromLot ? fromLot.out : NO_WAY;
    const tail = toLot ? reversed(toLot) : NO_WAY;
    const trip = {
      trip: this.nextTrip++, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
      seed: Math.floor(this.rng.float() * 0x7fffffff), ageClass, reach: m(30),
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
      const a = this.rng.float() * Math.PI * 2, d = m(60) + this.rng.float() * m(200);
      const p = engine.walkableNear?.call(engine, w, from.x + Math.cos(a) * d, from.y + Math.sin(a) * d, m(30));
      if (p) return p;
    }
    return null;
  }

  /**
   * The walkers whose walk does not end at a road end or at a lot's door,
   * sent on before they get to its end - nobody vanishes in the street: to a
   * lot, by the lots' tables of the hour, or a road end, or across the map
   * again. Every tick, so nobody reaches the end between two looks.
   */
  private keepWalking(w: SimWorld): void {
    if (!this.roaming.size) return;
    const hour = (w.city.minutes(w) % 1440) / 60;
    for (const id of [...this.roaming]) {
      if (!this.walkers.has(id)) { this.roaming.delete(id); continue; }
      if (!onLastStretch(w, id)) continue;
      const at = walkerOf(w, id);
      if (!at) continue;
      const lot = this.gates && this.placesReady() && this.rng.float() < 0.6 ? this.pickPlace(hour, false, null) : null;
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
  private footFor = '';
  private foot: { way: Walkway; at: number }[] = [];
  private footLength = 0;

  /**
   * The panel's numbers put on the streets of a map just opened, a slice a
   * tick (`OPEN_CARS`, `OPEN_PEOPLE`): cars on the lanes of the whole map,
   * people on its footways, each on a trip. After this, cars and people
   * come and go only at the road ends and the lots' gates.
   */
  private open(w: SimWorld): void {
    // A map with no road (a new map): nothing to fill, and nothing filled later
    // in sight - the first road drawn is not filled in the middle of a street.
    if (!this.lanesNear(w).length) { this.endOpening(); return; }
    const cars = w.edgeTraffic ? trafficTarget(w) - w.vehicles.size : 0;
    const people = this.peopleTarget(w) - this.walkers.size;
    if (cars > 0) this.openCars(w, Math.min(cars, OPEN_CARS));
    if (people > 0) this.openPeople(w, Math.min(people, OPEN_PEOPLE));
    if (--this.openTicks <= 0 || (cars <= 0 && people <= 0)) this.endOpening();
  }

  private endOpening(): void {
    this.opening = false;
    this.openSpots.length = 0;
  }

  /**
   * Cars on link lanes of the whole map, each lane drawn by its length (SUMO's
   * randomTrips weighted by edge length, sumo.dlr.de/docs/Tools/Trip.html),
   * at a random free place on it (its departPos "random_free": a few random
   * tries), a safe distance from the cars ahead and behind and born at a
   * speed they allow (`spawnVehicleAt`), bound for a road end, or driving
   * round until a lot calls them in (`agents/lotTraffic.ts`).
   */
  private openCars(w: SimWorld, n: number): void {
    const lanes = this.lanesNear(w);
    let total = 0;
    for (const l of lanes) total += l.length;
    const rng = w.rng.spawnVehicles;
    for (let made = 0, tries = 0; made < n && tries < n * 6; tries++) {
      let roll = rng.float() * total;
      let pick = lanes[lanes.length - 1]!;
      for (const l of lanes) { roll -= l.length; if (roll < 0) { pick = l; break; } }
      const arch = rng.weighted(TRAFFIC);
      if (pick.length < arch.length + m(3)) continue;
      const s = arch.length + m(0.4) + rng.float() * (pick.length - arch.length - m(0.8));
      if (spawnVehicleAt(w, pick.id, s, arch) !== null) made++;
    }
  }

  /**
   * People on the footways of the whole map, each footway drawn by its length,
   * never within 1.5 m of anybody (nor of anybody put there this opening and
   * still waiting to step out), each walking to a lot, a road end, or across
   * the map (`walkFrom`).
   */
  private openPeople(w: SimWorld, n: number): void {
    const engine = w.pedEngine;
    if (!engine.walkTrip) return;
    this.refreshPlaces(w);
    const key = `${w.net.revision}:${w.topologyRevision}`;
    if (key !== this.footFor) {
      this.footFor = key;
      this.foot = [];
      this.footLength = 0;
      for (const way of w.walkwaysFor(w.net.revision).ways) {
        if (way.kind !== 'footway' || way.path.length < m(4)) continue;
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
      const toLot = this.gates && this.placesReady() && rng.float() < 0.6 ? this.pickPlace(hour, false, null) : null;
      const id = this.walkFrom(w, { node: -1, x, y }, null, toLot);
      if (id === null) continue;
      this.openSpots.push({ x, y });
      made++;
    }
  }

  /**
   * The buildings people walk into, kept with the buildings: a lot whose
   * record is the same keeps its way; a few new ones are worked out each look
   * (`lotDoors.ts`: a person's grid round the gate and the door, a
   * millisecond or so each; a shop on the footway, its street door), so a
   * town grown at once never costs a frame. Every building is a candidate:
   * one with no people's gate may open its door onto the street, which only
   * its way tells (null: nobody walks to it).
   */
  private refreshPlaces(w: SimWorld): void {
    const rev = w.doc.buildings.revision;
    if (rev !== this.placesFor) {
      this.placesFor = rev;
      const known = new Map(this.places.map((p) => [p.b, p] as const));
      this.places = [];
      for (const b of w.doc.buildings.all()) {
        const was = known.get(b);
        this.places.push({ b, kind: kindOf(b), way: was?.way, footless: was?.footless ?? false });
      }
    }
    // A street door's way holds while a footway is at its foot: the roads
    // changed, those are looked at again.
    if (w.doc.revision !== this.placesRoads) {
      this.placesRoads = w.doc.revision;
      for (const p of this.places) if (p.way?.street || p.footless) { p.way = undefined; p.footless = false; }
    }
    const start = performance.now();
    for (const p of this.places) {
      if (p.way !== undefined) continue;
      const way = doorWay(p.b);
      p.footless = !!way?.street && !joinsFootway(w, way.out[way.out.length - 1]!);
      p.way = p.footless ? null : way;
      if (performance.now() - start >= WAYS_MS) break;
    }
  }

  /**
   * Whether most lots' ways to their doors are worked out (`refreshPlaces`
   * does a few a look): before, the few known would draw every walk sent to
   * a lot, and a town grown at once sent its walks to the first lots done.
   * And one of them a way to walk: every building is looked at, and a map of
   * buildings with no way in (no gate, no door on a footway) has no lot to
   * send anybody to.
   */
  private placesReady(): boolean {
    let known = 0, ways = 0;
    for (const p of this.places) {
      if (p.way !== undefined) known++;
      if (p.way) ways++;
    }
    return ways > 0 && known >= this.places.length / 2;
  }

  /**
   * A lot with a way to its door, at random by the people it has on its
   * street now coming out (`out`) or going in: `PEOPLE` x `busy` x frontage x
   * the share that way at this hour (`outShare`). Not `not`, nor one too near
   * it to be worth the walk.
   */
  private pickPlace(hour: number, out: boolean, not: DoorWay | null): DoorWay | null {
    let total = 0;
    const weight = (p: AmbientWorld['places'][number]): number => {
      if (!p.way || p.way === not) return 0;
      // The other end of a walk from `not`: nearer is likelier, by the
      // gravity model's negative exponential (`WALK_DECAY`).
      let near = 1;
      if (not) {
        const a = p.way.out[p.way.out.length - 1]!, b = not.out[not.out.length - 1]!;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < m(40)) return 0;
        near = Math.exp(-d / WALK_DECAY);
      }
      const share = outShare(p.kind, hour);
      return PEOPLE[p.kind] * busy(p.kind, hour) * p.way.frontage * (out ? share : 1 - share) * near;
    };
    for (const p of this.places) total += weight(p);
    if (total <= 0) return null;
    let roll = this.rng.float() * total;
    for (const p of this.places) {
      roll -= weight(p);
      if (roll < 0 && p.way) return p.way;
    }
    return null;
  }

  /**
   * Now and then somebody walking with a walker just made (`walkTrip` with):
   * a couple three times in ten, an adult with a child once in ten - the
   * same way, at the same pace; shot, the one left grieves beside them
   * (`sim/agents/walk.ts` mourn). Everybody walked alone, and nobody near a
   * shot person was theirs (the player, 2026-10-06).
   */
  private company(w: SimWorld, leader: number, age: PersonAgeClass, from: { x: number; y: number }, to: { x: number; y: number }, roams: boolean,
    head: readonly { x: number; y: number }[] = NO_WAY, tail: readonly { x: number; y: number }[] = NO_WAY): void {
    const engine = w.pedEngine;
    if (!engine.walkTrip) return;
    const roll = this.rng.float();
    if (roll >= 0.4) return;
    const ageClass: PersonAgeClass = age === 'child' ? 'adult' : roll < 0.1 && age === 'adult' ? 'child' : age;
    // Out of the same door: after the first, when the spot is clear (`walk.ts`
    // inside); on the footway, beside them, just past the 0.8 m a walker made
    // waits to have clear (`walk.ts` DOOR_CLEAR): at 0.6 m they stood inside
    // until the first had walked off, and a group was seen to step out apart.
    const trip = {
      trip: this.nextTrip++, fromX: from.x + (head.length ? 0 : m(0.9)), fromY: from.y, toX: to.x, toY: to.y,
      seed: Math.floor(this.rng.float() * 0x7fffffff), ageClass, reach: m(30), with: leader,
    };
    const id = head.length || tail.length ? walkThrough(w, trip, head, tail) : engine.walkTrip.call(engine, w, trip);
    if (id === null) return;
    this.walkers.add(id);
    if (roams) this.roaming.add(id);
  }

  /** A road end's footway point at another road end than `not`; null when there is none. */
  private pickEnd(w: SimWorld, not: number | null): { node: number; x: number; y: number } | null {
    const ends = this.roadEnds(w).filter((e) => e.node !== not);
    return ends.length ? ends[Math.floor(this.rng.float() * ends.length)]! : null;
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
    const lanes = this.lanesNear(w);
    if (!lanes.length) return;
    // Cars are drawn at every zoom: only past the edge of the view, but for a map just opened.
    const anywhere = this.fresh;
    for (let tries = 0, made = 0; tries < 48 && made < MAKE_PER_LOOK * (anywhere ? 4 : 1) && this.drivers.size < want; tries++) {
      const pick = lanes[Math.floor(this.rng.float() * lanes.length)]!;
      // A lane wholly out of reach is not looked at further.
      if (Math.hypot(pick.x - focus.x, pick.y - focus.y) > reach + pick.length / 2) continue;
      const lane = w.lanelet(pick.id);
      if (!lane) continue;
      const arch = this.rng.weighted(TRAFFIC);
      const s = arch.length + m(0.4) + this.rng.float() * Math.max(0, lane.length - arch.length - m(0.8));
      const at = lane.centre.sampleAt(s).p;
      const d = Math.hypot(at.x - focus.x, at.y - focus.y);
      const ok = anywhere ? d < reach : d < reach && !this.seen(w, focus, at.x, at.y, arch.length + m(4));
      if (!ok) continue;
      const id = spawnVehicleAt(w, lane.id, s, arch);
      if (id !== null) { this.drivers.add(id); made++; }
    }
  }

  /** The link lanes of the map, each with its middle: where cars can join. */
  private lanesNear(w: SimWorld): { id: string; length: number; x: number; y: number }[] {
    const key = `${w.topologyRevision}:${w.vehicleTopologyRevision}`;
    if (key !== this.lanesFor) {
      this.lanesFor = key;
      this.lanes = [];
      for (const lane of w.graph.lanelets.values()) {
        if (lane.kind !== 'link' || lane.length < m(12)) continue;
        const mid = lane.centre.sampleAt(lane.length / 2).p;
        this.lanes.push({ id: lane.id, length: lane.length, x: mid.x, y: mid.y });
      }
    }
    return this.lanes;
  }

  // ------------------------------------------------------------ parked cars

  /** Bays whose scenery car the lots drove out: left empty when the bays are made again. */
  private readonly vacated = new Set<string>();

  /**
   * A parked car handed to the lots' traffic (`agents/lotTraffic.ts`), which
   * drives it out of its bay: no longer the scenery's, and its bay is not
   * filled again when the bays are made again (a car would appear in it).
   */
  release(car: Vehicle): void {
    for (const [id, c] of this.bays) if (c === car) { this.bays.delete(id); break; }
    if (car.free) this.vacated.add(spotKey(car.free));
    const at = this.parked.indexOf(car);
    if (at >= 0) this.parked.splice(at, 1);
  }

  /**
   * The cars standing in the bays of the whole map, made again only when the
   * bays change (a building, a road): the same car in the same bay each time.
   */
  private parking(w: SimWorld): void {
    const key = `${w.doc.buildings.revision}:${w.topologyRevision}`;
    if (key === this.baysFor) return;
    this.baysFor = key;
    this.bayList = collectBays(w);
    const kept = new Map(this.bays);
    // The list is shared: the lots' own cars (`agents/lotTraffic.ts`, stepped
    // before the scenery) are in it too. Only the scenery's are made again;
    // the others stay, or a car driving into a lot went undrawn for the tick.
    const mine = new Set(kept.values());
    const others = this.parked.filter((car) => !mine.has(car));
    this.bays.clear();
    this.parked.length = 0;
    this.parked.push(...others);
    for (const bay of this.bayList) {
      // Left empty by a car the lots drove out (`release`), or held by one of theirs.
      if (this.vacated.has(spotKey(bay))) continue;
      if (others.some((car) => car.free && Math.hypot(car.free.x - bay.x, car.free.y - bay.y) < m(1.5))) continue;
      // Seeded by where the bay is, in steps of 0.4 m: the same car in it at any world unit.
      const r = new Rng(0x9e3779b9 ^ Math.imul(Math.round(stepsIn(bay.x, 0.4) * 7) + Math.round(stepsIn(bay.y, 0.4) * 13) * 4099, 2654435761));
      if (r.float() >= PARKED) continue;
      // A body the stall holds whole (`stallFits`): a van's nose stood through
      // the fence at the back of a car's stall.
      const fits = PARKED_KINDS.filter((kind) => stallFits(bay, kind.length));
      const pick = r.float();
      if (!fits.length) continue;
      const arch = fits[Math.floor(pick * fits.length)]!;
      const colour = arch.palette[Math.floor(r.float() * arch.palette.length)]!;
      // A bay that was there before keeps its car (same place, same body).
      const was = kept.get(bay.id);
      const angle = Math.atan2(-bay.oy, -bay.ox);
      const car = was && was.free && was.free.x === bay.x && was.free.y === bay.y ? was
        : createVehicle(w.nextVehicleId++, arch, makeDriver(arch, () => r.float()), colour, bay.lane?.lanelet ?? '', 0, w.clock.tick);
      car.seats = 0;
      car.free = { x: bay.x, y: bay.y, angle, px: bay.x, py: bay.y, pangle: angle, lot: bay.building };
      this.bays.set(bay.id, car);
      this.parked.push(car);
    }
  }

  // ------------------------------------------------------------ the place

  /**
   * The mix of the buildings round a place: counts by kind per cell and for
   * the whole map, kept by the diary (`ambientIndex.ts` BuildingMix). DO NOT
   * count every building again under a key with `buildings.revision`: the
   * town's ageing moves it every few seconds, and the whole map was counted
   * again that often (and on every look of the view's life).
   */
  private readonly buildingMix = new BuildingMix();

  private mixAround(w: SimWorld, x: number, y: number, r: number): Mix {
    this.buildingMix.sync(w.doc.buildings, w.doc.changes);
    return this.buildingMix.around(x, y, r);
  }

  /**
   * Street length inside the view, world units: what the population is sized
   * by (`ambientIndex.ts` streetLength). DO NOT put a one-slot cache back in
   * front of it: three questions a look (the view's people, its cars, the
   * whole map's) each threw the other's answer out, and every ribbon of the
   * map was walked again for each.
   */
  private readonly street = new StreetLength();

  private roadAround(w: SimWorld, x: number, y: number, r: number): number {
    return this.street.around(w.net, x, y, r);
  }
}

/**
 * Distance decay of a walk from one lot to another, u: the gravity model's
 * negative exponential, e^(-d/L) (Wikipedia "Trip distribution": "a negative
 * exponential tends to be the preferred form"). With places spread evenly,
 * walks then run 2L on average; L = 470 m makes that the 12 minutes of the
 * average walk in São Paulo's origin-destination survey of 2017 (about
 * 940 m at 1.3 m/s).
 */
const WALK_DECAY = m(470);
/**
 * Time given to working out lots' ways in one look of the budget, ms
 * (`refreshPlaces`): one way cost 0.65 ms on average and 4 ms at most over
 * 32 lots in `lotDoors.spec` (node), so a look works out one to three.
 */
const WAYS_MS = 1.5;
/** A bay's place as a key (a quarter of a unit), as the lots' traffic keys its bays. */
const spotKey = (p: { x: number; y: number }): string => `${Math.round(stepsIn(p.x, 0.1))},${Math.round(stepsIn(p.y, 0.1))}`;
const NO_WAY: readonly { x: number; y: number }[] = [];
const REVERSED = new WeakMap<DoorWay, readonly { x: number; y: number }[]>();
/** A lot's way the other way round: from the gate's foot on the footway in to the door. */
function reversed(way: DoorWay): readonly { x: number; y: number }[] {
  let back = REVERSED.get(way);
  if (!back) REVERSED.set(way, back = [...way.out].reverse());
  return back;
}
