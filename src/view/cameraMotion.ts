import type { Vec2 } from '@core/vec2';
import type { Viewport } from './viewport';

/**
 * THE CAMERA'S MOTION OVER TIME: the keys held and the wheel's notches turned
 * into a glide, frame by frame, instead of a jump per event.
 *
 * A key moved the view one step per `keydown`, so holding W moved it once,
 * stood still for the system's repeat delay (half a second) and then hopped
 * thirty times a second; a notch of the wheel zoomed in one frame. Here a
 * held key sets a velocity the camera eases into and out of, and a notch
 * adds to a pending zoom spent over the next frames, both with an
 * exponential approach measured in seconds, so the glide is the same at any
 * frame rate (three.js OrbitControls applies `dampingFactor` of the pending
 * motion each update; camera-controls and Unity's SmoothDamp spend it over a
 * `smoothTime` in seconds - the form used here). A drag with the mouse stays
 * direct, held to the hand (`cameraGestures.ts`).
 */

/** The camera's own keys, by `KeyboardEvent.code`. */
const KEYS: Readonly<Record<string, readonly [Axis, 1 | -1]>> = {
  KeyW: ['forward', 1], ArrowUp: ['forward', 1],
  KeyS: ['forward', -1], ArrowDown: ['forward', -1],
  KeyA: ['right', -1], ArrowLeft: ['right', -1],
  KeyD: ['right', 1], ArrowRight: ['right', 1],
  KeyQ: ['turn', -1], KeyE: ['turn', 1],
  // Tilt on Page Up/Down: R and F (Cities: Skylines II's zoom keys) are the
  // building's rotation and the walls tool here.
  PageUp: ['tilt', 1], PageDown: ['tilt', -1],
  Equal: ['zoom', 1], NumpadAdd: ['zoom', 1],
  Minus: ['zoom', -1], NumpadSubtract: ['zoom', -1],
};
type Axis = 'forward' | 'right' | 'turn' | 'tilt' | 'zoom';
const AXES: readonly Axis[] = ['forward', 'right', 'turn', 'tilt', 'zoom'];

/** The pan's speed in screen pixels a second: at the closest zoom about a walk (1.5 m/s), far away a map's width in a few seconds. */
const PAN_PX_PER_S = 700;
/** Turn, rad/s (a quarter turn in a second), tilt, rad/s, and zoom, log factor a second. */
const TURN_PER_S = 1.6;
const TILT_PER_S = 0.9;
const ZOOM_PER_S = 1.8;
/** Shift held: this much faster. */
const SHIFT = 3;
/** How long a held key takes to reach its speed and to stop, s (time constant). */
const EASE_S = 0.1;
/** How long a notch of the wheel takes to be spent, s (time constant). */
const ZOOM_EASE_S = 0.085;
/** How long a quarter turn by Shift+Q/E takes to be spent, s. */
const TURN_EASE_S = 0.12;

export interface MotionHost {
  view(): Viewport;
  size(): { readonly w: number; readonly h: number };
  /** The height of what is drawn under a screen point: the plane a zoom holds. */
  heightUnder(at: { x: number; y: number }): number;
}

/** An aimed turn (`aim`) is over when less than this is left, rad; under `AIM_SNAP` the rest is taken at once. */
const AIM_CLOSE = 1e-3;
const AIM_SNAP = 4e-3;
const AIM_MAX_S = 3;

export class CameraMotion {
  private readonly held = new Map<string, readonly [Axis, 1 | -1]>();
  private readonly velocity: Record<Axis, number> = { forward: 0, right: 0, turn: 0, tilt: 0, zoom: 0 };
  private shift = false;
  /**
   * Zoom still to spend (log factor), the screen point it is about, and the
   * ground point it holds there - picked once when the zoom began
   * (`Viewport.grab`), null over the sky or space (then it is about the
   * view's centre, as Cesium zooms with the pointer off the globe).
   */
  private pendingZoom = 0;
  private zoomAt: { x: number; y: number; height: number; grabbed: Vec2 | null } = { x: 0, y: 0, height: 0, grabbed: null };
  /** Turn still to spend, rad. */
  private pendingTurn = 0;
  /**
   * A heading being turned to (`aim`): what is still left of the turn, asked
   * again each frame, as the view now stands. Null when none.
   */
  private aiming: (() => number) | null = null;
  /** Seconds the aim has been turning: given up after `AIM_MAX_S`, so a heading never reached cannot hold the frames going. */
  private aimedFor = 0;

  constructor(private readonly host: MotionHost) {}

  /** A key went down: true when it is one of the camera's. */
  press(code: string, shift: boolean): boolean {
    const binding = KEYS[code];
    if (!binding) return false;
    this.held.set(code, binding);
    this.shift = shift;
    return true;
  }

  /** A key came up. */
  release(code: string, shift = false): void {
    this.held.delete(code);
    this.shift = shift;
  }

