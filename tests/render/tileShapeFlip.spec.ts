import { describe, expect, it } from 'vitest';

import type { MultiPoly } from '@core/clipper';
import { surfaceShape } from '@render/mesh/tileShape';

/**
 * THE ROAD SURFACES' TRIANGLES ARE WELL SHAPED (`tileShape.ts` `flipToDelaunay`):
 * ear clipping joins an outline's points with long thin triangles, and the
 * refinement left them thin - a verge's triangle was a twelfth of the area its
 * longest edge allows, a curb ramp's a hundredth, and the road surfaces were
 * 1.4 GB of a 2,560 m city's 1.7 GB of geometry (2026-10-15). The diagonals are
 * turned to Delaunay's; the outline, the vertices and the edge limit stand.
 */
const ring = (...points: [number, number][]): MultiPoly[number] => [points] as never;

/** The area of a polygon's rings (holes subtracted), by the shoelace sum. */
const areaOf = (poly: MultiPoly[number]): number => poly.reduce((t, r, i) => {
  let a = 0;
  for (let k = 0; k < r.length; k++) { const p = r[k]!, q = r[(k + 1) % r.length]!; a += p[0]! * q[1]! - q[0]! * p[1]!; }
  return t + (i === 0 ? 1 : -1) * Math.abs(a) / 2;
}, 0);

interface Stats { tris: number; area: number; thin: number; longest: number; windings: Set<number>; vertices: number }
function statsOf(polys: MultiPoly, maxEdge: number): Stats {
  const shape = surfaceShape(polys, maxEdge, false);
  const out: Stats = { tris: 0, area: 0, thin: 0, longest: 0, windings: new Set(), vertices: 0 };
  for (const piece of shape.pieces) {
    out.vertices += piece.xy.length / 2;
    for (let i = 0; i < piece.tris.length; i += 3) {
      const a = piece.tris[i]!, b = piece.tris[i + 1]!, c = piece.tris[i + 2]!;
      const ax = piece.xy[a * 2]!, ay = piece.xy[a * 2 + 1]!, bx = piece.xy[b * 2]!, by = piece.xy[b * 2 + 1]!, cx = piece.xy[c * 2]!, cy = piece.xy[c * 2 + 1]!;
      const cross = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      out.tris++;
      out.area += Math.abs(cross) / 2;
      out.windings.add(Math.sign(cross));
      const edge = Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(cx - bx, cy - by), Math.hypot(ax - cx, ay - cy));
      out.longest = Math.max(out.longest, edge);
      // A sliver: less than a quarter of the area an equilateral triangle of its longest edge has.
      if (Math.abs(cross) / 2 < 0.25 * (Math.sqrt(3) / 4) * edge * edge) out.thin++;
    }
  }
  return out;
}

describe('the triangles of a surface', () => {
  const shapes: [string, MultiPoly, number][] = [
    ['a curb ramp, 6 x 1.8 at 0.75', [[ring([0, 0], [6, 0], [6, 1.8], [0, 1.8])[0]!]] as never, 0.75],
    ['a verge strip, 120 x 4 at 3.2', [[ring([0, 0], [120, 0], [120, 4], [0, 4])[0]!]] as never, 3.2],
    ['a road deck, 90 x 11 at 3.2', [[ring([0, 0], [90, 0], [90, 11], [0, 11])[0]!]] as never, 3.2],
    ['a plate with a hole, 40 x 30 at 3.2', [[ring([0, 0], [40, 0], [40, 30], [0, 30])[0]!, ring([12, 8], [12, 20], [28, 20], [28, 8])[0]!]] as never, 3.2],
  ];
  for (const [name, polys, maxEdge] of shapes) {
    it(`covers ${name} exactly, one way round, within the edge limit`, () => {
      const s = statsOf(polys, maxEdge);
      const expected = polys.reduce((t, p) => t + areaOf(p), 0);
      expect(s.area).toBeCloseTo(expected, 6);
      expect(s.windings.size).toBe(1);
      expect(s.windings.has(0)).toBe(false);
      expect(s.longest).toBeLessThanOrEqual(maxEdge * (1 + 1e-9));
    });
  }

  it('has few slivers, where ear clipping and halving left most of the triangles thin', () => {
    // Before the diagonals were turned: ramp 320 triangles (6 x 1.8 m), the deck and the verge several times what
    // their area needs. The share of slivers, and the count a surface needs, are bounded.
    const ramp = statsOf(shapes[0]![1], shapes[0]![2]);
    expect(ramp.tris).toBeLessThan(200);
    const deck = statsOf(shapes[2]![1], shapes[2]![2]);
    // 90 x 11 m at 3.2: a lattice of ~3.2 m needs about 2 * 90 * 11 / (0.43 * 3.2^2) = 450 triangles.
    expect(deck.tris).toBeLessThan(1000);
    expect(deck.thin / deck.tris).toBeLessThan(0.45);
  });
});
