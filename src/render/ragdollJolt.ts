import type JoltModule from 'jolt-physics/wasm-compat';
import { Matrix4, Quaternion, Vector3 } from 'three';

/**
 * The bodies on the ground simulated by Jolt Physics (JoltPhysics.js, the
 * WebAssembly build of the engine Horizon Forbidden West shipped with): a
 * ragdoll is a dozen rigid parts - trunk, head, upper arms, forearms,
 * thighs, shins, feet - held by joints with the reach a body has (a hinge for
 * a knee or an elbow, a cone and a twist for a shoulder, a hip, the neck, an
 * ankle: Jolt's `SwingTwistConstraint`, made to approximate a human joint),
 * parts next to each other not colliding (`GroupFilterTable`), the ground a
 * height field and the walls, poles and cars convex prisms. The hand-written
 * stick figure it replaces (`ragdoll.ts` step) went limp like elastic, folded
 * a corpse onto its knees, turned a foot back and threw a hand off the edge
 * of a footway (2026-10-06).
 *
 * The rest of `ragdoll.ts` still reads and writes its particles (the joints'
 * points): after each step they are set from the parts; a change made to
 * them between steps (a bullet's push, a blast, arms put out to break a fall,
 * a knee drawn up) is turned into an impulse on the part that carries the
 * particle. Everything inside Jolt is in metres; the particles are in world
 * units (`toMetres`).
 *
 * https://github.com/jrouwe/JoltPhysics.js · https://jrouwe.github.io/JoltPhysics/
 */

type JoltApi = typeof JoltModule;
type JBody = InstanceType<JoltApi['Body']>;
type JConstraint = InstanceType<JoltApi['Constraint']>;
type JBodyID = InstanceType<JoltApi['BodyID']>;

const LAYER_STATIC = 0, LAYER_MOVING = 1;
/** Parts a ragdoll has (`RagdollSpec.parts`), for its collision groups. */
export const MAX_PARTS = 16;

let api: JoltApi | null = null;
let loading: Promise<void> | null = null;
let world: JoltWorld | null = null;

/** Starts loading Jolt (some 3 MB, once); `joltWorld` is null until it is in. */
export function startJolt(): void {
  if (loading) return;
  loading = import('jolt-physics/wasm-compat')
    .then((mod) => mod.default())
    .then((J) => { api = J as JoltApi; world = new JoltWorld(api); })
    .catch((e: unknown) => { console.warn('Jolt failed to load; bodies fall back to the stick figure', e); });
}

/** The physics world, once Jolt is loaded. */
export function joltWorld(): JoltWorld | null { return world; }

/** A part: a capsule from `a` to `b` (metres, world), or a box; the particles it carries. */
export interface PartSpec {
  readonly shape: { kind: 'capsule'; a: Vector3; b: Vector3; radius: number } | { kind: 'box'; centre: Vector3; axes: [Vector3, Vector3, Vector3]; half: [number, number, number] };
  /** Particle indices carried by this part, and where they are now (metres, world). */
  readonly particles: readonly number[];
}
/** A joint between two parts, at `at` (metres, world). */
export type JointSpec = {
  readonly parent: number; readonly child: number; readonly at: Vector3;
} & ({
  readonly kind: 'hinge'; readonly axis: Vector3; readonly normal: Vector3; readonly min: number; readonly max: number;
  /**
   * Its tone: a weak motor towards a relaxed bend (`relax`, radians from now,
   * `tone` newton metres at most) - not enough to hold weight, enough that a
   * shin is not left balanced straight up in the air.
   */
  readonly relax?: number; readonly tone?: number;
} | {
  readonly kind: 'cone'; readonly twist1: Vector3; readonly twist2: Vector3; readonly plane: Vector3;
  readonly planeCone: number; readonly normalCone: number; readonly twistMin: number; readonly twistMax: number;
});
export interface RagdollSpec {
  readonly parts: readonly PartSpec[];
  readonly joints: readonly JointSpec[];
  /** Every particle's position now (metres, world), by index. */
  readonly points: readonly Vector3[];
}

/** A static collider made for a body (its ground, the walls round it), released with it. */
export interface JoltStatic { readonly id: JBodyID }

const tmpQ = new Quaternion(), tmpV = new Vector3(), tmpW = new Vector3(), tmpM = new Matrix4();

