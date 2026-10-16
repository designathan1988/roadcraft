import type { Change, ChangeJournal, ChangeKind, ChangeRect } from '@world/changes';
import type { JournalCursor } from '@world/derived';
import { TILE } from '@world/tiles';
import { KEEP_CELL } from './candidateKeep';
import { keepCellRect } from './cellKeeps';

/** THE STREAMED WORLD'S ACTIVE TILES AS THE NEAR PRODUCTS READ THEM (CLAUDE.md "Streaming world", the solution's 5.4): the kept ring round the active 3 x 3 holds its records for the edits and the simulation, the far levels draw it; a near product makes an item only where it stands on an active tile and takes in or lets go the items of the tiles whose standing changed, as the buildings (`BuildingLayer.setActive`) and the roads (`SurfaceReuse.within`) do */

/** Why an entry holds the places the active region moved (`ActiveReader.entries`): not an edit, a change of where the near products are made. */
export const ACTIVE_MOVED = 'active region moved';

/** Tiles a box may reach over and still be looked at tile by tile (`meets`); a wider one is taken as meeting the region (made near, as before). */
const MEETS_MOST = 64;

/** Where the active region moved since a product last took it (`ActiveTiles.reader`): the tiles' rectangles, each once. */
class ActiveReader {
  /** Null: everywhere (a streamed world opened or closed). */
  private rects: ChangeRect[] | null = [];
  private readonly keys = new Set<string>();

  /** Told by `ActiveTiles.set`: the tiles that came into the region or left it; null, everywhere. */
  moved(rects: readonly ChangeRect[] | null): void {
    if (this.rects === null) return;
    if (rects === null) {
      this.rects = null;
      this.keys.clear();
      return;
    }
    for (const r of rects) {
      // A tile that came in and left again before the product looked is one place to look at again.
      const key = `${r[0]},${r[1]},${r[2]},${r[3]}`;
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      this.rects.push(r);
    }
  }

  /** Whether the region moved since the last take. */
  get pending(): boolean {
    return this.rects === null || this.rects.length > 0;
  }

  /** Where the region moved since the last take, taken; null: everywhere. */
  take(): readonly ChangeRect[] | null {
    const out = this.rects;
    this.rects = [];
    this.keys.clear();
    return out;
  }

  /** Where the region moved since the last take, taken as one entry of `kind` for a reader of the diary (`Derived.refresh`): none when it did not move; null, everywhere. */
  entries(kind: ChangeKind, pad = 0): readonly Change[] | null {
    const rects = this.take();
    if (rects === null) return null;
    if (!rects.length) return [];
    const grown = pad ? rects.map((r): ChangeRect => [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad]) : rects;
    return [{ serial: -1, kind, rects: grown, cause: ACTIVE_MOVED, at: 0 }];
  }
}

/** The active tiles of the streamed world as the renderer was last told them (`renderer.ts` setActiveTiles), and every near product's reader of where they moved. */
export class ActiveTiles {
  private at: ((x: number, y: number) => boolean) | null = null;
  private readonly readers: ActiveReader[] = [];
  /** The readers of the diary's cursors read through `read`, each its own record of the moves. */
  private readonly cursors = new WeakMap<JournalCursor, ActiveReader>();

  /** Whether an item standing at (x, y) is made near: on an active tile, or anywhere while no world streams. */
  has(x: number, y: number): boolean {
    return this.at === null || this.at(x, y);
  }

  /** Whether a box meets an active tile: an item reaching over tiles (a wall, a road's structures, a lot) is made near while any of them is active, so the active tiles never lose a part of it. */
  meets(r: ChangeRect): boolean {
    const at = this.at;
    if (at === null) return true;
    const i0 = Math.floor(r[0] / TILE), i1 = Math.floor(r[2] / TILE), j0 = Math.floor(r[1] / TILE), j1 = Math.floor(r[3] / TILE);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > MEETS_MOST) return true;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (at((i + 0.5) * TILE, (j + 0.5) * TILE)) return true;
    return false;
  }

  /** Whether a keep cell's places are kept here (`cellKeeps.ts`): on an active tile, or a cell from one (a tree's shape reads the cells round it, `plantCells.ts`, so the active tiles' edge stays as it was). */
  keepsCell(key: number): boolean {
    if (this.at === null) return true;
    const r = keepCellRect(key);
    return this.meets([r[0] - KEEP_CELL, r[1] - KEEP_CELL, r[2] + KEEP_CELL, r[3] + KEEP_CELL]);
  }

  /** The region moved (`renderer.ts` setActiveTiles): `rects`, the loaded tiles that came into it or left it; another predicate (a streamed world opened or closed) moves it everywhere. */
  set(at: ((x: number, y: number) => boolean) | null, rects: readonly ChangeRect[]): void {
    const everywhere = at !== this.at;
    this.at = at;
    if (!everywhere && !rects.length) return;
    for (const reader of this.readers) reader.moved(everywhere ? null : rects);
  }

  /** A product's own record of where the region moved, taken at the product's pace. */
  reader(): ActiveReader {
    const reader = new ActiveReader();
    this.readers.push(reader);
    return reader;
  }

  /** A cursor's diary entries since its last read (`JournalCursor.read`) and, as an entry of its first kind grown by a keep cell (`keepsCell`), where the region moved since: a product that makes again where its entries reach takes in or lets go what came or left. Null: everything. Every read of `cursor` goes through here. */
  read(cursor: JournalCursor, journal: ChangeJournal): readonly Change[] | null {
    let reader = this.cursors.get(cursor);
    if (!reader) this.cursors.set(cursor, reader = this.reader());
    const moved = reader.entries(cursor.kinds[0]!, KEEP_CELL);
    const entries = cursor.read(journal);
    if (entries === null || moved === null) return null;
    return moved.length ? [...entries, ...moved] : entries;
  }
}
