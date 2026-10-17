import earcut from 'earcut';

import { cutAtAxis } from '@core/axisCut';
import { intersection, type MultiPoly, type Poly } from '@core/clipper';
import { m } from '@world/units';

/** THE SHAPE OF A SURFACE, WITHOUT ITS HEIGHTS */

/** One compact piece's triangulation: its vertices, its triangles as clipped and refined, and whether they run clockwise. */
export interface PieceShape {
  readonly xy: Float64Array;
  readonly tris: Uint32Array;
  readonly flip: boolean;
}
/** One ring of an outline's skirt: its edges [ax, ay, bx, by, ...] in order, with its polygon's winding. */
export interface SkirtRing {
  readonly flip: boolean;
  readonly edges: Float64Array;
}
/** A surface's shape: its pieces and, for a surface with a bottom, its skirts. */
export interface SurfaceShape {
  readonly pieces: readonly PieceShape[];
  readonly skirts: readonly SkirtRing[] | null;
}

/** The shape of `polygons` (one compact piece at a time, `splitToSpan`), and the skirts along their outline when `skirts` */
export function surfaceShape(polygons: MultiPoly, maxEdge: number, skirts: boolean, cut?: TileRect): SurfaceShape {
  const spans: Poly[] = [];
  for (const polygon of polygons) splitToSpan(polygon, maxEdge * 6, spans);
  const pieces: PieceShape[] = [];
  for (const span of spans) {
    const piece = pieceShape(span, maxEdge);
    if (piece) pieces.push(piece);
  }
  return { pieces, skirts: skirts ? skirtShape(polygons, maxEdge, cut) : null };
}

/** One compact piece: ear clipping and refinement. */
function pieceShape(polygon: Poly, maxEdge: number): PieceShape | null {
  const outer = polygon[0];
  if (!outer || outer.length < 3) return null;
  const flat: number[] = [];
  const holes: number[] = [];
  for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
    const ring = polygon[ringIndex];
    if (!ring || ring.length < 3) continue;
    if (ringIndex > 0) holes.push(flat.length / 2);
    densify(flat, ring, maxEdge);
  }
  const seed = earcut(flat, holes, 2);
  if (seed.length === 0) return null;
  // Which way round the TRIANGLES run decides which side faces the sky, so that is what is measured.
  const flip = trianglesArea(flat, seed) < 0;
  const builder: Builder = { xs: [], ys: [], tris: [...seed], midpoints: new Map() };
  for (let i = 0; i < flat.length; i += 2) {
    builder.xs.push(flat[i] as number);
    builder.ys.push(flat[i + 1] as number);
  }
  // Ear clipping joins the outline's points with long thin triangles (a fan)
  flipToDelaunay(builder, maxEdge);
  refine(builder, maxEdge);
  flipToDelaunay(builder, maxEdge);
  const xy = new Float64Array(builder.xs.length * 2);
  for (let i = 0; i < builder.xs.length; i++) { xy[i * 2] = builder.xs[i]!; xy[i * 2 + 1] = builder.ys[i]!; }
  return { xy, tris: Uint32Array.from(builder.tris), flip };
}

/** The edges the walls hang from, from the ORIGINAL outlines, never from the pieces */
function skirtShape(polygons: MultiPoly, maxEdge: number, cut?: TileRect): SkirtRing[] {
  const out: SkirtRing[] = [];
  for (const polygon of polygons) {
    const outer = polygon[0];
    if (!outer || outer.length < 3) continue;
    const flip = ringArea(outer) < 0;
    for (const ring of polygon) {
      if (!ring || ring.length < 3) continue;
      const flat: number[] = [];
      densify(flat, ring, maxEdge);
      const count = flat.length / 2;
      const edges: number[] = [];
      for (let k = 0; k < count; k++) {
        const i = k * 2;
        const j = ((k + 1) % count) * 2;
        const ax = flat[i] as number;
        const ay = flat[i + 1] as number;
        const bx = flat[j] as number;
        const by = flat[j + 1] as number;
        if (Math.hypot(bx - ax, by - ay) < 1e-6) continue;
        if (cut && alongCut(cut, ax, ay, bx, by)) continue;
        edges.push(ax, ay, bx, by);
      }
      out.push({ flip, edges: Float64Array.from(edges) });
    }
  }
  return out;
}