export class JoltWorld {
  readonly J: JoltApi;
  private readonly jolt: InstanceType<JoltApi['JoltInterface']>;
  private readonly bodies: InstanceType<JoltApi['BodyInterface']>;
  private readonly system: InstanceType<JoltApi['PhysicsSystem']>;
  /** Parts next to each other in a ragdoll do not collide (subgroups by part index). */
  readonly groups: InstanceType<JoltApi['GroupFilterTable']>;
  private nextGroup = 1;
  // Scratch Jolt values, reused.
  private readonly v3: InstanceType<JoltApi['Vec3']>;
  private readonly r3: InstanceType<JoltApi['RVec3']>;

  constructor(J: JoltApi) {
    this.J = J;
    const settings = new J.JoltSettings();
    settings.mMaxWorkerThreads = 0;
    const pairs = new J.ObjectLayerPairFilterTable(2);
    pairs.EnableCollision(LAYER_STATIC, LAYER_MOVING);
    pairs.EnableCollision(LAYER_MOVING, LAYER_MOVING);
    const bp = new J.BroadPhaseLayerInterfaceTable(2, 2);
    bp.MapObjectToBroadPhaseLayer(LAYER_STATIC, new J.BroadPhaseLayer(0));
    bp.MapObjectToBroadPhaseLayer(LAYER_MOVING, new J.BroadPhaseLayer(1));
    settings.mObjectLayerPairFilter = pairs;
    settings.mBroadPhaseLayerInterface = bp;
    settings.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(settings.mBroadPhaseLayerInterface, 2, settings.mObjectLayerPairFilter, 2);
    this.jolt = new J.JoltInterface(settings);
    J.destroy(settings);
    this.system = this.jolt.GetPhysicsSystem();
    this.bodies = this.system.GetBodyInterface();
    this.system.SetGravity(new J.Vec3(0, -9.81, 0));
    this.groups = new J.GroupFilterTable(MAX_PARTS);
    this.v3 = new J.Vec3(0, 0, 0);
    this.r3 = new J.RVec3(0, 0, 0);
  }

  step(dt: number): void { this.jolt.Step(dt, 1); }

