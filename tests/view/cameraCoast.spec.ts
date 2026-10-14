import { describe, expect, it } from 'vitest';

import { createIsoRig } from '@render/isoViewport';
import { CameraGestures, type PointerSample } from '@view/cameraGestures';
import { m } from '@world/units';

/**
 * THE CAMERA'S DRAG AND ITS COAST (`view/cameraGestures.ts`), driven as the
 * browser drives it: the mouse sampled every 8 ms, the samples coalesced into
 * one `pointermove` per animation frame (Chrome aligns them to the frame), the
 * release sent at once, each with its own time stamp; on the game's own rig
 * (`render/isoViewport.ts`), orthographic and perspective.
 *
 * The camera must take the same path whatever the frames: at 60 frames a
 * second, at a ragged 7-50 ms, at 10. And letting go must not change the
 * motion: the view goes on as the hand was moving it, then slows.
 */
const W = 1280;
const H = 720;
const MOUSE_MS = 8;
const T0 = 1000;

interface State { t: number; cx: number; cy: number; az: number; el: number }

interface Drag {
  perspective: boolean;
  kind: 'pan' | 'orbit';
  from: { x: number; y: number };
  /** The hand's speed, CSS px/s. */
  v: { x: number; y: number };
  /** How long the hand drags before letting go, ms (a multiple of the mouse's 8 ms). */
  dragMs: number;
  /** The frames' lengths, ms, cycled. */
  frames: readonly number[];
  /** Frames drawn at these times as well, ms after the press. */
  extra?: readonly number[];
  /** How long after the press the run goes on, ms. */
  endMs: number;
  /** The view's half height, world units. */
  half?: number;
}

/** One drag, frame by frame: the camera's state at every frame and at the release. */
function run(d: Drag): { states: State[]; up: number; gestures: CameraGestures } {
  const rig = createIsoRig({ x: 0, y: 0 }, d.half ?? m(40));
  rig.resize(W, H);
  rig.setGround(() => 0);
  rig.setPerspective(d.perspective);
  rig.viewport.setOrbit(0.8, 0.7);
  const view = rig.viewport;
  const gestures = new CameraGestures({ view: () => view, size: () => ({ w: W, h: H }), orbited: () => {}, redraw: () => {}, heightUnder: () => 0 });
  const at = (t: number) => ({ x: d.from.x + (d.v.x * (t - T0)) / 1000, y: d.from.y + (d.v.y * (t - T0)) / 1000 });
  const up = T0 + d.dragMs + 3;
  const mouse: PointerSample[] = [];
  for (let t = T0 + MOUSE_MS; t <= T0 + d.dragMs; t += MOUSE_MS) mouse.push({ ...at(t), t });
  const times = new Set<number>();
  for (let t = T0, i = 0; t <= T0 + d.endMs; t += d.frames[i++ % d.frames.length]!) times.add(t);
  for (const e of d.extra ?? []) times.add(T0 + e);
  const frames = [...times].filter((t) => t > T0).sort((a, b) => a - b);

  gestures.press(1, d.from, T0);
  if (d.kind === 'pan') gestures.startPan(1, d.from);
  else gestures.startOrbit(1, d.from, false, 0);
  const states: State[] = [];
  const record = (t: number) => states.push({ t, cx: view.centre.x, cy: view.centre.y, az: view.azimuth, el: view.elevation });
  let next = 0;
  /** The mouse's samples up to `t` as one coalesced move. */
  const dispatch = (t: number) => {
    const path: PointerSample[] = [];
    while (next < mouse.length && mouse[next]!.t <= t) path.push(mouse[next++]!);
    const last = path[path.length - 1];
    if (last) gestures.move(1, { x: last.x, y: last.y }, last.t, path);
  };
  let released = false;
  for (const f of frames) {
    if (!released && f >= up) {
      // The release comes at once, after the moves still waiting (Chrome flushes them first).
      dispatch(up);
      gestures.release(1, up);
      released = true;
      record(up);
    }
    if (!released) dispatch(f);
    gestures.advance(f);
    record(f);
  }
  return { states, up, gestures };
}

const at = (states: State[], t: number): State => {
  const s = states.find((x) => Math.abs(x.t - t) < 1e-9);
  if (!s) throw new Error(`no frame at ${t}`);
  return s;
};

