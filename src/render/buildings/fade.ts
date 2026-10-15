import type { InstancedMesh, Mesh, Object3D } from 'three';
import { FINISHES, type Finish } from '@world/buildings/materials';
import { type BuildingKit, PART_KINDS, type PartKind } from './kit';

/** DO NOT emit the town again to fade it */
const SHELL = 'building-shell-';
const FURNITURE = 'building-furniture-';

export function fadeMeshes(root: Object3D, kit: BuildingKit, faded: boolean): void {
  root.traverse((o) => {
    const name = o.name;
    if (name.startsWith(SHELL)) {
      const finish = name.slice(SHELL.length);
      if (!(FINISHES as readonly string[]).includes(finish)) return;
      const mesh = o as Mesh;
      mesh.material = faded ? kit.dimShell[finish as Finish] : kit.shell[finish as Finish];
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
    if (kind === 'wash') { mesh.visible = !faded; return; }
    mesh.material = faded ? kit.dimParts : kit.material[kind as PartKind];
    mesh.renderOrder = faded ? 1 : 0;
  });
}
