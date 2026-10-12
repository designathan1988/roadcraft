import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { bakeFrames, restRig } from '@render/citizenBake';
import { PACKED_BONE_FLOATS, SKIN_BONE_FLOATS, blendPackedFrames, copyPackedFrame, packBoneMatrices } from '@render/citizenPalette';
import { citizenRig } from './support/citizenRig';

describe('citizen animation palette', () => {
  it('preserves affine bone transforms and their blended GPU palette', () => {
    const a = new Matrix4().compose(new Vector3(0.3, 1.2, -0.8), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4), new Vector3(1, 1, 1));
    const b = new Matrix4().compose(new Vector3(-0.7, 0.9, 0.2), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.3), new Vector3(1, 1, 1));
    const original = Float32Array.from([...a.elements, ...b.elements]);
    const packed = new Float32Array(2 * PACKED_BONE_FLOATS);
    packBoneMatrices(original, packed, 0);
    const restored = new Float32Array(2 * SKIN_BONE_FLOATS);
    copyPackedFrame(restored, 0, packed, 0, 2);
    expect(restored).toEqual(original);

    const blended = new Float32Array(SKIN_BONE_FLOATS);
    blendPackedFrames(blended, 0, packed, 0, PACKED_BONE_FLOATS, 1, 0.35, 0.65);
    for (let i = 0; i < SKIN_BONE_FLOATS; i++) {
      expect(blended[i]).toBeCloseTo(original[i]! * 0.35 + original[i + SKIN_BONE_FLOATS]! * 0.65, 6);
    }
  });

  it('rejects a non-affine pose rather than silently changing it', () => {
    const perspective = Float32Array.from(new Matrix4().makePerspective(-1, 1, 1, -1, 0.1, 10).elements);
    expect(() => packBoneMatrices(perspective, new Float32Array(PACKED_BONE_FLOATS), 0)).toThrow('non-affine');
  });

  it('reconstructs an actual MakeHuman skeleton bake exactly', async () => {
    const body = restRig(await citizenRig('mh_00'));
    const baked = await bakeFrames(body, () => body.reset(), 1, true, 1);
    const bones = body.mesh.skeleton.bones.length;
    expect(baked.data.length).toBe((baked.frames + 2) * bones * PACKED_BONE_FLOATS);
    body.mesh.skeleton.update();
    const expected = Float32Array.from(body.mesh.skeleton.boneMatrices!);
    const restored = new Float32Array(bones * SKIN_BONE_FLOATS);
    copyPackedFrame(restored, 0, baked.data, 0, bones);
    expect(restored).toEqual(expected);
  });
});
