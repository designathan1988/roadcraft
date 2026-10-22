import { Digest } from '@core/digest';
import type { TileRecords } from '@world/doc';

/** WHAT A NEAR BAKE READS OF A TILE, BY CONTENT (`nearTileBake.ts`, `nearTiles.ts`, `nearBuildings.ts`): the parts a tile is stored in, and their digest whatever version the tile is at */

/** The parts a tile is stored in (`editor/tileStore.ts`): its roads, its buildings, and the rest (poles, placed things, barriers, trees). */
export type NearPart = 'roads' | 'buildings' | 'rest';

/** The fields of each part, in a fixed order (`editor/tileStore.ts` splitRecords; `next` left out: it moves with every record made). */
const PART_FIELDS: Readonly<Record<NearPart, readonly (keyof TileRecords)[]>> = {
  roads: ['nodes', 'borrowedNodes', 'segments', 'gates'],
  buildings: ['buildings', 'grown', 'lots'],
  // DO NOT digest the lots' keys: no near product reads them, and the growth moves them with every building (every tile's kinds were asked again, first in the queue).
  rest: ['poles', 'borrowedPoles', 'poleSpans', 'landscape', 'barriers', 'paint', 'trees', 'elements'],
};

/** THE CONTENT OF SOME PARTS OF A TILE, digested: what a kind reads of it, whatever version the tile is at; a record object digested once where its reader keeps `memo` (a record is replaced, never edited). The page names an edited tile by it (`nearTiles.ts`), a worker its kept bakes. */
export function partsDigest(records: Partial<TileRecords>, parts: readonly NearPart[], memo: WeakMap<object, number> = new WeakMap()): string {
  const d = new Digest();
  for (const part of [...parts].sort()) {
    for (const field of PART_FIELDS[part]) {
      const value = records[field] as unknown;
      d.addText(field);
      if (!Array.isArray(value)) { d.addPlain(value ?? null); continue; }
      for (const item of value as unknown[]) {
        if (item === null || typeof item !== 'object') { d.addPlain(item ?? null); continue; }
        let known = memo.get(item);
        if (known === undefined) memo.set(item, known = new Digest().addPlain(item).value());
        d.add(known);
      }
      d.add(value.length);
    }
  }
  return d.value().toString(36);
}
