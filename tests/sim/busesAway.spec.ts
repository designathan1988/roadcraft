import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import type { SegmentId } from '@world/ids';
import { addLine, addStop, emptyTransit } from '@world/transit';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';

/** A BUS AWAY FROM THE VIEW RUNS BY ITS LINE'S TIMETABLE, NOT ON THE LANES (`transit.ts` stepBus): put on the road at a stop within the view */
const BLOCK = 120;

function busTown(): SimWorld {
  const doc = new RoadDoc();
  const n = 4;
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) { ids.push([]); for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * i, y: m(BLOCK) * j }).id); }
  const along: SegmentId[] = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    if (i < n) { const s = doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1)!; if (j === 2) along.push(s.id); }
    if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
  }
  let t = emptyTransit();
  const stops: number[] = [];
  for (const seg of along) {
    const s = doc.segment(seg)!;
    const a = doc.node(s.a)!, b = doc.node(s.b)!;
    const stop = addStop(t, { mode: 'bus', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - m(6), segment: seg });
    t = stop.data;
    stops.push(stop.id);
  }
  t = addLine(t, 'bus', stops).data;
  doc.setTransit(t);
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x5709);
  w.useMicroWindow();
  w.rebuildTopology();
  w.clock.paused = false;
  return w;
}

type BusRecord = { id: number | null; next: number };
const busesOf = (w: SimWorld): readonly BusRecord[] => (w.city.transit as unknown as { buses: BusRecord[] }).buses;
const onRoad = (w: SimWorld): number => [...w.vehicles.values()].filter((v) => v.archetype.id === 'bus').length;

describe('the buses away from the view', () => {
  it('go from stop to stop by the timetable with none on the road, and are put on it once the view comes', () => {
    const w = busTown();
    w.focus = { x: m(5000), y: m(5000), r: m(100), detail: true } as never;
    step(w, { traffic: true, pedestrians: false });
    expect(busesOf(w).length).toBeGreaterThan(0);
    const stopsWere = busesOf(w).map((b) => b.next);
    for (let k = 0; k < Math.round(240 / DT); k++) step(w, { traffic: true, pedestrians: false });
    expect(onRoad(w)).toBe(0);
    // They went on along the line meanwhile.
    expect(busesOf(w).map((b) => b.next)).not.toEqual(stopsWere);
    // The view over the town: a bus is put on the road at a stop within it.
    w.focus = { x: m(240), y: m(240), r: m(200), detail: true } as never;
    for (let k = 0; k < Math.round(240 / DT) && onRoad(w) === 0; k++) step(w, { traffic: true, pedestrians: false });
    expect(onRoad(w)).toBeGreaterThan(0);
  });
});
