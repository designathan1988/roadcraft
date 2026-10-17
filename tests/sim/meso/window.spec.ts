import { describe, expect, it, vi } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { Meso } from '@sim/meso/meso';
import { DT } from '@sim/params';
import { MICRO_MIN_RADIUS, MICRO_RADIUS } from '@sim/meso/memory';

/** THE MICRO WINDOW: the meso traffic hands its cars to the micro simulation inside it, and none drives outside it */

const BLOCK = 120;

/** A grid of 5 x 5 blocks with a road off the map at two corners (as `doLess.spec.ts`). */
function town(): RoadDoc {
  const n = 5;
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * (i - n / 2), y: m(BLOCK) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  const half = m(BLOCK) * (n / 2);
  doc.addSegment(ids[0]![0]! as never, doc.addNode({ x: -half - m(150), y: -half }).id as never, 1);
  doc.addSegment(ids[n]![n]! as never, doc.addNode({ x: half + m(150), y: half }).id as never, 1);
  return doc;
}

describe('the micro window', () => {
  it('makes the meso cars inside the window and keeps every micro car of the meso inside it', () => {
    const doc = town();
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x3e50);
    w.rebuildTopology();
    const meso = new Meso();
    w.meso = meso;
    // Ten times the edge entries' usual rate: the town's streets fill within the minute.
    w.trafficIntensity = 10;
    w.clock.paused = false;
    const radius = m(250);
    meso.want(0, 0, radius);
    let most = 0;
    for (let t = 1; t <= Math.round(90 / DT); t++) {
      step(w, { traffic: true, pedestrians: false });
      most = Math.max(most, meso.owned.size);
      // Right after a meso step every car of the meso that drove out was taken back: those left are on the window's links.
      if (t % Math.round(1 / DT) !== 0) continue;
      for (const id of meso.owned) {
        const v = w.vehicles.get(id as never)!;
        const lane = w.lanelet(v.lanelet);
        if (!lane || lane.kind !== 'link') continue;
        const slot = meso.slotOfLane(lane.id);
        if (slot !== undefined) expect(meso.model.isInside(slot), `vehicle ${id} on ${lane.id}`).toBe(true);
      }
    }
    expect(meso.model.slots).toBeGreaterThan(0);
    expect(meso.model.generated).toBeGreaterThan(20);
    expect(most).toBeGreaterThan(0);
    // No car came in at the map's edge by the micro simulation's own entries: every one is the meso's.
    for (const v of w.vehicles.values()) expect(meso.owned.has(v.id)).toBe(true);
  });

  it('follows the view: a street view keeps a smaller window (fewer micro cars), and its cars go back to the meso and come out again, none lost', () => {
    const doc = town();
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x3e50);
    w.rebuildTopology();
    const meso = new Meso();
    w.meso = meso;
    w.trafficIntensity = 10;
    w.clock.paused = false;
    meso.want(0, 0, MICRO_RADIUS);
    const run = (seconds: number): void => { for (let t = 0; t < Math.round(seconds / DT); t++) step(w, { traffic: true, pedestrians: false }); };
    const windowR = (): number => (meso as unknown as { micro: { r: number } }).micro.r;
    // The map view: the whole window the page asked for.
    w.focus = { x: 0, y: 0, r: m(2000), detail: false };
    run(60);
    expect(windowR()).toBe(MICRO_RADIUS);
    const wide = meso.owned.size;
    expect(wide).toBeGreaterThan(5);
    // No new trips from here: the cars on the map are only handed between the two models.
    w.trafficIntensity = 0;
    run(1);
    const total = (): number => meso.model.vehicles() + meso.owned.size;
    const before = total();
    // A street view: the window shrinks to its least, the cars past it handed back to the meso.
    w.focus = { x: 0, y: 0, r: m(60), detail: true };
    run(DT);
    expect(windowR()).toBe(MICRO_MIN_RADIUS);
    expect(meso.owned.size).toBeLessThan(wide);
    expect(Math.abs(total() - before)).toBeLessThanOrEqual(2);
    // A small wheel step does not resize it (it does not breathe).
    w.focus = { x: 0, y: 0, r: m(70), detail: true };
    run(DT);
    expect(windowR()).toBe(MICRO_MIN_RADIUS);
    // The map view again: the meso's cars come out on the links the window takes back in.
    const narrow = total();
    w.focus = { x: 0, y: 0, r: m(2000), detail: false };
    run(5);
    expect(windowR()).toBe(MICRO_RADIUS);
    expect(Math.abs(total() - narrow)).toBeLessThanOrEqual(4);
  });

  it('asks the demand of each cell once a step, not once for each of its links', () => {
    const doc = town();
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x3e51);
    w.rebuildTopology();
    const meso = new Meso();
    w.meso = meso;
    w.clock.paused = false;
    meso.want(0, 0, MICRO_RADIUS);
    for (let t = 0; t < Math.round(3 / DT); t++) step(w, { traffic: true, pedestrians: false });
    const inner = meso as unknown as { demand: { carsPer100m(cell: number): number }; cellOf: ArrayLike<number> };
    const asked = vi.spyOn(inner.demand, 'carsPer100m');
    for (let t = 0; t < Math.round(2 / DT); t++) step(w, { traffic: true, pedestrians: false });
    const cells = new Set(Array.from({ length: meso.model.slots }, (_, k) => inner.cellOf[k]!)).size;
    expect(meso.model.slots).toBeGreaterThan(cells);
    expect(asked.mock.calls.length).toBeGreaterThan(0);
    expect(asked.mock.calls.length).toBeLessThanOrEqual(2 * cells);
  });
});
