import { describe, expect, it } from 'vitest';
import { Polyline } from '@core/polyline';
import { mulberry32 } from '@core/rng';
import type { SegmentId } from '@world/ids';
import { type FieldProfile, SpatialIndex, roadField } from '@world/roadField';
import { m } from '@world/units';

/** THE ROAD HEIGHTS' QUERIES PRUNED BY BOX (`roadField.ts` `nearest`, `query`): a road whose line's box is past the best so far is never measured, and every answer is the one measuring every road gives */

const terrainAt = (x: number, y: number): number => Math.sin(x * 0.01) * m(2) + Math.cos(y * 0.013) * m(1.5);

/** A tangle of roads over a few hundred metres: straight, bent and crossing, at heights of their own. */
function profiles(): FieldProfile[] {
  const rnd = mulberry32(7);
  const out: FieldProfile[] = [];
  for (let k = 0; k < 40; k++) {
    const x0 = (rnd() - 0.5) * m(600), y0 = (rnd() - 0.5) * m(600);
    const a = rnd() * Math.PI * 2, bend = (rnd() - 0.5) * 0.8, length = m(40) + rnd() * m(260);
    const points = [];
    for (let s = 0; s <= 8; s++) {
      const t = s / 8, dir = a + bend * t;
      points.push({ x: x0 + Math.cos(dir) * length * t, y: y0 + Math.sin(dir) * length * t });
    }
    const line = Polyline.fromPoints(points);
    const step = m(2);
    const h = Array.from({ length: Math.ceil(line.length / step) + 1 }, (_, i) => m(5) * Math.sin(k + i * 0.05) + m(1));
    const half = m(4) + rnd() * m(6), grow = half + m(50);
    const bb = line.bbox;
    out.push({ id: (k + 1) as SegmentId, structure: k % 9 === 0 ? 'bridge' : 'ground', manualVertical: k % 13 === 0, type: k % 4, half, median: 0,
      sidewalk: m(3), sidewalkLeft: m(3), sidewalkRight: m(3), line, length: line.length, step, h,
      bbox: { minX: bb.minX - grow, minY: bb.minY - grow, maxX: bb.maxX + grow, maxY: bb.maxY + grow } });
  }
  return out;
}

/** The same roads with lines whose box covers the world: no road is ever pruned, every one is measured. */
function unpruned(list: readonly FieldProfile[]): FieldProfile[] {
  const everywhere = { minX: -1e12, minY: -1e12, maxX: 1e12, maxY: 1e12 };
  return list.map((p) => ({ ...p, line: Object.create(p.line, { bbox: { value: everywhere } }) as Polyline }));
}

describe('the road heights pruned by box', () => {
  it('answer every point as measuring every road does', () => {
    const list = profiles(), full = unpruned(list);
    const pruned = roadField(new SpatialIndex(list), new Map(list.map((p) => [p.id, p])), terrainAt);
    const reference = roadField(new SpatialIndex(full), new Map(full.map((p) => [p.id, p])), terrainAt);
    const rnd = mulberry32(11);
    for (let n = 0; n < 4000; n++) {
      const x = (rnd() - 0.5) * m(800), y = (rnd() - 0.5) * m(800);
      expect(pruned.at(x, y)).toBe(reference.at(x, y));
      const ground = new Set(['ground'] as const);
      expect(pruned.at(x, y, ground, false)).toBe(reference.at(x, y, ground, false));
    }
  });
});
