import { Session } from 'node:inspector';
import { describe, expect, it } from 'vitest';
import { SimHost } from '@sim/host/simHost';
import { makeSharedFrames, type ToSim } from '@sim/host/protocol';
import { trafficMapOf } from '@sim/agents/trafficBuildings';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/** THE MESO'S STEPS MAKE NO GARBAGE A LINK: its links stepped from typed arrays, no number handed back by a call, no map or pair a cell a step (the 20 km's sim worker, ~1 GB between collections with ~400 tiles in reach, sim20a, 2026-10-18) */

/** A grid of `n` x `n` two-way streets 60 m apart, on the page's own document (the lane graph's links). */
function grid(n: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i < n; i++) {
    ids.push([]);
    for (let j = 0; j < n; j++) ids[i]!.push(doc.addNode({ x: m(40 + 60 * i), y: m(40 + 60 * j) }).id);
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i < n - 1) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n - 1) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  return doc;
}

describe("the meso's steps", () => {
  it('allocate nothing a link: the bytes the meso and its model allocate a frame stay under a link\'s worth', async () => {
    const host = new SimHost(() => {});
    await host.handle({ type: 'init', map: trafficMapOf(grid(24)), seed: 7, zones: new Map(), frames: makeSharedFrames(), zonesPrefix: null, ambient: 'edges' } as ToSim);
    const controls = { speed: 1, paused: false, traffic: true, pedestrians: false, trafficIntensity: 1, pedestrianIntensity: 1, demandMultiplier: 1, maxShare: 1, focus: null };
    const frames = async (n: number): Promise<void> => { for (let f = 0; f < n; f++) await host.handle({ type: 'frame', wall: 0.05, hold: false, controls } as ToSim); };
    // Warmed until the steps are compiled: an interpreted step boxes every number, the steady state does not.
    await frames(20_000);
    const links = (host as unknown as { meso: { model: { slots: number } } }).meso.model.slots;
    expect(links).toBeGreaterThan(2000);
    const session = new Session();
    session.connect();
    const post = (method: string, params?: object): Promise<{ profile?: { head: Sampled } }> => new Promise((ok, no) => session.post(method, params ?? {}, (e, r) => (e ? no(e) : ok(r as { profile?: { head: Sampled } }))));
    await post('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const n = 300;
    await frames(n);
    const { profile } = await post('HeapProfiler.stopSampling');
    session.disconnect();
    // The bytes allocated in the meso's and its model's own functions (a built-in's under them counted too).
    let meso = 0;
    const walk = (node: Sampled, inMeso: boolean): void => {
      const file = node.callFrame.url.split('/').pop() ?? '';
      const here = file.startsWith('meso.ts') || file.startsWith('model.ts') || (!node.callFrame.url && inMeso);
      if (here) meso += node.selfSize;
      for (const child of node.children) walk(child, here);
    };
    walk(profile!.head, false);
    expect(meso / n).toBeLessThan(links * 0.5);
  });
});

interface Sampled { readonly callFrame: { readonly url: string }; readonly selfSize: number; readonly children: readonly Sampled[] }
