import { describe, expect, it } from 'vitest';

import { horizonGeometry } from '@render/flatAtlas';
import { TERRAIN_BASE } from '@render/terrain';
import { m } from '@world/units';

/** The ground past the far ring, out to the horizon (`flatAtlas.ts` `horizonGeometry`): no void under the far city */

describe('the ground past the far ring', () => {
  it('is one flat frame from the ring to the horizon, at the base, facing up, leaving the ring to its plates', () => {
    const [x0, x1, y0, y1] = [m(-7168), m(7168), m(-5120), m(9216)];
    const reach = m(131_072);
    const g = horizonGeometry(x0, x1, y0, y1, reach);
    const p = g.getAttribute('position');
    const index = g.getIndex()!;
    expect(p.count).toBe(8);
    expect(index.count).toBe(24);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.count; i++) {
      expect(p.getY(i)).toBeCloseTo(TERRAIN_BASE, 5);
      minX = Math.min(minX, p.getX(i)); maxX = Math.max(maxX, p.getX(i));
      minZ = Math.min(minZ, p.getZ(i)); maxZ = Math.max(maxZ, p.getZ(i));
    }
    // Out to the horizon each way from the ring's centre (three's z is -y).
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    expect([minX, maxX]).toEqual([cx - reach, cx + reach]);
    expect([minZ, maxZ]).toEqual([-(cy + reach), -(cy - reach)]);
    for (let t = 0; t < index.count; t += 3) {
      const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      const ux = p.getX(b) - p.getX(a), uz = p.getZ(b) - p.getZ(a);
      const vx = p.getX(c) - p.getX(a), vz = p.getZ(c) - p.getZ(a);
      // The triangle's own normal up (three's front face is counter-clockwise): lit and shadowed as the land is.
      expect(uz * vx - ux * vz).toBeGreaterThan(0);
      // None of it over the ring's square: the plates draw there.
      const mx = (p.getX(a) + p.getX(b) + p.getX(c)) / 3, my = -(p.getZ(a) + p.getZ(b) + p.getZ(c)) / 3;
      expect(mx < x0 || mx > x1 || my < y0 || my > y1).toBe(true);
    }
  });
});
