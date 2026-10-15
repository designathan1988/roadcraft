import type { Vec2 } from '@core/vec2';
import { type RailGraph, type TransitLine, type TransitStop, railGraph, railPath } from '@world/transit';
import { m } from '@world/units';
import { DRIVER_NOISE, DT } from '../params';
import type { SimWorld } from '../world';
import { ARCHETYPES, bodyClassOfArchetype } from '../vehicles/archetypes';
import { planTrip } from '../drive/tactical';
import { makeDriver } from '../vehicles/driver';
import { createVehicle, snapshot, type Vehicle, type VehicleId } from '../vehicles/state';
import { planFrom } from '../routing/router';
import { laneBeside, laneRank, lanesInBox } from '../agents/parking';
import type { BayLane } from '../agents/parking';

/**
 * Public transport running (`world/transit.ts` laid out by the player).
 *
 * BUSES are vehicles of the traffic: each line puts its buses on the road at
 * its terminal (or its first stop), one after another, and each drives to the
 * lane beside its next stop (`Vehicle.commute`, as a resident's car drives to
 * the bay it parks at), stops there, opens its doors a while - longer at a
 * terminal - and goes on to the next, out along the line and back.
 *
 * TRAINS and the METRO run on their own tracks: the line's way out along its
 * stations and back is a loop of points (`railPath`); a train goes along it
 * at its speed, brakes for the next station, stands there with its doors
 * open, and keeps its distance to the train ahead.
 *
 * Nobody rides them: the passengers were the residents (their days, kept
 * apart in `src/backup/residents` with the API they used here: a line
 * planned, a walk to the stop, the wait, boarding and getting off).
 */

/** Seconds a bus stands at a stop with its doors open, and at a terminal; a train at a station. */
const BUS_DWELL = 12, TERMINAL_DWELL = 30, TRAIN_DWELL = 20;
/** Top speed, acceleration and braking of a train and of the metro, u/s and u/s². */
const TRAIN_TOP = m(22), METRO_TOP = m(20), TRAIN_ACCEL = m(0.9), TRAIN_BRAKE = m(1.1);
/** The gap a train keeps to the one ahead on its line. */
const TRAIN_GAP = m(120);
/** How far back from its first stop a bus is put on the road, to drive up to it. */
const APPROACH = m(25);
/** Seconds between two buses of a line leaving the terminal. */
const BUS_SPACING = 40;
/** Farthest a passenger walks to a stop, and from one. */
export const STOP_REACH = m(450);
/** A bus is at its stop this near the stopping point, below this speed. */
const AT_STOP = m(2.5), STOPPED = m(0.3);
/** The track ahead of a moving train kept clear by walkers. */
const TRAIN_AHEAD = m(30);
/** Seconds of a train's run ahead of it kept clear of walkers: time to walk across the track and more. */
const AHEAD_TIME = 7;
/** How far short of a level crossing a vehicle waits, u. */
export const CROSSING_STOP = m(5);
/** A crossing closer than this to a stop line has the traffic wait before it (a bus and room to spare). */
const KEEP_CLEAR = m(20);
/** A level crossing closes when a train is this far from it. */
const CROSSING_WARN = m(160);
const NONE: number[] = [];
/** Cars of a train, length of one. */
const TRAIN_CARS = 4, METRO_CARS = 3, CAR_LENGTH = m(18);

interface Bus {
  readonly line: number;
  id: VehicleId | null;
  /** The index of the stop it is going to, and the way along the line (+1 out, -1 back). */
  next: number;
  dir: 1 | -1;
  dwell: number;
  /** Seconds before it is put on the road (spaced from the bus before). */
  wait: number;
}

interface Train {
  readonly line: number;
  readonly key: string;
  s: number;
  v: number;
  /** Index of the station it is going to on the loop. */
  next: number;
  dwell: number;
}

