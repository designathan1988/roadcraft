import { describe, expect, it } from 'vitest';
import { Group, Object3D, Scene, Vector3 } from 'three';
import { holdStill, updateMoving } from '@render/stillTree';

const at = (o: Object3D): Vector3 => new Vector3().setFromMatrixPosition(o.matrixWorld);

describe('still trees', () => {
  it('places what enters a still tree at once, from its parent', () => {
    const scene = new Scene();
    scene.matrixWorldAutoUpdate = false;
    const still = new Group();
    holdStill(still);
    scene.add(still);
    const holder = new Group();
    holder.position.set(10, 0, 0);
    const leaf = new Object3D();
    leaf.position.set(0, 5, 0);
    holder.add(leaf);
    still.add(holder);
    expect(at(leaf).toArray()).toEqual([10, 5, 0]);
    expect(leaf.matrixAutoUpdate).toBe(false);
  });

  it('places a still object moved by updateMatrix, children included', () => {
    const still = new Group();
    const holder = new Group();
    const leaf = new Object3D();
    leaf.position.set(1, 0, 0);
    holder.add(leaf);
    still.add(holder);
    holdStill(still);
    holder.position.set(0, 0, 3);
    holder.updateMatrix();
    expect(at(leaf).toArray()).toEqual([1, 0, 3]);
  });

  it('updates the moving children of the scene and leaves the still trees unwalked', () => {
    const scene = new Scene();
    scene.matrixWorldAutoUpdate = false;
    const still = new Group();
    holdStill(still);
    scene.add(still);
    const mover = new Object3D();
    scene.add(mover);
    mover.position.set(2, 0, 0);
    let walked = false;
    still.updateMatrixWorld = () => { walked = true; };
    updateMoving(scene);
    expect(at(mover).toArray()).toEqual([2, 0, 0]);
    expect(walked).toBe(false);
  });
});
