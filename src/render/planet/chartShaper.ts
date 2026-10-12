import type { Aabb } from '@core/aabb';
import { tileCellOf } from '@world/planet/atlas';
import { inChartInto } from '@world/planet/charts';
import type { TerrainShaper } from '../terrain';

/**
 * THE ROADS' AND THE SITES' SHAPE OF THE GROUND, ASKED BY ONE PIECE'S PLATE
 * (`terrainAtlas.ts` shapeToRoads). A plate works on its piece's own map,
 * about the piece's centre (`cx`, `cy` in the atlas). The shape answers in
 * the atlas, where every road and every lot is written on the map of the
 * piece it was laid on - and reaches past that piece's border, over the
 * neighbour's ground. Asked only on its own map, a plate missed every cut,
 * fill and pad written on the next piece's: the ground beside a road or a
 * lot over a border was cut on one side and left standing on the other, a
 * wall of up to 12 m along the border (the tools over a border, 2026-10-11).
 *
 * So the shape's boxes are sorted by the map they are written on; those of
 * another piece are brought onto this one (their corners, with a margin for
 * the maps' slight disagreement), and a point inside one is asked on that
 * piece's map as well - as a terrain tile is sampled by the tile that holds
 * the point (Unity `TerrainMap`). Where two maps' shapes reach the same
 * point, the stronger answer stands.
 */
const MARGIN = 2;

export function chartShaper(face: number, cx: number, cy: number, shape: TerrainShaper): TerrainShaper {
  const own: Aabb[] = [];
  const foreign: { chart: number; here: Aabb }[] = [];
  const q = { x: 0, y: 0 };
  for (const b of shape.shapeBounds()) {
    const chart = tileCellOf((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    if (chart === face) {
      own.push({ minX: b.minX - cx, minY: b.minY - cy, maxX: b.maxX - cx, maxY: b.maxY - cy });
      continue;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of [[b.minX, b.minY], [b.maxX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY], [(b.minX + b.maxX) / 2, b.minY], [(b.minX + b.maxX) / 2, b.maxY], [b.minX, (b.minY + b.maxY) / 2], [b.maxX, (b.minY + b.maxY) / 2]] as const) {
      inChartInto(face, x, y, q);
      if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    }
    const pad = MARGIN + 0.01 * Math.max(maxX - minX, maxY - minY);
    foreign.push({ chart, here: { minX: minX - cx - pad, minY: minY - cy - pad, maxX: maxX - cx + pad, maxY: maxY - cy + pad } });
  }
  const p = { x: 0, y: 0 };
  return {
    shapeAt(x, y, ground) {
      const ax = x + cx, ay = y + cy;
      let best = shape.shapeAt(ax, ay, ground);
      for (const f of foreign) {
        const h = f.here;
        if (x < h.minX || x > h.maxX || y < h.minY || y > h.maxY) continue;
        // The same ground on the map the shape is written on.
        inChartInto(f.chart, ax, ay, p);
        const there = shape.shapeAt(p.x, p.y, ground);
        if (there.weight > best.weight) best = there;
      }
      return best;
    },
    shapeBounds: () => [...own, ...foreign.map((f) => f.here)],
  };
}
