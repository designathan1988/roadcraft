import type { MultiPoly, Poly, Ring } from '@core/clipper';
import { m } from './units';

/**
 * THE PAVING NEAR A LOT (`lots.ts` `onLand`: a lot cut back to the land).
 * A town's paving is one piece - the footways of every street joined - whose
 * holes are its blocks: 541 rings and 4 989 points round a town of 5 400
 * lots, and the boolean difference of every lot with all of it was 35 s of
 * the 150 s a town of 2 560 m took to grow (2026-10-14). Within a lot's box
 * only what reaches the box counts: the blocks whose boxes meet it (found in
 * a grid of their boxes, spatial hashing), and the outer ring - itself where
 * one of its edges crosses the box, else the box (the ring holds it) or
 * nothing (it does not). The same region inside the box from the same
 * points, so the same cut.
 *
 * NO TILES CUT OUT OF THE PAVING: Clipper2's `RectClip` is O(n) and keeps
 * each ring's winding (angusj.com/clipper2, RectClip), but every tile would
 * work out its own seam points, and two tiles of different sizes rounding
 * a seam point apart leave a sliver of "land" 0.04 mm wide - a spike in the
 * lot cut along it. Nothing here is clipped; rings are taken whole.
 */

type Box = readonly [number, number, number, number];

/** Side of the grid the rings are filed in, world units. */
const CELL = m(64);
/** Room round the box asked for: the sides of the box put in for the outer ring stay off the lot's. */
const MARGIN = m(1);

const cellOf = (v: number): number => Math.floor(v / CELL);
const cellKey = (i: number, j: number): number => (i + 32768) * 65536 + (j + 32768);

function ringBox(ring: Ring): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) { x0 = Math.min(x0, x!); y0 = Math.min(y0, y!); x1 = Math.max(x1, x!); y1 = Math.max(y1, y!); }
  return [x0, y0, x1, y1];
}

/** Whether (x, y) lies inside the ring (even-odd, `core/polygon.ts` pointInPolygon). */
function insideRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!, xj = ring[j]![0]!, yj = ring[j]![1]!;
    if (yi > y === yj > y) continue;
    if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Every cell a box covers. */
function eachCell(box: Box, visit: (key: number) => void): void {
  const i1 = cellOf(box[2]), j1 = cellOf(box[3]);
  for (let i = cellOf(box[0]); i <= i1; i++) for (let j = cellOf(box[1]); j <= j1; j++) visit(cellKey(i, j));
}

interface Piece {
  readonly poly: Poly;
  /** Its outer ring's box (what `onLand` tested). */
  readonly box: Box;
  /** The cells an edge of the outer ring passes through (by the edge's box). */
  readonly edgeCells: ReadonlySet<number>;
  /** Its holes (rings 1 on) by the cells their boxes cover, and their boxes. */
  readonly holeCells: ReadonlyMap<number, readonly number[]>;
  readonly holeBoxes: readonly Box[];
}

function indexPiece(poly: Poly): Piece {
  const outer = poly[0] ?? [];
  const edgeCells = new Set<number>();
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const a = outer[j]!, b = outer[i]!;
    eachCell([Math.min(a[0]!, b[0]!), Math.min(a[1]!, b[1]!), Math.max(a[0]!, b[0]!), Math.max(a[1]!, b[1]!)], (k) => edgeCells.add(k));
  }
  const holeCells = new Map<number, number[]>();
  const holeBoxes = poly.slice(1).map(ringBox);
  holeBoxes.forEach((box, h) => eachCell(box, (k) => {
    const list = holeCells.get(k);
    if (list) list.push(h); else holeCells.set(k, [h]);
  }));
  return { poly, box: ringBox(outer), edgeCells, holeCells, holeBoxes };
}

export class PavingIndex {
  private readonly pieces: readonly Piece[];

  constructor(paving: MultiPoly) {
    this.pieces = paving.map(indexPiece);
  }

  /**
   * The paving within the box [x0, y0, x1, y1]: the same region there, from
   * the same points; null when no piece's box meets the box (`onLand` keeps
   * such a lot as drawn).
   */
  near(x0: number, y0: number, x1: number, y1: number): MultiPoly | null {
    let met = false;
    const out: MultiPoly = [];
    const box: Box = [x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN];
    for (const piece of this.pieces) {
      const b = piece.box;
      if (!(b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0)) continue;
      met = true;
      const outer = piece.poly[0]!;
      let crossed = outer.length < 3;
      eachCell(box, (k) => { if (piece.edgeCells.has(k)) crossed = true; });
      let first: Ring;
      if (crossed) first = outer;
      else if (insideRing(outer, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2)) first = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]];
      // Outside the piece's outer ring, and so outside its holes too: none of it here.
      else continue;
      const holes = new Set<number>();
      eachCell(box, (k) => {
        for (const h of piece.holeCells.get(k) ?? []) {
          const hb = piece.holeBoxes[h]!;
          if (hb[0] <= box[2] && hb[2] >= box[0] && hb[1] <= box[3] && hb[3] >= box[1]) holes.add(h);
        }
      });
      out.push([first, ...[...holes].sort((a, c) => a - c).map((h) => piece.poly[h + 1]!)]);
    }
    return met ? out : null;
  }
}
