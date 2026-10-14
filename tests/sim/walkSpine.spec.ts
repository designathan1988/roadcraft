import { describe, expect, it } from 'vitest';
import { Heap } from '@core/heap';
import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import type { WalkGraph, Walkway } from '@world/walkways';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { createAgentWalkEngine, inspectAgentWalkers, ParkedZoneIndex, route, walkWork } from '@sim/agents/walk';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { makeDriver } from '@sim/vehicles/driver';
import { createVehicle, type Vehicle, type VehicleId } from '@sim/vehicles/state';
import { seatPerson, stepKerbStops, type KerbStop } from '@sim/vehicles/kerbStops';

/**
 * The walkers' derived products cost what is near, not what the map holds
 * (docs/PLANO-ESPINHA-2026-10-14.md): `hailable` reads the walkers near the
 * lane, the parked cars' zones are filed again only for a car that changed,
 * a route search touches only the nodes it reaches; each gives what the old
 * algorithm (copied here) gave. The walkers step the same wherever the camera
 * is, and a seat emptied leaves no hole in the vehicle's lists.
 */

/** A grid of `n` x `n` blocks of `block` metres, centred on the origin: the same streets near it at any `n`. */
function grid(n: number, block = 80): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(block) * (i - n / 2), y: m(block) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  return doc;
}

function worldOf(doc: RoadDoc): SimWorld {
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x5a1e);
  w.rebuildTopology();
  w.usePedestrianEngine(createAgentWalkEngine());
  return w;
}

const graphOf = (w: SimWorld): WalkGraph => w.walkwaysFor(w.net.revision);

/** One walker on every footway, a quarter of the way along it to three quarters, in the graph's order. */
function populate(w: SimWorld): number {
  let n = 0;
  for (const way of graphOf(w).ways) {
    if (way.kind !== 'footway' || way.path.length < m(6)) continue;
    const a = way.path.sampleAt(way.path.length * 0.25).p, b = way.path.sampleAt(way.path.length * 0.75).p;
    if (w.pedEngine.walkTrip!(w, { trip: n, fromX: a.x, fromY: a.y, toX: b.x, toY: b.y, seed: n * 7 + 1, ageClass: 'adult' }) !== null) n++;
  }
  return n;
}

const run = (w: SimWorld, ticks: number): void => {
  for (let i = 0; i < ticks; i++) step(w, { traffic: false, pedestrians: true });
};

/** The old `hailable` (walk.ts before 2026-10-14): every walker of the map, in their order. */
function oldHailable(w: SimWorld, lanelet: string, s0: number, s1: number, exclude?: ReadonlySet<number>): { id: number; s: number } | null {
  const lane = w.lanelet(lanelet as never);
  if (!lane) return null;
  let best: { id: number; s: number } | null = null;
  for (const p of inspectAgentWalkers(w)) {
    const view = w.pedViewById.get(p.id);
    if (p.inside || !view || view.gesture || view.panic) continue;
    if (view.ageClass === 'child' || view.ground !== 'footway' || exclude?.has(p.id)) continue;
    const hit = lane.centre.closestPoint({ x: p.x, y: p.y });
    if (hit.s < s0 || hit.s > s1 || hit.distance > m(9)) continue;
    const f = lane.centre.sampleAt(hit.s);
    if ((p.x - f.p.x) * f.t.y - (p.y - f.p.y) * f.t.x <= 0) continue;
    if (!best || hit.s < best.s) best = { id: p.id, s: hit.s };
  }
  return best;
}

