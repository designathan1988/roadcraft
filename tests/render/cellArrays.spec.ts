import { poseMatrices } from '@render/buildings/partPose';
import { describe, expect, it } from 'vitest';
import { Box3, BufferAttribute, BufferGeometry, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial, Sphere } from 'three';

import { emitChunk, kitBoxes } from '@render/buildings/buildingMesh';
import { SHELL_PIECE, cellArrays } from '@render/buildings/cellArrays';
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
    expect(arrays.shells.length).toBeGreaterThan(0);
    for (const shell of arrays.shells) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(shell.position, 3));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      const b = shell.bounds;
      expect([...b.slice(0, 6)]).toEqual([g.boundingBox!.min.x, g.boundingBox!.min.y, g.boundingBox!.min.z, g.boundingBox!.max.x, g.boundingBox!.max.y, g.boundingBox!.max.z]);
      expect([...b.slice(6)]).toEqual([g.boundingSphere!.center.x, g.boundingSphere!.center.y, g.boundingSphere!.center.z, g.boundingSphere!.radius]);
    }
  });

  it('cuts its shell into pieces of whole buildings with 16-bit indices, every triangle kept', () => {
    const verticesOf = (list: typeof chunks): number => list.reduce((n, c) => n + Object.values(c.shells).reduce((k, s) => k + s.position.length / 3, 0), 0);
    // Enough buildings to pass two pieces' vertices.
    const many = Array.from({ length: Math.ceil((SHELL_PIECE * 2) / verticesOf(chunks)) + 1 }, () => chunks).flat();
    const made = verticesOf(many);
    const triangles = many.reduce((n, c) => n + Object.values(c.shells).reduce((k, s) => k + s.index.length / 3, 0), 0);
    expect(made).toBeGreaterThan(SHELL_PIECE * 2);
    const pieces = cellArrays(many, { parts: [], shells: true, furniture: false, ghost: false, dim: false }, kitBoxes(kit)).shells;
    expect(pieces.length).toBeGreaterThan(1);
    let vertices = 0, drawn = 0;
    for (const piece of pieces) {
      const n = piece.position.length / 3;
      vertices += n;
      drawn += piece.index.length / 3;
      // No building larger than a piece here: each piece's indices 16 bits, the primitive restart index never among them.
      expect(n).toBeLessThanOrEqual(SHELL_PIECE);
      expect(piece.index).toBeInstanceOf(Uint16Array);
      let most = 0;
      for (const i of piece.index) most = Math.max(most, i);
      expect(most).toBeLessThan(Math.min(n, 0xffff));
    }
    expect(vertices).toBe(made);
    expect(drawn).toBe(triangles);
  });

  it("has three's bounds for every instanced batch", () => {
    const parts = Object.entries(arrays.parts);
    expect(parts.length).toBeGreaterThan(5);
    for (const [kind, part] of parts) {
      const mesh = new InstancedMesh(kit.geometry[kind as keyof typeof kit.geometry], new MeshBasicMaterial(), part!.count);
      // The matrices the GPU makes from the poses (`partPose.ts`).
      mesh.instanceMatrix = new InstancedBufferAttribute(poseMatrices(part!.poses, part!.count), 16);
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
