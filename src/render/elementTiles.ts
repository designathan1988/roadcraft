import type { ElementItem } from '@world/elements';
import { m } from '@world/units';
import { type ElementBake, type ElementLayer, type ElementLayout, bakeElements } from './elements';
import type { NearBaker, NearProduct } from './nearTileBake';
import { runBuffers } from './streetFurnitureLayer';

/** A TILE'S BRUSH ELEMENTS AS A NEAR PRODUCT (`nearTiles.ts`): the stones, grass, flowers and leaves the player laid with the brush, and its smoke and fire, baked in a worker from the tile's own elements on the ground as drawn (`bakeElements`, the page's own placing), drawn in the elements' layer */

/** What an element bake reads from the page: where each kind's variants are drawn among the layer's stores. */
export interface ElementExtra {
  readonly layout: ElementLayout;
}

/** THE TILE'S OWN ELEMENTS (each in the tile its point falls in), on the ground at its point */
export const elementBaker: NearBaker<ElementBake | null, ElementExtra> = {
  parts: ['rest'],
  around: false,
  has: (tiles) => tiles[0]!.elements.length > 0,
  // An element stands on the ground drawn under its point.
  groundReach: m(8),
  bake: (area, extra) => bakeElements(area.tile.elements as readonly ElementItem[], area.groundAt, extra.layout),
  buffers: (bake) => (bake ? runBuffers(bake.run) : []),
};

/** A tile's elements as the page draws them: in the elements' layer (made once its models are in, `layer`). */
export function elementProduct(layer: () => ElementLayer | null): NearProduct<ElementBake> {
  return {
    kind: 'elements',
    // A stone or a tuft a metre across covering a pixel; an effect gives off within its own reach (`elements.ts` EFFECT_REACH).
    cover: m(1) * m(1),
    top: m(4),
    enabled: () => layer() !== null,
    extra: (): ElementExtra => ({ layout: layer()!.layout }),
    version: () => String(layer()?.layout.stores ?? 0),
    land(bake) {
      const drawn = layer()!;
      return { put: () => drawn.put(bake), remove: () => drawn.take(bake) };
    },
  };
}
