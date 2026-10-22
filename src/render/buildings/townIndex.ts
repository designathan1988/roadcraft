import { Box3, type Group } from 'three';
import type { Building, BuildingId } from '@world/buildings/types';
import type { BuildingMeshes } from './buildingMesh';
import type { LandedCell } from './cellRequests';
import { buildSignature, disposeSignature } from './signature';
import { BATCH_CELL, type CellCache, dropCell } from './layerCells';
import { FILED, type TownColumns } from './townColumns';
import { type PartCell, dropParts } from './partCells';

/** The buildings the layer shows, by id and by coarse cell, kept from one change to the next: ids, never records (`townColumns.ts`). */
export class TownIndex {
  /** The shown buildings' ids by coarse cell: what a cell is made of (`layer.ts` `townCells`). */
  readonly byCell = new Map<string, number[]>();

  constructor(private readonly columns: TownColumns) {}

  /** Every shown building filed again (the whole town: the opening, a map opened); `shown`, their slots (their columns filed). */
  reset(shown: Iterable<number>): void {
    const c = this.columns;
    for (const cell of this.byCell.values()) for (const id of cell) c.set(c.slotOf(id), FILED, false);
    this.byCell.clear();
    for (const slot of shown) this.file(slot);
  }

  /** A building as it is now taken in (`slot`: its columns filed; -1: gone, or not shown); the cells it left and entered marked in `dirty`. */
  take(id: number, slot: number, dirty: Set<string>): void {
    const c = this.columns;
    const at = c.slotOf(id);
    const was = c.has(at, FILED) ? `${c.filedI[at]!},${c.filedJ[at]!}` : undefined;
    const cell = slot >= 0 ? c.cellOf(slot) : undefined;
    if (was !== undefined) {
      dirty.add(was);
      if (was === cell) return;
      const list = this.byCell.get(was)!;
      list.splice(list.indexOf(id), 1);
      if (list.length === 0) this.byCell.delete(was);
      c.set(at, FILED, false);
    }
    if (slot >= 0 && cell !== undefined) {
      dirty.add(cell);
      this.file(slot);
    }
  }

  has(id: number): boolean {
    return this.columns.has(this.columns.slotOf(id), FILED);
  }

  private file(slot: number): void {
    const c = this.columns;
    const i = Math.floor(c.x[slot]! / BATCH_CELL), j = Math.floor(c.y[slot]! / BATCH_CELL);
    c.filedI[slot] = i; c.filedJ[slot] = j;
    c.set(slot, FILED, true);
    const cell = `${i},${j}`;
    const list = this.byCell.get(cell);
    const id = this.columns.idOf(slot);
    if (list) list.push(id);
    else this.byCell.set(cell, [id]);
  }
}

/** The signature buildings' bodies */
export function signatureBodies(root: Group): {
  /** `sig`: its record's digest (`townColumns.ts`): the body made again only when it or its floor changed. */
  set(b: Building, sig: number, floor: number | undefined): void;
  remove(id: BuildingId): void;
  /** Every body let go but those of the ids `keep` keeps. */
  keepOnly(keep: (id: BuildingId) => boolean): void;
  /** The highest point of any body (`massCells.ts` `top` for the rest); -Infinity with none. */
  top(): number;
} {
  const known = new Map<BuildingId, { key: string; group: Group; top: number }>();
  /** The highest body's top, walked again only when that body went (`top`). */
  let highest = -Infinity, stale = false;
  const remove = (id: BuildingId): void => {
    const k = known.get(id);
    if (!k) return;
    root.remove(k.group);
    disposeSignature(k.group);
    known.delete(id);
    if (k.top >= highest) stale = true;
  };
  return {
    set(b, sig, floor) {
      if (floor === undefined) { remove(b.id); return; }
      const key = `${sig}|${floor}`;
      if (known.get(b.id)?.key === key) return;
      remove(b.id);
      const built = buildSignature(b, floor);
      if (!built) return;
      root.add(built);
      // Its own few meshes measured once, as it is made.
      const top = new Box3().setFromObject(built).max.y;
      known.set(b.id, { key, group: built, top });
      if (top >= highest) { highest = top; stale = false; }
    },
    remove,
    keepOnly(keep) {
      for (const id of [...known.keys()]) if (!keep(id)) remove(id);
    },
    top() {
      if (stale) {
        stale = false;
        highest = -Infinity;
        for (const k of known.values()) highest = Math.max(highest, k.top);
      }
      return highest;
    },
  };
}

/** Where a cell's batches are kept and shown. */
export interface CellBatches {
  readonly cells: CellCache;
  readonly parts: Map<string, PartCell>;
  readonly stored: BuildingMeshes;
  readonly partRoot: Group;
}

/** One cell's batches swapped for those landed for it (`cellRequests.ts`), its parts with them; none */
export function patchCell(key: string, landed: LandedCell | null, at: CellBatches): void {
  dropCell(at.cells, key, at.stored);
  dropParts(at.parts, key, at.partRoot);
  if (!landed?.batch) return;
  at.cells.set(key, { entries: landed.entries, part: landed.batch, bytes: landed.bytes });
  at.stored.group.add(landed.batch.group);
  if (!landed.parts) return;
  at.parts.set(key, landed.parts);
  at.partRoot.add(landed.parts.group);
}
