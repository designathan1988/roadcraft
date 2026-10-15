import { BufferGeometry, DynamicDrawUsage, Float32BufferAttribute, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial } from 'three';
import { pullTowardEye } from './depthConvention';

/**
 * Fake shadows, as the three.js manual's "Shadows" article draws them: a flat
 * shape with a soft round shadow, just above the ground under what casts it,
 * unlit (`MeshBasicMaterial`), transparent and without depth writes. For what
 * is too small on the screen for the shadow map to be worth drawing it (the
 * far people, `proceduralCrowd.ts`): one instanced disc of 10 triangles each,
 * its middle dark and its rim clear by vertex alpha - no texture.
 */
export interface BlobShadows {
  readonly mesh: InstancedMesh;
  /** Starts a frame's list. */
  begin(): void;
  /** One under `matrix` (its origin on the ground): `radius` across and `length` along, in the matrix's own units. */
  add(matrix: Matrix4, radius: number, length?: number): void;
  /** Ends the list: only what was written goes to the GPU. */
  finish(): void;
  dispose(): void;
}

const SEGMENTS = 10;
/** Above the ground, in the matrix's units: clear of it without seeming to float. */
const LIFT = 0.03;

export function createBlobShadows(name: string, capacity: number, opacity = 0.34): BlobShadows {
  const positions = [0, 0, 0];
  const colours = [0, 0, 0, opacity];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    positions.push(Math.cos(a), 0, Math.sin(a));
    colours.push(0, 0, 0, 0);
  }
  // Counter-clockwise seen from above: facing up.
  const index: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) index.push(0, 1 + ((i + 1) % SEGMENTS), 1 + i);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(new Array(positions.length / 3).fill([0, 1, 0]).flat(), 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colours, 4));
  geometry.setIndex(index);
  const material = new MeshBasicMaterial({
    color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false,
  });
  // Over the ground it lies on, never into it.
  pullTowardEye(material, 2, 4);
  const mesh = new InstancedMesh(geometry, material, Math.max(1, capacity));
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.name = name;
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const local = new Matrix4();
  const placed = new Matrix4();
  let n = 0;
  /**
   * The buffer made at least `needed` long, doubling, what is written kept.
   * `capacity` is where it starts, not a ceiling: DO NOT drop what passes it -
   * the town's parked cars past the fleet's ceiling stood with no shadow.
   * three cannot resize an attribute, so it is a new one, the old one's GPU
   * buffer freed by the mesh's `dispose` (`WebGLObjects` `onInstancedMeshDispose`).
   */
  const grow = (needed: number): void => {
    let size = mesh.instanceMatrix.count;
    while (size < needed) size *= 2;
    const matrices = new InstancedBufferAttribute(new Float32Array(size * 16), 16);
    matrices.array.set(mesh.instanceMatrix.array);
    matrices.setUsage(DynamicDrawUsage);
    mesh.dispose();
    mesh.instanceMatrix = matrices;
  };
  return {
    mesh,
    begin() { n = 0; },
    add(matrix, radius, length = radius) {
      if (n >= mesh.instanceMatrix.count) grow(n + 1);
      local.makeScale(radius, 1, length);
      local.elements[13] = LIFT;
      mesh.setMatrixAt(n++, placed.multiplyMatrices(matrix, local));
    },
    finish() {
      mesh.count = n;
      mesh.visible = n > 0;
      const matrices = mesh.instanceMatrix;
      matrices.clearUpdateRanges();
      if (n > 0) {
        matrices.addUpdateRange(0, n * 16);
        matrices.needsUpdate = true;
      }
    },
    dispose() {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
