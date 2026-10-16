import { describe, expect, it } from 'vitest';
import { FURNITURE_KINDS } from '@world/buildings/interior';
import { createFurnitureGeometries, furnitureTones } from '@render/buildings/furnitureKit';

/** THE FURNITURE MODELS (`furnitureKit.ts`), drawn instanced behind every window: indexed, each corner drawn once for every triangle it serves */

describe('the furniture models', () => {
  it('are indexed, with fewer vertices than triangle corners, and keep their tones', () => {
    const geometry = createFurnitureGeometries();
    for (const kind of FURNITURE_KINDS) {
      const g = geometry[kind];
      expect(g.index, kind).not.toBeNull();
      expect(g.getAttribute('position').count, kind).toBeLessThan(g.index!.count);
      expect(g.getAttribute('color').count, kind).toBe(g.getAttribute('position').count);
    }
    const tones = furnitureTones(geometry);
    expect(tones).toHaveLength(FURNITURE_KINDS.length * 3);
    for (const v of tones) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThanOrEqual(1); }
  });
});
