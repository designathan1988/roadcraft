import { describe, expect, it } from 'vitest';

import { createIsoRig } from '@render/isoViewport';
import { CameraMotion } from '@view/cameraMotion';
import { m } from '@world/units';

/**
 * THE CAMERA'S GLIDE (`view/cameraMotion.ts`): a held key and a notch of the
 * wheel give the same view at the same time whatever the frames - 16 ms, a
 * ragged 7-50 ms, 150 ms - and the first frame after the game stood still
 * moves by the time since the key, not since the last frame drawn.
 */
const W = 1280;
const H = 720;
const T0 = 5000;

function rig() {
  const r = createIsoRig({ x: 0, y: 0 }, m(40));
  r.resize(W, H);
  r.setGround(() => 0);
  r.setPerspective(true);
  r.viewport.setOrbit(0.8, 0.7);
  const view = r.viewport;
  const motion = new CameraMotion({ view: () => view, size: () => ({ w: W, h: H }), heightUnder: () => 0 });
  return { view, motion };
}

/** Holds D for 600 ms, turns the wheel a notch at 300 ms; the view at each checkpoint (ms after T0). */
function run(frames: readonly number[], checkpoints: readonly number[]) {
  const { view, motion } = rig();
  const events: { t: number; act: () => void }[] = [
    { t: T0, act: () => motion.press('KeyD', false, T0) },
    { t: T0 + 300, act: () => motion.wheel(0.4, { x: 900, y: 500 }, T0 + 300) },
    { t: T0 + 600, act: () => motion.release('KeyD') },
  ];
  const times = new Set<number>();
  for (let t = T0 + 1, i = 0; t <= T0 + 2000; t += frames[i++ % frames.length]!) times.add(t);
  for (const c of checkpoints) times.add(T0 + c);
  // A frame at each event's time too: the release must be taken at its time in both runs.
  for (const e of events) times.add(e.t);
  const seen = new Map<number, { x: number; y: number; zoom: number }>();
  for (const f of [...times].sort((a, b) => a - b)) {
    // Frame first (the glide up to now), then the events of this instant.
    motion.step(f);
    for (const e of events) if (e.t === f) e.act();
    seen.set(f - T0, { x: view.centre.x, y: view.centre.y, zoom: view.zoom });
  }
  return { seen, motion };
}

describe("the camera's glide", () => {
  const checkpoints = Array.from({ length: 40 }, (_, i) => (i + 1) * 50);
  it('a held key and a notch of the wheel give the same view at the same time at any frame rate', () => {
    const a = run([16], checkpoints);
    const b = run([16, 7, 33, 16, 50], checkpoints);
    for (const c of checkpoints) {
      const sa = a.seen.get(c)!, sb = b.seen.get(c)!;
      expect(Math.hypot(sa.x - sb.x, sa.y - sb.y)).toBeLessThan(m(0.02));
      expect(Math.abs(Math.log(sa.zoom / sb.zoom))).toBeLessThan(1e-4);
    }
    expect(b.motion.moving).toBe(false);
  });

  it('at 150 ms a frame (no frame in between) it ends where it ends at 60 frames a second', () => {
    const a = run([16], []);
    const b = run([150], []);
    const end = (r: ReturnType<typeof run>) => r.seen.get(Math.max(...r.seen.keys()))!;
    const sa = end(a), sb = end(b);
    expect(b.motion.moving).toBe(false);
    // The slide's speed is in screen pixels, so it hangs on the zoom the wheel
    // is changing meanwhile: two coupled glides, exact each alone, agree to a
    // part in a thousand of the ground covered (it was a sixth short, cut to
    // 0.1 s a step).
    const travel = Math.hypot(sa.x, sa.y);
    expect(travel).toBeGreaterThan(m(10));
    expect(Math.hypot(sa.x - sb.x, sa.y - sb.y)).toBeLessThan(travel * 0.003);
    expect(Math.abs(Math.log(sa.zoom / sb.zoom))).toBeLessThan(1e-4);
  });

  it('counts the first step from the key, not from a frame drawn a minute before', () => {
    const { view, motion } = rig();
    motion.step(T0 - 60_000);
    const before = view.centre;
    motion.press('KeyD', false, T0);
    motion.step(T0 + 16);
    const moved = Math.hypot(view.centre.x - before.x, view.centre.y - before.y);
    // 16 ms of a glide starting from rest: well under a frame at full speed (700 px/s at this zoom).
    expect(moved).toBeLessThan((700 / view.zoom) * 0.016);
    expect(moved).toBeGreaterThan(0);
  });
});
