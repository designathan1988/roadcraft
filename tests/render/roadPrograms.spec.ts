import { describe, expect, it, vi } from 'vitest';
import { type Material, ShaderLib, Texture, UniformsUtils, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import { createMaterials } from '@render/materials';
import { type WearField, applyWear } from '@render/wear';

/** The baked textures as plain ones (not in Node): a texture is a uniform, nothing of the source nor the key. */
vi.mock('@render/surfaceTextures', async (actual) => ({
  ...(await actual<typeof import('@render/surfaceTextures')>()),
  surfaceTexture: () => new Texture(),
  requireSurfaceMaps: () => ({ map: new Texture(), normalMap: new Texture(), roughnessMap: new Texture() }),
}));

/** THE ROADS' SURFACES THAT DRAW FROM THE SAME SOURCE SHARE ONE PROGRAM (r186 `WebGLPrograms.getProgramCacheKey`: the material's kind, its parameters and `customProgramCacheKey`; each material still runs its own `onBeforeCompile` and keeps its own uniforms, `WebGLRenderer.getProgram`) */

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

describe("the roads' programs", () => {
  const m = createMaterials(1);
  // The wear the renderer puts on the carriageway and the footway (`renderer.ts`): their sources then differ from the raised asphalt's.
  const wear = { texture: new Texture(), window: { value: null } } as unknown as WearField;
  applyWear(m.asphalt, wear, 0, 'asphalt');
  applyWear(m.footway, wear, 1, 'footway');
  const roads = { asphalt: m.asphalt, asphaltRaised: m.asphaltRaised, footway: m.footway, kerb: m.kerb, verge: m.verge, deck: m.deck, parapet: m.parapet };

  it('key a surface by what its source is, never by its name: one program for the kerb, the verge and the deck', () => {
    const key = (x: Material): string => x.customProgramCacheKey();
    // The kerb, the verge and the deck: the same detail and lot patches, their textures and numbers as uniforms.
    const kerb = compiled(m.kerb);
    for (const other of [m.verge, m.deck]) {
      const out = compiled(other);
      expect(out.vertex).toBe(kerb.vertex);
      expect(out.fragment).toBe(kerb.fragment);
      expect(key(other)).toBe(key(m.kerb));
      // Each its own detail map and repeat.
      expect(out.uniforms['uDetailMap']).toBeDefined();
    }
    expect(compiled(m.verge).uniforms['uMacroTile']!.value).not.toBe(kerb.uniforms['uMacroTile']!.value);
    // A source that differs keeps its own key: the carriageway's wear and edges, the footway's, the parapet without the lots.
    const distinct = new Set(Object.values(roads).map(key));
    expect(distinct.size).toBe(5);
    // And the same key never stands for two sources.
    const byKey = new Map<string, string>();
    for (const material of Object.values(roads)) {
      const out = compiled(material);
      const source = out.vertex + out.fragment;
      const known = byKey.get(key(material));
      if (known !== undefined) expect(source).toBe(known); else byKey.set(key(material), source);
    }
  });
});
