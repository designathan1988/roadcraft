import { describe, expect, it } from 'vitest';
import { m } from '@world/units';
import { JAM_SPACING, MesoModel, WAVE_SPEED, laneCapacity } from '@sim/meso/model';

/** THE MESO MODEL (Link Transmission Model, equal-priority node model): vehicles kept, capacities respected, queues spilling back */

const L = m(200);
const V = m(14);
/** Room for standing cars on a one-lane link of `L`. */
const STORAGE = L / JAM_SPACING;

/** A link of the spec's shape into `to`. */
function link(model: MesoModel, slot: number, to: number, extra: { lanes?: number; capacity?: number; exit?: boolean } = {}): void {
  model.setLink(slot, { to, lanes: extra.lanes ?? 1, length: L, vFree: V, exit: extra.exit ?? false,
    ...(extra.capacity !== undefined ? { capacity: extra.capacity } : {}) });
}

/** What the model holds equals what came in less what left, at every step. */
function balance(model: MesoModel, start: number): number {
  return start + model.generated - model.lost - model.sunk + model.handedIn - model.handedOut - model.vehicles();
}

/** A ring road of 3 x 3 nodes, each joined both ways to its neighbours, two entries and two exits at the corners. */
function grid(model: MesoModel): number[] {
  const node = (i: number, j: number): number => i * 3 + j;
  const slots: number[] = [];
  const ends = new Map<number, { from: number; to: number }>();
  let slot = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (const [di, dj] of [[1, 0], [0, 1]] as const) {
        if (i + di > 2 || j + dj > 2) continue;
        const a = node(i, j), b = node(i + di, j + dj);
        link(model, slot, b, { lanes: 1 + (slot % 2) }); ends.set(slot, { from: a, to: b }); slots.push(slot++);
        link(model, slot, a, { lanes: 1 + (slot % 2) }); ends.set(slot, { from: b, to: a }); slots.push(slot++);
      }
    }
  }
  // Entries into the corners (0, 0) and (2, 2), exits out of (0, 2) and (2, 0).
  for (const [from, to, entry] of [[100, 0, true], [101, 8, true], [2, 102, false], [6, 103, false]] as const) {
    link(model, slot, to, { exit: !entry });
    ends.set(slot, { from, to });
    slots.push(slot++);
  }
  for (const s of slots) {
    const to = ends.get(s)!.to;
    const next = slots.filter((o) => ends.get(o)!.from === to && ends.get(o)!.to !== ends.get(s)!.from);
    model.setTurns(s, next, next.map((o) => 1 + (o % 3)));
  }
  return slots;
}

