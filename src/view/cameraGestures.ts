import type { Vec2 } from '@core/vec2';
import { clamp } from '@core/scalar';
import { PLANET_RADIUS } from '@core/cubeSphere';
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
/**
 * Which way a twist of two fingers turns the camera, so the map turns with
 * them: a positive orbit turns the map anticlockwise on screen, and a
 * clockwise twist grows the angle between the fingers.
 */
const TWIST_SIGN = -1;
/** How far a press may travel, CSS px, and still be a click rather than a drag. */
const CLICK_SLOP = 5;
/** Below this many CSS px between the fingers a twist is noise, not a turn. */
const TWIST_MIN_SPREAD = 40;
/**
 * The camera's coast after a drag is let go (three's OrbitControls
 * `enableDamping`, Cesium's `inertiaSpin`): it goes on at the speed the hand
 * left it with and slows by e every this many seconds - per second of wall
 * time, not per frame, so it coasts alike at any frame rate.
 */
const COAST_DECAY_S = 0.45;
/** Below this the coast is over: orbit rad/s, pan CSS px/s. */
const COAST_MIN_ORBIT = 0.02;
const COAST_MIN_PAN = 6;
/**
 * Out this far towards the whole globe (`Viewport.globe`), a drag with either
 * button turns the camera round the planet as a trackball: the ground under
 * the hand goes with it at the pixel rate it is drawn at, in any direction,
 * over every face. Holding the grabbed ground point instead (a pan's rule)
 * lost it at the globe's limb, and the planet jumped.
 */
const GLOBE_SPIN = 0.12;
/**
 * How the hand's speed is read when a drag is let go, as Android's
 * VelocityTracker reads a fling (AOSP libs/input/VelocityTracker.cpp): a line
 * fitted to the samples of the last `SPEED_HORIZON_MS` (one event's move over
 * its own interval read 10 px coalesced into one millisecond as 10 000 px/s),
 * none if the hand had stopped `SPEED_STOPPED_MS` before letting go, and never
 * above `MAX_FLING_PX_S` (its maxVelocity).
 */
const SPEED_HORIZON_MS = 100;
const SPEED_STOPPED_MS = 40;
const MAX_FLING_PX_S = 4000;
/**
 * The most ground a coast may carry the view over at the globe (an arc, world
 * units): an eighth of the way round. At the hand's own speed a flick spun the
 * planet ten times over in four seconds (the player, 2026-10-10: the view
 * would not cross the globe smoothly).
 */
const GLOBE_COAST_ARC = (PLANET_RADIUS * Math.PI) / 4;

/**
 * THE CAMERA'S GESTURES: the pointers on the canvas, a pan, an orbit, a
 * two-finger pinch - with the handlers that move the view by them. Each
 * pointer's last position is kept by its id and taken away on release
 * (MDN, "Pinch zoom gestures"); two at once are a pinch whose spread zooms,
 * whose twist turns and whose middle holds the ground under it.
 *
 * A pan holds the GROUND POINT that was grabbed under the pointer, not a
 * screen delta over the zoom: the two agree only looking straight down,
 * and holding the point is one rule for every view (`Viewport.panTo`).
 */
export class CameraGestures {
  private readonly pointers = new Map<number, Vec2>();
  /** A pan: the ground point held, or none (`grabbed` null) when it slides by the drag; `last` the pointer, CSS px. */
  private pan: { id: number; grabbed: Vec2 | null; height: number; last: Vec2 } | null = null;
  /** An orbit: where it was pressed and last was, CSS px; a right click that stays a click cancels the gesture in progress. */
  private orbit: { id: number; last: Vec2; pressed: Vec2; moved: boolean; cancelOnClick: boolean; height: number; spun: boolean } | null = null;
  private pinch: { d0: number; zoom0: number; world: Vec2; height: number; angle: number } | null = null;
  /** The hand's speed in the drag in progress (orbit rad/s or pan px/s), and when it last moved, ms. */
  private speed = { x: 0, y: 0, at: 0, from: { x: 0, y: 0 } };
  /** The drag's recent course (`SPEED_HORIZON_MS`): when (ms) and how far it had gone, in its own unit. */
  private samples: { t: number; x: number; y: number }[] = [];
  private travelled = { x: 0, y: 0 };
  /** The camera coasting after a drag let go (`step`). */
  private coast: { kind: 'orbit' | 'pan'; vx: number; vy: number } | null = null;

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

