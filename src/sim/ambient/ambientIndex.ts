import type { ChangeJournal } from '@world/changes';
import type { BuildingStore } from '@world/buildings/store';
import type { Building } from '@world/buildings/types';
import { solidFootprints } from '@world/buildings/geometry';
import { m } from '@world/units';

/**
 * The scenery's questions about the map (`ambient.ts`), answered from indexes
 * kept by the diary (`world/changes.ts`) instead of a walk over the whole map:
 *
 * - the walls between the eye and a point (`SightWalls`): a fixed grid of
 *   the buildings' solid rings (Nystrom, "Spatial Partition",
 *   gameprogrammingpatterns.com/spatial-partition.html), the line of sight
 *   reading only the cells it passes through (Amanatides and Woo, "A Fast
 *   Voxel Traversal Algorithm for Ray Tracing", 1987).
 *
 * Each index keeps the serial of the diary it last read and takes in only
 * the buildings the diary names since (`buildingsChangedSince`). A reader the
 * diary has forgotten, or a change of the whole store (a load, a clear),
 * reads the store once again.
 *
 * DO NOT key any of these by `doc.buildings.revision`: the town's ageing
 * writes a building every few seconds, and each index keyed by it was made
 * again from every building of the map that often.
 *
 * Pure: no three, no DOM.
 */

/** Work done by the indexes, for the scale tests: buildings filed, cells read, rings tested. */
export const ambientIndexWork = { filed: 0, cells: 0, rings: 0, full: 0 };

/**
 * The buildings the diary names as changed after `serial`; null when they
 * must all be read again (the diary forgot that far back, or an entry names
 * none: a load, a clear, a store shared).
 */
export function buildingsChangedSince(journal: ChangeJournal, serial: number): Set<number> | null {
  if (serial >= journal.version) return new Set();
  const entries = journal.since(serial, ['buildings']);
  if (!entries) return null;
  const ids = new Set<number>();
  for (const entry of entries) {
    if (!entry.ids) return null;
    for (const id of entry.ids) ids.add(id);
  }
  return ids;
}

/** A cell's key from its column and row (both within ±32 767), as `world/cells.ts`. */
const key = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

// ------------------------------------------------------------ the walls

/** A solid ring of a building, with its box; `mark` is the last query that read it. */
interface Wall {
  readonly ring: readonly { readonly x: number; readonly y: number }[];
  readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number;
  mark: number;
}

/** The side of a wall cell: a few buildings each, a sight line of 300 m reads some twenty. */
const WALL_CELL = m(32);
/**
 * Walls are filed over their box grown by this: a crossing that falls on a
 * cell's edge, where the traversal's arithmetic and the box's can round
 * apart, is found from either side.
 */
const WALL_SLACK = m(0.01);

/**
 * The buildings' solid rings in a fixed grid, kept by the diary: a sight
 * line asks only the cells it crosses. Answers as the walk over every wall
 * of the map it replaces (`tests/sim/ambientIndex.spec.ts`).
 */
export class SightWalls {
  private serial = -1;
  private readonly byBuilding = new Map<number, Wall[]>();
  private readonly cells = new Map<number, Set<Wall>>();
  private query = 0;

  /** Takes in what the diary says changed since the last call. */
  sync(store: BuildingStore, journal: ChangeJournal): void {
    const changed = buildingsChangedSince(journal, this.serial);
    this.serial = journal.version;
    if (changed === null) { this.fileAll(store); return; }
    for (const id of changed) {
      this.unfile(id);
      const b = store.get(id as never);
      if (b) this.file(b);
    }
  }

  /** @rebuild The whole store read again: a load, a clear, or a diary that forgot. */
  private fileAll(store: BuildingStore): void {
    ambientIndexWork.full++;
    this.byBuilding.clear();
    this.cells.clear();
    for (const b of store.all()) this.file(b);
  }

