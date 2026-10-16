import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m, stepsIn } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { growOnLot } from '@world/growth/zoning';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { createAgentWalkEngine } from '@sim/agents/walk';
import type { Bay } from '@sim/agents/parking';
import type { StandingCar, Vehicle } from '@sim/vehicles/state';
import type { WeightedSlots } from '@core/weightedSlots';
import type { SceneryCar } from '@sim/ambient/ambient';
import { Rng } from '@core/rng';
import { makeDriver } from '@sim/vehicles/driver';

/** The lots' traffic asks the scenery who stands where */

const ZONES = [
  { use: 'residential', density: 'medium' }, { use: 'commercial', density: 'low' },
  { use: 'residential', density: 'low' }, { use: 'industrial', density: 'medium' },
  { use: 'commercial', density: 'high' }, { use: 'residential', density: 'high' },
] as const;

function closedTown(): RoadDoc {
  const doc = new RoadDoc();
  const n = 2, block = 120;
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
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l, k) => zoneLots(doc, [l.id], ZONES[k % ZONES.length]!));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return doc;
}

const bayKey = (b: { x: number; y: number }): string => `${Math.round(stepsIn(b.x, 0.1))},${Math.round(stepsIn(b.y, 0.1))}`;

/** The lots' traffic's own state, read for the oracle. */
interface LotsInside {
  cars: Map<number, { bay: Bay; body: Vehicle | null; phase: string; go: boolean; until: number; slot: number }>;
  active: Set<unknown>;
  comingCount: number;
  movingCount: number;
  movingIn: Map<number, number>;
  leftBy: number;
  time: number;
  bays: Map<number, { bay: Bay; key: number; slot: number }>;
  free: WeightedSlots;
  scenery: WeightedSlots;
  waiting: WeightedSlots;
  holdLorries(hold: boolean): void;
  ripen(w: SimWorld): void;
}

