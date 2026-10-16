import { describe, expect, it } from 'vitest';
import { cityBudgetTable, memoryGroup, type CityMeasure } from '@core/perfBudget';

/** THE CITY PLAN'S BUDGETS AGAINST THE GAME (`core/perfBudget.ts` `cityBudgetTable`, `__roadcraft.budget`) */
const measure = (over: Partial<CityMeasure> = {}): CityMeasure => ({
  view: 'street',
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
    expect(memoryGroup('building-shell')).toBe('L0 shells');
    expect(memoryGroup('building-massing')).toBe('L1 masses');
    expect(memoryGroup('building-frame')).toBe('L0 building parts');
    expect(memoryGroup('building-preview-shell')).toBe('other');
    expect(memoryGroup('curb-ramp')).toBe('roads');
    expect(memoryGroup('utility-wires')).toBe('poles and wires');
    expect(memoryGroup('terrain-ground')).toBe('terrain');
    expect(memoryGroup('garden-bushes-bush')).toBe('vegetation');
    expect(memoryGroup('citizen-mh_59-person')).toBe('people and vehicles');
  });

  it('lists the rows furthest over first, by how many times over', () => {
    const rows = cityBudgetTable(measure({
      triangles: 48_000_000, // 3× the street's 16 M
      bytesByName: new Map([['building-shell', 1_800e6], ['building-massing', 60e6]]), // 6× the shells' 300 MB
    }));
    expect(rows[0]).toMatchObject({ item: 'video memory: L0 shells', status: 'over', times: 6 });
    expect(rows[1]).toMatchObject({ item: 'triangles drawn (street)', status: 'over', times: 3 });
    expect(rows.find((r) => r.item === 'video memory: L1 masses')).toMatchObject({ status: 'ok', measured: '60 MB' });
  });

  it('never passes what the plan does not budget or the game cannot measure', () => {
    const rows = cityBudgetTable(measure({ gpuMs: null, heapBytes: 7_000e6, bytesByName: new Map([['asphalt', 80e6]]) }));
    expect(rows.find((r) => r.item === 'GPU p95 (street)')?.status).toBe('not measured');
    expect(rows.find((r) => r.item === 'video memory: roads')?.status).toBe('no budget in the plan');
    expect(rows.find((r) => r.item.startsWith('JS heap'))?.status).toBe('approximate');
    expect(rows.find((r) => r.item.startsWith('video memory: render targets'))?.status).toBe('not measured');
  });

  it('holds the fps as a floor, per view', () => {
    expect(cityBudgetTable(measure({ view: 'map', fps: 52, triangles: 1e6, drawCalls: 100 })).find((r) => r.item === 'fps (map)')?.status).toBe('ok');
    expect(cityBudgetTable(measure({ view: 'street', fps: 30 })).find((r) => r.item === 'fps (street)')).toMatchObject({ status: 'over', times: 2 });
  });

  it('measures the render targets and shadow maps when they are counted, and says so when they are not', () => {
    const row = (over: Partial<CityMeasure>) => cityBudgetTable(measure(over)).find((r) => r.item === 'video memory: render targets and shadows')!;
    expect(row({}).status).toBe('not measured');
    const counted = row({ targetBytes: 640e6 });
    expect(counted.status).toBe('over');
    expect(counted.measured).toContain('640');
  });
});
