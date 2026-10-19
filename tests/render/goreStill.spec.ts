import { InstancedMesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createGore } from '@render/gore';

/** AGT-15: gore lying still is not sent to the GPU again, and is culled by a sphere round its pieces. */
describe('gore at rest', () => {
  it('sends its pieces while they move, none once they lie still, each mesh culled by its own sphere', () => {
    const gore = createGore();
    gore.scatter(new Vector3(0, 1, 0), 6, new Vector3(1, 2, 0));
    const organs = gore.group.children.find((o) => o.name === 'gore-organs') as InstancedMesh;
    const ground = (): number => 0;
    // Thrown and falling: sent.
    gore.update(1 / 60, ground);
    expect(organs.count).toBeGreaterThan(0);
    expect(organs.frustumCulled).toBe(true);
    // Ten seconds on the ground: at rest.
    for (let f = 0; f < 600; f++) gore.update(1 / 60, ground);
    const version = organs.instanceMatrix.version;
    for (let f = 0; f < 30; f++) gore.update(1 / 60, ground);
    expect(organs.instanceMatrix.version).toBe(version);
    // The sphere holds every piece.
    const at = new Vector3(), sphere = organs.boundingSphere!;
    const mtx = new (organs.matrix.constructor as new () => typeof organs.matrix)();
    for (let i = 0; i < organs.count; i++) { organs.getMatrixAt(i, mtx); at.setFromMatrixPosition(mtx); expect(at.distanceTo(sphere.center)).toBeLessThanOrEqual(sphere.radius); }
    gore.dispose();
  });
});
