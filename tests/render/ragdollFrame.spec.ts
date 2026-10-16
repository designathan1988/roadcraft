import { Matrix4, Quaternion, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRagdolls, type RagdollCitizens, type RagdollWorld } from '@render/ragdoll';
import type { Exhaust } from '@render/exhaust';
import { m } from '@world/units';

/** A FRAME OF THE BODIES ON THE GROUND MAKES NOTHING NEW (`render/ragdoll.ts`: palettes, bones, steps). */

/** A stick skeleton with the bones the ragdolls look for, standing (metres, y up, toes forward along z). */
const BONES: readonly (readonly [string, number, readonly [number, number, number]])[] = [
  ['Bip01', -1, [0, 0, 0]],
  ['Bip01_Pelvis', 0, [0, 1, 0]], ['Bip01_Spine2', 1, [0, 1.4, 0]], ['Bip01_Neck', 2, [0, 1.55, 0]], ['Bip01_Head', 3, [0, 1.65, 0]],
  ['Bip01_L_UpperArm', 2, [0.2, 1.45, 0]], ['Bip01_L_Forearm', 5, [0.45, 1.45, 0]], ['Bip01_L_Hand', 6, [0.7, 1.45, 0]],
  ['Bip01_R_UpperArm', 2, [-0.2, 1.45, 0]], ['Bip01_R_Forearm', 8, [-0.45, 1.45, 0]], ['Bip01_R_Hand', 9, [-0.7, 1.45, 0]],
  ['Bip01_L_Thigh', 1, [0.1, 0.95, 0]], ['Bip01_L_Calf', 11, [0.1, 0.5, 0]], ['Bip01_L_Foot', 12, [0.1, 0.08, 0]], ['Bip01_L_Toe0', 13, [0.1, 0.02, 0.15]],
  ['Bip01_R_Thigh', 1, [-0.1, 0.95, 0]], ['Bip01_R_Calf', 15, [-0.1, 0.5, 0]], ['Bip01_R_Foot', 16, [-0.1, 0.08, 0]], ['Bip01_R_Toe0', 17, [-0.1, 0.02, 0.15]],
];
const skeleton = {
  names: BONES.map(([name]) => name),
  parents: BONES.map(([, parent]) => parent),
  inverses: BONES.map(([, , [x, y, z]]) => new Matrix4().makeTranslation(x, y, z).invert()),
  local: new Matrix4(),
  bind: new Matrix4(),
};
/** Every bone at rest: the skin matrix of the pose it was bound in. */
const REST = new Float32Array(BONES.length * 16);
for (let i = 0; i < BONES.length; i++) new Matrix4().toArray(REST, i * 16);

const exhaust = { burst() {} } as unknown as Exhaust;
const flat: RagdollWorld = { groundAt: () => 0, wallsNear: () => [] };

/** The people as a cooked body draws them; `drawn` gets each frame's palettes. */
function people(drawn: Float32Array[]): RagdollCitizens {
  return {
    capturedPose: () => ({ index: 0, palette: REST, transform: new Matrix4().compose(new Vector3(), new Quaternion(), new Vector3(m(1), m(1), m(1))) }),
    skeletonOf: () => skeleton,
    drawPalette: (_index, palette) => { drawn.push(palette); },
    // No captured getting-up (as `agents.ts` riggedRagdoll): the key poses, then the crouch clip.
    clipPose: (_index, key) => (key === 'getUpFront' || key === 'getUpBack' || key === 'crawl' ? null : { palette: REST, duration: 1.2 }),
    loadedIndices: () => [0],
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('the bodies on the ground', () => {
  it('pose a body into its own palette every frame, its rest pose first as the bones were bound', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const ragdolls = createRagdolls(exhaust, () => {});
    const drawn: Float32Array[] = [];
    const citizens = people(drawn);
    ragdolls.fling([{ id: 7, x: 0, y: 0, z: 0, heading: 0, blastX: -1, blastY: 0, power: 0.5, kind: 'dead', index: 0 }], citizens, flat);
    expect(ragdolls.stats().bodies).toBe(1);
    ragdolls.draw(citizens, flat);
    expect(drawn.length).toBe(1);
    const first = drawn[0]!;
    // Unmoved, each bone's skin matrix is the anchor's inverse times where the body was put: the bones cancel out.
    const s = m(1);
    const put = new Matrix4().compose(new Vector3(), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2), new Vector3(s, s, s));
    const expected = new Matrix4().makeScale(s, s, s).setPosition(0, s, 0).invert().multiply(put).elements;
    for (let i = 0; i < BONES.length; i++) {
      for (let e = 0; e < 16; e++) expect(first[i * 16 + e]!).toBeCloseTo(expected[e]!, 4);
    }
    const before = first.slice();
    let moved = false;
    for (let frame = 0; frame < 120; frame++) {
      drawn.length = 0;
      ragdolls.update(1 / 60, flat);
      ragdolls.draw(citizens, flat);
      // One piece, one palette: the same array written again, none made.
      expect(drawn.length).toBe(1);
      expect(drawn[0]).toBe(first);
      expect(first.every(Number.isFinite)).toBe(true);
      expect(ragdolls.active()).toBe(ragdolls.stats().moving > 0 || ragdolls.stats().living > 0);
      if (first.some((v, k) => Math.abs(v - before[k]!) > 1e-6)) moved = true;
    }
    // It fell: the palette written is this frame's pose, not the first one kept.
    expect(moved).toBe(true);
  });

  it('keeps one palette for somebody falling, lying and getting up again', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const ragdolls = createRagdolls(exhaust, () => {});
    const drawn: Float32Array[] = [];
    const citizens = people(drawn);
    ragdolls.trip(3, 0, citizens, flat);
    expect(ragdolls.stats().living).toBe(1);
    let palette: Float32Array | null = null;
    let rising = 0;
    for (let frame = 0; frame < 30 * 12 && ragdolls.stats().bodies > 0; frame++) {
      drawn.length = 0;
      ragdolls.update(1 / 30, flat);
      if (ragdolls.stats().bodies === 0) break;
      ragdolls.draw(citizens, flat);
      if (ragdolls.debug()[0]?.phase.startsWith('rise')) rising++;
      expect(drawn.length).toBe(1);
      palette ??= drawn[0]!;
      // Fallen (the bones), getting up (the key poses), then into the clip (the blend): always the same array.
      expect(drawn[0]).toBe(palette);
      expect(palette.every(Number.isFinite)).toBe(true);
    }
    expect(rising).toBeGreaterThan(30);
  });
});
