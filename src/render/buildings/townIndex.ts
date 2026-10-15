import type { Group } from 'three';
import type { Building, BuildingId } from '@world/buildings/types';
import type { BuildingMeshes } from './buildingMesh';
import type { LandedCell } from './cellRequests';
import { buildSignature, disposeSignature } from './signature';
import { type CellCache, detailKeysOf, dropCell } from './layerCells';

/** The buildings the layer shows, by id and by coarse cell, kept from one change to the next */
export class TownIndex {
  /** The shown buildings by coarse cell: what a cell is made of (`layer.ts` `townCells`). */
  readonly byCell = new Map<string, Building[]>();
  private readonly cellOfId = new Map<BuildingId, string>();

  constructor(private readonly cellOf: (b: Building) => string) {}

  /** Every shown building filed again (the whole town: the opening, a map opened). */
  reset(shown: readonly Building[]): void {
    this.byCell.clear();
    this.cellOfId.clear();
    for (const b of shown) this.file(b);
  }

  /** A building's record as it is now (`undefined`: gone, or not shown) taken in */
  take(id: BuildingId, now: Building | undefined, dirty: Set<string>): void {
    const was = this.cellOfId.get(id);
    const cell = now ? this.cellOf(now) : undefined;
    if (was !== undefined) {
      dirty.add(was);
      const list = this.byCell.get(was)!;
      const at = list.findIndex((b) => b.id === id);
      if (was === cell && now) {
        list[at] = now;
        return;
      }
      list.splice(at, 1);
      if (list.length === 0) this.byCell.delete(was);
      this.cellOfId.delete(id);
    }
    if (now && cell !== undefined) {
      dirty.add(cell);
      this.file(now);
    }
  }

  has(id: BuildingId): boolean {
    return this.cellOfId.has(id);
  }

  private file(b: Building): void {
    const cell = this.cellOf(b);
    this.cellOfId.set(b.id, cell);
    const list = this.byCell.get(cell);
    if (list) list.push(b);
    else this.byCell.set(cell, [b]);
  }
}

/** The signature buildings' bodies */
export function signatureBodies(root: Group, sigOf: (b: Building) => number): {
  set(b: Building, floor: number | undefined): void;
  remove(id: BuildingId): void;
  keepOnly(ids: ReadonlySet<BuildingId>): void;
} {
  const known = new Map<BuildingId, { key: string; group: Group }>();
  const remove = (id: BuildingId): void => {
    const k = known.get(id);
    if (!k) return;
    root.remove(k.group);
    disposeSignature(k.group);
    known.delete(id);
  };
  return {
    set(b, floor) {
      if (floor === undefined) { remove(b.id); return; }
      const key = `${sigOf(b)}|${floor}`;
      if (known.get(b.id)?.key === key) return;
      remove(b.id);
      const built = buildSignature(b, floor);
      if (built) { root.add(built); known.set(b.id, { key, group: built }); }
    },
    remove,
    keepOnly(ids) {
      for (const id of [...known.keys()]) if (!ids.has(id)) remove(id);
    },
  };
}

/** Where a cell's batches are kept and shown. */
export interface CellBatches {
  readonly cells: CellCache;
  readonly details: CellCache;
  readonly stored: BuildingMeshes;
  readonly detailed: BuildingMeshes;
}

/** One coarse cell's batches swapped for those landed for it (`cellRequests.ts`), its detail cells with it; none */
export function patchCell(key: string, landed: LandedCell | null, at: CellBatches): void {
  dropCell(at.cells, key, at.stored);
  for (const sub of detailKeysOf(key)) dropCell(at.details, sub, at.detailed);
  if (!landed?.batch) return;
  at.cells.set(key, { entries: landed.entries, part: landed.batch });
  at.stored.group.add(landed.batch.group);
  for (const [sub, part] of landed.details) {
    at.details.set(sub, { entries: landed.entries, part });
    at.detailed.group.add(part.group);
  }
}
