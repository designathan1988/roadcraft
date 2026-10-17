import type { NodeId } from '@world/ids';
import { isMarkingStyle } from '@world/roads/markingStyle';
import { m } from '@world/units';
import type { NearBaker, NearProduct } from './nearTileBake';
import { type SignBake, type SignLayerKept, bakeSigns } from './signLayer';

/** A TILE'S SIGNS AS A NEAR PRODUCT (`nearTiles.ts`): its junctions' plates and its sign items' baked in a worker (`bakeSigns`, the same standing as the page's layer), stood in the signs' own layer (its posts' cells, its plates' sheets painted on the page) */

/** What a sign bake reads from the page: the plates' standard (the roads' paint style). */
export interface SignExtra {
  readonly markingStyle: string;
}

/** THE TILE'S OWN JUNCTIONS AND SIGN ITEMS: each in one tile's records, on the roads of the 3 x 3 round it (a junction on the edge has its legs; a street's name plates stand at the ends of its segments read) */
export const signBaker: NearBaker<SignBake | null, SignExtra> = {
  parts: ['roads', 'rest'],
  around: true,
  // A plate stands on its footway's deck (the roads' heights, solved on the natural ground).
  groundReach: m(16),
  bake(area, extra) {
    const tile = area.tile;
    const signs = tile.landscape.filter((item) => item.kind === 'sign').map((item) => item.id);
    const names = tile.landscape.filter((item) => item.kind === 'streetname' && !!item.text).map((item) => item.id);
    if (!tile.nodes.length && !signs.length && !names.length) return null;
    const style = (doc: { markingStyle: string }): void => { if (isMarkingStyle(extra.markingStyle)) (doc as { markingStyle: typeof extra.markingStyle }).markingStyle = extra.markingStyle; };
    style(area.doc());
    // The junctions' plates and the placed signs read the roads round the tile (the fringe); a street's name plates stand at the ends of every segment of its street, walked whole (`streetChain`): the tiles read whole for those alone.
    const near = bakeSigns(area.net(), area.elevation(), tile.nodes.map((n) => n.id as NodeId), signs);
    let named: ReturnType<typeof bakeSigns> = null;
    if (names.length) {
      const wide = area.wide();
      style(wide.doc);
      named = bakeSigns(wide.net, wide.elevation, [], names);
    }
    const stands = [...(near?.stands ?? []), ...(named?.stands ?? [])];
    return stands.length ? { stands } : null;
  },
  buffers: () => [],
};

/** A tile's signs as the page draws them: stood in the layer (posts and plates). */
export function signProduct(layer: SignLayerKept, markingStyle: () => string): NearProduct<SignBake> {
  return {
    kind: 'signs',
    // As far as a plate on its post shows: a metre square covering a pixel.
    cover: m(1) * m(1),
    top: m(4),
    version: () => markingStyle(),
    extra: (): SignExtra => ({ markingStyle: markingStyle() }),
    land: (bake) => ({ put: () => layer.put(bake), remove: () => layer.take(bake) }),
  };
}
