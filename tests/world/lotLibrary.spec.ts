import { describe, expect, it } from 'vitest';

import { LOT_NAMES, loadLot } from '../../src/world/buildings/lotLibrary';
import { TOWER_KINDS, signatureKind } from '../../src/world/buildings/towerKit';

// The lots of the lot lab (2026-10-05), offered in the builder's models.
describe('lot library', () => {
  it('has every tower of the kit, each with its lot', () => {
    expect([...LOT_NAMES].sort()).toEqual([...TOWER_KINDS].sort());
  });

  it('reads each lot, drawn by its own signature', async () => {
    for (const name of LOT_NAMES) {
      const lot = await loadLot(name);
      expect(lot?.name).toBe(name);
      expect(signatureKind(lot!.body)).toBe(name);
      expect(lot!.body.volumes.length).toBeGreaterThan(0);
    }
  });

  it('answers null for a lot it does not have', async () => {
    expect(await loadLot('none')).toBeNull();
  });
});
