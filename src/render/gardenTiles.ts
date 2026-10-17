import type { InstancedMesh, Object3D } from 'three';
import { migrateBuilding } from '@world/buildings/serialize';
import type { Building } from '@world/buildings/types';
import { tileBuildingsOf } from '@world/growth/grownRows';
import { m } from '@world/units';
import type { Pack } from './cellInstances';
import { type GardenPlant, type Gardens, gardenPack, gardenPlants } from './gardens';
import type { NearBaker, NearProduct } from './nearTileBake';
import { runBuffers } from './streetFurnitureLayer';

/** A TILE'S GARDENS AS A NEAR PRODUCT (`nearTiles.ts`): the trees, shrubs, hedges and flower beds of its buildings' lots, placed on the ground as drawn and packed in a worker (`gardenPlants`, `gardenPack`, the page's own) from the tile's stored buildings, drawn in the gardens' cells */

/** A tile's gardens as a bake hands them: their plants packed by kind. */
export interface GardenBake {
  readonly packs: ReadonlyMap<number, Pack>;
}

/** THE GARDENS OF THE TILE'S OWN BUILDINGS (each in one tile's records, its grown rows made records again), whole wherever its lot runs */
export const gardenBaker: NearBaker<GardenBake | null> = {
  parts: ['buildings'],
  around: false,
  has: (tiles) => tiles[0]!.buildings.length > 0 || (tiles[0]!.grown?.id.length ?? 0) > 0,
  // A lot's plants stand on the ground round its building (`renderer.ts` bankBox).
  groundReach: m(64),
  // DO NOT make the buildings again from their rows at every change of the ground under the tile (a dense tile's ~1,500 buildings, seconds of a worker): their plants are kept by the tile's version alone, on no ground; the ground is read after.
  staged(area): readonly GardenPlant[] {
    const buildings: Building[] = [];
    for (const raw of tileBuildingsOf(area.tile)) { const b = migrateBuilding(raw); if (b) buildings.push(b); }
    return gardenPlants(buildings, () => 0);
  },
  bake(area, _extra, staged) {
    const plants = (staged as readonly GardenPlant[]).map((p) => ({ ...p, z: area.groundAt(p.x, p.y) }));
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
    // As far as the furniture's street trees (`furnitureTiles.ts`): a garden tree a few pixels tall there. Each tile's buildings are made again from their rows once a version of the tile (`staged`), kept in the store.
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