  private file(b: Building): void {
    const walls: Wall[] = [];
    for (const ring of solidFootprints(b)) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      if (!(x0 <= x1 && y0 <= y1)) continue;
      const wall: Wall = { ring, x0, y0, x1, y1, mark: 0 };
      walls.push(wall);
      ambientIndexWork.filed++;
      const cx0 = Math.floor((x0 - WALL_SLACK) / WALL_CELL), cx1 = Math.floor((x1 + WALL_SLACK) / WALL_CELL);
      const cy0 = Math.floor((y0 - WALL_SLACK) / WALL_CELL), cy1 = Math.floor((y1 + WALL_SLACK) / WALL_CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const k = key(cx, cy);
          let set = this.cells.get(k);
          if (!set) this.cells.set(k, set = new Set());
          set.add(wall);
        }
      }
    }
    if (walls.length) this.byBuilding.set(b.id, walls);
  }

  private unfile(id: number): void {
    const walls = this.byBuilding.get(id);
    if (!walls) return;
    this.byBuilding.delete(id);
    for (const wall of walls) {
      const cx0 = Math.floor((wall.x0 - WALL_SLACK) / WALL_CELL), cx1 = Math.floor((wall.x1 + WALL_SLACK) / WALL_CELL);
      const cy0 = Math.floor((wall.y0 - WALL_SLACK) / WALL_CELL), cy1 = Math.floor((wall.y1 + WALL_SLACK) / WALL_CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const k = key(cx, cy);
          const set = this.cells.get(k);
          if (!set) continue;
          set.delete(wall);
          if (!set.size) this.cells.delete(k);
        }
      }
    }
  }

  /**
   * Whether a side of some wall properly crosses the segment a-b. The cells
   * are visited in the order the segment passes through them (Amanatides and
   * Woo): a crossing point lies on the segment and inside the wall's box, so
   * in a cell both reach.
   */
  blocked(ax: number, ay: number, bx: number, by: number): boolean {
    const mark = ++this.query;
    const lx = Math.min(ax, bx), ly = Math.min(ay, by), hx = Math.max(ax, bx), hy = Math.max(ay, by);
    let cx = Math.floor(ax / WALL_CELL), cy = Math.floor(ay / WALL_CELL);
    const ex = Math.floor(bx / WALL_CELL), ey = Math.floor(by / WALL_CELL);
    const dx = bx - ax, dy = by - ay;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0, stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const deltaX = stepX ? WALL_CELL / Math.abs(dx) : Infinity, deltaY = stepY ? WALL_CELL / Math.abs(dy) : Infinity;
    let maxX = stepX > 0 ? ((cx + 1) * WALL_CELL - ax) / dx : stepX < 0 ? (cx * WALL_CELL - ax) / dx : Infinity;
    let maxY = stepY > 0 ? ((cy + 1) * WALL_CELL - ay) / dy : stepY < 0 ? (cy * WALL_CELL - ay) / dy : Infinity;
    for (;;) {
      ambientIndexWork.cells++;
      const set = this.cells.get(key(cx, cy));
      if (set) {
        for (const wl of set) {
          if (wl.mark === mark) continue;
          wl.mark = mark;
          if (wl.x1 < lx || wl.x0 > hx || wl.y1 < ly || wl.y0 > hy) continue;
          ambientIndexWork.rings++;
          const r = wl.ring;
          for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            if (crosses(ax, ay, bx, by, r[j]!.x, r[j]!.y, r[i]!.x, r[i]!.y)) return true;
          }
        }
      }
      if (cx === ex && cy === ey) return false;
      // The axis whose cell edge comes first; once a column (row) is the
      // end's, only the other moves - rounding never carries it past the end.
      if (cy === ey || (cx !== ex && maxX < maxY)) { maxX += deltaX; cx += stepX; } else { maxY += deltaY; cy += stepY; }
    }
  }
}

/** Whether segment a-b crosses segment c-d (proper crossing). */
export function crosses(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}
