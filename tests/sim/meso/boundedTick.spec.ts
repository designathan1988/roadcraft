import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { Meso } from '@sim/meso/meso';
import { MesoModel } from '@sim/meso/model';
import { MESO_PRESENT, ML, MESO_RECORD } from '@sim/meso/memory';
import { DT } from '@sim/params';

/** THE MESO'S COST A TICK IS BOUNDED, NOT THE MAP'S SIZE: its step spread over ticks (the same numbers), the page sent only the links that changed, the window's cars sent to its edge */

const BLOCK = 120;

/** A grid of `n` x `n` blocks with a road off the map at two corners (as `window.spec.ts`). */
function town(n = 5): RoadDoc {
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

function world(seed: number): { w: SimWorld; meso: Meso } {
  const doc = town();
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, seed);
  w.rebuildTopology();
  const meso = new Meso();
  w.meso = meso;
  w.clock.paused = false;
  return { w, meso };
}

/** A line of `n` links 0 -> 1 -> ... with an entry at its start and an exit at its end, fed and sinking. */
function line(model: MesoModel, n: number): void {
  for (let s = 0; s < n; s++) model.setLink(s, { to: s + 1, lanes: 1 + (s % 2), length: m(150 + 10 * (s % 7)), vFree: m(14), exit: s === n - 1 });
  for (let s = 0; s < n - 1; s++) model.setTurns(s, [s + 1], [1]);
  for (let s = 0; s < n; s++) { model.seed(s, 3 + (s % 4)); model.setGeneration(s, s === 0 ? 0.5 : 0.01); model.setSinkShare(s, 0.02); }
}

const numbers = (model: MesoModel, n: number): number[] => {
  const out: number[] = [];
  const flow = { count: 0, queued: 0, speed: 0 };
  for (let s = 0; s < n; s++) { model.flowInto(s, flow); out.push(flow.count, flow.queued, flow.speed); }
  return [...out, model.generated, model.lost, model.sunk];
};

describe('the meso step spread over ticks', () => {
  it('gives the whole step\'s numbers exactly, a few links a call, and a link changed half way finishes the step first', () => {
    const whole = new MesoModel(1), spread = new MesoModel(1);
    line(whole, 40);
    line(spread, 40);
    for (let t = 0; t < 120; t++) {
      whole.step();
      let calls = 0;
      // Seven links or nodes a call: a step of 40 links takes many.
      while (spread.stepSome(7) <= 0 && spread.stepping) {
        calls++;
        // Half way through a step, the page's edit: the spread model finishes its step before taking it, the whole one takes it after.
        if (t === 60 && calls === 5) { spread.seed(3, 4); expect(spread.stepping).toBe(false); break; }
      }
      if (t === 60) whole.seed(3, 4);
      expect(calls).toBeGreaterThan(t === 60 ? 3 : 10);
      expect(numbers(spread, 40), `step ${t}`).toEqual(numbers(whole, 40));
    }
  });

  it('does no more than its budget of links a tick, and the far traffic slows rather than the tick', () => {
    const { w, meso } = world(0x7b1);
    meso.budget = 16;
    let spanned = 0;
    for (let t = 0; t < Math.round(20 / DT); t++) {
      step(w, { traffic: true, pedestrians: false });
      if (meso.model.stepping) spanned++;
    }
    expect(meso.model.slots).toBeGreaterThan(16);
    // A step of the town's links took several ticks; the steps still came.
    expect(spanned).toBeGreaterThan(0);
    expect(meso.model.generated).toBeGreaterThan(0);
  });
});

describe('the page\'s meso delta', () => {
  it('is every link the first time, then only the links whose drawn numbers moved', () => {
    const { w, meso } = world(0x7b2);
    meso.want(0, 0, m(200));
    const ticks = Math.round(1 / DT);
    for (let t = 0; t < ticks; t++) step(w, { traffic: true, pedestrians: false });
    const first = meso.takeDelta()!;
    expect(first.whole).toBe(true);
    let present = 0;
    for (let s = 0; s < meso.model.slots; s++) if (meso.model.has(s)) present++;
    expect(first.at.length).toBe(present);
    for (let k = 0; k < first.at.length; k++) {
      expect(first.records[k * MESO_RECORD + ML.flags]! & MESO_PRESENT).toBe(MESO_PRESENT);
      // Every line is new to the page.
      expect(first.records[k * MESO_RECORD + ML.shape]).toBeGreaterThan(0);
      expect(first.ids[k]).toBe(meso.linkOfSlot(first.at[k]!));
    }
    // No more trips: the next steps send the links that still move, never the whole town again.
    w.trafficIntensity = 0;
    let most = 0;
    for (let s = 0; s < 20; s++) {
      for (let t = 0; t < ticks; t++) step(w, { traffic: true, pedestrians: false });
      const d = meso.takeDelta();
      expect(d?.whole ?? false).toBe(false);
      for (let k = 0; k < (d?.at.length ?? 0); k++) expect(d!.records[k * MESO_RECORD + ML.shape]).toBe(0);
      most = Math.max(most, d?.at.length ?? 0);
    }
    expect(most).toBeLessThan(present);
    // The page asks again (its copy is new): every link once more.
    meso.requestWhole();
    for (let t = 0; t < ticks; t++) step(w, { traffic: true, pedestrians: false });
    const again = meso.takeDelta()!;
    expect(again.whole).toBe(true);
    expect(again.at.length).toBe(present);
  });
});

describe("the window's cars", () => {
  it('drive to a lane just past the window\'s edge, never to an exit of the map', () => {
    const { w, meso } = world(0x7b3);
    w.trafficIntensity = 10;
    meso.want(0, 0, m(250));
    for (let t = 0; t < Math.round(60 / DT); t++) step(w, { traffic: true, pedestrians: false });
    const edge = new Set(meso.handoffLanes());
    expect(edge.size).toBeGreaterThan(0);
    for (const id of edge) {
      const slot = meso.slotOfLane(id)!;
      expect(meso.model.isInside(slot), id).toBe(false);
    }
    let routed = 0;
    for (const id of meso.owned) {
      const v = w.vehicles.get(id as never);
      if (!v?.destination) continue;
      expect(edge.has(v.destination), `vehicle ${id} to ${v.destination}`).toBe(true);
      routed++;
    }
    expect(routed).toBeGreaterThan(0);
  });
});
