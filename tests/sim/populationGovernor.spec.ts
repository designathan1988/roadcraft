import { describe, expect, it } from 'vitest';
import { PopulationGovernor } from '@sim/populationGovernor';

/** THE POPULATION THE MACHINE SUSTAINS (`sim/populationGovernor.ts`) */

/** Feeds `seconds` of frames at 60 a second, one step each at `ms`, from `from`, the town within its ceilings */
function run(g: PopulationGovernor, ms: number, from: number, seconds: number, town = 0): number {
  let share = g.share;
  for (let f = 0; f < seconds * 60; f++) share = g.feed(1, ms, from + f / 60, town, town);
  return share;
}

describe('the population governor', () => {
  it('keeps the whole town while a step is cheap enough', () => {
    const g = new PopulationGovernor(1);
    expect(run(g, 5, 0, 30)).toBe(1);
  });

  it('thins the town a step at a time while a step is dear, held between changes', () => {
    const g = new PopulationGovernor(1);
    const after1 = run(g, 12, 0, 1.5);
    expect(after1).toBeCloseTo(0.85, 9);
    // Within the hold nothing more changes.
    expect(run(g, 12, 1.5, 2)).toBeCloseTo(0.85, 9);
    // Past it, the next step.
    expect(run(g, 12, 3.5, 1.5)).toBeCloseTo(0.85 * 0.85, 9);
  });

  it('cuts again only once the town is down to the ceilings the last cut set', () => {
    // Nobody is removed: the agents leave as their trips end, over minutes, and until then the cost is still the full town's.
    const g = new PopulationGovernor(1);
    expect(run(g, 12, 0, 1.5, 1000)).toBeCloseTo(0.85, 9);
    expect(run(g, 12, 1.5, 60, 1000)).toBeCloseTo(0.85, 9);
    // Down to them (850 people, 1 020 cars at most): the next cut.
    expect(run(g, 12, 61.5, 1, 800)).toBeCloseTo(0.85 * 0.85, 9);
  });

  it('never goes under its floor, and fills again when the cost falls', () => {
    const g = new PopulationGovernor(1);
    expect(run(g, 40, 0, 120)).toBeCloseTo(0.3, 9);
    // The averaged cost takes its time to fall, then the town fills back up to the whole.
    expect(run(g, 2, 120, 120)).toBe(1);
  });

  it('never gives more than the device carries', () => {
    const g = new PopulationGovernor(0.5);
    expect(run(g, 2, 0, 30)).toBe(0.5);
    g.setMax(0.35);
    expect(g.share).toBe(0.35);
  });

  it('ignores frames that ran no step', () => {
    const g = new PopulationGovernor(1);
    for (let f = 0; f < 600; f++) g.feed(0, 0, f / 60, 0, 0);
    expect(g.stepMs).toBe(0);
    expect(g.share).toBe(1);
  });
});
