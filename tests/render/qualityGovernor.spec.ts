import { describe, expect, it } from 'vitest';

import { QualityGovernor, type QualityLevel } from '@render/quality';

const BUDGET = 1000 / 60;

/** Feeds `seconds` of 60 Hz frames, each costing `cost(tier)` ms of the GPU; returns every tier change, applied as the game applies them. */
function run(governor: QualityGovernor, seconds: number, cost: (tier: QualityLevel) => number): QualityLevel[] {
  const changes: QualityLevel[] = [];
  for (let t = 0; t < seconds; t += 1 / 60) {
    const next = governor.sample(1 / 60, cost(governor.current), BUDGET);
    if (next) {
      governor.set(next);
      changes.push(next);
    }
  }
  return changes;
}

describe('the automatic quality governor', () => {
  it('drops a tier when the p90 of two windows misses the frame', () => {
    const governor = new QualityGovernor('high');
    expect(run(governor, 6, () => 22)[0]).toBe('medium');
  });

  it('does not move for one slow window (a road built, a city opened)', () => {
    const governor = new QualityGovernor('high');
    let frame = 0;
    expect(run(governor, 20, () => (frame++ >= 60 && frame < 150 ? 40 : 12))).toEqual([]);
  });

  it('does not move on a few slow frames: the p90, not the worst', () => {
    const governor = new QualityGovernor('high');
    let frame = 0;
    expect(run(governor, 30, () => (frame++ % 20 === 0 ? 40 : 12))).toEqual([]);
  });

  it('climbs back to its ceiling once the frames have room', () => {
    const governor = new QualityGovernor('high');
    run(governor, 12, () => 40);
    expect(governor.current).toBe('low');
    run(governor, 40, () => 4);
    expect(governor.current).toBe('high');
  });

  it('never climbs above the tier the hardware was given', () => {
    const governor = new QualityGovernor('high');
    expect(run(governor, 30, () => 1)).toEqual([]);
  });

  it('holds between the marks: neither down nor up (the hysteresis)', () => {
    const governor = new QualityGovernor('medium', 'high');
    expect(run(governor, 60, () => 13)).toEqual([]);
  });

  it('stops trying a tier the machine could not hold, longer each time', () => {
    const governor = new QualityGovernor('medium', 'high');
    const cost = (tier: QualityLevel): number => (tier === 'high' ? 25 : 5);
    // Raised at ~7 s, undone at ~11 s, then held 90 s.
    expect(run(governor, 95, cost)).toEqual(['high', 'medium']);
    // Tried again once the hold ran out, undone again, and now held 180 s.
    expect(run(governor, 100, cost)).toEqual(['high', 'medium']);
    expect(run(governor, 80, cost)).toEqual([]);
  });
});
