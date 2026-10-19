import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { laneletId } from '@world/lanelets';
import { SimWorld } from '@sim/world';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { makeDriver } from '@sim/vehicles/driver';
import { createVehicle } from '@sim/vehicles/state';
import { integrateAll } from '@sim/vehicles/integrate';
import { RouteIndex } from '@sim/routing/routeIndex';

/** SIM-02: a lane change files the route `planFrom` plans, once; not first the one-lane route it starts from. */
describe('the route a lane change files', () => {
  it('is filed once, as planned', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: -600 });
    const b = doc.addNode({ x: 0, y: 0 });
    const c = doc.addNode({ x: 0, y: 600 });
    const seg = doc.addSegment(a.id, b.id, 3)!;
    doc.addSegment(b.id, c.id, 3);
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x4812);
    sim.rebuildTopology();
    const lane = (k: number) => laneletId(seg.id, a.id, b.id, k);
    const goal = sim.graph.exitsOf(lane(1)).map((id) => sim.connector(id)!.toLane)[0]!;

    const archetype = ARCHETYPES.find((x) => x.id === 'hatch')!;
    const v = createVehicle(1, archetype, makeDriver(archetype, () => 0.5), '#ffffff', lane(0), 10, 0);
    v.s = 40;
    v.v = 10;
    v.destination = goal;
    sim.vehicles.set(v.id, v);
    sim.enterLanelet(v, lane(0));
    v.route = [lane(0)];
    sim.noteRoute(v);
    v.laneChange = lane(1);

    const filed: string[][] = [];
    const original = RouteIndex.prototype.file;
    RouteIndex.prototype.file = function (this: RouteIndex<{ readonly route: readonly string[] }>, x) {
      filed.push([...x.route]);
      original.call(this, x);
    };
    try {
      integrateAll(sim);
    } finally {
      RouteIndex.prototype.file = original;
    }
    expect(v.lanelet).toBe(lane(1));
    expect(v.route.length).toBeGreaterThanOrEqual(3);
    // Before: [lane(1)] filed, then the plan filed over it.
    expect(filed).toEqual([v.route]);
    expect(sim.routes.routing(v.route[1]!)?.has(v)).toBe(true);
    expect(sim.routes.routing(lane(0))?.has(v) ?? false).toBe(false);
  });
});
