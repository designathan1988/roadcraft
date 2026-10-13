import { Digest } from './digest';
import type { Vec2 } from './vec2';

/**
 * How overlapping rings combine.
 *
 *   evenodd  inside when a ray crosses the boundary an odd number of times: a
 *            polygon with holes, as a clipper union returns it.
 *   nonzero  inside when the winding number is not zero: the union of rings
 *            that may overlap one another, as they come from the ribbons and
 *            junctions before anything merges them. Rings are wound CCW first.
 */
export type FillRule = 'evenodd' | 'nonzero';

/**
 * Point location, boundary distance and line spans over a set of rings, in
 * constant time per query.
 *
 * The boundary segments are bucketed into a uniform grid, and every cell
 * stores the winding number at its own centre, computed once by a scanline.
 * A query then only has to walk from the centre of its cell to the point —
 * across the cell horizontally, then vertically — counting the crossings of
 * the segments in that one cell. No allocation after the build, no clipper,
 * and the answer is the same as a ray cast over every ring on the map.
 *
 * Built for the pedestrian navigation (which asks, thousands of times while a
 * network is being built, where the footway begins and ends along a line
 * across it) and for the audits that check whether a body is standing on
 * what the renderer draws.
 *
 * ONE GRID PER CLUSTER of rings. A single dense grid over the rings' bounds
 * paid for every empty cell between them: rings kilometres apart made the
 * player's map (1 130 segments) build two grids of 3.3 million cells each,
 * 200 ms of every road edit and 50 MB thrown away (2026-10-11) - the cost of a
 * uniform grid over sparse data, which a hashed or compact grid stores only
 * where it is occupied (Ihmsen et al., "SPH Fluids in Computer Graphics";
 * Lagae and Dutré, compact grids). Rings whose bounds come within
 * `CLUSTER_GAP` cells of each other share one dense grid, exactly as before;
 * clusters lie farther apart than that. A ring winds nothing outside its own
 * bounds, so a point's winding is its cluster's alone, and the queries that
 * reach out (a distance, a line, a box) ask every cluster they reach: the
 * answers are the single grid's. One town is one cluster, the old grid itself.
 */
export class RegionIndex {
  private readonly rule: FillRule;
  private readonly grids: readonly Grid[];
  /** The clusters' grids by coarse cell (`COARSE` cells a side), for point queries; null with one grid. */
  private readonly lookup: Map<number, Grid[]> | null;
  private readonly coarse: number;
  /** Scratch for `run`: crossing parameters and winding steps. */
  private hits = { t: new Float64Array(64), w: new Int8Array(64) };

  private constructor(rule: FillRule, grids: readonly Grid[], cell: number) {
    this.rule = rule;
    this.grids = grids;
    this.coarse = cell * COARSE;
    if (grids.length <= 1) { this.lookup = null; return; }
    const lookup = new Map<number, Grid[]>();
    for (const g of grids) {
      const [x0, y0, x1, y1] = g.bounds();
      for (let i = Math.floor(x0 / this.coarse); i <= Math.floor(x1 / this.coarse); i++) {
        for (let j = Math.floor(y0 / this.coarse); j <= Math.floor(y1 / this.coarse); j++) {
          const key = coarseKey(i, j);
          const list = lookup.get(key);
          if (list) list.push(g); else lookup.set(key, [g]);
        }
      }
    }
    this.lookup = lookup;
  }