/**
 * The triangles that own each edge, for `flipToDelaunay`: open addressing over the edge's key (`edgeKey`), each slot its owners'
 * count and the first two (an edge of three or more, rare, keeps its list aside), the slots in the order their edges came. Made once
 * and grown, reused by every piece: DO NOT keep an array per edge in a map (0.7-1.4 GB allocated per tile worker, the auditor's profile).
 */
class EdgeOwners {
  keys = new Float64Array(1024);
  /** Owners per slot; -1: a slot no edge took. */
  counts = new Int32Array(1024).fill(-1);
  first = new Int32Array(1024);
  second = new Int32Array(1024);
  /** The slots taken, in the order their edges were first asked. */
  order = new Int32Array(512);
  taken = 0;
  /** The lists of the edges three or more triangles own, by slot. */
  readonly many = new Map<number, number[]>();

  /** Emptied for a piece of about `edges` edges. */
  reset(edges: number): void {
    let size = this.keys.length;
    while (size < edges * 4) size *= 2;
    if (size !== this.keys.length) this.allocate(size);
    else this.counts.fill(-1);
    this.taken = 0;
    this.many.clear();
  }

  private allocate(size: number): void {
    this.keys = new Float64Array(size);
    this.counts = new Int32Array(size).fill(-1);
    this.first = new Int32Array(size);
    this.second = new Int32Array(size);
    if (this.order.length < size / 2) this.order = new Int32Array(size / 2);
  }

  /** The slot of `key`, taken for it where it has none (count 0: owned by none). */
  slot(key: number): number {
    const mask = this.keys.length - 1;
    // The key's two halves mixed (Math.imul, a multiplicative hash).
    const lo = key % 0x4000_0000, hi = (key - lo) / 0x4000_0000;
    let at = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca77)) & mask;
    for (;;) {
      if (this.counts[at]! < 0) break;
      if (this.keys[at] === key) return at;
      at = (at + 1) & mask;
    }
    if ((this.taken + 1) * 2 > this.keys.length) { this.grow(); return this.slot(key); }
    this.keys[at] = key;
    this.counts[at] = 0;
    this.order[this.taken++] = at;
    return at;
  }

  /** Twice the slots, every edge filed again in the order it came. */
  private grow(): void {
    const { keys, counts, first, second } = this;
    const order = this.order.slice(0, this.taken);
    const lists = new Map(this.many);
    this.allocate(keys.length * 2);
    this.taken = 0;
    this.many.clear();
    for (const was of order) {
      const at = this.slot(keys[was]!);
      this.counts[at] = counts[was]!; this.first[at] = first[was]!; this.second[at] = second[was]!;
      const list = lists.get(was);
      if (list) this.many.set(at, list);
    }
  }

  /** `tri` among the owners of the edge at `at`, last. */
  add(at: number, tri: number): void {
    const n = this.counts[at]!;
    if (n === 0) this.first[at] = tri;
    else if (n === 1) this.second[at] = tri;
    else if (n === 2) this.many.set(at, [this.first[at]!, this.second[at]!, tri]);
    else this.many.get(at)!.push(tri);
    this.counts[at] = n + 1;
  }

  /** The edge at `at` owned by `tri` first, then by its owners less `gone`, in their order: `[tri, ...owners.filter((x) => x !== gone)]`. */
  replace(at: number, tri: number, gone: number): void {
    const n = this.counts[at]!;
    let kept = 0;
    scratchOwners[kept++] = tri;
    if (n > 2) { for (const x of this.many.get(at)!) if (x !== gone) scratchOwners[kept++] = x; }
    else {
      if (n > 0 && this.first[at] !== gone) scratchOwners[kept++] = this.first[at]!;
      if (n > 1 && this.second[at] !== gone) scratchOwners[kept++] = this.second[at]!;
    }
    this.counts[at] = kept;
    this.first[at] = scratchOwners[0]!;
    if (kept > 1) this.second[at] = scratchOwners[1]!;
    if (kept > 2) this.many.set(at, scratchOwners.slice(0, kept)); else this.many.delete(at);
  }

  /** The edge at `at` owned by these two alone. */
  pair(at: number, a: number, b: number): void {
    this.many.delete(at);
    this.first[at] = a; this.second[at] = b; this.counts[at] = 2;
  }

  /** The edge at `at` owned by none. */
  clear(at: number): void {
    this.many.delete(at);
    this.counts[at] = 0;
  }
}

