import { describe, expect, it } from 'vitest';

import { DEFAULT_ELEVATION, MAX_HALF_HEIGHT, MIN_HALF_HEIGHT, createIsoRig } from '@render/isoViewport';
import { EYE_HEIGHT, FAR_TILT, NEAR_MIN_TILT, minTilt, profileTilt } from '@view/cameraProfile';
import { CameraGestures } from '@view/cameraGestures';
import { TUNED_UNIT } from '@world/units';

/** The 0.4 m unit these scenes were laid out in: lengths below in it, times U. */
const U = TUNED_UNIT;

/** The perspective camera from the overview down to the street (the player, 2026-10-09: "descer mais a vista e não travar") */
const W = 1280;
const H = 720;

function perspective(ground = (_x: number, _y: number) => 0, half = 400) {
  const r = createIsoRig({ x: 0, y: 0 }, half);
  r.resize(W, H);
  r.setGround(ground);
  r.setPerspective(true);
  return r;
}

const hills = (x: number, y: number): number => 8 * Math.sin(x / 90) * Math.cos(y / 70) + 20;

describe('camera from the overview to the street', () => {
  it('keeps the game\'s tilt far away and eases to nearly level close up', () => {
    expect(profileTilt(MAX_HALF_HEIGHT)).toBeCloseTo(FAR_TILT, 9);
    expect(profileTilt(MIN_HALF_HEIGHT)).toBeLessThan((10 * Math.PI) / 180);
    expect(minTilt(MIN_HALF_HEIGHT)).toBeCloseTo(NEAR_MIN_TILT, 9);
  });

  it('the wheel walks from the overview to a pedestrian view with no jump in tilt or eye', () => {
    const r = perspective(hills);
    const v = r.viewport;
    expect(v.elevation).toBeCloseTo(DEFAULT_ELEVATION, 6);
    let last = v.eye!;
    let lastTilt = v.elevation;
    for (let i = 0; i < 120; i++) {
      v.zoomAt(W / 2, H / 2, 1.06, W, H, hills(v.centre.x, v.centre.y));
      const eye = v.eye!;
      // No jump: each notch moves the eye a share of its distance, the tilt a few degrees.
      const step = Math.hypot(eye.x - last.x, eye.y - last.y, eye.z - last.z);
      const range = Math.hypot(last.x - v.centre.x, last.y - v.centre.y, last.z - hills(v.centre.x, v.centre.y));
      expect(step).toBeLessThan(range * 0.25 + 1);
      expect(Math.abs(v.elevation - lastTilt)).toBeLessThan((4 * Math.PI) / 180);
      // Never under the ground.
      expect(eye.z).toBeGreaterThan(hills(eye.x, eye.y));
      last = eye;
      lastTilt = v.elevation;
    }
    // A person's view: eyes at about 1.7-2.5 m over the ground, looking almost level.
    const eye = v.eye!;
    const over = eye.z - hills(eye.x, eye.y);
    expect(over).toBeGreaterThan(EYE_HEIGHT * 0.8);
    expect(over).toBeLessThan(EYE_HEIGHT * 1.6);
    expect(v.elevation).toBeLessThan((10 * Math.PI) / 180);
  });

  it('tilts below level close up to look up at a facade, and never puts the eye under the ground', () => {
    const r = perspective(() => 0, MIN_HALF_HEIGHT);
    const v = r.viewport;
    v.orbit(0, -2);
    expect(v.elevation).toBeCloseTo(NEAR_MIN_TILT, 6);
    expect(v.eye!.z).toBeGreaterThanOrEqual(4 * U - 1e-9);
    v.orbit(0, 5);
    expect(v.elevation).toBeCloseTo(Math.PI / 2, 6);
  });

  it('turns a full circle at street level', () => {
    const r = perspective(() => 0, MIN_HALF_HEIGHT);
    const v = r.viewport;
    const c = v.centre;
    for (let i = 0; i < 24; i++) {
      v.orbit(Math.PI / 12, 0);
      expect(Math.hypot(v.centre.x - c.x, v.centre.y - c.y)).toBeLessThan(1e-9);
    }
  });

  // The player, 2026-10-10: the closest zoom lands on the ground and stops (master 2feec96a).
  it('stops at the closest view: more zoom moves nothing', () => {
    const r = perspective(() => 0, MIN_HALF_HEIGHT);
    const v = r.viewport;
    const c = v.centre;
    const eye = v.eye!;
    for (let i = 0; i < 20; i++) v.zoomAt(W / 2, H / 2 + 100, 1.5, W, H, 0);
    expect(Math.hypot(v.centre.x - c.x, v.centre.y - c.y)).toBe(0);
    expect(Math.hypot(v.eye!.x - eye.x, v.eye!.y - eye.y, v.eye!.z - eye.z)).toBe(0);
    expect(v.zoom).toBeCloseTo(H / (MIN_HALF_HEIGHT * 2), 9);
  });

  // The player, 2026-10-10: looking up from the street turned the picture upside down.
  it('keeps the sky up and the ground down at every tilt', () => {
    const r = perspective(() => 0, MIN_HALF_HEIGHT);
    const v = r.viewport;
    for (const tilt of [-2, -0.3, -0.05, 0, 0.05, 0.5, 1, 5]) {
      v.setOrbit(v.azimuth, tilt);
      const c = r.camera;
      c.updateMatrixWorld(true);
      // The camera's up (its matrix's second column) never points down, and has no roll.
      const e = c.matrixWorld.elements;
      expect(e[5]).toBeGreaterThanOrEqual(-1e-9);
      const right = { x: e[0]!, y: e[1]!, z: e[2]! };
      expect(Math.abs(right.y)).toBeLessThan(1e-6);
    }
  });

  // The player, 2026-10-10: close over the ground a drag jumped the view backwards.
  it('a drag in the street never jumps: over the horizon it slides by the drag', () => {
    const r = perspective(() => 0, MIN_HALF_HEIGHT);
    const v = r.viewport;
    const hand = new CameraGestures({
      view: () => v,
      size: () => ({ w: W, h: H }),
      orbited: () => {},
      redraw: () => {},
      heightUnder: () => 0,
    });
    for (const y of [5, H / 2 - 40, H / 2, H / 2 + 200, H - 5]) {
      const c = v.centre;
      hand.press(1, { x: W / 2, y });
      hand.startPan(1, { x: W / 2, y });
      let last = c;
      for (let i = 1; i <= 10; i++) {
        hand.move(1, { x: W / 2 + i * 4, y: y + i * 3 });
        const now = v.centre;
        // Each 5 px of hand moves the view a little, never across the street.
        expect(Math.hypot(now.x - last.x, now.y - last.y)).toBeLessThan(2);
        last = now;
      }
      hand.release(1);
    }
  });

  it('a pointer over the horizon zooms without throwing the view across the map', () => {
    const r = perspective(() => 0, 6);
    const v = r.viewport;
    v.orbit(0, -1);
    const c = v.centre;
    v.zoomAt(W / 2, 5, 0.8, W, H, 0);
    expect(Math.hypot(v.centre.x - c.x, v.centre.y - c.y)).toBeLessThan(5);
  });

  // A tower 80 m high in an 8 x 8 m box, its floor falling to nothing 1.2 m outside.
  const tower = (x: number, y: number): number => {
    const d = Math.max(Math.abs(x) - 10 * U, Math.abs(y) - 10 * U, 0);
    const t = Math.max(0, 1 - d / (3 * U));
    return 200 * U * t * t * (3 - 2 * t);
  };

  // Brought in at once when a building comes between, as Cinemachine's Deoccluder
  it('is brought in front of a building between it and the point looked at, in the street', () => {
    const r = perspective(() => 0, 8 * U);
    r.setSolids(tower);
    const v = r.viewport;
    // Facing +x on the map, the point looked at just past the tower's far face.
    v.setOrbit(Math.PI, DEFAULT_ELEVATION);
    v.moveTo({ x: 16 * U, y: -40 * U });
    const full = Math.hypot(v.eye!.x - v.centre.x, v.eye!.y - v.centre.y);
    let pulled = 0;
    for (let i = 0; i < 160; i++) {
      v.slide(-0.5 * U, 0);
      const eye = v.eye!;
      // Never inside nor behind the tower.
      expect(eye.z).toBeGreaterThanOrEqual(tower(eye.x, eye.y) - 1e-3 * U);
      if (Math.hypot(eye.x - v.centre.x, eye.y - v.centre.y) < 20 * U) pulled++;
      // Brought in, never past the point looked at.
      expect(Math.hypot(eye.x - v.centre.x, eye.y - v.centre.y)).toBeLessThanOrEqual(full + 1e-6);
    }
    expect(pulled).toBeGreaterThan(10);
  });

  it('is never held among the towers far away: the overview keeps its distance', () => {
    const r = perspective(() => 0, 400);
    const free = r.viewport.eye!;
    r.setSolids(tower);
    r.viewport.setOrbit(r.viewport.azimuth, r.viewport.elevation);
    const eye = r.viewport.eye!;
    expect(Math.hypot(eye.x - free.x, eye.y - free.y, eye.z - free.z)).toBeLessThan(1e-6);
  });

  it('never blocks the view: the point looked at goes through a building', () => {
    const r = perspective(() => 0, MIN_HALF_HEIGHT);
    r.setSolids(tower);
    const v = r.viewport;
    v.setOrbit(Math.PI, DEFAULT_ELEVATION);
    v.moveTo({ x: -30, y: 0 });
    for (let i = 0; i < 120; i++) v.slide(0, 0.5);
    expect(v.centre.x).toBeGreaterThan(25);
  });
});
