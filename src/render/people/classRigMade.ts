import { SkinnedMesh } from 'three';
import type { MacroParams } from '@people/body/macro';
import { assemblePerson, cookPerson, decodeCookedPerson, type DecodedPerson } from './cookedPerson';
import { rigDeltasAt, type PersonRig, type RigDeltas } from './personRig';

/** A PROCEDURAL CLASS'S RIG MADE ON THE PEOPLE'S WORKER AND PUT TOGETHER ON THE PAGE (`proceduralCrowd.ts` buildClass, `citizenBake.worker.ts` klass) */

/** A class's rig as the page puts it together: its body as a cooked person, what its shape and posture are, its height. */
export interface ClassRigMade {
  readonly person: DecodedPerson;
  readonly morphSource: { readonly kind: Int16Array; readonly index: Int32Array };
  readonly deltas: RigDeltas;
  readonly base: MacroParams;
  readonly shape: Float32Array;
  readonly height: number;
}

/** What the worker sends of a rig it keeps (copies: it goes on fitting items with its own), and the buffers to move. */
export function classRigMade(rig: PersonRig, base: MacroParams, shape: Float32Array): { made: ClassRigMade; transfer: ArrayBuffer[] } {
  const { person, transfer } = decodeCookedPerson(cookPerson(rig.scene));
  const source = rig.mesh.geometry.userData['morphSource'] as { kind: Int16Array; index: Int32Array };
  const d = rig.deltasData!;
  // The shape is the posture's positions (`createPersonRig` input): one copy sent for both.
  const positions = shape.slice();
  const made: ClassRigMade = {
    person, morphSource: { kind: source.kind.slice(), index: source.index.slice() },
    deltas: { positions: d.positions === shape ? positions : d.positions.slice(), lowestDm: d.lowestDm, bodyRange: d.bodyRange, linear: d.linear.slice() },
    base, shape: positions, height: rig.height,
  };
  const moved = new Set<ArrayBuffer>([made.morphSource.kind.buffer as ArrayBuffer, made.morphSource.index.buffer as ArrayBuffer,
    made.deltas.positions.buffer as ArrayBuffer, made.deltas.linear.buffer as ArrayBuffer, positions.buffer as ArrayBuffer]);
  transfer.push(...moved);
  return { made, transfer };
}

/** Whether memory can be shared with the workers: a cross-origin isolated page (MDN, `SharedArrayBuffer`, COOP/COEP). */
const canShare = (): boolean => typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

/** `a` in shared memory (the people's worker reads it with no copy a job); as it is where memory cannot be shared. */
export function sharedCopy<T extends Float32Array | Float64Array | Int32Array>(a: T): T {
  if (!canShare() || a.buffer instanceof SharedArrayBuffer) return a;
  const c = new (a.constructor as new (b: SharedArrayBuffer) => T)(new SharedArrayBuffer(a.byteLength));
  c.set(a as never);
  return c;
}

/** The rig on the page from what the worker sent: its body put together, its face moves worked out from its posture (the base mesh's `weights` and `joints`); its items are fitted on the worker. */
/** DO NOT keep the posture twice (a copy for each face job, `faceShare`): its arrays shared at once, the only ones kept (the shape is its positions); `deltasAt` reads the rig's own at each call. */
export function rigFromMade(made: ClassRigMade, weights: ArrayLike<number>, joints: ArrayLike<number>): { rig: PersonRig; shape: Float32Array } {
  const scene = assemblePerson(made.person);
  let mesh: SkinnedMesh | undefined;
  scene.traverse((o) => { if (o instanceof SkinnedMesh && !mesh) mesh = o; });
  if (!mesh) throw new Error('a class rig without a body');
  mesh.geometry.userData['morphSource'] = made.morphSource;
  const positions = sharedCopy(made.deltas.positions);
  const rig: PersonRig = {
    scene, mesh, height: made.height,
    deltasData: { positions, lowestDm: made.deltas.lowestDm, bodyRange: made.deltas.bodyRange, linear: sharedCopy(made.deltas.linear) },
    deltasAt: (offset, vertices) => rigDeltasAt(rig.deltasData!, weights, joints, offset, vertices),
  };
  return { rig, shape: made.shape === made.deltas.positions ? positions : made.shape };
}
