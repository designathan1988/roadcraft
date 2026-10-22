import { Matrix4, Vector3, type Bone, type BufferAttribute, type SkinnedMesh } from 'three';
import { smoothSeams } from './polish';

/** RESHAPING THE BUILT PERSON, NOT BUILDING IT AGAIN, as MakeHuman does it (`modifierslider.py`: the target moved while the slider is dragged,
 *  everything refitted on release; `skeleton.py`: each joint the mean of its vertex group). A slider's shape is sampled along its range
 *  (`rig.morph`: the body and everything worn on it, each item by its three-vertex binding), and while it moves the mesh is the samples
 *  blended on the CPU into its own `position` (three.js r186 keeps morph target data fixed once drawn: `BufferGeometry` docs), the bones'
 *  heads blended the same way. When it rests the exact shape is written, the normals worked out again and the skeleton rebound
 *  (`Skeleton.boneInverses` from the new rest pose) - no new geometry, material or shader. */

/** One slider being moved. Its samples are taken with everything else as committed (`context`); a new context samples again. */
export interface ShapeAxis {
  readonly key: string;
  /** Everything else the samples depend on, as a string: samples taken in another context are dropped. */
  readonly context: string;
  /** Its value now, and in the person last committed. */
  readonly value: number;
  readonly base: number;
  readonly range: readonly [number, number];
  /** The body's shape (decimetres) with this slider at `v` and everything else as committed. */
  readonly at: (v: number) => Promise<Float32Array>;
}

interface Sample { readonly v: number; readonly delta: Float32Array; readonly heads: Float32Array }

interface Sampled {
  readonly context: string;
  /** Sorted by value. */
  readonly samples: Sample[];
  /** Values still to sample, nearest the hand first. */
  readonly todo: number[];
}

/** How many samples a slider's range is cut into (evenly, its ends included); MakeHuman's macro sliders bend at their middles, which this includes. */
const STEPS = 6;

export class Reshaper {
  private readonly position: BufferAttribute;
  /** The positions as built (bind posture, metres), and the committed shape's move from them. */
  private readonly origin: Float32Array;
  private current: Float32Array;
  /** Each bone's bind rotation and scale (world, translation zeroed) and its committed head. */
  private readonly axes: Matrix4[];
  private currentHeads: Float32Array;
  private readonly sampled = new Map<string, Sampled>();
  private axesNow: readonly ShapeAxis[] = [];
  private dirty = false;
  private sampling = false;
  private readonly m = new Matrix4();
  private readonly p = new Matrix4();
  private readonly l = new Matrix4();
  private readonly v = new Vector3();

  constructor(private readonly mesh: SkinnedMesh, private readonly morph: (shape: Float32Array) => Float32Array,
    private readonly heads: (shape: Float32Array) => Vector3[]) {
    this.position = mesh.geometry.getAttribute('position') as BufferAttribute;
    this.origin = new Float32Array(this.position.array as Float32Array);
    this.current = new Float32Array(this.origin.length);
    const bones = mesh.skeleton.bones;
    this.axes = bones.map((_, i) => mesh.skeleton.boneInverses[i]!.clone().invert());
    this.currentHeads = new Float32Array(bones.length * 3);
    this.axes.forEach((w, i) => { this.currentHeads.set(w.elements.slice(12, 15), i * 3); w.setPosition(0, 0, 0); });
  }

  /** The person as these sliders now set it, shown at the next `tick` from their samples (sampled first if new). */
  move(axes: readonly ShapeAxis[]): void {
    for (const axis of axes) {
      let s = this.sampled.get(axis.key);
      if (!s || s.context !== axis.context) {
        const [lo, hi] = axis.range;
        const grid = Array.from({ length: STEPS }, (_, k) => lo + ((hi - lo) * k) / (STEPS - 1));
        s = { context: axis.context, samples: [{ v: axis.base, delta: this.current, heads: this.currentHeads }], todo: grid.filter((g) => Math.abs(g - axis.base) > 1e-4) };
        this.sampled.set(axis.key, s);
      }
      // Nearest the hand first.
      s.todo.sort((a, b) => Math.abs(a - axis.value) - Math.abs(b - axis.value));
    }
    for (const key of this.sampled.keys()) if (!axes.some((a) => a.key === key) && !this.axesNow.some((a) => a.key === key)) this.sampled.delete(key);
    this.axesNow = axes;
    this.dirty = true;
    if (!this.sampling) void this.sample();
  }

