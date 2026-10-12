import type { Vec2 } from '@core/vec2';
import type { Rng } from '@core/rng';
import type { TensorField } from './field';
import { m } from '../units';

/**
 * THE STREETS OF A GENERATED CITY: hyperstreamlines of the city's tensor
 * field (`field.ts`), traced level by level, then cut into a street graph.
 *
 * As in Chen et al. 2008 and in MapGenerator (ProbableTrain, the tensor-field
 * city generator, `impl/streamlines.ts`):
 * - a level is traced in both families (major and minor eigenvectors); a
 *   streamline starts at a seed no nearer than `dsep` to a street of its own
 *   family and runs both ways, a step `dstep` at a time (second-order
 *   integration), until it leaves the city, comes within `dtest` of a street
 *   of its own family, closes on itself, or grows too long;
 * - the levels go from the widest spacing to the closest: main avenues, then
 *   collectors, then local streets, each level kept apart from the coarser
 *   ones it meets;
 * - a dangling end looks ahead `dlookahead` along its way and is carried on to
 *   the street it would meet (a T junction), as real streets end on others.
 *
 * Then the lines are cut where they cross into a planar graph: a node at every
 * crossing and every end, the nodes nearer than `merge` made one, dead ends
 * shorter than `prune` taken away, and two streets leaving a node at less than
 * `minAngle` reduced to one. Units are world units.
 */

export interface StreetLevel {
  /** Spacing of the streets that run along the major way, and along the minor way. */
  readonly dsepMajor: number;
  readonly dsepMinor: number;
  /** A streamline stops this near a street of its own family (a fraction of its spacing). */
  readonly testFraction: number;
  readonly dstep: number;
  readonly dlookahead: number;
  readonly minLength: number;
  readonly maxLength: number;
  readonly seedTries: number;
}

export interface StreetLine {
  readonly level: number;
  readonly family: 0 | 1;
  points: Vec2[];
  closed: boolean;
}