const edgeOwners = new EdgeOwners();
/** An edge's owners while `replace` writes them again. */
const scratchOwners: number[] = [];
/** The edges still to look at (`flipToDelaunay`), grown and reused. */
let edgeStack = new Float64Array(1024);
const edgeKey = (i: number, j: number): number => (i < j ? i * 0x4000_0000 + j : j * 0x4000_0000 + i);

/** DO NOT leave the fan ear clipping made: its slivers were most of the road surfaces' triangles */
function flipToDelaunay(b: Builder, maxEdge: number): void {
  const t = b.tris, xs = b.xs, ys = b.ys;
  const count = t.length / 3;
  if (count < 2) return;
  const owners = edgeOwners;
  owners.reset(count * 3);
  for (let tri = 0; tri < count; tri++) {
    const a = t[tri * 3]!, c = t[tri * 3 + 1]!, d = t[tri * 3 + 2]!;
    owners.add(owners.slot(edgeKey(a, c)), tri);
    owners.add(owners.slot(edgeKey(c, d)), tri);
    owners.add(owners.slot(edgeKey(d, a)), tri);
  }
  const orient = (a: number, c: number, d: number): number =>
    (xs[c]! - xs[a]!) * (ys[d]! - ys[a]!) - (xs[d]! - xs[a]!) * (ys[c]! - ys[a]!);
  const inCircle = (a: number, c: number, d: number, p: number): number => {
    const ax = xs[a]! - xs[p]!, ay = ys[a]! - ys[p]!, bx = xs[c]! - xs[p]!, by = ys[c]! - ys[p]!, cx = xs[d]! - xs[p]!, cy = ys[d]! - ys[p]!;
    return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
  };
  let top = 0;
  const push = (key: number): void => {
    if (top >= edgeStack.length) { const grown = new Float64Array(edgeStack.length * 2); grown.set(edgeStack); edgeStack = grown; }
    edgeStack[top++] = key;
  };
  // The edges two triangles share, in the order they first came.
  for (let n = 0; n < owners.taken; n++) { const at = owners.order[n]!; if (owners.counts[at] === 2) push(owners.keys[at]!); }
  const third = (tri: number, i: number, j: number): number => {
    for (let n = 0; n < 3; n++) { const v = t[tri * 3 + n]!; if (v !== i && v !== j) return v; }
    return -1;
  };
  // The two triangles keep their winding (that of the first, all of a piece's run one way).
  let wind = 0;
  const put = (tri: number, a: number, c: number, d: number): void => {
    if (Math.sign(orient(a, c, d)) !== wind) { t[tri * 3] = a; t[tri * 3 + 1] = d; t[tri * 3 + 2] = c; } else { t[tri * 3] = a; t[tri * 3 + 1] = c; t[tri * 3 + 2] = d; }
  };
  let budget = count * 12;
  while (top > 0 && budget-- > 0) {
    const k = edgeStack[--top]!;
    const at = owners.slot(k);
    if (owners.counts[at] !== 2) continue;
    const j = k % 0x4000_0000, i = (k - j) / 0x4000_0000;
    const t1 = owners.first[at]!, t2 = owners.second[at]!;
    const p = third(t1, i, j), q = third(t2, i, j);
    if (p < 0 || q < 0 || p === q) continue;
    // The quadrilateral i-p-j-q must be strictly convex for the other diagonal to lie inside it.
    if (orient(p, q, i) * orient(p, q, j) >= 0) continue;
    const side = orient(i, j, p);
    if (inCircle(i, j, p, q) * (side > 0 ? 1 : -1) <= 1e-9 * Math.abs(side)) continue;
    const old = Math.hypot(xs[i]! - xs[j]!, ys[i]! - ys[j]!), made = Math.hypot(xs[p]! - xs[q]!, ys[p]! - ys[q]!);
    if (made > Math.max(old, maxEdge)) continue;
    wind = Math.sign(orient(t[t1 * 3]!, t[t1 * 3 + 1]!, t[t1 * 3 + 2]!));
    // t1 = (i, j, p) and t2 = (j, i, q) become (i, q, p) and (q, j, p)
    owners.replace(owners.slot(edgeKey(j, p)), t2, t1);
    owners.replace(owners.slot(edgeKey(i, q)), t1, t2);
    owners.clear(owners.slot(k));
    owners.pair(owners.slot(edgeKey(p, q)), t1, t2);
    put(t1, i, q, p);
    put(t2, q, j, p);
    push(edgeKey(i, q)); push(edgeKey(q, j)); push(edgeKey(j, p)); push(edgeKey(p, i));
  }
}

