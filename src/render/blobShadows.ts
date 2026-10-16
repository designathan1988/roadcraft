import { BufferGeometry, DynamicDrawUsage, Float32BufferAttribute, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial, type Material } from 'three';
import { pullTowardEye } from './depthConvention';

/** Fake shadows, as the three.js manual's "Shadows" article draws them */
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

/** The discs' instanced mesh, none drawn: `capacity` instances to start (the vehicles write theirs as their own part, `agents.ts`). */
export function blobMesh(name: string, capacity: number, opacity = 0.34): InstancedMesh {
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
  return mesh;
}

/** `add`'s instance for a disc turned `yaw` about the vertical with its origin at (x, h, z), written into `out` at `offset`: no matrix made or multiplied. */
export function blobInto(out: Float32Array, offset: number, x: number, h: number, z: number, yaw: number, radius: number, length: number): void {
  // `makeRotationY(yaw)` times the disc's own scale and lift (`add`), column by column.
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out[offset] = c * radius; out[offset + 1] = 0; out[offset + 2] = -s * radius; out[offset + 3] = 0;
  out[offset + 4] = 0; out[offset + 5] = 1; out[offset + 6] = 0; out[offset + 7] = 0;
  out[offset + 8] = s * length; out[offset + 9] = 0; out[offset + 10] = c * length; out[offset + 11] = 0;
  out[offset + 12] = x; out[offset + 13] = LIFT + h; out[offset + 14] = z; out[offset + 15] = 1;
}

export function createBlobShadows(name: string, capacity: number, opacity = 0.34): BlobShadows {
  const mesh = blobMesh(name, capacity, opacity);
  const local = new Matrix4();
  const placed = new Matrix4();
  let n = 0;
  /** `capacity` is where it starts, not a ceiling: DO NOT drop what passes it */
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
      mesh.geometry.dispose();
      (mesh.material as Material).dispose();
    },
  };
}
