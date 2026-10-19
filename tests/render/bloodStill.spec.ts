import { InstancedMesh, Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';
import { type BloodDecal, createCasualties } from '@render/casualties';

/** AGT-15: the blood stains are laid out again only when one is added or taken, or while a pool still spreads. */
describe('blood stains lying still', () => {
  it('are sent while a pool spreads and when one comes, never again while nothing changes, each where it was', () => {
    const layer = createCasualties();
    const meshes = layer.group.children as InstancedMesh[];
    const versions = (): number[] => meshes.map((s) => s.instanceMatrix.version);
    const list: BloodDecal[] = [
      { x: 1, y: 2, z: 0, angle: 0.3, size: 0.6, spread: 2, age: 0 },
      { x: 4, y: 5, z: 0, angle: 1.1, size: 0.3, spread: 0, age: 0 },
    ];
    layer.sync(list);
    let was = versions();
    // The pool spreading: sent each frame.
    list[0]!.age = 1;
    layer.sync(list);
    expect(versions()).not.toEqual(was);
    // Spread out: sent once more, then never while nothing changes.
    list[0]!.age = 5;
    layer.sync(list);
    was = versions();
    const at = new Matrix4();
    meshes[0]!.getMatrixAt(0, at);
    const before = at.toArray();
    for (let f = 0; f < 10; f++) { for (const d of list) d.age += 1 / 60; layer.sync(list); }
    expect(versions()).toEqual(was);
    meshes[0]!.getMatrixAt(0, at);
    expect(at.toArray()).toEqual(before);
    // One more stain: sent.
    list.push({ x: 7, y: 8, z: 0, angle: 2, size: 0.8, spread: 0, age: 0 });
    layer.sync(list);
    expect(versions()).not.toEqual(was);
    expect(meshes.reduce((n, s) => n + s.count, 0)).toBe(3);
  });
});
