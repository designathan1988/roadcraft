import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { Level, halfWidth } from '@world/roadTypes';
import { type ZoneCell, buildZoneGrid } from '@world/zoneGrid';
import { m } from '@world/units';

/** Area of the overlap of two convex quads (Sutherland-Hodgman). */
function overlapArea(a: readonly Vec2[], b: readonly Vec2[]): number {
  const signed = (poly: readonly Vec2[]) => {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
      s += p.x * q.y - q.x * p.y;
    }
    return s / 2;
  };
  const ccw = (poly: readonly Vec2[]) => (signed(poly) < 0 ? [...poly].reverse() : [...poly]);
  let out = ccw(a);
  const clip = ccw(b);
  for (let i = 0; i < clip.length && out.length; i++) {
    const c0 = clip[i]!, c1 = clip[(i + 1) % clip.length]!;
    const side = (p: Vec2) => (c1.x - c0.x) * (p.y - c0.y) - (c1.y - c0.y) * (p.x - c0.x);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j]!, q = input[(j + 1) % input.length]!;
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
  }
  return out.length < 3 ? 0 : Math.abs(signed(out));
}

function overlaps(cells: readonly ZoneCell[]): [ZoneCell, ZoneCell, number][] {
  const found: [ZoneCell, ZoneCell, number][] = [];
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const a = cells[i]!, b = cells[j]!;
    if (Math.hypot(a.centre.x - b.centre.x, a.centre.y - b.centre.y) > m(30)) continue;
    const area = overlapArea(a.corners, b.corners);
    if (area > m(1) * m(1)) found.push([a, b, area]);
  }
  return found;
}

function onAnyRoad(net: Network, cell: ZoneCell): boolean {
  const inset = (q: Vec2) => ({ x: q.x + (cell.centre.x - q.x) * 0.1, y: q.y + (cell.centre.y - q.y) * 0.1 });
  for (const r of net.ribbons.values()) {
    const reach = halfWidth(r.road, Level.Sidewalk) - 0.1;
    if ([cell.centre, ...cell.corners.map(inset)].some((q) => r.full.distanceTo(q) < reach)) return true;
  }
  return false;
}

/** A block of streets: two parallel streets `gap` metres apart (centre to centre), joined at both ends. */
function block(gap: number, curve = 0) {
  const doc = new RoadDoc();
  const a0 = doc.addNode({ x: m(-150), y: 0 }), a1 = doc.addNode({ x: m(150), y: 0 });
  const b0 = doc.addNode({ x: m(-150), y: m(gap) }), b1 = doc.addNode({ x: m(150), y: m(gap) });
  doc.addSegment(a0.id, a1.id, 1);
  doc.addSegment(b0.id, b1.id, 1, curve ? { t: 0.5, h: m(curve) } : null);
  doc.addSegment(a0.id, b0.id, 1);
  doc.addSegment(a1.id, b1.id, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

describe('zone grids of neighbouring streets', () => {
  for (const gap of [40, 60, 90, 130]) {
    it(`never overlap between parallel streets ${gap} m apart, nor sit on a street`, () => {
      const { doc, net } = block(gap);
      const grid = buildZoneGrid(doc, net);
      const bad = overlaps(grid.cells);
      expect(bad.map(([a, b, area]) => `${a.id} x ${b.id}: ${(area / (m(1) * m(1))).toFixed(1)} m2`).slice(0, 5)).toEqual([]);
      expect(grid.cells.filter((c) => onAnyRoad(net, c)).map((c) => c.id)).toEqual([]);
    });
  }

  it('splits the land between two parallel streets at the midline: both get their front rows', () => {
    const { doc, net } = block(60);
    const grid = buildZoneGrid(doc, net);
    // 48 m of land between the footways: each street keeps its first two rows
    // (40 m) along the middle of the block, as in Cities: Skylines (nearer
    // row first); the older street takes the row left over.
    const inside = grid.cells.filter((c) => c.centre.y > 0 && c.centre.y < m(60) && Math.abs(c.centre.x) < m(100));
    const rows = (segment: number) => new Set(inside.filter((c) => c.segment === segment).map((c) => c.row));
    const segments = [...new Set(inside.map((c) => c.segment))].sort((a, b) => a - b);
    expect(segments.length).toBe(2);
    expect([...rows(segments[1]!)].sort()).toEqual([0, 1]);
    expect(rows(segments[0]!).has(0) && rows(segments[0]!).has(1)).toBe(true);
  });

  it('never overlap next to a curved street', () => {
    for (const h of [-25, 25]) {
      const { doc, net } = block(80, h);
      const grid = buildZoneGrid(doc, net);
      const bad = overlaps(grid.cells);
      expect(bad.map(([a, b, area]) => `${a.id} x ${b.id}: ${(area / (m(1) * m(1))).toFixed(1)} m2`).slice(0, 5)).toEqual([]);
      expect(grid.cells.filter((c) => onAnyRoad(net, c)).map((c) => c.id)).toEqual([]);
    }
  });
});
