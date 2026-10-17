import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { addLine, addStop, addTrack, emptyTransit, railGraph, railPath } from '@world/transit';
import { SimWorld } from '@sim/world';

/** A TRAIN LINE'S LOOP HOLDS EACH POINT ONCE. */

interface RailView {
  readonly points: readonly Vec2[];
  readonly at: readonly number[];
  readonly length: number;
  readonly stations: readonly { readonly stop: number; readonly s: number; readonly turn: boolean }[];
  readonly crossings: readonly unknown[];
}

function lineOn(stations: readonly Vec2[]): { w: SimWorld; stops: number[] } {
  const doc = new RoadDoc();
  // A street across the track, for a level crossing out and one back.
  const a = doc.addNode({ x: m(120), y: m(-60) }).id, b = doc.addNode({ x: m(120), y: m(60) }).id;
  doc.addSegment(a as never, b as never, 1);
  let t = emptyTransit();
  const track = addTrack(t, 'train', [{ x: 0, y: 0 }, { x: m(100), y: 0 }, { x: m(200), y: 0 }, { x: m(300), y: m(50) }]);
  t = track.data;
  const stops: number[] = [];
  for (const p of stations) {
    const s = addStop(t, { mode: 'train', x: p.x, y: p.y, track: track.id });
    t = s.data;
    stops.push(s.id);
  }
  t = addLine(t, 'train', stops).data;
  doc.setTransit(t);
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x7a1);
  w.rebuildTopology();
  return { w, stops };
}

const railsOf = (w: SimWorld): readonly RailView[] => (w.city.transit as unknown as { rails: RailView[] }).rails;

describe('a train line loop', () => {
  for (const stations of [
    [{ x: m(50), y: 0 }, { x: m(150), y: 0 }, { x: m(250), y: m(25) }],
    [{ x: m(30), y: 0 }, { x: m(170), y: 0 }],
  ]) {
    it(`has no stretch of length zero (${stations.length} stations)`, () => {
      const { w, stops } = lineOn(stations);
      w.city.transit.step(w);
      const [rail] = railsOf(w);
      expect(rail).toBeDefined();
      const pts = rail!.points;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
        expect(Math.hypot(q.x - p.x, q.y - p.y), `stretch ${i} of ${pts.length}`).toBeGreaterThan(0);
      }
      // The same line: its legs' lengths end to end, each station where its leg begins.
      const g = railGraph(w.doc.transit, 'train');
      const order = [...stops, ...stops.slice(1, -1).reverse()].map((id) => w.doc.transit.stops.find((s) => s.id === id)!);
      let s = 0;
      const begins: number[] = [];
      for (let i = 0; i < order.length; i++) {
        const leg = railPath(g, order[i]!, order[(i + 1) % order.length]!)!;
        begins.push(s);
        for (let k = 1; k < leg.length; k++) s += Math.hypot(leg[k]!.x - leg[k - 1]!.x, leg[k]!.y - leg[k - 1]!.y);
      }
      expect(rail!.length).toBeCloseTo(s, 6);
      expect(rail!.stations.map((st) => st.s)).toEqual(begins.map((b) => expect.closeTo(b, 6)));
      expect(rail!.stations.map((st) => st.turn)).toEqual(order.map((_, i) => i === 0 || i === stops.length - 1));
      // Each lane of the street crossed once out and once back.
      const perLane = new Map<string, number>();
      for (const c of rail!.crossings as { lanelet: string }[]) perLane.set(c.lanelet, (perLane.get(c.lanelet) ?? 0) + 1);
      expect(perLane.size).toBeGreaterThan(0);
      for (const n of perLane.values()) expect(n).toBe(2);
      // The trains run along it with a finite place and heading.
      for (let k = 0; k < 200; k++) w.city.transit.step(w);
      for (const train of w.city.transit.trains()) {
        for (const car of train.cars) expect(Number.isFinite(car.x) && Number.isFinite(car.y) && Number.isFinite(car.heading)).toBe(true);
      }
    });
  }

  it('gives the walkers the discs of the trains that can reach them only, the same ones as asked of every train', () => {
    const { w } = lineOn([{ x: m(50), y: 0 }, { x: m(150), y: 0 }, { x: m(250), y: m(25) }]);
    for (let t = 0; t < 40; t++) w.city.transit.step(w);
    const all = w.city.transit.trainZones();
    expect(all.length).toBeGreaterThan(0);
    // Walkers round the line: the same discs.
    expect(w.city.transit.trainZones(true, [m(-50), m(-50), m(350), m(100)])).toEqual(all);
    // Walkers a few kilometres off: none.
    expect(w.city.transit.trainZones(true, [m(3000), m(3000), m(3100), m(3100)])).toEqual([]);
  });
});
