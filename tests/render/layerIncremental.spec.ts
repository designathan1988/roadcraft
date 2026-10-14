import { describe, expect, it } from 'vitest';
import type { Mesh, Object3D } from 'three';

import { beginFrameWork } from '@core/frameWork';
import { createBuildingLayer } from '@render/buildings/layer';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building, BuildingId } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/**
 * The buildings layer takes a change of some buildings by their ids in the
 * diary (`townIndex.ts`, AUDITORIA A1): their cells put together again, the
 * rest of the town as it was. What it draws must be what a layer put together
 * from nothing draws on the same town - the same triangles, the same masses
 * from afar, the same ground under the buildings for the plant cull.
 */
const SPACING = m(70);
const flat = (): number => 0;

function body(index: number, x: number, y: number): Omit<Building, 'id'> {
  const bp = BLUEPRINTS[index % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), x, y, rotation: 0 } as Omit<Building, 'id'>;
}

function settle(layer: ReturnType<typeof createBuildingLayer>, doc: RoadDoc): void {
  for (let frame = 0; frame < 5000; frame++) {
    beginFrameWork();
    layer.update(doc, flat, 'g');
    if (!layer.pending) return;
  }
  throw new Error('the layer never settled');
}

/** What a layer draws: its triangles, and each far cell's mesh by its vertices. */
function drawn(layer: ReturnType<typeof createBuildingLayer>): { triangles: number; far: number[] } {
  const far: number[] = [];
  layer.group.traverse((o: Object3D) => {
    if (o.parent?.name === 'buildings-far' && (o as Mesh).isMesh) far.push((o as Mesh).geometry.getAttribute('position').count);
  });
  return { triangles: layer.triangles, far: far.sort((a, b) => a - b) };
}

describe('the buildings layer, a change at a time', () => {
  it('draws what a layer put together from nothing draws', () => {
    let seed = 11;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const doc = new RoadDoc();
    const side = 6;
    for (let i = 0; i < side * side; i++) doc.buildings.add(body(i, (i % side) * SPACING, Math.floor(i / side) * SPACING));
    const live = createBuildingLayer();
    settle(live, doc);
    let incremental = 0;
    for (let round = 0; round < 12; round++) {
      // A cell emptied whole, and a building taken to a cell where none stood.
      if (round === 4) for (const b of [...doc.buildings.all()]) if (b.x < m(240) && b.y < m(240)) doc.buildings.remove(b.id);
      if (round === 7) doc.buildings.add(body(3, side * SPACING + m(500), m(10)));
      // A few edits between two frames, as a tool or the growth makes them.
      for (let k = 0, n = round === 4 || round === 7 ? 0 : 1 + Math.floor(rand() * 3); k < n; k++) {
        const ids = [...doc.buildings.all()].map((b) => b.id);
        const pick = ids[Math.floor(rand() * ids.length)]! as BuildingId;
        const roll = rand();
        if (roll < 0.3) doc.buildings.add(body(Math.floor(rand() * 100), rand() * side * SPACING, rand() * side * SPACING));
        else if (roll < 0.5) doc.buildings.remove(pick);
        else if (roll < 0.75) {
          // Moved: across a cell's edge or within it.
          const b = doc.buildings.get(pick)!;
          doc.buildings.put({ ...b, x: b.x + (rand() - 0.5) * m(300), y: b.y + (rand() - 0.5) * m(60) });
        } else {
          const b = doc.buildings.get(pick)!;
          doc.buildings.put({ ...b, palette: (b.palette + 1) % 8 });
        }
      }
      // A change overtaking one still being put together: the cells of both are swapped.
      if (round === 9) {
        beginFrameWork();
        live.update(doc, flat, 'g');
        const b = doc.buildings.get([...doc.buildings.all()][0]!.id)!;
        doc.buildings.put({ ...b, x: b.x + m(250) });
      }
      // Taken in by the ids alone: the town is not walked.
      const all = doc.buildings.all.bind(doc.buildings);
      let walked = 0;
      doc.buildings.all = () => { walked++; return all(); };
      const before = live.version;
      settle(live, doc);
      doc.buildings.all = all;
      if (live.version > before && walked === 0) incremental++;
      const fresh = createBuildingLayer();
      settle(fresh, doc);
      expect(drawn(live)).toEqual(drawn(fresh));
      for (let i = 0; i < 300; i++) {
        const x = rand() * side * SPACING, y = rand() * side * SPACING;
        expect(live.covers(x, y)).toBe(fresh.covers(x, y));
      }
      fresh.dispose();
    }
    expect(incremental).toBe(12);
    live.dispose();
  });
});
