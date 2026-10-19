import { MeshBasicMaterial, MeshLambertMaterial, type Material, type Mesh, type Object3D } from 'three';
import { SHELL_MESH } from './buildings/cellArrays';
import { FACADE_PROP_KINDS } from './buildings/facadeProps';
import type { BuildingLayer, BuildingRoot } from './buildings/layerApi';
import type { BuildingChoices, BuildingSwitch, EffectSwitches, FrameHider } from './effectSwitches';

/** THE BUILDINGS' SWITCHES (the effects panel, `effectSwitches.ts`): each part of the layer and each kind of piece hidden for the frame, their materials drawn plain, their shadows left out of the sun's passes. */

const ROOT_SWITCH: Readonly<Record<BuildingRoot, BuildingSwitch>> = {
  masses: 'bMasses',
  farTiles: 'bFarTiles',
  facades: 'bFacadeLevel',
  cells: 'bDetail',
  parts: 'bParts',
  signatures: 'bSignatures',
  flags: 'bFlags',
};

/** A piece by the name its mesh is given (`buildingMesh.ts`, `partCells.ts`: `building-<kind>`), and the switch that hides it. */
const KIND_SWITCH: Readonly<Record<string, BuildingSwitch>> = Object.freeze({
  [SHELL_MESH]: 'bShell',
  ...Object.fromEntries(['glass', 'glassDark', 'glassRail'].map((k) => [`building-${k}`, 'bGlass'])),
  ...Object.fromEntries(['frame', 'door', 'shutter'].map((k) => [`building-${k}`, 'bFrames'])),
  ...Object.fromEntries(['railing', 'roofRailing', 'awning', 'column', 'water', 'lamp', 'wash', 'fin', 'louvre', 'brise'].map((k) => [`building-${k}`, 'bFacadeDetails'])),
  ...Object.fromEntries(['lotBox', 'lotRail', 'lotSlab'].map((k) => [`building-${k}`, 'bLots'])),
  ...Object.fromEntries(FACADE_PROP_KINDS.map((k) => [`building-${k}`, 'bProps'])),
}) as Readonly<Record<string, BuildingSwitch>>;
const kindOf = (name: string): BuildingSwitch | null =>
  KIND_SWITCH[name] ?? (name.startsWith('building-furniture-') ? 'bFurniture' : null);
const KIND_SWITCHES: readonly BuildingSwitch[] = ['bShell', 'bGlass', 'bFrames', 'bFacadeDetails', 'bLots', 'bProps', 'bFurniture'];

export interface BuildingSwitcher {
  /** Before the frame is drawn: the parts switched off hidden (by `hider`), the materials swapped. */
  beforeRender(on: EffectSwitches, choices: BuildingChoices, hider: FrameHider): void;
  /** After it: the materials given back, the shadows' hiding undone. */
  afterRender(): void;
  /** Each sun cascade's pass (`texel`), and their end (null): the buildings left out of it while their shadows are switched off. */
  casters(on: EffectSwitches, texel: number | null): void;
  dispose(): void;
}

export function createBuildingSwitcher(layer: BuildingLayer): BuildingSwitcher {
  const plain = { lambert: new MeshLambertMaterial({ color: 0xa8a8a8 }), basic: new MeshBasicMaterial({ color: 0x9a9a9a }) };
  const swapped: Mesh[] = [];
  const kept: (Material | Material[])[] = [];
  const toHide: Object3D[] = [];
  let shadowWas: boolean | null = null;

  const giveBackShadow = (): void => {
    if (shadowWas === null) return;
    layer.group.visible = shadowWas;
    shadowWas = null;
  };

  return {
    beforeRender(on, choices, hider) {
      if (!layer.group.visible) return;
      const roots = layer.roots();
      for (const root of Object.keys(ROOT_SWITCH) as BuildingRoot[]) if (!on[ROOT_SWITCH[root]]) toHide.push(roots[root]!);
      hider.hide(toHide);
      toHide.length = 0;
      const byKind = KIND_SWITCHES.some((key) => !on[key]);
      const swap = choices.material === 'normal' ? null : plain[choices.material];
      if (!byKind && !swap) return;
      // Only what is drawn: a hidden group's meshes are not walked.
      const walk = (object: Object3D): void => {
        if (!object.visible) return;
        if ((object as Mesh).isMesh) {
          const kind = byKind ? kindOf(object.name) : null;
          if (kind && !on[kind]) { toHide.push(object); return; }
          if (swap) {
            const mesh = object as Mesh;
            swapped.push(mesh);
            kept.push(mesh.material);
            mesh.material = swap;
          }
        }
        for (const child of object.children) walk(child);
      };
      walk(layer.group);
      hider.hide(toHide);
      toHide.length = 0;
    },
    afterRender() {
      for (let i = 0; i < swapped.length; i++) swapped[i]!.material = kept[i]!;
      swapped.length = 0;
      kept.length = 0;
      giveBackShadow();
    },
    casters(on, texel) {
      if (texel === null) { giveBackShadow(); return; }
      if (on.bShadows || shadowWas !== null) return;
      shadowWas = layer.group.visible;
      layer.group.visible = false;
    },
    dispose() {
      plain.lambert.dispose();
      plain.basic.dispose();
    },
  };
}
