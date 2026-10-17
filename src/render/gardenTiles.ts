import type { InstancedMesh, Object3D } from 'three';
import { m } from '@world/units';
import type { Pack } from './cellInstances';
import { type Gardens, gardenPack } from './gardens';
import type { NearBaker, NearProduct } from './nearTileBake';
import { runBuffers } from './streetFurnitureLayer';

/** A TILE'S GARDENS AS A NEAR PRODUCT (`nearTiles.ts`): the trees, shrubs, hedges and flower beds of its buildings' lots, placed on the ground as drawn and packed in a worker (`gardenPlants`, `gardenPack`, the page's own) from the tile's stored buildings, drawn in the gardens' cells */

/** A tile's gardens as a bake hands them: their plants packed by kind. */
export interface GardenBake {
  readonly packs: ReadonlyMap<number, Pack>;
}

/** THE GARDENS OF THE TILE'S OWN BUILDINGS (each in one tile's records, its grown rows made records again), whole wherever its lot runs */
export const gardenBaker: NearBaker<GardenBake | null> = {
  parts: [],
  around: false,
  // Its plants read off the tile's buildings kept a version (`nearBuildings.ts`): DO NOT make a dense tile's ~1,500 buildings again from their rows for its gardens.
  buildings: 'own',
  // A lot's plants stand on the ground round its building (`renderer.ts` bankBox).
  groundReach: m(64),
  bake(area) {
    const plants = area.buildings(0).plants.map((p) => ({ ...p, z: area.groundAt(p.x, p.y) }));
    if (!plants.length) return null;
    const packs = gardenPack(plants);
    return packs.size ? { packs } : null;
  },
  buffers: (bake) => (bake ? runBuffers(bake.packs) : []),
};

/** A tile's gardens as the page draws them: their packs placed in the gardens' cells (made once, `gardens`), the meshes the cells make put under `parent`. */
export function gardenProduct(gardens: () => Gardens, parent: Object3D): NearProduct<GardenBake> {
  return {
    kind: 'gardens',
    // As far as the furniture's street trees (`furnitureTiles.ts`): a garden tree a few pixels tall there. Its plants are read off each tile's buildings kept a version (`nearBuildings.ts`).
    cover: m(2) * m(2),
    top: m(16),
    land(bake) {
      const layer = gardens();
      return {
        put: () => { const made: readonly InstancedMesh[] = layer.put(bake.packs); for (const mesh of made) parent.add(mesh); },
        remove: () => layer.take(bake.packs),
      };
    },
  };
}
