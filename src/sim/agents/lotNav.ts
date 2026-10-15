import { Heap } from '@core/heap';
import { m } from '@world/units';
import type { BuildingElement, ElementKind } from '@world/buildings/types';

/** Driving inside a car park: a grid over the lot, its cells blocked where a car cannot go */

/** Cell size of a car's grid. */
const DEFAULT_CELL = m(0.75);
/** Kept between a car's centreline and anything solid: half a car's width and a little. */
const DEFAULT_CLEARANCE = m(1.1);
/** What a car cannot drive through on a lot. */
const SOLID: ReadonlySet<ElementKind> = new Set<ElementKind>([
  'stair', 'ramp', 'pillar', 'wall', 'fence', 'tree', 'bench', 'planter', 'railing', 'rocks', 'clock', 'hedge',
  'shrub', 'bin', 'lamp', 'bollard', 'parking',
]);
/** What a person cannot walk through on a lot: a car's list less the stairs and ramps, and the flower beds. */
const PEOPLE_SOLID: ReadonlySet<ElementKind> = new Set<ElementKind>([
  'pillar', 'wall', 'fence', 'tree', 'bench', 'planter', 'railing', 'rocks', 'clock', 'hedge',
  'shrub', 'bin', 'lamp', 'bollard', 'parking', 'flowers',
]);
/** Parts this high off the ground or more stand over a walker's head (a canopy's wall, a sign). */
const OVERHEAD = m(2.1);

/** The grid's make for one kind of agent: its cell, the clearance its centre keeps, what is solid to it. */
export interface LotGridOptions {
  readonly cell?: number;
  readonly clearance?: number;
  readonly solid?: ReadonlySet<ElementKind>;
}
/** A person's grid: 20 cm cells, so a gate's opening */
export const PEOPLE_GRID: LotGridOptions = { cell: m(0.2), clearance: m(0.25), solid: PEOPLE_SOLID };

export interface LotRect { readonly x: number; readonly y: number; readonly w: number; readonly d: number }

/** What a lot's grid reads of a part of the lot (`buildLotGrid`): all a worker is sent of it (`lotBays.ts` `shareOf`). */
export type LotPart = Pick<BuildingElement, 'kind' | 'x' | 'y' | 'w' | 'd' | 'facing' | 'angle' | 'z'>;

export interface LotGrid {
  readonly x0: number;
  readonly y0: number;
  /** Cell size. */
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  /** 1 where a car's centre may not be. */
  readonly blocked: Uint8Array;
  /** Distance to the nearest exit along free cells; Infinity where none is reached. */
  readonly dist: Float32Array;
  /** Which exit each cell's distance leads to (index into the exits given), or -1. */
  readonly exitOf: Int32Array;
}

/** The corners of an element's box in the local frame, turned by its angle. */
function elementCorners(el: LotPart): { x: number; y: number }[] {
  const alongY = el.facing === 0 || el.facing === 2;
  const sx = (alongY ? el.w : el.d) / 2;
  const sy = (alongY ? el.d : el.w) / 2;
  const c = Math.cos(el.angle ?? 0), s = Math.sin(el.angle ?? 0);
  return [[-sx, -sy], [sx, -sy], [sx, sy], [-sx, sy]].map(([a, b]) => ({ x: el.x + a! * c - b! * s, y: el.y + a! * s + b! * c }));
}

/** DO NOT build arrays per cell here */
class RingCover {
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  /** Per side with an axis: ax, ay, the ring's least and greatest projection on it. */
  private readonly sides: Float64Array;
  /** The square's four axes last met, and the ring's extent on each */
  private readonly squareAxes = new Float64Array(16).fill(NaN);