/** Where a train track crosses a lane of a road at grade: the lane, how far along it, how far along the line's loop. */
interface LevelCrossing { readonly lanelet: string; readonly at: number; readonly loopS: number }

interface RailLine {
  readonly line: TransitLine;
  readonly crossings: LevelCrossing[];
  /** The loop out and back: points and the distance along it of each. */
  readonly points: Vec2[];
  readonly at: number[];
  readonly length: number;
  /**
   * Each station on the loop: the stop's id, its distance along it, and
   * whether the loop turns back there (the line's two ends).
   */
  readonly stations: { readonly stop: number; readonly s: number; readonly turn: boolean }[];
  readonly trains: Train[];
}

/** A train as drawn: its cars, each a centre and a heading; its line's colour; underground or not. */
export interface TrainView {
  readonly key: string;
  readonly colour: string;
  readonly metro: boolean;
  readonly cars: readonly { readonly x: number; readonly y: number; readonly heading: number }[];
  readonly v: number;
}

export class TransitSim {
  private builtFor = '';
  private stops = new Map<number, TransitStop>();
  /** Each bus stop's lane point (where a bus stands beside it). */
  private stopLanes = new Map<number, BayLane>();
  private buses: Bus[] = [];
  private rails: RailLine[] = [];
  /** The lines by id, made again with them (`lineOf`). */
  private lines = new Map<number, TransitLine>();

