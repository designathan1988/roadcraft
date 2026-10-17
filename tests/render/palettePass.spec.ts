import { describe, expect, it } from 'vitest';
import { DataTexture, FloatType, RGBAFormat, type Mesh, type Scene, type ShaderMaterial, type WebGLRenderTarget, type WebGLRenderer } from 'three';
import type { ClipFrames } from '@render/citizenBake';
import { buildClassAnimation, createPalettePass } from '@render/people/crowdAnimation';
import { PACKED_BONE_FLOATS } from '@render/citizenPalette';

/** THE PALETTE PASS: a body refit through its parents is blended once a bone, then refit from the blends; a body on its own joints in one pass */

const BONES = 4;
const clip = { data: new Float32Array(3 * BONES * PACKED_BONE_FLOATS), frames: 1, duration: 1, stride: 1, pelvisY: 1, pelvisX: 0, pelvisZ: 0, loop: true } as ClipFrames;
const joints = new DataTexture(new Float32Array(BONES * 4), BONES, 1, RGBAFormat, FloatType);

/** The targets the pass draws into, in order, and the program each draw ran. */
function drawsOf(parent: Int16Array): { targets: (WebGLRenderTarget | null)[]; shaders: ShaderMaterial[]; texture: unknown } {
  const pass = createPalettePass(buildClassAnimation({ walk: clip }, BONES), parent, () => joints, 4);
  const targets: (WebGLRenderTarget | null)[] = [];
  const shaders: ShaderMaterial[] = [];
  let target: WebGLRenderTarget | null = null;
  const renderer = {
    autoClear: true,
    getRenderTarget: () => target,
    setRenderTarget: (t: WebGLRenderTarget | null) => { target = t; },
    render: (scene: Scene) => { targets.push(target); shaders.push((scene.children[0] as Mesh).material as ShaderMaterial); },
  } as unknown as WebGLRenderer;
  pass.setPlays(0, [{ row: 0, t: 0, weight: 1 }], 0);
  pass.render(renderer, 1);
  const texture = pass.texture;
  pass.dispose();
  return { targets, shaders, texture };
}

describe('the palette pass', () => {
  it('blends a body on its own joints in one draw', () => {
    const { targets, texture } = drawsOf(new Int16Array(BONES).fill(-1));
    expect(targets).toHaveLength(1);
    expect(targets[0]!.texture).toBe(texture);
  });

  it('blends each bone of a body refit through its parents once, then refits reading the blends', () => {
    const { targets, shaders, texture } = drawsOf(Int16Array.from([-1, 0, 1, 2]));
    expect(targets).toHaveLength(2);
    // The blends first, into a target of their own; the refit reads them and writes the palettes the skinning reads.
    expect(targets[0]).not.toBe(targets[1]);
    expect(targets[1]!.texture).toBe(texture);
    expect(shaders[1]!.uniforms['uBlend']!.value).toBe(targets[0]!.texture);
    // Only the blending draw runs the atlas loop; the refit reads three texels a parent.
    expect(shaders[0]!.fragmentShader).toContain('blended(person, bone)[column]');
    expect(shaders[1]!.fragmentShader).toContain('turnOf(person, p)');
    expect(shaders[1]!.fragmentShader).not.toContain('mat3(blended(person, p))');
  });
});
