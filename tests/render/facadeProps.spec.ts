import { describe, expect, it } from 'vitest';
import { facadeProps } from '@render/buildings/facadeProps';
import { m } from '@world/units';
import type { BayComponent, BuildingUse } from '@world/buildings/types';

/**
 * THE LIFE ON THE BALCONIES IS SPARSE AND VARIED (the player, 2026-10-13: a
 * tower with every balcony full of palms, chairs and tables - "tenha
 * noção"). Over many flats: some 45 % of balconies bare, a pot on one in five
 * at most, no condenser on a balcony's floor (they hang under the windows),
 * an office's balconies all but bare, and no two neighbouring flats alike in
 * a run of storeys.
 */
const opening = { a0: m(0.65), a1: m(2.35), h0: m(0.02), h1: m(2.3), depth: m(0.2) };

function survey(component: BayComponent, use: BuildingUse, old = 0.1): { bare: number; potted: number; kinds: Set<string>; arrangements: string[] } {
  let bare = 0, potted = 0;
  const kinds = new Set<string>();
  const arrangements: string[] = [];
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const hash = Math.imul(i + 1, 2_654_435_761) >>> 0;
    const props = facadeProps(component, 1 + (i % 20), use, old, hash, m(3), opening);
    if (props.length === 0) bare++;
    if (props.some((p) => p.kind === 'pot')) potted++;
    for (const p of props) kinds.add(p.kind);
    arrangements.push(props.map((p) => p.kind).sort().join(','));
  }
  return { bare: bare / N, potted: potted / N, kinds, arrangements };
}

describe('facade props', () => {
  it('leaves most balconies bare or nearly, with few plants', () => {
    for (const [component, use] of [['balcony', 'residential'], ['gourmet', 'residential'], ['balcony', 'mixed']] as const) {
      const s = survey(component, use);
      expect(s.bare, `${component} ${use}: bare`).toBeGreaterThan(0.4);
      expect(s.potted, `${component} ${use}: potted`).toBeLessThanOrEqual(0.2);
      expect(s.kinds.has('acUnit'), `${component} ${use}: a condenser on a balcony floor`).toBe(false);
    }
  });

  it('gives an office balcony next to nothing', () => {
    expect(survey('balcony', 'commercial').bare).toBeGreaterThan(0.9);
  });

  it('draws a churrasqueira only on a varanda gourmet, and the washing mostly on plain blocks', () => {
    expect(survey('gourmet', 'residential').kinds.has('grill')).toBe(true);
    expect(survey('balcony', 'residential').kinds.has('grill')).toBe(false);
    const airers = (s: ReturnType<typeof survey>): number => s.arrangements.filter((a) => a.includes('airer')).length;
    expect(airers(survey('balcony', 'residential', 0.6))).toBeGreaterThan(airers(survey('gourmet', 'residential')));
  });

  it('never repeats one arrangement up a column of flats', () => {
    // Twenty storeys of one column: the same furnished arrangement at most a few times.
    const column: string[] = [];
    for (let level = 1; level <= 20; level++) {
      const hash = (Math.imul(level + 7, 0x165667b1) ^ 0x27d4eb2d) >>> 0;
      column.push(facadeProps('balcony', level, 'residential', 0.1, hash, m(3), opening).map((p) => p.kind).sort().join(','));
    }
    const furnished = column.filter((a) => a !== '');
    const most = Math.max(0, ...[...new Set(furnished)].map((a) => furnished.filter((b) => b === a).length));
    expect(most).toBeLessThanOrEqual(4);
  });
});
