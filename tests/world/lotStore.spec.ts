import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { DocImage, sideOf } from '@world/docImage';
import { insideLot, type Lot } from '@world/lots';
import { lotBox } from '@world/lotStore';
import type { ChangeRect } from '@world/changes';
import { m } from '@world/units';

/** The lots' owner (`world/lotStore.ts`): by place it answers what the walk over every lot answered */
const SIDE = m(1200);

function square(rng: Rng): Omit<Lot, 'id'> {
  const x = rng.float() * SIDE, y = rng.float() * SIDE, w = m(10 + rng.float() * 30), d = m(10 + rng.float() * 30);
  return { corners: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + d }, { x, y: y + d }], ...(rng.float() < 0.5 ? { use: 'residential' as const, density: 'low' as const } : {}) };
}

const meets = (a: ChangeRect, b: ChangeRect): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** A random edit of the lots, as the tools make them: added, deleted, cut (the old out, pieces new), zoned, a corner moved. */
function edit(doc: RoadDoc, rng: Rng): void {
  const lots = doc.lots;
  const any = (): Lot => lots[rng.int(0, lots.length - 1)]!;
  const r = rng.float();
  if (r < 0.3 || lots.length < 4) doc.lotStore.apply({ add: [square(rng)] }, 'teste: novo');
  else if (r < 0.45) doc.lotStore.apply({ remove: [any().id] }, 'teste: apagado');
  else if (r < 0.6) doc.lotStore.apply({ remove: [any().id], add: [square(rng), square(rng)] }, 'teste: cortado');
  else if (r < 0.8) {
    const { use, density, ...rest } = any();
    doc.lotStore.apply({ put: [use ? rest : { ...rest, use: 'commercial', density: density ?? 'medium' }] }, 'teste: zona');
  } else {
    const l = any();
    const dx = m(rng.float() * 8 - 4);
    doc.lotStore.apply({ put: [{ ...l, corners: l.corners.map((q, i) => (i === 0 ? { x: q.x + dx, y: q.y } : q)) }] }, 'teste: canto');
  }
}

describe('the lots by their owner', () => {
  it('answer by place what the walk over every lot answered, edit after edit', () => {
    const rng = new Rng(11);
    const doc = new RoadDoc();
    for (let i = 0; i < 200; i++) doc.lotStore.apply({ add: [square(rng)] }, 'teste');
    for (let step = 0; step < 300; step++) {
      edit(doc, rng);
      const all = [...doc.lotStore.all()];
      for (let q = 0; q < 4; q++) {
        const x = rng.float() * SIDE, y = rng.float() * SIDE, s = m(rng.float() * 80);
        const rect: ChangeRect = [x, y, x + s, y + s];
        const want = all.filter((l) => meets(lotBox(l), rect)).map((l) => l.id).sort((a, b) => a - b);
        expect(doc.lotsIn(rect).map((l) => l.id), `step ${step}`).toEqual(want);
        const p = { x, y };
        expect(doc.lotAt(p), `step ${step}`).toBe(all.find((l) => insideLot(p, l)));
      }
    }
    // A map read back holds the same lots in the same order, and finds them by place alike.
    const copy = RoadDoc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(copy.lots).toEqual(doc.lots);
    expect(copy.nextLotId).toBe(doc.nextLotId);
  });

  it('writes every change of the lots with the ids it touched', () => {
    const rng = new Rng(3);
    const doc = new RoadDoc();
    const from = doc.changes.version;
    for (let step = 0; step < 100; step++) edit(doc, rng);
    const entries = doc.changes.since(from, ['lots'])!;
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.ids?.length, e.cause).toBeGreaterThan(0);
  });

  it('takes a working copy back by the ids its diary names, in the copy\'s order', () => {
    const rng = new Rng(5);
    const doc = new RoadDoc();
    for (let i = 0; i < 80; i++) doc.lotStore.apply({ add: [square(rng)] }, 'teste');
    for (let round = 0; round < 30; round++) {
      const work = doc.clone();
      for (let k = 0; k < 1 + rng.int(0, 6); k++) edit(work, rng);
      const want = work.lots;
      const before = doc.changes.version;
      doc.replaceWith(work);
      expect(doc.lots, `round ${round}`).toEqual(want);
      expect(doc.nextLotId).toBe(work.nextLotId);
      for (const e of doc.changes.since(before, ['lots'])!) expect(e.ids?.length).toBeGreaterThan(0);
      // And by place, as a store filed from nothing.
      const fresh = RoadDoc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
      const x = rng.float() * SIDE, y = rng.float() * SIDE;
      const rect: ChangeRect = [x, y, x + m(100), y + m(100)];
      expect(doc.lotsIn(rect).map((l) => l.id)).toEqual(fresh.lotsIn(rect).map((l) => l.id));
    }
  });

  it('undoes and redoes edits of the lots by their records', () => {
    const rng = new Rng(9);
    const doc = new RoadDoc();
    for (let i = 0; i < 60; i++) doc.lotStore.apply({ add: [square(rng)] }, 'teste');
    const image = new DocImage(doc);
    for (let round = 0; round < 40; round++) {
      const before = new Map([...doc.lotStore.all()].map((l) => [l.id, l]));
      for (let k = 0; k < 1 + rng.int(0, 4); k++) edit(doc, rng);
      const after = new Map([...doc.lotStore.all()].map((l) => [l.id, l]));
      const patch = image.commit(doc)!;
      expect(patch.lists.some((l) => (l.part as string) === 'lots')).toBe(false);
      doc.restore(sideOf(patch, 'before'));
      image.absorb(doc);
      expect(new Map([...doc.lotStore.all()].map((l) => [l.id, l]))).toEqual(before);
      doc.restore(sideOf(patch, 'after'));
      image.absorb(doc);
      expect(new Map([...doc.lotStore.all()].map((l) => [l.id, l]))).toEqual(after);
      const x = rng.float() * SIDE, y = rng.float() * SIDE;
      const rect: ChangeRect = [x, y, x + m(100), y + m(100)];
      expect(doc.lotsIn(rect).map((l) => l.id)).toEqual([...after.values()].filter((l) => meets(lotBox(l), rect)).map((l) => l.id).sort((a, b) => a - b));
    }
  });

  it('keeps land cut into lots apart from the lots: new keys alone move no lot', () => {
    const doc = new RoadDoc();
    doc.lotStore.apply({ add: [{ corners: [{ x: 0, y: 0 }, { x: m(20), y: 0 }, { x: m(20), y: m(30) }, { x: 0, y: m(30) }] }] }, 'teste');
    const lots = doc.lotRevision;
    expect(doc.lotStore.addKeys(['b:1,2,3,4'], [[0, 0, m(50), m(50)]], 'teste')).toBe(true);
    expect(doc.lotRevision).toBe(lots);
    expect(doc.lotKeys).toEqual(['b:1,2,3,4']);
    expect(doc.lotStore.addKeys(['b:1,2,3,4'], undefined, 'teste')).toBe(false);
  });
});
