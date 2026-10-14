import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m, stepsIn } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { growOnLot } from '@editor/zoning';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { createAgentWalkEngine } from '@sim/agents/walk';
import type { Bay } from '@sim/agents/parking';
import type { Vehicle } from '@sim/vehicles/state';

/**
 * The lots' traffic asks the scenery who stands where (`AmbientWorld.isParked`,
 * `sceneryCarAt`) instead of walking every parked car of the map: the same
 * answers as the walks it replaced, copied here as the oracle, every tick of
 * a closed town whose lots send cars in and out, with buildings taken away
 * and put back on the way.
 */

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
  cars: Map<number, { bay: Bay; body: Vehicle | null }>;
  bays: Bay[];
  freeBays(w: SimWorld): Bay[];
  sceneryInBays(w: SimWorld): { bay: Bay; body: Vehicle }[];
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
      // The free bays: the old walk over every parked car (the oracle).
      const taken = new Set<string>();
      for (const car of parked) if (car.free) taken.add(bayKey(car.free));
      for (const car of lots.cars.values()) taken.add(bayKey(car.bay));
      const oldFree = lots.bays.filter((b) => !taken.has(bayKey(b)));
      expect(lots.freeBays(w)).toEqual(oldFree);
      freeSeen += oldFree.length;
      // The scenery's cars in gated bays: the old walk over every parked car (the oracle).
      const byKey = new Map(lots.bays.map((b) => [bayKey(b), b] as const));
      const oldPool: { bay: Bay; body: Vehicle }[] = [];
      for (const body of parked) {
        if (!body.free || lots.cars.has(body.id)) continue;
        const bay = byKey.get(bayKey(body.free));
        if (bay) oldPool.push({ bay, body });
      }
      expect(lots.sceneryInBays(w)).toEqual(oldPool);
      sceneryPooled += oldPool.length;
      checked++;
    }
    expect(checked).toBeGreaterThan(400);
    // The lots did work: cars of theirs off the road, bays free, scenery cars to send out.
    expect(bodies).toBeGreaterThan(0);
    expect(freeSeen).toBeGreaterThan(0);
    expect(sceneryPooled).toBeGreaterThan(0);
  }, 10_000);
});
