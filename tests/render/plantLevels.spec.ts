import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera, type InstancedMesh } from 'three';
import { drawnMatrices } from '@render/cellInstances';
import { createGardens, type GardenPlant } from '@render/gardens';
import { PICTURE_PX, THIN_PX, impostorPick, sceneryPictures, thinWant } from '@render/plantImpostors';
import { createSceneryKit } from '@render/scenery';
import { m } from '@world/units';

/** THE NEAR PLANTS' LEVELS BY THEIR SIZE ON THE SCREEN (`cellInstances.ts`, `plantImpostors.ts`) */

/** A row of trees running away from the eye, one every 4 m. */
function row(count: number): GardenPlant[][] {
  return Array.from({ length: count }, (_, i) => [{ kind: 'tree', x: 0, y: m(10) + i * m(4), z: 0, w: m(3), d: m(3), h: m(8), yaw: 0, seed: (i * 0.618) % 1, species: 'broadleaf' }]);
}

function look(fov = 40): { frustum: Frustum; view: Matrix4 } {
  const camera = new PerspectiveCamera(fov, 16 / 9, 0.5, m(20000));
  camera.position.set(0, m(6), 0);
  camera.lookAt(0, m(3), -m(100));
  camera.updateMatrixWorld();
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return { frustum: new Frustum().setFromProjectionMatrix(view), view };
}

const counts = (meshes: readonly InstancedMesh[]): Record<string, number> => Object.fromEntries(meshes.map((mesh) => [mesh.name, mesh.count]));

describe('the near plants by their size on the screen', () => {
  const kit = createSceneryKit();

  it('draws every tree whole until the pictures are taken', () => {
    const gardens = createGardens(kit);
    gardens.update({ added: row(3000), removed: [] });
    const { frustum, view } = look();
    gardens.cull(frustum, view);
    const drawn = counts(gardens.meshes as InstancedMesh[]);
    expect(drawn['garden-trees-broadleaf']).toBeGreaterThan(0);
    expect(drawn['garden-trees-broadleaf-far']).toBe(0);
    gardens.dispose();
  });

  it('draws a near tree whole, a far one as its picture, never both', () => {
    // As if taken (`takeWaitingPictures`): no renderer here.
    const pictures = sceneryPictures(kit);
    (pictures.set as { ready: () => boolean }).ready = () => true;
    const gardens = createGardens(kit);
    gardens.update({ added: row(3000), removed: [] });
    const { frustum, view } = look();
    gardens.cull(frustum, view);
    const drawn = counts(gardens.meshes as InstancedMesh[]);
    expect(drawn['garden-trees-broadleaf']).toBeGreaterThan(0);
    expect(drawn['garden-trees-broadleaf-far']).toBeGreaterThan(0);
    expect(drawn['garden-trees-broadleaf-cards']).toBe(drawn['garden-trees-broadleaf']);
    // Each tree at one level: the near ones' and the far ones' translations never meet.
    const feet = (mesh: InstancedMesh): Set<string> => { const at = drawnMatrices(mesh); return new Set(Array.from({ length: mesh.count }, (_, i) => `${at[i * 16 + 12]},${at[i * 16 + 14]}`)); };
    const meshes = gardens.meshes as InstancedMesh[];
    const near = feet(meshes.find((x) => x.name === 'garden-trees-broadleaf')!), far = feet(meshes.find((x) => x.name === 'garden-trees-broadleaf-far')!);
    for (const foot of near) expect(far.has(foot)).toBe(false);
    expect(PICTURE_PX).toBeGreaterThan(THIN_PX);
    gardens.dispose();
    pictures.release();
  });

  it('thins the pictures under a couple of pixels by their pick, keeping the cover', () => {
    for (const across of [0.2, 0.7, 1.4, 2, 5]) {
      const want = thinWant(across);
      let kept = 0;
      const n = 20_000;
      for (let i = 0; i < n; i++) if (impostorPick(i * 0.37, 1.5, -i * 0.91) < want) kept++;
      // The share kept, grown to THIN_PX: the cover (kept times area) is the plants' own, with the margin's shrinking ones.
      const keep = Math.min(1, (across / THIN_PX) ** 2);
      expect(kept / n).toBeGreaterThan(keep * 0.95);
      expect(kept / n).toBeLessThan(Math.min(1, keep * 1.15) + 0.02);
    }
  });
});
