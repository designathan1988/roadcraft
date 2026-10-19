import { type InstancedMesh, Sphere } from 'three';

/** `mesh`'s bounding sphere round its first `n` instances (InstancedMesh docs: "You may need to recompute the bounding sphere if an instance is transformed"): the box of their places, widened by the model's sphere at the largest scale any of them has. Conservative: no instance is ever left out. */
/** `grow`: the model's sphere widened by this much (a skinned body's limbs reach past its rest pose). */
export function fitInstances(mesh: InstancedMesh, n: number, grow = 1): void {
  const a = mesh.instanceMatrix.array as Float32Array;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, scale2 = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const x = a[o + 12]!, y = a[o + 13]!, z = a[o + 14]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    const sx = a[o]! * a[o]! + a[o + 1]! * a[o + 1]! + a[o + 2]! * a[o + 2]!;
    const sy = a[o + 4]! * a[o + 4]! + a[o + 5]! * a[o + 5]! + a[o + 6]! * a[o + 6]!;
    const sz = a[o + 8]! * a[o + 8]! + a[o + 9]! * a[o + 9]! + a[o + 10]! * a[o + 10]!;
    scale2 = Math.max(scale2, sx, sy, sz);
  }
  const geometry = mesh.geometry;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const model = geometry.boundingSphere!;
  const reach = (model.radius * grow + model.center.length()) * Math.sqrt(scale2);
  const sphere = mesh.boundingSphere ??= new Sphere();
  sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  sphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + reach;
}
