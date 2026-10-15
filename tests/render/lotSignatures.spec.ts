import { describe, expect, it } from 'vitest';

import { drawsSignature } from '@render/buildings/signature';
import type { Building } from '@world/buildings/types';
import { LOT_NAMES } from '@world/buildings/lotLibrary';

/** Every lot of the builder's catalogue has a body the town and the builder's pictures draw. */
describe('lot signatures', () => {
  it('draw every lot of the catalogue', () => {
    const undrawn = LOT_NAMES.filter((name) => !drawsSignature({ blueprint: `signature:${name}` } as Building));
    expect(undrawn).toEqual([]);
  });
});
