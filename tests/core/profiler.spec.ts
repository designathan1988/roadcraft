import { describe, expect, it } from 'vitest';
import { Profiler } from '@core/profiler';

/** THE PROFILER CLOSED (`core/profiler.ts`, the HUD hidden by default): nothing recorded, its observers told to stop, and open again it records */

describe('the profiler closed', () => {
  it('records nothing while closed and tells its observers when it opens and closes', () => {
    const profiler = new Profiler();
    const told: boolean[] = [];
    profiler.onToggle((on) => told.push(on));
    expect(told).toEqual([true]);
    profiler.enabled = false;
    profiler.enabled = false;
    expect(told).toEqual([true, false]);
    profiler.beginFrame(0);
    profiler.count('upload.buffer', 100);
    profiler.change({ kind: 'roads', cause: 'tool', ids: 3 });
    profiler.product({ name: 'signs', phase: 'draw', ms: 1, keys: 1, idle: true });
    profiler.longTask(80);
    profiler.heap(5e8, 0);
    profiler.endFrame(10_000);
    const closed = profiler.view();
    expect(closed.frames).toBe(0);
    expect(closed.events).toEqual({});
    expect(closed.products).toEqual([]);
    expect(closed.idleProducts).toEqual([]);
    expect(closed.longTasks).toEqual([]);
    expect(closed.heapMB).toBeNull();
    profiler.enabled = true;
    expect(told).toEqual([true, false, true]);
    profiler.beginFrame(0);
    profiler.count('upload.buffer', 100);
    profiler.endFrame(16);
    const open = profiler.view();
    expect(open.frames).toBe(1);
    expect(open.events['upload.buffer']?.total).toBe(1);
  });
});