  gesture(): string | null {
    if (this.pinch) return 'câmera: pinça';
    if (this.orbit) return 'câmera: girando';
    if (this.pan) return 'câmera: arrastando';
    return null;
  }

  /** A pointer pressed at `screen`, CSS px: a coast in progress is caught. */
  press(id: number, screen: Vec2): void {
    this.pointers.set(id, screen);
    this.coast = null;
  }

  /** The camera still coasting after a drag: the frame loop keeps going. */
  get coasting(): boolean {
    return this.coast !== null;
  }

  /** The hand moved by (dx, dy) - rad of orbit or px of pan - now: its speed, smoothed. */
  private track(dx: number, dy: number): void {
    const now = performance.now();
    if (this.speed.at === 0) { this.samples.length = 0; this.travelled = { x: 0, y: 0 }; this.samples.push({ t: now, x: 0, y: 0 }); }
    this.travelled.x += dx;
    this.travelled.y += dy;
    this.samples.push({ t: now, x: this.travelled.x, y: this.travelled.y });
    while (this.samples.length > 2 && now - this.samples[0]!.t > SPEED_HORIZON_MS) this.samples.shift();
    this.speed.at = now;
  }

  /**
   * The hand's speed as it let go (per second, in the drag's own unit): the
   * slope of a line fitted by least squares to the last samples; zero when
   * they span too little time to say.
   */
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

  /** A drag let go: the camera coasts on at the hand's speed, if it was moving. */
  private throwCoast(kind: 'orbit' | 'pan'): void {
    const moving = performance.now() - this.speed.at < SPEED_STOPPED_MS;
    const min = kind === 'orbit' ? COAST_MIN_ORBIT : COAST_MIN_PAN;
    let { x: vx, y: vy } = this.handSpeed();
    // The fling's ceiling, in the drag's unit (an orbit's is in radians).
    let most = kind === 'orbit' ? MAX_FLING_PX_S * ORBIT_PER_PX : MAX_FLING_PX_S;
    // At the globe a pan's px are thousands of units each: the coast carries
    // the view no farther than `GLOBE_COAST_ARC` (its distance is speed x decay).
    const view = this.host.view();
    if (kind === 'pan' && this.spinning(view)) {
      const scale = view.scaleAtCentre ?? view.zoom;
      most = Math.min(most, (GLOBE_COAST_ARC * scale) / COAST_DECAY_S);
    }
    const v = Math.hypot(vx, vy);
    if (v > most) { vx *= most / v; vy *= most / v; }
    if (moving && Math.hypot(vx, vy) > min) this.coast = { kind, vx, vy };
    this.speed = { x: 0, y: 0, at: 0, from: { x: 0, y: 0 } };
    this.samples.length = 0;
  }

  /** Whether the view is out at the globe, where a drag spins the camera round it. */
  private spinning(view: Viewport): boolean {
    return (view.globe ?? 0) > GLOBE_SPIN;
  }

  /** The camera turned round the planet by a drag of (dx, dy) CSS px: the ground under the hand goes with it. */
  private spin(view: Viewport, dx: number, dy: number): void {
    const units = 1 / Math.max(1e-6, view.scaleAtCentre ?? view.zoom);
    view.slide(-dx * units, dy * units);
  }

  /** Advances the coast by `dt` seconds of wall time: true when the camera moved. */
  step(dt: number): boolean {
    const coast = this.coast;
    if (!coast) return false;
    const seconds = Math.min(0.1, Math.max(0, dt));
    const view = this.host.view();
    // The way the speed decays over this step, and the distance it covers -
    // the exact integral of v e^(-t/tau), tau (1 - e^(-dt/tau)) v: stepped as
    // v dt the coast went about dt/2tau further than its cap allows.
    const keep = Math.exp(-seconds / COAST_DECAY_S);
    const span = COAST_DECAY_S * (1 - keep);
    if (coast.kind === 'orbit') view.orbit(coast.vx * span, coast.vy * span);
    else {
      // The pan's own sense: the ground follows the hand, so the view's
      // centre goes the other way across the screen and away down it.
      const units = span / Math.max(1e-6, view.scaleAtCentre ?? view.zoom);
      view.slide(-coast.vx * units, coast.vy * units);
    }
    coast.vx *= keep;
    coast.vy *= keep;
    const min = coast.kind === 'orbit' ? COAST_MIN_ORBIT : COAST_MIN_PAN;
    if (Math.hypot(coast.vx, coast.vy) < min) this.coast = null;
    this.host.orbited();
    this.host.redraw();
    return true;
  }

