import { describe, expect, it } from 'vitest';
import type { WebGLRenderer } from 'three';
import { SampleRing, STUTTER_MS } from '@core/sampleRing';
import { createGpuTimer } from '@render/gpuTimer';

/** THE GPU TIME OF A FRAME */
const TIME_ELAPSED = 0x88bf, DISJOINT = 0x8fbb;

/** A WebGL2 context with the timer extension, whose results come in when `ready` says. */
function fakeGl() {
  const results = new Map<object, number>();
  const ready = new Set<object>();
  let made = 0, disjoint = false, active: object | null = null;
  const gl = {
    QUERY_RESULT_AVAILABLE: 0x8867, QUERY_RESULT: 0x8866,
    getExtension: (name: string) => (name === 'EXT_disjoint_timer_query_webgl2' ? { TIME_ELAPSED_EXT: TIME_ELAPSED, GPU_DISJOINT_EXT: DISJOINT } : null),
    getParameter: (p: number) => (p === DISJOINT ? disjoint : 0),
    createQuery: () => { made++; return { id: made }; },
    beginQuery: (_t: number, q: object) => { if (active) throw new Error('two active'); active = q; },
    endQuery: () => { active = null; },
    getQueryParameter: (q: object, p: number) => (p === 0x8867 ? ready.has(q) : results.get(q) ?? 0),
  };
  const renderer = { getContext: () => gl, domElement: new EventTarget() } as unknown as WebGLRenderer;
  return {
    renderer,
    get made() { return made; },
    /** The last query issued finishes with `ms` of GPU. */
    finish(q: object, ms: number) { results.set(q, ms * 1e6); ready.add(q); },
    lastBegun: () => active,
    setDisjoint(v: boolean) { disjoint = v; },
    gl,
  };
}

describe('the GPU timer', () => {
  it('reads the frames in order, skips when the ring is full, and drops a disjoint round', () => {
    const f = fakeGl();
    const issued: object[] = [];
    const realBegin = f.gl.beginQuery;
    f.gl.beginQuery = (t: number, q: object) => { issued.push(q); realBegin(t, q); };
    const timer = createGpuTimer(f.renderer, 4);
    expect(timer.supported).toBe(true);
    expect(f.made).toBe(4);
    // Four frames, none answered yet: the fifth has no free query.
    for (let i = 0; i < 5; i++) { timer.poll(); timer.begin(); timer.end(); }
    expect(timer.skipped).toBe(1);
    expect(f.made).toBe(4);
    // The second answers before the first: nothing is read until the first does.
    f.finish(issued[1]!, 7);
    timer.poll();
    expect(timer.samples.size).toBe(0);
    f.finish(issued[0]!, 5);
    timer.poll();
    expect(timer.samples.toArray()).toEqual([5, 7]);
    // A disjoint round: its results are thrown away, and counted.
    f.finish(issued[2]!, 40);
    f.setDisjoint(true);
    timer.poll();
    expect(timer.samples.toArray()).toEqual([5, 7]);
    expect(timer.disjoint).toBe(1);
    f.setDisjoint(false);
    f.finish(issued[3]!, 9);
    timer.poll();
    expect(timer.samples.toArray()).toEqual([5, 7, 9]);
    // The queries are reused, none made per frame.
    timer.begin(); timer.end();
    expect(f.made).toBe(4);
  });

  it('is a no-op where the extension is missing', () => {
    const renderer = { getContext: () => ({ getExtension: () => null, getParameter: () => 0 }) } as unknown as WebGLRenderer;
    const timer = createGpuTimer(renderer);
    expect(timer.supported).toBe(false);
    timer.poll(); timer.begin(); timer.end();
    expect(timer.samples.size).toBe(0);
  });
});

describe('a ring of samples', () => {
  it('keeps the last ones and gives nearest-rank percentiles and the stutters', () => {
    const ring = new SampleRing(100);
    for (let i = 1; i <= 150; i++) ring.push(i);
    expect(ring.size).toBe(100);
    expect(ring.toArray()[0]).toBe(51);
    const s = ring.stats(140);
    expect(s).toMatchObject({ n: 100, p50: 100, p95: 145, p99: 149, max: 150, over: 10 });
    expect(STUTTER_MS).toBeCloseTo(33.9, 1);
  });
});
