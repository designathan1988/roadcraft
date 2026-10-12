import { describe, expect, it } from 'vitest';
import type { BufferAttribute, Mesh } from 'three';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { assembleBuildingMeshes, emitChunk, refillShells } from '@render/buildings/buildingMesh';
import { createBuildingKit } from '@render/buildings/kit';

/**
 * THE TOWN'S SHELLS LIVE ON THE GPU (`render/buildings/buildingMesh.ts`):
 * their arrays, copies of the chunks', are let go once the renderer uploads
 * them (a third of a big town's heap), and come back the same from the
 * chunks when a lost WebGL context is restored. The preview keeps its own.
 */
function placed(index: number): Building {
  const bp = BLUEPRINTS[index]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), id: index + 1, x: index * 60, y: 20, rotation: 0.3 } as Building;
}

describe("the town's shells", () => {
  it('let their arrays go once uploaded, and take them back the same when the context is restored', () => {
    const kit = createBuildingKit();
    const chunks = [emitChunk(placed(0), () => 0), emitChunk(placed(1), () => 0)];
    const meshes = assembleBuildingMeshes(chunks, kit);
    const shells = meshes.group.children.filter((m) => m.name.startsWith('building-shell-')) as Mesh[];
    expect(shells.length).toBeGreaterThan(0);
    const before = shells.map((m) => [...Object.values(m.geometry.attributes), m.geometry.index!].map((a) => Array.from((a as BufferAttribute).array)));
    // The renderer's upload (WebGLAttributes calls it after bufferData).
    for (const m of shells) for (const a of [...Object.values(m.geometry.attributes), m.geometry.index!]) (a as BufferAttribute).onUploadCallback();
    for (const m of shells) {
      for (const a of [...Object.values(m.geometry.attributes), m.geometry.index!]) expect((a as BufferAttribute).array).toBeNull();
      // Bounds were worked out before: culling and the shadows' box still read them.
      expect(m.geometry.boundingSphere).not.toBeNull();
      expect(m.geometry.boundingBox).not.toBeNull();
    }
    refillShells(meshes.group);
    shells.forEach((m, k) => {
      const after = [...Object.values(m.geometry.attributes), m.geometry.index!].map((a) => Array.from((a as BufferAttribute).array));
      expect(after).toEqual(before[k]);
    });
    meshes.dispose();
  });

  it('keeps the preview\'s arrays (it is redrawn as the player moves it)', () => {
    const kit = createBuildingKit();
    const meshes = assembleBuildingMeshes([emitChunk(placed(2), () => 0)], kit, true);
    const shells = meshes.group.children.filter((m) => m.name.startsWith('building-preview-shell-')) as Mesh[];
    expect(shells.length).toBeGreaterThan(0);
    for (const m of shells) for (const a of Object.values(m.geometry.attributes)) { (a as BufferAttribute).onUploadCallback(); expect((a as BufferAttribute).array).not.toBeNull(); }
    meshes.dispose();
  });
});
