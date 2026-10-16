import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { WeightedSlots } from '@core/weightedSlots';

/** THE DRAWS OF A WEIGHTED LIST, READ IN LOG STEPS, ARE THE WALK'S: the first item whose running sum passes the roll, the k-th item */

/** The walk over the list the slots stand for: running sums of the weights, as the lots' draws were written (`lotTraffic.ts`). */
function walkWeighted(classes: readonly number[], weights: readonly number[], target: number): number {
  let roll = target;
  for (let i = 0; i < classes.length; i++) {
    const c = classes[i]!;
    if (c < 0) continue;
    roll -= weights[c]!;
    if (roll < 0) return i;
  }
  return -1;
}

function walkNth(classes: readonly number[], k: number): number {
  let seen = 0;
  for (let i = 0; i < classes.length; i++) if (classes[i]! >= 0 && seen++ === k) return i;
  return -1;
}

describe('weighted slots', () => {
  it('draw what the walk over the list draws, through slots added, emptied, refilled and cleared', () => {
    const rng = new Rng(0x5107);
    const slots = new WeightedSlots(5);
    let classes: number[] = [];
    // Weights in eighths: every running sum exact, so the walk and the tree agree to the last bit.
    const weights = [3 / 8, 1, 0, 5 / 4, 2];
    let checked = 0;
    for (let round = 0; round < 3000; round++) {
      const roll = rng.float();
      if (roll < 0.35 || !classes.length) {
        const c = rng.int(-1, 4);
        expect(slots.push(c)).toBe(classes.length);
        classes.push(c);
      } else if (roll < 0.8) {
        const at = rng.int(0, classes.length - 1), c = rng.int(-1, 4);
        slots.set(at, c);
        classes[at] = c;
      } else if (roll < 0.805) {
        slots.clear();
        classes = [];
        continue;
      }
      expect(slots.length).toBe(classes.length);
      expect(slots.total()).toBe(classes.filter((c) => c >= 0).length);
      for (let c = 0; c < 5; c++) expect(slots.count(c)).toBe(classes.filter((x) => x === c).length);
      let total = 0;
      for (const c of classes) if (c >= 0) total += weights[c]!;
      for (let k = 0; k < 4; k++) {
        const target = Math.floor(rng.float() * total * 8) / 8;
        expect(slots.findWeighted(weights, target)).toBe(walkWeighted(classes, weights, target));
        const n = rng.int(0, slots.total());
        expect(slots.nth(n)).toBe(walkNth(classes, n));
        checked++;
      }
      // Past the whole sum: none.
      expect(slots.findWeighted(weights, total)).toBe(-1);
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('finds the last of a hundred thousand slots grown room by room as the walk finds it', () => {
    const slots = new WeightedSlots(2);
    for (let i = 0; i < 100_000; i++) slots.push(i % 3 === 0 ? -1 : i % 2);
    // The last slot of class 1 drawn: the tree's depth, 17 steps of 2 classes.
    const weights = [0, 1];
    const at = slots.findWeighted(weights, slots.count(1) - 0.5);
    expect(slots.classAt(at)).toBe(1);
    expect(walkWeighted(Array.from({ length: slots.length }, (_, i) => slots.classAt(i)), weights, slots.count(1) - 0.5)).toBe(at);
  });
});
