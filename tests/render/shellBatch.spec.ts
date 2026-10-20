import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, type BatchedMesh } from 'three';
import { createBuildingKit } from '@render/buildings/kit';
import { ShellBatch } from '@render/buildings/shellBatch';
import { SHELL_MESH } from '@render/buildings/cellArrays';
import type { BuildingMeshes } from '@render/buildings/buildingMesh';

/** A cell's landed meshes holding one shell piece (`ShellBatch.add` takes the meshes named `SHELL_MESH`). */
function landed(): BuildingMeshes {
  const group = new Group();
  const shell = new Mesh(new BoxGeometry(4, 6, 4), new MeshBasicMaterial());
  shell.name = SHELL_MESH;
  group.add(shell);
  return { group } as unknown as BuildingMeshes;
}

const castVersion = (batch: ShellBatch): number => {
  const mesh = batch.detailGroup.children[0] as BatchedMesh;
  return (mesh.userData['castVersion'] as number | undefined) ?? 0;
};

describe("the cells' walls batched", () => {
  it('tell the shadows of every piece added, shown, hidden or taken out: none of its attributes changes for a piece shown or hidden', () => {
    const batch = new ShellBatch(createBuildingKit());
    const steps: number[] = [castVersion(batch)];
    batch.add('cell', '0,0', landed());
    steps.push(castVersion(batch));
    batch.setVisible('cell', '0,0', false);
    steps.push(castVersion(batch));
    // The same state again: nothing changed, nothing told.
    batch.setVisible('cell', '0,0', false);
    steps.push(castVersion(batch));
    batch.setVisible('cell', '0,0', true);
    steps.push(castVersion(batch));
    batch.remove('cell', '0,0');
    steps.push(castVersion(batch));
    expect(steps[1]).toBeGreaterThan(steps[0]!);
    expect(steps[2]).toBeGreaterThan(steps[1]!);
    expect(steps[3]).toBe(steps[2]);
    expect(steps[4]).toBeGreaterThan(steps[3]!);
    expect(steps[5]).toBeGreaterThan(steps[4]!);
    batch.dispose();
  });
});