describe('hailable reads the walkers near the lane', () => {
  it('gives what the walk over every walker gave, on every lane', () => {
    const w = worldOf(grid(4));
    expect(populate(w)).toBeGreaterThan(40);
    run(w, 90);
    let found = 0;
    for (const lane of w.graph.lanelets.values()) {
      for (const [s0, s1] of [[0, lane.length], [lane.length * 0.2, lane.length * 0.6], [-m(5), m(12)]] as const) {
        const want = oldHailable(w, lane.id, s0, s1);
        expect(w.pedEngine.bridge.hailable(w, lane.id, s0, s1)).toEqual(want);
        if (want) {
          found++;
          const exclude = new Set([want.id]);
          expect(w.pedEngine.bridge.hailable(w, lane.id, s0, s1, exclude)).toEqual(oldHailable(w, lane.id, s0, s1, exclude));
        }
      }
    }
    expect(found).toBeGreaterThan(10);
  });

  it('looks at as many walkers on a map four times the size', () => {
    const work = (n: number): { looked: number; walkers: number } => {
      const w = worldOf(grid(n));
      const walkers = populate(w);
      run(w, 30);
      const near = [...w.graph.lanelets.values()].filter((l) => {
        const p = l.centre.sampleAt(l.length / 2).p;
        return Math.hypot(p.x, p.y) < m(60);
      });
      expect(near.length).toBeGreaterThan(4);
      const before = walkWork.hailLooked;
      for (const lane of near) w.pedEngine.bridge.hailable(w, lane.id, 0, lane.length);
      return { looked: walkWork.hailLooked - before, walkers };
    };
    const small = work(4), large = work(8);
    expect(large.walkers).toBeGreaterThan(small.walkers * 3);
    expect(small.looked).toBeGreaterThan(0);
    // The old walk looked at every walker for each lane: four times as many.
    expect(large.looked).toBeLessThanOrEqual(small.looked * 1.25);
  });
});

// ------------------------------------------------------------ parked cars' zones

interface Zone { x0: number; y0: number; x1: number; y1: number; discs: { x: number; y: number; r: number }[] }
const LOOK = m(8), ZONE_CELL = m(16);
/** The old `parkedZone` and `fileZones` (walk.ts before 2026-10-14): every parked car filed again. */
function oldZone(car: Vehicle): Zone {
  const f = car.free!;
  const r = car.archetype.width / 2;
  const reach = Math.max(0, car.archetype.length / 2 - r);
  const discs = [-1, 0, 1].map((k) => ({ x: f.x + Math.cos(f.angle) * reach * k, y: f.y + Math.sin(f.angle) * reach * k, r }));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of discs) { x0 = Math.min(x0, d.x - d.r); y0 = Math.min(y0, d.y - d.r); x1 = Math.max(x1, d.x + d.r); y1 = Math.max(y1, d.y + d.r); }
  return { x0, y0, x1, y1, discs };
}
function oldFile(cars: readonly Vehicle[]): Map<number, Zone[]> {
  const cells = new Map<number, Zone[]>();
  for (const car of cars) {
    if (!car.free) continue;
    const z = oldZone(car);
    const gx0 = Math.floor((z.x0 - LOOK) / ZONE_CELL), gx1 = Math.floor((z.x1 + LOOK) / ZONE_CELL);
    const gy0 = Math.floor((z.y0 - LOOK) / ZONE_CELL), gy1 = Math.floor((z.y1 + LOOK) / ZONE_CELL);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const k = gx * 65536 + gy;
      const list = cells.get(k);
      if (list) list.push(z); else cells.set(k, [z]);
    }
  }
  return cells;
}
/** Cells as comparable text: each cell's zones by their discs, sorted (a cell's order is read as a set). */
const cellsText = (cells: ReadonlyMap<number, readonly Zone[]>): string[] =>
  [...cells.entries()].map(([k, zs]) => `${k}:${zs.map((z) => z.discs.map((d) => `${d.x},${d.y},${d.r}`).join('|')).sort().join(';')}`).sort();

let nextCar = 1;
function car(rng: Rng, span: number): Vehicle {
  const arch = ARCHETYPES[0]!;
  const v = createVehicle(nextCar++ as VehicleId, arch, makeDriver(arch, () => rng.float()), '#fff', '' as never, 0, 0);
  const x = rng.range(-span, span), y = rng.range(-span, span), angle = rng.range(0, 6.28);
  v.free = { x, y, angle, px: x, py: y, pangle: angle, lot: 0 };
  return v;
}

