import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { MAX_PLANTED_TREES } from '@world/trees';
import { MAX_TERRAIN_STAMPS } from '@world/terrain';
import { TILE } from '@world/tiles';
import { m } from '@world/units';

/** DECISION 5.1: A CAP IS A TILE'S, AND PAST IT THE NEW ITEM IS REFUSED - NOTHING OF THE PLAYER'S IS EVER TAKEN AWAY */

const tree = (x: number, y: number) => ({ x, y, height: 8, yaw: 0, seed: 0.3 });

describe("a tile's caps", () => {
  it('refuse a tree past the cap in its tile, keep every tree planted before, and take one in another tile', () => {
    const doc = new RoadDoc();
    const full = Array.from({ length: MAX_PLANTED_TREES }, (_, k) => tree(m(1) + (k % 500) * m(1), m(1) + Math.floor(k / 500) * m(1)));
    expect(doc.plantTrees(full)).toBe(MAX_PLANTED_TREES);
    const first = doc.trees[0];
    expect(doc.plantTrees([tree(m(600), m(600))])).toBe(0);
    expect(doc.trees).toHaveLength(MAX_PLANTED_TREES);
    expect(doc.trees[0]).toBe(first);
    // The next tile has room.
    expect(doc.plantTrees([tree(TILE + m(10), m(10))])).toBe(1);
  });

  it('refuse a stamp of relief past the cap in its tile: the land sculpted first stays', () => {
    const doc = new RoadDoc();
    for (let k = 0; k < MAX_TERRAIN_STAMPS; k++) doc.addTerrainStamp({ x: m(100), y: m(100), radius: m(5), strength: 1, mode: 'raise' });
    const first = doc.terrainStamps[0];
    expect(doc.addTerrainStamp({ x: m(200), y: m(200), radius: m(5), strength: 1, mode: 'raise' })).toBeNull();
    expect(doc.terrainStamps).toHaveLength(MAX_TERRAIN_STAMPS);
    expect(doc.terrainStamps[0]).toBe(first);
  });

  it('read a saved map whole, past any cap: nothing dropped as it opens', () => {
    const trees = Array.from({ length: MAX_PLANTED_TREES + 5 }, (_, k) => tree(m(1) + (k % 500) * m(1), m(1) + Math.floor(k / 500) * m(1)));
    const doc = RoadDoc.fromJSON({ version: 1, nodes: [], segments: [], trees } as never);
    expect(doc.trees).toHaveLength(MAX_PLANTED_TREES + 5);
  });
});
