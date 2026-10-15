import type { Vec2 } from '@core/vec2';
import { clamp } from '@core/scalar';
import type { Viewport } from './viewport';

/** What the camera's gestures read of the game and do to it. */
export interface CameraGesturesHost {
  /** The view the pointer moves (it is replaced when the renderer changes). */
  view(): Viewport;
  /** The canvas's size, CSS px. */
  size(): { readonly w: number; readonly h: number };
  /** The camera turned: its bearing and tilt are kept with the settings. */
  orbited(): void;
  redraw(): void;
  /** The height of what is drawn under a pointer (CSS px): the plane a pan or pinch holds. */
  heightUnder(at: Vec2): number;
}

/** Camera turn and tilt per CSS pixel of an orbit drag, rad: a full turn in ~1000 px. */
const ORBIT_PER_PX = 0.0063;
/** Which way a twist of two fingers turns the camera, so the map turns with them */
const TWIST_SIGN = -1;
/** How far a press may travel, CSS px, and still be a click rather than a drag. */
const CLICK_SLOP = 5;
/** Below this many CSS px between the fingers a twist is noise, not a turn. */
const TWIST_MIN_SPREAD = 40;
/** The camera's coast after a drag is let go (three's OrbitControls `enableDamping`, Cesium's `inertiaSpin`) */
const COAST_DECAY_S = 0.45;
/** Below this the coast is over: orbit rad/s, pan CSS px/s of the hand. */
const COAST_MIN_ORBIT = 0.02;
const COAST_MIN_PAN = 6;
/** DO NOT read `performance.now()` in the handler instead: Chrome holds `pointermove` until the next animation frame */
const SPEED_HORIZON_MS = 100;
const SPEED_STOPPED_MS = 40;
const MAX_FLING_PX_S = 4000;
/** The longest step a coast takes at once, s: the closed form holds for any step; this only bounds a resume after the tab slept. */
const COAST_MAX_STEP_S = 1;

/** A pointer position at a time: CSS px of the canvas, and the event's time stamp (ms, `performance.now()`'s clock). */
export interface PointerSample {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

/** DO NOT coast an orbit about the view's centre or a pan by the scale at the centre */
type Coast =
  | { kind: 'orbit'; vx: number; vy: number; pxSpeed: number; at: number; pivot: { px: number; py: number; height: number } }
  | { kind: 'pan'; vx: number; vy: number; pxSpeed: number; at: number }
  | { kind: 'slide'; vx: number; vy: number; pxSpeed: number; at: number };

/** THE CAMERA'S GESTURES: the pointers on the canvas, a pan, an orbit, a two-finger pinch */
export class CameraGestures {
  private readonly pointers = new Map<number, Vec2>();
  /** A pan: the ground point held, or none (`grabbed` null) when it slides by the drag; `last` the pointer, CSS px. */
  private pan: { id: number; grabbed: Vec2 | null; height: number; last: Vec2 } | null = null;
  /** An orbit: where it was pressed and last was, CSS px; a right click that stays a click cancels the gesture in progress. */
  private orbit: { id: number; last: Vec2; pressed: Vec2; moved: boolean; cancelOnClick: boolean; height: number } | null = null;
  private pinch: { d0: number; zoom0: number; world: Vec2; height: number; angle: number } | null = null;
  /** When the last pointer went down, ms (the event's time). */
  private pressedAt = 0;
  /** The drag's recent course (`SPEED_HORIZON_MS`): the pointer's positions, CSS px, at the events' times. */
  private samples: PointerSample[] = [];
  /** The camera coasting after a drag let go (`advance`). */
  private coast: Coast | null = null;

  constructor(private readonly host: CameraGesturesHost) {}

  /** Something of the camera is being moved by hand. */
  get active(): boolean {
    return this.pan !== null || this.orbit !== null || this.pinch !== null;
  }

  get pinching(): boolean {
    return this.pinch !== null;
  }

  /** Pointers on the canvas now. */
  get touches(): number {
    return this.pointers.size;
  }

  has(id: number): boolean {
    return this.pointers.has(id);
  }

  /** DO NOT write the player's text here. */
  gesture(): string | null {
    if (this.pinch) return 'gesture.camera.pinch';
    if (this.orbit) return 'gesture.camera.orbit';
    if (this.pan) return 'gesture.camera.pan';
    return null;
  }

  /** A pointer pressed at `screen`, CSS px, at `time` (the event's, ms): a coast in progress is caught. */
  press(id: number, screen: Vec2, time = performance.now()): void {
    this.pointers.set(id, screen);
    this.pressedAt = time;
    this.coast = null;
  }

  /** The camera still coasting after a drag: the frame loop keeps going. */
  get coasting(): boolean {
    return this.coast !== null;
  }

  /** The drag's course starts at `at`, where it was pressed. */
  private startTrack(at: Vec2): void {
    this.samples.length = 0;
    this.samples.push({ x: at.x, y: at.y, t: this.pressedAt });
  }

