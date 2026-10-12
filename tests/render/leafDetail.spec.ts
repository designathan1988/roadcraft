import { describe, expect, it } from 'vitest';

import { lowPolyTreeParts, type LowPolyKind } from '../../src/render/lowPolyTrees';

/**
 * THE LEAVES' DETAIL CLOSE UP (`render/lowPolyTrees.ts`, PL31): a card reads
 * the atlas' first third (the far clump) and the shader moves it, near the
 * eye, to the second (the near clump: more, smaller leaves); the palm's
 * fronds read the last third. If a card's uv left the first third the near
 * clump would be read from the wrong place - and the triangles stay the
 * light tree's (`groundCover.spec.ts`).
 */
const uvOf = (kind: LowPolyKind): Float32Array => {
  const { cards } = lowPolyTreeParts(kind, 0x7ee5);
  if (!cards) throw new Error(`${kind} has no cards`);
  return cards.getAttribute('uv').array as Float32Array;
};

describe('the leaves\' detail close up', () => {
  it('reads the far clump, in the atlas\' first third, on every leafy card', () => {
    for (const kind of ['oak', 'broadleafTall', 'cypress', 'ipeYellow', 'ipePink', 'bush', 'bushFlowering', 'hedge'] as const) {
      const uv = uvOf(kind);
      for (let i = 0; i < uv.length; i += 2) {
        expect(uv[i]).toBeGreaterThanOrEqual(0);
        expect(uv[i]).toBeLessThanOrEqual(1 / 3 + 1e-6);
      }
    }
  });

  it('reads the palm\'s fronds from the last third, which the near clump never touches', () => {
    const uv = uvOf('palm');
    for (let i = 0; i < uv.length; i += 2) expect(uv[i]).toBeGreaterThanOrEqual(2 / 3 - 1e-6);
  });
});
