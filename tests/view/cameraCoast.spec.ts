import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraGestures } from '../../src/view/cameraGestures';
import type { Viewport } from '../../src/view/viewport';

/**
 * THE CAMERA'S COAST AFTER A DRAG (`view/cameraGestures.ts`).
 *
 * The hand's speed was read event by event: moves coalesced into one
 * millisecond read 10 px as 10 000 px/s, and a flick threw the view across
 * the map (the player, 2026-10-10). It is now a line fitted to the last
 * 100 ms, capped (Android's VelocityTracker maxVelocity).
 */

/** A view that only adds up how far it was slid. */
function view(scale: number) {
  let slid = 0;
  const v = {
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

  const setup = (scale: number) => {
    const clock = { t: 1000 };
    vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
    const { v, slid } = view(scale);
    const gestures = new CameraGestures({ view: () => v, size: () => ({ w: 1600, h: 900 }), orbited: () => {}, redraw: () => {}, heightUnder: () => 0 });
    return { clock, gestures, slid };
  };

  it('caps the speed a flick throws the view with, however fast the hand', () => {
    const { clock, gestures, slid } = setup(1.5);
    // 600 px in 20 ms (30 000 px/s).
    drag(gestures, clock, 10, 60, 2);
    const coast = (gestures as unknown as { coast: { vx: number; vy: number } | null }).coast;
    expect(coast).not.toBeNull();
    expect(Math.hypot(coast!.vx, coast!.vy)).toBeLessThanOrEqual(4000 + 1e-6);
    const during = slid();
    for (let i = 0; i < 600; i++) { clock.t += 16; gestures.step(0.016); }
    // At most the capped speed times the decay's time constant, in units (px / scale).
    expect(slid() - during).toBeLessThanOrEqual((4000 * 0.45 / 1.5) * 1.01);
  });

  it('throws nothing from moves bunched into a few milliseconds (too little to read a speed from)', () => {
    const { clock, gestures } = setup(1.5);
    drag(gestures, clock, 10, 30, 1);
    expect((gestures as unknown as { coast: unknown }).coast).toBeNull();
  });

  it('reads a steady drag at its real speed', () => {
    // The pan goes by panTo, not slide: the coast's speed is what is read.
    const { clock, gestures } = setup(1.5);
    drag(gestures, clock, 20, 8, 16);
    const coast = (gestures as unknown as { coast: { vx: number } | null }).coast;
    // 8 px every 16 ms: 500 px/s.
    expect(coast).not.toBeNull();
    expect(coast!.vx).toBeCloseTo(500, -1);
  });

  it('throws nothing when the hand stopped before letting go', () => {
    const { clock, gestures } = setup(1.5);
    gestures.press(1, { x: 0, y: 0 });
    gestures.startPan(1, { x: 0, y: 0 });
    for (let i = 1; i <= 10; i++) { clock.t += 16; gestures.move(1, { x: i * 8, y: 0 }); }
    clock.t += 120;
    gestures.release(1);
    expect((gestures as unknown as { coast: unknown }).coast).toBeNull();
  });
});
