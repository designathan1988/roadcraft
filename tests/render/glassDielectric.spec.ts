import { describe, expect, it } from 'vitest';

import { FINISHES } from '@world/buildings/materials';
import { finishLookTable } from '../../src/render/buildings/finishes';

// Glass is a dielectric (Filament, "Metallic"; three's MeshStandardMaterial)
describe('building glass', () => {
  const glass = FINISHES.indexOf('glass') * 8;

  it('is not metal where no map says which texel is aluminium', () => {
    const unbaked = finishLookTable(false);
    expect(unbaked[glass + 2]).toBe(0);
    expect(unbaked[glass + 4]).toBe(0);
  });

  it('takes its metal from its map once baked', () => {
    const baked = finishLookTable(true);
    expect(baked[glass + 2]).toBe(1);
    expect(baked[glass + 4]).toBe(1);
  });
});
