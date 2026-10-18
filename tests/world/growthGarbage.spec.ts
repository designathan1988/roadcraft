import { Session } from 'node:inspector';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CITY } from '@world/cityGen/plan';
import { WHOLE_MAP_DEFAULTS, type WholeMapOptions } from '@world/cityGen/wholeMap';
import { buildStreamTilePair } from '@editor/wholeMapTile';

/** A DENSE TILE'S BUILDINGS GROWN WITHOUT THROWAWAY COPIES: no deep clone of a try's parts, no boolean cut of a surface already inside its lot, no heap number a pair of lot parts (the workers' transient garbage that took the 20 km over the V8 cage, 2026-10-18) */

const { size: _size, radius: _radius, ...base } = DEFAULT_CITY;
const options: WholeMapOptions = { ...base, ...WHOLE_MAP_DEFAULTS, seed: 1 };

interface Sampled { readonly callFrame: { readonly functionName: string; readonly url: string }; readonly selfSize: number; readonly children: readonly Sampled[] }

describe("a dense tile's growth", () => {
  it('allocates no deep copy a try, no cut of a surface inside its lot, no number a pair of parts', async () => {
    // Warmed on the tile itself: an interpreted function boxes every number, the steady state does not.
    buildStreamTilePair(options, 4, 4);
    const session = new Session();
    session.connect();
    const post = (method: string, params?: object): Promise<{ profile?: { head: Sampled } }> => new Promise((ok, no) => session.post(method, params ?? {}, (e, r) => (e ? no(e) : ok(r as { profile?: { head: Sampled } }))));
    await post('HeapProfiler.startSampling', { samplingInterval: 32_768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    buildStreamTilePair(options, 4, 4);
    const { profile } = await post('HeapProfiler.stopSampling');
    session.disconnect();
    // Bytes under a function of the growth (built-ins under it counted too).
    const under = new Map<string, number>();
    const walk = (node: Sampled, stack: readonly string[]): void => {
      const here = node.callFrame.url ? [...stack, node.callFrame.functionName] : stack;
      for (const name of new Set(here)) under.set(name, (under.get(name) ?? 0) + node.selfSize);
      if (!node.callFrame.url) under.set(`${node.callFrame.functionName} < ${stack.at(-1)}`, (under.get(`${node.callFrame.functionName} < ${stack.at(-1)}`) ?? 0) + node.selfSize);
      for (const child of node.children) walk(child, here);
    };
    walk(profile!.head, []);
    const mb = (key: string): number => (under.get(key) ?? 0) / 1e6;
    // Before: ~44 MB of clones, ~37 MB of hypot's numbers, ~330 MB under `fitToLot` (clipper's cut of every surface).
    expect(mb('structuredClone')).toBe(0);
    expect(mb('hypot < fits') + mb('hypot < put') + mb('hypot < near')).toBeLessThan(12);
    expect(mb('fitToLot')).toBeLessThan(150);
  }, 10_000);
});
