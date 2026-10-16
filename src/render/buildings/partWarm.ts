import { Color, InstancedMesh } from 'three';
import { FURNITURE_KINDS } from '@world/buildings/interior';
import { COLOURED_PARTS } from './buildingMesh';
import { type BuildingKit, PART_KINDS } from './kit';

/** One instance of every part and piece of furniture as the buildings' layer draws them */
export function partWarmMeshes(kit: BuildingKit): InstancedMesh[] {
  const out: InstancedMesh[] = [];
  for (const kind of PART_KINDS) {
    const mesh = new InstancedMesh(kit.geometry[kind], kit.material[kind], 1);
    if (COLOURED_PARTS.has(kind)) mesh.setColorAt(0, new Color(1, 1, 1));
    mesh.castShadow = kit.castsShadow.has(kind);
    out.push(mesh);
  }
  // The shell's parts faded with the shell ("Ocultar outros", `fade.ts`): its plain program drawn instanced, every kind of them one.
  const faded = new InstancedMesh(kit.geometry.lotBox, kit.dimShell, 1);
  faded.setColorAt(0, new Color(1, 1, 1));
  out.push(faded);
  const furniture = kit.furniture();
  for (const kind of FURNITURE_KINDS) {
    const mesh = new InstancedMesh(furniture.geometry[kind], furniture.material, 1);
    mesh.castShadow = true;
    out.push(mesh);
  }
  for (const mesh of out) { mesh.receiveShadow = true; mesh.frustumCulled = false; }
  return out;
}
