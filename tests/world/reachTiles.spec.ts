import { describe, expect, it } from 'vitest';
import { tilesInReach } from '@world/reachTiles';
import { TILE } from '@world/tiles';

/** A map of `n` tiles each way round the origin (`wholeMap.ts` tileOnMap at MAP_TILES n). */
const mapOf = (n: number) => (i: number, j: number): boolean => i >= -n / 2 && i < n / 2 && j >= -n / 2 && j < n / 2;

describe('the tiles the opening view reaches', () => {
  it('are as many on a map of 20 km as of 40 or 80: the curtain waits for the view, never the map', () => {
    const reach = 5 * TILE;
    const counts = [20, 40, 80].map((n) => tilesInReach(0, 0, reach, mapOf(n)).length);
    expect(counts[0]).toBe(121);
    expect(new Set(counts).size).toBe(1);
  });

  it('are only those the view sees: none wholly behind the camera', () => {
    // A view looking north from the origin: it sees nothing wholly south of it.
    const all = tilesInReach(0, 0, 5 * TILE, mapOf(20));
    const keys = tilesInReach(0, 0, 5 * TILE, mapOf(20), (_x0, _y0, _x1, y1) => y1 > 0);
    expect(keys.length).toBe(66);
    expect(keys.every((key) => all.includes(key))).toBe(true);
  });

  it('stop at the map\'s edge, and are none with no reach yet', () => {
    expect(tilesInReach(0, 0, 5 * TILE, mapOf(10)).length).toBe(100);
    expect(tilesInReach(0, 0, 0, mapOf(10))).toEqual([]);
    expect(tilesInReach(0, 0, Infinity, mapOf(10))).toEqual([]);
  });
});