  /** From closed rings; each need not repeat its first point. */
  static fromRings(rings: readonly (readonly Vec2[])[], rule: FillRule = 'nonzero', cell = 8): RegionIndex {
    const kept = rings.filter((ring) => ring.length >= 3);
    const grids = clusters(kept, cell * CLUSTER_GAP).map((members) => {
      let n = 0;
      for (const r of members) n += kept[r]!.length;
      const segs = new Float64Array(n * 4);
      let k = 0;
      for (const r of members) {
        const ring = kept[r]!;
        let area = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          area += (ring[j]!.x - ring[i]!.x) * (ring[j]!.y + ring[i]!.y);
        }
        // Wound counter-clockwise, so that for `nonzero` overlapping rings add
        // up instead of cancelling.
        const flip = rule === 'nonzero' && area < 0;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[flip ? ring.length - 1 - i : i]!;
          const b = ring[flip ? (2 * ring.length - 2 - i) % ring.length : (i + 1) % ring.length]!;
          segs[k++] = a.x; segs[k++] = a.y; segs[k++] = b.x; segs[k++] = b.y;
        }
      }
      return new Grid(segs.subarray(0, k), rule, cell);
    });
    // No ring at all: one empty grid, as the single grid was.
    return new RegionIndex(rule, grids.length ? grids : [new Grid(new Float64Array(0), rule, cell)], cell);
  }

  /** From a clipper multipolygon (`[x, y]` pairs, holes after the outline). */
  static fromMultiPoly(polygons: readonly (readonly (readonly (readonly number[])[])[])[],
    rule: FillRule = 'evenodd', cell = 8): RegionIndex {
    const rings: Vec2[][] = [];
    for (const polygon of polygons) {
      for (const ring of polygon) rings.push(ring.map((p) => ({ x: p[0] as number, y: p[1] as number })));
    }
    return RegionIndex.fromRings(rings, rule, cell);
  }

  private inside(w: number): boolean {
    return this.rule === 'evenodd' ? (w & 1) !== 0 : w !== 0;
  }

  /** The grid whose cells hold a point, if any. */
  private gridAt(x: number, y: number): Grid | null {
    if (this.lookup === null) return this.grids[0]!;
    const list = this.lookup.get(coarseKey(Math.floor(x / this.coarse), Math.floor(y / this.coarse)));
    if (!list) return null;
    for (const g of list) if (g.covers(x, y)) return g;
    return null;
  }

  /** Winding number at a point (evenodd: the crossing count); 0 off every grid. */
  winding(x: number, y: number): number {
    return this.gridAt(x, y)?.winding(x, y) ?? 0;
  }

  contains(x: number, y: number): boolean {
    return this.inside(this.winding(x, y));
  }

  /**
   * An exact digest of every segment whose cell the box touches (a collision
   * aside, at about one in 2^53).
   *
   * What a cached piece of work built from this region is keyed by: a query
   * inside the box reads only the segments in and around it, so two builds
   * that digest alike over the box answer every query in it identically, and
   * the answer may be reused as it is.
   *
   * The per-segment hashes are combined with XOR, not chained cell by cell:
   * the grid is anchored to the map's bounds, so adding a road anywhere moves
   * the whole grid, and a chained digest then changed for geometry that had
   * not moved at all — exactly the case this is asked about after an edit.
   */
  digest(minX: number, minY: number, maxX: number, maxY: number): number {
    // Two running sums and a count, not an XOR: XOR cancels two identical
    // segments, so a box holding two of the same edge would digest the same as
    // an empty one. A sum does not cancel its own terms, and the count says
    // how many were added without depending on the order they came in.
    const acc = { count: 0, sum: 0, cross: 0 };
    for (const g of this.grids) if (g.overlaps(minX, minY, maxX, maxY)) g.digestInto(minX, minY, maxX, maxY, acc);
    // And how many times the box's own middle is wound round. The segments a
    // box touches say nothing about a ring that goes AROUND it: a band added
    // round a corner leaves every segment in the box where it was, and only
    // moves what the box's middle is - which is exactly the change a corner
    // path must not sleep through. The NUMBER of turns, not inside-or-out:
    // a ring added round one already there leaves the middle inside twice.
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    return new Digest()
      .add(acc.count).add(acc.sum).add(acc.cross)
      .add(this.winding(midX, midY))
      .value();
  }

  /** Distance from a point to the nearest boundary segment within `reach`, or Infinity. */
  boundaryDistance(x: number, y: number, reach: number): number {
    let best = Infinity;
    for (const g of this.grids) {
      if (!g.overlaps(x - reach, y - reach, x + reach, y + reach)) continue;
      best = Math.min(best, g.nearest(x, y, reach));
    }
    return best <= reach ? best : Infinity;
  }

  /**
   * Along the line through `p` in direction `d` (a unit vector), the stretch
   * either side of `p`, within `reach`, that is on the same side of the
   * boundary as `p`: writes `lo` (<= 0) and `hi` (>= 0) into `out`, and
   * returns whether `p` is inside. A bound that is not met within `reach` is
   * written as the reach itself.
   */
  run(px: number, py: number, dx: number, dy: number, reach: number, out: { lo: number; hi: number }): boolean {
    const w0 = this.winding(px, py);
    const start = this.inside(w0);
    const ax = px - dx * reach, ay = py - dy * reach;
    const bx = px + dx * reach, by = py + dy * reach;
    const odd = this.rule === 'evenodd';
    let n = 0;
    for (const g of this.grids) {
      if (!g.overlaps(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) continue;
      n = g.crossings(px, py, dx, dy, reach, this.hits, n);
    }
    const hitT = this.hits.t, hitW = this.hits.w;
    // Insertion sort: a line across a footway crosses a handful of edges.
    for (let i = 1; i < n; i++) {
      const t = hitT[i]!, wv = hitW[i]!;
      let j = i - 1;
      while (j >= 0 && hitT[j]! > t) { hitT[j + 1] = hitT[j]!; hitW[j + 1] = hitW[j]!; j--; }
      hitT[j + 1] = t; hitW[j + 1] = wv;
    }
    let hi = reach;
    let w = w0;
    for (let i = 0; i < n; i++) {
      const t = hitT[i]!;
      if (t <= 0) continue;
      w += odd ? 1 : hitW[i]!;
      if (this.inside(w) !== start) { hi = t; break; }
    }
    let lo = -reach;
    w = w0;
    for (let i = n - 1; i >= 0; i--) {
      const t = hitT[i]!;
      if (t > 0) continue;
      // Going backwards reverses every step.
      w -= odd ? 1 : hitW[i]!;
      if (this.inside(w) !== start) { lo = t; break; }
    }
    out.lo = lo;
    out.hi = hi;
    return start;
  }

  /** `run`, for a point that must be inside: false, leaving `out` alone, when it is not. */
  span(px: number, py: number, dx: number, dy: number, reach: number, out: { lo: number; hi: number }): boolean {
    if (!this.contains(px, py)) return false;
    return this.run(px, py, dx, dy, reach, out);
  }

  /** How many dense grids the rings were filed in (one for one town). */
  get clusterCount(): number {
    return this.grids.length;
  }

  /** Cells allocated over every grid. */
  get cellCount(): number {
    let n = 0;
    for (const g of this.grids) n += g.cellCount;
    return n;
  }
}

