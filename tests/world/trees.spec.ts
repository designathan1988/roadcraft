import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { DEFAULT_TREE_BRUSH, clearingIndex, plantTrees, treeSeed } from '@world/trees';

const random = (seed: number): (() => number) => { const rng = new Rng(seed); return () => rng.float(); };

describe('planted trees', () => {
  it('plant about the density asked, none nearer than the spacing', () => {
    // 100 m across at 1 unit a metre: some 0.785 ha, 120 trees a hectare.
    const trees = plantTrees('mixed', DEFAULT_TREE_BRUSH, 0, 0, 50, 1, random(1), []);
    expect(trees.length).toBeGreaterThan(60);
    expect(trees.length).toBeLessThanOrEqual(95);
    for (const a of trees) for (const b of trees) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(DEFAULT_TREE_BRUSH.spacing);
    expect(trees.every((t) => Math.hypot(t.x, t.y) <= 50)).toBe(true);
  });

  it('pick the chosen kind’s models', () => {
    const next = random(2);
    for (let i = 0; i < 50; i++) {
      // The models in order (`render/natureTrees.ts` TREE_MODELS): two oaks, two cypresses, two palms.
      expect(Math.floor(treeSeed('oak', next) * 6)).toBeLessThan(2);
      expect(Math.floor(treeSeed('palm', next) * 6)).toBeGreaterThanOrEqual(4);
    }
  });

  it('are cut away with a clearing, and kept in the map', () => {
    const doc = new RoadDoc();
    doc.plantTrees([{ x: 0, y: 0, height: 12, yaw: 0, seed: 0.1 }, { x: 200, y: 0, height: 12, yaw: 0, seed: 0.5 }]);
    doc.cutTrees(0, 0, 30);
    expect(doc.trees.map((t) => t.x)).toEqual([200]);
    const cleared = clearingIndex(doc.treeClearings);
    expect(cleared(10, 10)).toBe(true);
    expect(cleared(200, 0)).toBe(false);
    const loaded = RoadDoc.fromJSON(doc.toJSON());
    expect(loaded.trees).toEqual(doc.trees);
    expect(loaded.treeClearings).toEqual(doc.treeClearings);
    loaded.clearTrees();
    expect(loaded.trees.length + loaded.treeClearings.length).toBe(0);
  });
});
