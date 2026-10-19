import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { laneletId } from '@world/lanelets';
import { SimWorld } from '@sim/world';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { makeDriver } from '@sim/vehicles/driver';
import { createVehicle } from '@sim/vehicles/state';
import { stepLaneChange } from '@sim/vehicles/laneChange';

/** SIM-12: a queue waiting for a gap works each lane's resting rears out once a stage, not once for every vehicle in it. */
describe('the resting rears of a queue', () => {
  it('are walked once a lane, not once a vehicle', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: -1500 });
    const b = doc.addNode({ x: 0, y: 1500 });
    const seg = doc.addSegment(a.id, b.id, 3)!;
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x12);
    sim.rebuildTopology();
    const lane = (k: number) => laneletId(seg.id, a.id, b.id, k);
    const archetype = ARCHETYPES.find((x) => x.id === 'hatch')!;
    const n = 80;
    let id = 1;
    for (const k of [0, 1]) {
      for (let i = 0; i < n; i++) {
        const v = createVehicle(id++, archetype, makeDriver(archetype, () => 0.5), '#ffffff', lane(k), 10, 0);
        v.s = 100 + i * 7 + k * 3;
        v.v = 0;
        v.age = 30;
        // Every car in the near lane wants the far one, signalling long enough to move as soon as there is room.
        if (k === 0) { v.desiredLane = lane(1); v.laneIntent = lane(1); v.laneIntentSince = 0; }
        sim.vehicles.set(v.id, v);
        sim.enterLanelet(v, lane(k));
      }
    }

    let reads = 0;
    const veh = sim.veh.bind(sim);
    sim.veh = (x) => { reads++; return veh(x); };
    stepLaneChange(sim);
    // Before: each of the 80 walked its own lane from the head down to itself, about n²/2 reads.
    expect(reads).toBeLessThan(n * 12);
    // No gap in a queue packed this tight.
    expect([...sim.vehicles.values()].filter((v) => v.laneChange !== null)).toEqual([]);
  });
});
