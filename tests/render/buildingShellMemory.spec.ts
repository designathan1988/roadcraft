import { describe, expect, it } from 'vitest';
import type { BufferAttribute, InstancedMesh, InterleavedBufferAttribute, Mesh } from 'three';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { assembleBuildingMeshes, emitChunk } from '@render/buildings/buildingMesh';
import { refillArrays } from '@render/mesh/gpuOnly';
import { createBuildingKit } from '@render/buildings/kit';

/** THE TOWN'S SHELLS LIVE ON THE GPU (`render/buildings/buildingMesh.ts`) */

/** What three uploads of a geometry: each attribute, an interleaved one by its buffer (once), and the index. */
function uploads(m: Mesh, withIndex = true): { array: ArrayLike<number> | null; onUploadCallback(): void }[] {
  const out = new Set<{ array: ArrayLike<number> | null; onUploadCallback(): void }>();
  for (const a of Object.values(m.geometry.attributes)) out.add((a as InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as InterleavedBufferAttribute).data : a as BufferAttribute);
  if (withIndex && m.geometry.index) out.add(m.geometry.index);
  return [...out];
}
function placed(index: number): Building {
  const bp = BLUEPRINTS[index]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), id: index + 1, x: index * 60, y: 20, rotation: 0.3 } as Building;
}

describe("the town's shells", () => {
  it('let their arrays go once uploaded, and take them back the same when the context is restored', () => {
    const kit = createBuildingKit();
    const chunks = [emitChunk(placed(0), () => 0), emitChunk(placed(1), () => 0)];
    const meshes = assembleBuildingMeshes(chunks, kit);
    const shells = meshes.group.children.filter((m) => m.name === 'building-shell') as Mesh[];
    expect(shells.length).toBe(1);
    const before = shells.map((m) => uploads(m).map((a) => Array.from(a.array!)));
    // The renderer's upload (WebGLAttributes calls it after bufferData).
    for (const m of shells) for (const a of uploads(m)) a.onUploadCallback();
    for (const m of shells) {
      for (const a of uploads(m)) expect(a.array).toBeNull();
      // Bounds were worked out before: culling and the shadows' box still read them.
      expect(m.geometry.boundingSphere).not.toBeNull();
      expect(m.geometry.boundingBox).not.toBeNull();
    }
    refillArrays(meshes.group);
    shells.forEach((m, k) => {
      const after = uploads(m).map((a) => Array.from(a.array!));
      expect(after).toEqual(before[k]);
    });
    meshes.dispose();
  });

  it('let their parts\' own arrays go too, never the kit\'s shared geometry, and take them back the same', () => {
    const kit = createBuildingKit();
    const chunks = [0, 1, 2, 3].map((i) => emitChunk(placed(i), () => 0));
    const meshes = assembleBuildingMeshes(chunks, kit);
    const parts = meshes.group.children.filter((m) => (m as InstancedMesh).isInstancedMesh) as InstancedMesh[];
    expect(parts.some((p) => p.name === 'building-glass')).toBe(true);
    const own = (p: InstancedMesh): { array: ArrayLike<number> | null; onUploadCallback(): void }[] => {
      const list: { array: ArrayLike<number> | null; onUploadCallback(): void }[] = [p.instanceMatrix];
      if (p.instanceColor) list.push(p.instanceColor);
      if (p.userData['ownGeometry']) {
        for (const name of ['position', 'normal', 'uv', 'litSlot']) list.push(p.geometry.getAttribute(name) as BufferAttribute);
        list.push((p.geometry.getAttribute('roomA') as InterleavedBufferAttribute).data);
      }
      return list;
    };
    const before = parts.map((p) => own(p).map((a) => Array.from(a.array!)));
    for (const p of parts) for (const a of own(p)) a.onUploadCallback();
    for (const p of parts) {
      for (const a of own(p)) expect(a.array).toBeNull();
      expect(p.boundingSphere).not.toBeNull();
      // The kit's geometry, drawn by every batch of the kind, keeps its arrays.
      if (!p.userData['ownGeometry']) expect(p.geometry.getAttribute('position').array).not.toBeNull();
    }
    refillArrays(meshes.group);
    parts.forEach((p, k) => expect(own(p).map((a) => Array.from(a.array!))).toEqual(before[k]));
    meshes.dispose();
  });

  it('keeps the preview\'s arrays (it is redrawn as the player moves it)', () => {
    const kit = createBuildingKit();
    const meshes = assembleBuildingMeshes([emitChunk(placed(2), () => 0)], kit, true);
    const shells = meshes.group.children.filter((m) => m.name === 'building-preview-shell') as Mesh[];
    expect(shells.length).toBeGreaterThan(0);
    for (const m of shells) for (const a of uploads(m, false)) { a.onUploadCallback(); expect(a.array).not.toBeNull(); }
    meshes.dispose();
  });
});
