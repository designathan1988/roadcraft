import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { JoltRagdoll, JoltWorld, type JointSpec } from '@render/ragdollJolt';

/** ONE OWNER FOR EVERY JOINT. */

/** A world that records what the ragdolls ask of it: each joint must leave it exactly once. */
function countingWorld() {
  const removed = new Map<object, number>();
  const destroyed = new Map<object, number>();
  const world = {
    removeConstraint: (c: object) => removed.set(c, (removed.get(c) ?? 0) + 1),
    destroyBody: (b: object) => destroyed.set(b, (destroyed.get(b) ?? 0) + 1),
    // Where the stump part is, for the particles left at the tear: at rest at the origin.
    rotation: (_id: unknown, out: { set(x: number, y: number, z: number, w: number): unknown }) => out.set(0, 0, 0, 1),
    position: (_id: unknown, out: { set(x: number, y: number, z: number): unknown }) => out.set(0, 0, 0),
  };
  return { world: world as unknown as JoltWorld, removed, destroyed };
}

const at = new Vector3();
const hinge = (parent: number, child: number): JointSpec => ({ kind: 'hinge', parent, child, at, axis: new Vector3(1, 0, 0), normal: new Vector3(0, 1, 0), min: -1, max: 1 });

describe('a ragdoll torn in two', () => {
  it('takes each joint out of the physics once, whichever half goes first', () => {
    for (const order of ['body first', 'piece first'] as const) {
      const { world, removed, destroyed } = countingWorld();
      // A chain of three parts: 0 - 1 - 2; parts 1 and 2 are torn off together.
      const parts = [0, 1, 2].map((i) => ({ GetID: () => i }));
      const a = { j: 'a' }, b = { j: 'b' };
      // The ragdoll owns (and empties) the array it is given.
      const joints = [a, b];
      const specs = [hinge(0, 1), hinge(1, 2)];
      const owner = new Map([[0, { part: 0, local: new Vector3() }], [1, { part: 1, local: new Vector3() }], [2, { part: 2, local: new Vector3() }]]);
      const body = new JoltRagdoll(world, parts as never, joints as never, specs, owner);
      const piece = body.tear([1, 2], 0, new Vector3(), []);
      if (order === 'body first') { body.destroy(); piece.destroy(); } else { piece.destroy(); body.destroy(); }
      // The joint between 0 and 1 let go at the tear; the one inside the piece (1 - 2) went with it.
      expect([...removed.values()], order).toEqual([1, 1]);
      expect(removed.get(a)).toBe(1);
      expect(removed.get(b)).toBe(1);
      expect([...destroyed.values()]).toEqual([1, 1, 1]);
    }
  });
});

describe('the physics world', () => {
  it('refuses to take a joint out twice instead of corrupting the engine', async () => {
    const mod = await import('jolt-physics/wasm-compat');
    const J = await mod.default();
    const world = new JoltWorld(J as never);
    const p = (x: number) => new Vector3(x, 1, 0);
    const ragdoll = world.ragdoll({
      parts: [
        { shape: { kind: 'capsule', a: p(0), b: p(0.4), radius: 0.05 }, particles: [0] },
        { shape: { kind: 'capsule', a: p(0.4), b: p(0.8), radius: 0.05 }, particles: [1] },
      ],
      joints: [{ ...hinge(0, 1), at: p(0.4) }],
      points: [p(0), p(0.8)],
    });
    expect(world.liveConstraints).toBe(1);
    const joint = (ragdoll as unknown as { joints: unknown[] }).joints[0] as never;
    world.removeConstraint(joint);
    expect(world.liveConstraints).toBe(0);
    expect(() => world.removeConstraint(joint)).toThrow(/twice/);
    world.step(1 / 60);
  });
});
