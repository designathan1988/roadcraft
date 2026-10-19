import { MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { applyPartSway, applyStructureSway } from '@render/wind';

/** VEG-14: the structures' sway keys its program by its patch, not by whose material it is: one program for every signal part of the same code. */
describe("a structure's sway", () => {
  it('gives the same program key to every user of one patch, another to the other patch', () => {
    const a = new MeshStandardMaterial(), b = new MeshStandardMaterial(), c = new MeshStandardMaterial();
    applyStructureSway(a, 3, 6, 0.1, 'signal-housing');
    applyStructureSway(b, 2, 5, 0.2, 'signal-lens');
    applyPartSway(c, 6, 0.1, 'signal-frame');
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey());
    expect(c.customProgramCacheKey()).not.toBe(a.customProgramCacheKey());
  });
});
