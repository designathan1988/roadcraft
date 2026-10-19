import { BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { fitInstances } from '@render/instanceBounds';

/** AGT-04: an agent part is culled by a sphere fitted round its instances, never leaving one out. */
describe("an agent part's sphere", () => {
  it('holds every vertex of every instance, moved, turned and scaled', () => {
    const geometry = new BoxGeometry(1.8, 1.4, 4.2).translate(0, 0.7, 0.3);
    const mesh = new InstancedMesh(geometry, new MeshBasicMaterial(), 50);
    const m = new Matrix4(), q = new Quaternion();
    let seed = 7;
    const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 50; i++) {
      q.setFromAxisAngle(new Vector3(0, 1, 0), rnd() * 6.3);
      m.compose(new Vector3(rnd() * 900 - 450, rnd() * 20, rnd() * 900 - 450), q, new Vector3(0.5 + rnd(), 0.5 + rnd(), 0.5 + rnd()));
      mesh.setMatrixAt(i, m);
    }
    const n = 37;
    fitInstances(mesh, n);
    const sphere = mesh.boundingSphere!;
    const p = new Vector3(), position = geometry.getAttribute('position');
    for (let i = 0; i < n; i++) {
      mesh.getMatrixAt(i, m);
      for (let v = 0; v < position.count; v++) {
        p.fromBufferAttribute(position, v).applyMatrix4(m);
        expect(p.distanceTo(sphere.center)).toBeLessThanOrEqual(sphere.radius + 1e-6);
      }
    }
    // Not the whole map: a sphere round a few cars a few hundred metres across.
    expect(sphere.radius).toBeLessThan(800);
    // Culled by three in the camera and every shadow pass.
    expect(mesh.frustumCulled).toBe(true);
  });
});
