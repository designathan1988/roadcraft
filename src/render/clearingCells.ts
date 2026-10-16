import type { TreeClearing } from '@world/trees';
import { m } from '@world/units';

/** THE CLEARINGS BY PLACE, kept as the document's list grows at its end and lets its oldest go at the cap (`RoadDoc.cutTrees`) */

/** DO NOT file every clearing of the map again at each one cut (`clearingIndex`): a dab filed ten thousand clearings */
export class ClearingCells {
  private readonly cells = new Map<number, TreeClearing[]>();
  /** The clearings filed, in the document's order, from `head`. */
  private filed: TreeClearing[] = [];
  private head = 0;
  private owner: object | null = null;
  /** Clearings filed and let go since made: the work, for the specs. */
  work = 0;

  constructor(private readonly cell = m(64)) {}

  /** The filing brought up to `list`, the clearings of `owner` (a document), oldest first. */
  follow(owner: object, list: readonly TreeClearing[]): void {
    if (owner !== this.owner) {
      this.owner = owner;
      this.refile(list);
      return;
    }
    // The oldest let go at the cap leave from the front.
    while (this.head < this.filed.length && this.filed[this.head] !== list[0]) this.unfile(this.filed[this.head++]!);
    const kept = this.filed.length - this.head;
    // What stays filed must be where the list starts, as it was: else (an undo, the list replaced) the list is filed again.
    if (kept > list.length || (kept > 0 && list[kept - 1] !== this.filed[this.filed.length - 1])) {
      this.refile(list);
      return;
    }
    for (let k = kept; k < list.length; k++) this.file(list[k]!);
    // The front let go is dropped once it is most of the list.
    if (this.head > 64 && this.head * 2 > this.filed.length) {
      this.filed = this.filed.slice(this.head);
      this.head = 0;
    }
  }

  /** Whether a point lies in a clearing. */
  has(x: number, y: number): boolean {
    for (const c of this.cells.get(this.keyOf(Math.floor(x / this.cell), Math.floor(y / this.cell))) ?? []) {
      if (Math.abs(c.x - x) < c.radius && Math.abs(c.y - y) < c.radius && Math.hypot(c.x - x, c.y - y) < c.radius) return true;
    }
    return false;
  }

  private keyOf(i: number, j: number): number {
    return (i + 32_768) * 65_536 + (j + 32_768);
  }

  /** @rebuild Every clearing of a list filed: a document opened, or its clearings replaced. */
  private refile(list: readonly TreeClearing[]): void {
    this.cells.clear();
    this.filed = [];
    this.head = 0;
    for (const c of list) this.file(c);
  }

  private file(c: TreeClearing): void {
    this.filed.push(c);
    this.work++;
    this.over(c, (k) => {
      const list = this.cells.get(k);
      if (list) list.push(c); else this.cells.set(k, [c]);
    });
  }

  private unfile(c: TreeClearing): void {
    this.work++;
    this.over(c, (k) => {
      const list = this.cells.get(k);
      if (!list) return;
      const at = list.indexOf(c);
      if (at >= 0) list.splice(at, 1);
      if (!list.length) this.cells.delete(k);
    });
  }

  /** Each cell a clearing's square reaches. */
  private over(c: TreeClearing, visit: (key: number) => void): void {
    for (let j = Math.floor((c.y - c.radius) / this.cell); j <= Math.floor((c.y + c.radius) / this.cell); j++) {
      for (let i = Math.floor((c.x - c.radius) / this.cell); i <= Math.floor((c.x + c.radius) / this.cell); i++) visit(this.keyOf(i, j));
    }
  }
}
