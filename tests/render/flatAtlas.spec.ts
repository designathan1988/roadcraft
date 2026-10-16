import { describe, expect, it } from 'vitest';
import { PLATE_SIZE, plateRegion, platesAround } from '@world/bounds';
import { RELIEF_NATURAL, reliefHeight } from '@world/terrain';
import { TERRAIN_BASE, TERRAIN_HALF } from '@render/terrain';
import { createFlatFar, farIndexInto, writeFarPatch } from '@render/flatAtlas';

/** THE WORLD'S GROUND (`render/flatAtlas.ts`) */

describe('the world in plates', () => {
  it('draws each plate of the world with one terrain plate', () => {
    expect(PLATE_SIZE).toBe(2 * TERRAIN_HALF);
  });
});

describe('the far ground', () => {
  const land = (x: number, y: number): number => reliefHeight(RELIEF_NATURAL, x, y);
  // A ring of 3 x 3 plates round a plate far from the origin: each in its slot, as the atlas lays them.
  const ring = platesAround(40, -25, 1).map(plateRegion);
  const far = createFlatFar(ring.length);
  ring.forEach((r, slot) => writeFarPatch(far, slot, r.cx, r.cy, land));
  const position = far.geometry.getAttribute('position');

  it('stands on the land\'s own heights, wherever the plates are', () => {
    for (let v = 0; v < position.count; v += 97) {
      const x = position.getX(v), y = -position.getZ(v), h = position.getY(v);
      // A skirt hangs below its edge; every other vertex is on the land.
      expect(h).toBeLessThanOrEqual(TERRAIN_BASE + land(x, y) + 1e-3);
      expect(Math.abs(x - 40 * PLATE_SIZE)).toBeLessThanOrEqual(1.5 * PLATE_SIZE + 1e-6);
      expect(Math.abs(y + 25 * PLATE_SIZE)).toBeLessThanOrEqual(1.5 * PLATE_SIZE + 1e-6);
    }
    let onLand = 0;
    for (let v = 0; v < position.count; v += 101) {
      const x = position.getX(v), y = -position.getZ(v);
      if (Math.abs(position.getY(v) - (TERRAIN_BASE + land(x, y))) < 1e-3) onLand++;
    }
    expect(onLand).toBeGreaterThan(position.count / 101 * 0.7);
  });

  it('marks only the slot it wrote to be sent', () => {
    const one = createFlatFar(4);
    writeFarPatch(one, 2, ring[0]!.cx, ring[0]!.cy, land);
    const ranges = (one.geometry.getAttribute('position') as unknown as { updateRanges: { start: number; count: number }[] }).updateRanges;
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.start).toBe(2 * ranges[0]!.count);
  });

  it('leaves out the plates drawn in full, draws the rest, and hangs no skirt on the ring\'s rim', () => {
    const open = [false, false, false, false] as const;
    const all = farIndexInto(far, ring.map((_, slot) => ({ slot, rim: open })));
    const middle = 0;
    const some = farIndexInto(far, ring.map((_, slot) => ({ slot, rim: open })).filter((p) => p.slot !== middle));
    expect(some).toBe(all - all / ring.length);
    const index = far.geometry.getIndex()!.array;
    const centre = ring[middle]!;
    for (let k = 0; k < some; k++) {
      const v = index[k]!;
      const x = position.getX(v), y = -position.getZ(v);
      const inside = Math.abs(x - centre.cx) < PLATE_SIZE / 2 - 1 && Math.abs(y - centre.cy) < PLATE_SIZE / 2 - 1;
      expect(inside).toBe(false);
    }
    expect(far.geometry.drawRange.count).toBe(some);
    // A rim edge: its skirt left out (the cut side stands there).
    const rimmed = farIndexInto(far, [{ slot: 1, rim: [true, false, false, false] }]);
    expect(rimmed).toBe(all / ring.length - 32 * 12);
  });
});