describe('the cars standing in bays, asked by the lots', () => {
  it('answer as the walks over every parked car, tick by tick, through edits', () => {
    const doc = closedTown();
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x0be9);
    w.rebuildTopology();
    w.usePedestrianEngine(createAgentWalkEngine());
    w.driveModel = 'v2';
    w.trafficCount = 40;
    w.pedestrianCount = 20;
    w.ambient.enabled = true;
    w.ambient.source = 'edges';
    const lots = w.city.lots as unknown as LotsInside;
    let checked = 0, bodies = 0, freeSeen = 0, sceneryPooled = 0;
    const removed: Parameters<typeof doc.buildings.restore>[1][] = [];
    const ticks = Math.round(40 / DT);
    for (let i = 0; i < ticks; i++) {
      step(w, { traffic: true, pedestrians: true });
      // More cars asked for than drive: the lots send the scenery's out of their bays.
      if (i === Math.round(3 / DT)) w.trafficCount = 90;
      // A building with a car park taken away, and later put back.
      if (i === Math.round(12 / DT) || i === Math.round(24 / DT)) {
        const b = [...doc.buildings.all()].find((x) => (x.elements ?? []).some((el) => el.kind === 'parking'));
        if (b) { removed.push(b); doc.buildings.remove(b.id); }
      }
      if (i === Math.round(32 / DT)) for (const b of removed) if (b) doc.buildings.restore(b.id, b);
      if (i % 5) continue;
      const parked = w.ambient.parked;
      // isParked: as `parked.includes`, for every car of the lots and every car standing.
      for (const car of lots.cars.values()) {
        if (!car.body) continue;
        expect(w.ambient.isParked(car.body)).toBe(parked.includes(car.body));
        bodies++;
      }
      // The free bays, as the draws see them during a look (the lorries' places held): the old walk over every parked car (the oracle).
      const gated = [...lots.bays.values()];
      const taken = new Set<string>();
      for (const car of parked) if (car.free) taken.add(bayKey(car.free));
      for (const car of lots.cars.values()) taken.add(bayKey(car.bay));
      const oldFree = gated.map((e) => e.bay).filter((b) => !taken.has(bayKey(b)));
      lots.holdLorries(true);
      expect(gated.filter((e) => lots.free.classAt(e.slot) >= 0).map((e) => e.bay)).toEqual(oldFree);
      lots.holdLorries(false);
      expect(lots.free.total()).toBe(gated.filter((e) => lots.free.classAt(e.slot) >= 0).length);
      freeSeen += oldFree.length;
      // The scenery's cars in gated bays: the old walk over every parked car (the oracle).
      const byKey = new Map(gated.map((e) => [bayKey(e.bay), e.bay] as const));
      const oldPool: { bay: Bay; body: StandingCar }[] = [];
      for (const body of parked) {
        if (!body.free || lots.cars.has(body.id)) continue;
        const bay = byKey.get(bayKey(body.free));
        if (bay) oldPool.push({ bay, body });
      }
      // In the order of the bays the list of parked cars keeps none: a car taken out of it leaves its place to the last,
      const rank = new Map(gated.map((e, i) => [e.bay, i] as const));
      oldPool.sort((p, q) => rank.get(p.bay)! - rank.get(q.bay)!);
      expect(gated.filter((e) => lots.scenery.classAt(e.slot) >= 0).map((e) => ({ bay: e.bay, body: w.ambient.sceneryCarAt(e.key) }))).toEqual(oldPool);
      sceneryPooled += oldPool.length;
      // The cars `depart` may send out: as the old filter over every car of the lots, in their order.
      lots.ripen(w);
      const oldRipe = [...lots.cars.values()].filter((c) => c.phase === 'parked' && !c.go && lots.time >= c.until && c.body);
      expect([...lots.cars.values()].filter((c) => lots.waiting.classAt(c.slot) >= 0)).toEqual(oldRipe);
      // The counts kept by each change of phase: as a count over every car; the cars stepped: all but those parked and not sent out.
      let coming = 0, moving = 0;
      const movingIn = new Map<number, number>();
      for (const car of lots.cars.values()) {
        if (car.phase === 'coming') coming++;
        if (car.phase === 'parking' || car.phase === 'leaving') { moving++; movingIn.set(car.bay.building, (movingIn.get(car.bay.building) ?? 0) + 1); }
        if (car.phase !== 'parked' || car.go) expect(lots.active.has(car)).toBe(true);
      }
      for (const car of lots.active) expect([...lots.cars.values()]).toContain(car);
      expect([lots.comingCount, lots.movingCount, [...lots.movingIn].sort()]).toEqual([coming, moving, [...movingIn].sort()]);
      checked++;
    }
    // Cars sent out of the bays still drove out (in these 40 s no car of the lots finishes parking: none rests unstepped yet).
    expect(lots.leftBy).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(400);
    // The lots did work: cars of theirs off the road, bays free, scenery cars to send out.
    expect(bodies).toBeGreaterThan(0);
    expect(freeSeen).toBeGreaterThan(0);
    expect(sceneryPooled).toBeGreaterThan(0);
  }, 10_000);

  it('are rows of the scenery\'s, never vehicles, until the lots drive one out: then the vehicle it stood for', () => {
    const doc = closedTown();
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x0be9);
    w.rebuildTopology();
    w.usePedestrianEngine(createAgentWalkEngine());
    w.trafficCount = 40;
    w.pedestrianCount = 0;
    w.ambient.enabled = true;
    w.ambient.source = 'edges';
    for (let i = 0; i < Math.round(5 / DT); i++) step(w, { traffic: true, pedestrians: true });
    const rows = w.ambient.parked.filter((car) => !w.ambient.movers.has(car as Vehicle)) as SceneryCar[];
    expect(rows.length).toBeGreaterThan(10);
    // A row holds its place and look, nothing of a vehicle's.
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['archetype', 'color', 'free', 'id', 'lanelet', 'seed', 'spot']);
    const row = rows[0]!;
    const v = w.ambient.release(w, row);
    expect([v.id, v.archetype, v.color, v.free, v.lanelet, v.seats]).toEqual([row.id, row.archetype, row.color, row.free, row.lanelet, 0]);
    // Its driver drawn as the scenery drew it with the car, before the rows: the bay's seed after the share parked, the kind and the colour.
    const r = new Rng(row.seed);
    r.float(); r.float(); r.float();
    expect(v.driver).toEqual(makeDriver(row.archetype, () => r.float()));
    expect(w.ambient.isParked(row)).toBe(false);
    expect(w.ambient.sceneryCarAt(row.spot)).toBeUndefined();
  });
});
