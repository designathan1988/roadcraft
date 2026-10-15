import { FLOOR_READ_REACH, type GroundAt, type PavedAt, floorHeight } from '@world/buildings/foundation';
import type { Building, BuildingId } from '@world/buildings/types';
import type { ChangeKind } from '@world/changes';
import { JournalCursor } from '@world/derived';
import type { RoadDoc } from '@world/doc';

/**
 * THE GROUND FLOOR OF EACH STORED BUILDING, for the Builder's picks and
 * overlay (`BuildingTool.floorOf`), kept from the diary (`world/derived.ts`
 * `JournalCursor`): a floor is measured on the building's record, the natural
 * ground under it (`terrain`) and the paving at its door (`roads`, and the
 * roads' heights solved, `elevation`). Only what the diary names is measured
 * again: a building whose record changed (its id), the buildings within
 * `FLOOR_READ_REACH` of a place the land or the roads changed
 * (`BuildingStore.near`); an entry of the whole map, or a diary that cannot
 * say, forgets them all.
 * DO NOT key the floors on a global revision (`${doc.revision}:${doc.terrainRevision}:${buildings.revision}`):
 * every road drawn, every hill dabbed and every building grown anywhere threw
 * away the floor of every building of the city.
 */
const KINDS: readonly ChangeKind[] = ['buildings', 'terrain', 'roads', 'elevation'];

export class BuildingFloors {
  private readonly floors = new Map<BuildingId, number>();
  private readonly cursor = new JournalCursor(KINDS);

  floorOf(doc: RoadDoc, b: Building, groundAt: GroundAt, pavedAt?: PavedAt): number {
    this.follow(doc);
    const known = this.floors.get(b.id);
    if (known !== undefined) return known;
    const floor = floorHeight(b, groundAt, pavedAt);
    this.floors.set(b.id, floor);
    return floor;
  }

  /** Forgets the floors the changes since the last look reached. */
  private follow(doc: RoadDoc): void {
    const entries = this.cursor.read(doc.changes);
    if (entries === null) { this.floors.clear(); return; }
    for (const entry of entries) {
      if (this.floors.size === 0) return;
      if (entry.kind === 'buildings') {
        if (!entry.ids) { this.floors.clear(); continue; }
        for (const id of entry.ids) this.floors.delete(id as BuildingId);
        continue;
      }
      if (entry.rects === null) { this.floors.clear(); continue; }
      // A floor reads the ground and the paving up to `FLOOR_READ_REACH` past the building's bounds.
      const pad = FLOOR_READ_REACH;
      for (const [x0, y0, x1, y1] of entry.rects) {
        for (const near of doc.buildings.near(x0 - pad, y0 - pad, x1 + pad, y1 + pad)) this.floors.delete(near.id);
      }
    }
  }
}
