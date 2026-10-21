import { describe, expect, it } from 'vitest';
import type { Mesh } from 'three';

import { cellMass } from '@render/buildings/cellArrays';
import { createBuildingKit } from '@render/buildings/kit';
import { createMassCells } from '@render/buildings/massCells';
import { BASE_CELL_STRIDE, BaseWriter, emitBase, paint } from '@render/buildings/massBase';
import { baseOf, levelCells } from '@render/buildings/levelKeys';
import { emitMassing } from '@render/buildings/massing';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/** THE BUILDINGS' TOP LEVEL (`massBase.ts`): the prisms of every building of a plate's square, drawn under the cells nothing finer draws */
const CELL = m(256);
const flat = (): number => 0;

function building(index: number, x: number, y: number): Building {
  const bp = BLUEPRINTS[index % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), id: index + 1, x, y, rotation: 0 } as Building;
}

/** Two cells' buildings, three each, and their base. */
function town(): { buildings: Building[]; base: NonNullable<ReturnType<BaseWriter['done']>> } {
  const buildings = [0, 1, 2].flatMap((i) => [building(i, m(10) + i * m(40), m(20)), building(i + 3, CELL + m(10) + i * m(40), m(20))]);
  const writer = new BaseWriter();
  for (const b of buildings) emitBase(writer.cellOf(b), b, 0, flat, false);
  return { buildings, base: writer.done(levelCells(baseOf(0, 0)))! };
}

describe('the base', () => {
  it('lays each cell\'s buildings in a run of its own, its colours in 5-6-5 bits of sRGB', () => {
    const { base } = town();
    expect(base.pieces).toHaveLength(1);
    const cells = base.pieces[0]!.cells;
    expect(cells.length).toBe(2 * BASE_CELL_STRIDE);
    // Cell 0,0 then 1,0, one run after the other.
    expect([cells[0], cells[1], cells[2]]).toEqual([0, 0, 0]);
    expect([cells[4], cells[5], cells[6]]).toEqual([1, 0, cells[3]]);
    expect(cells[3]! > 0 && cells[7]! > 0).toBe(true);
    expect(paint([1, 1, 1])).toBe(0xffff);
    expect(paint([0, 0, 0])).toBe(0);
  });

  it('is drawn under exactly the cells nothing finer draws, and never let go for the budget', () => {
    const kit = createBuildingKit();
    const far = createMassCells(kit, CELL, () => {});
    const { buildings, base } = town();
    far.plan('0,0');
    far.plan('1,0');
    far.planLevel(baseOf(0, 0));
    expect(far.basesWaiting).toBe(1);
    far.landBase(baseOf(0, 0), base);
    expect(far.basesWaiting).toBe(0);
    far.syncBases();
    const mesh = (): Mesh => { let out: Mesh | null = null; far.group.traverse((o) => { if (o.name === 'building-massing-base') out = o as Mesh; }); return out!; };
    // Nothing else drawn yet: the base under both cells, one draw.
    expect(mesh().visible).toBe(true);
    expect(mesh().geometry.groups).toEqual([{ start: 0, count: base.pieces[0]!.index.length, materialIndex: 0 }]);
    expect([...far.census().values()]).toEqual(['base', 'base']);
    // Cell 0,0's own masses come: the base draws 1,0 alone.
    far.land('0,0', cellMass(buildings.filter((b) => b.x < CELL).map((b) => emitMassing(b, flat)!))!);
    far.syncBases();
    const cells = base.pieces[0]!.cells;
    expect(mesh().geometry.groups).toEqual([{ start: cells[6], count: cells[7], materialIndex: 0 }]);
    expect(Object.fromEntries(far.census())).toEqual({ '0,0': 'mass', '1,0': 'base' });
    // Shown in detail: still not under the base.
    far.setDetailed('0,0', true);
    far.syncBases();
    expect(far.census().get('0,0')).toBe('detail');
    // The budget lets go every level out of the view, never the base.
    far.choose(0, 0, m(500), 1000, 0.1, false, Infinity, null);
    expect(far.evictLevels(0)).toBe(0);
    expect(mesh().parent).not.toBeNull();
    far.dispose();
  });
});
