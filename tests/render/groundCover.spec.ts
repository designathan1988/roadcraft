import { describe, expect, it } from 'vitest';

import { FOREST_SPECIES, rockGeometry, scrubGeometry, treeModel } from '../../src/render/groundCover';

const triangles = (geometry: { index: { count: number } | null; getAttribute(name: string): { count: number } }): number =>
  (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;

/** The ground cover is low-poly by rule: a field of it must cost next to nothing. */
describe('ground cover', () => {
  it('keeps a stone to 36 triangles and a bush to 60', () => {
    for (let seed = 0; seed < 8; seed++) {
      expect(triangles(rockGeometry(seed * 17 + 3))).toBeLessThanOrEqual(36);
      expect(triangles(scrubGeometry(seed * 7 + 5))).toBeLessThanOrEqual(60);
    }
  });

  it('grows every tree light: body and foliage cards together under 300 triangles', () => {
    // The game's one tree style (`lowPolyTrees.ts`): a low-poly trunk and
    // inner crown under alpha-cut foliage cards, conifers included.
    for (const species of FOREST_SPECIES) {
      for (let seed = 0; seed < 4; seed++) {
        const model = treeModel(species, seed);
        expect(model.cards).not.toBeNull();
        const total = triangles(model.body) + (model.cards ? triangles(model.cards) : 0);
        expect(total).toBeLessThanOrEqual(300);
      }
    }
  });

  it('keeps a stone sitting on the ground, not floating or sunk out of sight', () => {
    const geometry = rockGeometry(3);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.min.y).toBeGreaterThan(-0.3);
    expect(box.max.y).toBeGreaterThan(0.3);
  });
});
