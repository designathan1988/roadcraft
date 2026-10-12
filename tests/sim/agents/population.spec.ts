import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { growOnLot } from '@editor/zoning';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT, JAM_GAP } from '@sim/params';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { trafficTarget } from '@sim/vehicles/spawn';

/**
 * A map opened is already lived in (the player, 2026-10-09: "sempre que abrir
 * a cidade tem que já ter carros e pessoas"): the numbers of the panel are on
 * the streets within a second, and a closed town - no road leading off the
 * map - keeps them, its lots sending cars and people out and taking them in.
 */

const ZONES = [
  { use: 'residential', density: 'medium' }, { use: 'commercial', density: 'low' },
  { use: 'residential', density: 'low' }, { use: 'industrial', density: 'medium' },
  { use: 'commercial', density: 'high' }, { use: 'residential', density: 'high' },
] as const;

/** A grid of `n` x `n` blocks, every node joined to two roads or more: no road end. */
function closedGrid(n: number, block: number, grow: boolean): RoadDoc {
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
  if (grow) {
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    doc.lots.forEach((l, k) => zoneLots(doc, [l.id], ZONES[k % ZONES.length]!));
    const refused = new Set<number>();
    for (let k = 0; k < doc.lots.length * 3; k++) {
      if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
    }
  }
  return doc;
}

/** A crossroads whose four arms lead off the map. */
function crossroads(): RoadDoc {
  const doc = new RoadDoc();
  const c = doc.addNode({ x: 0, y: 0 });
  for (const [x, y] of [[-m(160), 0], [m(160), 0], [0, -m(160)], [0, m(160)]] as const) doc.addSegment(doc.addNode({ x, y }).id, c.id, 1);
  return doc;
}

/** As the game runs it (`main.ts`): the walking engine, the scenery's life from the road ends and the lots. */
function worldOf(doc: RoadDoc, cars: number, people: number, seed = 0x0be9): SimWorld {
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, seed);
  w.rebuildTopology();
  w.usePedestrianEngine(createAgentWalkEngine());
  w.driveModel = 'v2';
  w.trafficCount = cars;
  w.pedestrianCount = people;
  w.ambient.enabled = true;
  w.ambient.source = 'edges';
  return w;
}

/** The cars the panel counts: on the lanes, and driving into or out of a lot's bay (`main.ts` updateStatus). */
const driving = (w: SimWorld): number => w.vehicles.size + w.city.lots.moving();

function run(w: SimWorld, seconds: number, each?: (t: number) => void): void {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    step(w, { traffic: true, pedestrians: true });
    each?.(i * DT);
  }
}

describe('a map opened is already lived in', () => {
  it('a closed town with no road end opens with the panel numbers and keeps them for two minutes', () => {
    const doc = closedGrid(2, 120, true);
    for (const node of doc.nodes.values()) expect(doc.degree(node.id)).toBeGreaterThan(1);
    expect(doc.buildings.size).toBeGreaterThan(8);
    const w = worldOf(doc, 40, 40);
    run(w, 1);
    expect(w.vehicles.size).toBeGreaterThanOrEqual(38);
    expect(w.pedViews.length).toBeGreaterThanOrEqual(36);
    let fewestCars = Infinity, fewestPeople = Infinity, sumCars = 0, sumPeople = 0, samples = 0;
    run(w, 120, (t) => {
      if (Math.round(t / DT) % 60 !== 0) return;
      fewestCars = Math.min(fewestCars, driving(w));
      fewestPeople = Math.min(fewestPeople, w.pedViews.length);
      sumCars += driving(w);
      sumPeople += w.pedViews.length;
      samples++;
    });
    // Held round the number: cars parking are replaced by cars leaving a lot,
    // people going in by people coming out.
    expect(fewestCars).toBeGreaterThanOrEqual(32);
    expect(fewestPeople).toBeGreaterThanOrEqual(30);
    expect(sumCars / samples).toBeGreaterThanOrEqual(36);
    expect(sumPeople / samples).toBeGreaterThanOrEqual(34);
    // And the lots made the trips: cars went in and came out of them.
    expect(w.city.lots.parkedIn).toBeGreaterThan(0);
    expect(w.city.lots.leftBy).toBeGreaterThan(0);
    expect(w.ambient.gateWalks.toGate).toBeGreaterThan(0);
    // Five minutes on: people who went in at a gate are replaced by people
    // coming out of one, and the numbers still hold.
    let laterCars = Infinity, laterPeople = Infinity, mostCars = 0;
    run(w, 300, (t) => {
      if (Math.round(t / DT) % 60 !== 0) return;
      laterCars = Math.min(laterCars, driving(w));
      mostCars = Math.max(mostCars, driving(w));
      laterPeople = Math.min(laterPeople, w.pedViews.length);
    });
    expect(w.ambient.gateWalks.fromGate).toBeGreaterThan(0);
    expect(laterCars).toBeGreaterThanOrEqual(32);
    // Nor more than asked for: the cars coming out of the lots replace those gone in.
    expect(mostCars).toBeLessThanOrEqual(44);
    expect(laterPeople).toBeGreaterThanOrEqual(30);
  }, 300_000);

  it('a map with road ends opens already lived in', () => {
    const w = worldOf(crossroads(), 30, 30);
    const want = trafficTarget(w);
    expect(want).toBe(30);
    run(w, 1);
    expect(w.vehicles.size, 'cars').toBeGreaterThanOrEqual(27);

    expect(w.pedViews.length, 'people').toBeGreaterThanOrEqual(27);
  }, 120_000);

  it('nobody is born on top of anybody', () => {
    const w = worldOf(closedGrid(2, 120, false), 120, 120);
    const seenPeople = new Set<number>();
    const seenCars = new Set<number>();
    let worstPeople = Infinity, worstCar = Infinity;
    run(w, 1.5, () => {
      // Each one as it first shows: how near the nearest other body is.
      for (const p of w.pedViews) {
        if (seenPeople.has(p.id)) continue;
        seenPeople.add(p.id);
        for (const q of w.pedViews) if (q.id !== p.id) worstPeople = Math.min(worstPeople, Math.hypot(p.x - q.x, p.y - q.y));
      }
      for (const v of w.vehicles.values()) {
        if (seenCars.has(v.id)) continue;
        seenCars.add(v.id);
        // Bumper to bumper with whatever shares its lane.
        for (const b of w.bodiesIn(v.lanelet)) {
          if (b.vehicle.id === v.id) continue;
          const gap = b.s > v.s ? b.s - b.vehicle.archetype.length - v.s : v.s - v.archetype.length - b.s;
          worstCar = Math.min(worstCar, gap);
        }
      }
    });
    expect(seenPeople.size).toBeGreaterThan(100);
    expect(worstPeople).toBeGreaterThan(m(0.5));
    expect(seenCars.size).toBeGreaterThan(100);
    expect(worstCar).toBeGreaterThanOrEqual(JAM_GAP * 0.99);
  }, 120_000);
});
