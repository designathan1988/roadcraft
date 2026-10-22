import { describe, expect, it } from 'vitest';

import { IdSlots } from '@core/idSlots';

/** DENSE SLOTS FOR SPARSE IDS (`core/idSlots.ts`): what a `Map` from id to slot answers, on typed arrays. */
describe('the slots of sparse ids', () => {
  it('answers as a map does through takes, deletes and growth, its slots dense and reused', () => {
    const slots = new IdSlots(4);
    const model = new Map<number, number>();
    let capacity = 0;
    slots.onGrow = (n) => { capacity = n; };
    let seed = 7;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let step = 0; step < 20_000; step++) {
      // Ids of a tile's range and of a table, far apart.
      const id = Math.floor(rand() * 3000) * 7919 + (rand() < 0.5 ? 0 : 2 ** 40);
      if (rand() < 0.6) {
        const slot = slots.take(id);
        if (model.has(id)) expect(slot).toBe(model.get(id));
        else { expect([...model.values()]).not.toContain(slot); model.set(id, slot); }
        expect(slot).toBeLessThan(capacity);
      } else {
        expect(slots.delete(id)).toBe(model.delete(id));
      }
      expect(slots.size).toBe(model.size);
    }
    for (const [id, slot] of model) expect(slots.get(id)).toBe(slot);
    // Dense: every slot under the most ids ever held at once.
    expect(Math.max(...model.values())).toBeLessThan(capacity);
    let visited = 0;
    slots.forEach((id, slot) => { expect(model.get(id)).toBe(slot); visited++; });
    expect(visited).toBe(model.size);
    slots.clear();
    expect(slots.size).toBe(0);
    expect(slots.get([...model.keys()][0]!)).toBe(-1);
  });
});
