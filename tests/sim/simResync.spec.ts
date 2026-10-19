import { describe, expect, it } from 'vitest';
import { SimClient } from '@sim/host/simClient';
import { SimHost } from '@sim/host/simHost';
import { type ToSim, makeSharedFrames } from '@sim/host/protocol';
import { trafficMapOf } from '@sim/agents/trafficBuildings';
import type { SimWorld } from '@sim/world';
import { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { m } from '@world/units';
import type { LaneletId } from '@world/lanelets';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { makeDriver } from '@sim/vehicles/driver';
import { createVehicle } from '@sim/vehicles/state';

/** SIM-18: the same map sent whole again (a change the diary cannot name) brings the worker's copy up to it and keeps its traffic; only another map starts it over. */

function grid(n: number, side: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: NodeId[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: i * side, y: j * side }).id);
  }
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    if (i < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, 1);
    if (j < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, 1);
  }
  return doc;
}

describe('the same map sent again', () => {
  it('is a resync, not another map, when the buildings change without saying which: the views kept', () => {
    const doc = grid(2, m(120));
    const client = new SimClient(doc);
    const sent: ToSim[] = [];
    const inner = client as unknown as { worker: { postMessage(message: ToSim): void }; markSent(): void; vehicles: Map<number, unknown> };
    inner.worker = { postMessage: (message) => { sent.push(message); } };
    inner.markSent();
    inner.vehicles.set(7, {});
    // A whole store of buildings loaded: the diary's entry names none.
    doc.buildings.load([]);
    client.frame(1 / 60, false, { traffic: true, pedestrians: true, maxShare: 1 });
    const types = sent.map((message) => message.type);
    expect(types).toContain('resync');
    expect(types).not.toContain('load');
    // Before: the views cleared, the city emptied and filled again.
    expect(inner.vehicles.has(7)).toBe(true);
  });

  it("brings the worker's copy up to it and keeps its traffic driving", async () => {
    const doc = grid(3, m(150));
    const host = new SimHost(() => {});
    await host.handle({ type: 'init', map: trafficMapOf(doc), live: [], seed: 7, zones: new Map(), frames: makeSharedFrames(), zonesPrefix: null, ambient: 'edges' } as ToSim);
    const inner = host as unknown as { sim: SimWorld; doc: RoadDoc };
    // A car of the city as it stands (put straight into the worker's world).
    const archetype = ARCHETYPES.find((x) => x.id === 'hatch')!;
    const car = createVehicle(41, archetype, makeDriver(archetype, () => 0.5), '#ffffff', 'lane' as LaneletId, 10, 0);
    inner.sim.vehicles.set(car.id, car);

    // A road taken out on the page; the worker hears of it only as the whole map again.
    const gone = [...doc.segments.keys()].at(-1)! as SegmentId;
    doc.removeSegment(gone);
    await host.handle({ type: 'resync', map: trafficMapOf(doc), live: [] } as ToSim);
    expect(inner.doc.segments.has(gone)).toBe(false);
    expect(inner.doc.segments.size).toBe(doc.segments.size);
    // Before: another map's load, every vehicle gone.
    expect(inner.sim.vehicles.get(car.id)).toBe(car);
  }, 60_000);
});