  /** The ground under a square (metres, world): `n` x `n` samples `cell` apart from (x0, z0), heights from `height`. */
  ground(x0: number, z0: number, n: number, cell: number, height: (x: number, z: number) => number): JoltStatic {
    const J = this.J;
    const s = new J.HeightFieldShapeSettings();
    s.mOffset.Set(x0, 0, z0);
    s.mScale.Set(cell, 1, cell);
    s.mSampleCount = n;
    s.mBlockSize = 4;
    s.mHeightSamples.resize(n * n);
    const heights = new Float32Array(J.HEAPF32.buffer, J.getPointer(s.mHeightSamples.data()), n * n);
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) heights[z * n + x] = height(x0 + x * cell, z0 + z * cell);
    const shape = s.Create().Get();
    J.destroy(s);
    return this.addStatic(shape, 0, 0, 0);
  }

  /** A wall, a pole, a car: the ring (metres, world x and z) stood from `bottom` to `top`. */
  prism(ring: readonly { x: number; z: number }[], bottom: number, top: number): JoltStatic | null {
    if (ring.length < 3 || top - bottom < 0.05) return null;
    const J = this.J;
    const s = new J.ConvexHullShapeSettings();
    let cx = 0, cz = 0;
    for (const q of ring) { cx += q.x; cz += q.z; }
    cx /= ring.length; cz /= ring.length;
    const cy = (bottom + top) / 2;
    for (const q of ring) {
      for (const y of [bottom, top]) { const v = new J.Vec3(q.x - cx, y - cy, q.z - cz); s.mPoints.push_back(v); J.destroy(v); }
    }
    s.mMaxConvexRadius = 0.02;
    const result = s.Create();
    J.destroy(s);
    if (result.HasError()) return null;
    return this.addStatic(result.Get(), cx, cy, cz);
  }

  private addStatic(shape: InstanceType<JoltApi['Shape']>, x: number, y: number, z: number): JoltStatic {
    const J = this.J;
    const pos = new J.RVec3(x, y, z), rot = new J.Quat(0, 0, 0, 1);
    const c = new J.BodyCreationSettings(shape, pos, rot, J.EMotionType_Static, LAYER_STATIC);
    c.mFriction = 0.9;
    const body = this.bodies.CreateBody(c);
    J.destroy(c); J.destroy(pos); J.destroy(rot);
    this.bodies.AddBody(body.GetID(), J.EActivation_DontActivate);
    return { id: body.GetID() };
  }

  release(list: readonly JoltStatic[]): void {
    for (const s of list) { this.bodies.RemoveBody(s.id); this.bodies.DestroyBody(s.id); }
  }

  /** A ragdoll from its spec, moving at rest (the particles' own velocities come in as pushes). */
  ragdoll(spec: RagdollSpec): JoltRagdoll {
    const J = this.J;
    const group = this.nextGroup++;
    const parts: JBody[] = [];
    const owner = new Map<number, { part: number; local: Vector3 }>();
    spec.parts.forEach((part, i) => {
      let shape: InstanceType<JoltApi['Shape']>;
      const centre = new Vector3();
      const rot = new Quaternion();
      if (part.shape.kind === 'capsule') {
        const { a, b, radius } = part.shape;
        centre.addVectors(a, b).multiplyScalar(0.5);
        const axis = tmpV.subVectors(b, a);
        const len = axis.length();
        rot.setFromUnitVectors(tmpW.set(0, 1, 0), len > 1e-6 ? axis.divideScalar(len) : tmpW.set(0, 1, 0));
        shape = new J.CapsuleShapeSettings(Math.max(0.01, len / 2), radius).Create().Get();
      } else {
        centre.copy(part.shape.centre);
        rot.setFromRotationMatrix(tmpM.makeBasis(part.shape.axes[0], part.shape.axes[1], part.shape.axes[2]));
        const [hx, hy, hz] = part.shape.half;
        const he = new J.Vec3(hx, hy, hz);
        shape = new J.BoxShapeSettings(he, Math.min(0.05, hx * 0.5, hy * 0.5, hz * 0.5)).Create().Get();
        J.destroy(he);
      }
      const pos = new J.RVec3(centre.x, centre.y, centre.z), q = new J.Quat(rot.x, rot.y, rot.z, rot.w);
      const c = new J.BodyCreationSettings(shape, pos, q, J.EMotionType_Dynamic, LAYER_MOVING);
      J.destroy(pos); J.destroy(q);
      c.mFriction = 0.85;
      c.mRestitution = 0;
      c.mLinearDamping = 0.08;
      c.mAngularDamping = 0.25;
      c.mMaxAngularVelocity = 30;
      c.mMotionQuality = J.EMotionQuality_LinearCast;
      const cg = new J.CollisionGroup(this.groups, group, i);
      c.mCollisionGroup = cg;
      J.destroy(cg);
      const body = this.bodies.CreateBody(c);
      J.destroy(c);
      this.bodies.AddBody(body.GetID(), J.EActivation_Activate);
      parts.push(body);
      const inv = rot.clone().invert();
      for (const k of part.particles) owner.set(k, { part: i, local: spec.points[k]!.clone().sub(centre).applyQuaternion(inv) });
    });
    const joints: (JConstraint | null)[] = spec.joints.map((j) => this.joint(j, parts));
    return new JoltRagdoll(this, parts, joints, spec.joints, owner);
  }

  private joint(j: JointSpec, parts: readonly JBody[]): JConstraint {
    const J = this.J;
    const p = new J.RVec3(j.at.x, j.at.y, j.at.z);
    let c: JConstraint;
    if (j.kind === 'hinge') {
      const s = new J.HingeConstraintSettings();
      s.mSpace = J.EConstraintSpace_WorldSpace;
      const h = new J.Vec3(j.axis.x, j.axis.y, j.axis.z), n = new J.Vec3(j.normal.x, j.normal.y, j.normal.z);
      s.mPoint1 = p; s.mPoint2 = p;
      s.mHingeAxis1 = h; s.mHingeAxis2 = h;
      s.mNormalAxis1 = n; s.mNormalAxis2 = n;
      s.mLimitsMin = j.min; s.mLimitsMax = j.max;
      s.mMaxFrictionTorque = 0.5;
      if (j.tone) {
        const ms = new J.MotorSettings(), sp = new J.SpringSettings();
        sp.mFrequency = 1.5; sp.mDamping = 1;
        ms.mSpringSettings = sp;
        ms.mMinTorqueLimit = -j.tone; ms.mMaxTorqueLimit = j.tone;
        s.mMotorSettings = ms;
        J.destroy(ms); J.destroy(sp);
      }
      c = s.Create(parts[j.parent]!, parts[j.child]!);
      J.destroy(s); J.destroy(h); J.destroy(n);
      if (j.tone && j.relax !== undefined) {
        const hinge = J.castObject(c, J.HingeConstraint);
        hinge.SetMotorState(J.EMotorState_Position);
        hinge.SetTargetAngle(Math.max(j.min, Math.min(j.max, j.relax)));
      }
    } else {
      const s = new J.SwingTwistConstraintSettings();
      s.mSpace = J.EConstraintSpace_WorldSpace;
      const t1 = new J.Vec3(j.twist1.x, j.twist1.y, j.twist1.z), t2 = new J.Vec3(j.twist2.x, j.twist2.y, j.twist2.z);
      const pl = new J.Vec3(j.plane.x, j.plane.y, j.plane.z);
      s.mPosition1 = p; s.mPosition2 = p;
      s.mTwistAxis1 = t1; s.mTwistAxis2 = t2;
      s.mPlaneAxis1 = pl; s.mPlaneAxis2 = pl;
      s.mPlaneHalfConeAngle = j.planeCone; s.mNormalHalfConeAngle = j.normalCone;
      s.mTwistMinAngle = j.twistMin; s.mTwistMaxAngle = j.twistMax;
      s.mMaxFrictionTorque = 2;
      c = s.Create(parts[j.parent]!, parts[j.child]!);
      J.destroy(s); J.destroy(t1); J.destroy(t2); J.destroy(pl);
    }
    J.destroy(p);
    this.system.AddConstraint(c);
    return c;
  }

  /** Parts of a ragdoll that do not collide with each other (parent and child), set once per pair of part indices. */
  separate(a: number, b: number): void { this.groups.DisableCollision(a, b); }

  // --- what a ragdoll needs of the world
  position(id: JBodyID, out: Vector3): Vector3 { const p = this.bodies.GetPosition(id); return out.set(p.GetX(), p.GetY(), p.GetZ()); }
  rotation(id: JBodyID, out: Quaternion): Quaternion { const q = this.bodies.GetRotation(id); return out.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW()); }
  pointVelocity(id: JBodyID, at: Vector3, out: Vector3): Vector3 {
    this.r3.Set(at.x, at.y, at.z);
    const v = this.bodies.GetPointVelocity(id, this.r3);
    return out.set(v.GetX(), v.GetY(), v.GetZ());
  }
  impulse(id: JBodyID, impulse: Vector3, at: Vector3): void {
    this.v3.Set(impulse.x, impulse.y, impulse.z);
    this.r3.Set(at.x, at.y, at.z);
    this.bodies.AddImpulse(id, this.v3, this.r3);
    this.bodies.ActivateBody(id);
  }
  mass(body: JBody): number {
    const inv = body.GetMotionProperties().GetInverseMass();
    return inv > 0 ? 1 / inv : 0;
  }
  active(id: JBodyID): boolean { return this.bodies.IsActive(id); }
  deactivate(id: JBodyID): void { this.bodies.DeactivateBody(id); }
  removeConstraint(c: JConstraint): void { this.system.RemoveConstraint(c); }
  destroyBody(body: JBody): void { const id = body.GetID(); this.bodies.RemoveBody(id); this.bodies.DestroyBody(id); }
}

