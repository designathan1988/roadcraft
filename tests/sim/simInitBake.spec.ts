import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimClient } from '@sim/host/simClient';
import { SimHost } from '@sim/host/simHost';
import { type ToSim, makeSharedFrames } from '@sim/host/protocol';
import { trafficMapOf } from '@sim/agents/trafficBuildings';
import { RoadDoc } from '@world/doc';
import type { NodeId } from '@world/ids';
import { Network, type NetworkBake } from '@world/network';
import { networkWork } from '@world/rebuildWork';
import { m } from '@world/units';

/** SIM-04: the worker takes the page's junctions and ribbons as solved when the map opens, and builds the same network. */

function grid(n: number, side: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: NodeId[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: i * side, y: j * side }).id);
  }
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    if (i < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, (i + j) % 3 === 0 ? 3 : 1);
    if (j < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, 1);
  }
  return doc;
}

/** A worker that keeps what it is sent. */
class KeptWorker {
  static last: KeptWorker | null = null;
  readonly sent: ToSim[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  constructor() { KeptWorker.last = this; }
  postMessage(message: ToSim): void { this.sent.push(message); }
  terminate(): void {}
}

afterEach(() => { vi.unstubAllGlobals(); KeptWorker.last = null; });

async function opened(doc: RoadDoc, bake: NetworkBake | null): Promise<{ net: Network; solved: number }> {
  const host = new SimHost(() => {});
  const before = networkWork.built;
  await host.handle({ type: 'init', map: trafficMapOf(doc), live: [], seed: 7, zones: new Map(), frames: makeSharedFrames(), zonesPrefix: null, ambient: 'edges', bake } as ToSim);
  return { net: (host as unknown as { net: Network }).net, solved: networkWork.built - before };
}

describe("the worker's network when the map opens", () => {
  it("takes the page's junctions as solved, and is the network it would have solved", async () => {
    const doc = grid(4, m(140));
    const page = new Network(doc);
    page.rebuild();

    vi.stubGlobal('Worker', KeptWorker);
    const client = new SimClient(doc, page);
    void client.start(7, new Map(), null, 'edges');
    const init = KeptWorker.last!.sent.find((message) => message.type === 'init') as Extract<ToSim, { type: 'init' }>;
    expect(init.bake?.nodes.length).toBe(doc.nodes.size);

    const solvedHere = await opened(doc, null);
    const taken = await opened(doc, structuredClone(init.bake!));
    expect(solvedHere.solved).toBeGreaterThanOrEqual(doc.nodes.size);
    // Before: every junction of the map solved again in the worker.
    expect(taken.solved).toBe(0);
    const all = (net: Network): NetworkBake => net.exportBake(doc.nodes.keys(), doc.segments.keys());
    expect(all(taken.net)).toEqual(all(solvedHere.net));
  }, 60_000);
});
