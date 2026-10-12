import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { commitDraft } from '@editor/commit';
import { applyLots, insideLot, planLots } from '@world/lots';
import { Level, halfWidth } from '@world/roadTypes';
import { pavedTester } from '@world/zoneGrid';
import { m } from '@world/units';

/**
 * NO EMPTY SPACE AT A CORNER (the player, 2026-10-09: "os espaços vazios").
 *
 * A street between two cross streets: the cross streets' strips of lots take
 * the corners, and every proposed lot of the street between touching one was
 * dropped whole - a gap up to a lot wide at each corner. A stored lot did the
 * same to its block's row. Now what is left beside them is cut into lots.
 */

function street(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const net = new Network(doc);
  net.rebuild();
  const road = (ax: number, ay: number, bx: number, by: number): void => {
    commitDraft(doc, net, { kind: 'free', at: { x: ax, y: ay } }, { kind: 'free', at: { x: bx, y: by } }, 1);
    net.rebuild();
  };
  road(0, -200, 0, 0); road(0, 0, 0, 200);
  road(330, -200, 330, 0); road(330, 0, 330, 200);
  road(0, 0, 330, 0);
  return { doc, net };
}

/** The longest stretch of land behind the footway, along any street, with no lot on it. */
function widestGap(doc: RoadDoc, net: Network, lots: readonly { corners: readonly { x: number; y: number }[] }[]): number {
  const { onRoad, onPlate } = pavedTester(doc, net);
  let widest = 0;
  for (const ribbon of net.ribbons.values()) {
    const line = ribbon.full;
    const face = halfWidth(ribbon.road, Level.Sidewalk) + m(2);
    for (const side of [1, -1]) {
      let from = -1;
      for (let s = 0; s <= line.length; s += 2) {
        const f = line.sampleAt(s);
        const p = { x: f.p.x - f.t.y * side * face, y: f.p.y + f.t.x * side * face };
        const gap = !onRoad(p) && !onPlate(p) && !lots.some((l) => insideLot(p, l));
        if (gap && from < 0) from = s;
        if ((!gap || s + 2 > line.length) && from >= 0) { widest = Math.max(widest, s - from); from = -1; }
      }
    }
  }
  return widest;
}

describe('lots: no empty space at a corner', () => {
  it('cuts the street between two cross streets right up to their corner lots', () => {
    const { doc, net } = street();
    const plan = planLots(doc, net);
    expect(widestGap(doc, net, plan.add)).toBeLessThan(m(6));
  });

  it('cuts the rest of a row round a stored lot', () => {
    const { doc, net } = street();
    // A lot zoned off the division (half a lot along), the rest left to the proposal.
    const first = planLots(doc, net);
    const lot = first.add.find((c) => c.corners.every((q) => q.x > 60 && q.x < 280 && q.y > 0))!;
    const shifted = lot.corners.map((q) => ({ x: q.x + m(5), y: q.y }));
    applyLots(doc, { add: [{ key: '', corners: shifted }], keys: [], drop: [] });
    const plan = planLots(doc, net);
    expect(widestGap(doc, net, [...doc.lots, ...plan.add])).toBeLessThan(m(6));
  });
});
