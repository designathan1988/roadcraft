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
  const made: ClassRigMade = {
    person, morphSource: { kind: source.kind.slice(), index: source.index.slice() },
    deltas: { positions: d.positions.slice(), lowestDm: d.lowestDm, bodyRange: d.bodyRange, linear: d.linear.slice() },
    base, shape: shape.slice(), height: rig.height,
  };
  transfer.push(made.morphSource.kind.buffer as ArrayBuffer, made.morphSource.index.buffer as ArrayBuffer, made.deltas.positions.buffer as ArrayBuffer,
    made.deltas.linear.buffer as ArrayBuffer, made.shape.buffer as ArrayBuffer);
  return { made, transfer };
}

/** The rig on the page from what the worker sent: its body put together, its face moves worked out from its posture (the base mesh's `weights` and `joints`); its items are fitted on the worker. */
export function rigFromMade(made: ClassRigMade, weights: ArrayLike<number>, joints: ArrayLike<number>): PersonRig {
  const scene = assemblePerson(made.person);
  let mesh: SkinnedMesh | undefined;
  scene.traverse((o) => { if (o instanceof SkinnedMesh && !mesh) mesh = o; });
  if (!mesh) throw new Error('a class rig without a body');
  mesh.geometry.userData['morphSource'] = made.morphSource;
  const deltas = made.deltas;
  return { scene, mesh, height: made.height, deltasData: deltas, deltasAt: (offset, vertices) => rigDeltasAt(deltas, weights, joints, offset, vertices) };
}
