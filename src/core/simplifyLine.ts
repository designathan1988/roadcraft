import type { Vec2 } from './vec2';

/** An open line with the points within `tol` of the line through the points kept either side of them taken out, its ends kept
 *  (Ramer-Douglas-Peucker: no point dropped lies farther than `tol` from the line drawn). */
export function simplifyLine(points: readonly Vec2[], tol: number): Vec2[] {
  if (points.length < 3) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = points[i]!, b = points[j]!;
    const ex = b.x - a.x, ey = b.y - a.y, l = Math.hypot(ex, ey);
    let far = -1, best = tol;
    for (let k = i + 1; k < j; k++) {
      const p = points[k]!;
      // Against the chord, or against its first end where the chord has no length.
      const d = l > 0 ? Math.abs((p.x - a.x) * ey - (p.y - a.y) * ex) / l : Math.hypot(p.x - a.x, p.y - a.y);
      if (d > best) { best = d; far = k; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([i, far], [far, j]); }
  }
  return points.filter((_, k) => keep[k]);
}
