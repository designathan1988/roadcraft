import { describe, expect, it } from 'vitest';
import { SimClient } from '@sim/host/simClient';
import { H, V, VEHICLE_STRIDE, headBase, vehicleBase, type FromSim, type SimStats } from '@sim/host/protocol';
import { RoadDoc } from '@world/doc';

/** THE PAGE READS THE WORKER'S FRAME (`SimClient.readTick`): each vehicle's view kept from tick to tick and written in place, those not in a tick let go */

type Inside = { receive(message: FromSim): void; readonly data: Float64Array };
const inside = (client: SimClient): Inside => client as unknown as Inside;

/** A vehicle's numbers in the slot: where it is, and off the road (1) or on a lane (0). */
interface Written { readonly id: number; readonly x: number; readonly y: number; readonly free: 0 | 1; readonly lot?: number }

/** A tick written into slot 0 (the slot `C.latest` names while nothing else is), then told. */
function tick(client: SimClient, vehicles: readonly Written[]): void {
  const data = inside(client).data;
  data[headBase(0) + H.vehicles] = vehicles.length;
  data[headBase(0) + H.peds] = 0;
  vehicles.forEach((v, k) => {
    const at = vehicleBase(0) + k * VEHICLE_STRIDE;
    data.fill(0, at, at + VEHICLE_STRIDE);
    data[at + V.id] = v.id;
    data[at + V.free] = v.free;
    data[at + V.bx] = v.x; data[at + V.by] = v.y; data[at + V.x] = v.x; data[at + V.y] = v.y;
    data[at + V.segment] = -1; data[at + V.inSegment] = -1; data[at + V.lot] = v.lot ?? -1;
  });
  const stats = { issues: [] } as unknown as SimStats;
  inside(client).receive({ type: 'tick', slot: 0, vehicles: [], peds: [], signals: [], layout: null, trains: [], parked: null, stats, wounds: [], casualties: [] });
}

describe("the page's reading of the fleet", () => {
  it('keeps each view and its pose off the road from tick to tick, written in place', () => {
    const client = new SimClient(new RoadDoc());
    tick(client, [{ id: 1, x: 5, y: 6, free: 1, lot: 3 }, { id: 2, x: 50, y: 0, free: 0 }]);
    expect(client.traffic.map((v) => v.id)).toEqual([1, 2]);
    const one = client.vehicles.get(1)!;
    const pose = one.free!;
    expect(pose).toMatchObject({ x: 5, y: 6, lot: 3 });
    expect(client.vehicles.get(2)!.free).toBeNull();
    // Moved on: the same view, the same pose object with the new numbers.
    tick(client, [{ id: 1, x: 7, y: 6, free: 1 }, { id: 2, x: 52, y: 0, free: 0 }]);
    expect(client.vehicles.get(1)).toBe(one);
    expect(one.free).toBe(pose);
    expect(pose).toMatchObject({ x: 7, y: 6, lot: null });
    // Back on a lane: no pose off the road.
    tick(client, [{ id: 1, x: 9, y: 6, free: 0 }, { id: 2, x: 54, y: 0, free: 0 }]);
    expect(one.free).toBeNull();
  });

  it('lets go the views not read in a tick, and only those', () => {
    const client = new SimClient(new RoadDoc());
    tick(client, [{ id: 1, x: 0, y: 0, free: 0 }, { id: 2, x: 10, y: 0, free: 0 }, { id: 3, x: 20, y: 0, free: 0 }]);
    const two = client.vehicles.get(2)!;
    const fleet = client.fleet;
    // Vehicle 1 gone, 4 come: 2 and 3 kept as they were.
    tick(client, [{ id: 2, x: 11, y: 0, free: 0 }, { id: 3, x: 21, y: 0, free: 0 }, { id: 4, x: 30, y: 0, free: 0 }]);
    expect([...client.vehicles.keys()].sort()).toEqual([2, 3, 4]);
    expect(client.vehicles.get(2)).toBe(two);
    expect(client.fleet).toBe(fleet + 2);
    expect(client.vehiclesIn({ x0: -5, y0: -5, x1: 5, y1: 5 }, [])).toEqual([]);
    // The same vehicles again: none let go.
    tick(client, [{ id: 2, x: 12, y: 0, free: 0 }, { id: 3, x: 22, y: 0, free: 0 }, { id: 4, x: 31, y: 0, free: 0 }]);
    expect(client.vehicles.size).toBe(3);
    expect(client.fleet).toBe(fleet + 2);
    // All gone.
    tick(client, []);
    expect(client.vehicles.size).toBe(0);
    expect(client.traffic).toEqual([]);
  });
});