describe('the parked cars are filed again only when one changes', () => {
  it('gives the cells filing them all gave, through cars coming, going and moving', () => {
    const rng = new Rng(0xca7);
    const cars: Vehicle[] = Array.from({ length: 120 }, () => car(rng, m(400)));
    const index = new ParkedZoneIndex();
    for (let round = 0; round < 200; round++) {
      const roll = rng.float();
      if (roll < 0.4) {
        // A lot's car or a lorry manoeuvring, in place (`lotTraffic.ts` setFree).
        const f = cars[rng.int(0, cars.length - 1)]!.free;
        if (f) { f.x += rng.range(-m(1), m(1)); f.angle += 0.05; }
      } else if (roll < 0.55) cars.push(car(rng, m(400)));
      else if (roll < 0.7 && cars.length > 1) cars.splice(rng.int(0, cars.length - 1), 1);
      else if (roll < 0.8) { const c = cars[rng.int(0, cars.length - 1)]!; c.free = c.free ? null : { x: 0, y: 0, angle: 0, px: 0, py: 0, pangle: 0, lot: 0 }; }
      else if (roll < 0.85) cars.reverse();
      index.sync(cars);
      expect(cellsText(index.cells as ReadonlyMap<number, readonly Zone[]>)).toEqual(cellsText(oldFile(cars)));
    }
  });

  it('files one car again for one car moving, on a map with four times the cars', () => {
    const moveOne = (count: number): number => {
      const rng = new Rng(0xbee);
      const cars = Array.from({ length: count }, () => car(rng, m(400) * Math.sqrt(count / 100)));
      const index = new ParkedZoneIndex();
      index.sync(cars);
      index.sync(cars);
      const before = walkWork.parkedFiled;
      cars[3]!.free!.x += m(0.5);
      index.sync(cars);
      return walkWork.parkedFiled - before;
    };
    const small = moveOne(100), large = moveOne(400);
    // Taken out of its cells and filed again; filing them all was every car.
    expect(small).toBe(2);
    expect(large).toBe(small);
  });
});

// ------------------------------------------------------------ routes

type Step = ReturnType<typeof route> extends (infer S)[] | null ? S : never;
/** The old `route` (walk.ts before 2026-10-14): three arrays of every node of the graph per search. */
function oldRoute(g: WalkGraph, from: { way: Walkway; s: number }, to: { way: Walkway; s: number }): Step[] | null {
  if (from.way.id === to.way.id) return [{ way: from.way, dir: to.s >= from.s ? 1 : -1, from: from.s, to: to.s }];
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1);
  const open = new Heap();
  const cost = (way: Walkway): number => way.path.length + (way.kind === 'crossing' ? m(12) : 0);
  const push = (node: number, d: number, way: number): void => {
    if (d >= dist[node]!) return;
    dist[node] = d; via[node] = way; open.push(node, d);
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
      push(way.a === node ? way.b : way.a, d + cost(way), way.id);
    }
  }
  const ends = [
    { node: to.way.a, total: dist[to.way.a]! + to.s },
    { node: to.way.b, total: dist[to.way.b]! + (to.way.path.length - to.s) },
  ].sort((p, q) => p.total - q.total);
  const end = ends[0]!;
  if (!Number.isFinite(end.total)) return null;
  const chain: { way: Walkway; enter: number }[] = [];
  let node = end.node, guard = 0;
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
const stepsText = (steps: readonly Step[] | null): string => (steps ? steps.map((s) => `${s.way?.id}:${s.dir}:${s.from}:${s.to}`).join(' ') : 'none');

/** The walkway nearest a point (any kind but a crossing), with where on it. */
function wayNear(g: WalkGraph, x: number, y: number): { way: Walkway; s: number } {
  let best: { way: Walkway; s: number; d: number } | null = null;
  for (const way of g.ways) {
    if (way.kind === 'crossing') continue;
    const hit = way.path.closestPoint({ x, y });
    if (!best || hit.distance < best.d) best = { way, s: hit.s, d: hit.distance };
  }
  return { way: best!.way, s: best!.s };
}

