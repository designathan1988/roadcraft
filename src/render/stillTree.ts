import { Object3D, type Object3DEventMap, type Scene } from 'three';

/** Still trees under the scene: the frame walks them never (`updateMoving`), their world matrices made where something enters or is moved. */
const stillRoots = new WeakSet<Object3D>();

/** One object's matrix composed and its world matrices (its own and its children's) made at once, from its parent's. */
function movedInStill(this: Object3D): void {
  Object3D.prototype.updateMatrix.call(this);
  this.updateMatrixWorld(true);
}

/** DO NOT move an object inside a still tree */
export function holdStill(root: Object3D): void {
  const onAdded = (event: Object3DEventMap['childadded'] & { target: Object3D }): void => {
    settle(event.child);
    // What came in is placed now, from its parent's world matrix: the tree's are always up to date.
    event.child.updateMatrixWorld(true);
  };
  const settle = (object: Object3D): void => {
    if (object.matrixAutoUpdate) {
      Object3D.prototype.updateMatrix.call(object);
      object.matrixAutoUpdate = false;
    }
    // An `updateMatrix` later (a still object put elsewhere) places it and its children at once.
    if (object.updateMatrix !== movedInStill) object.updateMatrix = movedInStill;
    if (!object.hasEventListener('childadded', onAdded)) object.addEventListener('childadded', onAdded);
    for (const child of object.children) settle(child);
  };
  settle(root);
  stillRoots.add(root);
  root.updateMatrixWorld(true);
}

/** The scene's world matrices for a frame (the scene's `matrixWorldAutoUpdate` is off): every child that is not a still tree, as three's own update did, once a frame and not once per pass drawn. */
export function updateMoving(scene: Scene): void {
  const children = scene.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (!stillRoots.has(child)) child.updateMatrixWorld();
  }
}
