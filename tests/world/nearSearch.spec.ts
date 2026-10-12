import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildDefaultTown } from '@world/defaultTown';
import { crossingAccesses, crossingAccessTester, onCrossingAccess } from '@world/landscape';
import { Rng } from '@core/rng';
import { m } from '@world/units';

/**
 * The searches of the street furniture by cell (profile of 2026-10-12: every
 * item asked every road and every crossing of the map, ~65 ms of each road
 * drawn on the player's map) find what the whole-map loops found.
 */
function town(): Network {
  const doc = new RoadDoc();
  buildDefaultTown(doc);
  const net = new Network(doc);
  net.rebuild();
  return net;
}

describe('the searches near a point', () => {
  it('meet every ribbon the whole-map loop would test, in its order', () => {
    const net = town();
    const order = [...net.ribbons.keys()];
    const rng = new Rng(7);
    const xs = [...net.doc.nodes.values()].map((n) => n.x), ys = [...net.doc.nodes.values()].map((n) => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    for (let k = 0; k < 3000; k++) {
      const at = { x: x0 + (x1 - x0) * rng.float(), y: y0 + (y1 - y0) * rng.float() };
      const reach = m(rng.float() * 3);
      const near = net.ribbonsMeeting([at.x - reach, at.y - reach, at.x + reach, at.y + reach]).map((r) => r.id);
      // The loop's own test (`landscape.ts` footwayAt): the box grown by the road's half width, footway and reach.
      for (const ribbon of net.ribbons.values()) {
        const box = ribbon.full.bbox, pad = ribbon.road.width / 2 + ribbon.road.sidewalk + reach;
        const passes = !(at.x < box.minX - pad || at.x > box.maxX + pad || at.y < box.minY - pad || at.y > box.maxY + pad);
        if (passes) expect(near, `point ${k}, ribbon ${ribbon.id}`).toContain(ribbon.id);
      }
      expect(near).toEqual([...near].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    }
  });

  it('tells a crossing landing as the item-by-item test does', () => {
    const net = town();
    const accesses = crossingAccesses(net);
    expect(accesses.length).toBeGreaterThan(4);
    const test = crossingAccessTester(net, accesses);
    const rng = new Rng(11);
    const segments = [...net.doc.segments.keys()];
    let inside = 0;
    for (let k = 0; k < 5000; k++) {
      const a = accesses[Math.floor(rng.float() * accesses.length)]!;
      const x = a.x + m((rng.float() - 0.5) * 30), y = a.y + m((rng.float() - 0.5) * 30), radius = m(rng.float() * 2);
      const segment = segments[Math.floor(rng.float() * segments.length)]!;
      const expected = onCrossingAccess(net, accesses, segment, x, y, radius);
      if (expected) inside++;
      expect(test(segment, x, y, radius), `point ${k}`).toBe(expected);
    }
    expect(inside).toBeGreaterThan(50);
  });
});
