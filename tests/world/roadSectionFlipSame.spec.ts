import { describe, expect, it } from 'vitest';
import { flipSection, normalizeRoadSection, sameRoadSection, sameRoadSectionIgnoringArrows } from '@world/roadSection';
import { m } from '@world/units';

/** A road stored b -> a is the same road as one stored a -> b once its section is flipped (`flipSection`) */
const base = { laneWidth: m(4), sidewalk: m(4), median: m(2), speedKmh: 40, priority: 3 };

describe('a flipped section compared with the same road', () => {
  it('is the same road when every material is set', () => {
    const section = normalizeRoadSection({
      ...base, materials: { carriageway: 'concrete', footwayLeft: 'stone', footwayRight: 'pavers', median: 'grass' },
    })!;
    // Flipped twice: the very same section, its keys written in another order.
    expect(sameRoadSection(flipSection(flipSection(section)), section)).toBe(true);
  });

  it('is the same road when the other piece was stored the other way round', () => {
    // Piece one, a -> b: pavers on its left. Piece two, stored b -> a: pavers on its right.
    const first = normalizeRoadSection({ ...base, materials: { footwayLeft: 'pavers', median: 'concrete' } })!;
    const second = normalizeRoadSection({ ...base, materials: { footwayRight: 'pavers', median: 'concrete' } })!;
    expect(sameRoadSection(first, flipSection(second))).toBe(true);
    expect(sameRoadSectionIgnoringArrows(first, flipSection(second))).toBe(true);
  });

  it('still tells different materials apart', () => {
    const first = normalizeRoadSection({ ...base, materials: { footwayLeft: 'pavers' } })!;
    const second = normalizeRoadSection({ ...base, materials: { footwayLeft: 'stone' } })!;
    expect(sameRoadSection(first, second)).toBe(false);
    expect(sameRoadSection(first, flipSection(first))).toBe(false);
    expect(sameRoadSection(first, normalizeRoadSection(base))).toBe(false);
  });

  it('takes no materials and an empty set of materials as the same', () => {
    const plain = normalizeRoadSection(base)!;
    expect(sameRoadSection(plain, { ...plain, materials: {} })).toBe(true);
  });
});