/** Every 20 ms from the press to the end: frames both runs draw. */
const checkpoints = (endMs: number) => Array.from({ length: Math.floor(endMs / 20) }, (_, i) => (i + 1) * 20);

const REGULAR = [16];
const RAGGED = [16, 7, 33, 16, 50];

describe('the camera takes the same path at any frame rate', () => {
  for (const perspective of [false, true]) {
    for (const kind of ['pan', 'orbit'] as const) {
      it(`${kind}, ${perspective ? 'perspective' : 'orthographic'}: frames of 16 ms and of 7-50 ms give the same view at the same time`, () => {
        const drag = {
          perspective, kind, from: { x: 640, y: 560 }, v: { x: -900, y: -250 }, dragMs: 240, endMs: 2400,
          extra: checkpoints(2400),
        };
        const a = run({ ...drag, frames: REGULAR });
        const b = run({ ...drag, frames: RAGGED });
        for (const c of checkpoints(2400)) {
          const sa = at(a.states, T0 + c), sb = at(b.states, T0 + c);
          expect(Math.hypot(sa.cx - sb.cx, sa.cy - sb.cy)).toBeLessThan(m(0.02));
          expect(Math.abs(sa.az - sb.az)).toBeLessThan(1e-6);
          expect(Math.abs(sa.el - sb.el)).toBeLessThan(1e-6);
        }
        // And the coast did run: the view moved on after the release.
        const end = a.states[a.states.length - 1]!, release = at(a.states, a.up);
        const went = kind === 'orbit' ? Math.abs(end.az - release.az) : Math.hypot(end.cx - release.cx, end.cy - release.cy);
        expect(went).toBeGreaterThan(kind === 'orbit' ? 0.5 : m(1));
      });
    }
  }
});

describe('letting go does not change the motion', () => {
  /** The view's velocity over [t0, t1]: centre (units/s) and bearing (rad/s). */
  const velocity = (states: State[], t0: number, t1: number) => {
    const a = at(states, t0), b = at(states, t1), s = (t1 - t0) / 1000;
    let daz = b.az - a.az;
    daz = Math.atan2(Math.sin(daz), Math.cos(daz));
    return { x: (b.cx - a.cx) / s, y: (b.cy - a.cy) / s, az: daz / s };
  };

  for (const perspective of [false, true]) {
    for (const kind of ['pan', 'orbit'] as const) {
      // Grabbed low on the screen, off the centre: where the scale under the
      // hand and the pivot of the turn are not the view's centre's.
      it(`${kind}, ${perspective ? 'perspective' : 'orthographic'}, grabbed off the centre: the same speed and way just before and just after`, () => {
        const dragMs = 240;
        const up = dragMs + 3;
        // The hand's last 16 ms (two mouse samples, at up-19 and up-3) and the coast's first 16 ms.
        const extra = [up - 19, up - 3, up + 16];
        const r = run({ perspective, kind, from: { x: 300, y: 620 }, v: { x: 700, y: -120 }, dragMs, frames: REGULAR, extra, endMs: 1500 });
        const before = velocity(r.states, T0 + up - 19, T0 + up - 3);
        const after = velocity(r.states, r.up, T0 + up + 16);
        // Over its first 16 ms the coast keeps tau (1 - e^(-0.016/tau)) / 0.016 of its speed: 98 %.
        const decay = (0.45 * (1 - Math.exp(-0.016 / 0.45))) / 0.016;
        const vb = Math.hypot(before.x, before.y), va = Math.hypot(after.x, after.y);
        expect(vb).toBeGreaterThan(m(0.5));
        expect(va / (vb * decay)).toBeGreaterThan(0.95);
        expect(va / (vb * decay)).toBeLessThan(1.05);
        expect((before.x * after.x + before.y * after.y) / (vb * va)).toBeGreaterThan(0.995);
        if (kind === 'orbit') expect(after.az / (before.az * decay)).toBeCloseTo(1, 2);
      });

      it(`${kind}, ${perspective ? 'perspective' : 'orthographic'}: after the release the view slows without turning back`, () => {
        const r = run({ perspective, kind, from: { x: 300, y: 620 }, v: { x: 700, y: -120 }, dragMs: 240, frames: RAGGED, endMs: 3000 });
        const after = r.states.filter((s) => s.t >= r.up);
        let last: { x: number; y: number; az: number; speed: number } | null = null;
        for (let i = 1; i < after.length; i++) {
          const a = after[i - 1]!, b = after[i]!;
          const s = (b.t - a.t) / 1000;
          if (s <= 0) continue;
          const v = { x: (b.cx - a.cx) / s, y: (b.cy - a.cy) / s, az: (b.az - a.az) / s, speed: 0 };
          v.speed = Math.hypot(v.x, v.y) + Math.abs(v.az) * 100;
          if (v.speed < 1e-6) continue;
          if (last) {
            // Never back the other way, never faster again (an average over a longer frame is lower).
            expect(v.x * last.x + v.y * last.y + v.az * last.az * 1e4).toBeGreaterThanOrEqual(0);
            expect(v.speed).toBeLessThanOrEqual(last.speed * 1.0001);
          }
          last = v;
        }
        expect(r.gestures.coasting).toBe(false);
      });
    }
  }
});