/** Clusters closer than this many cells share a grid (so no two grids' cells meet). */
const CLUSTER_GAP = 4;
/** The point lookup's coarse cell, in grid cells a side. */
const COARSE = 64;
const coarseKey = (i: number, j: number): number => (i + 1_048_576) * 2_097_152 + (j + 1_048_576);

/**
 * The rings in clusters: those whose bounds, grown by half of `gap` each,
 * overlap, and so on through every chain of such rings. Filed by coarse
 * cells of the gap's size so only near rings are compared. Each cluster's
 * rings in their order; the clusters in the order of their first ring.
 */
function clusters(rings: readonly (readonly Vec2[])[], gap: number): number[][] {
  const n = rings.length;
  if (n === 0) return [];
  const box = new Float64Array(n * 4);
  for (let r = 0; r < n; r++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of rings[r]!) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    box[r * 4] = x0 - gap / 2; box[r * 4 + 1] = y0 - gap / 2; box[r * 4 + 2] = x1 + gap / 2; box[r * 4 + 3] = y1 + gap / 2;
  }
  const parent = new Int32Array(n);
  for (let r = 0; r < n; r++) parent[r] = r;
  const find = (r: number): number => {
    while (parent[r] !== r) { parent[r] = parent[parent[r]!]!; r = parent[r]!; }
    return r;
  };
  const join = (a: number, b: number): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  const overlap = (a: number, b: number): boolean =>
    box[a * 4]! <= box[b * 4 + 2]! && box[b * 4]! <= box[a * 4 + 2]! && box[a * 4 + 1]! <= box[b * 4 + 3]! && box[b * 4 + 1]! <= box[a * 4 + 3]!;
  // Rings that overlap share a coarse cell: compared only there.
  const size = Math.max(gap * 8, 1e-9);
  const cells = new Map<number, number[]>();
  for (let r = 0; r < n; r++) {
    const i0 = Math.floor(box[r * 4]! / size), i1 = Math.floor(box[r * 4 + 2]! / size);
    const j0 = Math.floor(box[r * 4 + 1]! / size), j1 = Math.floor(box[r * 4 + 3]! / size);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const key = coarseKey(i, j);
      const list = cells.get(key);
      if (!list) { cells.set(key, [r]); continue; }
      for (const other of list) if (find(other) !== find(r) && overlap(other, r)) join(other, r);
      list.push(r);
    }
  }
  // A cluster's bounds can reach another cluster's ring that no single ring
  // of it overlaps (an L of rings round a corner): their grids would meet.
  // Merged until no two clusters' bounds overlap.
  for (;;) {
    const roots = new Map<number, [number, number, number, number]>();
    for (let r = 0; r < n; r++) {
      const root = find(r);
      const b = roots.get(root);
      if (!b) { roots.set(root, [box[r * 4]!, box[r * 4 + 1]!, box[r * 4 + 2]!, box[r * 4 + 3]!]); continue; }
      b[0] = Math.min(b[0], box[r * 4]!); b[1] = Math.min(b[1], box[r * 4 + 1]!);
      b[2] = Math.max(b[2], box[r * 4 + 2]!); b[3] = Math.max(b[3], box[r * 4 + 3]!);
    }
    const list = [...roots.entries()];
    let merged = false;
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const p = list[a]![1], q = list[b]![1];
      if (p[0] <= q[2] && q[0] <= p[2] && p[1] <= q[3] && q[1] <= p[3] && find(list[a]![0]) !== find(list[b]![0])) { join(list[a]![0], list[b]![0]); merged = true; }
    }
    if (!merged) break;
  }
  const out = new Map<number, number[]>();
  for (let r = 0; r < n; r++) {
    const root = find(r);
    const members = out.get(root);
    if (members) members.push(r); else out.set(root, [r]);
  }
  return [...out.values()];
}

