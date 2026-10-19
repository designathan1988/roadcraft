import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Matrix4, MeshStandardMaterial, ShaderLib, Texture, type Material, type Mesh } from 'three';
import { createAgentMeshes } from '@render/agents';
import { skinMaterial } from '@render/riggedCitizens';
import { personShaderText } from '@render/people/proceduralCrowd';
import { PERSON_SHADOW_VARIANTS, PERSON_VARIANTS, personDepthKey, personProgramKey, type Kind, type Variant } from '@render/people/personVariants';
import { programKeys } from './programKeys';

/** The shader programs the people's and vehicles' meshes ask three for: one per shader, never two keys for the same text nor one key for two texts */

/** Every piece a procedural person could be drawn with, levels 0 to 3, each kind's own flags. */
function everyVariant(): Variant[] {
  const out: Variant[] = [];
  for (const kind of ['skin', 'face', 'hair', 'cloth'] as Kind[]) {
    for (let level = 0; level < 4; level++) {
      for (const widen of kind === 'hair' ? [false, true] : [false]) for (const grown of kind === 'hair' ? [false, true] : [false]) {
        for (const lash of kind === 'face' ? [false, true] : [false]) out.push({ kind, level, widen, grown, lash });
      }
    }
  }
  return out;
}

/** Variants by key: each key's shader texts, which must be one. */
function textsByKey(variants: readonly Variant[], key: (v: Variant) => string, text: (v: Variant) => string): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>();
  for (const v of variants) {
    const k = key(v);
    let set = by.get(k);
    if (!set) by.set(k, set = new Set());
    set.add(text(v));
  }
  return by;
}

describe('the programs of the agents', () => {
  beforeAll(() => { vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {} }); vi.stubGlobal('location', { search: '?bodies=cooked' }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it("vehicles: the meshes of every body and part ask 10 programs of three (the 10th the body joined with its roof, `vehiclePanels.ts`)", () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    expect(programKeys(agents.meshes).size).toBe(10);
    agents.dispose();
  });

  it('vehicles: a body joined with its roof is drawn where the shells were, before the lamps and the trim (three sorts the opaque by material id)', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const meshes = agents.meshes.filter((o): o is Mesh => (o as Mesh).isMesh === true);
    const id = (pattern: RegExp): number => (meshes.find((o) => pattern.test(o.name))!.material as Material).id;
    expect(id(/^car-sedan-sedan-body$/)).toBe(id(/^car-sedan-sedan-shell$/) + 1);
    expect(id(/^vehicle-lamps$/)).toBeGreaterThan(id(/^car-sedan-sedan-body$/));
    expect(id(/^car-sedan-sedan-trim$/)).toBeGreaterThan(id(/^car-sedan-sedan-body$/));
    agents.dispose();
  });

  it('procedural people: one program for each shader a level gives (23 lit, 6 cast; were 28 and 8, hair and cloth compiled again at L3, cast hair and cloth apart)', () => {
    expect(PERSON_VARIANTS.length).toBe(23);
    expect(PERSON_SHADOW_VARIANTS.length).toBe(6);
    const all = everyVariant();
    // One key, one text; and two keys, two texts (no program kept apart for nothing).
    const lit = textsByKey(all, personProgramKey, (v) => personShaderText(v));
    for (const [key, texts] of lit) expect(texts.size, key).toBe(1);
    expect(new Set([...lit.values()].map((t) => [...t][0])).size).toBe(lit.size);
    const cast = textsByKey(all.filter((v) => v.level < 3), (v) => personDepthKey({ ...v, level: v.level + 1 }), (v) => personShaderText(v, true));
    for (const [key, texts] of cast) expect(texts.size, key).toBe(1);
    expect(new Set([...cast.values()].map((t) => [...t][0])).size).toBe(cast.size);
  });

  it("cooked people: every child's shirt colour one program, the colour a uniform", () => {
    const mesh = { bindMatrix: new Matrix4(), bindMatrixInverse: new Matrix4() } as never;
    const shaded = (look: number): { key: string; text: string; shirt: unknown } => {
      const material = new MeshStandardMaterial();
      skinMaterial(material, { value: new Texture() }, mesh, look);
      const shader = { vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader, uniforms: {} as Record<string, { value: unknown }> };
      material.onBeforeCompile(shader as never, null as never);
      return { key: material.customProgramCacheKey(), text: shader.vertexShader + shader.fragmentShader, shirt: shader.uniforms['citizenShirt']?.value };
    };
    const shirts = [1, 2, 3].map(shaded);
    expect(new Set(shirts.map((s) => s.key)).size).toBe(1);
    expect(new Set(shirts.map((s) => s.text)).size).toBe(1);
    expect(new Set(shirts.map((s) => JSON.stringify(s.shirt))).size).toBe(3);
    expect(shaded(0).key).not.toBe(shirts[0]!.key);
  });
});
