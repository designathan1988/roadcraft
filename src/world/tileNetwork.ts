import { identityMemo } from '@core/identityMemo';
import { RoadDoc, type TileRecords } from './doc';
import { Network } from './network';
import { METERS_PER_UNIT } from './units';

/** A TILE'S ROADS AS A NETWORK OF THEIR OWN where the tile is made or read (its nodes, its roads' foreign ends as borrowed nodes), built once per tile's records for every bake that reads it: its junctions' bake (`editor/tileStore.ts` bakeTileNetwork) and its parking bays (`sim/tileBays.ts`) - DO NOT build it again for each */
export const tileRoadNetwork = identityMemo((records: TileRecords): { readonly doc: RoadDoc; readonly net: Network } => {
  const owned = new Set(records.nodes.map((n) => n.id));
  const doc = RoadDoc.fromJSON({
    version: 1, unit: METERS_PER_UNIT,
    nodes: [...records.nodes, ...records.borrowedNodes.filter((n) => !owned.has(n.id))], segments: records.segments,
  }, { repair: false });
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
});