/** One dense grid over a cluster of rings (the single grid it once was over all of them). */
class Grid {
  private readonly segs: Float64Array;
  private readonly count: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly start: Int32Array;
  private readonly list: Int32Array;
  private readonly ref: Int32Array;
  private readonly stamps: Int32Array;
  private stamp = 0;
  private readonly rule: FillRule;

  constructor(segs: Float64Array, rule: FillRule, cell: number) {
    this.segs = segs;
    this.count = segs.length / 4;
    this.rule = rule;
    this.cell = cell;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < segs.length; i += 2) {
      const x = segs[i] as number, y = segs[i + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
    this.x0 = minX - cell;
    this.y0 = minY - cell;
    this.nx = Math.max(1, Math.ceil((maxX - this.x0) / cell) + 1);
    this.ny = Math.max(1, Math.ceil((maxY - this.y0) / cell) + 1);
    const cells = this.nx * this.ny;
    const counts = new Int32Array(cells + 1);
    this.rasterise((c) => { counts[c + 1]!++; });
    for (let c = 0; c < cells; c++) counts[c + 1]! += counts[c]!;
    this.start = counts;
    this.list = new Int32Array(counts[cells]!);
    const fill = counts.slice(0, cells);
    this.rasterise((c, s) => { this.list[fill[c]!++] = s; });
    this.stamps = new Int32Array(this.count);
    this.ref = new Int32Array(cells);
    this.scanReference();
  }

  get cellCount(): number {
    return this.nx * this.ny;
  }

  /** The area its cells cover. */
  bounds(): readonly [number, number, number, number] {
    return [this.x0, this.y0, this.x0 + this.nx * this.cell, this.y0 + this.ny * this.cell];
  }

  /** Whether a point lies in one of its cells. */
  covers(x: number, y: number): boolean {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((y - this.y0) / this.cell);
    return i >= 0 && j >= 0 && i < this.nx && j < this.ny;
  }

  /** Whether a box reaches its cells. */
  overlaps(minX: number, minY: number, maxX: number, maxY: number): boolean {
    return maxX >= this.x0 && maxY >= this.y0 && minX < this.x0 + this.nx * this.cell && minY < this.y0 + this.ny * this.cell;
  }

  /** Every (cell, segment) pair a segment's supercover touches. */
  private rasterise(visit: (cell: number, seg: number) => void): void {
    const s = this.segs;
    for (let k = 0; k < this.count; k++) {
      const ax = s[k * 4]!, ay = s[k * 4 + 1]!, bx = s[k * 4 + 2]!, by = s[k * 4 + 3]!;
      this.cellsOfSegment(ax, ay, bx, by, (c) => visit(c, k));
    }
  }

  /** Cells the segment (a, b) passes through, row by row. */
  private cellsOfSegment(ax: number, ay: number, bx: number, by: number, visit: (cell: number) => void): void {
    const c = this.cell;
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - this.y0) / c));
    const j1 = Math.min(this.ny - 1, Math.floor((Math.max(ay, by) - this.y0) / c));
    for (let j = j0; j <= j1; j++) {
      const lo = this.y0 + j * c, hi = lo + c;
      let xa: number, xb: number;
      if (Math.abs(by - ay) < 1e-12) { xa = ax; xb = bx; } else {
        const ta = Math.max(0, Math.min(1, (lo - ay) / (by - ay)));
        const tb = Math.max(0, Math.min(1, (hi - ay) / (by - ay)));
        xa = ax + (bx - ax) * ta;
        xb = ax + (bx - ax) * tb;
      }
      const i0 = Math.max(0, Math.floor((Math.min(xa, xb) - this.x0) / c));
      const i1 = Math.min(this.nx - 1, Math.floor((Math.max(xa, xb) - this.x0) / c));
      for (let i = i0; i <= i1; i++) visit(j * this.nx + i);
    }
  }

  /** The winding number at every cell centre, one scanline per row. */
  private scanReference(): void {
    const s = this.segs;
    // A scanline needs each crossing edge once. Walking every grid cell in a
    // row to rediscover those edges repeated the same bucket lookup hundreds
    // of times during the cold city build; the cell buckets remain for queries.
    const rowStart = new Int32Array(this.ny + 1);
    const eachCrossingRow = (visit: (row: number, segment: number) => void): void => {
      for (let k = 0; k < this.count; k++) {
        const ay = s[k * 4 + 1]!, by = s[k * 4 + 3]!;
        const first = Math.max(0, Math.floor((Math.min(ay, by) - this.y0) / this.cell));
        const last = Math.min(this.ny - 1, Math.floor((Math.max(ay, by) - this.y0) / this.cell));
        for (let j = first; j <= last; j++) {
          const y = this.y0 + (j + 0.5) * this.cell;
          if ((ay > y) !== (by > y)) visit(j, k);
        }
      }
    };
    eachCrossingRow((j) => { rowStart[j + 1]!++; });
    for (let j = 0; j < this.ny; j++) rowStart[j + 1]! += rowStart[j]!;
    const rowSegments = new Int32Array(rowStart[this.ny]!);
    const fill = rowStart.slice(0, this.ny);
    eachCrossingRow((j, k) => { rowSegments[fill[j]!++] = k; });
    const xs: number[] = [];
    const ds: number[] = [];
    const order: number[] = [];
    for (let j = 0; j < this.ny; j++) {
      const y = this.y0 + (j + 0.5) * this.cell;
      xs.length = 0; ds.length = 0; order.length = 0;
      for (let q = rowStart[j]!; q < rowStart[j + 1]!; q++) {
        const k = rowSegments[q]!;
        const ax = s[k * 4]!, ay = s[k * 4 + 1]!, bx = s[k * 4 + 2]!, by = s[k * 4 + 3]!;
        xs.push(ax + (bx - ax) * (y - ay) / (by - ay));
        ds.push(by > ay ? 1 : -1);
        order.push(order.length);
      }
      order.sort((a, b) => xs[a]! - xs[b]!);
      // w(x) = sum of directions of crossings strictly to the right of x.
      let total = 0;
      for (const d of ds) total += this.rule === 'evenodd' ? 1 : d;
      let q = 0;
      let left = 0;
      for (let i = 0; i < this.nx; i++) {
        const x = this.x0 + (i + 0.5) * this.cell;
        while (q < order.length && xs[order[q]!]! <= x) {
          left += this.rule === 'evenodd' ? 1 : ds[order[q]!]!;
          q++;
        }
        this.ref[j * this.nx + i] = total - left;
      }
    }
  }

  /** Winding number at a point (evenodd: the crossing count), 0 off the grid. */
  winding(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((y - this.y0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return 0;
    const c = j * this.nx + i;
    const cx = this.x0 + (i + 0.5) * this.cell;
    const cy = this.y0 + (j + 0.5) * this.cell;
    let w = this.ref[c]!;
    const s = this.segs;
    const odd = this.rule === 'evenodd';
    for (let q = this.start[c]!; q < this.start[c + 1]!; q++) {
      const k = this.list[q]!;
      const ax = s[k * 4]!, ay = s[k * 4 + 1]!, bx = s[k * 4 + 2]!, by = s[k * 4 + 3]!;
      // Across the cell at the centre's height, from its centre to x.
      if ((ay > cy) !== (by > cy)) {
        const xc = ax + (bx - ax) * (cy - ay) / (by - ay);
        const up = by > ay ? 1 : -1;
        if (x < cx && xc > x && xc <= cx) w += odd ? 1 : up;
        else if (x > cx && xc > cx && xc <= x) w -= odd ? 1 : up;
      }
      // Then up or down to the point.
      if ((ax > x) !== (bx > x)) {
        const yc = ay + (by - ay) * (x - ax) / (bx - ax);
        const east = bx > ax ? 1 : -1;
        if (y > cy && yc > cy && yc <= y) w += odd ? 1 : east;
        else if (y < cy && yc > y && yc <= cy) w -= odd ? 1 : east;
      }
    }
    return w;
  }

  /** The segments whose cell the box touches, added to the digest's sums (`RegionIndex.digest`). */
  digestInto(minX: number, minY: number, maxX: number, maxY: number, acc: { count: number; sum: number; cross: number }): void {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((minX - this.x0) / c));
    const i1 = Math.min(this.nx - 1, Math.floor((maxX - this.x0) / c));
    const j0 = Math.max(0, Math.floor((minY - this.y0) / c));
    const j1 = Math.min(this.ny - 1, Math.floor((maxY - this.y0) / c));
    this.stamp++;
    const s = this.segs;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cellId = j * this.nx + i;
        for (let q = this.start[cellId]!; q < this.start[cellId + 1]!; q++) {
          const k = this.list[q]!;
          if (this.stamps[k] === this.stamp) continue;
          this.stamps[k] = this.stamp;
          const h = segmentHash(s[k * 4]!, s[k * 4 + 1]!, s[k * 4 + 2]!, s[k * 4 + 3]!);
          acc.count++;
          acc.sum = (acc.sum + h) >>> 0;
          acc.cross = (acc.cross + Math.imul(h, 0x9e3779b1)) >>> 0;
        }
      }
    }
  }

  /** Distance from a point to its nearest segment in the cells within `reach`, or Infinity. */
  nearest(x: number, y: number, reach: number): number {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x - reach - this.x0) / c));
    const i1 = Math.min(this.nx - 1, Math.floor((x + reach - this.x0) / c));
    const j0 = Math.max(0, Math.floor((y - reach - this.y0) / c));
    const j1 = Math.min(this.ny - 1, Math.floor((y + reach - this.y0) / c));
    this.stamp++;
    let best = Infinity;
    const s = this.segs;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cellId = j * this.nx + i;
      for (let q = this.start[cellId]!; q < this.start[cellId + 1]!; q++) {
        const k = this.list[q]!;
        if (this.stamps[k] === this.stamp) continue;
        this.stamps[k] = this.stamp;
        const ax = s[k * 4]!, ay = s[k * 4 + 1]!;
        const dx = s[k * 4 + 2]! - ax, dy = s[k * 4 + 3]! - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 1e-18 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /**
   * The crossings of the line through `p` along `d`, within `reach`, with its
   * segments: appended to `hits` from `n` (grown as needed), the new count returned.
   */
  crossings(px: number, py: number, dx: number, dy: number, reach: number, hits: { t: Float64Array; w: Int8Array }, n: number): number {
    const ax = px - dx * reach, ay = py - dy * reach;
    const bx = px + dx * reach, by = py + dy * reach;
    this.stamp++;
    const s = this.segs;
    const odd = this.rule === 'evenodd';
    const c = this.cell;
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - this.y0) / c));
    const j1 = Math.min(this.ny - 1, Math.floor((Math.max(ay, by) - this.y0) / c));
    for (let j = j0; j <= j1; j++) {
      const lo = this.y0 + j * c, hi = lo + c;
      let xa: number, xb: number;
      if (Math.abs(by - ay) < 1e-12) { xa = ax; xb = bx; } else {
        const ta = Math.max(0, Math.min(1, (lo - ay) / (by - ay)));
        const tb = Math.max(0, Math.min(1, (hi - ay) / (by - ay)));
        xa = ax + (bx - ax) * ta;
        xb = ax + (bx - ax) * tb;
      }
      const i0 = Math.max(0, Math.floor((Math.min(xa, xb) - this.x0) / c));
      const i1 = Math.min(this.nx - 1, Math.floor((Math.max(xa, xb) - this.x0) / c));
      for (let i = i0; i <= i1; i++) {
        const cellId = j * this.nx + i;
        for (let q = this.start[cellId]!; q < this.start[cellId + 1]!; q++) {
          const k = this.list[q]!;
          if (this.stamps[k] === this.stamp) continue;
          this.stamps[k] = this.stamp;
          const sx = s[k * 4]!, sy = s[k * 4 + 1]!;
          const ex = s[k * 4 + 2]! - sx, ey = s[k * 4 + 3]! - sy;
          const den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-12) continue;
          const rx = sx - px, ry = sy - py;
          const t = (rx * ey - ry * ex) / den;
          const u = (rx * dy - ry * dx) / den;
          if (u < 0 || u >= 1 || t < -reach || t > reach) continue;
          if (n >= hits.t.length) {
            const grownT = new Float64Array(n * 2); grownT.set(hits.t); hits.t = grownT;
            const grownW = new Int8Array(n * 2); grownW.set(hits.w); hits.w = grownW;
          }
          hits.t[n] = t;
          // Moving along +d across this edge: from its right to its left adds one.
          hits.w[n] = odd ? 1 : (ex * dy - ey * dx > 0 ? 1 : -1);
          n++;
        }
      }
    }
    return n;
  }
}

/** One 32-bit half of a double's bits, for the segment hash below. */
const hashBits = new Float64Array(1);
const hashWords = new Uint32Array(hashBits.buffer);
function floatWord(value: number, index: number): number {
  hashBits[0] = value;
  return hashWords[index] as number;
}

/** A segment's own hash, for `digest`: the four numbers of its ends. */
function segmentHash(ax: number, ay: number, bx: number, by: number): number {
  let h = 0x811c9dc5;
  h = Math.imul(h ^ floatWord(ax, 0), 0x01000193);
  h = Math.imul(h ^ floatWord(ax, 1), 0x01000193);
  h = Math.imul(h ^ floatWord(ay, 0), 0x01000193);
  h = Math.imul(h ^ floatWord(ay, 1), 0x01000193);
  h = Math.imul(h ^ floatWord(bx, 0), 0x01000193);
  h = Math.imul(h ^ floatWord(bx, 1), 0x01000193);
  h = Math.imul(h ^ floatWord(by, 0), 0x01000193);
  h = Math.imul(h ^ floatWord(by, 1), 0x01000193);
  return h;
}
