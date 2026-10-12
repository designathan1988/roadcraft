import { m } from '@world/units';
import type { Building, BuildingElement, ElementKind } from '@world/buildings/types';

/**
 * Driving inside a car park: a grid over the lot, its cells blocked where a
 * car cannot go (walls, the stalls themselves, fences, hedges, trees, posts),
 * and the distance from every free cell to the nearest way out onto a street.
 * A car leaving its stall follows that distance down the aisles to the exit;
 * one arriving drives the same way in reverse. Grid path planning with a
 * multi-source distance field, as car-park and crowd navigation commonly do;
 * the path is then pulled taut and driven as smooth curves (`manoeuvre.ts`).
 *
 * All coordinates here are the building's local frame (the lot's own axes).
 *
 * The same grid serves a person walking from a lot's gate to its door
 * (`agents/lotDoors.ts`), built for that walker as clearance-based
 * pathfinding builds one per kind of agent (Harabor, "Clearance-based
 * pathfinding", 2009: an agent may use a tile only where the clearance is at
 * least its size, for the terrain it can cross): finer cells, a body's
 * clearance instead of a car's, and stairs and ramps walkable. Built with the
 * car's clearance, a 1.2 m person's gate was shut.
 */

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
export const PEOPLE_SOLID: ReadonlySet<ElementKind> = new Set<ElementKind>([
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
/**
 * A person's grid: 20 cm cells, so a gate's opening (1.3 m between the fence
 * ends at the narrowest, `editor/lotPlan.ts`) keeps free cells after the
 * supercover rounds each fence end out by up to a cell; grown by 0.25 m, the
 * nearest free cell's centre is a cell and a half (0.3 m) from the edge of
 * the solid cell, more than a body's radius (0.27 m, `agents/walk.ts` BODY).
 */
export const PEOPLE_GRID: LotGridOptions = { cell: m(0.2), clearance: m(0.25), solid: PEOPLE_SOLID };

export interface LotRect { readonly x: number; readonly y: number; readonly w: number; readonly d: number }

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
function elementCorners(el: BuildingElement): { x: number; y: number }[] {
  const alongY = el.facing === 0 || el.facing === 2;
  const sx = (alongY ? el.w : el.d) / 2;
  const sy = (alongY ? el.d : el.w) / 2;
  const c = Math.cos(el.angle ?? 0), s = Math.sin(el.angle ?? 0);
  return [[-sx, -sy], [sx, -sy], [sx, sy], [-sx, sy]].map(([a, b]) => ({ x: el.x + a! * c - b! * s, y: el.y + a! * s + b! * c }));
}

/**
 * Whether a convex ring (an element's turned box) overlaps the cell square
 * from (`cx`, `cy`) one `CELL` across: separating axes of the square and of
 * the ring's sides.
 */
function rectTouchesCell(ring: readonly { x: number; y: number }[], cx: number, cy: number, size: number): boolean {
  const sq = [{ x: cx, y: cy }, { x: cx + size, y: cy }, { x: cx + size, y: cy + size }, { x: cx, y: cy + size }];
  for (const poly of [sq, ring]) {
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k]!, q = poly[(k + 1) % poly.length]!;
      const ax = -(q.y - p.y), ay = q.x - p.x;
      if (ax === 0 && ay === 0) continue;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const v of sq) { const d = v.x * ax + v.y * ay; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const v of ring) { const d = v.x * ax + v.y * ay; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (a1 <= b0 || b1 <= a0) return false;
    }
  }
  return true;
}

function inside(ring: readonly { x: number; y: number }[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, c = ring[j]!;
    if ((a.y > y) !== (c.y > y) && x < ((c.x - a.x) * (y - a.y)) / (c.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/**
 * The lot's grid: `walls` are the buildings' footprints already in this
 * building's local frame; `exits` the points (local) cars leave the lot by.
 * `options`: a car's grid when absent; a person's is `PEOPLE_GRID`.
 */
export function buildLotGrid(b: Building, lot: LotRect, walls: readonly (readonly { x: number; y: number }[])[],
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
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * CELL, y = y0 + (j + 0.5) * CELL;
      if (walls.some((ring) => inside(ring, x, y))) solid[j * nx + i] = 1;
    }
  }
  // The parts are marked in every cell they touch (a supercover, Red Blob
  // Games "Line drawing on a grid"): a fence 12 cm thick lies between the
  // centres of cells 75 cm apart, and marked by the centres it covered it was
  // not in the grid at all - cars drove through the boundary, not its gate.
  for (const ring of solids) {
    let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
    for (const p of ring) { rx0 = Math.min(rx0, p.x); ry0 = Math.min(ry0, p.y); rx1 = Math.max(rx1, p.x); ry1 = Math.max(ry1, p.y); }
    const i0 = Math.max(0, Math.floor((rx0 - x0) / CELL)), i1 = Math.min(nx - 1, Math.floor((rx1 - x0) / CELL));
    const j0 = Math.max(0, Math.floor((ry0 - y0) / CELL)), j1 = Math.min(ny - 1, Math.floor((ry1 - y0) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!solid[j * nx + i] && rectTouchesCell(ring, x0 + i * CELL, y0 + j * CELL, CELL)) solid[j * nx + i] = 1;
      }
    }
  }
  // Grown by the clearance: a free cell is one a car's centre can stand on,
  // `CLEARANCE` from the nearest solid cell's EDGE (its centre is half a cell in).
  const blocked = new Uint8Array(nx * ny);
  const reach = (CLEARANCE + CELL / 2) / CELL;
  const r = Math.ceil(reach);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!solid[j * nx + i]) continue;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (di * di + dj * dj >= reach * reach) continue;
          const a = i + di, c = j + dj;
          if (a >= 0 && a < nx && c >= 0 && c < ny) blocked[c * nx + a] = 1;
        }
      }
    }
  }
  // Distance from the exits over free cells (Dijkstra, eight neighbours).
  const dist = new Float32Array(nx * ny).fill(Infinity);
  const exitOf = new Int32Array(nx * ny).fill(-1);
  const heap: number[] = [];
  const push = (cell: number): void => {
    heap.push(cell);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (dist[heap[p]!]! <= dist[heap[k]!]!) break;
      [heap[p], heap[k]] = [heap[k]!, heap[p]!];
      k = p;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const a = 2 * k + 1, c = a + 1;
        let s = k;
        if (a < heap.length && dist[heap[a]!]! < dist[heap[s]!]!) s = a;
        if (c < heap.length && dist[heap[c]!]! < dist[heap[s]!]!) s = c;
        if (s === k) break;
        [heap[s], heap[k]] = [heap[k]!, heap[s]!];
        k = s;
      }
    }
    return top;
  };
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
    push(cell);
  });
  const done = new Uint8Array(nx * ny);
  while (heap.length > 0) {
    const cell = pop();
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
        if (d < dist[n]!) { dist[n] = d; exitOf[n] = exitOf[cell]!; push(n); }
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

/**
 * The way from a local point (in front of a stall) down the aisles to the
 * nearest exit: the cells walked downhill on the distance field, pulled taut
 * so only the turns remain. Null when the point reaches no exit.
 */
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
