import { describe, expect, it } from 'vitest';

import { LEVEL_TRIANGLES } from '@render/people/crowdLod';
import { PERSON_SHADOW_VARIANTS, PERSON_VARIANTS, personDepthKey, personProgramKey, type Variant } from '@render/people/personVariants';

/** THE PEOPLE'S PROGRAMS COMPILED AT LOAD (`personVariants.ts`, `proceduralCrowd.ts` personProgramStandIns) */
describe('the procedural people\'s programs', () => {
  const lit = new Set(PERSON_VARIANTS.map(personProgramKey));
  const shadow = new Set(PERSON_SHADOW_VARIANTS.map(personDepthKey));
  const v = (kind: Variant['kind'], level: number, flags: Partial<Pick<Variant, 'widen' | 'grown' | 'lash'>> = {}): Variant =>
    ({ kind, level, widen: false, grown: false, lash: false, ...flags });

  it('are each in the catalogue once', () => {
    expect(lit.size).toBe(PERSON_VARIANTS.length);
    expect(shadow.size).toBe(PERSON_SHADOW_VARIANTS.length);
  });

  it('cover every kind of piece at every level its budget draws, and the far mesh', () => {
    const levels = (role: keyof typeof LEVEL_TRIANGLES): number[] => [0, 1, 2, 3].filter((l) => LEVEL_TRIANGLES[role][l]! > 0);
    for (const level of levels('skin')) expect(lit.has(personProgramKey(v('skin', level)))).toBe(true);
    for (const role of ['outfit', 'garment', 'shoes', 'accessory', 'mouth'] as const) {
      for (const level of levels(role)) expect(lit.has(personProgramKey(v('cloth', level)))).toBe(true);
    }
    for (const level of levels('hair')) {
      for (const widen of [false, true]) for (const grown of [false, true]) {
        expect(lit.has(personProgramKey(v('hair', level, { widen, grown })))).toBe(true);
      }
    }
    for (const level of levels('brows')) expect(lit.has(personProgramKey(v('face', level)))).toBe(true);
    for (const level of levels('lashes')) expect(lit.has(personProgramKey(v('face', level, { lash: true })))).toBe(true);
    expect(lit.has(personProgramKey(v('far', 3)))).toBe(true);
  });

  it('cover the shadow of every piece cast close up, and none of the brows, lashes or far mesh', () => {
    for (const level of [0, 1]) {
      expect(shadow.has(personDepthKey(v('skin', level)))).toBe(true);
      expect(shadow.has(personDepthKey(v('cloth', level)))).toBe(true);
      for (const widen of [false, true]) expect(shadow.has(personDepthKey(v('hair', level, { widen })))).toBe(true);
    }
    expect(PERSON_SHADOW_VARIANTS.some((x) => x.kind === 'face' || x.kind === 'far' || x.level > 1)).toBe(false);
  });
});
