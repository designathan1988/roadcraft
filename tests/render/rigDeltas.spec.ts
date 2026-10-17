import { describe, expect, it } from 'vitest';
import { Matrix3, Vector3 } from 'three';
import { rigDeltasAt } from '@render/people/personRig';

/** A face's moves worked out from shared data (`rigDeltasAt`, the people's worker) are the rig's own (`deltasAt`, `Vector3.applyMatrix3`) */

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("a face's moves from shared data", () => {
  it('are, number for number, the rig\u2019s own sum of each bone\u2019s posture', () => {
    const r = random(7);
    const n = 40, bones = 5;
    const positions = Float32Array.from({ length: n * 3 }, () => (r() - 0.5) * 20);
    const offset = Float32Array.from({ length: n * 3 }, () => (r() - 0.5) * 0.4);
    const weights = Uint16Array.from({ length: n * 4 }, (_, i) => (i % 4 === 3 ? 0 : Math.floor(r() * 65535)));
    const joints = Uint8Array.from({ length: n * 4 }, () => Math.floor(r() * bones));
    const matrices = Array.from({ length: bones }, () => new Matrix3().set(r(), r(), r(), r(), r(), r(), r(), r(), r()));
    const linear = new Float64Array(bones * 9);
    matrices.forEach((m, i) => linear.set(m.elements, i * 9));
    const bodyRange = [[0, n - 1]] as const;
    let lowestDm = Infinity;
    for (let v = 0; v < n; v++) lowestDm = Math.min(lowestDm, positions[v * 3 + 1]!);
    const vertices = [0, 3, 7, 12, 39];
    const got = rigDeltasAt({ positions, lowestDm, bodyRange, linear }, weights, joints, offset, vertices);
    // The rig's own computation, as it was written with three's vectors.
    let lowestOffset = Infinity;
    for (let v = 0; v < n; v++) lowestOffset = Math.min(lowestOffset, positions[v * 3 + 1]! + offset[v * 3 + 1]!);
    const drop = lowestOffset - lowestDm;
    const d = new Vector3(), q = new Vector3();
    vertices.forEach((v, i) => {
      d.set(offset[v * 3]! / 10, (offset[v * 3 + 1]! - drop) / 10, offset[v * 3 + 2]! / 10);
      let sum = 0, x = 0, y = 0, z = 0;
      for (let k = 0; k < 4; k++) {
        const w = weights[v * 4 + k]! / 65535;
        if (w === 0) continue;
        q.copy(d).applyMatrix3(matrices[joints[v * 4 + k]!]!);
        x += q.x * w; y += q.y * w; z += q.z * w; sum += w;
      }
      expect(got[i * 3]).toBe(Math.fround(sum > 0 ? x / sum : d.x));
      expect(got[i * 3 + 1]).toBe(Math.fround(sum > 0 ? y / sum : d.y));
      expect(got[i * 3 + 2]).toBe(Math.fround(sum > 0 ? z / sum : d.z));
    });
  });
});
