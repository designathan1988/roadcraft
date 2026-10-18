import { describe, expect, it } from 'vitest';
import { SimClient } from '@sim/host/simClient';
import type { FromSim, SimStats } from '@sim/host/protocol';
import { RoadDoc } from '@world/doc';
import type { NodeId } from '@world/ids';

/** THE SIGNALS' FEED ACROSS ANOTHER MAP (`SimClient.load`): a reader of the map before places every junction again (null), never "nothing changed" - the heads of the city left behind stood on the grass of a new empty map (2026-10-18) */

type Inside = { receive(message: FromSim): void };
const inside = (client: SimClient): Inside => client as unknown as Inside;

/** A tick telling the junctions' layout (every junction told: `all`). */
function layout(client: SimClient, nodes: readonly number[]): void {
  const stats = { issues: [] } as unknown as SimStats;
  const junctions = nodes.map((node) => ({ node: node as NodeId, groups: [{ id: 0 }] }));
  inside(client).receive({ type: 'tick', slot: 0, vehicles: [], peds: [], signals: [], layout: { all: true, junctions }, trains: [], parked: null, stats, wounds: [], casualties: [] } as unknown as FromSim);
}

describe("the signals' feed", () => {
  it('tells a reader of the map before another map is loaded to place every junction again', () => {
    const client = new SimClient(new RoadDoc());
    layout(client, [5, 9]);
    // The heads' reader, up to date with the old map.
    const read = client.signals.changesSince(0).serial;
    expect([...client.signals.nodes()]).toEqual([5, 9]);
    // Another map: the simulation starts over with no junction.
    client.load();
    expect([...client.signals.nodes()]).toEqual([]);
    expect(client.signals.changesSince(read).nodes).toBeNull();
  });
});
