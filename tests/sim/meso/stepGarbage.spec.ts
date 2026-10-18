import { Session } from 'node:inspector';
import { describe, expect, it } from 'vitest';
import { SimHost } from '@sim/host/simHost';
import { makeSharedFrames, type ToSim } from '@sim/host/protocol';
import { trafficMapOf } from '@sim/agents/trafficBuildings';
import { RoadDoc, type TileRecords } from '@world/doc';
import { tileIdBase, tileKey } from '@world/tiles';
import { m } from '@world/units';
import { bakeTileLinks } from '@sim/meso/tileLinks';

/** THE MESO'S STEPS MAKE NO GARBAGE A LINK: its far tiles' links stepped from typed arrays, no number handed back by a call, no map or pair a cell a step (the 20 km's sim worker, ~1 GB between collections with ~400 tiles in reach, sim20a, 2026-10-18) */

type Node = TileRecords['nodes'][number];
type Segment = TileRecords['segments'][number];

/** Tile (3, 3): a grid of `n` x `n` streets 60 m apart, two-way. */
function grid(n: number): TileRecords {
  const key = tileKey(3, 3), base = tileIdBase(key), at = (gx: number, gy: number): number => base + gx * n + gy;
  const nodes: Node[] = [], segments: Segment[] = [];
  for (let gx = 0; gx < n; gx++) for (let gy = 0; gy < n; gy++) nodes.push({ id: at(gx, gy), x: 3 * 1024 * m(1) + m(40 + 60 * gx), y: 3 * 1024 * m(1) + m(40 + 60 * gy) });
  let s = base + n * n + 10;
  for (let gx = 0; gx < n; gx++) for (let gy = 0; gy < n; gy++) {
    if (gx < n - 1) segments.push({ id: s++, a: at(gx, gy), b: at(gx + 1, gy), type: 1, curve: null });
    if (gy < n - 1) segments.push({ id: s++, a: at(gx, gy), b: at(gx, gy + 1), type: 1, curve: null });
  }
  return {
    key, version: 1, nodes, borrowedNodes: [], segments, poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [], lotKeys: [],
    landscape: [], barriers: [], paint: [], trees: [], elements: [],
    next: { node: base + n * n, segment: s, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
  };
}

describe("the meso's steps", () => {
  it('allocate nothing a link: the bytes the meso and its model allocate a frame stay under a link\'s worth', async () => {
    const table = bakeTileLinks(grid(24));
    expect(table.count).toBeGreaterThan(2000);
    const host = new SimHost(() => {});
    await host.handle({ type: 'init', map: trafficMapOf(new RoadDoc()), live: [], seed: 7, zones: new Map(), frames: makeSharedFrames(), zonesPrefix: null, ambient: 'edges' } as ToSim);
    const controls = { speed: 1, paused: false, traffic: true, pedestrians: false, trafficIntensity: 1, pedestrianIntensity: 1, demandMultiplier: 1, maxShare: 1, focus: null };
    const frames = async (n: number): Promise<void> => { for (let f = 0; f < n; f++) await host.handle({ type: 'frame', wall: 0.05, hold: false, controls } as ToSim); };
    (host as unknown as { meso: { offerTable(t: unknown): void } }).meso.offerTable(table);
    // Warmed until the steps are compiled: an interpreted step boxes every number, the steady state does not.
    await frames(20_000);
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
    expect(meso / n).toBeLessThan(table.count * 0.5);
  });
});

interface Sampled { readonly callFrame: { readonly url: string }; readonly selfSize: number; readonly children: readonly Sampled[] }
