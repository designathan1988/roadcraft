import { describe, expect, it } from 'vitest';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { offsetRing, localFootprint } from '@world/buildings/footprints';
import { buildingBounds, elementRect } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';

/** A BUILDING'S WORLD BOX WITHOUT A FUNCTION, AN ARRAY OR A RING A CALL (`geometry.ts` `buildingBounds`): the box the corners made one by one gave */

/** The box as it was worked out before, corner by corner through a function. */
function before(b: Building, grow = 0): { minX: number; minY: number; maxX: number; maxY: number } {
  const c = Math.cos(b.rotation), s = Math.sin(b.rotation);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const take = (lx: number, ly: number): void => {
    const x = b.x + lx * c - ly * s, y = b.y + lx * s + ly * c;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const v of b.volumes) {
    if (v.outline) { for (const p of offsetRing(localFootprint(v), grow)) take(p.x, p.y); continue; }
    take(v.x - grow, v.y - grow); take(v.x + v.w + grow, v.y - grow); take(v.x + v.w + grow, v.y + v.d + grow); take(v.x - grow, v.y + v.d + grow);
  }
  for (const e of b.elements ?? []) {
    const [x0, y0, x1, y1] = elementRect(e);
    const gx0 = Math.sign(x0 - e.x) * grow, gx1 = Math.sign(x1 - e.x) * grow, gy0 = Math.sign(y0 - e.y) * grow, gy1 = Math.sign(y1 - e.y) * grow;
    take(x0 + gx0, y0 + gy0); take(x1 + gx1, y0 + gy0); take(x1 + gx1, y1 + gy1); take(x0 + gx0, y1 + gy1);
  }
  return { minX, minY, maxX, maxY };
}

describe("a building's world box", () => {
  it('is the one its corners gave one by one, bit for bit: every blueprint, turned, with and without a margin, an outline and a turned element', () => {
    let outlined = 0, angled = 0;
    BLUEPRINTS.forEach((bp, i) => {
      const body = JSON.parse(JSON.stringify(bp.body)) as Building;
      // A turned element (a run along a path) on every other one.
      const own = [0, 1, 2, 3].map((k) => ({ id: 900 + k, kind: 'wall', x: 3 + 4 * k, y: -2 - k, facing: k % 4, w: 1.5 + k, d: 0.3, z: 0, h: 1.2 } as unknown as NonNullable<Building['elements']>[number]));
      const elements = [...(body.elements ?? []), ...own].map((e, k) => (k % 2 ? { ...e, angle: 0.37 * (k + 1) } : e));
      angled += elements.filter((e) => e.angle).length;
      // An outline on one block of every third.
      const volumes = body.volumes.map((v, k) => (k === 0 && i % 3 === 0 ? { ...v, outline: [{ x: 0, y: 0 }, { x: 1, y: 0.2 }, { x: 0.7, y: 1 }, { x: 0, y: 0.8 }] } : v));
      outlined += volumes.filter((v) => v.outline).length;
      const b = { ...body, volumes, elements, x: 13.7 * i, y: -4.1 * i, rotation: 0.23 * i } as Building;
      for (const grow of [0, 0.5, 2]) expect(buildingBounds(b, grow), `${i} ${grow}`).toEqual(before(b, grow));
    });
    expect(outlined).toBeGreaterThan(0);
    expect(angled).toBeGreaterThan(0);
  });
});
