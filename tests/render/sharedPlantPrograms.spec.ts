import { describe, expect, it } from 'vitest';
import { BoxGeometry, type Material, MeshStandardMaterial, ShaderLib, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import { applyWind, windDepthMaterial } from '@render/wind';
import { leafCardMaterials } from '@render/lowPolyTrees';
import { createPlantImpostors } from '@render/plantImpostors';

/** THE PLANTS' PROGRAMS SHARED BY THEIR CODE (`wind.ts`, `lowPolyTrees.ts`, `plantImpostors.ts`): one program key a patch, never one a user (three r186 `WebGLPrograms.acquireProgram` keys the program; each material's `onBeforeCompile` still gives it its own uniforms) */

/** A material's shaders as its patches leave them, from three's own sources for its kind. */
function patched(material: Material): string {
  const lib = material.type === 'MeshDepthMaterial' ? ShaderLib.depth : ShaderLib.standard;
  const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: {} } as unknown as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, null as unknown as WebGLRenderer);
  return `${shader.vertexShader}\n----\n${shader.fragmentShader}`;
}
const keyOf = (material: Material): string => material.customProgramCacheKey();

describe('the plants\' programs', () => {
  it('give every user of the same patch one key, and the same key always the same code', () => {
    const winds = [{ sway: 0.2, flutter: 0.05 }, { sway: 0.08, flutter: 0.02 }, { sway: 0.3, flutter: 0.1 }];
    // Each user's wind: the trunks and crowns, the shrubs, the grass, the flowers (scenery, ground cover, nature's trees).
    const plain = ['tree', 'bush', 'grass', 'flower', 'forest-crown', 'nature-trees-lowpoly'].map((name, k) => {
      const m = new MeshStandardMaterial({ vertexColors: true });
      applyWind(m, winds[k % 3]!, name);
      return m;
    });
    const depths = ['tree', 'bush', 'forest-crown-depth', 'nature-trees-lowpoly-depth'].map((name, k) => windDepthMaterial(winds[k % 3]!, name));
    const cards = ['tree', 'bush', 'forest', 'nature-trees'].map((name, k) => leafCardMaterials(winds[k % 3]!, name));
    const models = [{ body: new BoxGeometry(1, 2, 1), cards: null, cardsCast: false }];
    const sets = [createPlantImpostors(models, winds[0]!, 'nature'), createPlantImpostors(models, winds[1]!, 'scenery')];
    const groups: Material[][] = [plain, depths, cards.map((c) => c.material), cards.map((c) => c.depth), sets.map((s) => s.material), sets.map((s) => s.depth)];
    // 22 keys before (one per user), 6 now: one per patch.
    const keys = new Set(groups.flat().map(keyOf));
    expect(keys.size).toBe(6);
    for (const group of groups) {
      expect(new Set(group.map(keyOf)).size).toBe(1);
      const code = new Set(group.map(patched));
      expect(code.size).toBe(1);
    }
    for (const s of sets) s.dispose();
  });
});
