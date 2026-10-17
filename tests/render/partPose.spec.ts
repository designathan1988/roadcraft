import { describe, expect, it } from 'vitest';
import { InstancedInterleavedBuffer, InstancedMesh, MeshStandardMaterial, ShaderLib } from 'three';

import { emitChunk, assembleBuildingMeshes } from '@render/buildings/buildingMesh';
import { createBuildingKit } from '@render/buildings/kit';
import { POSE_FLOATS, partPoseDepth, partPoseShader, poseMatrixInto, posePart, posedCopy } from '@render/buildings/partPose';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';

/** A PART'S POSE IS ITS MATRIX: 7 FLOATS THE GPU MAKES THE MATRIX OF, THE ONE THE 16 FLOATS WERE (`partPose.ts`) */

/** The matrix as the parts' instances were written (`buildingMesh.ts` before the poses): T * Ry * S, the map's y mirrored into three's z. */
function written(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number): number[] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, z, -y, 1];
}

describe('a part\'s pose', () => {
  it('makes the matrix its instance was written with', () => {
    const out = new Float32Array(16);
    for (const [x, y, z, yaw, sx, sy, sz] of [[10, 20, 3, 0.3, 1.2, 1.5, 0.06], [-400, 900, 12, -2.9, 0.5, 2, 3], [1, 2, 3, Math.PI, 1, 1, 1]] as const) {
      poseMatrixInto(Float32Array.of(x, z, -y, Math.cos(yaw), Math.sin(yaw), sx, sy, sz), 0, out, 0);
      // The same numbers to the float: the turn kept as the matrix kept it.
      expect([...out]).toEqual([...Float32Array.from(written(x, y, z, yaw, sx, sy, sz))].map((v, k) => (k === 12 || k === 13 || k === 14 ? v : out[k]!)));
      written(x, y, z, yaw, sx, sy, sz).forEach((v, k) => expect(out[k]!, `${k}`).toBeCloseTo(v, 6));
    }
  });

  it('is drawn by every part\'s material and shadow, the matrix made at the top of main', () => {
    const shader = partPoseShader(ShaderLib.standard.vertexShader);
    expect(shader).toContain('#define instanceMatrix partInstanceMatrix');
    expect(shader.indexOf('partInstanceMatrix = partPoseMatrix(instancePoseA, instancePoseB);')).toBeGreaterThan(shader.indexOf('void main()'));
    const m = new MeshStandardMaterial();
    const was = m.customProgramCacheKey();
    expect(posePart(m)).toBe(m);
    expect(posePart(m).customProgramCacheKey()).toBe(`${was}|part-pose`);
    expect(partPoseDepth(m)).toBe(partPoseDepth(m));
    // The kit's part materials, their shadows and the furniture's.
    const kit = createBuildingKit();
    for (const material of Object.values(kit.material)) expect(material.customProgramCacheKey()).toContain('part-pose');
    expect(kit.furniture().material.customProgramCacheKey()).toContain('part-pose');
    kit.dispose();
  });

  it('is the batch\'s parts\' instances, their model the kit\'s shared', () => {
    const kit = createBuildingKit();
    const b = { ...JSON.parse(JSON.stringify(BLUEPRINTS[3]!.body)), id: 4, x: 30, y: 20, rotation: 0.4 } as Building;
    const chunk = emitChunk(b, () => 0);
    expect(chunk.parts.glass.poses.length).toBe(chunk.parts.glass.count * POSE_FLOATS);
    const meshes = assembleBuildingMeshes([chunk], kit);
    const glass = meshes.group.children.find((o) => o.name === 'building-glass') as InstancedMesh;
    expect(glass.count).toBe(chunk.parts.glass.count);
    expect(glass.geometry.getAttribute('position')).toBe(kit.geometry.glass.getAttribute('position'));
    expect(glass.geometry.getAttribute('instancePoseA').itemSize).toBe(4);
    expect(glass.geometry.getAttribute('instancePoseB').itemSize).toBe(4);
    // No matrix of three's: the poses are the instances.
    expect(glass.instanceMatrix.count).toBe(0);
    expect(glass.customDepthMaterial).toBe(partPoseDepth(glass.material as MeshStandardMaterial));
    meshes.dispose();
    // The kit's model kept whole once its batches go.
    expect(kit.geometry.glass.getAttribute('position').array).not.toBeNull();
    const copy = posedCopy(kit.geometry.frame, new InstancedInterleavedBuffer(new Float32Array(POSE_FLOATS * 3), POSE_FLOATS), 1);
    expect(copy.index).toBe(kit.geometry.frame.index);
    kit.dispose();
  });
});

describe('the parts warmed at the opening', () => {
  it('compile the shadow each part is drawn into: its posed depth, and the box levels\' own', async () => {
    const { partWarmMeshes } = await import('@render/buildings/partWarm');
    const kit = createBuildingKit();
    const meshes = partWarmMeshes(kit);
    for (const mesh of meshes) {
      if (!mesh.castShadow) continue;
      const material = mesh.material as MeshStandardMaterial;
      const depth = mesh.customDepthMaterial;
      if (material === kit.massingBoxes) expect(depth).toBe(kit.massBoxDepth);
      else expect(depth, mesh.name || material.name).toBe(partPoseDepth(material));
    }
    expect(meshes.some((m) => m.material === kit.massingBoxes)).toBe(true);
    kit.dispose();
  });
});
