import type { Vec2 } from '@core/vec2';
import type { Viewport } from '@view/viewport';
import { chartAt, inChartInto, towardsNorthInto } from '@world/planet/charts';
import { onLanguageChange, t } from '../i18n';

/**
 * THE COMPASS, a corner of the screen (Google Earth's and Cesium's navigation
 * widget, Cities: Skylines' north arrow): a needle that turns with the camera
 * and always points where north lies on the screen - the planet's own north
 * pole on the planet (`towardsNorthInto`), up the map on the flat map. A
 * click turns the view to face north, gliding (`CameraMotion.turn`); a drag
 * across it turns the camera, up and down tilts it.
 */

const north = { x: 0, y: 0 };
const toNorth = (c: Vec2): Vec2 => towardsNorthInto(c.x, c.y, 10, north);

/**
 * Where north lies on the screen from the middle of the view: radians
 * clockwise from straight up.
 */
export function northOnScreen(view: Viewport, w: number, h: number): number {
  const c = view.centre;
  const a = view.toScreen(c, w, h);
  const b = view.toScreen(toNorth(c), w, h);
  return Math.atan2(b.x - a.x, a.y - b.y);
}

/**
 * The angle on the ground, at the view's centre, from the way the
 * screen's up points to north (radians, counter-clockwise on the map).
 * Measured on the ground, not on the screen, so a tilted view turns by the
 * angle it really needs (on the screen a tilt squeezes it).
 */
function groundAngleToNorth(view: Viewport, w: number, h: number): number {
  // The ground the view turns about (out at the globe it is not under the
  // middle of the screen: the globe is framed whole there).
  const c = view.centre;
  const at = view.toScreen(c, w, h);
  // The screen's up there, laid on the ground: a few pixels up, on the
  // centre's own chart (a point past a piece's border is written on its
  // neighbour's). Farther up the screen the ground curves away from the
  // globe, and the way to it is not the way up the screen.
  const raw = view.toWorld(at.x, at.y - 4, w, h);
  const up = inChartInto(chartAt(c.x, c.y), raw.x, raw.y, { x: 0, y: 0 });
  const n = toNorth(c);
  const ux = up.x - c.x, uy = up.y - c.y, nx = n.x - c.x, ny = n.y - c.y;
  if (Math.hypot(ux, uy) < 1e-9 || Math.hypot(nx, ny) < 1e-9) return 0;
  return Math.atan2(ux * ny - uy * nx, ux * nx + uy * ny);
}

/**
 * The turn (`Viewport.orbit`'s azimuth, radians) still wanted to bring north
 * straight up the screen, as the view stands: the orbit turns the map's
 * directions the other way on the screen. Close to the ground one turn by it
 * is enough; out at the globe the view's tilt turns with the orbit and a
 * step leaves part of it, so it is asked again each frame
 * (`CameraMotion.aim`).
 */
export function northTurn(view: Viewport, w: number, h: number): number {
  return -groundAngleToNorth(view, w, h);
}

export interface CompassHandlers {
  /** Turn the view to face north. */
  north(): void;
  /** A drag across the compass: `Viewport.orbit` by `turn` and `tilt` radians. */
  drag(turn: number, tilt: number): void;
}

export interface Compass {
  /** Points the needle: north `angle` radians clockwise from straight up the screen. */
  point(angle: number): void;
}

/** Radians a CSS pixel of drag across the compass turns or tilts the camera. */
const DRAG_TURN = 0.012;
const DRAG_TILT = 0.006;
/** A press that moves less than this is a click. */
const CLICK_SLOP = 4;

export function mountCompass(host: HTMLElement, handlers: CompassHandlers): Compass {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'v2-compass';
  button.innerHTML = `<svg viewBox="0 0 48 48" aria-hidden="true">
    <circle class="v2-compass-ring" cx="24" cy="24" r="21"/>
    <g class="v2-compass-needle">
      <path class="v2-compass-n" d="M24 6 29 24H19Z"/>
      <path class="v2-compass-s" d="M24 42 19 24h10Z"/>
      <text x="24" y="17.5" text-anchor="middle">N</text>
    </g>
  </svg>`;
  const needle = button.querySelector<SVGGElement>('.v2-compass-needle')!;
  const label = (): void => {
    button.title = t('compass.label');
    button.setAttribute('aria-label', t('compass.label'));
  };
  label();
  onLanguageChange(label);
  host.appendChild(button);

  let press: { id: number; x: number; y: number; moved: boolean } | null = null;
  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    button.setPointerCapture(e.pointerId);
    button.classList.add('held');
  });
  button.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    if (!press.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
    press.moved = true;
    press.x = e.clientX;
    press.y = e.clientY;
    // The dial follows the hand: dragged right, north swings clockwise -
    // the orbit's turn the other way (`northTurn`). Up raises the camera.
    handlers.drag(-dx * DRAG_TURN, -dy * DRAG_TILT);
  });
  const end = (e: PointerEvent): void => {
    if (!press || e.pointerId !== press.id) return;
    const click = !press.moved;
    press = null;
    button.classList.remove('held');
    if (click && e.type === 'pointerup') handlers.north();
  };
  button.addEventListener('pointerup', end);
  button.addEventListener('pointercancel', end);
  // The keyboard's click (Enter, Space) faces north too.
  button.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handlers.north();
    }
  });

  let shown = NaN;
  return {
    point(angle) {
      const deg = Math.round((angle * 180) / Math.PI);
      if (deg === shown) return;
      shown = deg;
      needle.style.transform = `rotate(${deg}deg)`;
    },
  };
}
