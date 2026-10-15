import type { MultiPoly, Poly } from '@core/clipper';
import { Digest } from '@core/digest';
import { offsetPolyline } from '@core/offset';
import type { NodeId } from '@world/ids';
import type { Network, SegmentRibbon } from '@world/network';
import { CURB_BAND, Level } from '@world/roadTypes';
import { medianNose } from '@world/landscape';
import { m } from '@world/units';

/** The rings the road surfaces are cut from, one at a time (`roadSurfaceInputs.ts`). */

/** One ring of input, with its box and its digest, measured once when its item is made. */
export interface Input {
  readonly poly: Poly;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly digest: number;
}

export function inputOf(poly: Poly): Input | null {
  const outer = poly[0];
  if (!outer || outer.length < 3) return null;
  const digest = new Digest();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of poly) {
    digest.add(ring.length);
    for (const point of ring) {
      const x = point[0] as number;
      const y = point[1] as number;
      digest.add(x).add(y);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { poly, minX, minY, maxX, maxY, digest: digest.value() };
}

/** A road's central reservation, as two real polygons rather than as paint */
export function medianOf(net: Network, ribbon: SegmentRibbon): { kerb: Poly; inner: Poly; paved: boolean } | null {
  const median = ribbon.road.median;
  // A median painted on the carriageway has no kerb and no island.
  if (median <= 0 || ribbon.road.medianFlush) return null;
  const centre = ribbon.centre[Level.Asphalt];
  if (!centre || centre.n < 2) return null;
  // The island's nose stands back of each crossing (`world/landscape.ts` medianNose)
  const seg = net.doc.segment(ribbon.id);
  const back = (node: NodeId | undefined, from: { x: number; y: number }): number => {
    const at = node === undefined ? null : net.doc.node(node);
    const nose = node === undefined || !at ? 0 : medianNose(net, ribbon.id, node);
    return nose > 0 && at ? Math.max(0, nose - Math.hypot(from.x - at.x, from.y - at.y)) : 0;
  };
  const s0 = back(seg?.a, centre.point(0)), s1 = centre.length - back(seg?.b, centre.point(centre.n - 1));
  if (s1 - s0 < m(1)) return null;
  const points = s0 > 0 || s1 < centre.length ? centre.sub(s0, s1).toPoints() : centre.toPoints();
  // Grass by default; paved in concrete or pavers when the profile says so.
  const material = ribbon.road.materials?.median;
  return {
    // The kerb stone round the island, as wide as the footway's (`CURB_BAND`).
    kerb: strip(points, median / 2 + CURB_BAND),
    inner: strip(points, median / 2),
    paved: !!material && material !== 'grass',
  };
}

/** A closed ribbon `half` wide either side of a centreline. */
function strip(points: readonly { x: number; y: number }[], half: number): MultiPoly[number] {
  const left = offsetPolyline(points, half);
  const right = offsetPolyline(points, -half).reverse();
  return [[...left, ...right].map((p) => [p.x, p.y])];
}
