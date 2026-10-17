import { describe, expect, it } from 'vitest';
import { Matrix4, Scene, type Object3D } from 'three';
import { createDensityCars } from '@render/densityCars';
import { createTrackPreview, createTransit } from '@render/transit';

/** R14: what never moves as an object and is not in the renderer's still tree (trains, far cars: their instances or the shader move) is never composed nor multiplied by three's frame */

const pinnedTree = (root: Object3D): Object3D[] => {
  const loose: Object3D[] = [];
  root.traverse((o) => { if (o.matrixAutoUpdate || o.matrixWorldAutoUpdate) loose.push(o); });
  return loose;
};
const IDENTITY = new Matrix4();

describe('objects moved only by their instances', () => {
  it('ask nothing of three each frame, and stand at the origin', () => {
    const far = createDensityCars(() => 0);
    const transit = createTransit();
    const preview = createTrackPreview();
    const scene = new Scene();
    const roots: Object3D[] = [far.object, preview.group];
    for (const root of roots) {
      expect(pinnedTree(root).map((o) => o.name || o.type), root.name).toEqual([]);
      scene.add(root);
    }
    const trains = transit.group.getObjectByName('transit-trains')!;
    expect([transit.group.matrixAutoUpdate, trains.matrixAutoUpdate, trains.matrixWorldAutoUpdate]).toEqual([false, false, false]);
    scene.updateMatrixWorld();
    for (const root of roots) root.traverse((o) => expect(o.matrixWorld.equals(IDENTITY)).toBe(true));
    far.dispose();
  });
});
