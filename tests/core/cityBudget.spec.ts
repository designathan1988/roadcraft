import { describe, expect, it } from 'vitest';
import { cityBudgetTable, memoryGroup, type CityMeasure } from '@core/perfBudget';

/**
 * THE CITY PLAN'S BUDGETS AGAINST THE GAME (`core/perfBudget.ts`
 * `cityBudgetTable`, `__roadcraft.budget`): each scene object counted in the
 * plan's level its name says, the rows furthest over the plan first, and
 * what the plan does not budget or the game cannot measure said so, never
 * passed as within.
 */
const measure = (over: Partial<CityMeasure> = {}): CityMeasure => ({
  view: 'rua',
  triangles: 5_000_000,
  drawCalls: 500,
  gpuMs: 8,
  fps: 60,
  bytesByName: new Map(),
  textureBytes: 0,
  geometryCpuBytes: 0,
  heapBytes: null,
  ...over,
});

describe("the city plan's budgets", () => {
  it('puts each object in its level by name', () => {
    expect(memoryGroup('building-shell-metal')).toBe('L0 cascas');
    expect(memoryGroup('building-massing')).toBe('L1 massas');
    expect(memoryGroup('building-frame')).toBe('L0 peças dos prédios');
    expect(memoryGroup('building-preview-shell-metal')).toBe('outros');
    expect(memoryGroup('curb-ramp')).toBe('vias');
    expect(memoryGroup('utility-wires')).toBe('postes e fios');
    expect(memoryGroup('terrain-ground')).toBe('terreno');
    expect(memoryGroup('garden-bushes-bush')).toBe('vegetação');
    expect(memoryGroup('citizen-mh_59-person')).toBe('pessoas e veículos');
  });

  it('lists the rows furthest over first, by how many times over', () => {
    const rows = cityBudgetTable(measure({
      triangles: 30_000_000, // 3× the street's 10 M
      bytesByName: new Map([['building-shell-metal', 1_800e6], ['building-shell-stone', 0], ['building-massing', 60e6]]), // 6× the shells' 300 MB
    }));
    expect(rows[0]).toMatchObject({ item: 'memória de vídeo: L0 cascas', situação: 'acima', vezes: 6 });
    expect(rows[1]).toMatchObject({ item: 'triângulos desenhados (rua)', situação: 'acima', vezes: 3 });
    expect(rows.find((r) => r.item === 'memória de vídeo: L1 massas')).toMatchObject({ situação: 'ok', medido: '60 MB' });
  });

  it('never passes what the plan does not budget or the game cannot measure', () => {
    const rows = cityBudgetTable(measure({ gpuMs: null, heapBytes: 7_000e6, bytesByName: new Map([['asphalt', 80e6]]) }));
    expect(rows.find((r) => r.item === 'GPU p95 (rua)')?.situação).toBe('não medido');
    expect(rows.find((r) => r.item === 'memória de vídeo: vias')?.situação).toBe('sem orçamento no plano');
    expect(rows.find((r) => r.item.startsWith('heap JS'))?.situação).toBe('aproximado');
    expect(rows.find((r) => r.item.startsWith('memória de vídeo: alvos'))?.situação).toBe('não medido');
  });

  it('holds the fps as a floor, per view', () => {
    expect(cityBudgetTable(measure({ view: 'mapa', fps: 52, triangles: 1e6, drawCalls: 100 })).find((r) => r.item === 'fps (mapa)')?.situação).toBe('ok');
    expect(cityBudgetTable(measure({ view: 'rua', fps: 30 })).find((r) => r.item === 'fps (rua)')).toMatchObject({ situação: 'acima', vezes: 2 });
  });

  it('measures the render targets and shadow maps when they are counted, and says so when they are not', () => {
    const row = (over: Partial<CityMeasure>) => cityBudgetTable(measure(over)).find((r) => r.item === 'memória de vídeo: alvos de render e sombras')!;
    expect(row({}).situação).toBe('não medido');
    const counted = row({ targetBytes: 640e6 });
    expect(counted.situação).toBe('acima');
    expect(counted.medido).toContain('640');
  });
});
