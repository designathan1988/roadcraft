import { describe, expect, it } from 'vitest';
import { askPlate, padsOfAsk } from '@render/groundShape';
import { GroundShare, sharedGroundReaders } from '@render/sharedGround';
import { plateOf } from '@world/bounds';
import { cityBuilding } from '@world/buildings/cityBuildings';
import { instantiate } from '@world/buildings/blueprints';
import { floorHeight } from '@world/buildings/foundation';
import { padOf } from '@world/buildings/pads';
import { refOf } from '@world/buildings/recordTable';
import { type Building, asBuildingId } from '@world/buildings/types';

describe('a plate asked of the ground worker', () => {
  it('takes an empty box (Infinity bounds) or a NaN region as no corners', () => {
    const n = 5;
    const grid = { n, x: (i: number) => i % n, y: (i: number) => Math.floor(i / n) } as never;
    const natural = new Float64Array(n * n);
    const ask = askPlate(grid, natural, [[Infinity, -Infinity, Infinity, -Infinity], [NaN, 2, 0, 1], [1, 2, 1, 2]]);
    expect(ask.natural.length).toBe(4);
    expect(ask.xy.length).toBe(8);
  });
});

describe('the platforms worked out by the ground worker', () => {
  it('are the page\'s for the same buildings: their records read from a table, their floors as kept, the ground shared', () => {
    const n = 33, cell = 6.4, half = ((n - 1) * cell) / 2;
    const share = new GroundShare(n, cell, half, 0);
    // A hillside on the plate at the origin, falling one in eight towards +x, a little across.
    const plate = share.open(plateOf(0, 0))!;
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
      const x = ix * cell - half, y = half - iy * cell;
      plate.natural[iy * n + ix] = plate.rendered[iy * n + ix] = -x / 8 + y / 20;
    }
    const ground = share.current!;
    const naturalAt = sharedGroundReaders(ground).naturalAt;
    const buildings = (['supermarket', 'apartments'] as const).map((name, k) => {
      const model = cityBuilding(name)!;
      return { ...instantiate(model.body, { x: k * 60 - 40, y: k * 20 - 10 }, k * 0.4, model.fn), id: asBuildingId(k + 1) } as Building;
    });
    // No road at grade: the paving the page reads is none at every point.
    const paving = { rect: [-half, -half, half, half] as const, field: null, flush: null };
    const pavedAt = (): number => NaN;
    const apron = cell * 1.5;
    const floors = buildings.map((b) => floorHeight(b, naturalAt, pavedAt));
    const worker = padsOfAsk({ buildings: buildings.map((b, k) => ({ record: refOf(b), floor: floors[k]! })), paving, ground, apron });
    const page = buildings.map((b, k) => padOf(b, naturalAt, pavedAt, apron, () => floors[k]!));
    expect(page.every((p) => p !== null)).toBe(true);
    // Through the message, as the worker hands them over.
    expect(structuredClone(worker)).toEqual(page);
  });
});
