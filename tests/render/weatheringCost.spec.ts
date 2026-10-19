import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** PRD-03: the wear's noise worked out only where it shows; the picture is the same (what was skipped was multiplied by 0 or thrown away). */
describe("the wear's noise in the shell's pixels", () => {
  const src = readFileSync('src/render/buildings/finishes.ts', 'utf8');
  it('skips the stains where they weigh nothing (a glassy finish not run down)', () => {
    expect(src).toMatch(/float d = max\(vDecay, shellKind\.z > 0\.5 \? 0\.0 : 0\.3\);[\s\S]{0,200}if \(d > 0\.0\) \{/);
  });
  it('works the rain streaks out on a wall only', () => {
    expect(src).toMatch(/wall \? 0\.28 \* smoothstep\(0\.55, 0\.85, dNoise\(/);
    expect(src).not.toMatch(/float streak = /);
  });
  it('works the peeled paint out on a wall only', () => {
    expect(src).toMatch(/if \(wall\) \{\s*float peel = /);
  });
});
