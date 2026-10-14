import { Color, InstancedMesh } from 'three';
import { FURNITURE_KINDS } from '@world/buildings/interior';
import { COLOURED_PARTS } from './buildingMesh';
import { type BuildingKit, PART_KINDS } from './kit';

/**
 * One instance of every part and piece of furniture as the buildings' layer
 * draws them (`buildingMesh.ts` parts: instanced, a colour per instance for
 * the trims, the shadow where the kit casts one), for their programs to be
 * compiled ahead (`renderer.ts` `warmBlastShaders`, `compileAhead`). The
 * layer makes a kind's mesh only when a cell near the camera has some: a
 * balcony's chairs, bushes and airers compiled in the frame they first came
 * into view, stalls in the middle of a pan (20 programs over a pan across a
 * new town, 2026-10-14). Compiled as plain meshes they were other programs.
 * NÃO trocar por Mesh simples: o programa instanciado é outro e travaria igual.
 */
export function partWarmMeshes(kit: BuildingKit): InstancedMesh[] {
  const out: InstancedMesh[] = [];
  for (const kind of PART_KINDS) {
    const mesh = new InstancedMesh(kit.geometry[kind], kit.material[kind], 1);
    if (COLOURED_PARTS.has(kind)) mesh.setColorAt(0, new Color(1, 1, 1));
    mesh.castShadow = kit.castsShadow.has(kind);
    out.push(mesh);
  }
  const furniture = kit.furniture();
  for (const kind of FURNITURE_KINDS) {
    const mesh = new InstancedMesh(furniture.geometry[kind], furniture.material, 1);
    mesh.castShadow = true;
    out.push(mesh);
  }
  for (const mesh of out) { mesh.receiveShadow = true; mesh.frustumCulled = false; }
  return out;
}