interface Builder {
  readonly xs: number[];
  readonly ys: number[];
  readonly tris: number[];
  readonly midpoints: Map<number, number>;
}

function addVertex(b: Builder, x: number, y: number): number {
  b.xs.push(x);
  b.ys.push(y);
  return b.xs.length - 1;
}

function midpoint(b: Builder, i: number, j: number): number {
  const key = i < j ? i * 0x4000_0000 + j : j * 0x4000_0000 + i;
  const cached = b.midpoints.get(key);
  if (cached !== undefined) return cached;
  const index = addVertex(
    b,
    ((b.xs[i] as number) + (b.xs[j] as number)) / 2,
    ((b.ys[i] as number) + (b.ys[j] as number)) / 2,
  );
  b.midpoints.set(key, index);
  return index;
}

const edgeLength = (b: Builder, i: number, j: number): number =>
  Math.hypot((b.xs[i] as number) - (b.xs[j] as number), (b.ys[i] as number) - (b.ys[j] as number));

/** Refines until no triangle edge is longer than `maxEdge`. ## Longest-edge bisection */
function refine(b: Builder, maxEdge: number, maxRounds = 24, budget = 600_000): void {
  // A triangle with every edge within `maxEdge` is finished: no round marks one of its edges
  const done: number[] = [];
  let active: number[] = [];
  const long = (x: number, y: number, z: number): boolean =>
    edgeLength(b, x, y) > maxEdge || edgeLength(b, y, z) > maxEdge || edgeLength(b, z, x) > maxEdge;
  for (let t = 0; t < b.tris.length; t += 3) {
    const a = b.tris[t] as number, c = b.tris[t + 1] as number, d = b.tris[t + 2] as number;
    if (long(a, c, d)) active.push(a, c, d); else done.push(a, c, d);
  }
  for (let round = 0; round < maxRounds && active.length; round++) {
    if ((done.length + active.length) / 3 > budget) break;
    const marked = new Set<number>();
    for (let t = 0; t < active.length; t += 3) {
      const a = active[t] as number;
      const c = active[t + 1] as number;
      const d = active[t + 2] as number;
      // The three edges in the order a-c, c-d, d-a; the first of equal longest wins.
      const ac = edgeLength(b, a, c);
      const cd = edgeLength(b, c, d);
      const da = edgeLength(b, d, a);
      let bestLength = maxEdge;
      let i = -1;
      let j = -1;
      if (ac > bestLength) { bestLength = ac; i = a; j = c; }
      if (cd > bestLength) { bestLength = cd; i = c; j = d; }
      if (da > bestLength) { i = d; j = a; }
      if (i >= 0) marked.add(i < j ? i * 0x4000_0000 + j : j * 0x4000_0000 + i);
    }
    if (marked.size === 0) break;

    const split = (i: number, j: number): number | null => {
      const key = i < j ? i * 0x4000_0000 + j : j * 0x4000_0000 + i;
      return marked.has(key) ? midpoint(b, i, j) : null;
    };

    const next: number[] = [];
    for (let t = 0; t < active.length; t += 3) {
      const a = active[t] as number;
      const c = active[t + 1] as number;
      const d = active[t + 2] as number;
      emit(next, a, c, d, split(a, c), split(c, d), split(d, a));
    }
    active = [];
    for (let t = 0; t < next.length; t += 3) {
      const a = next[t] as number, c = next[t + 1] as number, d = next[t + 2] as number;
      if (long(a, c, d)) active.push(a, c, d); else done.push(a, c, d);
    }
  }
  b.tris.length = 0;
  for (const v of done) b.tris.push(v);
  for (const v of active) b.tris.push(v);
}

