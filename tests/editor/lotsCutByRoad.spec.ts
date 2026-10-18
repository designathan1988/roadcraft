import { describe, expect, it } from 'vitest';
import { commitDraft } from '@editor/commit';
import { History } from '@editor/history';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { addPolygonLot, cutLotsByRoads, lotArea, zoneLots } from '@world/lots';
import { touchesRoad } from '@world/buildings/validate';

/** A ROAD THROUGH A ZONED LOT CUTS IT (`world/lots.ts` cutLotsByRoads, `main.ts` mutateBuilt): the pieces left on land each a lot of its zone, none over the road; the edit's undo gives the lot back whole (the grid's road across two zoned blocks left both lots whole over it, 2026-10-18) */

/** A block 90 x 70 m between four streets, one zoned lot over its land. */
function zonedBlock(): { doc: RoadDoc; net: Network; lot: number } {
  const doc = new RoadDoc();
  const n = (x: number, y: number) => doc.addNode({ x: m(x), y: m(y) }).id;
  const a = n(-45, -35), b = n(45, -35), c = n(45, 35), d = n(-45, 35);
  doc.addSegment(a, b, 1); doc.addSegment(b, c, 1); doc.addSegment(c, d, 1); doc.addSegment(d, a, 1);
  const net = new Network(doc);
  net.rebuild();
  const lot = addPolygonLot(doc, [{ x: m(-30), y: m(-22) }, { x: m(30), y: m(-22) }, { x: m(30), y: m(22) }, { x: m(-30), y: m(22) }], 0)!;
  zoneLots(doc, [lot.id], { use: 'residential', density: 'low' });
  return { doc, net, lot: lot.id };
}

/** A road drawn as the player draws it, in one undo step with what the road edit does after (`main.ts` mutateBuilt). */
function drawRoad(doc: RoadDoc, net: Network, history: History, from: [number, number], to: [number, number]): void {
  if (net.revision !== doc.revision) net.rebuild();
  const before = net.state;
  history.begin(doc);
  const result = commitDraft(doc, net, { kind: 'free', at: { x: m(from[0]), y: m(from[1]) } }, { kind: 'free', at: { x: m(to[0]), y: m(to[1]) } }, 1, null, 'ground');
  expect(result.committed).toBe(true);
  if (net.revision !== doc.revision) net.rebuild();
  const delta = net.changesSince(before);
  cutLotsByRoads(doc, net, delta === null ? null : delta.rects);
  history.end(doc);
}

describe('a road through a zoned lot', () => {
  it('cuts it into the pieces left on land, each of its zone and none over the road; undo gives it back whole', () => {
    const { doc, net, lot } = zonedBlock();
    const whole = doc.lot(lot)!;
    const history = new History();
    // Across the block on the diagonal, from open land to open land.
    drawRoad(doc, net, history, [-70, -60], [70, 60]);
    expect(doc.lot(lot)).toBeUndefined();
    expect(doc.lots.length).toBeGreaterThanOrEqual(2);
    for (const piece of doc.lots) {
      expect(piece.use).toBe('residential');
      // Inside its edge (a piece meets the footway along it, as a building's footprint is read 2 cm in, `editor/buildings.ts`).
      const cx = piece.corners.reduce((t, p) => t + p.x, 0) / piece.corners.length, cy = piece.corners.reduce((t, p) => t + p.y, 0) / piece.corners.length;
      expect(touchesRoad(net, piece.corners.map((p) => ({ x: cx + (p.x - cx) * 0.98, y: cy + (p.y - cy) * 0.98 })))).toBe(false);
      expect(Math.abs(lotArea(piece))).toBeLessThan(Math.abs(lotArea(whole)));
    }
    // The edit undone: the lot as it was, alone.
    expect(history.undo(doc)).toBe(true);
    expect(doc.lots.map((l) => l.id)).toEqual([lot]);
    expect(doc.lot(lot)!.corners).toEqual(whole.corners);
  });

  it('is left as it is by a road that only runs past it', () => {
    const { doc, net, lot } = zonedBlock();
    const history = new History();
    drawRoad(doc, net, history, [-60, -80], [60, -80]);
    expect(doc.lots.map((l) => l.id)).toEqual([lot]);
  });
});
