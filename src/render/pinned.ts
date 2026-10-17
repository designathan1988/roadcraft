import type { Object3D } from 'three';

/** An object that never moves as an object (its instances move, or the shader places it), at the origin under parents at the origin: its matrices are the identity for good */
/** DO NOT leave three to compose and multiply its matrices every frame (`Object3D.updateMatrixWorld`: `compose` and `multiplyMatrices` at the top of the movement's profile). */
export function pinned<T extends Object3D>(object: T): T {
  object.matrixAutoUpdate = false;
  object.matrixWorldAutoUpdate = false;
  return object;
}
