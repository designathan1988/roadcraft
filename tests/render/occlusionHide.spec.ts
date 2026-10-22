import { BoxGeometry, MeshBasicMaterial, PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';

import { GpuBatchedMesh } from '@render/buildings/gpuBatchedMesh';

/** Two boxes ahead of the eye in one batch; the draws three lists for a camera (`_multiDrawCount`). */
function batchOfTwo(): GpuBatchedMesh {
  const material = new MeshBasicMaterial();
  const batch = new GpuBatchedMesh(4, 64, 128, material);
  const geometry = new BoxGeometry(1, 1, 1);
  const id = batch.addGeometry(geometry);
  batch.addInstance(id);
  batch.addInstance(id);
  batch.updateMatrixWorld();
  return batch;
}

const eye = (): PerspectiveCamera => {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.updateMatrixWorld();
  return camera;
};

const listed = (batch: GpuBatchedMesh, camera: PerspectiveCamera): number => {
  batch.onBeforeRender(null as unknown as WebGLRenderer, new Scene(), camera, batch.geometry, batch.material as MeshBasicMaterial, null);
  return (batch as unknown as { _multiDrawCount: number })._multiDrawCount;
};

describe('a batch\'s instances hidden from one camera alone (the occlusion\'s colour pass)', () => {
  it('leaves the hidden instances out of that camera\'s draws only, and shows them again after', () => {
    const batch = batchOfTwo();
    const main = eye(), sun = eye();
    expect(listed(batch, main)).toBe(2);
    batch.colourHidden = { camera: main, ids: [1] };
    expect(listed(batch, main)).toBe(1);
    // Another camera (a shadow cascade, three's onBeforeShadow lists through onBeforeRender): every instance drawn.
    expect(listed(batch, sun)).toBe(2);
    expect(batch.getVisibleAt(1)).toBe(true);
    batch.colourHidden = null;
    expect(listed(batch, main)).toBe(2);
  });
});