  constructor(ring: readonly { x: number; y: number }[]) {
    const n = ring.length;
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    for (let k = 0; k < n; k++) { this.px[k] = ring[k]!.x; this.py[k] = ring[k]!.y; }
    const sides: number[] = [];
    for (let k = 0; k < n; k++) {
      const p = ring[k]!, q = ring[(k + 1) % n]!;
      const ax = -(q.y - p.y), ay = q.x - p.x;
      if (ax === 0 && ay === 0) continue;
      let b0 = Infinity, b1 = -Infinity;
      for (let v = 0; v < n; v++) { const d = this.px[v]! * ax + this.py[v]! * ay; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      sides.push(ax, ay, b0, b1);
    }
    this.sides = Float64Array.from(sides);
  }

  /** Whether the ring overlaps the cell square from (`cx`, `cy`) `size` across */
  touches(cx: number, cy: number, size: number): boolean {
    // The square's corners: (cx, cy), (x1, cy), (x1, y1), (cx, y1).
    const x1 = cx + size, y1 = cy + size;
    const { px, py } = this;
    // The ring's sides first (their extents are the ring's own); the answer is the same in any order.
    const s = this.sides;
    for (let k = 0; k < s.length; k += 4) {
      if (apart(cx, cy, x1, y1, s[k]!, s[k + 1]!, s[k + 2]!, s[k + 3]!)) return false;
    }
    // The square's sides in order, each axis the difference of a side's corners turned a quarter: (cx, cy) to (x1, cy), to
    for (let k = 0; k < 4; k++) {
      const ax = k === 1 ? -(y1 - cy) : k === 3 ? -(cy - y1) : -0;
      const ay = k === 0 ? x1 - cx : k === 2 ? cx - x1 : 0;
      if (ax === 0 && ay === 0) continue;
      const kept = this.squareAxes;
      if (kept[4 * k] !== ax || kept[4 * k + 1] !== ay) {
        let b0 = Infinity, b1 = -Infinity;
        for (let v = 0; v < px.length; v++) { const d = px[v]! * ax + py[v]! * ay; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
        kept[4 * k] = ax; kept[4 * k + 1] = ay; kept[4 * k + 2] = b0; kept[4 * k + 3] = b1;
      }
      if (apart(cx, cy, x1, y1, ax, ay, kept[4 * k + 2]!, kept[4 * k + 3]!)) return false;
    }
    return true;
  }
}

/** Whether a cell square's projection on an axis and a ring's (`b0`..`b1`) at most touch. */
function apart(cx: number, cy: number, x1: number, y1: number, ax: number, ay: number, b0: number, b1: number): boolean {
  const d0 = cx * ax + cy * ay, d1 = x1 * ax + cy * ay, d2 = x1 * ax + y1 * ay, d3 = cx * ax + y1 * ay;
  const a0 = Math.min(d0, d1, d2, d3), a1 = Math.max(d0, d1, d2, d3);
  return a1 <= b0 || b1 <= a0;
}

/** DO NOT test every cell's centre against every ring again */
function fillRing(solid: Uint8Array, nx: number, ny: number, x0: number, y0: number, cell: number,
  ring: readonly { x: number; y: number }[], xs: number[]): void {
  const n = ring.length;
  let minY = Infinity, maxY = -Infinity;
  for (const p of ring) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  // The rows a side may cross, and one more each way: the crossing test decides.
  const j0 = Math.max(0, Math.floor((minY - y0) / cell - 0.5) - 1);
  const j1 = Math.min(ny - 1, Math.ceil((maxY - y0) / cell - 0.5) + 1);
  for (let j = j0; j <= j1; j++) {
    const y = y0 + (j + 0.5) * cell;
    xs.length = 0;
    for (let i = 0, k = n - 1; i < n; k = i++) {
      const a = ring[i]!, c = ring[k]!;
      if ((a.y > y) !== (c.y > y)) xs.push(((c.x - a.x) * (y - a.y)) / (c.y - a.y) + a.x);
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const row = j * nx;
    for (let e = 0; e + 1 < xs.length; e += 2) {
      const s0 = xs[e]!, s1 = xs[e + 1]!;
      // The first centre at or past s0 (the centres grow with i), then every centre short of s1.
      let i = Math.max(0, Math.min(nx, Math.ceil((s0 - x0) / cell - 0.5)));
      while (i > 0 && x0 + (i - 1 + 0.5) * cell >= s0) i--;
      while (i < nx && x0 + (i + 0.5) * cell < s0) i++;
      for (; i < nx && x0 + (i + 0.5) * cell < s1; i++) solid[row + i] = 1;
    }
  }
}

/** DO NOT spread the disc from every solid cell again */
function growByClearance(solid: Uint8Array, nx: number, ny: number, reach: number): Uint8Array {
  const blocked = solid.slice();
  const r = Math.ceil(reach);
  const offsets: number[] = [];
  for (let dj = -r; dj <= r; dj++) {
    for (let di = -r; di <= r; di++) {
      if ((di === 0 && dj === 0) || di * di + dj * dj >= reach * reach) continue;
      offsets.push(di, dj);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!solid[k]) continue;
      if (i > 0 && i < nx - 1 && j > 0 && j < ny - 1 && solid[k - 1] && solid[k + 1] && solid[k - nx] && solid[k + nx]) continue;
      for (let o = 0; o < offsets.length; o += 2) {
        const a = i + offsets[o]!, c = j + offsets[o + 1]!;
        if (a >= 0 && a < nx && c >= 0 && c < ny) blocked[c * nx + a] = 1;
      }
    }
  }
  return blocked;
}

/** The lot's grid: `walls` are the buildings' footprints already in this building's local frame; `exits` the points */
export function buildLotGrid(b: { readonly elements?: readonly LotPart[] }, lot: LotRect, walls: readonly (readonly { x: number; y: number }[])[],
  exits: readonly { readonly inner: { x: number; y: number }; readonly edge: { x: number; y: number } }[],
  options: LotGridOptions = {}): LotGrid {
  const CELL = options.cell ?? DEFAULT_CELL;
  const CLEARANCE = options.clearance ?? DEFAULT_CLEARANCE;
  const kinds = options.solid ?? SOLID;
  // A person walks under what stands overhead; a car's grid keeps everything of its kinds.
  const overhead = options.solid ? OVERHEAD : Infinity;
  const x0 = lot.x, y0 = lot.y;
  const nx = Math.max(1, Math.ceil(lot.w / CELL)), ny = Math.max(1, Math.ceil(lot.d / CELL));
  const solid = new Uint8Array(nx * ny);
  const solids = (b.elements ?? []).filter((el) => kinds.has(el.kind) && el.z < overhead).map(elementCorners);
  // Solid where a cell's centre is inside a wall (`fillRing`).
  const xs: number[] = [];
  for (const ring of walls) fillRing(solid, nx, ny, x0, y0, CELL, ring, xs);
  // The parts are marked in every cell they touch (a supercover, Red Blob Games "Line drawing on a grid")
  for (const ring of solids) {
    let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
    for (const p of ring) { rx0 = Math.min(rx0, p.x); ry0 = Math.min(ry0, p.y); rx1 = Math.max(rx1, p.x); ry1 = Math.max(ry1, p.y); }
    const i0 = Math.max(0, Math.floor((rx0 - x0) / CELL)), i1 = Math.min(nx - 1, Math.floor((rx1 - x0) / CELL));
    const j0 = Math.max(0, Math.floor((ry0 - y0) / CELL)), j1 = Math.min(ny - 1, Math.floor((ry1 - y0) / CELL));
    if (!(i0 <= i1 && j0 <= j1)) continue;
    const cover = new RingCover(ring);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!solid[j * nx + i] && cover.touches(x0 + i * CELL, y0 + j * CELL, CELL)) solid[j * nx + i] = 1;
      }
    }
  }
  // Grown by the clearance: a free cell is one a car's centre can stand on, `CLEARANCE` from the nearest solid cell's EDGE
  const blocked = growByClearance(solid, nx, ny, (CLEARANCE + CELL / 2) / CELL);
  // Distance from the exits over free cells (Dijkstra, eight neighbours).
  const dist = new Float32Array(nx * ny).fill(Infinity);
  const exitOf = new Int32Array(nx * ny).fill(-1);
  // DO NOT key a heap on `dist[cell]`: a waiting entry's key then falls under it when a shorter way lowers `dist`.
  const heap = new Heap();
  const grid0 = { x0, y0, cell: CELL, nx, ny, blocked };
  exits.forEach((ex, n) => {
    // A way out only where the line to the lot's edge is free: through a gate, not a fence.
    if (!sees(grid0, ex.inner, ex.edge)) return;
    const e = ex.inner;
    const i = Math.floor((e.x - x0) / CELL), j = Math.floor((e.y - y0) / CELL);
    if (i < 0 || i >= nx || j < 0 || j >= ny) return;
    const cell = j * nx + i;
    if (blocked[cell] || dist[cell]! === 0) return;
    dist[cell] = 0;
    exitOf[cell] = n;
    heap.push(cell, 0);
  });
  const done = new Uint8Array(nx * ny);
  while (heap.size > 0) {
    const cell = heap.pop();
    if (done[cell]) continue;
    done[cell] = 1;
    const i = cell % nx, j = (cell - i) / nx;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = i + di, c = j + dj;
        if (a < 0 || a >= nx || c < 0 || c >= ny) continue;
        const n = c * nx + a;
        if (blocked[n] || done[n]) continue;
        // No cutting a blocked corner diagonally.
        if (di && dj && (blocked[j * nx + a] || blocked[c * nx + i])) continue;
        const d = dist[cell]! + (di && dj ? Math.SQRT2 : 1) * CELL;
        if (d < dist[n]!) { dist[n] = d; exitOf[n] = exitOf[cell]!; heap.push(n, dist[n]!); }
      }
    }
  }
  return { x0, y0, cell: CELL, nx, ny, blocked, dist, exitOf };
}

