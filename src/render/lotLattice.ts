/** DO NOT go back to triangulating each lot and laying every vertex on the ground */

/** Metres a side of a lattice cell: a few shapes each where lots are smallest. */
export const LOT_CELL = 8;
/** Cells a side of a tile: the index is kept only where there are shapes. */
export const TILE_CELLS = 16;
/** Texels a row of the texture. */
export const TEXTURE_WIDTH = 2048;
/** How far past a cell an edge is still listed in it, beyond its stroke's half width */
export const AA_MARGIN = 1.5;
/** A dashed line: dash and gap, metres. */
export const DASH = 2;
export const GAP = 1.2;

export const FLAG_FILL = 1;
export const FLAG_INSIDE = 2;
export const FLAG_DASHED = 4;
export const FLAG_STROKE = 8;
export const FLAG_BUTT = 16;
export const FLAG_LEVEL = 32;

/** One thing drawn on the ground. */
export interface LatticeShape {
  /** Edges, four numbers each (ax, ay, bx, by), world metres; a dot is one edge of no length. */
  readonly edges: Float64Array;
  /** RGBA8 of the fill (sRGB colour, linear alpha), 0 for none. Only a closed ring is filled. */
  readonly fill: number;
  /** RGBA8 of the stroke along the edges, 0 for none. */
  readonly line: number;
  /** Half the stroke's width, metres (a dot: its radius). */
  readonly halfWidth: number;
  readonly dashed: boolean;
  /** A line with square ends (its one edge); otherwise round at its ends and corners (an outline, a dot). */
  readonly butt: boolean;
  /** A built lot's ground level (world height, metres): the buildings' materials colour their level surfaces near it */
  readonly level?: number;
  /** Drawing order: later over earlier (fills all under the strokes). */
  order: number;
}

/** A shape as the lattice keeps it: the records it wrote, by cell. */
interface Placed {
  readonly shape: LatticeShape;
  readonly records: Map<number, Uint32Array>;
}

/** Where a cell's stream lies. */
interface Stream { at: number; length: number }

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const floatBits = (v: number): number => { f32[0] = v; return u32[0]!; };

/** IEEE half float bits of `v` (round to nearest even; no NaN). */
export function halfBits(v: number): number {
  f32[0] = v;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let h = mant >>> shift;
    const rest = mant & ((1 << shift) - 1), halfway = 1 << (shift - 1);
    if (rest > halfway || (rest === halfway && (h & 1))) h++;
    return sign | h;
  }
  let h = (exp << 10) | (mant >>> 13);
  const rest = mant & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (h & 1))) h++;
  return sign | h;
}

/** Points tried as a cell's reference, metres from its centre */
const REFERENCES: readonly (readonly [number, number])[] = [
  [0, 0], [0.5625, 0.3125], [-0.4375, 0.6875], [0.3125, -0.8125], [-0.9375, -0.5625],
  [1.6875, 1.1875], [-1.8125, 1.4375], [1.4375, -1.9375], [-1.5625, -1.6875], [2.5625, 0.0625],
];
/** The least a reference keeps from every edge (metres): its side is never in doubt. */
const REFERENCE_CLEAR = 0.01;

/** Distance from point (px, py) to segment (ax, ay)-(bx, by). */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2)) : 0;
  return Math.hypot(px - ax - abx * t, py - ay - aby * t);
}

/** Whether segment (ax, ay)-(bx, by) comes within `r` of the box [x0, y0]-[x1, y1]. */
function segmentNearBox(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  // The box grown by r, then the segment clipped to it (Liang-Barsky)
  const gx0 = x0 - r, gy0 = y0 - r, gx1 = x1 + r, gy1 = y1 + r;
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, ax - gx0) && clip(dx, gx1 - ax) && clip(-dy, ay - gy0) && clip(dy, gy1 - ay);
}

/** Even-odd: whether (px, py) is inside the ring the edges close (half-open crossing rule). */
function insideEdges(edges: Float64Array, px: number, py: number): boolean {
  let inside = false;
  for (let i = 0; i < edges.length; i += 4) {
    const ax = edges[i]!, ay = edges[i + 1]!, bx = edges[i + 2]!, by = edges[i + 3]!;
    if ((ay > py) !== (by > py) && px < ax + (py - ay) / (by - ay) * (bx - ax)) inside = !inside;
  }
  return inside;
}