  /** Every key let go at once (the window lost focus). */
  releaseAll(): void {
    this.held.clear();
    this.shift = false;
  }

  /** Whether `code` is one of the camera's keys. */
  static owns(code: string): boolean {
    return code in KEYS;
  }

  /** A notch of the wheel: `logFactor` of zoom (positive: closer) about the screen point `at`. */
  wheel(logFactor: number, at: { x: number; y: number }): void {
    // A new point: what is left of the last notch goes to the new one.
    if (this.pendingZoom === 0 || Math.hypot(at.x - this.zoomAt.x, at.y - this.zoomAt.y) > 2) {
      const ground = this.host.heightUnder(at);
      const held = this.host.view().grab?.(at.x, at.y, ground) ?? null;
      this.zoomAt = { x: at.x, y: at.y, height: held ? held.height : ground, grabbed: held ? held.world : null };
    }
    this.pendingZoom += logFactor;
  }

  /** A turn to spend smoothly (Shift+Q/E's quarter turn), rad. */
  turn(angle: number): void {
    this.pendingTurn += angle;
  }

  /**
   * Turns smoothly to a heading (the compass's north): `left` gives the turn
   * still wanted (rad, `Viewport.orbit`'s azimuth) as the view stands, and is
   * asked again every frame - a closed loop, as a turn worked out once
   * misses where a step of the orbit does not turn the ground by just its
   * angle (out at the globe). Over when less than a milliradian is left.
   */
  aim(left: () => number): void {
    this.aiming = left;
    this.aimedFor = 0;
  }

  /** Stops everything at once. */
  stop(): void {
    this.held.clear();
    for (const axis of AXES) this.velocity[axis] = 0;
    this.pendingZoom = 0;
    this.pendingTurn = 0;
    this.aiming = null;
  }

  /** Something is still moving (or held): the frame loop keeps going. */
  get moving(): boolean {
    return this.held.size > 0 || this.pendingZoom !== 0 || this.pendingTurn !== 0 || this.aiming !== null
      || AXES.some((axis) => this.velocity[axis] !== 0);
  }

  /** Advances by `dt` seconds of wall time: true when the camera moved. */
  step(dt: number): boolean {
    if (!this.moving) return false;
    const seconds = Math.min(0.1, Math.max(0, dt));
    const view = this.host.view();
    const { w, h } = this.host.size();
    const goal: Record<Axis, number> = { forward: 0, right: 0, turn: 0, tilt: 0, zoom: 0 };
    for (const [axis, sign] of this.held.values()) goal[axis] += sign;
    const ease = 1 - Math.exp(-seconds / EASE_S);
    for (const axis of AXES) {
      const g = Math.max(-1, Math.min(1, goal[axis])) * (this.shift ? SHIFT : 1);
      let v = this.velocity[axis] + (g - this.velocity[axis]) * ease;
      if (g === 0 && Math.abs(v) < 0.002) v = 0;
      this.velocity[axis] = v;
    }
    const vel = this.velocity;
    if (vel.forward !== 0 || vel.right !== 0) {
      const units = (PAN_PX_PER_S / Math.max(1e-6, view.zoom)) * seconds;
      view.slide(vel.right * units, vel.forward * units);
    }
    let turn = vel.turn * TURN_PER_S * seconds;
    if (this.pendingTurn !== 0) {
      const spend = Math.abs(this.pendingTurn) < 1e-4 ? this.pendingTurn : this.pendingTurn * (1 - Math.exp(-seconds / TURN_EASE_S));
      this.pendingTurn -= spend;
      turn += spend;
    }
    if (this.aiming) {
      const left = this.aiming();
      this.aimedFor += seconds;
      if (!Number.isFinite(left) || Math.abs(left) < AIM_CLOSE || this.aimedFor > AIM_MAX_S) this.aiming = null;
      else turn += Math.abs(left) < AIM_SNAP ? left : left * (1 - Math.exp(-seconds / TURN_EASE_S));
    }
    const tilt = vel.tilt * TILT_PER_S * seconds;
    if (turn !== 0 || tilt !== 0) view.orbit(turn, tilt);
    if (vel.zoom !== 0) view.zoomAt(w / 2, h / 2, Math.exp(vel.zoom * ZOOM_PER_S * seconds), w, h, this.host.heightUnder({ x: w / 2, y: h / 2 }));
    if (this.pendingZoom !== 0) {
      const spend = Math.abs(this.pendingZoom) < 1e-4 ? this.pendingZoom : this.pendingZoom * (1 - Math.exp(-seconds / ZOOM_EASE_S));
      this.pendingZoom -= spend;
      const at = this.zoomAt;
      if (at.grabbed) view.zoomAt(at.x, at.y, Math.exp(spend), w, h, at.height, at.grabbed);
      else view.zoomAt(w / 2, h / 2, Math.exp(spend), w, h, this.host.heightUnder({ x: w / 2, y: h / 2 }));
    }
    return true;
  }
}
