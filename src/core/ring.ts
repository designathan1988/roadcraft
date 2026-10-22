import { ARC_TOL, EPS, FINE_EPS, MIN_ITER_STEP, normalizeAngle } from './scalar';
import { type Vec2, angleOf, sub } from './vec2';
import type { Aabb } from './aabb';

export type RingEdge =
  | { readonly kind: 'line'; readonly to: Vec2 }
  | {
      readonly kind: 'arc';
      readonly c: Vec2;
      readonly r: number;
      readonly a0: number;
      readonly a1: number;
      /** True when the sweep goes counter-clockwise in math orientation. */
      readonly ccw: boolean;
      /** Arc endpoint, stored so `flatten` never has to recompute it. */
      readonly to: Vec2;
    };

/** Where a ring's numbers stand in its run (`Ring.data`): its area and box (NaN until first asked), its start, then its edges. */
const AREA = 0, MIN_X = 1, MIN_Y = 2, MAX_X = 3, MAX_Y = 4, START = 5, EDGES = 7;
/** An edge's code, first of its numbers: a line (then its end), an arc either way (then its end, centre, radius and two angles). */
const LINE = 0, ARC_CCW = 1, ARC_CW = 2;
/** How many numbers an edge of each kind takes. */
const LINE_SIZE = 3, ARC_SIZE = 8;

/** A closed boundary made of lines and exact arcs. */
export class Ring {
  /**
   * DO NOT keep a ring as objects - an edge an object, a point an object, its flattened vertices a list of points (~600 B a ring, 2 KB
   * a building of the network's junctions and roads, 2026-10-21): one run of doubles (`AREA`..`EDGES`, a plain array of numbers: no
   * typed array's ~200 B of buffer a ring), the edges and the vertices made from it when asked for.
   */
  private readonly data: number[];
  private readonly count: number;

  constructor(start: Vec2, edges: readonly RingEdge[]) {
    let size = EDGES;
    for (const e of edges) size += e.kind === 'line' ? LINE_SIZE : ARC_SIZE;
    // Laid at its size (a list pushed to grows past it), every slot written before it is read.
    const data = new Array<number>(size);
    data[AREA] = NaN; data[MIN_X] = NaN; data[MIN_Y] = NaN; data[MAX_X] = NaN; data[MAX_Y] = NaN;
    data[START] = start.x; data[START + 1] = start.y;
    let k = EDGES;
    for (const e of edges) {
      data[k] = e.kind === 'line' ? LINE : e.ccw ? ARC_CCW : ARC_CW;
      data[k + 1] = e.to.x; data[k + 2] = e.to.y;
      if (e.kind === 'arc') { data[k + 3] = e.c.x; data[k + 4] = e.c.y; data[k + 5] = e.r; data[k + 6] = e.a0; data[k + 7] = e.a1; }
      k += e.kind === 'line' ? LINE_SIZE : ARC_SIZE;
    }
    this.data = data;
    this.count = edges.length;
  }

  /** The first vertex (a new point at each call). */
  get start(): Vec2 {
    return { x: this.data[START]!, y: this.data[START + 1]! };
  }

  /** The edges (new objects at each call: the ring keeps numbers). */
  get edges(): RingEdge[] {
    const d = this.data, out: RingEdge[] = [];
    for (let k = EDGES; k < d.length;) {
      const code = d[k]!, to = { x: d[k + 1]!, y: d[k + 2]! };
      if (code === LINE) { out.push({ kind: 'line', to }); k += LINE_SIZE; continue; }
      out.push({ kind: 'arc', c: { x: d[k + 3]!, y: d[k + 4]! }, r: d[k + 5]!, a0: d[k + 6]!, a1: d[k + 7]!, ccw: code === ARC_CCW, to });
      k += ARC_SIZE;
    }
    return out;
  }

  get isEmpty(): boolean {
    return this.count < 2;
  }

  /** Vertices approximating the ring, first point NOT repeated at the end: a new list at each call (the caller may keep it). */
  flatten(): Vec2[] {
    const xy = this.flatXY();
    const n = xy.length >> 1;
    const out = new Array<Vec2>(n);
    for (let i = 0; i < n; i++) out[i] = { x: xy[i * 2]!, y: xy[i * 2 + 1]! };
    return out;
  }