/** Points of streamlines, hashed by cell, for "anything of mine within d of here?". */
class SampleGrid {
  private readonly cells = new Map<string, Vec2[]>();
  constructor(private readonly cell: number) {}
  private key(x: number, y: number): string { return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`; }
  add(p: Vec2): void {
    const k = this.key(p.x, p.y);
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, list = []);
    list.push(p);
  }
  near(p: Vec2, d: number): boolean {
    const r = Math.ceil(d / this.cell);
    const cx = Math.floor(p.x / this.cell), cy = Math.floor(p.y / this.cell);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const list = this.cells.get(`${cx + i},${cy + j}`);
      if (!list) continue;
      for (const q of list) if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 < d * d) return true;
    }
    return false;
  }
}

/** Traces every level; returns the streamlines, coarsest level first. */
export function traceStreets(
  field: TensorField,
  inside: (p: Vec2) => boolean,
  bounds: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number },
  levels: readonly StreetLevel[],
  rng: Rng,
): StreetLine[] {
  const cell = Math.max(m(3.2), Math.min(...levels.map((l) => Math.min(l.dsepMajor, l.dsepMinor))) / 2);
  const grids: [SampleGrid, SampleGrid] = [new SampleGrid(cell), new SampleGrid(cell)];
  const lines: StreetLine[] = [];
  const dirOf = (family: 0 | 1, p: Vec2): Vec2 | null => (family === 0 ? field.major(p.x, p.y) : field.minor(p.x, p.y));

  for (let level = 0; level < levels.length; level++) {
    const L = levels[level]!;
    for (const family of [0, 1] as const) {
      const dsep = family === 0 ? L.dsepMajor : L.dsepMinor;
      const dtest = dsep * L.testFraction;
      let fails = 0;
      // Seeds, as in Jobard and Lefer's evenly spaced streamlines: every
      // street of this family laid offers seeds one spacing away on both
      // sides, so the streets fill the city row by row at even spacing; a
      // random point only when the queue runs dry.
      const queue: Vec2[] = [];
      const offer = (points: readonly Vec2[]): void => {
        for (let i = 2; i < points.length; i += 4) {
          const p = points[i]!, q = points[i - 1]!;
          const dx = p.x - q.x, dy = p.y - q.y, n = Math.hypot(dx, dy) || 1;
          queue.push({ x: p.x - (dy / n) * dsep, y: p.y + (dx / n) * dsep }, { x: p.x + (dy / n) * dsep, y: p.y - (dx / n) * dsep });
        }
      };
      for (const line of lines) if (line.family === family) offer(line.points);
      while (fails < L.seedTries) {
        const fromQueue = queue.length > 0;
        const seed: Vec2 = fromQueue ? queue.shift()! : { x: rng.range(bounds.x0, bounds.x1), y: rng.range(bounds.y0, bounds.y1) };
        if (!inside(seed) || grids[family].near(seed, dsep * 0.98) || !dirOf(family, seed)) { if (!fromQueue) fails++; continue; }
        const line = trace(seed, family, L, dtest);
        if (!line) { if (!fromQueue) fails++; continue; }
        fails = 0;
        lines.push({ level, family, points: line.points, closed: line.closed });
        for (const p of line.points) grids[family].add(p);
        offer(line.points);
      }
    }
  }
  // Dangling ends carried on to the street they would meet.
  for (const line of lines) {
    if (line.closed) continue;
    const L = levels[line.level]!;
    for (const end of [0, 1] as const) {
      const pts = line.points;
      const a = end === 0 ? pts[1]! : pts[pts.length - 2]!, b = end === 0 ? pts[0]! : pts[pts.length - 1]!;
      const dx = b.x - a.x, dy = b.y - a.y, n = Math.hypot(dx, dy) || 1;
      const hit = castTo(lines, line, b, { x: dx / n, y: dy / n }, L.dlookahead);
      if (!hit) continue;
      if (end === 0) pts.unshift(hit); else pts.push(hit);
    }
  }
  return lines;

  function trace(seed: Vec2, family: 0 | 1, L: StreetLevel, dtest: number): { points: Vec2[]; closed: boolean } | null {
    const start = dirOf(family, seed)!;
    const halves: Vec2[][] = [];
    let closed = false;
    for (const sign of [1, -1]) {
      const out: Vec2[] = [];
      let p = seed, prev = { x: start.x * sign, y: start.y * sign }, length = 0;
      for (let it = 0; it < 4000; it++) {
        const d1 = oriented(dirOf(family, p), prev);
        if (!d1) break;
        const mid = { x: p.x + (d1.x * L.dstep) / 2, y: p.y + (d1.y * L.dstep) / 2 };
        const d2 = oriented(dirOf(family, mid), d1);
        if (!d2) break;
        const next = { x: p.x + d2.x * L.dstep, y: p.y + d2.y * L.dstep };
        if (!inside(next)) break;
        if (grids[family].near(next, dtest)) break;
        length += L.dstep;
        // Round on itself (a ring round a radial centre): closed.
        if (sign === 1 && length > L.dstep * 12 && Math.hypot(next.x - seed.x, next.y - seed.y) < L.dstep * 1.5) { closed = true; break; }
        out.push(next);
        prev = d2;
        p = next;
        if (length > L.maxLength / 2) break;
      }
      halves.push(out);
      if (closed) break;
    }
    const points = closed ? [seed, ...halves[0]!, seed] : [...(halves[1] ?? []).reverse(), seed, ...halves[0]!];
    let total = 0;
    for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    return total >= L.minLength ? { points, closed } : null;
  }
}

/** A unit way, flipped to go on the way it was going. */
function oriented(d: Vec2 | null, prev: Vec2): Vec2 | null {
  if (!d) return null;
  return d.x * prev.x + d.y * prev.y < 0 ? { x: -d.x, y: -d.y } : d;
}

/** The first street a ray from `p` along `dir` meets within `reach` (not its own last stretch). */
function castTo(lines: readonly StreetLine[], own: StreetLine, p: Vec2, dir: Vec2, reach: number): Vec2 | null {
  let best: Vec2 | null = null, bestT = reach;
  const ex = p.x + dir.x * reach, ey = p.y + dir.y * reach;
  for (const line of lines) {
    const pts = line.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!, b = pts[i]!;
      if (line === own && (Math.hypot(a.x - p.x, a.y - p.y) < reach * 1.5 || Math.hypot(b.x - p.x, b.y - p.y) < reach * 1.5)) continue;
      const t = rayHit(p.x, p.y, ex, ey, a.x, a.y, b.x, b.y);
      if (t !== null && t * reach > 1e-3 && t * reach < bestT) { bestT = t * reach; best = { x: p.x + dir.x * t * reach, y: p.y + dir.y * t * reach }; }
    }
  }
  return best;
}

/** Parameter along p-q where it crosses a-b, or null. */
function rayHit(px: number, py: number, qx: number, qy: number, ax: number, ay: number, bx: number, by: number): number | null {
  const rx = qx - px, ry = qy - py, sx = bx - ax, sy = by - ay;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((ax - px) * sy - (ay - py) * sx) / den;
  const u = ((ax - px) * ry - (ay - py) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

// ------------------------------------------------------------------ the graph

export interface StreetEdge {
  readonly a: number;
  readonly b: number;
  /** The points between the two nodes, in order from a to b. */
  readonly points: readonly Vec2[];
  readonly level: number;
}

export interface StreetGraph {
  readonly nodes: readonly Vec2[];
  readonly edges: readonly StreetEdge[];
}

export interface GraphOptions {
  readonly merge: number;
  readonly prune: number;
  readonly minAngle: number;
  readonly simplify: number;
  /** Least distance between two points kept along an edge (the editor's shortest road and more). */
  readonly spacing: number;
}

/** Cuts the streamlines into a planar street graph. */
export function planarize(lines: readonly StreetLine[], o: GraphOptions): StreetGraph {
  const polys = lines.map((l) => ({ level: l.level, points: simplify(l.points, o.simplify) }));
  // Every crossing, as (polyline, segment, t) on both.
  const cuts: { seg: number; t: number; p: Vec2 }[][] = polys.map(() => []);
  const segs: { line: number; seg: number; a: Vec2; b: Vec2 }[] = [];
  polys.forEach((pl, line) => { for (let i = 1; i < pl.points.length; i++) segs.push({ line, seg: i - 1, a: pl.points[i - 1]!, b: pl.points[i]! }); });
  const cellSize = m(80);
  const hash = new Map<string, number[]>();
  segs.forEach((s, k) => {
    const x0 = Math.floor(Math.min(s.a.x, s.b.x) / cellSize), x1 = Math.floor(Math.max(s.a.x, s.b.x) / cellSize);
    const y0 = Math.floor(Math.min(s.a.y, s.b.y) / cellSize), y1 = Math.floor(Math.max(s.a.y, s.b.y) / cellSize);
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) { const key = `${i},${j}`; let l = hash.get(key); if (!l) hash.set(key, l = []); l.push(k); }
  });
  const seen = new Set<string>();
  for (const list of hash.values()) {
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const s = segs[list[x]!]!, r = segs[list[y]!]!;
      if (s.line === r.line && Math.abs(s.seg - r.seg) <= 1) continue;
      const key = list[x]! < list[y]! ? `${list[x]},${list[y]}` : `${list[y]},${list[x]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = segCross(s.a, s.b, r.a, r.b);
      if (!hit) continue;
      const p = { x: s.a.x + (s.b.x - s.a.x) * hit.t, y: s.a.y + (s.b.y - s.a.y) * hit.t };
      cuts[s.line]!.push({ seg: s.seg, t: hit.t, p });
      cuts[r.line]!.push({ seg: r.seg, t: hit.u, p });
    }
  }
  // Ends that stop on another street (a T, from the look-ahead) are cuts on it too.
  polys.forEach((pl, line) => {
    for (const end of [pl.points[0]!, pl.points[pl.points.length - 1]!]) {
      let best: { line: number; seg: number; t: number; d: number } | null = null;
      for (const s of segs) {
        if (s.line === line) continue;
        const ex = s.b.x - s.a.x, ey = s.b.y - s.a.y, l2 = ex * ex + ey * ey;
        if (l2 < 1e-9) continue;
        const t = Math.max(0, Math.min(1, ((end.x - s.a.x) * ex + (end.y - s.a.y) * ey) / l2));
        const d = Math.hypot(s.a.x + ex * t - end.x, s.a.y + ey * t - end.y);
        if (d < o.merge * 0.5 && (!best || d < best.d)) best = { line: s.line, seg: s.seg, t, d };
      }
      if (best) cuts[best.line]!.push({ seg: best.seg, t: best.t, p: end });
    }
  });

