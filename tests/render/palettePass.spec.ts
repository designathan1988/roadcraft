import { describe, expect, it } from 'vitest';
import { DataTexture, FloatType, Matrix3, Matrix4, RGBAFormat, Vector3, type WebGLRenderer } from 'three';
import { BLEND_FRAGMENT, REFIT_FRAGMENT, buildClassAnimation, createPalettePass, createPaletteTargets, renderPalettes } from '@render/people/crowdAnimation';
import type { ClipFrames } from '@render/citizenBake';

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

  it('places a person in the pass: bind * drawn * bind^-1 on the palette skins a vertex where the instance matrix put it', () => {
    expect(REFIT_FRAGMENT).toContain('#ifdef PLACED');
    expect(REFIT_FRAGMENT).toContain('m = place * m;');
    // three's skinning: bind^-1 * bone * bind * v; then the instance matrix. The placed pass folds the instance into the bone.
    const bind = new Matrix4().makeRotationY(0.4).setPosition(0.1, -0.2, 0.05);
    const bindInverse = bind.clone().invert();
    const bone = new Matrix4().makeRotationX(0.7).setPosition(0.3, 1.1, -0.4);
    const drawn = new Matrix4().makeRotationY(2.1).scale(new Vector3(1.07, 1.07, 1.07)).setPosition(812.5, 3.25, -4410.75);
    const v = new Vector3(0.12, 1.4, -0.03);
    const before = v.clone().applyMatrix4(bind).applyMatrix4(bone).applyMatrix4(bindInverse).applyMatrix4(drawn);
    const placed = new Matrix4().multiplyMatrices(bind, drawn).multiply(bindInverse).multiply(bone);
    const after = v.clone().applyMatrix4(bind).applyMatrix4(placed).applyMatrix4(bindInverse);
    expect(after.distanceTo(before)).toBeLessThan(1e-6);
  });

  it('draws every pass into one pair of targets, each pass a band of rows from its base, the blends then the refits', () => {
    const clip = { data: new Float32Array(3 * 2 * 12), frames: 1, duration: 1, stride: 1, pelvisY: 0, pelvisX: 0, pelvisZ: 0, loop: true } as ClipFrames;
    const anim = (bones: number): ReturnType<typeof buildClassAnimation> =>
      buildClassAnimation({ walk: { ...clip, data: new Float32Array(3 * bones * 12) } }, bones);
    const joints = new DataTexture(new Float32Array(16), 2, 2, RGBAFormat, FloatType);
    const small = createPalettePass(anim(2), Int16Array.from([-1, 0]), () => joints, 8);
    const wide = createPalettePass(anim(3), Int16Array.from([-1, 0, 1]), () => joints, 8, true);
    const bound: { target: unknown; y: number; height: number; width: number }[] = [];
    let current: { viewport: { y: number; z: number; w: number } } | null = null;
    const renderer = {
      autoClear: true, getRenderTarget: () => null,
      setRenderTarget: (t: { viewport: { y: number; z: number; w: number } } | null) => { current = t; },
      render: () => { bound.push({ target: current, y: current!.viewport.y, width: current!.viewport.z, height: current!.viewport.w }); },
    } as unknown as WebGLRenderer;
    const targets = createPaletteTargets();
    const bases: number[] = [];
    renderPalettes(renderer, targets, [{ pass: small, rows: 3 }, { pass: wide, rows: 5 }], bases);
    expect(bases).toEqual([0, 3]);
    // Two targets in all: both passes' blends into the first, then both refits into the second.
    expect(new Set(bound.map((b) => b.target)).size).toBe(2);
    expect(bound[0]!.target).toBe(bound[1]!.target);
    expect(bound[2]!.target).toBe(bound[3]!.target);
    expect(bound.map((b) => [b.y, b.height, b.width])).toEqual([[0, 3, 8], [3, 5, 12], [0, 3, 8], [3, 5, 12]]);
    // Room for every row, as wide as the widest palette.
    expect(targets.texture.image.height).toBeGreaterThanOrEqual(8);
    expect(targets.texture.image.width).toBe(12);
    // The refit reads its blends and plays from its own base.
    expect(REFIT_FRAGMENT).toContain('int person = at.y - uBase;');
    expect(BLEND_FRAGMENT).toContain('int person = at.y - uBase;');
  });
});
