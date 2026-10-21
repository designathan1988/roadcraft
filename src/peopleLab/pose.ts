import { Quaternion, Vector3, type Bone, type Object3D, type SkinnedMesh } from 'three';
import { clipTransferFor, type LibraryClip, type LibraryClipName, type NeutralWalk, type RocketboxClips } from '@render/citizenWalk';

/** THE LAB'S POSES: a relaxed standing pose, breathing, and a few gestures, aimed in world space so no bone's own axes have to be known */

export type PoseName = 'idle' | 'wave' | 'cheer' | 'hips';

const v1 = new Vector3(), v2 = new Vector3(), dir = new Vector3();
const q1 = new Quaternion(), q2 = new Quaternion(), delta = new Quaternion();

/** Turns `bone` so the line to `child` points along `target` (world), blended by `amount`. */
function aim(bone: Bone, child: Object3D, target: Vector3, amount = 1): void {
  bone.updateWorldMatrix(true, true);
  const from = child.getWorldPosition(v2).sub(bone.getWorldPosition(v1)).normalize();
  delta.setFromUnitVectors(from, dir.copy(target).normalize());
  if (amount < 1) delta.slerp(q1.identity(), 1 - amount);
  const world = bone.getWorldQuaternion(q1);
  const parent = bone.parent ? bone.parent.getWorldQuaternion(q2) : q2.identity();
  bone.quaternion.copy(parent.invert().multiply(delta.multiply(world)));
  bone.updateWorldMatrix(false, true);
}

/** The rig's bones by the MakeHuman game-engine name, and the capture (Rocketbox) name the citizen rig gives them (`personRig.ts` CAPTURE_NAME). */
const ALIASES: Readonly<Record<string, string>> = {
  pelvis: 'Bip01_Pelvis', spine_03: 'Bip01_Spine2', neck_01: 'Bip01_Neck', head: 'Bip01_Head',
  upperarm_l: 'Bip01_L_UpperArm', lowerarm_l: 'Bip01_L_Forearm', hand_l: 'Bip01_L_Hand',
  upperarm_r: 'Bip01_R_UpperArm', lowerarm_r: 'Bip01_R_Forearm', hand_r: 'Bip01_R_Hand',
};

export class Poser {
  private readonly bones = new Map<string, Bone>();
  private readonly rest = new Map<string, Quaternion>();
  /** The character's left in world space (+1 or -1 along x) */
  private readonly left: number;

  constructor(root: Object3D) {
    root.traverse((o) => { if ((o as Bone).isBone) this.bones.set(o.name, o as Bone); });
    for (const [own, capture] of Object.entries(ALIASES)) {
      const bone = this.bones.get(capture);
      if (bone && !this.bones.has(own)) this.bones.set(own, bone);
    }
    for (const [name, bone] of this.bones) this.rest.set(name, bone.quaternion.clone());
    root.updateWorldMatrix(true, true);
    const l = this.bones.get('upperarm_l'), r = this.bones.get('upperarm_r');
    this.left = l && r ? Math.sign(l.getWorldPosition(v1).x - r.getWorldPosition(v2).x) || 1 : 1;
  }

  get ready(): boolean { return this.bones.has('upperarm_l') && this.bones.has('lowerarm_l'); }

  private b(name: string): Bone | undefined { return this.bones.get(name); }

  private arm(side: 'l' | 'r', upper: Vector3, lower: Vector3): void {
    const up = this.b(`upperarm_${side}`), low = this.b(`lowerarm_${side}`), hand = this.b(`hand_${side}`);
    if (!up || !low || !hand) return;
    aim(up, low, upper);
    aim(low, hand, lower);
  }

  /** The pose at `t` seconds. */
  apply(pose: PoseName, t: number): void {
    for (const [name, q] of this.rest) this.bones.get(name)!.quaternion.copy(q);
    const L = this.left;
    const breath = Math.sin(t * 1.6);
    const sway = Math.sin(t * 0.45);
    // The whole body: a slow shift of weight, the chest rising with each breath, the head looking about.
    const pelvis = this.b('pelvis'), chest = this.b('spine_03'), head = this.b('head'), neck = this.b('neck_01');
    if (pelvis) pelvis.quaternion.multiply(q1.setFromAxisAngle(v1.set(0, 0, 1), sway * 0.025));
    if (chest) chest.quaternion.multiply(q1.setFromAxisAngle(v1.set(1, 0, 0), breath * 0.012));
    if (neck) neck.quaternion.multiply(q1.setFromAxisAngle(v1.set(0, 0, 1), -sway * 0.02));
    if (head) head.quaternion.multiply(q1.setFromAxisAngle(v1.set(0, 1, 0), Math.sin(t * 0.33) * 0.05));
    const hang = (side: number, swing = 0): [Vector3, Vector3] => [
      new Vector3(side * 0.2, -1, 0.04 + swing), new Vector3(side * 0.1, -1, 0.22 + swing)];
    const breathe = breath * 0.01;
    switch (pose) {
      case 'idle':
        this.arm('l', ...hang(L, breathe));
        this.arm('r', ...hang(-L, breathe));
        break;
      case 'wave': {
        this.arm('l', ...hang(L, breathe));
        const w = Math.sin(t * 7);
        this.arm('r', new Vector3(-L * 0.85, 0.35, 0.15), new Vector3(-L * (0.15 + 0.35 * w), 1, 0.12));
        break;
      }
      case 'cheer': {
        const pump = 0.15 * Math.sin(t * 6);
        this.arm('l', new Vector3(L * 0.45, 1, 0.1), new Vector3(L * (0.1 + pump), 1, 0.1));
        this.arm('r', new Vector3(-L * 0.45, 1, 0.1), new Vector3(-L * (0.1 + pump), 1, 0.1));
        break;
      }
      case 'hips':
        this.arm('l', new Vector3(L * 0.75, -0.65, -0.1), new Vector3(-L * 0.85, -0.25, 0.35));
        this.arm('r', new Vector3(-L * 0.75, -0.65, -0.1), new Vector3(L * 0.85, -0.25, 0.35));
        break;
    }
  }
}

/** THE GAME'S OWN CAPTURED MOTIONS (Microsoft Rocketbox, `citizenWalk.ts` library) on the lab's person: the actions play the clips the street plays. */
export class ClipPlayer {
  private transfer: NeutralWalk | null = null;
  private clip: LibraryClip | null = null;
  private started = 0;

  constructor(private readonly root: Object3D, private readonly mesh: SkinnedMesh, private readonly clips: RocketboxClips) {}

  /** Plays `name` from now; false when the library has no such clip. */
  play(name: LibraryClipName | null, now: number): boolean {
    const clip = name ? this.clips[name] : undefined;
    if (!clip) { this.transfer = null; this.clip = null; return false; }
    if (clip === this.clip) return true;
    this.clip = clip;
    this.transfer = clipTransferFor(this.root, this.mesh, clip);
    this.started = now;
    return true;
  }

  get playing(): boolean { return !!this.transfer; }

  /** The pose at `now` (seconds); a clip that does not loop holds its last frame. */
  apply(now: number): void {
    if (!this.transfer || !this.clip) return;
    const t = now - this.started;
    this.transfer.pose(this.clip.loop ? t % this.clip.duration : Math.min(t, this.clip.duration - 1e-3));
  }
}