export class LotLattice {
  readonly cellsPerSide: number;
  readonly tilesPerSide: number;
  /** Texels of the tile table at the start of the texture. */
  private readonly tableTexels: number;
  /** The texture's texels, four uint32 each; replaced when it grows. */
  data: Uint32Array;
  private top: number;
  /** Texels held by blocks and streams in use (the rest below `top` is garbage). */
  private live = 0;
  private readonly blocks: Int32Array;
  private readonly streams = new Map<number, Stream>();
  private readonly cellShapes = new Map<number, Set<Placed>>();
  private readonly placed = new Map<LatticeShape, Placed>();
  private readonly dirty = new Set<number>();
  /** Texel ranges written since the last `takeUpload` ([start, count] pairs). */
  private written: number[] = [];
  /** The whole texture to send (it grew, or was compacted). */
  private wholeChanged = true;

  /** The frame's low corner (world x, y): a square of `2 half` centred on (`cx`, `cy`), anywhere on the world. */
  readonly x0: number;
  readonly y0: number;

  constructor(readonly half: number, initialRows = 16, cx = 0, cy = 0) {
    this.x0 = cx - half;
    this.y0 = cy - half;
    this.cellsPerSide = Math.ceil((2 * half) / LOT_CELL);
    this.tilesPerSide = Math.ceil(this.cellsPerSide / TILE_CELLS);
    this.tableTexels = Math.ceil((this.tilesPerSide * this.tilesPerSide) / 4);
    this.blocks = new Int32Array(this.tilesPerSide * this.tilesPerSide);
    const rows = Math.max(initialRows, Math.ceil((this.tableTexels + 1) / TEXTURE_WIDTH) * 2);
    this.data = new Uint32Array(TEXTURE_WIDTH * rows * 4);
    this.top = this.tableTexels;
  }

  get rows(): number { return this.data.length / 4 / TEXTURE_WIDTH; }
  /** Shapes held. */
  get size(): number { return this.placed.size; }
  /** Cells whose records were written since made (a probe of the work an edit costs). */
  cellsWritten = 0;

  /** A shape's records written into every cell it reaches; the cells rewritten at `flush`. */
  add(shape: LatticeShape): void {
    if (this.placed.has(shape)) return;
    const records = this.records(shape);
    const placed: Placed = { shape, records };
    this.placed.set(shape, placed);
    for (const cell of records.keys()) {
      let set = this.cellShapes.get(cell);
      if (!set) this.cellShapes.set(cell, set = new Set());
      set.add(placed);
      this.dirty.add(cell);
    }
  }

  /** A shape taken out of the cells it was in. */
  remove(shape: LatticeShape): void {
    const placed = this.placed.get(shape);
    if (!placed) return;
    this.placed.delete(shape);
    for (const cell of placed.records.keys()) {
      const set = this.cellShapes.get(cell);
      if (set) { set.delete(placed); if (set.size === 0) this.cellShapes.delete(cell); }
      this.dirty.add(cell);
    }
  }

  /** Every shape gone, the texture empty. */
  clear(): void {
    this.placed.clear();
    this.cellShapes.clear();
    this.streams.clear();
    this.dirty.clear();
    this.blocks.fill(0);
    this.data.fill(0);
    this.top = this.tableTexels;
    this.live = 0;
    this.written = [];
    this.wholeChanged = true;
  }

  /** The cells shapes were added to or taken from, written again in drawing order. */
  flush(): void {
    for (const cell of this.dirty) this.writeCell(cell);
    this.dirty.clear();
  }

  /** What to send to the GPU since the last call: everything */
  takeUpload(): { whole: boolean; ranges: number[] } {
    const whole = this.wholeChanged;
    const ranges: number[] = [];
    if (!whole) {
      for (let i = 0; i < this.written.length; i += 2) {
        let start = this.written[i]!, count = this.written[i + 1]!;
        while (count > 0) {
          const inRow = Math.min(count, TEXTURE_WIDTH - (start % TEXTURE_WIDTH));
          ranges.push(start * 4, inRow * 4);
          start += inRow; count -= inRow;
        }
      }
    }
    this.written = [];
    this.wholeChanged = false;
    return { whole, ranges };
  }

  // ------------------------------------------------------------ records

