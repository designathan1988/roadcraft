import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BLUEPRINTS } from '@world/buildings/blueprints';
import { storedBounds } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/**
 * THE BUILDINGS SEVERAL CHANGES REACH, IN ONE LOOK (`BuildingStore.nearAny`):
 * what asking `near` of each rectangle, testing and joining gives, in the
 * store's order. Rectangle by rectangle, the ground's changes since a look
 * read the cells they share again for each (0.8 s in one frame of a 2,560 m
 * city's growth, 2026-10-15).
 */
type Rect = readonly [number, number, number, number];
describe('the buildings several rectangles reach', () => {
  it('are those each rectangle reaches, joined, in the store order', () => {
    let seed = 3;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const doc = new RoadDoc();
    for (let i = 0; i < 600; i++) {
      const bp = BLUEPRINTS[i % BLUEPRINTS.length]!;
      doc.buildings.add({ ...JSON.parse(JSON.stringify(bp.body)), x: rand() * m(3000), y: rand() * m(3000), rotation: rand() * 6 } as Omit<Building, 'id'>);
    }
    const pad = m(50);
    const meets = (b: Building, r: Rect): boolean => {
      const box = storedBounds(b, pad);
      return box.minX <= r[2] && box.maxX >= r[0] && box.minY <= r[3] && box.maxY >= r[1];
    };
    const order = [...doc.buildings.all()].map((b) => b.id);
    for (let round = 0; round < 25; round++) {
      const rects: Rect[] = [];
      for (let k = 0; k < 1 + Math.floor(rand() * 15); k++) {
        const x = rand() * m(3000), y = rand() * m(3000);
        rects.push([x, y, x + rand() * m(300), y + rand() * m(300)]);
      }
      const each = new Set<number>();
      for (const r of rects) for (const b of doc.buildings.near(r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad)) if (meets(b, r)) each.add(b.id);
      const expected = order.filter((id) => each.has(id));
      expect(doc.buildings.nearAny(rects, pad, meets).map((b) => b.id)).toEqual(expected);
    }
  });

  it('is how the buildings on moved ground are found', () => {
    const source = readFileSync('src/render/renderer.ts', 'utf8');
    const body = source.slice(source.indexOf('const buildingsOnGroundSince'), source.indexOf('const buildingsOnGroundSince') + 900);
    expect(body).toMatch(/doc\.buildings\.nearAny\(rects, BANK_REACH,/);
    expect(body).not.toMatch(/buildings\.near\(/);
  });
});
