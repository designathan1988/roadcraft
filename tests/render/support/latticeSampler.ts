import { FLAG_DASHED, FLAG_LEVEL, FLAG_FILL, FLAG_INSIDE, FLAG_STROKE, LOT_CELL, DASH, GAP, TEXTURE_WIDTH, TILE_CELLS, type LotLattice } from '@render/lotLattice';

/** The shader of `render/lotOverlay.ts` (`lotOver`) in TypeScript, for the tests: what a pixel of the ground at world */
export interface LatticeHit {
  /** Per shape listed in the cell: its fill and stroke colours, whether the point is inside, the distance to its nearest edge. */
  readonly records: { fill: number; line: number; inside: boolean; distance: number; halfWidth: number; flags: number; level: number | null }[];
}

const u32 = new Uint32Array(1);
const f32 = new Float32Array(u32.buffer);
const bitsFloat = (b: number): number => { u32[0] = b; return f32[0]!; };
const fround = Math.fround;

function halfFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

const cross = (ux: number, uy: number, vx: number, vy: number): number => ux * vy - uy * vx;

export function sampleLattice(lattice: LotLattice, x: number, y: number): LatticeHit | null {
  const data = lattice.data;
  const texel = (a: number, k: number): number => data[a * 4 + k]!;
  void TEXTURE_WIDTH;
  const gx = (x - lattice.x0) / LOT_CELL, gy = (y - lattice.y0) / LOT_CELL;
  if (gx < 0 || gy < 0 || gx >= lattice.cellsPerSide || gy >= lattice.cellsPerSide) return null;
  const cx = Math.floor(gx), cy = Math.floor(gy);
  const tx = Math.floor(cx / TILE_CELLS), ty = Math.floor(cy / TILE_CELLS);
  const tile = ty * lattice.tilesPerSide + tx;
  const block = texel(tile >> 2, tile & 3);
  if (block === 0) return null;
  const local = (cy - ty * TILE_CELLS) * TILE_CELLS + (cx - tx * TILE_CELLS);
  const entry = texel(block + (local >> 2), local & 3);
  let count = entry & 255;
  if (count === 0) return null;
  let at = entry >>> 8;
  if (count === 255) { count = texel(at, 0); at += 1; }
  const px = fround(x - lattice.x0 - (cx + 0.5) * LOT_CELL), py = fround(y - lattice.y0 - (cy + 0.5) * LOT_CELL);
  const records: LatticeHit['records'] = [];
  for (let r = 0; r < count; r++) {
    const hz = texel(at, 2), hw = texel(at, 3);
    const fill = texel(at, 0), line = texel(at, 1);
    at += 1;
    const n = hz & 1023, flags = (hz >>> 10) & 63;
    let level: number | null = null;
    if (flags & FLAG_LEVEL) { level = bitsFloat(texel(at, 0)); at += 1; }
    const halfWidth = halfFloat(hz >>> 16);
    const rx = halfFloat(hw & 0xffff), ry = halfFloat(hw >>> 16);
    let inside = (flags & FLAG_INSIDE) !== 0;
    const dashed = (flags & FLAG_DASHED) !== 0;
    let best = 1e9;
    const rpx = px - rx, rpy = py - ry;
    for (let e = 0; e < n; e++) {
      const ax = bitsFloat(texel(at + e, 0)), ay = bitsFloat(texel(at + e, 1));
      const bx = bitsFloat(texel(at + e, 2)), by = bitsFloat(texel(at + e, 3));
      const abx = bx - ax, aby = by - ay;
      if (((cross(abx, aby, rx - ax, ry - ay) > 0) !== (cross(abx, aby, px - ax, py - ay) > 0))
        && ((cross(rpx, rpy, ax - rx, ay - ry) > 0) !== (cross(rpx, rpy, bx - rx, by - ry) > 0))) inside = !inside;
      const len2 = abx * abx + aby * aby;
      let s = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
      if (dashed && len2 > 0) {
        const len = Math.sqrt(len2);
        let along = s * len;
        const d0 = Math.floor(along / (DASH + GAP)) * (DASH + GAP);
        const d1 = Math.min(d0 + DASH, len);
        const next = d0 + DASH + GAP;
        along = (along > d1 && next < len && next - along < along - d1) ? next : Math.min(Math.max(along, d0), d1);
        s = along / len;
      }
      s = Math.min(Math.max(s, 0), 1);
      const d = Math.hypot(px - (ax + abx * s), py - (ay + aby * s));
      if (d < best) best = d;
    }
    at += n;
    records.push({ fill: (flags & FLAG_FILL) ? fill : 0, line: (flags & FLAG_STROKE) ? line : 0, inside, distance: best, halfWidth, flags, level });
  }
  return { records };
}