describe('a route search touches the nodes it reaches', () => {
  it('gives the routes the search with fresh arrays gave, search after search on the same graph', () => {
    const g = graphOf(worldOf(grid(6)));
    const rng = new Rng(0x7007e);
    const ways = g.ways.filter((w) => w.kind !== 'crossing');
    for (let k = 0; k < 400; k++) {
      const a = ways[rng.int(0, ways.length - 1)]!, b = ways[rng.int(0, ways.length - 1)]!;
      const from = { way: a, s: rng.float() * a.path.length }, to = { way: b, s: rng.float() * b.path.length };
      expect(stepsText(route(g, from, to))).toBe(stepsText(oldRoute(g, from, to)));
    }
  });

  it('touches as many nodes for a short route on a map four times the size', () => {
    const work = (n: number): { touched: number; nodes: number } => {
      const g = graphOf(worldOf(grid(n)));
      const from = wayNear(g, m(10), m(4)), to = wayNear(g, m(70), -m(30));
      const before = walkWork.routeNodes;
      expect(route(g, from, to)).not.toBeNull();
      return { touched: walkWork.routeNodes - before, nodes: g.nodes.length };
    };
    const small = work(4), large = work(8);
    expect(large.nodes).toBeGreaterThan(small.nodes * 3);
    // The old search made and filled arrays of every node: `nodes`.
    expect(small.touched).toBeLessThan(small.nodes / 2);
    expect(large.touched).toBeLessThanOrEqual(small.touched * 1.25);
  });
});

// ------------------------------------------------------------ the camera

describe('the walkers step the same wherever the camera is', () => {
  it('two worlds with the camera elsewhere are the same after 200 ticks', () => {
    const state = (focus: SimWorld['focus']): string => {
      const w = worldOf(grid(3));
      populate(w);
      w.focus = focus;
      run(w, 200);
      return JSON.stringify(inspectAgentWalkers(w));
    };
    const none = state(null);
    expect(state({ x: m(5000), y: m(5000), r: m(10), detail: false, view: null })).toBe(none);
    expect(state({ x: 0, y: 0, r: m(40), detail: false, view: null })).toBe(none);
  });
});

// ------------------------------------------------------------ seats

describe('a seat emptied or taken leaves no hole', () => {
  it('a passenger set down and somebody picked up into a back seat', () => {
    const w = worldOf(grid(1));
    const lane = [...w.graph.lanelets.values()][0]!;
    const arch = ARCHETYPES.find((a) => a.doorsPerSide >= 2)!;
    const v = createVehicle(9001 as VehicleId, arch, makeDriver(arch, () => 0.5), '#fff', lane.id, 0, 0);
    v.s = lane.length / 2;
    w.vehicles.set(v.id, v);
    const task = (kind: 'drop' | 'pick', seat: number): KerbStop => ({ kind, lanelet: lane.id, at: v.s, door: seat, seat, phase: 'transfer', t: 0,
      elapsed: 0, pedId: null, person: null, transferTime: 0, fetchTime: 0, walked: 0, keep: false, hold: 0, seatStage: true });
    v.people = [11, 12, 13, 14];
    v.peopleAge = ['adult', 'adult', 'adult', 'adult'];
    v.kerbStop = task('drop', 2);
    stepKerbStops(w);
    expect(2 in v.people).toBe(true);
    expect(2 in v.peopleAge).toBe(true);
    expect(v.people[2]).toBeUndefined();
    expect(seatPerson(v, 2).seed).not.toBe(13);

    const other = createVehicle(9002 as VehicleId, arch, makeDriver(arch, () => 0.5), '#fff', lane.id, 0, 0);
    other.s = lane.length / 2;
    w.vehicles.set(other.id, other);
    other.kerbStop = { ...task('pick', 3), person: { seed: 77, gender: 'f', ageClass: 'adult', footX: 0, footY: 0, footHeading: 0 } };
    stepKerbStops(w);
    expect(other.people[3]).toBe(77);
    expect([0, 1, 2].every((i) => i in other.people && i in other.peopleAge)).toBe(true);
  });
});
