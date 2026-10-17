import { BoxGeometry, CylinderGeometry, type Material, type Object3D } from 'three';
import type { SegmentRibbon } from '@world/network';
import { m } from '@world/units';
import type { SceneMaterials } from './materials';
import type { NearBaker, NearProduct } from './nearTileBake';
import { PIER_FOOT_FLARE, type StructureParts, structureBuffers, structureMeshes, structureParts } from './structures';

/** A TILE'S ROAD STRUCTURES AS A NEAR PRODUCT (`nearTiles.ts`): the piers, crossbeams, abutments and parapets of its raised roads, the retaining walls of its cuttings, its tunnels' portals, baked in a worker (`structureParts`, the same making as the page's) from the tile's roads solved with its neighbours', drawn as meshes made of those arrays (`structureMeshes`) */

/** What a structure bake reads from the page: the deck's texture scale (`SceneMaterials.scale.deck`). */
export interface StructureExtra {
  readonly deckTile: number;
}

/** THE STRUCTURES OF THE TILE'S OWN ROADS (each road in one tile's records), on the heights solved over the 3 x 3 round it: two tiles never draw one twice nor leave one out */
export const structureBaker: NearBaker<StructureParts | null, StructureExtra> = {
  parts: ['roads'],
  around: true,
  // A structure reads the ground round its road (abutments, piers' feet, portals' wings, `SPAN_REACH`).
  groundReach: m(64),
  has: (tile) => tile.segments.length > 0,
  bake(area, extra) {
    const net = area.net();
    const ribbons: SegmentRibbon[] = [];
    for (const s of area.tile.segments) { const ribbon = net.ribbons.get(s.id as SegmentRibbon['id']); if (ribbon) ribbons.push(ribbon); }
    if (!ribbons.length) return null;
    ribbons.sort((a, b) => a.id - b.id);
    const parts = structureParts(net, area.elevation(), area.groundAt, extra.deckTile, ribbons);
    const empty = !parts.piers.length && !parts.caps.length && !parts.abutments.length && !parts.jambs.length && !parts.lintels.length && !parts.headwalls.length
      && !parts.parapets && !parts.walls && !parts.backfill;
    return empty ? null : parts;
  },
  buffers: (parts) => (parts ? structureBuffers(parts) : []),
};

/** A tile's structures as the page draws them: their meshes under `parent`, in the page's materials (`groundMaterial`, the backfill's), on shapes made once. */
export function structureProduct(parent: Object3D, materials: SceneMaterials, groundMaterial: Material): NearProduct<StructureParts> {
  const shapes = { pier: new CylinderGeometry(1, PIER_FOOT_FLARE, 1, 16), box: new BoxGeometry(1, 1, 1) };
  return {
    kind: 'structures',
    // A pier or a portal, several metres across, seen from afar.
    cover: m(5) * m(5),
    top: m(60),
    extra: (): StructureExtra => ({ deckTile: materials.scale.deck }),
    land(parts) {
      const details = structureMeshes(parts, materials, groundMaterial, shapes);
      return {
        put: () => parent.add(details.group),
        remove: () => { parent.remove(details.group); details.dispose(); },
      };
    },
  };
}