  /** The vertices as x, y pairs (`flatten`), worked out at each call from the edges (the ring keeps none). */
  flatXY(): Float64Array {
    const d = this.data;
    const sx = d[START]!, sy = d[START + 1]!;
    const out: number[] = [sx, sy];
    for (let k = EDGES; k < d.length;) {
      const code = d[k]!;
      if (code === LINE) { out.push(d[k + 1]!, d[k + 2]!); k += LINE_SIZE; continue; }
      const cx = d[k + 3]!, cy = d[k + 4]!, a0 = d[k + 6]!;
      const delta = arcDelta(a0, d[k + 7]!, code === ARC_CCW);
      const r = Math.abs(d[k + 5]!);
      const maxStep = r < ARC_TOL ? Math.PI : 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOL / r)));
      const steps = Math.max(1, Math.ceil(Math.abs(delta) / Math.max(maxStep, MIN_ITER_STEP)));
      for (let i = 1; i <= steps; i++) {
        const a = a0 + (delta * i) / steps;
        out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      k += ARC_SIZE;
    }
    // Drop a trailing point that coincides with the start (the start itself when there is nothing else).
    const k = out.length;
    if (Math.hypot(out[k - 2]! - sx, out[k - 1]! - sy) < FINE_EPS) out.length = k - 2;
    return Float64Array.from(out);
  }

  /** The box of the flattened ring (a new object at each call; the numbers are kept). */
  get bbox(): Aabb {
    const d = this.data;
    // Never NaN once worked out (a comparison with NaN takes nothing: an empty ring's box is Infinity, -Infinity).
    if (Number.isNaN(d[MIN_X]!)) {
      const xy = this.flatXY();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < xy.length; i += 2) {
        const x = xy[i]!, y = xy[i + 1]!;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      d[MIN_X] = minX; d[MIN_Y] = minY; d[MAX_X] = maxX; d[MAX_Y] = maxY;
    }
    return { minX: d[MIN_X]!, minY: d[MIN_Y]!, maxX: d[MAX_X]!, maxY: d[MAX_Y]! };
  }

  /** Shoelace area of the flattened ring. Positive means correct winding. */
  signedArea(): number {
    const d = this.data;
    if (!Number.isNaN(d[AREA]!)) return d[AREA]!;
    const p = this.flatXY();
    const n = p.length >> 1;
    let a = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) a += p[j * 2]! * p[i * 2 + 1]! - p[i * 2]! * p[j * 2 + 1]!;
    return (d[AREA] = a / 2);
  }

  /** Returns this ring, or a reversed copy, whichever has positive area. */
  ensurePositive(): Ring {
    return this.signedArea() >= 0 ? this : this.reversed();
  }

  /** The same boundary traversed the other way, with arcs kept exact. */
  reversed(): Ring {
    const n = this.count;
    if (n === 0) return this;
    const edges = this.edges, start = this.start;
    const out: RingEdge[] = [];
    for (let k = n - 1; k >= 0; k--) {
      const e = edges[k]!;
      const from = k === 0 ? start : edges[k - 1]!.to;
      if (e.kind === 'line') {
        out.push({ kind: 'line', to: from });
      } else {
        // Same circle, swept from the far end back to the near one.
        out.push({ kind: 'arc', c: e.c, r: e.r, a0: e.a1, a1: e.a0, ccw: !e.ccw, to: from });
      }
    }
    return new Ring(start, out);
  }

  /** Builds a ring of straight edges from a closed point list. */
  static fromPolygon(points: readonly Vec2[]): Ring {
    if (points.length < 3) {
      return new Ring(points[0] ?? { x: 0, y: 0 }, []);
    }
    const edges: RingEdge[] = [];
    for (let i = 1; i < points.length; i++) {
      edges.push({ kind: 'line', to: points[i] as Vec2 });
    }
    edges.push({ kind: 'line', to: points[0] as Vec2 });
    return new Ring(points[0] as Vec2, edges);
  }

  /** Appends this ring to a Path2D as a closed subpath, arcs kept exact. */
  addToPath(path: Path2D): void {
    if (this.isEmpty) return;
    const d = this.data;
    path.moveTo(d[START]!, d[START + 1]!);
    for (let k = EDGES; k < d.length;) {
      const code = d[k]!;
      if (code === LINE) { path.lineTo(d[k + 1]!, d[k + 2]!); k += LINE_SIZE; continue; }
      path.arc(d[k + 3]!, d[k + 4]!, Math.abs(d[k + 5]!), d[k + 6]!, d[k + 7]!, code !== ARC_CCW);
      k += ARC_SIZE;
    }
    path.closePath();
  }
}

function arcDelta(a0: number, a1: number, ccw: boolean): number {
  let d = normalizeAngle(a1 - a0);
  if (ccw && d < 0) d += Math.PI * 2;
  if (!ccw && d > 0) d -= Math.PI * 2;
  return Math.abs(d) < EPS ? 0 : d;
}

/** Builds an arc edge from a centre and two endpoints, choosing the sweep whose central angle is less than PI. */
export function arcEdge(c: Vec2, r: number, from: Vec2, to: Vec2): RingEdge {
  const a0 = angleOf(sub(from, c));
  const a1 = angleOf(sub(to, c));
  const delta = normalizeAngle(a1 - a0);
  return { kind: 'arc', c, r: Math.abs(r), a0, a1, ccw: delta >= 0, to };
}

export const lineEdge = (to: Vec2): RingEdge => ({ kind: 'line', to });
