import { describe, expect, it } from 'vitest';
import { BatchedMesh, BoxGeometry, BufferAttribute, BufferGeometry, DataTexture, Group, InstancedMesh, InterleavedBuffer, InterleavedBufferAttribute, Mesh, MeshBasicMaterial, ShaderMaterial } from 'three';
import { countMemory } from '@render/memoryCounters';

/** THE SCENE'S MEMORY, COUNTED (`render/memoryCounters.ts`) */
describe('countMemory', () => {
  it('counts a shared geometry and texture once', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(30), 3));
    geometry.setIndex(new BufferAttribute(new Uint16Array(12), 1));
    const map = new DataTexture(new Uint8Array(8 * 8 * 4), 8, 8);
    const material = new MeshBasicMaterial({ map });
    const root = new Group();
    root.add(new Mesh(geometry, material), new Mesh(geometry, material));
    const c = countMemory(root);
    expect(c.buffers).toBe(2);
    expect(c.geometryBytes).toBe(30 * 4 + 12 * 2);
    expect(c.geometryCpuBytes).toBe(c.geometryBytes);
    expect(c.textures).toBe(1);
    expect(c.textureBytes).toBe(8 * 8 * 4);
  });

  it('keeps a buffer let go after upload on the GPU, off the CPU', () => {
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(new Float32Array(300), 3);
    geometry.setAttribute('position', position);
    const root = new Mesh(geometry, new MeshBasicMaterial());
    (position as { array: ArrayLike<number> | null }).array = null; // as `buildingMesh.ts` letGoOfArray
    const c = countMemory(root);
    expect(c.geometryBytes).toBe(300 * 4);
    expect(c.geometryCpuBytes).toBe(0);
  });

  it('counts instance matrices, an interleaved buffer once, and shader uniforms', () => {
    const interleaved = new InterleavedBuffer(new Float32Array(6 * 10), 6);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new InterleavedBufferAttribute(interleaved, 3, 0));
    geometry.setAttribute('normal', new InterleavedBufferAttribute(interleaved, 3, 3));
    const lut = new DataTexture(new Float32Array(4 * 4 * 4), 4, 4);
    const instanced = new InstancedMesh(geometry, new ShaderMaterial({ uniforms: { lut: { value: lut } } }), 5);
    const c = countMemory(instanced);
    expect(c.buffers).toBe(2); // the interleaved buffer, the instance matrices
    expect(c.geometryBytes).toBe(6 * 10 * 4 + 5 * 16 * 4);
    expect(c.textures).toBe(1);
    expect(c.textureBytes).toBe(4 * 4 * 4 * 4);
  });

  it("shows a BatchedMesh's capacity held on the CPU", () => {
    const batched = new BatchedMesh(10, 10_000, 30_000, new MeshBasicMaterial());
    batched.addGeometry(new BoxGeometry());
    const c = countMemory(batched);
    // position, normal, uv at capacity (three allocates the whole capacity), the index, the matrices texture.
    expect(c.geometryCpuBytes).toBeGreaterThanOrEqual(10_000 * (3 + 3 + 2) * 4 + 30_000 * 2);
    expect(c.textures).toBeGreaterThanOrEqual(1);
    // Who holds it, by name: the culprit of a regression named at once.
    batched.name = 'town-shells';
    const root = new Group();
    root.add(batched, new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    expect(countMemory(root).cpuByName[0]).toEqual(['town-shells', c.geometryCpuBytes]);
  });
});
