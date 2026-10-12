import { describe, expect, it } from 'vitest';

import { createFinishMaterials } from '../../src/render/buildings/finishes';

// Glass is a dielectric (Filament, "Metallic"; three's MeshStandardMaterial):
// 0.6 over a whole curtain wall made its panes a grey mirror. With no canvas
// to bake the metal map on (here), the curtain wall is drawn as its glass.
describe('building glass', () => {
  it('is not metal where no map says which texel is aluminium', () => {
    const glass = createFinishMaterials().glass;
    expect(glass.metalnessMap).toBeNull();
    expect(glass.metalness).toBe(0);
  });
});
