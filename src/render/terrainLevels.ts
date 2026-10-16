import { cellHeight } from '@world/groundPatch';

/** HOW FAR EACH LEVEL OF A TERRAIN PLATE STANDS OFF ITS FULL GROUND (CDLOD's quadtree, `terrainLod.ts`): no three.js, the plate's worker reads it too */

/** Cells along a patch, the one grid a plate instances; a quadtree node is 2 x 2 patches, so its grid is even and its odd corners morph onto even ones. */
export const LOD_PATCH = 10;
/** Levels: 0 reads every corner of the plate, each next level every other corner of the one before. */
export const LOD_LEVELS = 5;
/** Cells along a node of level 0. */
export const LOD_NODE = 2 * LOD_PATCH;

/** Nodes along a side at each level. */
function nodesAt(seg: number, level: number): number {
  return seg / (LOD_NODE << level);
}

/** Each node's lowest and highest corner and how far its level stands off the plate's full ground, per level (`[lo, hi, err]` a node) */
export class LandLevels {
  /** Level 0's nodes first, then each next level's: `[lo, hi, err]` a node. */
  readonly data: Float32Array;
  /** The plate's worst error at each level (metres), as `measure` left it. */
  readonly worst = new Float64Array(LOD_LEVELS);
  private readonly first: number[] = [];
  private readonly dirty: Uint8Array[] = [];
  private readonly seg: number;
  private readonly n: number;

  constructor(seg: number) {
    if (nodesAt(seg, LOD_LEVELS - 1) !== 1) throw new Error(`a plate of ${seg} cells is not ${LOD_LEVELS} levels of ${LOD_NODE}-cell nodes`);
    this.seg = seg;
    this.n = seg + 1;
    let count = 0;
    for (let level = 0; level < LOD_LEVELS; level++) {
      this.first.push(count);
      const side = nodesAt(seg, level);
      count += side * side;
      this.dirty.push(new Uint8Array(side * side));
    }
    this.data = new Float32Array(count * 3);
  }

  /** The nodes as measured elsewhere (the plate's worker, `plateMesh.ts`), every mark cleared. */
  take(data: Float32Array): void {
    this.data.set(data);
    for (const d of this.dirty) d.fill(0);
    this.sumUp();
  }

  /** The node's lowest corner, highest corner and error. */
  lo(level: number, nx: number, ny: number): number { return this.data[(this.first[level]! + nx + ny * nodesAt(this.seg, level)) * 3]!; }
  hi(level: number, nx: number, ny: number): number { return this.data[(this.first[level]! + nx + ny * nodesAt(this.seg, level)) * 3 + 1]!; }

  /** The nodes holding a box of corners or the cells round it (their diagonals follow those corners) marked to be measured again. */
  markBox(x0: number, x1: number, y0: number, y1: number): void {
    const side = nodesAt(this.seg, 0);
    const nx0 = Math.max(0, Math.floor((x0 - 1) / LOD_NODE)), nx1 = Math.min(side - 1, Math.floor((x1 + 1) / LOD_NODE));
    const ny0 = Math.max(0, Math.floor((y0 - 1) / LOD_NODE)), ny1 = Math.min(side - 1, Math.floor((y1 + 1) / LOD_NODE));
    for (let ny = ny0; ny <= ny1; ny++) for (let nx = nx0; nx <= nx1; nx++) this.dirty[0]![nx + ny * side] = 1;
  }

  /** The nodes holding corner `i` marked to be measured again. */
  markCorner(i: number): void {
    const ix = i % this.n, iy = (i - ix) / this.n;
    this.markBox(ix, ix, iy, iy);
  }

  /** Every node marked. */
  markAll(): void {
    for (const d of this.dirty) d.fill(1);
  }

