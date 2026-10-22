import { BufferAttribute, type SkinnedMesh } from 'three';

/** LIVE SHAPING: a change of the body's shape seen on the next frame, without rebuilding the person - as three.js draws morph targets on a
 *  skinned mesh (webgl_animation_skinning_morph: the morph runs before the skinning). The new shape becomes one relative morph target, "live",
 *  of the dressed mesh (`PersonRig.morph` moves the body and everything worn on it, each vertex from the piece it belongs to), at full weight;
 *  the full rebuild (bones, fitting) follows when the slider rests. */

const LIVE = 'live';

export class LiveShape {
  private pending: (() => Promise<Float32Array | null>) | null = null;
  private running = false;

  /** Shows `shapeOf()` on `mesh` (through `morph`), the latest call winning while one is still being worked out. */
  show(mesh: SkinnedMesh, morph: (positions: Float32Array) => Float32Array, shapeOf: () => Promise<Float32Array | null>): void {
    this.pending = shapeOf;
    if (this.running) return;
    void this.drain(mesh, morph);
  }

  private async drain(mesh: SkinnedMesh, morph: (positions: Float32Array) => Float32Array): Promise<void> {
    this.running = true;
    while (this.pending) {
      const next = this.pending;
      this.pending = null;
      const shape = await next();
      if (!shape || !mesh.parent) continue;
      const geometry = mesh.geometry;
      const delta = morph(shape);
      const list = [...(geometry.morphAttributes.position ?? [])];
      let index = list.findIndex((a) => a.name === LIVE);
      if (index >= 0 && list[index]!.count * 3 === delta.length) {
        // The same target refilled: three uploads its morph texture again (morphTargetsRelative stays as it was).
        (list[index]!.array as Float32Array).set(delta);
        list[index]!.needsUpdate = true;
        geometry.morphAttributes.position = list;
      } else {
        const attribute = new BufferAttribute(delta, 3);
        attribute.name = LIVE;
        if (index < 0) { list.push(attribute); index = list.length - 1; } else list[index] = attribute;
        geometry.morphAttributes.position = list;
        geometry.morphTargetsRelative = true;
        mesh.updateMorphTargets();
      }
      // three caches the morph texture per geometry: a changed target is only re-read after the geometry is told so.
      geometry.dispatchEvent({ type: 'dispose' });
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = 1;
    }
    this.running = false;
  }
}
