import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANET_RADIUS } from '@core/cubeSphere';
import { CameraGestures } from '../../src/view/cameraGestures';
import type { Viewport } from '../../src/view/viewport';

/**
 * THE CAMERA'S COAST AFTER A DRAG (`view/cameraGestures.ts`).
 *
 * The hand's speed was read event by event: moves coalesced into one
 * millisecond read 10 px as 10 000 px/s, and at the globe, where a pixel is
 * thousands of units, a flick spun the planet ten times over in four seconds
 * (the player, 2026-10-10). It is now a line fitted to the last 100 ms,
 * capped, and at the globe never past an eighth of the way round.
 */

/** A view at the globe (or not) that only adds up how far it was slid. */
function view(globe: number, scale: number) {
  let slid = 0;
  const v = {
    globe,
    scaleAtCentre: scale,
    zoom: scale,
    slide: (right: number, forward: number) => { slid += Math.hypot(right, forward); },
    panTo: () => {},
    orbit: () => {},
    toWorldAt: () => ({ x: 0, y: 0 }),
    holds: () => true,
  } as unknown as Viewport;
  return { v, slid: () => slid };
}

function drag(gestures: CameraGestures, clock: { t: number }, steps: number, px: number, ms: number): void {
  gestures.press(1, { x: 0, y: 0 });
  gestures.startPan(1, { x: 0, y: 0 });
  for (let i = 1; i <= steps; i++) {
    clock.t += ms;
    gestures.move(1, { x: i * px, y: 0 });
  }
  gestures.release(1);
}

describe("the camera's coast", () => {
  afterEach(() => vi.restoreAllMocks());

  const setup = (globe: number, scale: number) => {
    const clock = { t: 1000 };
    vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
    const { v, slid } = view(globe, scale);
    const gestures = new CameraGestures({ view: () => v, size: () => ({ w: 1600, h: 900 }), orbited: () => {}, redraw: () => {}, heightUnder: () => 0 });
    return { clock, gestures, slid };
  };

  it('carries the globe no farther than an eighth of the way round, however fast the flick', () => {
    const { clock, gestures, slid } = setup(1, 0.058);
    // 300 px in 80 ms (3 750 px/s): a quick flick.
    drag(gestures, clock, 10, 30, 8);
    const during = slid();
    for (let i = 0; i < 600; i++) { clock.t += 16; gestures.step(0.016); }
    const coast = slid() - during;
    expect(coast).toBeGreaterThan(0);
    // An eighth of the way round (the frames add up a hair over the exponential's integral).
    expect(coast).toBeLessThanOrEqual(((PLANET_RADIUS * Math.PI) / 4) * 1.01);
  });

  it('throws nothing from moves bunched into a few milliseconds (too little to read a speed from)', () => {
    const { clock, gestures } = setup(1, 0.058);
    drag(gestures, clock, 10, 30, 1);
    expect((gestures as unknown as { coast: unknown }).coast).toBeNull();
  });

  it('reads a steady drag at its real speed near the ground', () => {
    // At the street the pan goes by panTo, not slide: the coast's speed is what is read.
    const { clock, gestures } = setup(0, 1.5);
    drag(gestures, clock, 20, 8, 16);
    const coast = (gestures as unknown as { coast: { vx: number } | null }).coast;
    // 8 px every 16 ms: 500 px/s.
    expect(coast).not.toBeNull();
    expect(coast!.vx).toBeCloseTo(500, -1);
  });

  it('throws nothing when the hand stopped before letting go', () => {
    const { clock, gestures } = setup(0, 1.5);
    gestures.press(1, { x: 0, y: 0 });
    gestures.startPan(1, { x: 0, y: 0 });
    for (let i = 1; i <= 10; i++) { clock.t += 16; gestures.move(1, { x: i * 8, y: 0 }); }
    clock.t += 120;
    gestures.release(1);
    expect((gestures as unknown as { coast: unknown }).coast).toBeNull();
  });
});
