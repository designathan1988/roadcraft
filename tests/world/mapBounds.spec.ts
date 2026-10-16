import { describe, expect, it } from 'vitest';

import { buildStreamTile } from '@editor/wholeMapTile';
import { MAP_HALF, MAP_TILES, WHOLE_MAP_DEFAULTS, clampToMap, gatesOf, onMap, planWholeMap, tileOnMap } from '@world/cityGen/wholeMap';
import { DEFAULT_CITY } from '@world/cityGen/plan';
import { RoadDoc, type TileRecords } from '@world/doc';
import { TILE, tileKey, tileOfKey } from '@world/tiles';
import { WorldStreamer } from '@/worldStreamer';

/** THE MAP HAS AN EDGE: 10 km x 10 km, the city over the whole of it, nothing past it (`wholeMap.ts` MAP_TILES) */

const { size: _size, radius: _radius, ...base } = DEFAULT_CITY;
const options = { ...base, ...WHOLE_MAP_DEFAULTS, seed: 1 };

describe('the map of 10 km', () => {
  it('is 10 tiles each way round the origin', () => {
    expect(MAP_TILES).toBe(10);
    expect(MAP_HALF).toBe(5 * TILE);
    expect(tileOnMap(-5, -5)).toBe(true);
    expect(tileOnMap(4, 4)).toBe(true);
    expect(tileOnMap(5, 0)).toBe(false);
    expect(tileOnMap(0, -6)).toBe(false);
    expect(onMap(MAP_HALF - 1, -MAP_HALF)).toBe(true);
    expect(onMap(MAP_HALF, 0)).toBe(false);
    expect(clampToMap(MAP_HALF * 3, -MAP_HALF * 2)).toEqual({ x: MAP_HALF, y: -MAP_HALF });
  });

  it('is built up everywhere on it, and open country with no street past it', () => {
    const plan = planWholeMap(options);
    for (const [x, y] of [[0, 0], [MAP_HALF - 100, MAP_HALF - 100], [-MAP_HALF + 50, 2000], [3000, -MAP_HALF + 50]]) {
      expect(plan.heatAt(x!, y!)).toBeGreaterThan(0.24);
      expect(plan.tile(Math.floor(x! / TILE), Math.floor(y! / TILE)).kind).not.toBe('rural');
    }
    expect(plan.heatAt(MAP_HALF + 10, 0)).toBe(0);
    expect(plan.tile(5, 0).kind).toBe('rural');
    expect(plan.zoneAt({ x: -MAP_HALF - 10, y: 0 }, true)).toBe('park');
    // No gate on the map's edge lines nor beyond: a street never leaves the map.
    expect(gatesOf(1, 0, 5)).toEqual([]);
    expect(gatesOf(1, 1, -5)).toEqual([]);
    expect(gatesOf(1, 0, -6)).toEqual([]);
    expect(gatesOf(1, 0, 0).length).toBeGreaterThan(0);
  });

  it('a tile past the edge is empty', () => {
    const t = buildStreamTile(options, 5, 2);
    expect(t.key).toBe(tileKey(5, 2));
    expect(t.nodes).toEqual([]);
    expect(t.segments).toEqual([]);
    expect(t.buildings).toEqual([]);
    expect(t.lots).toEqual([]);
  });

  it('the streamer never asks for a tile past the edge', async () => {
    const asked: number[] = [];
    const empty = (key: number): TileRecords => buildStreamTile(options, 99, 99) && { ...buildStreamTile(options, 99, 99), key };
    const source = {
      load: (key: number) => { asked.push(key); return Promise.resolve(empty(key)); },
      ensure: (key: number) => { asked.push(key); return Promise.resolve(1); },
      write: () => Promise.resolve(1),
    };
    const streamer = new WorldStreamer(new RoadDoc(), source, {}, 9);
    streamer.focus(MAP_HALF - 10, MAP_HALF - 10);
    for (let k = 0; k < 20; k++) { await Promise.resolve(); streamer.apply(k * 100); }
    expect(asked.length).toBeGreaterThan(0);
    for (const key of asked) { const { i, j } = tileOfKey(key); expect(tileOnMap(i, j), `tile ${i},${j}`).toBe(true); }
  });
});