/** The red/green cases: 0, 1, 2 or 3 split edges of one triangle. */
function emit(
  out: number[],
  a: number,
  b: number,
  c: number,
  ab: number | null,
  bc: number | null,
  ca: number | null,
): void {
  const count = (ab !== null ? 1 : 0) + (bc !== null ? 1 : 0) + (ca !== null ? 1 : 0);
  if (count === 0) {
    out.push(a, b, c);
    return;
  }
  if (count === 3) {
    out.push(a, ab as number, ca as number);
    out.push(ab as number, b, bc as number);
    out.push(ca as number, bc as number, c);
    out.push(ab as number, bc as number, ca as number);
    return;
  }
  if (count === 1) {
    if (ab !== null) out.push(a, ab, c, ab, b, c);
    else if (bc !== null) out.push(b, bc, a, bc, c, a);
    else out.push(c, ca as number, b, ca as number, a, b);
    return;
  }
  // Two split edges: cut off the corner they share, then split the quad left over along its shorter diagonal
  if (ab !== null && bc !== null) out.push(b, bc, ab, ab, bc, c, ab, c, a);
  else if (bc !== null && ca !== null) out.push(c, ca as number, bc, bc, ca as number, a, bc, a, b);
  else out.push(a, ab as number, ca as number, ca as number, ab as number, b, ca as number, b, c);
}

/** Appends a ring, inserting points so no edge is longer than `step`. */
function densify(flat: number[], ring: readonly (readonly number[])[], step: number): void {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as readonly number[];
    const b = ring[(i + 1) % ring.length] as readonly number[];
    const ax = a[0] as number;
    const ay = a[1] as number;
    const bx = b[0] as number;
    const by = b[1] as number;
    flat.push(ax, ay);
    const cuts = Math.min(512, Math.floor(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= cuts; k++) {
      const t = k / (cuts + 1);
      flat.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
}

/** Cuts a polygon down until no piece is wider than `span` in either axis. ## Why this is here */
function splitToSpan(polygon: Poly, span: number, out: Poly[], depth = 0): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const outer = polygon[0];
  if (!outer || outer.length < 3) return;
  for (const point of outer) {
    const x = point[0] as number;
    const y = point[1] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  // Depth is bounded so a pathological shape cannot recurse for ever
  if ((width <= span && height <= span) || depth >= 12) {
    out.push(polygon);
    return;
  }

  const cutX = width >= height;
  const middle = cutX ? (minX + maxX) / 2 : (minY + maxY) / 2;
  // A straight cut, done as one (see `cutAtAxis`); the general clipper only for a polygon the fast path declines.
  const halves = cutAtAxis(polygon, cutX ? 0 : 1, middle) ?? clipHalves(polygon, span, cutX, middle, minX, minY, maxX, maxY);
  for (const half of halves) {
    for (const piece of half) splitToSpan(piece, span, out, depth + 1);
  }
}

/** The two sides of a cut, by intersection with a rectangle either side of it. */
function clipHalves(
  polygon: Poly,
  pad: number,
  cutX: boolean,
  middle: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): MultiPoly[] {
  const rect = (x0: number, y0: number, x1: number, y1: number): MultiPoly => [
    [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]],
  ];
  const halves: MultiPoly[] = cutX
    ? [
        rect(minX - pad, minY - pad, middle, maxY + pad),
        rect(middle, minY - pad, maxX + pad, maxY + pad),
      ]
    : [
        rect(minX - pad, minY - pad, maxX + pad, middle),
        rect(minX - pad, middle, maxX + pad, maxY + pad),
      ];
  return halves.map((half) => intersection([polygon], half));
}

/** Twice the summed signed area of triangles over a flat [x,y,...] list; positive means CCW. */
function trianglesArea(flat: readonly number[], tris: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const a = (tris[i] as number) * 2;
    const b = (tris[i + 1] as number) * 2;
    const c = (tris[i + 2] as number) * 2;
    const ax = flat[a] as number;
    const ay = flat[a + 1] as number;
    sum += ((flat[b] as number) - ax) * ((flat[c + 1] as number) - ay)
      - ((flat[b + 1] as number) - ay) * ((flat[c] as number) - ax);
  }
  return sum;
}