  /** The lines and their vehicles made again from the map as it is. */
  private rebuild(w: SimWorld): void {
    const t = w.doc.transit;
    this.stops = new Map(t.stops.map((s) => [s.id, s]));
    this.lines = new Map(t.lines.map((l) => [l.id, l]));
    this.stopLanes.clear();
    for (const s of t.stops) {
      if (s.mode !== 'bus') continue;
      const lane = laneBeside(w, s.x, s.y, s.segment);
      if (lane) this.stopLanes.set(s.id, lane);
    }
    // The buses of a line still running stay on the road, where they are,
    // each sent on again to its next stop (its lane may be another now:
    // `stepBus` sends a bus with no stop); only those of a line gone, or
    // past its number of buses, come off. DO NOT take every bus off the road
    // here: this runs at every edit of the roads, and every bus of the town
    // vanished and was made again at its terminal for a road drawn anywhere.
    const before = new Map<number, Bus[]>();
    for (const b of this.buses) {
      const list = before.get(b.line);
      if (list) list.push(b); else before.set(b.line, [b]);
    }
    this.buses = [];
    const kept = new Set<Bus>();
    for (const line of t.lines) {
      if (line.mode !== 'bus') continue;
      const served = line.stops.filter((id) => this.stopLanes.has(id));
      if (served.length < 2) continue;
      // From a terminal, if the line has one.
      const start = Math.max(0, line.stops.findIndex((id) => this.stops.get(id)?.terminal));
      const was = before.get(line.id) ?? [];
      for (let k = 0; k < line.vehicles; k++) {
        const bus = was[k];
        if (!bus) {
          this.buses.push({ line: line.id, id: null, next: start, dir: 1, dwell: 0, wait: k * BUS_SPACING });
          continue;
        }
        if (bus.next >= line.stops.length) { bus.next = start; bus.dir = 1; }
        const v = bus.id !== null ? w.vehicles.get(bus.id) : undefined;
        if (v) v.commute = null;
        kept.add(bus);
        this.buses.push(bus);
      }
    }
    for (const list of before.values()) {
      for (const b of list) {
        if (kept.has(b)) continue;
        if (b.id !== null) { const v = w.vehicles.get(b.id); if (v) w.removeVehicle(v); }
      }
    }
    const railsBefore = new Map(this.rails.map((r) => [r.line.id, r]));
    this.rails = [];
    this.crossingsByLane.clear();
    const graphs: Record<'train' | 'metro', RailGraph> = { train: railGraph(t, 'train'), metro: railGraph(t, 'metro') };
    for (const line of t.lines) {
      if (line.mode === 'bus') continue;
      const g = graphs[line.mode];
      const stations = line.stops.map((id) => this.stops.get(id)).filter((s): s is TransitStop => !!s);
      if (stations.length < 2) continue;
      // Out along the stations and back: one loop.
      const order = [...stations, ...stations.slice(1, -1).reverse()];
      // Each leg starts at the point the one before it ended on (the same
      // station met on the track, `railPath`), and the last one ends on the
      // loop's first point: every point is kept once, as polylines are joined
      // at a shared end (shapely `line_merge`, `remove_repeated_points` with
      // tolerance 0), and the loop closes by its `length`. DO NOT push whole
      // legs: every joint was a stretch of length zero on the loop, and so
      // was its closing stretch.
      const points: Vec2[] = [];
      const marks: { stop: number; index: number }[] = [];
      const repeats = (p: Vec2): boolean => {
        const last = points[points.length - 1];
        return last !== undefined && last.x === p.x && last.y === p.y;
      };
      let ok = true;
      for (let i = 0; i < order.length; i++) {
        const a = order[i]!, b = order[(i + 1) % order.length]!;
        const leg = railPath(g, a, b);
        if (!leg) { ok = false; break; }
        marks.push({ stop: a.id, index: repeats(leg[0]!) ? points.length - 1 : points.length });
        for (const p of leg) if (!repeats(p)) points.push(p);
      }
      if (points.length > 1 && points[0]!.x === points[points.length - 1]!.x && points[0]!.y === points[points.length - 1]!.y) points.pop();
      if (!ok || points.length < 2) continue;
      const at: number[] = [0];
      const stretch = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
      for (let i = 1; i < points.length; i++) at.push(at[i - 1]! + stretch(points[i - 1]!, points[i]!));
      const length = at[at.length - 1]! + stretch(points[points.length - 1]!, points[0]!);
      // The loop turns back at the first station and at the last one out.
      // A mark on the point the loop closed on (the one taken off above) is its first.
      const stationsOn = marks.map((mk, i) => ({ stop: mk.stop, s: at[mk.index % points.length]!, turn: i === 0 || i === stations.length - 1 }));
      // The trains running on a loop that is the same keep running where they
      // are. DO NOT put them back at their starts at every edit of the roads:
      // a road drawn anywhere made every train of the town jump.
      const was = railsBefore.get(line.id);
      const same = was !== undefined && was.trains.length === line.vehicles && samePoints(was.points, points) &&
        was.stations.length === stationsOn.length && was.stations.every((st, i) => st.stop === stationsOn[i]!.stop && st.s === stationsOn[i]!.s);
      const trains: Train[] = same ? was.trains : [];
      for (let k = 0; !same && k < line.vehicles; k++) {
        const s = (length * k) / line.vehicles;
        const next = stationsOn.findIndex((st) => st.s >= s);
        trains.push({ line: line.id, key: `${line.id}:${k}`, s, v: 0, next: next < 0 ? 0 : next, dwell: 0 });
      }
      // Level crossings: where the loop crosses a lane of a road (the metro runs under them all).
      const crossings = line.mode === 'train' ? levelCrossings(w, points, at) : [];
      const rail: RailLine = { line, crossings, points, at, length, stations: stationsOn, trains };
      this.rails.push(rail);
      for (const c of crossings) {
        const list = this.crossingsByLane.get(c.lanelet);
        if (list) list.push({ rail, crossing: c }); else this.crossingsByLane.set(c.lanelet, [{ rail, crossing: c }]);
      }
    }
  }

  /**
   * The level crossings by lane, in the order of the lines and of each line's
   * crossings: what every vehicle asks of the lanes ahead of it, every tick
   * (`crossingNearEnd`, `closedOn`). DO NOT walk every line's crossings for
   * a lane: every crossing of the town, for each vehicle and each lane ahead.
   */
  private readonly crossingsByLane = new Map<string, { readonly rail: RailLine; readonly crossing: LevelCrossing }[]>();

