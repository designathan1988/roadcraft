import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { m } from '@world/units';
import { JAM_SPACING, MesoModel, WAVE_SPEED, laneCapacity } from '@sim/meso/model';
import { ObjectModel } from './support/objectModel';

/** The model's public face, as both the tables by slot and the object model have it. */
type Model = Omit<MesoModel, 'bytes' | 'setRates'>;

/** THE MESO MODEL (Link Transmission Model, equal-priority node model): vehicles kept, capacities respected, queues spilling back */

const L = m(200);
const V = m(14);
/** Room for standing cars on a one-lane link of `L`. */
const STORAGE = L / JAM_SPACING;

/** A link of the spec's shape into `to`. */
function link(model: Model, slot: number, to: number, extra: { lanes?: number; capacity?: number; exit?: boolean } = {}): void {
  model.setLink(slot, { to, lanes: extra.lanes ?? 1, length: L, vFree: V, exit: extra.exit ?? false,
    ...(extra.capacity !== undefined ? { capacity: extra.capacity } : {}) });
}

/** What the model holds equals what came in less what left, at every step. */
function balance(model: Model, start: number): number {
  return start + model.generated - model.lost - model.sunk + model.handedIn - model.handedOut - model.vehicles();
}

/** A ring road of 3 x 3 nodes, each joined both ways to its neighbours, two entries and two exits at the corners. */
function grid(model: Model): number[] {
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

/** Every number the model answers: its totals, the links it handed, and each slot's state, flows and turns. */
function reading(model: Model): number[] {
  const out = [model.slots, model.generated, model.lost, model.sunk, model.handedIn, model.handedOut, model.vehicles(), ...model.handed];
  for (let s = 0; s < model.slots; s++) {
    out.push(model.has(s) ? 1 : 0, model.isInside(s) ? 1 : 0, model.count(s), model.queued(s), model.speed(s), model.pending(s),
      model.outflowOf(s), model.inflowOf(s), model.lengthAt(s), model.lanesAt(s), model.capacityAt(s), model.freeSpeedAt(s), model.toAt(s),
      -1, ...model.turnsAt(s));
  }
  return out;
}

describe('the meso model in tables by slot', () => {
  it('gives the object model\'s numbers exactly, step by step, through links made, changed, dropped, taken again and handed to the window', () => {
    const a = new MesoModel(1), b = new ObjectModel(1);
    const models: Model[] = [a, b];
    const slots = grid(a);
    grid(b);
    const toOf = slots.map((s) => a.toAt(s)), turnsOf = slots.map((s) => [...a.turnsAt(s)]);
    const nodes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 100, 101, 102, 103];
    const micro = new Map<Model, Map<number, number>>(models.map((model) => [model, new Map()]));
    for (const model of models) for (const s of slots) model.seed(s, (s % 4) * 2);
    const rng = new Rng(0x5eed);
    for (let t = 0; t < 1200; t++) {
      // The same draws for both models.
      const gen = slots.map(() => rng.float() * 0.6), sink = slots.map(() => rng.float() * 0.2);
      const act = rng.int(0, 9), k = rng.int(0, slots.length - 1), x = rng.float();
      const s = slots[k]!;
      for (const model of models) {
        slots.forEach((o, i) => { model.setGeneration(o, gen[i]!); model.setSinkShare(o, sink[i]!); });
        const mine = micro.get(model)!;
        const held = mine.get(s) ?? 0;
        switch (act) {
          case 0: if (!model.isInside(s)) model.dropLink(s); break;
          case 1:
            if (!model.has(s)) {
              model.setLink(s, { to: toOf[k]!, lanes: 1 + (s % 2), length: L * (0.5 + x), vFree: V, exit: false });
              model.setTurns(s, turnsOf[k]!, turnsOf[k]!.map(() => 1));
            }
            break;
          case 2: if (model.has(s)) model.setLink(s, { to: toOf[k]!, lanes: 1 + (s % 2), length: L * (0.6 + x), vFree: V * (0.8 + x / 2), exit: false }); break;
          case 3: model.enterWindow(s); break;
          case 4: if (model.isInside(s)) { model.leaveWindow(s, held); mine.delete(s); } break;
          case 5:
            if (model.isInside(s)) {
              const take = Math.floor(model.pending(s));
              model.takePending(s, take);
              mine.set(s, held + take);
              model.setMicro(s, held + take);
            }
            break;
          case 6: {
            const onto = turnsOf[k]![0];
            if (model.isInside(s) && held > 0 && onto !== undefined && model.has(onto) && !model.isInside(onto)) {
              mine.set(s, held - 1);
              model.setMicro(s, held - 1);
              model.microExit(onto);
            }
            break;
          }
          case 7: model.seed(s, x * 5); break;
          case 8: if (model.has(s)) model.setTurns(s, turnsOf[k]!, turnsOf[k]!.map((_, i) => x + i)); break;
        }
        // A link past the first tables' room, fed by one of the grid's: the tables grow mid-run.
        if (t === 600) {
          model.setLink(70, { to: 4, lanes: 2, length: L, vFree: V, exit: true });
          model.setTurns(slots[1]!, [70, ...turnsOf[1]!], [2, ...turnsOf[1]!.map(() => 1)]);
        }
      }
      a.step();
      b.step();
      expect(reading(a), `step ${t}`).toEqual(reading(b));
      for (const n of nodes) expect([...a.inLinks(n)]).toEqual([...b.inLinks(n)]);
    }
    expect(a.generated).toBeGreaterThan(100);
    expect(a.handedOut).toBeGreaterThan(0);
  });

  it('holds a link in a few hundred bytes of typed arrays, and takes back the blocks of the links let go', () => {
    const model = new MesoModel(1);
    const n = 10_000;
    const fill = (): void => {
      for (let s = 0; s < n; s++) {
        model.setLink(s, { to: s % 2500, lanes: 1 + (s % 2), length: m(100), vFree: m(14), exit: false });
        model.setTurns(s, [(s + 1) % n, (s + 7) % n, (s + 13) % n], [1, 2, 3]);
      }
    };
    fill();
    const once = model.bytes;
    expect(once / n).toBeLessThan(1000);
    // A tile's links gone and others come: the same room again, nothing new.
    for (let s = 0; s < n; s++) model.dropLink(s);
    fill();
    expect(model.bytes).toBe(once);
    for (let t = 0; t < 30; t++) model.step();
    expect(model.vehicles()).toBe(0);
  });
});