describe('the meso model', () => {
  it('keeps every vehicle: what it holds is what came in less what left, step by step', () => {
    const model = new MesoModel(1);
    const slots = grid(model);
    for (const s of slots) { model.seed(s, (s % 5) * 3); model.setSinkShare(s, 0.05 * (s % 3)); }
    const start = 0;
    for (let t = 0; t < 900; t++) {
      // Demand rising past what the corners can take, then falling: queues come and go.
      const wave = t < 450 ? 0.2 + t / 450 : Math.max(0, 1.2 - (t - 450) / 300);
      for (const s of slots) model.setGeneration(s, s >= slots.length - 4 && s < slots.length - 2 ? wave : 0.02);
      model.step();
      expect(Math.abs(balance(model, start))).toBeLessThan(1e-6 * Math.max(1, model.generated));
    }
    expect(model.generated).toBeGreaterThan(200);
    expect(model.sunk).toBeGreaterThan(50);
  });

  it('never moves more than a link discharges or takes in a step', () => {
    const model = new MesoModel(1);
    const slots = grid(model);
    for (let t = 0; t < 600; t++) {
      for (const s of slots) model.setGeneration(s, 0.4);
      model.step();
      for (const s of slots) {
        const cap = model.capacityAt(s) * model.dt + 1e-9;
        expect(model.outflowOf(s)).toBeLessThanOrEqual(cap);
        expect(model.inflowOf(s)).toBeLessThanOrEqual(cap);
        expect(model.count(s)).toBeLessThanOrEqual(model.lanesAt(s) * STORAGE + 1e-6);
      }
    }
  });

  it('spills a queue back from a bottleneck, link after link, up to the origin', () => {
    const model = new MesoModel(1);
    link(model, 0, 1);
    link(model, 1, 2);
    link(model, 2, 3, { exit: true, capacity: 0.1 });
    model.setTurns(0, [1], [1]);
    model.setTurns(1, [2], [1]);
    // Twice what the last link lets out comes in.
    model.setGeneration(0, 0.2);
    const early: number[] = [];
    for (let t = 0; t < 4000; t++) {
      model.step();
      if (t === 150) early.push(model.count(0), model.count(1), model.count(2));
      expect(model.outflowOf(2)).toBeLessThanOrEqual(0.1 + 1e-9);
    }
    // At first only the free run's few cars on the first link; at last both links before the bottleneck hold its queue, standing
    // (the bottleneck itself takes in only what it lets out: a link's capacity bounds both its ends).
    expect(early[0]!).toBeLessThan(0.3 * STORAGE);
    // In the queue's state of the diagram at the bottleneck's flow: k = k_jam - q / w.
    const queueState = L * (1 / JAM_SPACING - 0.1 / WAVE_SPEED);
    for (const s of [0, 1]) expect(model.count(s)).toBeGreaterThan(0.85 * queueState);
    expect(model.queued(1)).toBeGreaterThan(0.5 * model.count(1));
    expect(model.speed(1)).toBeLessThan(0.4 * V);
    // The first link's intake fell to the bottleneck's: the rest waited at the origin and was lost there.
    expect(model.inflowOf(0)).toBeLessThan(0.1 + 0.02);
    expect(model.lost).toBeGreaterThan(0);
    expect(Math.abs(balance(model, 0))).toBeLessThan(1e-6 * model.generated);
  });

  it('holds a whole approach when one of its turns is full (FIFO), and shares a merge by capacity', () => {
    const diverge = new MesoModel(1);
    link(diverge, 0, 1, { lanes: 2 });
    // One turn leads to a road closed further on, the other off the map.
    link(diverge, 1, 2);
    link(diverge, 3, 4, { capacity: 0 });
    link(diverge, 2, 3, { exit: true });
    diverge.setTurns(0, [1, 2], [1, 1]);
    diverge.setTurns(1, [3], [1]);
    diverge.setGeneration(0, 0.5);
    // The closed road's approach fills to a standstill, and then nothing leaves the diverge for the open turn either.
    for (let t = 0; t < 600; t++) diverge.step();
    expect(diverge.count(1)).toBeGreaterThan(0.9 * STORAGE);
    expect(diverge.outflowOf(0)).toBeLessThan(1e-6);
    expect(diverge.inflowOf(2)).toBeLessThan(1e-6);

    const merge = new MesoModel(1);
    link(merge, 0, 9, { lanes: 2 });
    link(merge, 1, 9, { lanes: 1 });
    link(merge, 2, 10, { exit: true, capacity: 0.3 });
    merge.setTurns(0, [2], [1]);
    merge.setTurns(1, [2], [1]);
    merge.seed(0, 50);
    merge.seed(1, 25);
    let a = 0, b = 0;
    // Before either runs dry (0.2 and 0.1 a step out of 50 and 25).
    for (let t = 0; t < 220; t++) {
      merge.step();
      if (t > 20) { a += merge.outflowOf(0); b += merge.outflowOf(1); }
    }
    // Both queued at the merge: each served in proportion to its capacity, two lanes to one.
    const ratio = (2 * laneCapacity(V)) / laneCapacity(V);
    expect(a / b).toBeGreaterThan(ratio * 0.9);
    expect(a / b).toBeLessThan(ratio * 1.1);
  });

  it('hands a link to the micro window and takes it back without losing a vehicle', () => {
    const model = new MesoModel(1);
    link(model, 0, 1);
    link(model, 1, 2);
    link(model, 2, 3, { exit: true });
    model.setTurns(0, [1], [1]);
    model.setTurns(1, [2], [1]);
    model.setGeneration(0, 0.3);
    let micro = 0;
    for (let t = 0; t < 300; t++) {
      if (t === 50) model.enterWindow(1);
      // The micro simulation makes what it is handed, and lets one drive out onto the next link now and then.
      if (model.isInside(1)) {
        const take = Math.floor(model.pending(1));
        model.takePending(1, take);
        micro += take;
        if (micro > 0 && t % 7 === 0) { micro--; model.microExit(2); }
        model.setMicro(1, micro);
      }
      if (t === 200) { model.leaveWindow(1, micro); micro = 0; }
      model.step();
      // What the micro simulation holds was handed out (counted in `handedOut`), and is the model's again once handed back.
      expect(Math.abs(balance(model, 0))).toBeLessThan(1e-6 * Math.max(1, model.generated));
      expect(model.handedOut - model.handedIn).toBeCloseTo(micro, 6);
    }
    expect(model.handedOut).toBeGreaterThan(10);
    expect(model.handedIn).toBeGreaterThan(5);
  });
});