  /** One tick of every line. */
  step(w: SimWorld): void {
    const key = `${w.doc.transitRevision}:${w.topologyRevision}`;
    if (key !== this.builtFor) { this.builtFor = key; this.rebuild(w); }
    for (const bus of this.buses) this.stepBus(w, bus);
    for (const rail of this.rails) for (const train of rail.trains) this.stepTrain(rail, train);
  }

  /** A line by id (`lines`): each bus asked it every tick of every line of the town. */
  private lineOf(id: number): TransitLine | undefined { return this.lines.get(id); }

  // ------------------------------------------------------------- buses

  private stepBus(w: SimWorld, bus: Bus): void {
    const line = this.lineOf(bus.line);
    if (!line) return;
    const v = bus.id !== null ? w.vehicles.get(bus.id) : undefined;
    if (!v) {
      // Not on the road (not yet, or taken off it): put on at the stop it was going to, in its time.
      bus.wait -= DT;
      if (bus.wait > 0) return;
      bus.id = this.spawnBus(w, line, bus);
      // Somebody at the wheel (the residents who drove the buses are kept apart, `src/backup/residents`).
      const v2 = bus.id !== null ? w.vehicles.get(bus.id) : undefined;
      if (v2) v2.seats |= 1;
      bus.wait = BUS_SPACING;
      return;
    }
    const c = v.commute;
    if (!c) { this.sendBus(w, line, bus, v); return; }
    const at = v.lanelet === c.lanelet && v.v < STOPPED && v.s >= c.at - AT_STOP;
    if (!at) return;
    // At the stop, doors open.
    const stopId = line.stops[bus.next]!;
    bus.dwell += DT;
    const terminal = this.stops.get(stopId)?.terminal || bus.next === 0 || bus.next === line.stops.length - 1;
    if (bus.dwell < (terminal ? TERMINAL_DWELL : BUS_DWELL)) return;
    bus.dwell = 0;
    // On to the next stop, turning at the ends.
    if (bus.next + bus.dir < 0 || bus.next + bus.dir >= line.stops.length) bus.dir = bus.dir === 1 ? -1 : 1;
    bus.next += bus.dir;
    this.sendBus(w, line, bus, v);
  }

  /** A bus driven on to its next stop: the lane beside it as where it stops. */
  private sendBus(w: SimWorld, line: TransitLine, bus: Bus, v: Vehicle): void {
    for (let k = 0; k < 2 * line.stops.length; k++) {
      const lane = this.stopLanes.get(line.stops[bus.next]!);
      // A stop the bus can get to from where it is (a stop on a road out of
      // the map, on the lane leaving it, cannot be reached): skipped otherwise.
      if (lane && (lane.lanelet === v.lanelet || planTrip(w, v.lanelet, v.s, lane.lanelet, bodyClassOfArchetype(v.archetype), true, v.archetype.shape))) {
        v.commute = { trip: -1, lanelet: lane.lanelet, at: lane.at + v.archetype.length / 2 };
        v.destination = lane.lanelet;
        planFrom(w, v);
        return;
      }
      // A stop with no lane beside it: skipped.
      if (bus.next + bus.dir < 0 || bus.next + bus.dir >= line.stops.length) bus.dir = bus.dir === 1 ? -1 : 1;
      bus.next += bus.dir;
    }
  }

