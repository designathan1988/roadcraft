import type { Barrier } from '@world/barriers';
import { m } from '@world/units';
import { type BarrierBake, type Barriers, bakeBarriers } from './barriers';
import type { NearBaker, NearProduct } from './nearTileBake';
import { runBuffers } from './streetFurnitureLayer';

/** A TILE'S WALLS, FENCES, HEDGES AND RAILS AS A NEAR PRODUCT (`nearTiles.ts`): baked in a worker from the tile's own barriers (`bakeBarriers`, the same pieces as the page's layer) on the ground as drawn, drawn in the barriers' own layer */

/** THE TILE'S OWN BARRIERS, each in one tile's records (that of its first point), whole wherever it runs: two tiles never draw one twice nor leave one out */
export const barrierBaker: NearBaker<BarrierBake | null> = {
  parts: ['rest'],
  around: false,
  // A run reaches past its tile's edge from its first point: the ground it stands on read that far.
  groundReach: m(128),
  bake(area) {
    if (!area.tile.barriers.length) return null;
    const doc = area.doc();
    const barriers: Barrier[] = [];
    for (const record of area.tile.barriers) { const barrier = doc.barriers.get(record.id as Barrier['id']); if (barrier) barriers.push(barrier); }
    return bakeBarriers(barriers, area.groundAt);
  },
  buffers: (bake) => (bake ? runBuffers(bake.run) : []),
};

/** A tile's barriers as the page draws them: their run put in the layer's cells. */
export function barrierProduct(layer: Barriers): NearProduct<BarrierBake> {
  return {
    kind: 'barriers',
    // As far as a 4 m piece of wall a metre high or a hedge shows.
    cover: m(2) * m(2),
    top: m(3),
    land: (bake) => ({ put: () => layer.put(bake), remove: () => layer.take(bake) }),
  };
}