  /** The pointer was at (x, y) at `t`, ms: kept while within `SPEED_HORIZON_MS` of the newest. */
  private track(x: number, y: number, t: number): void {
    const list = this.samples;
    const last = list[list.length - 1];
    // The coalesced list is in time order (Pointer Events 3); a clock that stepped back would make a slope of nothing.
    const time = last && t < last.t ? last.t : t;
    list.push({ x, y, t: time });
    while (list.length > 2 && time - list[0]!.t > SPEED_HORIZON_MS) list.shift();
  }

  /** The hand's speed as it let go, CSS px/s: the slope of a line fitted by least squares to the last samples */
  private handSpeed(): { x: number; y: number } {
    const list = this.samples;
    if (list.length < 2) return { x: 0, y: 0 };
    const t0 = list[0]!.t, span = list[list.length - 1]!.t - t0;
    if (span < 16) return { x: 0, y: 0 };
    let st = 0, sx = 0, sy = 0, stt = 0, stx = 0, sty = 0;
    for (const p of list) {
      const t = (p.t - t0) / 1000;
      st += t; sx += p.x; sy += p.y; stt += t * t; stx += t * p.x; sty += t * p.y;
    }
    const n = list.length, d = n * stt - st * st;
    if (Math.abs(d) < 1e-12) return { x: 0, y: 0 };
    return { x: (n * stx - st * sx) / d, y: (n * sty - st * sy) / d };
  }

  /** A drag let go at `time` (the release's own time stamp, ms) */
  private throwCoast(time: number): void {
    const list = this.samples;
    const newest = list[list.length - 1];
    const moving = newest !== undefined && time - newest.t < SPEED_STOPPED_MS;
    let { x: vx, y: vy } = this.handSpeed();
    this.samples = [];
    const v = Math.hypot(vx, vy);
    if (v > MAX_FLING_PX_S) { vx *= MAX_FLING_PX_S / v; vy *= MAX_FLING_PX_S / v; }
    const pxSpeed = Math.min(v, MAX_FLING_PX_S);
    if (!moving || !newest) return;
    const orbit = this.orbit, pan = this.pan;
    if (orbit) {
      if (pxSpeed * ORBIT_PER_PX <= COAST_MIN_ORBIT) return;
      this.coast = {
        kind: 'orbit', vx: vx * ORBIT_PER_PX, vy: vy * ORBIT_PER_PX, pxSpeed, at: time,
        pivot: { px: orbit.pressed.x, py: orbit.pressed.y, height: orbit.height },
      };
      return;
    }
    if (!pan || pxSpeed <= COAST_MIN_PAN) return;
    if (!pan.grabbed) {
      this.coast = { kind: 'slide', vx, vy, pxSpeed, at: time };
      return;
    }
    // The ground under the hand moved at J v
    const view = this.host.view();
    const { w, h } = this.host.size();
    const p = pan.last;
    const ax = view.toWorldAt(p.x - 1, p.y, pan.height, w, h), bx = view.toWorldAt(p.x + 1, p.y, pan.height, w, h);
    const ay = view.toWorldAt(p.x, p.y - 1, pan.height, w, h), by = view.toWorldAt(p.x, p.y + 1, pan.height, w, h);
    const gx = ((bx.x - ax.x) * vx + (by.x - ay.x) * vy) / 2;
    const gy = ((bx.y - ax.y) * vx + (by.y - ay.y) * vy) / 2;
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
    this.coast = { kind: 'pan', vx: -gx, vy: -gy, pxSpeed, at: time };
  }

  /** Takes the coast to `now` (ms, the frame's time on the events' clock): true when the camera moved. */
  advance(now: number): boolean {
    const coast = this.coast;
    if (!coast) return false;
    // It ends when the hand's speed has decayed to the least one, at a time of its own
    const least = coast.kind === 'orbit' ? COAST_MIN_ORBIT / ORBIT_PER_PX : COAST_MIN_PAN;
    const left = COAST_DECAY_S * Math.log(Math.max(1, coast.pxSpeed / least));
    const seconds = Math.min(COAST_MAX_STEP_S, left, Math.max(0, (now - coast.at) / 1000));
    coast.at = Math.max(coast.at, now);
    if (seconds === 0 && left > 0) return true;
    const view = this.host.view();
    const keep = Math.exp(-seconds / COAST_DECAY_S);
    const span = COAST_DECAY_S * (1 - keep);
    if (coast.kind === 'orbit') {
      // About the drag's own pivot, as the drag turned (`move`).
      view.orbit(coast.vx * span, coast.vy * span, coast.pivot);
      this.host.orbited();
    } else if (coast.kind === 'pan') {
      const c = view.centre;
      view.moveTo({ x: c.x + coast.vx * span, y: c.y + coast.vy * span });
    } else {
      // The slide's own sense and scale (`move`)
      const units = span / Math.max(1e-6, view.scaleAtCentre ?? view.zoom);
      view.slide(-coast.vx * units, coast.vy * units);
    }
    coast.vx *= keep;
    coast.vy *= keep;
    coast.pxSpeed *= keep;
    if (seconds >= left) this.coast = null;
    this.host.redraw();
    return true;
  }

