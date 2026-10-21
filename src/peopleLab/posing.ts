import { Quaternion, type Bone, type Camera, type Object3D, type Scene } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** POSING AND ANIMATING BY HAND: a bone picked, turned with a rotation gizmo (three's TransformControls), poses kept as keyframes and played back */

/** The bones a hand can turn, by the name shown. */
export const JOINTS: readonly (readonly [string, string])[] = [
  ['Cabeça', 'Bip01_Head'], ['Pescoço', 'Bip01_Neck'], ['Peito', 'Bip01_Spine2'], ['Cintura', 'Bip01_Spine'], ['Quadril', 'Bip01_Pelvis'],
  ['Ombro esq.', 'Bip01_L_UpperArm'], ['Cotovelo esq.', 'Bip01_L_Forearm'], ['Mão esq.', 'Bip01_L_Hand'],
  ['Ombro dir.', 'Bip01_R_UpperArm'], ['Cotovelo dir.', 'Bip01_R_Forearm'], ['Mão dir.', 'Bip01_R_Hand'],
  ['Coxa esq.', 'Bip01_L_Thigh'], ['Joelho esq.', 'Bip01_L_Calf'], ['Pé esq.', 'Bip01_L_Foot'],
  ['Coxa dir.', 'Bip01_R_Thigh'], ['Joelho dir.', 'Bip01_R_Calf'], ['Pé dir.', 'Bip01_R_Foot'],
];

/** A pose: each turned bone's local rotation (x, y, z, w), by name. */
export type Pose = Record<string, [number, number, number, number]>;

/** A keyframe: a pose at a time, seconds. */
export interface Key { readonly t: number; readonly pose: Pose }

export class PoseEditor {
  readonly gizmo: TransformControls;
  /** The hand-set rotations over the clip, by bone name: kept while posing. */
  readonly edits = new Map<string, Quaternion>();
  keys: Key[] = [];
  playing = false;
  private started = 0;
  private root: Object3D | null = null;
  bone: string | null = null;

  constructor(camera: Camera, dom: HTMLElement, scene: Scene, orbit: OrbitControls) {
    this.gizmo = new TransformControls(camera, dom);
    this.gizmo.setMode('rotate');
    this.gizmo.setSpace('local');
    this.gizmo.setSize(0.7);
    this.gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !(e as unknown as { value: boolean }).value; });
    this.gizmo.addEventListener('objectChange', () => {
      const b = this.bone && this.root?.getObjectByName(this.bone);
      if (b) this.edits.set(this.bone!, b.quaternion.clone());
    });
    scene.add(this.gizmo.getHelper());
  }

  /** The person built now: the gizmo moves to it. */
  setRoot(root: Object3D | null): void {
    this.root = root;
    if (this.bone) this.select(this.bone);
  }

  select(name: string | null): void {
    this.bone = name;
    const b = name ? this.root?.getObjectByName(name) as Bone | undefined : undefined;
    if (b) this.gizmo.attach(b); else this.gizmo.detach();
  }

  get active(): boolean { return this.bone !== null || this.playing || this.edits.size > 0; }

  /** After the clip's pose each frame: the hand's edits, or the keyframes playing. */
  apply(now: number): void {
    if (!this.root) return;
    if (this.playing && this.keys.length) {
      const span = this.keys[this.keys.length - 1]!.t || 1;
      const t = (now - this.started) % (span + 0.5);
      const i = Math.max(0, this.keys.findIndex((k) => k.t > t) - 1);
      const a = this.keys[Math.min(i, this.keys.length - 1)]!, b = this.keys[Math.min(i + 1, this.keys.length - 1)]!;
      const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
      // Eased between keys (smoothstep): no robotic starts and stops.
      const e = u * u * (3 - 2 * u);
      for (const name of new Set([...Object.keys(a.pose), ...Object.keys(b.pose)])) {
        const bone = this.root.getObjectByName(name);
        if (!bone) continue;
        const qa = a.pose[name] ? new Quaternion(...a.pose[name]) : bone.quaternion.clone();
        const qb = b.pose[name] ? new Quaternion(...b.pose[name]) : bone.quaternion.clone();
        bone.quaternion.copy(qa.slerp(qb, e));
      }
      return;
    }
    for (const [name, q] of this.edits) {
      const bone = this.root.getObjectByName(name);
      if (bone && !(this.gizmo.dragging && name === this.bone)) bone.quaternion.copy(q);
    }
  }

  addKey(t: number): void {
    const pose: Pose = {};
    for (const [name, q] of this.edits) pose[name] = [q.x, q.y, q.z, q.w];
    this.keys = [...this.keys.filter((k) => Math.abs(k.t - t) > 1e-3), { t, pose }].sort((a, b) => a.t - b.t);
  }

  play(now: number): void { if (this.keys.length > 1) { this.playing = true; this.started = now; this.select(null); } }
  stop(): void { this.playing = false; }
  reset(): void { this.edits.clear(); this.keys = []; this.playing = false; this.select(null); }
}