/** One body's parts in Jolt, and which part carries each of its particles. */
export class JoltRagdoll {
  private readonly owner: Map<number, { part: number; local: Vector3 }>;
  constructor(
    private readonly world: JoltWorld,
    readonly parts: (JBody | null)[],
    private readonly joints: (JConstraint | null)[],
    private readonly jointSpecs: readonly JointSpec[],
    owner: Map<number, { part: number; local: Vector3 }>,
  ) { this.owner = owner; }

  /** Where particle `k` is now (metres, world); null when no part carries it. */
  point(k: number, out: Vector3): Vector3 | null {
    const o = this.owner.get(k);
    const part = o ? this.parts[o.part] : null;
    if (!o || !part) return null;
    const id = part.GetID();
    this.world.rotation(id, tmpQ);
    return this.world.position(id, out).add(tmpV.copy(o.local).applyQuaternion(tmpQ));
  }

  /** How fast particle `k` moves (metres a second, world). */
  velocity(k: number, out: Vector3): Vector3 | null {
    const o = this.owner.get(k);
    const part = o ? this.parts[o.part] : null;
    if (!o || !part) return null;
    const at = this.point(k, tmpW);
    return at ? this.world.pointVelocity(part.GetID(), at, out) : null;
  }

  /** Particle `k`'s speed changed by `dv` (metres a second): an impulse on its part, at it, for its share of the part's mass. */
  push(k: number, dv: Vector3, share: number): void {
    const o = this.owner.get(k);
    const part = o ? this.parts[o.part] : null;
    if (!o || !part) return;
    const at = this.point(k, new Vector3());
    if (!at) return;
    this.world.impulse(part.GetID(), dv.clone().multiplyScalar(this.world.mass(part) * share), at);
  }