/** The free cell nearest a local point within a few cells, or -1. */
function freeCellNear(g: LotGrid, x: number, y: number): number {
  const i0 = Math.floor((x - g.x0) / g.cell), j0 = Math.floor((y - g.y0) / g.cell);
  let best = -1, bestD = Infinity;
  for (let dj = -3; dj <= 3; dj++) {
    for (let di = -3; di <= 3; di++) {
      const i = i0 + di, j = j0 + dj;
      if (i < 0 || i >= g.nx || j < 0 || j >= g.ny) continue;
      const cell = j * g.nx + i;
      if (g.blocked[cell] || !Number.isFinite(g.dist[cell]!)) continue;
      const d = di * di + dj * dj;
      if (d < bestD) { bestD = d; best = cell; }
    }
  }
  return best;
}

const centre = (g: LotGrid, cell: number): { x: number; y: number } => {
  const i = cell % g.nx;
  return { x: g.x0 + (i + 0.5) * g.cell, y: g.y0 + ((cell - i) / g.nx + 0.5) * g.cell };
};

/** Whether the straight line between two local points crosses only free cells. */
export function sees(g: Pick<LotGrid, "x0" | "y0" | "cell" | "nx" | "ny" | "blocked">, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / (g.cell * 0.5)));
  for (let k = 0; k <= steps; k++) {
    const x = a.x + ((b.x - a.x) * k) / steps, y = a.y + ((b.y - a.y) * k) / steps;
    const i = Math.floor((x - g.x0) / g.cell), j = Math.floor((y - g.y0) / g.cell);
    if (i < 0 || i >= g.nx || j < 0 || j >= g.ny || g.blocked[j * g.nx + i]) return false;
  }
  return true;
}