/** An axis-aligned rectangle a surface has been cut to: [minX, minY, maxX, maxY]. */
export type TileRect = readonly [number, number, number, number];

/** How far a cut may land from the line it was asked for */
const CUT_SLACK = m(0.04);

/** The parts of `polygons` inside a rectangle, by four straight cuts (see `cutAtAxis`). */
export function clipToRect(polygons: MultiPoly, rect: TileRect): MultiPoly {
  let pieces: MultiPoly = polygons;
  const cuts: [0 | 1, number, boolean][] = [
    [0, rect[0], true], [0, rect[2], false], [1, rect[1], true], [1, rect[3], false],
  ];
  for (const [axis, at, keepAbove] of cuts) {
    const next: MultiPoly = [];
    for (const polygon of pieces) {
      const box = bounds(polygon);
      if (!box) continue;
      const low = axis === 0 ? box[0] : box[1];
      const high = axis === 0 ? box[2] : box[3];
      // Wholly on the kept side, or wholly off it: no cut to make.
      if (keepAbove ? low >= at : high <= at) {
        next.push(polygon);
        continue;
      }
      if (keepAbove ? high <= at : low >= at) continue;
      const [below = [], above = []] = cutAtAxis(polygon, axis, at) ??
        clipHalves(polygon, Math.max(box[2] - box[0], box[3] - box[1]) + 1, axis === 0, at,
          box[0], box[1], box[2], box[3]);
      for (const piece of keepAbove ? above : below) next.push(piece);
    }
    pieces = next;
  }
  return pieces;
}

/** Whether an edge runs along one of the lines a tile was cut on. */
function alongCut(rect: TileRect, ax: number, ay: number, bx: number, by: number): boolean {
  for (let k = 0; k < 4; k++) {
    const at = rect[k] as number;
    if (k % 2 === 0 ? Math.abs(ax - at) < CUT_SLACK && Math.abs(bx - at) < CUT_SLACK
      : Math.abs(ay - at) < CUT_SLACK && Math.abs(by - at) < CUT_SLACK) return true;
  }
  return false;
}

/** Bounding box of a polygon's outer ring, [minX, minY, maxX, maxY]. */
function bounds(polygon: Poly): [number, number, number, number] | null {
  const outer = polygon[0];
  if (!outer || outer.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of outer) {
    const x = point[0] as number;
    const y = point[1] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Twice the signed area of a ring of [x, y] pairs; positive means CCW. */
function ringArea(ring: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as readonly number[];
    const b = ring[(i + 1) % ring.length] as readonly number[];
    sum += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
  }
  return sum;
}

