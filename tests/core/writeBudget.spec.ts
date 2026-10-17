import { describe, expect, it } from 'vitest';
import { WriteBudget, bytesOf } from '@core/derivedCache';
import { DerivedWriterLane } from '@/render/derivedWriterLane';

/** THE DERIVED CACHE'S WRITES HELD UNDER A CEILING OF BYTES NOT YET COMMITTED (`WriteBudget`, `DerivedWriterLane`): a slow writer never lets them pile up in the V8 cage */

const MB = 2 ** 20;

describe("the page's writes to the derived cache", () => {
  it('never hold more than the ceiling in flight while the writer is slow, the rest not kept, room again as commits come', () => {
    const posted: { id: number }[] = [];
    const port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (m: { id: number }) => { posted.push(m); } };
    const lane = new DerivedWriterLane(port as unknown as Worker, 48 * MB);
    let kept = 0, most = 0;
    // Thirty road tiles of 10 MB each, the writer committing none.
    for (let k = 0; k < 30; k++) {
      if (lane.post('roads:', [[`t${k}`, k]], [], 10 * MB)) kept++;
      most = Math.max(most, lane.bytes);
    }
    expect(most).toBeLessThanOrEqual(48 * MB);
    expect(kept).toBe(4);
    // Two commits answered: room for two more.
    port.onmessage!({ data: { done: posted[0]!.id } } as MessageEvent);
    port.onmessage!({ data: { done: posted[1]!.id } } as MessageEvent);
    expect(lane.bytes).toBe(20 * MB);
    expect(lane.post('roads:', [['u1', 1]], [], 10 * MB)).toBe(true);
    expect(lane.post('roads:', [['u2', 2]], [], 10 * MB)).toBe(true);
    expect(lane.post('roads:', [['u3', 3]], [], 10 * MB)).toBe(false);
  });
});

describe("a worker's queued writes (`keepDerivedQueued`)", () => {
  it('wait for the earlier ones to commit past the ceiling, a lone one whatever its size', async () => {
    const budget = new WriteBudget(40 * MB);
    const first = await budget.take(30 * MB);
    let second: (() => void) | null = null;
    void budget.take(30 * MB).then((release) => { second = release; });
    await new Promise((r) => setTimeout(r, 0));
    expect(second).toBeNull();
    expect(budget.bytes).toBe(30 * MB);
    first();
    await new Promise((r) => setTimeout(r, 0));
    expect(second).not.toBeNull();
    expect(budget.bytes).toBe(30 * MB);
    second!();
    // Alone, a write larger than the ceiling still goes.
    const big = await budget.take(100 * MB);
    expect(budget.bytes).toBe(100 * MB);
    big();
    expect(budget.bytes).toBe(0);
  });

  it('count the bytes of what they hold: the arrays\' buffers, the strings, the numbers', () => {
    expect(bytesOf({ positions: new Float32Array(1000), name: 'abcd', n: 1, list: [new Uint16Array(10)] })).toBe(4000 + 8 + 8 + 20);
    expect(bytesOf(new Map([['k', new Float64Array(4)]]))).toBe(2 + 32);
  });
});
