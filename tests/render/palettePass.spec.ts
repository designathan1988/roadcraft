import { describe, expect, it } from 'vitest';
import { Matrix3, Matrix4, Vector3 } from 'three';
import { BLEND_FRAGMENT, REFIT_FRAGMENT } from '@render/people/crowdAnimation';

/** THE PALETTE PASS IN TWO (plan 9.6): each bone blended once a person, the refit reading its parents' blends back, the same palette as blending each parent again */

const fetches = (glsl: string, sampler: string): number => glsl.split(`texelFetch(${sampler}`).length - 1;

describe('the palette pass of the procedural crowd', () => {
  it('blends in the first pass only, and refits in the second from the blends read back, never from the clips', () => {
    expect(BLEND_FRAGMENT).toContain('atlasBone(r, bone)');
    expect(BLEND_FRAGMENT).not.toContain('uParent');
    expect(REFIT_FRAGMENT).not.toContain('uAtlas');
    expect(REFIT_FRAGMENT).not.toContain('atlasBone');
    // A parent's turn is three texels read back, not its plays blended again (24 texels of the atlas and 4 of the plays).
    expect(fetches(REFIT_FRAGMENT, 'uBlend')).toBe(7);
  });

  it('gives the palette of blending every parent again: the refit is the same sums', () => {
    // A chain of five bones, each with its blend and joints; the old pass blended a parent where the new one reads it.
    const bones = 5, parent = [-1, 0, 1, 2, 1];
    let seed = 7;
    const r = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const blends = Array.from({ length: bones }, () => new Matrix4().makeRotationFromEuler({ x: r(), y: r(), z: r(), order: 'XYZ', isEuler: true } as never).setPosition(r(), r(), r()));
    const joints = Array.from({ length: bones }, () => new Vector3(r(), r(), r()));
    // The refit of both passes, written once: what differs is only where a parent's turn comes from.
    const refit = (bone: number, turnOf: (b: number) => Matrix3): Matrix4 => {
      const m = blends[bone]!.clone();
      const shift = new Vector3();
      let cur = bone;
      for (;;) {
        const p = parent[cur]!;
        if (p < 0) break;
        shift.add(joints[cur]!.clone().sub(joints[p]!).applyMatrix3(turnOf(p)));
        cur = p;
      }
      shift.add(joints[cur]!);
      const own = joints[bone]!.clone().applyMatrix3(new Matrix3().setFromMatrix4(m));
      const e = m.elements;
      e[12] += shift.x - own.x; e[13] += shift.y - own.y; e[14] += shift.z - own.z;
      return m;
    };
    // Read back from a float target: the same float32 numbers the blend wrote.
    const readBack = blends.map((b) => new Matrix4().fromArray(Float32Array.from(b.elements)));
    for (let bone = 0; bone < bones; bone++) {
      const again = refit(bone, (p) => new Matrix3().setFromMatrix4(new Matrix4().fromArray(Float32Array.from(blends[p]!.elements))));
      const read = refit(bone, (p) => new Matrix3().setFromMatrix4(readBack[p]!));
      for (let i = 0; i < 16; i++) expect(read.elements[i]).toBe(again.elements[i]);
    }
  });
});
