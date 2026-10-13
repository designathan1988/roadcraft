import { describe, expect, it } from 'vitest';
import { SimClock } from '@sim/clock';
import { DT, MAX_SUBSTEPS } from '@sim/params';

/**
 * THE SIMULATION'S BUDGET A FRAME (`SimClock.advance`): past `budgetMs` of
 * wall time no further step runs this frame (one always does) and the debt
 * is shed, so a simulation dearer than real time slows down instead of
 * stretching every frame (Fiedler, "Fix Your Timestep!"). A fake clock
 * stands for the wall: each step costs what the spec says.
 */
function clockWithSteps(stepMs: number): { clock: SimClock; steps: () => number; run: (wall: number, budget?: number) => number } {
  const clock = new SimClock();
  let wall = 0, steps = 0;
  const now = (): number => wall;
  const step = (): void => { wall += stepMs; steps++; };
  return { clock, steps: () => steps, run: (seconds, budget) => clock.advance(seconds, step, budget, now) };
}

describe("the simulation's budget a frame", () => {
  it('runs every step a frame asks while they fit the budget', () => {
    const { clock, steps, run } = clockWithSteps(1);
    clock.speed = 4;
    run(DT, 8);
    expect(steps()).toBe(4);
    expect(clock.lastSteps).toBe(4);
    expect(clock.lastStepMs).toBe(1);
  });

  it('stops at the budget, sheds the debt, and slows rather than stretches', () => {
    const { clock, steps, run } = clockWithSteps(10);
    clock.speed = 4;
    // Four steps wanted at 10 ms each: one runs (it always does), the budget is spent.
    const alpha = run(DT, 8);
    expect(steps()).toBe(1);
    expect(alpha).toBe(0);
    // The next frame does not try to catch up the three left over.
    run(DT, 8);
    expect(steps()).toBe(2);
  });

  it('starts no step that would end past the budget', () => {
    // Steps of 7 ms under 8: the second would end at 14.
    const { clock, steps, run } = clockWithSteps(7);
    clock.speed = 2;
    run(DT, 8);
    expect(steps()).toBe(1);
    expect(clock.lastStepMs).toBe(7);
  });

  it('without a budget, runs up to the step cap as before', () => {
    const { clock, steps, run } = clockWithSteps(10);
    clock.speed = 4;
    run(0.25);
    expect(steps()).toBe(MAX_SUBSTEPS);
    expect(clock.lastStepMs).toBe(10);
  });

  it('reports no step when none ran', () => {
    const { clock, run } = clockWithSteps(1);
    clock.paused = true;
    run(DT, 8);
    expect(clock.lastSteps).toBe(0);
    expect(clock.lastStepMs).toBe(0);
  });
});
