import { describe, expect, it } from 'vitest';
import { type ShaderMaterial, Vector2 } from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { shareBloomBlur } from '@render/postprocess';

/** THE BLOOM'S BLUR, ONE PROGRAM FOR ALL ITS RADII (`postprocess.ts` shareBloomBlur) */

describe('the bloom blur', () => {
  it('has one program key for its five radii, and sums the same taps, in the same order, as three\'s own', () => {
    const own = new UnrealBloomPass(new Vector2(64, 64), 1, 0.3, 0.8);
    const shared = new UnrealBloomPass(new Vector2(64, 64), 1, 0.3, 0.8);
    const before = own.separableBlurMaterials as ShaderMaterial[];
    const after = shared.separableBlurMaterials as ShaderMaterial[];
    // Five programs before: a define each.
    expect(new Set(before.map((m) => `${JSON.stringify(m.defines)}|${m.fragmentShader}`)).size).toBe(5);
    shareBloomBlur(after);
    expect(new Set(after.map((m) => `${JSON.stringify(m.defines)}|${m.fragmentShader}|${m.vertexShader}`)).size).toBe(1);
    // A blur's sum as the loop runs it: the same taps and weights as three's, stopped at its own pairs.
    const run = (m: ShaderMaterial, sample: (offset: number) => number): number => {
      const pairs = (m.uniforms['uPairs']?.value as number | undefined) ?? Number(m.defines['KERNEL_PAIRS']);
      const offsets = m.uniforms['gaussianOffsets']!.value as number[], weights = m.uniforms['gaussianWeights']!.value as number[];
      let sum = sample(0) * (m.uniforms['centerWeight']!.value as number);
      for (let i = 0; i < Number(m.defines['KERNEL_PAIRS']); i++) {
        if (i >= pairs) break;
        sum += (sample(offsets[i]!) + sample(-offsets[i]!)) * weights[i]!;
      }
      return sum;
    };
    const signal = (x: number): number => Math.sin(x * 1.7) * 3 + Math.cos(x * 0.3);
    for (let k = 0; k < 5; k++) expect(run(after[k]!, signal)).toBe(run(before[k]!, signal));
    own.dispose();
    shared.dispose();
  });
});
