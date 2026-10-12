import { describe, expect, it } from 'vitest';
import { FlightStick, STICK, stickRate } from '../../src/render/planet/flight';

/**
 * THE MOUSE AS A STICK (`flight.ts` FlightStick): the cursor's offset from
 * the sight turns the view at a rate - nothing in the dead zone, a curve past
 * it, the rate following the stick with a first-order lag. It must obey at
 * once (a turn under way within a few frames), never overshoot (let go, the
 * rate falls to nothing without turning back) and never drift.
 */
const FRAME = 1 / 60;
const run = (stick: FlightStick, seconds: number, each?: (t: number) => void): void => {
  for (let t = 0; t < seconds; t += FRAME) { stick.update(FRAME); each?.(t); }
};

describe('the flight stick', () => {
  it('does nothing in the dead zone and rises smoothly past it to the most at the edge', () => {
    expect(stickRate(0)).toBe(0);
    expect(stickRate(STICK.deadZone * 0.99)).toBe(0);
    // Just past the dead zone: barely moving, not a jump.
    expect(Math.abs(stickRate(STICK.deadZone + 0.01))).toBeLessThan(0.01 * STICK.maxRate);
    let last = 0;
    for (let d = STICK.deadZone; d <= 1; d += 0.01) {
      const r = stickRate(d);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
    expect(stickRate(1)).toBeCloseTo(STICK.maxRate, 6);
    expect(stickRate(-0.5)).toBeCloseTo(-stickRate(0.5), 9);
  });

  it('obeys at once: most of the turn asked within 0.15 s, a turn under way after a frame', () => {
    const stick = new FlightStick();
    stick.set(0.6, 0);
    stick.update(FRAME);
    const want = -stickRate(0.6);
    expect(stick.yawRate / want).toBeGreaterThan(0.2);
    run(stick, 0.15);
    expect(stick.yawRate / want).toBeGreaterThan(0.94);
    expect(stick.pitchRate).toBe(0);
  });

  it('let go, stops without turning back (no overshoot) and holds still (no drift)', () => {
    const stick = new FlightStick();
    stick.set(-0.8, 0.5);
    run(stick, 1);
    const yawSign = Math.sign(stick.yawRate), pitchSign = Math.sign(stick.pitchRate);
    stick.set(0, 0);
    let wrong = 0;
    run(stick, 0.4, () => {
      if (Math.sign(stick.yawRate) === -yawSign) wrong++;
      if (Math.sign(stick.pitchRate) === -pitchSign) wrong++;
    });
    expect(wrong).toBe(0);
    expect(Math.abs(stick.yawRate) + Math.abs(stick.pitchRate)).toBeLessThan(1e-3);
    // A hand resting a little off the sight: ten seconds, no turn at all.
    stick.set(STICK.deadZone * 0.7, -STICK.deadZone * 0.5);
    let turned = 0;
    run(stick, 10, () => { turned += Math.abs(stick.yawRate) + Math.abs(stick.pitchRate); });
    expect(turned).toBe(0);
  });

  it('turns the way the cursor is: right turns right, below looks down; a diagonal as a straight push', () => {
    const stick = new FlightStick();
    stick.set(0.5, 0.5);
    run(stick, 1);
    // Yaw about the up (left +): right is negative; pitch (up +): below is negative.
    expect(stick.yawRate).toBeLessThan(0);
    expect(stick.pitchRate).toBeLessThan(0);
    const along = Math.hypot(stick.yawRate, stick.pitchRate);
    expect(along).toBeCloseTo(stickRate(Math.hypot(0.5, 0.5)), 3);
    // Past the edge: held at full deflection.
    stick.set(5, 0);
    run(stick, 1);
    expect(-stick.yawRate).toBeCloseTo(STICK.maxRate, 3);
  });
});