/** The way from a local point (in front of a stall) down the aisles to the nearest exit */
export function wayOut(g: LotGrid, x: number, y: number): { points: { x: number; y: number }[]; exit: number } | null {
  let cell = freeCellNear(g, x, y);
  if (cell < 0) return null;
  const exit = g.exitOf[cell]!;
  const cells = [cell];
  for (let guard = 0; guard < g.nx * g.ny && g.dist[cell]! > 0; guard++) {
    const i = cell % g.nx, j = (cell - i) / g.nx;
    let next = -1, nd = g.dist[cell]!;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const a = i + di, c = j + dj;
        if ((!di && !dj) || a < 0 || a >= g.nx || c < 0 || c >= g.ny) continue;
        const n = c * g.nx + a;
        if (g.dist[n]! < nd) { nd = g.dist[n]!; next = n; }
      }
    }
    if (next < 0) break;
    cell = next;
    cells.push(cell);
  }
  // String pulling: from each kept point, the farthest cell still in sight.
  const pts = cells.map((c) => centre(g, c));
  const out = [{ x, y }];
  let at = { x, y };
  let k = 0;
  while (k < pts.length - 1) {
    let far = k + 1;
    for (let n = pts.length - 1; n > k + 1; n--) if (sees(g, at, pts[n]!)) { far = n; break; }
    at = pts[far]!;
    out.push(at);
    k = far;
  }
  return { points: out, exit };
}
