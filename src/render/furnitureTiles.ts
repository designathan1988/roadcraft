import type { LandscapeItem } from '@world/landscape';
import { m } from '@world/units';
import type { NearBaker, NearProduct } from './nearTileBake';
import { type FurnitureBake, type LampLens, type StreetFurnitureLayer, bakeFurniture, runBuffers } from './streetFurnitureLayer';

/** A TILE'S STREET FURNITURE AND LONG GRASS AS A NEAR PRODUCT (`nearTiles.ts`): baked in a worker from the tile and the roads round it (`bakeFurniture`, the same placing as the page's layer), drawn in the furniture's own layer (its cells, levels and pictures) */

/** What a furniture bake reads from the page: the lamp's lens on its post, and the city's time (its hour sizes the plants still growing). */
export interface FurnitureExtra {
  readonly lens: LampLens;
  readonly minutes: number;
}

/** THE TILE'S OWN PLACED ITEMS: each in one tile's records (`RoadDoc.loadTile`), on the roads of the 3 x 3 round it (an item's own street, the crossings near it) */
export const furnitureBaker: NearBaker<FurnitureBake | null, FurnitureExtra> = {
  parts: ['roads', 'rest'],
  around: true,
  // An item stands on its footway's deck; a clump of grass reads the ground round it (`grass.ts` CLUMP_READ_REACH).
  groundReach: m(16),
  bake(area, extra) {
    const ids = area.tile.landscape.map((item) => item.id);
    if (!ids.length) return null;
    const doc = area.doc();
    const items: LandscapeItem[] = [];
    for (const id of ids) { const item = doc.landscape.get(id); if (item) items.push(item); }
    const bake = bakeFurniture(area.net(), area.elevation(), area.groundAt, items, extra.lens, extra.minutes);
    return bake.furniture || bake.grass ? bake : null;
  },
  buffers: (bake) => (bake ? [...runBuffers(bake.furniture), ...runBuffers(bake.grass)] : []),
};

/** A tile's furniture as the page draws it: its runs put in the layer's cells; a tile with a plant still growing baked again each city hour, as the page sized its plants. */
export function furnitureProduct(layer: StreetFurnitureLayer, lens: LampLens, minutes: () => number): NearProduct<FurnitureBake> {
  /** The tiles whose last bake had a plant still growing. */
  const growing = new Set<number>();
  const hourOf = (): string => { const now = minutes(); return Number.isFinite(now) ? String(Math.floor(now / 60)) : '-'; };
  return {
    kind: 'furniture',
    // As far as a lamp post shows (6 m by a third of a metre, `PartStore.view`'s pixel), a street tree a few pixels tall there.
    cover: m(2) * m(2),
    top: m(12),
    version: (tile) => (growing.has(tile) ? hourOf() : ''),
    extra: (): FurnitureExtra => ({ lens, minutes: minutes() }),
    land(bake, tile) {
      if (bake.growing) growing.add(tile); else growing.delete(tile);
      return { put: () => layer.put(bake), remove: () => layer.take(bake) };
    },
  };
}
