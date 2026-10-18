import { describe, expect, it } from 'vitest';
import { type Material, ShaderLib, UniformsUtils, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import { createBuildingKit } from '@render/buildings/kit';
import { THIN_PROPS } from '@render/buildings/facadeProps';

/** MATERIALS WHOSE SOURCE IS THE SAME SHARE ONE PROGRAM (r186 `WebGLRenderer.getProgram`: a program by its key, each material its own uniforms): the thin parts and the two panes */

/** A material's source and uniforms as three hands them to its patches, then as they come out. */
function compiled(material: Material): { vertex: string; fragment: string; uniforms: Record<string, { value: unknown }> } {
  const shader = {
    vertexShader: ShaderLib.standard.vertexShader,
    fragmentShader: ShaderLib.standard.fragmentShader,
    uniforms: UniformsUtils.clone(ShaderLib.standard.uniforms),
  } as unknown as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as WebGLRenderer);
  return { vertex: shader.vertexShader, fragment: shader.fragmentShader, uniforms: shader.uniforms as Record<string, { value: unknown }> };
}

describe("the buildings' programs", () => {
  const kit = createBuildingKit();

  it('make the thin parts one source and one key, each its bar and the tone behind as uniforms, the numbers the source once spelled', () => {
    const thin: [string, number, number][] = [['frame', 0.05, 0.08], ['railing', 0.02, 0.16], ['roofRailing', 0.02, 0.16], ...THIN_PROPS.map(([k, bar, behind]) => [k, bar, behind] as [string, number, number])];
    const first = compiled(kit.material[thin[0]![0] as 'frame']);
    for (const [kind, bar, behind] of thin) {
      const material = kit.material[kind as 'frame'];
      const out = compiled(material);
      expect(out.vertex, kind).toBe(first.vertex);
      expect(out.fragment, kind).toBe(first.fragment);
      expect(material.customProgramCacheKey(), kind).toBe(kit.material.frame.customProgramCacheKey());
      expect(out.uniforms['thinBar']!.value, kind).toBe(Number(bar.toFixed(3)));
      expect(out.uniforms['thinBehind']!.value, kind).toBe(Number(behind.toFixed(3)));
    }
    // Nothing of a kind's own written in the source.
    expect(first.fragment).toContain('thinBar / metresPerPixel');
  });

  it('make the clear and the dark panes one source and one key', () => {
    const clear = compiled(kit.material.glass), dark = compiled(kit.material.glassDark);
    expect(dark.vertex).toBe(clear.vertex);
    expect(dark.fragment).toBe(clear.fragment);
    expect(kit.material.glassDark.customProgramCacheKey()).toBe(kit.material.glass.customProgramCacheKey());
  });
});
