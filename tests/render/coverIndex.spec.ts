import { describe, expect, it } from 'vitest';

import { pointInPolygon } from '@core/polygon';
import { coverPolygons, createCoverIndex } from '@render/buildings/layerCells';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { BuildingStore } from '@world/buildings/store';
import { type Building, asBuildingId } from '@world/buildings/types';
import { ChangeJournal } from '@world/changes';
import { m } from '@world/units';

/** The plant cull's index of where the buildings stand, derived cell by cell from the document and dropped where its diary says */
function building(id: number, x: number, y: number, rotation = 0): Building {
  const bp = BLUEPRINTS[id % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), id: asBuildingId(id), x, y, rotation } as Building;
}

/** Whether some building of the store covers (x, y), asked of every one: what the index must answer. */
const coveredByAny = (store: BuildingStore, x: number, y: number): boolean => {
  for (const b of store.all()) for (const poly of coverPolygons(b)) if (pointInPolygon({ x, y }, poly)) return true;
  return false;
};

describe('the cover index, cell by cell', () => {
  it('answers as every building asked, through edits', () => {
    let seed = 3;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const changes = new ChangeJournal();
    const buildings = new BuildingStore(changes);
    const live = createCoverIndex();
    // Across several of the world's cells (256 m), so buildings straddle their edges.
    const span = m(520);
    let covered = 0;
    for (let step = 0; step < 120; step++) {
      const id = 1 + Math.floor(rand() * 20);
      if (buildings.has(asBuildingId(id)) && rand() < 0.3) buildings.remove(asBuildingId(id));
      else buildings.restore(asBuildingId(id), building(id, rand() * span, rand() * span, rand() * Math.PI));
      if (step % 10 !== 9) continue;
      live.follow({ buildings, changes });
      for (let i = 0; i < 400; i++) {
        const x = rand() * span * 1.2 - span * 0.1, y = rand() * span * 1.2 - span * 0.1;
        const want = coveredByAny(buildings, x, y);
        expect(live.covers(x, y)).toBe(want);
        if (want) covered++;
      }
    }
    expect(covered).toBeGreaterThan(30);
  });

  it('drops only the cells an edit reached, and moves its version with them', () => {
    const changes = new ChangeJournal();
    const buildings = new BuildingStore(changes);
    for (let i = 0; i < 40; i++) buildings.restore(asBuildingId(i + 1), building(i + 1, (i % 8) * m(300), Math.floor(i / 8) * m(300)));
    const index = createCoverIndex();
    index.follow({ buildings, changes });
    // Every cell asked once.
    for (let x = 0; x < m(2400); x += m(64)) for (let y = 0; y < m(1500); y += m(64)) index.covers(x, y);
    const held = index.cells.size;
    const v = index.version;
    const before = index.cells.work.invalidated;
    buildings.restore(asBuildingId(5), building(5, m(1210), m(20)));
    index.follow({ buildings, changes });
    const dropped = index.cells.work.invalidated - before;
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(9);
    expect(index.cells.size).toBe(held - dropped);
    expect(index.version).toBe(v + 1);
    expect(index.covers(m(1215), m(25))).toBe(coveredByAny(buildings, m(1215), m(25)));
  });
});
