import type { InstancedMesh, Material, Mesh, Object3D } from 'three';
import { SHELL_MESH } from './cellArrays';
import { type BuildingKit, PART_KINDS, type PartKind } from './kit';
import { SHELL_PARTS } from './shellParts';

/** DO NOT emit the town again to fade it */
const FURNITURE = 'building-furniture-';

/** How a part kind is drawn faded ("Ocultar outros") or not: its material, its order and whether it is drawn at all (a lantern's light is not). */
export function partLook(kit: BuildingKit, kind: PartKind, faded: boolean): { material: Material; renderOrder: number; visible: boolean } {
  if (kind === 'wash') return { material: kit.material.wash, renderOrder: 0, visible: !faded };
  // The shell's parts fade as the shell they were laid in (`shellParts.ts`).
  const dim = SHELL_PARTS.has(kind) ? kit.dimShell : kit.dimParts;
  return { material: faded ? dim : kit.material[kind], renderOrder: faded ? 1 : 0, visible: true };
}

export function fadeMeshes(root: Object3D, kit: BuildingKit, faded: boolean): void {
  root.traverse((o) => {
    const name = o.name;
    if (name === SHELL_MESH) {
      const mesh = o as Mesh;
      // The facade level's shells (their window grid) back to their own material (`facadeLevel.ts`).
      const solid = mesh.geometry.hasAttribute('facadeCell') ? kit.facade : kit.shellMaterial;
      mesh.material = faded ? kit.dimShell : solid;
      mesh.renderOrder = faded ? 1 : 0;
      return;
    }
    if (name.startsWith(FURNITURE)) {
      const mesh = o as InstancedMesh;
      mesh.material = faded ? kit.dimParts : kit.furniture().material;
      mesh.renderOrder = faded ? 1 : 0;
      return;
    }
    if (!name.startsWith('building-')) return;
    const kind = name.slice('building-'.length);
    if (!(PART_KINDS as readonly string[]).includes(kind)) return;
    const mesh = o as InstancedMesh;
    const look = partLook(kit, kind as PartKind, faded);
    mesh.material = look.material;
    mesh.renderOrder = look.renderOrder;
    mesh.visible = look.visible;
  });
}
