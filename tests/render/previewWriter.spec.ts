import { describe, expect, it, vi } from 'vitest';
import type { InstancedMesh, Mesh } from 'three';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { ShellWriter, assembleBuildingMeshes, buildBuildingMeshes, emitChunk } from '@render/buildings/buildingMesh';
import { createBuildingKit } from '@render/buildings/kit';

/** THE PREVIEW'S MESHES (`buildBuildingMeshes`): emitted into one shell written again, the same meshes as a shell of their own */

const slope = (x: number, y: number): number => x * 0.05 + y * 0.03;
const placed = (index: number): Building => ({ ...JSON.parse(JSON.stringify(BLUEPRINTS[index]!.body)), id: index + 1, x: index * 60, y: 20, rotation: 0.3 }) as Building;

/** Every mesh's arrays: its attributes, index and instances, by name. */
function arraysOf(meshes: ReturnType<typeof buildBuildingMeshes>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  meshes.group.traverse((o) => {
    const mesh = o as Mesh & Partial<InstancedMesh>;
    if (!mesh.geometry) return;
    const g = mesh.geometry;
    for (const [name, a] of Object.entries(g.attributes)) out[`${mesh.name}/${name}`] = Array.from(a.array as ArrayLike<number>);
    if (g.index) out[`${mesh.name}/index`] = Array.from(g.index.array as ArrayLike<number>);
    if (mesh.instanceMatrix) out[`${mesh.name}/instances`] = [...mesh.instanceMatrix.array].slice(0, (mesh.count ?? 0) * 16);
  });
  return out;
}

describe('the preview meshes', () => {
  it('are emitted into one shell written again, and come out as with a shell of their own', () => {
    const kit = createBuildingKit();
    const next = vi.spyOn(ShellWriter.prototype, 'next');
    // One building, another, the first again: what the first left in the shell does not show in the next.
    for (const index of [0, 1, 0, 2]) {
      const b = placed(index);
      const shared = buildBuildingMeshes([b], slope, kit, true);
      const own = assembleBuildingMeshes([emitChunk(b, slope)], kit, true);
      expect(arraysOf(shared)).toEqual(arraysOf(own));
      shared.dispose(); own.dispose();
    }
    expect(next).toHaveBeenCalledTimes(4);
    next.mockRestore();
  });
});
