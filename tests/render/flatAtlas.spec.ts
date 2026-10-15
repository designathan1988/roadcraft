import { describe, expect, it } from 'vitest';
import { MAP_REGIONS, PLATE_SIZE, plateOf } from '@world/bounds';
import { RELIEF_NATURAL, reliefHeight } from '@world/terrain';
import { TERRAIN_BASE, TERRAIN_HALF } from '@render/terrain';
import { buildFlatFar, farIndexInto } from '@render/flatAtlas';

/** THE MAP'S GROUND (`render/flatAtlas.ts`) */

describe('the map in plates', () => {
  it('draws each plate of the map with one terrain plate', () => {
    expect(PLATE_SIZE).toBe(2 * TERRAIN_HALF);
  });
});

describe('the far ground', () => {
  const land = (x: number, y: number): number => reliefHeight(RELIEF_NATURAL, x, y);
  const far = buildFlatFar(land);
  const position = far.geometry.getAttribute('position');

  it('stands on the land\'s own heights', () => {
    for (let v = 0; v < position.count; v += 977) {
      const x = position.getX(v), y = -position.getZ(v), h = position.getY(v);
      // A skirt hangs below its edge; every other vertex is on the land.
      expect(h).toBeLessThanOrEqual(TERRAIN_BASE + land(x, y) + 1e-3);
    }
    let onLand = 0;
    for (let v = 0; v < position.count; v += 101) {
      const x = position.getX(v), y = -position.getZ(v);
      if (Math.abs(position.getY(v) - (TERRAIN_BASE + land(x, y))) < 1e-3) onLand++;
    }
    expect(onLand).toBeGreaterThan(position.count / 101 * 0.7);
  });

  it('leaves out the plates drawn in full, and draws the rest', () => {
    const all = farIndexInto(far, () => false);
    const home = plateOf(0, 0);
    const some = farIndexInto(far, (p) => p === home);
    expect(some).toBe(all - all / MAP_REGIONS.length);
    const index = far.geometry.getIndex()!.array;
    const homeCentre = MAP_REGIONS[home]!;
    for (let k = 0; k < some; k++) {
      const v = index[k]!;
      const x = position.getX(v), y = -position.getZ(v);
      const inside = Math.abs(x - homeCentre.cx) < PLATE_SIZE / 2 - 1 && Math.abs(y - homeCentre.cy) < PLATE_SIZE / 2 - 1;
      expect(inside).toBe(false);
    }
    expect(far.geometry.drawRange.count).toBe(some);
  });
});