describe("the hand's speed, read at the events' own times", () => {
  it('a fling at 10 frames a second coasts as at 60, and comes to rest at the same place', () => {
    // No frame in between: each move carries 100 ms of the mouse's samples, and
    // the release comes 43 ms after the last frame. Read at the handler's time,
    // the hand had "stopped" 43 ms before letting go and nothing coasted.
    for (const kind of ['pan', 'orbit'] as const) {
      // Both runs draw a frame at 4 s, after either coast has ended (an orbit's by 2.8 s).
      const drag = { perspective: true, kind, from: { x: 640, y: 560 }, v: { x: -900, y: 0 }, dragMs: 240, endMs: 4000 };
      const slow = run({ ...drag, frames: [100] });
      const fast = run({ ...drag, frames: REGULAR });
      const a = slow.states[slow.states.length - 1]!, b = fast.states[fast.states.length - 1]!;
      const released = at(slow.states, slow.up);
      expect(kind === 'pan' ? Math.hypot(a.cx - released.cx, a.cy - released.cy) : Math.abs(a.az - released.az))
        .toBeGreaterThan(kind === 'pan' ? m(1) : 0.5);
      expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeLessThan(m(0.02));
      expect(Math.abs(a.az - b.az)).toBeLessThan(1e-6);
    }
  });

  /** A pan of `steps` moves of `px` every `ms`, all at once on the gestures; the coast it throws. */
  const fling = (steps: number, px: number, ms: number, pause = 0) => {
    const rig = createIsoRig({ x: 0, y: 0 }, m(40));
    rig.resize(W, H);
    const view = rig.viewport;
    const gestures = new CameraGestures({ view: () => view, size: () => ({ w: W, h: H }), orbited: () => {}, redraw: () => {}, heightUnder: () => 0 });
    let t = T0;
    gestures.press(1, { x: 100, y: 300 }, t);
    gestures.startPan(1, { x: 100, y: 300 });
    for (let i = 1; i <= steps; i++) {
      t += ms;
      gestures.move(1, { x: 100 + i * px, y: 300 }, t);
    }
    gestures.release(1, t + pause);
    return (gestures as unknown as { coast: { pxSpeed: number } | null }).coast;
  };

  it('caps the speed a flick throws the view with, however fast the hand', () => {
    // 600 px in 20 ms (30 000 px/s).
    const coast = fling(10, 60, 2);
    expect(coast).not.toBeNull();
    expect(coast!.pxSpeed).toBeLessThanOrEqual(4000 + 1e-6);
  });

  it('throws nothing from moves bunched into a few milliseconds (too little to read a speed from)', () => {
    expect(fling(10, 30, 1)).toBeNull();
  });

  it('reads a steady drag at its real speed', () => {
    // 8 px every 16 ms: 500 px/s.
    expect(fling(20, 8, 16)!.pxSpeed).toBeCloseTo(500, -1);
  });

  it('throws nothing when the hand stopped before letting go', () => {
    expect(fling(10, 8, 16, 120)).toBeNull();
  });
});
