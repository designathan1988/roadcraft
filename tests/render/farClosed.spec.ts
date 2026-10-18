import { describe, expect, it } from 'vitest';
import { FarLevels, type FarRun } from '@render/buildings/farLevels';
import { type FarCache, emptyRecords, nodeSide, runFarJob } from '@render/buildings/farTiles';
import { createBuildingKit } from '@render/buildings/kit';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { WHOLE_MAP_DEFAULTS, type WholeMapOptions } from '@world/cityGen/wholeMap';
import { TILE, tileKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { m } from '@world/units';

/** THE FAR LEVELS OF A WORLD CLOSED ("new map", `main.ts` afterStreamedWorld: `setSource(null)`): nothing of it waited for - the curtain of the empty map stood to its 90 s limit, the old world's tiles in view never to be baked (2026-10-18) */

const OPTIONS: WholeMapOptions = { ...WHOLE_MAP_DEFAULTS, seed: 7, density: 0.6, industry: true };

function memoryCache(): FarCache {
  const kept = new Map<string, unknown>();
  return {
    ready: () => Promise.resolve(true),
    get: (key) => Promise.resolve(kept.get(key)),
    put: (key, value) => { kept.set(key, structuredClone(value)); return Promise.resolve(); },
  };
}

const runner = (cache: FarCache): FarRun => (job, done) => {
  let live = true;
  void runFarJob(job, cache).then((reply) => { if (live) done(reply); });
  return () => { live = false; };
};

/** Turns of the task queue until `done` holds (no time waited); false when it never did. */
async function settles(look: () => void, done: () => boolean, turns = 400): Promise<boolean> {
  for (let turn = 0; turn < turns; turn++) {
    look();
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return false;
}

describe('the far levels of a world closed', () => {
  it('wait for nothing of it: its tiles let go with it', async () => {
    const far = new FarLevels(createBuildingKit(), runner(memoryCache()), 'test:');
    const tiles = new Map<number, TileRecords>();
    far.setSource({ records: (key) => Promise.resolve(tiles.get(key) ?? null), plan: OPTIONS }, () => false);
    const look = (): void => far.choose(0.5 * nodeSide(2), 0.5 * nodeSide(2), m(2_000), 150, null, m(6_000));
    // The world's tiles in view, stored and drawn.
    for (let n = 0; n < 2; n++) {
      const key = tileKey(n, 0);
      const body = JSON.parse(JSON.stringify(BLUEPRINTS[0]!.body)) as Building;
      tiles.set(key, { ...emptyRecords(key, 1), buildings: [{ ...body, id: 1, x: (n + 0.5) * TILE, y: 0.5 * TILE, rotation: 0 } as unknown] });
      far.stored(key, 1);
    }
    expect(await settles(look, () => far.waiting === 0), 'the open world drawn').toBe(true);
    // The world closed: no source, no plan; nothing it had is waited for, nothing of it is drawn.
    far.setSource(null, () => false);
    expect(await settles(look, () => far.waiting === 0, 20), 'nothing waited for once closed').toBe(true);
    expect(far.shownKeys()).toEqual([]);
  });
});
