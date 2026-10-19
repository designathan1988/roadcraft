import { describe, expect, it } from 'vitest';

import { longFrameWork, stepsWithin } from '@ui/healthWatch';

/** THE F9 MONITOR REPORTS WORK, NOT WAITING (Etapa 5g). */
describe('long frames in the health monitor', () => {
  it('count the work in a frame, not the time the browser held it open', () => {
    // 57 s by the clock, nothing run in it.
    expect(longFrameWork({ startTime: 1000, duration: 57_000, blockingDuration: 0, scripts: [] })).toBeLessThan(50);
    // 80 ms of scripts and 20 of rendering.
    expect(longFrameWork({ startTime: 0, duration: 400, renderStart: 380, scripts: [{ duration: 50 }, { duration: 30 }] })).toBe(100);
    // What blocked input, when the browser tells it and it is more.
    expect(longFrameWork({ startTime: 0, duration: 300, blockingDuration: 220, scripts: [{ duration: 90 }] })).toBe(220);
  });

  it('count the scripts too short for the browser to list (report TST-09)', () => {
    // Many callbacks under 5 ms, none listed: the time before the render is theirs.
    expect(longFrameWork({ startTime: 0, duration: 200, renderStart: 180, scripts: [] })).toBe(200);
    // The game's own steps inside the frame, more than the one script listed.
    expect(longFrameWork({ startTime: 0, duration: 200, renderStart: 150, scripts: [{ duration: 10 }] }, 120)).toBe(170);
  });

  it('blames only the steps that ran inside the frame', () => {
    const steps = [
      { name: 'draw/Render', start: 105, end: 160 },
      { name: 'person/fit', start: 20, end: 1100 },
      { name: 'road/rebuild', start: 90, end: 140 },
    ];
    expect(stepsWithin(steps, 100, 170).map((s) => s.name)).toEqual(['draw/Render']);
  });
});