  private spawnBus(w: SimWorld, line: TransitLine, bus: Bus): VehicleId | null {
    const lane = this.stopLanes.get(line.stops[bus.next]!);
    const arch = ARCHETYPES.find((a) => a.id === 'bus');
    const l = lane ? w.lanelet(lane.lanelet) : undefined;
    if (!lane || !arch || !l) return null;
    // A way back from the stop on its lane, driving up to it as to any stop
    // (the drive holds a vehicle at its stop only when it comes up to it).
    const start = Math.max(arch.length, lane.at - APPROACH);
    // Not into another vehicle: the lane clear from there to the stop.
    for (const body of w.bodiesIn(l.id)) if (body.s > start - arch.length * 2 && body.s - body.vehicle.archetype.length < lane.at + arch.length) return null;
    const driver = makeDriver(arch, () => w.rng.driver.float());
    const v0 = l.speedLimit * arch.speedFactor * w.rng.driver.range(DRIVER_NOISE.lo, DRIVER_NOISE.hi);
    const v = createVehicle(w.nextVehicleId++, arch, driver, line.colour, l.id, v0, w.clock.tick);
    v.s = start;
    v.v = 0;
    v.prev = snapshot(v);
    v.errand = null;
    w.vehicles.set(v.id, v);
    w.enterLanelet(v, l.id);
    v.commute = { trip: -1, lanelet: lane.lanelet, at: lane.at + arch.length / 2 };
    v.destination = lane.lanelet;
    planFrom(w, v);
    return v.id;
  }

  // ------------------------------------------------------------- trains

  private stepTrain(rail: RailLine, train: Train): void {
    const station = rail.stations[train.next]!;
    const ahead = (station.s - train.s + rail.length) % rail.length;
    if (train.dwell > 0) {
      train.dwell -= DT;
      if (train.dwell <= 0) {
        train.dwell = 0;
        train.next = (train.next + 1) % rail.stations.length;
        // At an end of the line the train goes back the way it came, as a
        // real one does: its last car leads. Its place on the loop moves on by
        // its own length - onto the way back, where the cars stand exactly
        // where they stood (`pointAt`), last first. Left at the front, the
        // leading car turned round on the loop and drove back through the
        // train's own cars.
        if (station.turn) train.s = (train.s + (rail.line.mode === 'metro' ? METRO_CARS : TRAIN_CARS) * CAR_LENGTH) % rail.length;
      }
      return;
    }
    if (ahead < m(0.6) && train.v < m(0.5)) {
      train.v = 0;
      train.dwell = TRAIN_DWELL;
      return;
    }
    // The train ahead on the line.
    let gap = Infinity;
    for (const o of rail.trains) if (o !== train) gap = Math.min(gap, (o.s - train.s + rail.length) % rail.length || Infinity);
    const top = rail.line.mode === 'metro' ? METRO_TOP : TRAIN_TOP;
    // The headway asked for, at most a share of the loop each train has: on a
    // short line the full block ahead (`TRAIN_GAP`) was longer than the loop
    // between two trains, and both stood at their first station for good -
    // the two trains a line starts with, on a track of a few hundred metres.
    // Never less than the train's own length and a margin.
    const length = (rail.line.mode === 'metro' ? METRO_CARS : TRAIN_CARS) * CAR_LENGTH;
    const headway = Math.min(TRAIN_GAP, Math.max(length + m(10), (0.6 * rail.length) / rail.trains.length));
    const room = Math.min(ahead, gap - headway);
    const want = Math.max(0, Math.min(top, Math.sqrt(2 * TRAIN_BRAKE * Math.max(0, room))));
    train.v = want > train.v ? Math.min(want, train.v + TRAIN_ACCEL * DT) : Math.max(want, train.v - TRAIN_BRAKE * 1.5 * DT);
    if (room > m(0.6) && train.v < m(0.4)) train.v = Math.min(m(0.4), want);
    train.s = (train.s + train.v * DT) % rail.length;
  }

