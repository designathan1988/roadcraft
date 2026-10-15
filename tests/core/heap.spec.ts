import { describe, expect, it } from 'vitest';
import { Heap } from '@core/heap';

describe('the heap', () => {
  it('pops by key, ties by insertion order', () => {
    const h = new Heap();
    [[5, 2], [6, 1], [7, 2], [8, 0]].forEach(([item, key]) => h.push(item!, key!));
    const out: number[] = [];
    while (h.size) out.push(h.pop());
    expect(out).toEqual([8, 6, 5, 7]);
  });

  it('breaks ties by the order given before insertion order', () => {
    // Items placed by a coordinate: the tie goes to the smaller one, whatever the insertion.
    const place = [3, 1, 2, 1];
    const h = new Heap((a, b) => place[a]! < place[b]!);
    [0, 1, 2, 3].forEach((item) => h.push(item, 10));
    const out: number[] = [];
    while (h.size) out.push(h.pop());
    expect(out).toEqual([1, 3, 2, 0]);
  });
});
