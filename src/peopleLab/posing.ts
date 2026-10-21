import {
  BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, Quaternion, Raycaster, SphereGeometry, Vector3,
  type Bone, type Camera, type Object3D, type Scene, type Vector2,
} from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** RIGGING AND ANIMATION, as Blender's pose mode and Maya's animation tools: the skeleton drawn over the body, a bone clicked to select it,
 *  turned (FK) or moved (the rig reshaped) with a gizmo, hands and feet placed by IK targets (cyclic coordinate descent, Wang & Chen 1991 -
 *  three's CCDIKSolver), and a timeline of keys holding the body's pose and the face's expression, interpolated (slerp, eased) on playback. */

/** The bones shown and their names. */
export const JOINTS: readonly (readonly [string, string])[] = [
  ['Cabeça', 'Bip01_Head'], ['Pescoço', 'Bip01_Neck'], ['Peito', 'Bip01_Spine2'], ['Tronco', 'Bip01_Spine1'], ['Cintura', 'Bip01_Spine'], ['Quadril', 'Bip01_Pelvis'],
  ['Clavícula esq.', 'Bip01_L_Clavicle'], ['Ombro esq.', 'Bip01_L_UpperArm'], ['Cotovelo esq.', 'Bip01_L_Forearm'], ['Mão esq.', 'Bip01_L_Hand'],
  ['Clavícula dir.', 'Bip01_R_Clavicle'], ['Ombro dir.', 'Bip01_R_UpperArm'], ['Cotovelo dir.', 'Bip01_R_Forearm'], ['Mão dir.', 'Bip01_R_Hand'],
  ['Coxa esq.', 'Bip01_L_Thigh'], ['Joelho esq.', 'Bip01_L_Calf'], ['Pé esq.', 'Bip01_L_Foot'],
  ['Coxa dir.', 'Bip01_R_Thigh'], ['Joelho dir.', 'Bip01_R_Calf'], ['Pé dir.', 'Bip01_R_Foot'],
];

/** IK chains: the target's name, the effector, and the links from the effector up (each turned to reach). */
const CHAINS: readonly (readonly [string, string, readonly string[]])[] = [
  ['Mão esq. (IK)', 'Bip01_L_Hand', ['Bip01_L_Forearm', 'Bip01_L_UpperArm']],
  ['Mão dir. (IK)', 'Bip01_R_Hand', ['Bip01_R_Forearm', 'Bip01_R_UpperArm']],
  ['Pé esq. (IK)', 'Bip01_L_Foot', ['Bip01_L_Calf', 'Bip01_L_Thigh']],
  ['Pé dir. (IK)', 'Bip01_R_Foot', ['Bip01_R_Calf', 'Bip01_R_Thigh']],
];

/** The face's channels a key can hold (`faceExpression.ts` CHANNELS), with their names. */
export const FACE_CHANNELS: readonly (readonly [string, string])[] = [
  ['faceJoy', 'Alegria'], ['faceSadness', 'Tristeza'], ['faceAnger', 'Raiva'], ['faceSurprise', 'Surpresa'], ['faceBrowRaise', 'Sobrancelhas'],
  ['faceBlink', 'Olhos fechados'], ['mouthOpen', 'Boca aberta'], ['mouthRound', 'Boca em O'], ['mouthSpread', 'Boca esticada'], ['mouthPuckered', 'Bico'],
];

/** A pose: each turned bone's local rotation (x, y, z, w), by name. */
export type Pose = Record<string, [number, number, number, number]>;
/** A face: channel weights. */
export type Face = Record<string, number>;

/** A keyframe: a pose and a face at a time, seconds. */
export interface Key { readonly t: number; readonly pose: Pose; readonly face?: Face }

/** What a person keeps of the posing (`LabPerson.motion`): the joints moved (the rig), the pose held, the face set, the animation's keys. */
export interface Motion {
  readonly rig?: Readonly<Record<string, [number, number, number]>>;
  readonly pose?: Pose;
  readonly face?: Face;
  readonly keys?: readonly Key[];
}

const ease = (u: number): number => u * u * (3 - 2 * u);

export class PoseEditor {
  readonly gizmo: TransformControls;
  readonly edits = new Map<string, Quaternion>();
  readonly offsets = new Map<string, Vector3>();
  /** The face as set by hand (channel weights); empty: the face lives on its own. */
  face: Face = {};
  keys: Key[] = [];
  playing = false;
  /** The time the timeline shows, s. */
  time = 0;
  duration = 3;
  loop = true;
  bone: string | null = null;
  /** The IK target selected, by chain index, or -1. */
  ikTarget = -1;
  onChange: () => void = () => {};
  /** The bones drawn and their pick spheres, shown in the pose tab. */
  readonly helpers = new Group();
  private readonly lines: LineSegments;
  private readonly spheres: Mesh[] = [];
  private readonly targets: Mesh[] = [];
  private readonly ikOn = new Set<number>();
  private started = 0;
  private root: Object3D | null = null;
  private readonly rest = new Map<string, Vector3>();
  private readonly raycaster = new Raycaster();

  constructor(camera: Camera, dom: HTMLElement, scene: Scene, orbit: OrbitControls) {
    this.gizmo = new TransformControls(camera, dom);
    this.gizmo.setMode('rotate');
    this.gizmo.setSpace('local');
    this.gizmo.setSize(0.75);
    this.gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !(e as unknown as { value: boolean }).value; });
    this.gizmo.addEventListener('objectChange', () => {
      if (this.ikTarget >= 0) return;
      const b = this.bone && this.root?.getObjectByName(this.bone);
      if (!b) return;
      if (this.gizmo.mode === 'translate') {
        const rest = this.rest.get(this.bone!);
        if (rest) this.offsets.set(this.bone!, b.position.clone().sub(rest));
      } else this.edits.set(this.bone!, b.quaternion.clone());
    });
    this.gizmo.addEventListener('mouseUp', () => { if (this.ikTarget >= 0) this.bakeIk(); this.onChange(); });
    scene.add(this.gizmo.getHelper());
    this.lines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x8fb6ff, depthTest: false, transparent: true, opacity: 0.85 }));
    this.lines.renderOrder = 20;
    this.helpers.add(this.lines);
    this.helpers.visible = false;
    scene.add(this.helpers);
    const sphere = new SphereGeometry(0.018, 12, 8);
    for (const [, name] of JOINTS) {
      const m = new Mesh(sphere, new MeshBasicMaterial({ color: 0xd5e3ff, depthTest: false, transparent: true, opacity: 0.9 }));
      m.renderOrder = 21; m.userData['bone'] = name;
      this.spheres.push(m); this.helpers.add(m);
    }
    const handle = new SphereGeometry(0.03, 16, 10);
    CHAINS.forEach((_, i) => {
      const m = new Mesh(handle, new MeshBasicMaterial({ color: 0xffb547, depthTest: false, transparent: true, opacity: 0.85 }));
      m.renderOrder = 22; m.userData['ik'] = i; m.visible = false;
      this.targets.push(m); scene.add(m);
    });
  }

  setRoot(root: Object3D | null): void {
    this.root = root;
    this.rest.clear();
    root?.traverse((o) => { if ((o as Bone).isBone) this.rest.set(o.name, o.position.clone()); });
    if (this.bone) this.select(this.bone);
  }

  show(on: boolean): void {
    this.helpers.visible = on;
    for (const [i, t] of this.targets.entries()) t.visible = on && this.ikOn.has(i);
    if (!on) this.select(null);
  }

  setMode(mode: 'rotate' | 'translate'): void { this.gizmo.setMode(mode); }
  get mode(): 'rotate' | 'translate' { return this.gizmo.mode === 'translate' ? 'translate' : 'rotate'; }

  select(name: string | null): void {
    this.bone = name;
    this.ikTarget = -1;
    const b = name ? this.root?.getObjectByName(name) as Bone | undefined : undefined;
    if (b) { this.gizmo.setMode(this.gizmo.mode === 'translate' ? 'translate' : 'rotate'); this.gizmo.attach(b); } else this.gizmo.detach();
  }

  /** An IK chain on or off; on, its target stands at the effector and the gizmo moves it. */
  toggleIk(i: number): void {
    if (this.ikOn.has(i)) { this.ikOn.delete(i); this.targets[i]!.visible = false; if (this.ikTarget === i) this.select(null); return; }
    const eff = this.root?.getObjectByName(CHAINS[i]![1]);
    if (!eff) return;
    eff.getWorldPosition(this.targets[i]!.position);
    this.ikOn.add(i);
    this.targets[i]!.visible = this.helpers.visible;
    this.selectIk(i);
  }

  private selectIk(i: number): void {
    this.bone = null; this.ikTarget = i;
    this.gizmo.setMode('translate');
    this.gizmo.attach(this.targets[i]!);
  }

  get chains(): readonly string[] { return CHAINS.map((c) => c[0]); }
  ikActive(i: number): boolean { return this.ikOn.has(i); }

  /** The bone (or IK target) under the pointer, selected; false when none. */
  pick(ndc: Vector2, camera: Camera): boolean {
    if (!this.helpers.visible) return false;
    this.raycaster.setFromCamera(ndc, camera);
    const visibleTargets = this.targets.filter((t) => t.visible);
    const hit = this.raycaster.intersectObjects([...visibleTargets, ...this.spheres], false)[0];
    if (!hit) return false;
    if (hit.object.userData['ik'] !== undefined) this.selectIk(hit.object.userData['ik'] as number);
    else this.select(hit.object.userData['bone'] as string);
    return true;
  }

  /** CCD IK: each link from the effector up turned so the effector points at the target, a few rounds. */
  private solveIk(): void {
    if (!this.root) return;
    const e = new Vector3(), t = new Vector3(), j = new Vector3(), q = new Quaternion(), wq = new Quaternion(), pq = new Quaternion();
    for (const i of this.ikOn) {
      const [, effName, links] = CHAINS[i]!;
      const eff = this.root.getObjectByName(effName);
      if (!eff) continue;
      t.copy(this.targets[i]!.position);
      for (let round = 0; round < 8; round++) {
        for (const name of links) {
          const link = this.root.getObjectByName(name);
          if (!link) continue;
          link.updateWorldMatrix(true, true);
          link.getWorldPosition(j);
          eff.getWorldPosition(e);
          const from = e.clone().sub(j).normalize(), to = t.clone().sub(j).normalize();
          if (from.dot(to) > 0.99999) continue;
          q.setFromUnitVectors(from, to);
          link.getWorldQuaternion(wq);
          if (link.parent) link.parent.getWorldQuaternion(pq); else pq.identity();
          link.quaternion.copy(pq.invert().multiply(q.multiply(wq)));
        }
      }
    }
  }

  /** The chain's solved rotations kept as edits (FK), so a key holds them. */
  private bakeIk(): void {
    if (!this.root) return;
    for (const i of this.ikOn) for (const name of CHAINS[i]![2]) {
      const b = this.root.getObjectByName(name);
      if (b) this.edits.set(name, b.quaternion.clone());
    }
  }

  /** After the clip's pose each frame: the rig as reshaped, the animation or the hand's pose, IK; the drawn skeleton follows. */
  apply(now: number): void {
    if (!this.root) return;
    for (const [name, off] of this.offsets) {
      const bone = this.root.getObjectByName(name), rest = this.rest.get(name);
      if (bone && rest && !(this.gizmo.dragging && name === this.bone && this.mode === 'translate')) bone.position.copy(rest).add(off);
    }
    if (this.playing && this.keys.length) {
      const span = Math.max(this.duration, this.keys[this.keys.length - 1]!.t);
      const t = now - this.started;
      this.time = this.loop ? t % span : Math.min(t, span);
      this.poseAt(this.time);
    } else {
      for (const [name, q] of this.edits) {
        const bone = this.root.getObjectByName(name);
        if (bone && !(this.gizmo.dragging && name === this.bone)) bone.quaternion.copy(q);
      }
      if (this.ikOn.size) this.solveIk();
    }
    if (this.helpers.visible) this.drawSkeleton();
  }

  /** The keys' pose (and face) at `t`, set on the rig. */
  private poseAt(t: number): void {
    if (!this.root || !this.keys.length) return;
    const ks = this.keys;
    let i = ks.findIndex((k) => k.t > t) - 1;
    if (i < 0) i = ks[0]!.t > t ? 0 : ks.length - 1;
    const a = ks[i]!, b = ks[Math.min(i + 1, ks.length - 1)]!;
    const u = b.t > a.t ? ease(Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)))) : 0;
    for (const name of new Set([...Object.keys(a.pose), ...Object.keys(b.pose)])) {
      const bone = this.root.getObjectByName(name);
      if (!bone) continue;
      const qa = a.pose[name] ? new Quaternion(...a.pose[name]) : bone.quaternion.clone();
      const qb = b.pose[name] ? new Quaternion(...b.pose[name]) : bone.quaternion.clone();
      bone.quaternion.copy(qa.slerp(qb, u));
    }
    const face: Face = {};
    for (const [ch] of FACE_CHANNELS) {
      const v = (a.face?.[ch] ?? 0) * (1 - u) + (b.face?.[ch] ?? 0) * u;
      if (v > 0.001) face[ch] = v;
    }
    this.face = face;
  }

  /** The face the person shows: the animation's or the hand's, or null to let the face live on its own. */
  faceNow(): Face | null { return Object.keys(this.face).length || this.playing ? this.face : null; }

  setFace(channel: string, v: number): void {
    if (v <= 0.001) delete this.face[channel]; else this.face[channel] = v;
    this.onChange();
  }

  private drawSkeleton(): void {
    if (!this.root) return;
    const pts: number[] = [];
    const p = new Vector3(), c = new Vector3();
    this.root.traverse((o) => {
      if (!(o as Bone).isBone || !o.parent || !(o.parent as Bone).isBone) return;
      if (/Finger|Toe|Nub|Bip01$/.test(o.name)) return;
      o.parent.getWorldPosition(p); o.getWorldPosition(c);
      pts.push(p.x, p.y, p.z, c.x, c.y, c.z);
    });
    const g = this.lines.geometry;
    g.setAttribute('position', new BufferAttribute(Float32Array.from(pts), 3));
    g.computeBoundingSphere();
    for (const s of this.spheres) {
      const b = this.root.getObjectByName(s.userData['bone'] as string);
      if (b) b.getWorldPosition(s.position);
      (s.material as MeshBasicMaterial).color.setHex(s.userData['bone'] === this.bone ? 0x4f8cff : 0xd5e3ff);
      s.scale.setScalar(s.userData['bone'] === this.bone ? 1.5 : 1);
    }
  }

  // ------------------------------------------------------------ the timeline

  /** A key at the time shown: every bone posed now, and the face. */
  addKey(t = this.time): void {
    this.bakeIk();
    const pose: Pose = {};
    for (const [n, q] of this.edits) pose[n] = [q.x, q.y, q.z, q.w];
    // Every shown bone, so a key fixes the whole pose (not only those touched since the last key).
    if (this.root) for (const [, name] of JOINTS) {
      const b = this.root.getObjectByName(name);
      if (b && !pose[name]) pose[name] = [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w];
    }
    this.keys = [...this.keys.filter((k) => Math.abs(k.t - t) > 1e-3), { t, pose, face: { ...this.face } }].sort((a, b) => a.t - b.t);
    this.duration = Math.max(this.duration, t);
    this.onChange();
  }

  deleteKey(t: number): void { this.keys = this.keys.filter((k) => Math.abs(k.t - t) > 1e-3); this.onChange(); }

  /** The timeline moved to `t`: the pose and face there shown (and held for editing). */
  scrub(t: number): void {
    this.playing = false;
    this.time = t;
    if (!this.keys.length || !this.root) return;
    this.poseAt(t);
    this.edits.clear();
    for (const [, name] of JOINTS) {
      const b = this.root.getObjectByName(name);
      if (b) this.edits.set(name, b.quaternion.clone());
    }
  }

  play(now: number): void { if (this.keys.length > 1) { this.playing = true; this.started = now - this.time; this.select(null); } }
  stop(): void { this.playing = false; }
  reset(): void { this.edits.clear(); this.offsets.clear(); this.keys = []; this.face = {}; this.playing = false; this.time = 0; this.select(null); this.onChange(); }

  motion(): Motion {
    const rig: Record<string, [number, number, number]> = {};
    for (const [n, o] of this.offsets) if (o.lengthSq() > 1e-8) rig[n] = [o.x, o.y, o.z];
    const pose: Pose = {};
    for (const [n, q] of this.edits) pose[n] = [q.x, q.y, q.z, q.w];
    return { ...(Object.keys(rig).length ? { rig } : {}), ...(Object.keys(pose).length ? { pose } : {}),
      ...(Object.keys(this.face).length ? { face: this.face } : {}), ...(this.keys.length ? { keys: this.keys } : {}) };
  }

  load(m: Motion | undefined): void {
    this.edits.clear(); this.offsets.clear();
    for (const [n, v] of Object.entries(m?.rig ?? {})) this.offsets.set(n, new Vector3(...v));
    for (const [n, q] of Object.entries(m?.pose ?? {})) this.edits.set(n, new Quaternion(...q));
    this.face = { ...(m?.face ?? {}) };
    this.keys = [...(m?.keys ?? [])];
    this.duration = Math.max(3, ...this.keys.map((k) => k.t));
  }

  setPose(pose: Pose): void {
    this.edits.clear();
    for (const [n, q] of Object.entries(pose)) this.edits.set(n, new Quaternion(...q));
    this.onChange();
  }

  get active(): boolean { return this.bone !== null || this.playing || this.edits.size > 0 || this.ikOn.size > 0; }
}
