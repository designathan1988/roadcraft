import { Rng } from '@core/rng';
import { BLUEPRINTS, instantiate, type BlueprintBody } from '@world/buildings/blueprints';
import { CITY_BUILDINGS } from '@world/buildings/cityBuildings';
import { madeToMeasure } from '@world/buildings/procedural';
import { buildingHeight } from '@world/buildings/geometry';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { createBuildingKit } from '../../render/buildings/kit';
import { assembleBuildingMeshes, buildBuildingMeshes, emitChunk } from '../../render/buildings/buildingMesh';
import { CELL_DETAIL, PLATE_DETAIL, TILE_DETAIL, emitMassing, massFloor } from '../../render/buildings/massing';
import { cellMass } from '../../render/buildings/cellArrays';
import { cellMesh } from '../../render/buildings/massCells';
import { BASE_VERTEX, CellWriter, emitBase } from '../../render/buildings/massBase';
import { drawsSignature } from '../../render/buildings/signature';
import { BufferAttribute, BufferGeometry as BufferGeometryClass, Mesh, MeshStandardMaterial, type Material } from 'three';
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

/** The far levels of every building the generators make, each built alone by the code the building layer's cells run: its facade from afar (L1, the bays
 *  laid as runs, `emitChunk` far), its masses at the cell's, the tile's and the plate's detail (`massing.ts` emitMassing, packed as the GPU takes them by
 *  `cellArrays.ts` cellMass, drawn by `massCells.ts` cellMesh), and its base (`massBase.ts` emitBase). */
export function engineBuildingFarItems(add: Add): void {
  const kit = createBuildingKit(16);
  const cache: BatchCache = new Map();
  const ground = (): number => 0;
  let id = 1;
  const one = (group: string, name: string, variation: string, body: BlueprintBody, key?: string): void => {
    const b = { ...instantiate(body, { x: 0, y: 0 }, 0, key), id: id++ as BuildingId } as Building;
    const signature = drawsSignature(b);
    const label = `${name} (${variation})`;
    const facade = assembleBuildingMeshes([emitChunk(b, ground, undefined, ground, undefined, true)], kit);
    add({ group: 'Buildings: far facade (L1)', name: label, variation: group, origin: 'kit', source: 'src/render/buildings/buildingMesh.ts (emitChunk far, assembleBuildingMeshes)', build: 'merged',
      pieces: piecesOf(facade.group), object: shown(facade.group, cache), countKey: `building-l1:${label}`,
      notes: ['the bays laid as runs, their windows drawn by the facade shader (facadeLevel.ts); what is set into an opening left to the shader'] });
    for (const [level, detail] of [['cell', CELL_DETAIL], ['tile', TILE_DETAIL], ['plate', PLATE_DETAIL]] as const) {
      const chunk = emitMassing(b, ground, undefined, ground, signature, undefined, detail);
      const mass = chunk ? cellMass([chunk]) : null;
      if (!mass) continue;
      const mesh = cellMesh(mass, kit);
      add({ group: `Buildings: masses (${level} level)`, name: label, variation: group, origin: 'kit', source: 'src/render/buildings/massing.ts (emitMassing) + massCells.ts (cellMesh)', build: 'merged',
        pieces: [{ label: 'masses', geometry: mesh.geometry, material: mesh.material as Material }], object: shown(mesh, cache), countKey: `building-mass-${level}:${label}`,
        notes: [`left out or laid flat at this level: up to ${detail.drop} m${detail.boxes ? ', pitched roofs as boxes' : ''}; the windows drawn by the massing shader`] });
    }
    const writer = new CellWriter();
    emitBase(writer, b, massFloor(b, ground), ground, signature);
    if (writer.index.length) {
      const g = new BufferGeometryClass();
      g.setAttribute('position', new BufferAttribute(new Float32Array(writer.position), 3));
      g.setIndex(writer.index);
      g.computeVertexNormals();
      const mesh = new Mesh(g, new MeshStandardMaterial({ color: 0xb9b2a6, roughness: 0.9 }));
      mesh.name = 'building-base';
      add({ group: 'Buildings: base (farthest level)', name: label, variation: group, origin: 'kit', source: 'src/render/buildings/massBase.ts (emitBase)', build: 'merged',
        pieces: [{ label: 'base', geometry: g, material: mesh.material }], object: mesh, countKey: `building-base:${label}`,
        notes: [`each block a prism, each paved lot a slab; on the GPU a vertex is ${BASE_VERTEX} shorts on its square's grid (massBase.ts)`] });
    }
  };
  for (const bp of BLUEPRINTS) one('preset', bp.key, 'preset', bp.body, bp.key);
  for (const cb of CITY_BUILDINGS) one('function', cb.fn, cb.category, cb.body);
  for (const use of USES) {
    for (const density of DENSITIES) {
      for (const [size, W, D] of LOTS) {
        const made = madeToMeasure(use, density, { W, D }, new Rng(1));
        one('made to measure', `${use} ${density}`, `${size} lot ${W} x ${D} m (${made.fn})`, made.body);
      }
    }
  }
}

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