  /** The point a pan or pinch holds under the pointer */
  private anchor(px: number, py: number): { world: Vec2; height: number } {
    const { w, h } = this.host.size();
    const height = this.host.heightUnder({ x: px, y: py });
    return { world: this.host.view().toWorldAt(px, py, height, w, h), height };
  }

  /** Two fingers (or more) down: a pinch from where they are. */
  startPinch(): void {
    const [a, b] = [...this.pointers.values()] as [Vec2, Vec2];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const held = this.anchor(mid.x, mid.y);
    this.pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y),
      zoom0: this.host.view().zoom,
      world: held.world,
      height: held.height,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  /** The camera swung round the ground under `at` (at `height`); `cancelOnClick`: a click cancels what is in progress. */
  startOrbit(id: number, at: Vec2, cancelOnClick: boolean, height: number): void {
    this.orbit = { id, last: at, pressed: at, moved: false, cancelOnClick, height };
    this.startTrack(at);
  }

  /** The ground under `at` grabbed and dragged. */
  startPan(id: number, at: Vec2): void {
    const held = this.anchor(at.x, at.y);
    const { w, h } = this.host.size();
    // Close over the ground, looking along the street, the pointer may be over the horizon or on ground far down the road
    const holds = this.host.view().holds(at.x, at.y, held.height, w, h);
    this.pan = { id, grabbed: holds ? held.world : null, height: held.height, last: at };
    this.startTrack(at);
  }

  /** Pointer `id` moved to `screen` at `time` (the event's time stamp, ms): true when the camera took the move. */
  move(id: number, screen: Vec2, time = performance.now(), path?: readonly PointerSample[]): boolean {
    if (this.pointers.has(id)) this.pointers.set(id, screen);
    const { host } = this;
    const view = host.view();
    const { w, h } = host.size();
    if (this.pinch && this.pointers.size >= 2) {
      const pinch = this.pinch;
      const [a, b] = [...this.pointers.values()] as [Vec2, Vec2];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const limits = view.zoomBounds;
      const targetZoom = clamp((pinch.zoom0 * d) / Math.max(1, pinch.d0), limits.min, limits.max);
      // A twist of the two fingers turns the camera with them
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const twist = Math.atan2(Math.sin(angle - pinch.angle), Math.cos(angle - pinch.angle));
      pinch.angle = angle;
      if (d > TWIST_MIN_SPREAD) view.orbit(TWIST_SIGN * twist, 0);
      view.zoomAt(mid.x, mid.y, targetZoom / Math.max(0.001, view.zoom), w, h, pinch.height);
      view.panTo(pinch.world, mid.x, mid.y, w, h, pinch.height);
      host.redraw();
      return true;
    }
    const orbit = this.orbit;
    const pan = this.pan;
    if (orbit?.id !== id && pan?.id !== id) return false;
    if (path && path.length > 0) for (const p of path) this.track(p.x, p.y, p.t);
    else this.track(screen.x, screen.y, time);
    if (orbit?.id === id) {
      if (!orbit.moved) {
        if (Math.hypot(screen.x - orbit.pressed.x, screen.y - orbit.pressed.y) < CLICK_SLOP) return true;
        orbit.moved = true;
      }
      const dx = screen.x - orbit.last.x;
      const dy = screen.y - orbit.last.y;
      orbit.last = screen;
      // A turntable: the near side of the map follows the hand; dragging down lifts the camera towards a plan view.
      view.orbit(dx * ORBIT_PER_PX, dy * ORBIT_PER_PX, { px: orbit.pressed.x, py: orbit.pressed.y, height: orbit.height });
      host.orbited();
      host.redraw();
      return true;
    }
    if (pan) {
      const dx = screen.x - pan.last.x, dy = screen.y - pan.last.y;
      if (pan.grabbed) view.panTo(pan.grabbed, screen.x, screen.y, w, h, pan.height);
      else {
        // The ground follows the hand: dragged right it goes right, dragged down it comes nearer.
        const unit = 1 / Math.max(1e-6, view.scaleAtCentre ?? view.zoom);
        view.slide(-dx * unit, dy * unit);
      }
      pan.last = screen;
      host.redraw();
      return true;
    }
    return false;
  }

  /** Pointer `id` let go at `time` (the release's time stamp, ms). */
  release(id: number, time = performance.now()): { wasPinching: boolean; clickCancels: boolean } {
    const wasPinching = this.pinch !== null;
    this.pointers.delete(id);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pan?.id === id) {
      if (!wasPinching) this.throwCoast(time);
      this.pan = null;
    }
    let clickCancels = false;
    if (this.orbit?.id === id) {
      clickCancels = this.orbit.cancelOnClick && !this.orbit.moved;
      if (this.orbit.moved) this.throwCoast(time);
      this.orbit = null;
    }
    return { wasPinching, clickCancels };
  }

  /** The gesture in progress cut short (a tool switch, undo, Escape): the pan and the orbit end. */
  cancel(): void {
    this.pan = null;
    this.orbit = null;
    this.coast = null;
  }

  /** Every press forgotten (the window lost focus, the capture was taken): its release will never arrive. */
  releaseAll(): void {
    this.cancel();
    this.pointers.clear();
    this.pinch = null;
  }
}
