import { describe, expect, it } from 'vitest';
import {
  FLAT_EARTH_WIDTH, FLAT_PLATE, FLAT_PLATES, FLAT_WORLD, flatEarthGround, flatPlateCentre, flatPlateOf,
} from '@world/flatEarth';
import { MAP_REGIONS, regionAt } from '@world/bounds';
import { TERRAIN_BASE, TERRAIN_HALF } from '@render/terrain';
import { buildFlatFar, farIndexInto } from '@render/flatAtlas';

/**
 * THE WHOLE FLAT EARTH'S GROUND (`render/flatAtlas.ts`,
 * docs/MAPA-PLANO-COMPLETO.md): the plates tile the world with no gap and no
 * overlap, the old map is the plate at the origin, and the far ground stands
 * on the land's own heights and is never drawn under a plate drawn in full.
 */

describe('the flat Earth in plates', () => {
  it('is the old map\'s plate, side by side, as wide as the globe is round', () => {
    expect(FLAT_PLATE).toBe(2 * TERRAIN_HALF);
    expect(FLAT_WORLD.maxX - FLAT_WORLD.minX).toBeGreaterThanOrEqual(FLAT_EARTH_WIDTH);
    expect(MAP_REGIONS).toHaveLength(FLAT_PLATES);
    const home = flatPlateCentre(flatPlateOf(0, 0));
    expect(home).toEqual({ x: 0, y: 0 });
  });

  it('puts every point on the plate whose square holds it', () => {
    for (let i = 0; i < FLAT_PLATES; i++) {
      const c = flatPlateCentre(i);
      expect(flatPlateOf(c.x, c.y)).toBe(i);
      expect(flatPlateOf(c.x + FLAT_PLATE * 0.49, c.y - FLAT_PLATE * 0.49)).toBe(i);
      const r = regionAt(c.x, c.y);
      expect([r.cx, r.cy]).toEqual([c.x, c.y]);
    }
    // Neighbours meet edge to edge.
    const a = flatPlateCentre(0), b = flatPlateCentre(1);
    expect(b.x - a.x).toBe(FLAT_PLATE);
    expect(b.y).toBe(a.y);
  });
});

describe('the far ground', () => {
  const far = buildFlatFar(flatEarthGround);
  const position = far.geometry.getAttribute('position');

  it('stands on the land\'s own heights', () => {
    for (let v = 0; v < position.count; v += 977) {
      const x = position.getX(v), y = -position.getZ(v), h = position.getY(v);
      // A skirt hangs below its edge; every other vertex is on the land.
      expect(h).toBeLessThanOrEqual(TERRAIN_BASE + flatEarthGround(x, y) + 1e-3);
    }
    let onLand = 0;
    for (let v = 0; v < position.count; v += 101) {
      const x = position.getX(v), y = -position.getZ(v);
      if (Math.abs(position.getY(v) - (TERRAIN_BASE + flatEarthGround(x, y))) < 1e-3) onLand++;
    }
    expect(onLand).toBeGreaterThan(position.count / 101 * 0.7);
  });

  it('leaves out the plates drawn in full, and draws the rest', () => {
    const all = farIndexInto(far, () => false);
    const home = flatPlateOf(0, 0);
    const some = farIndexInto(far, (p) => p === home);
    expect(some).toBe(all - all / FLAT_PLATES);
    const index = far.geometry.getIndex()!.array;
    const homeCentre = flatPlateCentre(home);
    for (let k = 0; k < some; k++) {
      const v = index[k]!;
      const x = position.getX(v), y = -position.getZ(v);
      const inside = Math.abs(x - homeCentre.x) < FLAT_PLATE / 2 - 1 && Math.abs(y - homeCentre.y) < FLAT_PLATE / 2 - 1;
      expect(inside).toBe(false);
    }
    expect(far.geometry.drawRange.count).toBe(some);
  });
});
