import type { Vec2 } from '@core/vec2';

/**
 * A LOT'S RING, pure geometry (`lots.ts`): the points of a cut lot thinned,
 * the hull of a block and the rectangle round it. No document, no network.
 */

/**
 * A ring with the points that lie within `tol` of the line through their
 * neighbours taken out, again and again (a footway's corner curve in many
 * short pieces becomes a few): a lot is a handful of sides, and what is built
 * to its shape (`zoning.ts` `fitToLot`) takes at most 64.
 */
export function simplifyRing(ring: readonly Vec2[], tol: number): Vec2[] {
  const out = [...ring];
  for (let changed = true; changed && out.length > 3;) {
    changed = false;
    let best = -1, bestD = tol;
    for (let i = 0; i < out.length; i++) {
      const p = out[(i - 1 + out.length) % out.length]!, q = out[i]!, r = out[(i + 1) % out.length]!;
      const len = Math.hypot(r.x - p.x, r.y - p.y);
      const d = len < 1e-9 ? 0 : Math.abs((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / len;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { out.splice(best, 1); changed = true; }
  }
  return out;
}

export function hull(points: readonly Vec2[]): Vec2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [], upper: Vec2[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]!; while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The smallest-area rectangle round a convex hull (rotating its edges): centre, long axis u, short axis v, lengths. */
export function orientedBox(h: readonly Vec2[]): { c: Vec2; u: Vec2; v: Vec2; L: number; D: number } {
  let best = { area: Infinity, c: { x: 0, y: 0 }, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, L: 0, D: 0 };
  for (let i = 0; i < h.length; i++) {
    const a = h[i]!, b = h[(i + 1) % h.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, v = { x: -u.y, y: u.x };
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const q of h) {
      const s = q.x * u.x + q.y * u.y, t = q.x * v.x + q.y * v.y;
      s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    const area = (s1 - s0) * (t1 - t0);
    if (area < best.area) {
      const sc = (s0 + s1) / 2, tc = (t0 + t1) / 2;
      best = { area, c: { x: u.x * sc + v.x * tc, y: u.y * sc + v.y * tc }, u, v, L: s1 - s0, D: t1 - t0 };
    }
  }
  if (best.D > best.L) best = { ...best, u: best.v, v: { x: -best.v.y, y: best.v.x }, L: best.D, D: best.L };
  return best;
}

/** The boundary's area centroid (the corners' mean for a degenerate one). */
export function lotCentre(l: { readonly corners: readonly Vec2[] }): Vec2 {
  const q = l.corners;
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!, r = q[(i + 1) % q.length]!;
    const c = p.x * r.y - r.x * p.y;
    a += c; x += (p.x + r.x) * c; y += (p.y + r.y) * c;
  }
  if (Math.abs(a) < 1e-9) return { x: q.reduce((s, p) => s + p.x, 0) / q.length, y: q.reduce((s, p) => s + p.y, 0) / q.length };
  return { x: x / (3 * a), y: y / (3 * a) };
}
