import { Rng } from '@core/rng';
import { BLUEPRINTS, instantiate, type BlueprintBody } from '@world/buildings/blueprints';
import { CITY_BUILDINGS } from '@world/buildings/cityBuildings';
import { madeToMeasure } from '@world/buildings/procedural';
import { buildingHeight } from '@world/buildings/geometry';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { createBuildingKit } from '../../render/buildings/kit';
import { buildBuildingMeshes } from '../../render/buildings/buildingMesh';
import type { BatchCache } from './capture';
import { piecesOf, shown } from './layout';
import type { ItemSpec } from './items';

/** THE BUILDINGS AS THE ENGINE'S OWN GENERATORS MAKE THEM, no city: every preset (`blueprints.ts`), every building of a function (`cityBuildings.ts`),
 *  and the made-to-measure buildings of every use and density (`procedural.ts` madeToMeasure) on three lots, small, medium and large; each built by
 *  the building builder (`buildingMesh.ts` buildBuildingMeshes) with every part (windows, balconies, railings, units, pots...), drawn with each part
 *  where its pose puts it. Their cut-open interiors and their editor ghost alongside. */

type Add = (spec: ItemSpec) => void;

/** The lots the made-to-measure buildings are made for: width and depth, metres. */
const LOTS = [['small', m(12), m(16)], ['medium', m(24), m(26)], ['large', m(40), m(36)]] as const;
const USES = ['residential', 'commercial', 'industrial'] as const;
const DENSITIES = ['low', 'medium', 'high'] as const;

/** A building's floors: its height over its storey. */
const floorsOf = (b: Building): number => Math.max(1, Math.round(buildingHeight(b) / Math.max(0.5, b.storeyHeight)));

/** Every building the generators make, each built alone. */
export function engineBuildingItems(add: Add): void {
  const kit = createBuildingKit(16);
  const cache: BatchCache = new Map();
  let id = 1;
  let interiors = 0;
  const one = (group: string, name: string, variation: string, source: string, body: BlueprintBody, key?: string): void => {
    const b = { ...instantiate(body, { x: 0, y: 0 }, 0, key), id: id++ as BuildingId } as Building;
    const built = buildBuildingMeshes([b], () => 0, kit);
    const floors = floorsOf(b);
    add({ group, name, variation: `${variation} (${floors} floors)`, origin: 'kit', source, build: 'merged', floors,
      pieces: piecesOf(built.group), object: shown(built.group, cache), countKey: `building:${group}:${name}:${variation}`,
      notes: ['built alone at its detail level (L0) by buildBuildingMeshes, every part with it; its far levels (facade L1, masses) are the building layer\'s cells'] });
    // The Construction tool's cut-open view and the editor's ghost, of one building of each kind of generator.
    if (interiors < 3 && floors >= 3) {
      interiors++;
      const cut = buildBuildingMeshes([{ ...b, cutaway: 1 }], () => 0, kit);
      add({ group: 'Buildings: interiors (cut open)', name, variation: `${floors} floors, cut above level 1`, origin: 'editor preview', preview: true,
        source: 'src/render/buildings/buildingMesh.ts (cutaway)', build: 'merged', pieces: piecesOf(cut.group), object: shown(cut.group, cache),
        notes: ['the Construction tool\'s cut-open view: walls, floors and furniture of the cut level'] });
      const ghost = buildBuildingMeshes([b], () => 0, kit, true);
      add({ group: 'Editor previews', name: 'building ghost', variation: name, origin: 'editor preview', preview: true, source: 'src/render/buildings/buildingMesh.ts (ghost)',
        build: 'merged', pieces: piecesOf(ghost.group), object: shown(ghost.group, cache) });
    }
  };
  for (const bp of BLUEPRINTS) one('Buildings: presets', bp.key, 'preset', 'src/world/buildings/blueprints.ts (BLUEPRINTS, instantiate)', bp.body, bp.key);
  for (const cb of CITY_BUILDINGS) one('Buildings: functions', cb.fn, cb.category, 'src/world/buildings/cityBuildings.ts (CITY_BUILDINGS)', cb.body);
  for (const use of USES) {
    for (const density of DENSITIES) {
      for (const [size, W, D] of LOTS) {
        const made = madeToMeasure(use, density, { W, D }, new Rng(1));
        one('Buildings: made to measure', `${use} ${density}`, `${size} lot ${W} x ${D} m (${made.fn})`, 'src/world/buildings/procedural.ts (madeToMeasure)', made.body);
      }
    }
  }
}