  /**
   * The point a pan or pinch holds under the pointer: what is drawn there,
   * on the plane at its own height, which `panTo` then solves on too. On the
   * plane at zero - as orthographic views allow, every plane moving alike -
   * the perspective view, which stands at the height of the ground it looks
   * at, moved too far over a hill and jumped when the pointer's ray passed
   * that plane's horizon (the player, 2026-10-09: the middle-button drag
   * failed close up). Grabbed and solved on the same plane, the first move
   * does not jerk (comparing a deck-plane point with a zero-plane one jerked
   * every drag by `height / tan(48°)`).
   */
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
    this.orbit = { id, last: at, pressed: at, moved: false, cancelOnClick, height, spun: false };
    this.speed = { x: 0, y: 0, at: 0, from: at };
  }

  /** The ground under `at` grabbed and dragged. */
  startPan(id: number, at: Vec2): void {
    const held = this.anchor(at.x, at.y);
    const { w, h } = this.host.size();
    // Close over the ground, looking along the street, the pointer may be over
    // the horizon or on ground far down the road: there is no point to hold
    // (the stand-in the view gave, its own centre, pulled it back at the
    // first move - the player, 2026-10-10). The view then slides by the drag,
    // at the scale of the point looked at, as three's MapControls pans.
    const holds = this.host.view().holds(at.x, at.y, held.height, w, h);
    this.pan = { id, grabbed: holds ? held.world : null, height: held.height, last: at };
    this.speed = { x: 0, y: 0, at: 0, from: at };
  }

  /** Pointer `id` moved to `screen`: true when the camera took the move. */
  move(id: number, screen: Vec2): boolean {
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
      // A twist of the two fingers turns the camera with them; the pan below
      // then keeps the ground between the fingers where it was.
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
    if (orbit?.id === id) {
      if (!orbit.moved) {
        if (Math.hypot(screen.x - orbit.pressed.x, screen.y - orbit.pressed.y) < CLICK_SLOP) return true;
        orbit.moved = true;
      }
      const dx = screen.x - orbit.last.x;
      const dy = screen.y - orbit.last.y;
      orbit.last = screen;
      if (this.spinning(view)) {
        orbit.spun = true;
        this.track(dx, dy);
        this.spin(view, dx, dy);
        host.orbited();
        host.redraw();
        return true;
      }
      orbit.spun = false;
      this.track(dx * ORBIT_PER_PX, dy * ORBIT_PER_PX);
      // A turntable: the near side of the map follows the hand; dragging
      // down lifts the camera towards a plan view.
      view.orbit(dx * ORBIT_PER_PX, dy * ORBIT_PER_PX, { px: orbit.pressed.x, py: orbit.pressed.y, height: orbit.height });
      host.orbited();
      host.redraw();
      return true;
    }
    if (this.pan?.id === id) {
      const pan = this.pan;
      const dx = screen.x - pan.last.x, dy = screen.y - pan.last.y;
      this.track(dx, dy);
      if (this.spinning(view)) this.spin(view, dx, dy);
      else if (pan.grabbed) view.panTo(pan.grabbed, screen.x, screen.y, w, h, pan.height);
      else {
        // The ground follows the hand: dragged right it goes right, dragged
        // down it comes nearer. `scaleAtCentre` is pixels per unit at the point looked at.
        const unit = 1 / Math.max(1e-6, view.scaleAtCentre ?? view.zoom);
        view.slide(-dx * unit, dy * unit);
      }
      pan.last = screen;
      host.redraw();
      return true;
    }
    return false;
  }

  /**
   * Pointer `id` let go. `wasPinching`: a pinch was on when it was let go;
   * `clickCancels`: it was a right click that stayed a click over a gesture
   * in progress, which that click cancels.
   */
  release(id: number): { wasPinching: boolean; clickCancels: boolean } {
    const wasPinching = this.pinch !== null;
    this.pointers.delete(id);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pan?.id === id) {
      this.pan = null;
      if (!wasPinching) this.throwCoast('pan');
    }
    let clickCancels = false;
    if (this.orbit?.id === id) {
      clickCancels = this.orbit.cancelOnClick && !this.orbit.moved;
      if (this.orbit.moved) this.throwCoast(this.orbit.spun ? 'pan' : 'orbit');
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