  // Nodes, merged within `merge`.
  const nodes: Vec2[] = [];
  const nodeHash = new Map<string, number[]>();
  const nodeAt = (p: Vec2): number => {
    const cx = Math.floor(p.x / o.merge), cy = Math.floor(p.y / o.merge);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const k of nodeHash.get(`${cx + i},${cy + j}`) ?? []) if (Math.hypot(nodes[k]!.x - p.x, nodes[k]!.y - p.y) < o.merge) return k;
    }
    nodes.push({ ...p });
    const key = `${cx},${cy}`;
    let l = nodeHash.get(key); if (!l) nodeHash.set(key, l = []); l.push(nodes.length - 1);
    return nodes.length - 1;
  };

  let edges: { a: number; b: number; points: Vec2[]; level: number }[] = [];
  polys.forEach((pl, line) => {
    const pts = pl.points;
    const marks = [{ seg: 0, t: 0, p: pts[0]! }, ...cuts[line]!, { seg: pts.length - 2, t: 1, p: pts[pts.length - 1]! }]
      .sort((u, v) => u.seg - v.seg || u.t - v.t);
    let from = nodeAt(marks[0]!.p);
    let between: Vec2[] = [];
    let k = 1;
    for (let seg = 0; seg < pts.length - 1; seg++) {
      while (k < marks.length && marks[k]!.seg === seg) {
        const to = nodeAt(marks[k]!.p);
        if (to !== from) edges.push({ a: from, b: to, points: between, level: pl.level });
        from = to;
        between = [];
        k++;
      }
      if (seg < pts.length - 2) between.push(pts[seg + 1]!);
    }
  });

  // Duplicates (two lines along the same stretch): the coarser kept.
  const byPair = new Map<string, { a: number; b: number; points: Vec2[]; level: number }>();
  for (const e of edges) {
    const key = e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`;
    const had = byPair.get(key);
    if (!had || e.level < had.level) byPair.set(key, e);
  }
  edges = [...byPair.values()];

  const length = (e: { a: number; b: number; points: Vec2[] }): number => {
    const all = [nodes[e.a]!, ...e.points, nodes[e.b]!];
    let s = 0;
    for (let i = 1; i < all.length; i++) s += Math.hypot(all[i]!.x - all[i - 1]!.x, all[i]!.y - all[i - 1]!.y);
    return s;
  };
  const leaving = (e: { a: number; b: number; points: Vec2[] }, at: number): number => {
    const all = [nodes[e.a]!, ...e.points, nodes[e.b]!];
    if (at === e.b) all.reverse();
    const a = all[0]!, b = all[Math.min(all.length - 1, 1)]!;
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    const degree = new Map<number, number>();
    for (const e of edges) { degree.set(e.a, (degree.get(e.a) ?? 0) + 1); degree.set(e.b, (degree.get(e.b) ?? 0) + 1); }
    // Short dead ends: stubs left where a line stopped just past a crossing.
    const kept = edges.filter((e) => !((degree.get(e.a) === 1 || degree.get(e.b) === 1) && length(e) < o.prune));
    if (kept.length !== edges.length) { edges = kept; changed = true; }
    // Two streets leaving a node too close in angle: the finer (or shorter) taken away.
    const at = new Map<number, typeof edges>();
    for (const e of edges) for (const n of [e.a, e.b]) { let l = at.get(n); if (!l) at.set(n, l = []); l.push(e); }
    const drop = new Set<(typeof edges)[number]>();
    for (const [n, list] of at) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const u = list[i]!, v = list[j]!;
        if (drop.has(u) || drop.has(v)) continue;
        let d = Math.abs(leaving(u, n) - leaving(v, n)) % (2 * Math.PI);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d >= o.minAngle) continue;
        drop.add(u.level > v.level || (u.level === v.level && length(u) < length(v)) ? u : v);
      }
    }
    if (drop.size) { edges = edges.filter((e) => !drop.has(e)); changed = true; }
    if (!changed) break;
  }

  // The points along each edge: no two nearer than `spacing` (the editor's shortest road).
  const out: StreetEdge[] = edges.map((e) => {
    const pts: Vec2[] = [];
    let last = nodes[e.a]!;
    for (const p of e.points) {
      if (Math.hypot(p.x - last.x, p.y - last.y) < o.spacing) continue;
      pts.push(p);
      last = p;
    }
    while (pts.length && Math.hypot(pts[pts.length - 1]!.x - nodes[e.b]!.x, pts[pts.length - 1]!.y - nodes[e.b]!.y) < o.spacing) pts.pop();
    return { a: e.a, b: e.b, points: pts, level: e.level };
  }).filter((e) => length(e as { a: number; b: number; points: Vec2[] }) >= o.spacing);
  // Only the nodes still used, renumbered.
  const used = new Map<number, number>();
  const finalNodes: Vec2[] = [];
  for (const e of out) for (const n of [e.a, e.b]) if (!used.has(n)) { used.set(n, finalNodes.length); finalNodes.push(nodes[n]!); }
  return { nodes: finalNodes, edges: out.map((e) => ({ ...e, a: used.get(e.a)!, b: used.get(e.b)! })) };
}

function segCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number } | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6 ? { t, u } : null;
}

/** Ramer-Douglas-Peucker. */
export function simplify(points: readonly Vec2[], tol: number): Vec2[] {
  if (points.length < 3) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = points[i]!, b = points[j]!;
    const ex = b.x - a.x, ey = b.y - a.y, l = Math.hypot(ex, ey) || 1;
    let far = -1, best = tol;
    for (let k = i + 1; k < j; k++) {
      const p = points[k]!;
      const d = Math.abs((p.x - a.x) * ey - (p.y - a.y) * ex) / l;
      if (d > best) { best = d; far = k; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([i, far], [far, j]); }
  }
  return points.filter((_, k) => keep[k]);
}
