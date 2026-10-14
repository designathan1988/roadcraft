import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { lotCentre, type Lot } from '@world/lots';
import { generateBody } from '@world/buildings/blueprints';
import type { Building, BuildingId } from '@world/buildings/types';
import { Rng } from '@core/rng';
import { m } from '@world/units';

/**
 * The open lots kept by the document (`world/openLots.ts`) answer what the
 * loop over every lot answered (`growOnLot` before it): how many are open,
 * the k-th of them in the list's order, the building grown last, the open
 * ones round a point - after lots grown, refused, their buildings knocked
 * down, the lots changed and the set aside emptied, in any order.
 */
const REACH = m(70);

function brute(doc: RoadDoc, refused: ReadonlySet<number>): { open: Lot[]; last: { x: number; y: number } | null } {
  const standing = (b: number | undefined): boolean => b !== undefined && doc.buildings.has(b as BuildingId);
  const open = doc.lots.filter((l) => l.use && !standing(l.building) && !refused.has(l.id));
  let best: Building | null = null;
  for (const l of doc.lots) {
    if (l.building === undefined) continue;
    const b = doc.buildings.get(l.building as BuildingId);
    if (b && (!best || b.id > best.id)) best = b;
  }
  return { open, last: best ? { x: best.x, y: best.y } : null };
}

describe('open lots', () => {
  it('answer as the loop over every lot, whatever happened in between', () => {
    const rng = new Rng(7);
    const doc = new RoadDoc();
    const square = (x: number, y: number): Lot['corners'] => [{ x, y }, { x: x + m(20), y }, { x: x + m(20), y: y + m(30) }, { x, y: y + m(30) }];
    for (let i = 0; i < 300; i++) {
      const zoned = rng.float() < 0.8;
      doc.lots.push({ id: doc.nextLotId++, corners: square(rng.float() * m(1500), rng.float() * m(1500)), ...(zoned ? { use: 'residential' as const, density: 'low' as const } : {}) });
    }
    doc.lotsChanged(null, 'lotes de teste');
    let refused = new Set<number>();
    const check = (): void => {
      const want = brute(doc, refused);
      const count = doc.openLots.count(refused);
      expect(count).toBe(want.open.length);
      for (let k = 0; k < count; k++) expect(doc.openLots.at(k)).toBe(want.open[k]);
      expect(doc.openLots.lastGrown()).toEqual(want.last);
      const at = { x: rng.float() * m(1500), y: rng.float() * m(1500) };
      const near = want.open.filter((l) => Math.hypot(lotCentre(l).x - at.x, lotCentre(l).y - at.y) < REACH);
      const got = doc.openLots.near(at, REACH);
      expect(got.filter((l) => near.includes(l))).toEqual(near);
      for (let i = 1; i < got.length; i++) expect(doc.lots.indexOf(got[i - 1]!)).toBeLessThan(doc.lots.indexOf(got[i]!));
    };
    for (let step = 0; step < 600; step++) {
      check();
      const r = rng.float();
      const count = doc.openLots.count(refused);
      if (r < 0.45 && count) {
        // Grown: a building, then the lot naming it (as `growOnLot`), then the caller's put.
        const lot = doc.openLots.at(rng.int(0, count - 1));
        const c = lotCentre(lot);
        const b = doc.buildings.add({ ...generateBody('residential', 10, 10, 2), x: c.x, y: c.y, rotation: 0 } as unknown as Building);
        doc.openLots.grew(lot, b.id as number, null, 'teste');
        doc.buildings.put({ ...b, decay: 0 } as Building);
      } else if (r < 0.6 && count) {
        doc.openLots.refuse(doc.openLots.at(rng.int(0, count - 1)), refused);
      } else if (r < 0.75) {
        // A building knocked down: its lot open again.
        const named = doc.lots.filter((l) => l.building !== undefined && doc.buildings.has(l.building as BuildingId));
        if (named.length) doc.buildings.remove(named[rng.int(0, named.length - 1)]!.building as BuildingId);
      } else if (r < 0.82) {
        // A lot unzoned, or zoned, by its writer (a new record, the lots' revision moved).
        const i = rng.int(0, doc.lots.length - 1);
        const { use, density, ...rest } = doc.lots[i]!;
        doc.lots[i] = use ? rest : { ...rest, use: 'commercial', density: density ?? 'medium' };
        doc.lotsChanged(null, 'zona trocada');
      } else if (r < 0.86) {
        doc.lots.splice(rng.int(0, doc.lots.length - 1), 1);
        doc.lotsChanged(null, 'lote apagado');
      } else if (r < 0.9) {
        refused.clear();
      } else if (r < 0.93) {
        refused = new Set(refused);
      } else if (r < 0.95) {
        // Many buildings changed at once (more than the diary keeps).
        const any = [...doc.buildings.all()];
        for (let k = 0; k < 2100 && any.length; k++) doc.buildings.put({ ...any[k % any.length]! } as Building);
      }
    }
    check();
  });
});