  /** The point and heading at a distance along a line's loop. */
  private pointAt(rail: RailLine, s: number): Vec2 & { heading: number } {
    const at = rail.at, pts = rail.points;
    const d = ((s % rail.length) + rail.length) % rail.length;
    let lo = 0, hi = at.length - 1;
    if (d >= at[hi]!) {
      const a = pts[hi]!, b = pts[0]!;
      const span = rail.length - at[hi]!;
      const u = span > 0 ? (d - at[hi]!) / span : 0;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, heading: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (at[mid]! <= d) lo = mid; else hi = mid; }
    const a = pts[lo]!, b = pts[hi]!;
    const span = at[hi]! - at[lo]!;
    const u = span > 0 ? (d - at[lo]!) / span : 0;
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, heading: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  /**
   * A level crossing this close to the stop line at the end of `lanelet`
   * leaves no room to wait between the two: where it is, how far along the
   * lane; null when there is none. Traffic waits for the junction BEFORE the
   * track, as at a real crossing next to a junction (the stop line set back
   * ahead of the rails, MUTCD 8B.28; FHWA Highway-Rail Crossing Handbook,
   * "clear storage distance"), and is let into the junction from there
   * (`vehicles/obstacles.ts`, `intersections/admission.ts`).
   */
  crossingNearEnd(lanelet: string, length: number): number | null {
    let out: number | null = null;
    for (const { crossing: c } of this.crossingsByLane.get(lanelet) ?? NO_CROSSINGS) {
      if (length - c.at < KEEP_CLEAR && (out === null || c.at < out)) out = c.at;
    }
    return out;
  }

  /** True when a level crossing lies within `reach` of `at` along a lane (open or closed). */
  crossingNear(lanelet: string, at: number, reach: number): boolean {
    for (const { crossing: c } of this.crossingsByLane.get(lanelet) ?? NO_CROSSINGS) if (Math.abs(c.at - at) < reach) return true;
    return false;
  }

  /**
   * The level crossings of a lane closed now - a train coming up to it, or
   * on it: how far along the lane each is. The traffic stops short of them
   * (`vehicles/obstacles.ts`).
   */
  closedOn(lanelet: string): number[] {
    let out: number[] | null = null;
    for (const { rail, crossing: c } of this.crossingsByLane.get(lanelet) ?? NO_CROSSINGS) {
      const n = rail.line.mode === 'metro' ? METRO_CARS : TRAIN_CARS;
      for (const train of rail.trains) {
        // Ahead of the train, coming up; or under it, its cars still across.
        const ahead = (c.loopS - train.s + rail.length) % rail.length;
        if (ahead < CROSSING_WARN || ahead > rail.length - n * CAR_LENGTH - m(10)) { (out ??= []).push(c.at); break; }
      }
    }
    return out ?? NONE;
  }

  /**
   * Every car of the trains at grade, and the track just ahead of each
   * moving one, as discs a walker keeps clear of (centre, radius), one list
   * per train: nobody steps onto a level crossing with a train coming, and
   * whoever is on its ground walks off all of it, never stuck between two discs.
   */
  trainZones(ahead = true): { x: number; y: number; r: number }[][] {
    const zones = new Map<string, { x: number; y: number; r: number }[]>();
    const zone = (key: string): { x: number; y: number; r: number }[] => { let z = zones.get(key); if (!z) { z = []; zones.set(key, z); } return z; };
    for (const rail of ahead ? this.rails : []) {
      if (rail.line.mode === 'metro') continue;
      for (const train of rail.trains) {
        // Standing at a station, it is ground to keep off only once it is about to leave.
        if (train.v < m(1) && train.dwell > AHEAD_TIME) continue;
        // Ahead by time, not distance: as long as it takes to walk across the track.
        const reach = Math.max(TRAIN_AHEAD, train.v * AHEAD_TIME);
        for (let d = m(4); d < reach; d += m(3)) {
          const p = this.pointAt(rail, train.s + d);
          zone(train.key).push({ x: p.x, y: p.y, r: m(1.9) });
        }
      }
    }
    for (const t of this.trains()) {
      if (t.metro) continue;
      // Discs close enough to overlap: no gap a person could slip through.
      for (const car of t.cars) {
        for (let d = -CAR_LENGTH / 2 + m(1.5); d <= CAR_LENGTH / 2 - m(1.5) + 1e-6; d += m(2.5)) {
          zone(t.key).push({ x: car.x + Math.cos(car.heading) * d, y: car.y + Math.sin(car.heading) * d, r: m(1.8) });
        }
      }
    }
    return [...zones.values()];
  }

  /** Every train as drawn. */
  trains(): TrainView[] {
    const out: TrainView[] = [];
    for (const rail of this.rails) {
      const metro = rail.line.mode === 'metro';
      const n = metro ? METRO_CARS : TRAIN_CARS;
      for (const train of rail.trains) {
        const cars: { x: number; y: number; heading: number }[] = [];
        for (let k = 0; k < n; k++) cars.push(this.pointAt(rail, train.s - CAR_LENGTH * (k + 0.5)));
        out.push({ key: train.key, colour: rail.line.colour, metro, cars, v: train.v });
      }
    }
    return out;
  }

}

/**
 * Slack round a leg's box when the lanes are looked up by it: a crossing's
 * `u` and `v` are worked out in floating point, and one found at the very end
 * of a leg must not be lost to rounding (a superset; `crossAt` decides).
 */
const CROSS_SLACK = 1e-3;

/**
 * Where a train's loop crosses a lane of a road: each leg of the loop meets
 * the lanes near it (the lanes' grid, `parking.ts` `lanesInBox`) and the
 * segments of those lanes whose box reaches the leg's. Every lane of the map
 * was met with every leg of every line, segment by segment, on each road edit.
 * DO NOT go back to the loop over every lane: in the order that loop met them
 * (the graph's lanes, their segments, then the legs), which the sort below keeps.
 */
export function levelCrossings(w: SimWorld, points: readonly Vec2[], at: readonly number[]): LevelCrossing[] {
  const rank = laneRank(w);
  const found: { rank: number; j: number; i: number; crossing: LevelCrossing }[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    const x0 = Math.min(a.x, b.x) - CROSS_SLACK, x1 = Math.max(a.x, b.x) + CROSS_SLACK;
    const y0 = Math.min(a.y, b.y) - CROSS_SLACK, y1 = Math.max(a.y, b.y) + CROSS_SLACK;
    for (const lane of lanesInBox(w, x0, y0, x1, y1)) {
      const c = lane.centre;
      for (let j = 1; j < c.n; j++) {
        const p = c.point(j - 1), q = c.point(j);
        if (Math.max(p.x, q.x) < x0 || Math.min(p.x, q.x) > x1 || Math.max(p.y, q.y) < y0 || Math.min(p.y, q.y) > y1) continue;
        const hit = crossAt(a, b, p, q);
        if (!hit) continue;
        const laneS = c.closestPoint({ x: p.x + (q.x - p.x) * hit.v, y: p.y + (q.y - p.y) * hit.v }).s;
        found.push({ rank: rank(lane.id), j, i, crossing: { lanelet: lane.id, at: laneS, loopS: at[i]! + Math.hypot(b.x - a.x, b.y - a.y) * hit.u } });
      }
    }
  }
  found.sort((u, v) => u.rank - v.rank || u.j - v.j || u.i - v.i);
  return found.map((f) => f.crossing);
}

const NO_CROSSINGS: readonly { readonly rail: RailLine; readonly crossing: LevelCrossing }[] = [];

/** Whether two loops run through the same points. */
function samePoints(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.x !== b[i]!.x || a[i]!.y !== b[i]!.y) return false;
  return true;
}

/** Where segment a-b crosses segment p-q: the share along each, or null. */
function crossAt(a: Vec2, b: Vec2, p: Vec2, q: Vec2): { u: number; v: number } | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = q.x - p.x, sy = q.y - p.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const u = ((p.x - a.x) * sy - (p.y - a.y) * sx) / den;
  const v = ((p.x - a.x) * ry - (p.y - a.y) * rx) / den;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null;
}
