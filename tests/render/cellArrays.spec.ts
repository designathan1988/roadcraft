import { describe, expect, it } from 'vitest';
import { Box3, BufferAttribute, BufferGeometry, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial, Sphere } from 'three';

import { emitChunk, kitBoxes } from '@render/buildings/buildingMesh';
import { cellArrays } from '@render/buildings/cellArrays';
import { PART_KINDS, createBuildingKit } from '@render/buildings/kit';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/** A BATCH'S BOUNDS WORKED OUT WITH ITS ARRAYS ARE THREE'S (`cellArrays.ts`) */
const groundAt = (x: number, y: number): number => x * 0.02 - y * 0.01;

describe('a batch as arrays', () => {
  const kit = createBuildingKit();
  const chunks = BLUEPRINTS.map((bp, i) => emitChunk({ ...JSON.parse(JSON.stringify(bp.body)), id: i + 1, x: (i % 7) * m(70), y: Math.floor(i / 7) * m(70), rotation: 0.3 * i } as Building, groundAt));
  const arrays = cellArrays(chunks, { parts: PART_KINDS, shells: true, furniture: true, ghost: false, dim: false }, kitBoxes(kit));

  it("has three's bounds for its shell", () => {
    expect(arrays.shell).not.toBeNull();
    for (const shell of [arrays.shell]) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(shell!.position, 3));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      const b = shell!.bounds;
      expect([...b.slice(0, 6)]).toEqual([g.boundingBox!.min.x, g.boundingBox!.min.y, g.boundingBox!.min.z, g.boundingBox!.max.x, g.boundingBox!.max.y, g.boundingBox!.max.z]);
      expect([...b.slice(6)]).toEqual([g.boundingSphere!.center.x, g.boundingSphere!.center.y, g.boundingSphere!.center.z, g.boundingSphere!.radius]);
    }
  });

  it("has three's bounds for every instanced batch", () => {
    const parts = Object.entries(arrays.parts);
    expect(parts.length).toBeGreaterThan(5);
    for (const [kind, part] of parts) {
      const mesh = new InstancedMesh(kit.geometry[kind as keyof typeof kit.geometry], new MeshBasicMaterial(), part!.count);
      mesh.instanceMatrix = new InstancedBufferAttribute(part!.instanceMatrix, 16);
      mesh.computeBoundingBox();
      const box = mesh.boundingBox!;
      const sphere = box.getBoundingSphere(new Sphere());
      const b = part!.bounds;
      expect([...b.slice(0, 6)], kind).toEqual([box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]);
      expect([...b.slice(6)], kind).toEqual([sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius]);
      expect(new Box3().copy(box).isEmpty()).toBe(false);
    }
  });
});
