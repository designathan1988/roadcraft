import { describe, expect, it } from 'vitest';
import { m } from '@world/units';
import { planRoofPlant, type RoofSite } from '@world/buildings/roofPlant';
import type { BuildingUse } from '@world/buildings/types';

/**
 * Roof plant (docs/PLANO.md 5f; the player, 2026-10-09: "placas solares e
 * caixa d'água azul em TODOS"): every flat roof carried one set of plant
 * whatever the building. Now a catalogue by use, size and age, seeded per
 * building and packed so no two pieces cross.
 */
const site = (building: number, use: BuildingUse, storeys: number, w: number, d: number, age: number): RoofSite =>
  ({ building, volume: 1, use, storeys, x0: 0, y0: 0, x1: m(w), y1: m(d), age, hasCore: false });

describe('roof plant', () => {
  it('packs every piece inside the parapet with a clear way, none crossing another', () => {
    let pieces = 0;
    for (let k = 0; k < 400; k++) {
      const use = (['residential', 'commercial', 'industrial'] as const)[k % 3]!;
      const s = site(k + 1, use, 1 + (k % 14), 8 + (k % 23), 8 + ((k * 7) % 19), (k % 10) / 10);
      const items = planRoofPlant(s);
      pieces += items.length;
      for (const it of items) {
        expect(it.x0).toBeGreaterThanOrEqual(m(0.8) - 1e-6);
        expect(it.y0).toBeGreaterThanOrEqual(m(0.8) - 1e-6);
        expect(it.x1).toBeLessThanOrEqual(s.x1 - m(0.8) + 1e-6);
        expect(it.y1).toBeLessThanOrEqual(s.y1 - m(0.8) + 1e-6);
      }
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!, b = items[j]!;
        const gap = Math.max(a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1);
        expect(gap, `${a.kind} and ${b.kind} on roof ${k}`).toBeGreaterThanOrEqual(m(0.5) - 1e-6);
      }
    }
    expect(pieces).toBeGreaterThan(400);
  });

  it('gives roofs of one size different plant by building, and plant by use and age', () => {
    const kits = new Map<string, number>();
    let tankAndSolar = 0;
    const N = 300;
    for (let k = 0; k < N; k++) {
      const items = planRoofPlant(site(1000 + k, 'residential', 4, 16, 12, (k % 10) / 10));
      const kinds = items.map((i) => `${i.kind}${i.kind === 'tank' ? i.variant : ''}`).sort().join(',');
      kits.set(kinds, (kits.get(kinds) ?? 0) + 1);
      if (items.some((i) => i.kind === 'tank') && items.some((i) => i.kind === 'solar')) tankAndSolar++;
    }
    // The old renderer drew one kit on every such roof: one kit, 100%.
    expect(kits.size).toBeGreaterThan(40);
    expect(Math.max(...kits.values()) / N).toBeLessThan(0.1);
    expect(tankAndSolar / N).toBeLessThan(0.4);
    // A works hall: vents and skylights; old buildings: masts more than solar panels.
    const count = (use: BuildingUse, age: number, kind: string): number => {
      let n = 0;
      for (let k = 0; k < 200; k++) n += planRoofPlant(site(5000 + k, use, 1, 24, 30, age)).filter((i) => i.kind === kind).length;
      return n;
    };
    expect(count('industrial', 0.5, 'vent')).toBeGreaterThan(count('residential', 0.5, 'vent') * 3);
    expect(count('residential', 1, 'mast')).toBeGreaterThan(count('residential', 0, 'mast'));
    expect(count('residential', 0, 'solar')).toBeGreaterThan(count('residential', 1, 'solar'));
  });
});
