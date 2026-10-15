import type { Vec2 } from '@core/vec2';
import { MAX_ZOOM, MIN_ZOOM, type Camera } from './camera';

/** Which of the four quarter turns the view is at. Zero for a top-down view. */
export type Facing = 0 | 1 | 2 | 3;

/** What the input layer needs from a view, and nothing else. */
export interface Viewport {
  readonly kind: '2d' | 'iso';
  /** Ground point under a pointer, in world units, on the `y = 0` plane. */
  toWorld(px: number, py: number, cssW: number, cssH: number): Vec2;
  /** The same, but on a horizontal plane at `height`. */
  toWorldAt(px: number, py: number, height: number, cssW: number, cssH: number): Vec2;
  /** Where a ground point lands on screen, in CSS pixels. */
  toScreen(p: Vec2, cssW: number, cssH: number, height?: number): Vec2;
  /** Whether the ground under a pointer, on the plane at `height`, can be held by a pan */
  holds(px: number, py: number, height: number, cssW: number, cssH: number): boolean;
  /** Moves the view so `grabbed` (a point at `height`, what was under the pointer) sits under the pointer again. */
  panTo(grabbed: Vec2, px: number, py: number, cssW: number, cssH: number, height?: number): void;
  /** Zooms about a pointer, keeping the ground under it (at `height`, the ground's own height there). */
  zoomAt(px: number, py: number, factor: number, cssW: number, cssH: number, height?: number, grabbed?: Vec2): void;
  /** The point a zoom about (px, py) holds, and the height of the plane it is held on */
  grab?(px: number, py: number, height: number): { readonly world: Vec2; readonly height: number } | null;
  /** Moves the view over the ground, world units: `right` across the screen, `forward` the way the camera faces. */
  slide(right: number, forward: number): void;
  /** Where the camera's eye is (x, y on the map, z its height), or null for a flat view. */
  readonly eye: { readonly x: number; readonly y: number; readonly z: number } | null;
  /** The pointer's line of sight (x, y on the map, z up; a unit direction), from the camera into the scene */
  rayAt?(px: number, py: number, cssW: number, cssH: number): { readonly ox: number; readonly oy: number; readonly oz: number; readonly dx: number; readonly dy: number; readonly dz: number };
  /** Turns the view. A no-op where there is nothing to turn. */
  rotate(quarterTurns: number, px: number, py: number, cssW: number, cssH: number): void;
  /** Swings the camera round (`dAzimuth`, rad) and over (`dElevation`, rad) the `pivot` */
  orbit(dAzimuth: number, dElevation: number, pivot?: { readonly px: number; readonly py: number; readonly height: number }): void;
  /** Puts the camera at an exact bearing and tilt about the centre of the view. */
  setOrbit(azimuth: number, elevation: number): void;
  /** Bearing the camera looks from, rad, measured as the rig measures it. */
  readonly azimuth: number;
  /** Angle the camera looks down at, rad: PI/2 is straight down. */
  readonly elevation: number;
  /** World point at the centre of the view, and the only way to move it there. */
  readonly centre: Vec2;
  moveTo(p: Vec2): void;
  readonly zoom: number;
  readonly facing: Facing;
  /** Inclusive zoom range this viewport can actually represent. */
  readonly zoomBounds: { readonly min: number; readonly max: number };
  /** Screen pixels per world unit at the point looked at, as drawn. */
  readonly scaleAtCentre?: number;
}

/** The existing flat camera, behind the same seam. */
export function flatViewport(camera: Camera): Viewport {
  return {
    kind: '2d',
    toWorld: (px, py, cssW, cssH) => camera.screenToWorld(px, py, cssW, cssH),
    // A top-down view has no parallax: height moves nothing sideways.
    toWorldAt: (px, py, _height, cssW, cssH) => camera.screenToWorld(px, py, cssW, cssH),
    toScreen: (p, cssW, cssH) => camera.worldToScreen(p, cssW, cssH),
    holds: () => true,
    panTo(grabbed, px, py, cssW, cssH) {
      const now = camera.screenToWorld(px, py, cssW, cssH);
      camera.x += grabbed.x - now.x;
      camera.y += grabbed.y - now.y;
    },
    zoomAt(px, py, factor, cssW, cssH) {
      camera.zoomAt(px, py, factor, cssW, cssH);
    },
    slide(right, forward) {
      // Screen up is -y on the flat canvas.
      camera.x += right;
      camera.y -= forward;
    },
    get eye() {
      return null;
    },
    rotate() {
      // A top-down view has one orientation.
    },
    orbit() {},
    setOrbit() {},
    get azimuth() {
      return 0;
    },
    get elevation() {
      return Math.PI / 2;
    },
    get centre() {
      return { x: camera.x, y: camera.y };
    },
    moveTo(p) {
      camera.x = p.x;
      camera.y = p.y;
    },
    get zoom() {
      return camera.zoom;
    },
    get facing() {
      return 0 as Facing;
    },
    get zoomBounds() {
      return { min: MIN_ZOOM, max: MAX_ZOOM };
    },
  };
}
