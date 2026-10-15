import type { Vec2 } from './vec2';

/** A ring's edges sorted into horizontal bands: Haines' "bins" for the crossings test */
export interface PolygonBands {
  readonly y0: number;
  /** Bands per world unit. */
  readonly scale: number;
  readonly count: number;
  /** The ring's points, flat: x0, y0, x1, y1, ... */
  readonly xy: Float64Array;
  /** Band k's edges are `edge[start[k]]` up to `edge[start[k + 1]]`. */
  readonly start: Int32Array;
  /** An edge is named by its end point i; it runs from point i - 1 (n - 1 for 0). */
  readonly edge: Int32Array;
}

/** The band a height falls in. */
const bandAt = (y0: number, scale: number, count: number, y: number): number =>
  Math.min(count - 1, Math.max(0, Math.floor((y - y0) * scale)));

export function polygonBands(points: readonly Vec2[], box: { readonly minY: number; readonly maxY: number }): PolygonBands {
  const n = points.length;
  const count = Math.max(1, Math.ceil(n / 2));
  const span = box.maxY - box.minY;
  const y0 = box.minY, scale = span > 0 ? count / span : 0;
  const xy = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) { xy[i * 2] = points[i]!.x; xy[i * 2 + 1] = points[i]!.y; }
  // Each edge's first and last band, then a counting sort of the edges by band.
  const lo = new Int32Array(n), hi = new Int32Array(n);
  const start = new Int32Array(count + 1);
  for (let i = 0; i < n; i++) {
    const yi = xy[i * 2 + 1]!, yj = xy[(i === 0 ? n - 1 : i - 1) * 2 + 1]!;
    lo[i] = bandAt(y0, scale, count, Math.min(yi, yj));
    hi[i] = bandAt(y0, scale, count, Math.max(yi, yj));
    for (let k = lo[i]!; k <= hi[i]!; k++) start[k + 1]!++;
  }
  for (let k = 0; k < count; k++) start[k + 1]! += start[k]!;
  const edge = new Int32Array(start[count]!);
  const fill = start.slice(0, count);
  for (let i = 0; i < n; i++) for (let k = lo[i]!; k <= hi[i]!; k++) edge[fill[k]!++] = i;
  return { y0, scale, count, xy, start, edge };
}

/** `pointInPolygon` (`polygon.ts`) over the edges of the point's band only */
export function insideBands(p: Vec2, b: PolygonBands): boolean {
  const n = b.xy.length >> 1;
  const xy = b.xy;
  const k = bandAt(b.y0, b.scale, b.count, p.y);
  let inside = false;
  for (let e = b.start[k]!, end = b.start[k + 1]!; e < end; e++) {
    const i = b.edge[e]!, j = i === 0 ? n - 1 : i - 1;
    const pix = xy[i * 2]!, piy = xy[i * 2 + 1]!, pjx = xy[j * 2]!, pjy = xy[j * 2 + 1]!;
    if (piy > p.y === pjy > p.y) continue;
    const x = ((pjx - pix) * (p.y - piy)) / (pjy - piy) + pix;
    if (p.x < x) inside = !inside;
  }
  return inside;
}
