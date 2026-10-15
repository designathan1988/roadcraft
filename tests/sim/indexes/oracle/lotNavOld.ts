// The lot's grid as built before 2026-10-15 (src/sim/agents/lotNav.ts at 8434df1)
import { Heap } from '@core/heap';
import { sees } from '@sim/agents/lotNav';
import { m } from '@world/units';
import type { Building, BuildingElement, ElementKind } from '@world/buildings/types';

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
/** Parts this high off the ground or more stand over a walker's head (a canopy's wall, a sign). */
const OVERHEAD = m(2.1);

/** The grid's make for one kind of agent: its cell, the clearance its centre keeps, what is solid to it. */
interface LotGridOptions {
  readonly cell?: number;
  readonly clearance?: number;
  readonly solid?: ReadonlySet<ElementKind>;
}

interface LotRect { readonly x: number; readonly y: number; readonly w: number; readonly d: number }

interface LotGrid {
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

/** Whether a convex ring (an element's turned box) overlaps the cell square from (`cx`, `cy`) one `CELL` across */
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

/** The lot's grid: `walls` are the buildings' footprints already in this building's local frame; `exits` the points */
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
  // The parts are marked in every cell they touch (a supercover, Red Blob Games "Line drawing on a grid")
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
  // Grown by the clearance: a free cell is one a car's centre can stand on, `CLEARANCE` from the nearest solid cell's EDGE
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