  /**
   * A muscle's pull: particles `a` and `b` drawn towards each other by
   * `impulse` (newton seconds) - equal and opposite, so the body as a whole
   * is not moved (a knee drawn up to the belly does not sit the body up).
   */
  pull(a: number, b: number, impulse: number): void {
    const oa = this.owner.get(a), ob = this.owner.get(b);
    const pa = oa ? this.parts[oa.part] : null, pb = ob ? this.parts[ob.part] : null;
    if (!oa || !ob || !pa || !pb || oa.part === ob.part) return;
    const A = this.point(a, new Vector3()), B = this.point(b, new Vector3());
    if (!A || !B) return;
    const d = B.clone().sub(A);
    const l = d.length();
    if (l < 1e-4) return;
    d.multiplyScalar(impulse / l);
    this.world.impulse(pa.GetID(), d, A);
    this.world.impulse(pb.GetID(), d.negate(), B);
  }

  /** How many particles part `i` carries. */
  carried(i: number): number { let n = 0; for (const o of this.owner.values()) if (o.part === i) n++; return n; }
  partOf(k: number): number { return this.owner.get(k)?.part ?? -1; }

  /** Whether any part is still moving (Jolt has not put it to sleep). */
  active(): boolean { return this.parts.some((p) => p !== null && this.world.active(p.GetID())); }

  /** Every part put to sleep (the body lies still; a push wakes it). */
  sleep(): void { for (const p of this.parts) if (p) this.world.deactivate(p.GetID()); }

  /**
   * Parts torn off (`ragdoll.ts` detach): the joints holding them to the rest
   * let go, and they go to a ragdoll of their own; the particles they carried
   * here stay where the tear is, carried by `stump` at the point `at`.
   */
  tear(torn: readonly number[], stump: number, at: Vector3, moved: readonly number[], root?: { particle: number; part: number }): JoltRagdoll {
    const set = new Set(torn);
    // The joint it came off at goes with the piece too, on its first part:
    // left behind, the piece's bone was drawn from there to wherever the
    // limb flew, a sleeve stretched metres long.
    let rootOwner: { part: number; local: Vector3 } | null = null;
    const rootBody = root ? this.parts[root.part] : null;
    if (root && rootBody) {
      const p = this.point(root.particle, new Vector3());
      if (p) {
        this.world.rotation(rootBody.GetID(), tmpQ);
        rootOwner = { part: root.part, local: p.sub(this.world.position(rootBody.GetID(), tmpV)).applyQuaternion(tmpQ.clone().invert()) };
      }
    }
    this.jointSpecs.forEach((j, i) => {
      const c = this.joints[i];
      if (!c) return;
      if (set.has(j.child) !== set.has(j.parent)) { this.world.removeConstraint(c); this.joints[i] = null; }
    });
    const pieceOwner = new Map<number, { part: number; local: Vector3 }>();
    for (const [k, o] of this.owner) if (set.has(o.part)) pieceOwner.set(k, o);
    const pieceParts = this.parts.map((p, i) => (set.has(i) ? p : null));
    const pieceJoints = this.joints.map((c, i) => (c && set.has(this.jointSpecs[i]!.child) && set.has(this.jointSpecs[i]!.parent) ? c : null));
    for (const i of torn) this.parts[i] = null;
    // The particles that went with the piece stay here at the tear, on the stump.
    const stumpPart = this.parts[stump];
    if (stumpPart) {
      this.world.rotation(stumpPart.GetID(), tmpQ);
      const local = at.clone().sub(this.world.position(stumpPart.GetID(), tmpV)).applyQuaternion(tmpQ.clone().invert());
      for (const k of moved) this.owner.set(k, { part: stump, local: local.clone() });
    }
    for (const k of pieceOwner.keys()) if (!moved.includes(k)) this.owner.delete(k);
    if (root && rootOwner) pieceOwner.set(root.particle, rootOwner);
    return new JoltRagdoll(this.world, pieceParts, pieceJoints, this.jointSpecs, pieceOwner);
  }

  destroy(): void {
    this.joints.forEach((c, i) => { if (c) { this.world.removeConstraint(c); this.joints[i] = null; } });
    this.parts.forEach((p, i) => { if (p) { this.world.destroyBody(p); this.parts[i] = null; } });
  }
}