  /** The marked nodes measured again from the drawn corners and diagonals, and each level's worst error with them. */
  measure(heights: ArrayLike<number>, flip: ArrayLike<number>): void {
    const n = this.n;
    for (let level = 0; level < LOD_LEVELS; level++) {
      const side = nodesAt(this.seg, level);
      const span = LOD_NODE << level;
      const marks = this.dirty[level]!;
      const up = level + 1 < LOD_LEVELS ? this.dirty[level + 1]! : null;
      const upSide = side >> 1;
      for (let ny = 0; ny < side; ny++) {
        for (let nx = 0; nx < side; nx++) {
          const k = nx + ny * side;
          if (!marks[k]) continue;
          marks[k] = 0;
          if (up) up[(nx >> 1) + (ny >> 1) * upSide] = 1;
          const o = (this.first[level]! + k) * 3;
          if (level === 0) {
            let lo = Infinity, hi = -Infinity;
            for (let j = ny * span; j <= (ny + 1) * span; j++) {
              for (let i = nx * span; i <= (nx + 1) * span; i++) {
                const h = heights[i + j * n] as number;
                if (h < lo) lo = h;
                if (h > hi) hi = h;
              }
            }
            this.data[o] = lo; this.data[o + 1] = hi; this.data[o + 2] = 0;
            continue;
          }
          // A node's error: its children's worst and how far its own level parts from theirs (the triangle inequality).
          let lo = Infinity, hi = -Infinity, err = 0;
          const below = this.first[level - 1]!, belowSide = side * 2;
          for (let q = 0; q < 4; q++) {
            const c = (below + (nx * 2 + (q & 1)) + (ny * 2 + (q >> 1)) * belowSide) * 3;
            lo = Math.min(lo, this.data[c]!); hi = Math.max(hi, this.data[c + 1]!); err = Math.max(err, this.data[c + 2]!);
          }
          this.data[o] = lo; this.data[o + 1] = hi;
          this.data[o + 2] = err + parting(heights, flip, n, this.seg, level, nx * span, ny * span, span);
        }
      }
    }
    this.sumUp();
  }

  /** Each level's worst error over its nodes. */
  private sumUp(): void {
    for (let level = 0; level < LOD_LEVELS; level++) {
      const side = nodesAt(this.seg, level);
      let worst = 0;
      for (let k = 0; k < side * side; k++) worst = Math.max(worst, this.data[(this.first[level]! + k) * 3 + 2]!);
      this.worst[level] = worst;
    }
  }
}

/** The height range of a cell of `step` corners at a point of it (corner units), over both its diagonals: the shader picks one by its own floats. */
function coarseRange(h: ArrayLike<number>, n: number, seg: number, step: number, x: number, y: number, out: { lo: number; hi: number }): void {
  const cx = Math.min(seg / step - 1, Math.floor(x / step)), cy = Math.min(seg / step - 1, Math.floor(y / step));
  const x0 = cx * step, y0 = cy * step;
  const u = (x - x0) / step, v = (y - y0) / step;
  const a = h[x0 + y0 * n] as number, b = h[x0 + (y0 + step) * n] as number;
  const c = h[x0 + step + (y0 + step) * n] as number, d = h[x0 + step + y0 * n] as number;
  const p = cellHeight(a, b, c, d, u, v, 0), q = cellHeight(a, b, c, d, u, v, 1);
  out.lo = Math.min(p, q); out.hi = Math.max(p, q);
}

const fineAt = { lo: 0, hi: 0 };
const coarseAt = { lo: 0, hi: 0 };
/** How far level `level` parts from level `level - 1` over a node: read at the finer level's corners and cell centres, where two piecewise-planar grounds part most. */
function parting(h: ArrayLike<number>, flip: ArrayLike<number>, n: number, seg: number, level: number, x0: number, y0: number, span: number): number {
  const s = 1 << (level - 1), coarse = s << 1;
  let most = 0;
  const take = (x: number, y: number): void => {
    coarseRange(h, n, seg, coarse, x, y, coarseAt);
    most = Math.max(most, coarseAt.hi - fineAt.lo, fineAt.hi - coarseAt.lo);
  };
  for (let j = 0; j <= span; j += s) {
    for (let i = 0; i <= span; i += s) {
      const x = x0 + i, y = y0 + j;
      fineAt.lo = fineAt.hi = h[x + y * n] as number;
      take(x, y);
      if (i === span || j === span) continue;
      // The finer cell's centre: its own diagonal at level 0, either one above.
      const a = h[x + y * n] as number, b = h[x + (y + s) * n] as number, c = h[x + s + (y + s) * n] as number, d = h[x + s + y * n] as number;
      if (s === 1) fineAt.lo = fineAt.hi = cellHeight(a, b, c, d, 0.5, 0.5, flip[x + y * seg] as number);
      else { fineAt.lo = Math.min(a + c, b + d) / 2; fineAt.hi = Math.max(a + c, b + d) / 2; }
      take(x + s / 2, y + s / 2);
    }
  }
  return most;
}
