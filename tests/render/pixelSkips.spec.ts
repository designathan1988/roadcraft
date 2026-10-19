import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Work a pixel skips where its result weighs nothing; the picture is the same (what was skipped was multiplied by 0). */
describe('the shaders skip what weighs nothing', () => {
  it("roads: the wear's noise only over each term's threshold (VIA-09)", () => {
    const src = readFileSync('src/render/wear.ts', 'utf8');
    expect(src).toMatch(/if \(wear > 0\.55\) \{\s*float holes = smoothstep\(0\.55,/);
    expect(src).toMatch(/if \(wear > 0\.3\) \{\s*float cracks = smoothstep\(0\.3,/);
    expect(src).toMatch(/if \(wear > 0\.0\) \{\s*float stain = smoothstep\(0\.0,/);
  });
  it('roads: the close-up detail read only where it weighs, with the derivatives taken outside the branch (VIA-05)', () => {
    const src = readFileSync('src/render/mesh/detailLayer.ts', 'utf8');
    expect(src).toMatch(/vec2 detailDx = dFdx\(detailUv\), detailDy = dFdy\(detailUv\);\s*if \(detailW > 0\.0\) \{/);
    expect(src).not.toMatch(/texture2D\(tex,/);
    expect(src).toMatch(/textureGrad\(tex, uv, dx, dy\)/);
  });
  it('terrain: the paint layers read only on a plate painted (TER-02)', () => {
    const src = readFileSync('src/render/terrain.ts', 'utf8');
    expect(src).toMatch(/if \(uHasPaint > 0\.5\) \{\s*pa = texture\(uPaint/);
    expect(src).toMatch(/uHasPaint\.value = 1;/);
  });
});