  /** A shape's record for every cell it reaches. */
  private records(shape: LatticeShape): Map<number, Uint32Array> {
    const out = new Map<number, Uint32Array>();
    const { edges } = shape;
    const stroke = shape.line !== 0 && shape.halfWidth > 0;
    const filled = shape.fill !== 0 && edges.length >= 12;
    if (!stroke && !filled) return out;
    const reach = (stroke ? shape.halfWidth : 0) + AA_MARGIN;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < edges.length; i += 2) {
      const x = edges[i]!, y = edges[i + 1]!;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const n = this.cellsPerSide;
    const cx0 = Math.max(0, Math.floor((x0 - reach - this.x0) / LOT_CELL));
    const cy0 = Math.max(0, Math.floor((y0 - reach - this.y0) / LOT_CELL));
    const cx1 = Math.min(n - 1, Math.floor((x1 + reach - this.x0) / LOT_CELL));
    const cy1 = Math.min(n - 1, Math.floor((y1 + reach - this.y0) / LOT_CELL));
    const near: number[] = [];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bx0 = cx * LOT_CELL + this.x0, by0 = cy * LOT_CELL + this.y0;
        const bx1 = bx0 + LOT_CELL, by1 = by0 + LOT_CELL;
        near.length = 0;
        for (let i = 0; i < edges.length; i += 4) {
          if (segmentNearBox(edges[i]!, edges[i + 1]!, edges[i + 2]!, edges[i + 3]!, bx0, by0, bx1, by1, reach)) near.push(i);
        }
        const mx = bx0 + LOT_CELL / 2, my = by0 + LOT_CELL / 2;
        let flags = (filled ? FLAG_FILL : 0) | (stroke ? FLAG_STROKE : 0) | (shape.dashed ? FLAG_DASHED : 0) | (shape.butt ? FLAG_BUTT : 0);
        let refX = 0, refY = 0;
        if (near.length === 0) {
          // Away from every edge: only a fill whose inside holds the cell draws here.
          if (!filled || !insideEdges(edges, mx, my)) continue;
          flags |= FLAG_INSIDE;
        } else if (filled) {
          const ref = REFERENCES.find(([dx, dy]) => near.every((i) =>
            segmentDistance(mx + dx, my + dy, edges[i]!, edges[i + 1]!, edges[i + 2]!, edges[i + 3]!) >= REFERENCE_CLEAR));
          // Ten points a few metres apart all on edges cannot happen with real lots.
          if (!ref) throw new Error('lot lattice: no clear reference point in a cell');
          [refX, refY] = ref;
          if (insideEdges(edges, mx + refX, my + refY)) flags |= FLAG_INSIDE;
        }
        if (near.length > 1023) throw new Error('lot lattice: more than 1023 edges of one shape in a cell');
        const level = shape.level !== undefined;
        if (level) flags |= FLAG_LEVEL;
        const record = new Uint32Array((1 + (level ? 1 : 0) + near.length) * 4);
        record[0] = shape.fill >>> 0;
        record[1] = shape.line >>> 0;
        record[2] = (near.length | (flags << 10) | (halfBits(shape.halfWidth) << 16)) >>> 0;
        record[3] = (halfBits(refX) | (halfBits(refY) << 16)) >>> 0;
        let k = 4;
        if (level) { record[4] = floatBits(shape.level!); k = 8; }
        for (const i of near) {
          record[k++] = floatBits(edges[i]! - mx);
          record[k++] = floatBits(edges[i + 1]! - my);
          record[k++] = floatBits(edges[i + 2]! - mx);
          record[k++] = floatBits(edges[i + 3]! - my);
        }
        out.set(cy * n + cx, record);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ the texture

  /** A cell's stream written again: its shapes' records in drawing order, at the top. */
  private writeCell(cell: number): void {
    this.cellsWritten++;
    const before = this.streams.get(cell);
    if (before) { this.live -= before.length; this.streams.delete(cell); }
    const set = this.cellShapes.get(cell);
    const cx = cell % this.cellsPerSide, cy = (cell - cx) / this.cellsPerSide;
    const tile = Math.floor(cy / TILE_CELLS) * this.tilesPerSide + Math.floor(cx / TILE_CELLS);
    const local = (cy % TILE_CELLS) * TILE_CELLS + (cx % TILE_CELLS);
    if (!set || set.size === 0) {
      const block = this.blocks[tile]!;
      if (block) this.setEntry(block, local, 0);
      return;
    }
    const shapes = [...set].sort((a, b) => a.shape.order - b.shape.order);
    const count = shapes.length;
    const long = count >= 255;
    let length = long ? 1 : 0;
    for (const p of shapes) length += p.records.get(cell)!.length / 4;
    const blockSize = TILE_CELLS * TILE_CELLS / 4;
    // Room for both first: a compaction between the two would move one and not the other.
    this.reserve(length + blockSize);
    if (!this.blocks[tile]) {
      const block = this.alloc(blockSize);
      this.blocks[tile] = block;
      this.live += blockSize;
      this.data.fill(0, block * 4, (block + blockSize) * 4);
      this.mark(block, blockSize);
      this.setTable(tile, block);
    }
    const at = this.alloc(length);
    if (at >= 1 << 24) throw new Error('lot lattice: stream address past 24 bits');
    this.live += length;
    let k = at * 4;
    if (long) { this.data[k] = count; this.data[k + 1] = 0; this.data[k + 2] = 0; this.data[k + 3] = 0; k += 4; }
    for (const p of shapes) { const r = p.records.get(cell)!; this.data.set(r, k); k += r.length; }
    this.mark(at, length);
    this.streams.set(cell, { at, length });
    this.setEntry(this.blocks[tile]!, local, ((at << 8) | (long ? 255 : count)) >>> 0);
  }

  private setEntry(block: number, local: number, value: number): void {
    const texel = block + (local >> 2);
    this.data[texel * 4 + (local & 3)] = value;
    this.mark(texel, 1);
  }

  private setTable(tile: number, block: number): void {
    this.data[(tile >> 2) * 4 + (tile & 3)] = block;
    this.mark(tile >> 2, 1);
  }

  private mark(start: number, count: number): void {
    if (this.wholeChanged) return;
    const n = this.written.length;
    // Contiguous with the last range written (a stream after its block): one range.
    if (n && this.written[n - 2]! + this.written[n - 1]! === start) this.written[n - 1]! += count;
    else this.written.push(start, count);
  }

  /** Room for `length` texels at the top: the texture compacted, or grown, when full. */
  private reserve(length: number): void {
    if (this.top + length <= this.data.length / 4) return;
    // More garbage than live texels: compacted, which moves each live texel once for at least as many texels thrown away
    const used = this.top - this.tableTexels;
    if (used - this.live > this.live) this.compact();
    if (this.top + length > this.data.length / 4) this.grow(this.top + length);
  }

  /** `length` texels at the top (`reserve` made room). */
  private alloc(length: number): number {
    const at = this.top;
    this.top += length;
    return at;
  }

  private grow(needed: number): void {
    let rows = this.rows;
    while (rows * TEXTURE_WIDTH < needed * 1.25) rows *= 2;
    const data = new Uint32Array(TEXTURE_WIDTH * rows * 4);
    data.set(this.data);
    this.data = data;
    this.wholeChanged = true;
    this.written = [];
  }

  /** Every block and stream in use moved down together, in a fresh array of the same size. */
  private compact(): void {
    const old = this.data;
    const data = new Uint32Array(old.length);
    this.data = data;
    this.top = this.tableTexels;
    this.live = 0;
    const blockSize = TILE_CELLS * TILE_CELLS / 4;
    const oldBlocks = Int32Array.from(this.blocks);
    this.blocks.fill(0);
    // The tiles that still have a stream keep a block; the entries are rewritten below.
    for (const cell of this.streams.keys()) {
      const cx = cell % this.cellsPerSide, cy = (cell - cx) / this.cellsPerSide;
      const tile = Math.floor(cy / TILE_CELLS) * this.tilesPerSide + Math.floor(cx / TILE_CELLS);
      if (this.blocks[tile]) continue;
      const block = this.top;
      this.top += blockSize;
      this.live += blockSize;
      this.blocks[tile] = block;
      data[(tile >> 2) * 4 + (tile & 3)] = block;
    }
    for (const [cell, stream] of this.streams) {
      const at = this.top;
      data.set(old.subarray(stream.at * 4, (stream.at + stream.length) * 4), at * 4);
      this.top += stream.length;
      this.live += stream.length;
      const cx = cell % this.cellsPerSide, cy = (cell - cx) / this.cellsPerSide;
      const tile = Math.floor(cy / TILE_CELLS) * this.tilesPerSide + Math.floor(cx / TILE_CELLS);
      const local = (cy % TILE_CELLS) * TILE_CELLS + (cx % TILE_CELLS);
      const oldEntry = old[(oldBlocks[tile]! + (local >> 2)) * 4 + (local & 3)]!;
      data[(this.blocks[tile]! + (local >> 2)) * 4 + (local & 3)] = ((at << 8) | (oldEntry & 255)) >>> 0;
      stream.at = at;
    }
    this.wholeChanged = true;
    this.written = [];
  }
}
