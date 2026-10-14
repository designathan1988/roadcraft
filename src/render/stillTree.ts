import type { Object3D, Object3DEventMap } from 'three';

/**
 * A SUBTREE THAT NEVER MOVES: the world's roads, plants, poles, furniture,
 * barriers, forests - meshes and groups placed once, their instances' matrices
 * written into instance buffers, never their own transforms changed after.
 *
 * three recomposes the local matrix of every object left `matrixAutoUpdate`
 * (the default) on every render of the scene, and a parent that recomposes
 * forces all its children to recompute their world matrices
 * (`Object3D.updateMatrixWorld`, r186): the world group alone made every
 * static child of the map do it on every pass of every frame. The manual's
 * rule (manual/pages/matrix-transformations.html): "If the object is static
 * ... better performance can be obtained by setting the property false", and
 * update the matrix by hand after a change.
 *
 * Every object in the tree, and every object added to it later at any depth
 * (`childadded`), gets its matrix composed once and `matrixAutoUpdate` off; an
 * object already holding a matrix set by hand (`matrixAutoUpdate` false) keeps
 * it (the manual: calling `updateMatrix` would clobber it).
 * DO NOT move an object inside a still tree: change its transform and call
 * `updateMatrix()` yourself, or put a moving thing elsewhere in the scene.
 */
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
