import type { Object3D, Object3DEventMap } from 'three';

/** DO NOT move an object inside a still tree */
export function holdStill(root: Object3D): void {
  const onAdded = (event: Object3DEventMap['childadded'] & { target: Object3D }): void => settle(event.child);
  const settle = (object: Object3D): void => {
    if (object.matrixAutoUpdate) {
      object.updateMatrix();
      object.matrixAutoUpdate = false;
    }
    // Its world matrix once, at the next update, from the parent's.
    object.matrixWorldNeedsUpdate = true;
    if (!object.hasEventListener('childadded', onAdded)) object.addEventListener('childadded', onAdded);
    for (const child of object.children) settle(child);
  };
  settle(root);
}
