import { describe, expect, it } from 'vitest';
import { SimClient } from '@sim/host/simClient';
import { SimHost } from '@sim/host/simHost';
import { type FromSim, type ToSim, makeSharedFrames } from '@sim/host/protocol';
import { trafficMapOf } from '@sim/agents/trafficBuildings';
import { RoadDoc } from '@world/doc';
import type { NodeId } from '@world/ids';
import { Network } from '@world/network';
import { applyLots, planLots } from '@world/lots';
import { m } from '@world/units';

/** THE ZONING TOOL'S PROPOSAL PLANNED IN THE SIMULATION'S WORKER (`SimHost.lotPlan`): the same plan as the page's planner would make, for the same land and the same edits */

/** A grid of streets `n` x `n` blocks of `side`. */
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

/** The page's client and the worker's host in one thread, each message handled in order. */
async function wired(doc: RoadDoc): Promise<SimClient> {
  const client = new SimClient(doc);
  let chain = Promise.resolve();
  const host = new SimHost((message: FromSim) => (client as unknown as { receive(m: FromSim): void }).receive(message));
  await host.handle({ type: 'init', map: trafficMapOf(new RoadDoc()), seed: 7, zones: new Map(), frames: makeSharedFrames(), zonesPrefix: null, ambient: 'edges' } as ToSim);
  (client as unknown as { worker: { postMessage(message: ToSim): void } }).worker = {
    postMessage: (message) => { chain = chain.then(() => host.handle(message)); },
  };
  return client;
}

/** A plan as compared: its lots' keys and corners, its keys and their places, the lots it drops. */
const shape = (plan: ReturnType<typeof planLots> | null): unknown => plan && ({ add: plan.add, keys: plan.keys, keyRects: plan.keyRects, drop: plan.drop });

describe("the proposed lots planned in the simulation's worker", () => {
  it("are the page's plan for the same land, and again after a road and lots are laid", async () => {
    const doc = grid(4, m(120));
    const net = new Network(doc);
    net.rebuild();
    const client = await wired(doc);
    const worker = await client.lotPlan();
    const page = planLots(doc, net);
    expect(page.add.length).toBeGreaterThan(20);
    expect(shape(worker)).toEqual(shape(page));
    // A street across a block, and some of the proposal laid: the worker's planner follows the diary, as the page's does.
    const a = doc.addNode({ x: m(60), y: m(0) }).id, b = doc.addNode({ x: m(60), y: m(120) }).id;
    doc.addSegment(a, b, 1);
    net.rebuild();
    applyLots(doc, { add: page.add.slice(0, 5), keys: [], drop: [] });
    const again = planLots(doc, net);
    expect(shape(await client.lotPlan())).toEqual(shape(again));
  });
});
