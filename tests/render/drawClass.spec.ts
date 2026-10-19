import { MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { createBuildingKit } from '@render/buildings/kit';
import { BEHIND, OCCLUDER, opaqueSort } from '@render/drawClass';

type Mat = MeshStandardMaterial & { readonly id: number };
const item = (material: Mat, over: Partial<{ groupOrder: number; renderOrder: number; z: number; id: number }> = {}) =>
  ({ groupOrder: 0, renderOrder: 0, materialVariant: 0, z: 0, id: 0, material, ...over });

describe('the opaques drawn by who hides whom (PRD-05)', () => {
  const kit = createBuildingKit();
  const shell = kit.shellMaterial as Mat;
  const glass = kit.material.glass as Mat;
  const concrete = kit.material.concrete as Mat;

  it('draws the shell first and the panes last, whatever order their materials were made in', () => {
    expect(glass.id).toBeLessThan(shell.id);
    const list = [item(glass), item(concrete), item(shell)].sort(opaqueSort);
    expect(list.map((i) => i.material)).toEqual([shell, concrete, glass]);
    expect(glass.userData['drawClass']).toBe(BEHIND);
    expect(shell.userData['drawClass']).toBe(OCCLUDER);
  });

  it('keeps three\'s order otherwise: group, renderOrder (the faded "hide the others" after), then front to back within a material', () => {
    const faded = item(shell, { renderOrder: 1 });
    expect([faded, item(glass)].sort(opaqueSort)[0]!.material).toBe(glass);
    expect([item(glass, { groupOrder: 1 }), item(glass)].sort(opaqueSort)[0]!.groupOrder).toBe(0);
    const near = item(concrete, { z: 1, id: 2 }), far = item(concrete, { z: 5, id: 1 });
    expect([far, near].sort(opaqueSort)[0]).toBe(near);
  });
});