  /** Samples still missing, one a frame so the page never stalls. */
  private async sample(): Promise<void> {
    this.sampling = true;
    try {
      for (;;) {
        const axis = this.axesNow.find((a) => this.sampled.get(a.key)?.todo.length);
        if (!axis) break;
        const s = this.sampled.get(axis.key)!;
        const v = s.todo.shift()!;
        const shape = await axis.at(v);
        if (this.sampled.get(axis.key) !== s || !this.mesh.parent) continue;
        const heads = new Float32Array(this.currentHeads.length);
        this.heads(shape).forEach((h, i) => h.toArray(heads, i * 3));
        s.samples.push({ v, delta: this.morph(shape), heads });
        s.samples.sort((a, b) => a.v - b.v);
        this.dirty = true;
        await new Promise((r) => requestAnimationFrame(r));
      }
    } finally {
      this.sampling = false;
    }
  }

  /** Each moving slider's two samples round its value and their blend weights; none before a second sample is in. */
  private around(axis: ShapeAxis): [Sample, Sample, number] | null {
    const list = this.sampled.get(axis.key)?.samples;
    if (!list || list.length < 2) return null;
    const v = Math.max(list[0]!.v, Math.min(list[list.length - 1]!.v, axis.value));
    let j = 0;
    while (j < list.length - 2 && list[j + 1]!.v < v) j++;
    const a = list[j]!, b = list[j + 1]!;
    return [a, b, b.v === a.v ? 0 : (v - a.v) / (b.v - a.v)];
  }

  /** Draws the moving sliders' blend when it changed (each frame). */
  tick(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const blends = this.axesNow.map((a) => this.around(a)).filter((b): b is [Sample, Sample, number] => !!b);
    if (!blends.length) return;
    // origin + current + each slider's (its blend - current): the sliders add, each sampled from the committed person.
    const out = this.position.array as Float32Array, o = this.origin, c = this.current;
    for (let i = 0; i < out.length; i++) {
      let x = o[i]! + c[i]!;
      for (const [a, b, t] of blends) x += a.delta[i]! + (b.delta[i]! - a.delta[i]!) * t - c[i]!;
      out[i] = x;
    }
    this.position.needsUpdate = true;
    const h = new Float32Array(this.currentHeads);
    for (let i = 0; i < h.length; i++) for (const [a, b, t] of blends) h[i] = h[i]! + a.heads[i]! + (b.heads[i]! - a.heads[i]!) * t - this.currentHeads[i]!;
    this.rest(h);
  }

  /** The exact shape (decimetres) written, its normals and its skeleton's rest refitted. The moving sliders' samples stay (still the same context). */
  commit(shape: Float32Array): void {
    this.current = this.morph(shape);
    const heads = new Float32Array(this.currentHeads.length);
    this.heads(shape).forEach((h, i) => h.toArray(heads, i * 3));
    this.currentHeads = heads;
    const out = this.position.array as Float32Array;
    for (let i = 0; i < out.length; i++) out[i] = this.origin[i]! + this.current[i]!;
    this.position.needsUpdate = true;
    const g = this.mesh.geometry;
    g.computeVertexNormals();
    smoothSeams(this.mesh);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.mesh.computeBoundingSphere();
    this.rest(heads, true);
    this.dirty = false;
    // The committed values are exact samples now: the next move starts from the shape drawn, no jump.
    for (const axis of this.axesNow) {
      const s = this.sampled.get(axis.key);
      if (!s) continue;
      const kept = s.samples.filter((x) => Math.abs(x.v - axis.value) > 1e-4);
      kept.push({ v: axis.value, delta: this.current, heads });
      kept.sort((a, b) => a.v - b.v);
      s.samples.splice(0, s.samples.length, ...kept);
    }
  }

  /** The skeleton's rest pose with these heads (metres, the scene's frame): each bone's inverse bind matrix and its place on its parent;
   *  with `pose`, every bone also turned back to its rest (what a clip is measured from, `clipTransferFor`), the clip turning it again next frame. */
  private rest(heads: Float32Array, pose = false): void {
    const { bones, boneInverses } = this.mesh.skeleton;
    for (let i = 0; i < bones.length; i++) {
      boneInverses[i]!.copy(this.axes[i]!).setPosition(heads[i * 3]!, heads[i * 3 + 1]!, heads[i * 3 + 2]!).invert();
    }
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i]!;
      const parent = bone.parent as Bone | null;
      const pi = parent && (parent as Bone).isBone ? bones.indexOf(parent) : -1;
      // The parent's bind matrix, inverted: its inverse bind matrix, or the armature's.
      if (pi >= 0) this.p.copy(boneInverses[pi]!);
      else this.p.copy(parent ? parent.matrix : this.m.identity()).invert();
      if (pose) this.l.multiplyMatrices(this.p, this.m.copy(boneInverses[i]!).invert()).decompose(bone.position, bone.quaternion, bone.scale);
      else bone.position.copy(this.v.set(heads[i * 3]!, heads[i * 3 + 1]!, heads[i * 3 + 2]!).applyMatrix4(this.p));
    }
    if (pose) this.mesh.parent?.updateMatrixWorld(true);
  }
}
