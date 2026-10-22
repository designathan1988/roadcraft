import { describe, expect, it, vi } from 'vitest';

import { CellPool } from '@render/buildings/cellPool';
import { createBuildingLayer, playerCause } from '@render/buildings/layer';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building, BuildingId } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/** THE BUILDINGS A PLAYER'S EDIT CHANGED ASKED FIRST, IN WHICHEVER TILE (`layer.ts` editedCells; conf79 40-road-4s: a road's demolition in the next tile stood on the screen behind the queue) */
const flat = (): number => 0;

function body(index: number, x: number, y: number): Omit<Building, 'id'> {
  const bp = BLUEPRINTS[index % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), x, y, rotation: 0 } as Omit<Building, 'id'>;
}

function settle(layer: ReturnType<typeof createBuildingLayer>, doc: RoadDoc): void {
  for (let frame = 0; frame < 5000; frame++) {
    layer.update(doc, flat, 'g');
    if (!layer.pending) return;
  }
  throw new Error('the layer never settled');
}

describe('a cell the player edited', () => {
  it('tells the player\'s causes from the growth\'s', () => {
    expect(playerCause('tool roads')).toBe(true);
    expect(playerCause('tool bulldozer: drag')).toBe(true);
    expect(playerCause('desfazer')).toBe(true);
    expect(playerCause('zone growth')).toBe(false);
    expect(playerCause('jogo')).toBe(false);
  });

  it('asks a demolition\'s cells and levels first, a building grown in its band', () => {
    const doc = new RoadDoc();
    // Two groups 1.5 km apart: the road's tile and the next one's.
    const near: BuildingId[] = [], far: BuildingId[] = [];
    for (let k = 0; k < 4; k++) near.push(doc.buildings.add(body(k, k * m(60), 0)).id);
    for (let k = 0; k < 4; k++) far.push(doc.buildings.add(body(k + 4, m(1500) + k * m(60), 0)).id);
    const layer = createBuildingLayer();
    settle(layer, doc);
    const runs: { kind: string; edited: boolean }[] = [];
    const run = CellPool.prototype.run;
    const spy = vi.spyOn(CellPool.prototype, 'run').mockImplementation(function (this: CellPool, ...args: Parameters<CellPool['run']>) {
      runs.push({ kind: args[0], edited: args[6] ?? false });
      return run.apply(this, args);
    });
    // The road's edit demolishes a building of the next group.
    doc.changes.causeNext('tool roads');
    doc.buildings.remove(far[1]!);
    doc.changes.causeNext('jogo');
    settle(layer, doc);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.edited)).toBe(true);
    // The growth takes one of the first group: its jobs in their own band.
    runs.length = 0;
    doc.changes.causeNext('zone growth');
    doc.buildings.remove(near[2]!);
    doc.changes.causeNext('jogo');
    settle(layer, doc);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.some((r) => r.edited)).toBe(false);
    spy.mockRestore();
  });
});
