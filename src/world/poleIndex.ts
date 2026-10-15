import type { ChangeRect } from './changes';
import type { PoleId, SpanId } from './ids';
import { m } from './units';
import type { UtilityPole, UtilitySpan } from './utilities';

/** DO NOT scan `doc.poles` or `doc.poleSpans` to find what is near or what is joined. */

/** Side of a cell, world units: a few pole spacings. */
const CELL = m(64);
const keyOf = (i: number, j: number): number => (i + 32768) * 65536 + (j + 32768);
const cellOf = (x: number, y: number): number => keyOf(Math.floor(x / CELL), Math.floor(y / CELL));

export class PoleIndex {
  private readonly cells = new Map<number, Set<PoleId>>();
  private readonly cellOfPole = new Map<PoleId, number>();
  private readonly spansOfPole = new Map<PoleId, Set<SpanId>>();

  /** An index filing the same poles and spans in the same order (a working copy's own, `RoadDoc.ownIndex`). */
  copy(): PoleIndex {
    const out = new PoleIndex();
    for (const [key, cell] of this.cells) out.cells.set(key, new Set(cell));
    for (const [id, key] of this.cellOfPole) out.cellOfPole.set(id, key);
    for (const [id, spans] of this.spansOfPole) out.spansOfPole.set(id, new Set(spans));
    return out;
  }

  clear(): void {
    this.cells.clear();
    this.cellOfPole.clear();
    this.spansOfPole.clear();
  }

  /** A pole put (new, or its record replaced where it may have moved). */
  putPole(pole: UtilityPole): void {
    const key = cellOf(pole.x, pole.y);
    const was = this.cellOfPole.get(pole.id);
    if (was === key) return;
    if (was !== undefined) this.unfile(pole.id, was);
    this.cellOfPole.set(pole.id, key);
    const cell = this.cells.get(key);
    if (cell) cell.add(pole.id);
    else this.cells.set(key, new Set([pole.id]));
  }

  deletePole(id: PoleId): void {
    const was = this.cellOfPole.get(id);
    if (was === undefined) return;
    this.unfile(id, was);
    this.cellOfPole.delete(id);
  }

  private unfile(id: PoleId, key: number): void {
    const cell = this.cells.get(key);
    if (!cell) return;
    cell.delete(id);
    if (cell.size === 0) this.cells.delete(key);
  }

  putSpan(span: UtilitySpan): void {
    for (const end of [span.a, span.b]) {
      const at = this.spansOfPole.get(end);
      if (at) at.add(span.id);
      else this.spansOfPole.set(end, new Set([span.id]));
    }
  }

  deleteSpan(span: UtilitySpan): void {
    for (const end of [span.a, span.b]) {
      const at = this.spansOfPole.get(end);
      if (!at) continue;
      at.delete(span.id);
      if (at.size === 0) this.spansOfPole.delete(end);
    }
  }

  /** The spans reaching a pole, in the order they were strung (`Set` keeps it). */
  spansAt(id: PoleId): Iterable<SpanId> {
    return this.spansOfPole.get(id) ?? [];
  }

  /** The ids of the poles in the cells the rectangle reaches: a superset, the caller keeps its own exact test. */
  near(rect: ChangeRect): PoleId[] {
    const i0 = Math.floor(rect[0] / CELL), j0 = Math.floor(rect[1] / CELL);
    const i1 = Math.floor(rect[2] / CELL), j1 = Math.floor(rect[3] / CELL);
    const out: PoleId[] = [];
    // A rectangle wider than the poles' own cells reads the cells there are, not the empty ones it spans.
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > this.cells.size) {
      for (const [key, cell] of this.cells) {
        const i = Math.floor(key / 65536) - 32768, j = (key % 65536) - 32768;
        if (i >= i0 && i <= i1 && j >= j0 && j <= j1) for (const id of cell) out.push(id);
      }
      return out;
    }
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cell = this.cells.get(keyOf(i, j));
        if (cell) for (const id of cell) out.push(id);
      }
    }
    return out;
  }
}

