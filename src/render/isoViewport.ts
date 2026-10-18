import {
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';

import type { Vec2 } from '@core/vec2';
import { MAP_HALF } from '@world/cityGen/wholeMap';
import { m } from '@world/units';
import type { Facing, Viewport } from '@view/viewport';
import { FAR_TILT, eyeLift, fieldOfView, minTilt, profileTilt, pullWeight, viewDistance } from '@view/cameraProfile';

/** Close inspection of pedestrian faces, gaits and the people inside vehicles. */
export const MIN_HALF_HEIGHT = m(0.8);
/** Out to some 11 km of ground in view (the old map's side and a tenth more): within the far ground's ring round the view (`flatAtlas.ts`, 7 plates). */
export const MAX_HALF_HEIGHT = m(5_632);

/** The zoom range the iso rig can represent at a given viewport height. */
export function isoZoomBounds(height: number): { min: number; max: number } {
  return { min: height / (MAX_HALF_HEIGHT * 2), max: height / (MIN_HALF_HEIGHT * 2) };
}

/** The orbit the camera starts in, and the one "reset view" returns to */
export const DEFAULT_AZIMUTH = Math.PI / 4;
export const DEFAULT_ELEVATION = (48 * Math.PI) / 180;
/** How low the camera may look. */
export const MIN_ELEVATION = (20 * Math.PI) / 180;
export const MAX_ELEVATION = Math.PI / 2;
/** The orthographic camera's distance from the view's centre: past the farthest ground a zoomed-out low view takes in. */
const DISTANCE = m(2000);
/** The perspective camera's vertical field of view far away, degrees */
export const PERSPECTIVE_FOV = 35;
const TAU = Math.PI * 2;
/** The most steps a zoom or a turn takes to bring the point it holds back under the pointer (`keeping`). */
const KEEP_PASSES = 8;

function clampElevation(e: number): number {
  return Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, e));
}

function wrapAzimuth(a: number): number {
  return ((a % TAU) + TAU) % TAU;
}

export interface IsoRig {
  /** The camera drawn with: orthographic, or perspective (`setPerspective`). */
  readonly camera: OrthographicCamera | PerspectiveCamera;
  readonly perspective: boolean;
  /** Perspective on or off. */
  setPerspective(on: boolean): void;
  readonly viewport: Viewport;
  readonly target: Vector3;
  resize(width: number, height: number): void;
  /** The height of what is drawn at a map point (x, y) */
  setGround(groundAt: (x: number, y: number) => number): void;
  /** The lowest the perspective camera's eye may stand at a map point, world height: over the roofs near a building */
  setSolids(floorAt: ((x: number, y: number) => number) | null, roofAt?: ((x: number, y: number) => number) | null): void;
  /** One frame of the pull's own time, `dt` seconds, as Cinemachine's Deoccluder times it */
  settle(dt: number): boolean;
}

/** The pull in front of a building (`apply`): samples along the line of sight, and how deep in a building's margin one weighs whole. */
const PULL_SAMPLES = 48;
const PULL_SOFT = m(1.5);
/** Cinemachine Deoccluder's Minimum Occlusion Time, Damping When Occluded, Smoothing Time and Damping (`settle`), seconds. */
const PULL_WAIT = 0.35;
const PULL_IN = 0.12;
const PULL_HOLD = 0.4;
const PULL_OUT = 0.6;
/** How far over the ground under it the perspective camera keeps, units. */
const GROUND_CLEARANCE = m(1.6);
/** How far the eye steps back out of the margin round a wall (`apply`), units. */
const BACK = m(4);

export function createIsoRig(
  initial: Vec2,
  initialHalfHeight: number,
  orbit: { azimuth: number; elevation: number } = { azimuth: DEFAULT_AZIMUTH, elevation: DEFAULT_ELEVATION },
): IsoRig {
  const ortho = new OrthographicCamera(-1, 1, 1, -1, m(0.4), m(5600));
  const persp = new PerspectiveCamera(PERSPECTIVE_FOV, 1, m(0.4), m(8000));
  let perspective = false;
  let camera: OrthographicCamera | PerspectiveCamera = ortho;
  const target = new Vector3(initial.x, 0, -initial.y);
  const raycaster = new Raycaster();
  const ground = new Plane(new Vector3(0, 1, 0), 0);
  const hit = new Vector3();
  const ndc = new Vector2();

  let width = 1;
  let height = 1;
  let halfHeight = Math.min(MAX_HALF_HEIGHT, Math.max(MIN_HALF_HEIGHT, initialHalfHeight));
  let azimuth = wrapAzimuth(Number.isFinite(orbit.azimuth) ? orbit.azimuth : DEFAULT_AZIMUTH);
  /** The player's tilt, as it would be far away. */
  let farTilt = clampElevation(Number.isFinite(orbit.elevation) ? orbit.elevation : DEFAULT_ELEVATION);
  /** The tilt in use now, rad. */
  const tiltNow = (): number => camera === persp
    ? Math.min(MAX_ELEVATION, Math.max(minTilt(halfHeight), profileTilt(halfHeight) + farTilt - FAR_TILT))
    : clampElevation(farTilt);
  /** The tilt the player asks for now (`next`), kept as the far tilt it means at this distance. */
  const askTilt = (next: number): void => {
    if (camera === persp) {
      const now = Math.min(MAX_ELEVATION, Math.max(minTilt(halfHeight), next));
      farTilt = now - profileTilt(halfHeight) + FAR_TILT;
    } else farTilt = clampElevation(next);
  };
  let elevation = clampElevation(farTilt);

  const apply = (): void => {
    const aspect = Math.max(0.1, width / Math.max(1, height));
    elevation = tiltNow();
    // The view's centre is held to the map (CLAUDE.md: the camera held to its edge, `wholeMap.ts` MAP_HALF), never past it into the void.
    const edge = MAP_HALF;
    target.x = Math.max(-edge, Math.min(edge, target.x));
    target.z = Math.max(-edge, Math.min(edge, target.z));
    let distance = DISTANCE;
    if (camera === ortho) {
      ortho.left = -halfHeight * aspect;
      ortho.right = halfHeight * aspect;
      ortho.top = halfHeight;
      ortho.bottom = -halfHeight;
      // The ground the view takes in runs `halfHeight` cot(elevation) nearer and farther than the point looked at
      const deep = halfHeight / Math.tan(Math.max(elevation, MIN_ELEVATION));
      distance = Math.max(distance, deep + m(400));
      ortho.far = Math.max(m(5600), distance + deep + m(800));
    } else {
      // As far back as makes the view `halfHeight` tall at the centre
      persp.fov = fieldOfView(halfHeight);
      distance = viewDistance(halfHeight);
      persp.aspect = aspect;
      persp.near = Math.max(m(0.08), distance * 0.02);
      persp.far = distance * 4 + m(2400);
    }

    // In perspective the view looks at the ground itself, at its height there
    if (camera === persp) target.y = (groundAt ? groundAt(target.x, -target.z) : 0) + eyeLift(halfHeight);
    const horizontal = Math.cos(elevation) * distance;
    camera.position.set(
      target.x + Math.cos(azimuth) * horizontal,
      (camera === persp ? target.y : 0) + Math.sin(elevation) * distance,
      target.z + Math.sin(azimuth) * horizontal,
    );
    // "Up" on screen: the camera's own up with no roll, the world's up tipped forward by the tilt
    camera.up.set(-Math.cos(azimuth) * Math.sin(elevation), Math.cos(elevation), -Math.sin(azimuth) * Math.sin(elevation));
    // Never behind a building from the point looked at, close up
    const pull = camera === persp && solidsAt ? pullWeight(halfHeight) : 0;
    let wanted = 0;
    if (pull > 0 && solidsAt) {
      const floorAt = solidsAt;
      const clear1 = target.y >= floorAt(target.x, -target.z);
      if (clear1) {
        for (let i = 0; i < PULL_SAMPLES; i++) {
          const t = i / PULL_SAMPLES;
          const x = camera.position.x + (target.x - camera.position.x) * t;
          const y = camera.position.y + (target.y - camera.position.y) * t;
          const z = camera.position.z + (target.z - camera.position.z) * t;
          const deep = floorAt(x, -z) - y;
          if (deep <= 0) continue;
          const k = Math.min(1, deep / PULL_SOFT);
          wanted = Math.max(wanted, k * k * (3 - 2 * k) * Math.min(1, t + 1 / PULL_SAMPLES) * pull);
        }
      }
    }
    pullWanted = wanted;
    if (pullShown < 0) pullShown = wanted;
    if (pullShown > 1e-6) {
      camera.position.lerp(target, pullShown);
      persp.near = Math.max(m(0.08), camera.position.distanceTo(target) * 0.02);
    }
    if (camera === persp && solidsAt) {
      // At any distance, never inside a building: the eye stood inside the towers it orbited, the walls cut by the near plane
      const floorAt = solidsAt;
      const inside = (t: number): boolean => {
        const y = camera.position.y + (target.y - camera.position.y) * t;
        return y < floorAt(camera.position.x + (target.x - camera.position.x) * t, -(camera.position.z + (target.z - camera.position.z) * t));
      };
      // Inside a building's walls, not merely in the margin round them that the floor above eases down over
      const roof = roofAt;
      const within = (t: number): boolean => {
        const y = camera.position.y + (target.y - camera.position.y) * t;
        return y < roof!(camera.position.x + (target.x - camera.position.x) * t, -(camera.position.z + (target.z - camera.position.z) * t));
      };
      if (roof) {
        // DO NOT lift the point whenever it falls in a building
        if (within(1) && within(0)) {
          const lift = roof(target.x, -target.z) + eyeLift(halfHeight) - target.y;
          target.y += lift;
          camera.position.y += lift;
        }
        if (within(0) && !within(1)) {
          // 2.
          let lo = 0, hi = 1;
          for (let i = 0; i < 20; i++) {
            const mid = (lo + hi) / 2;
            if (within(mid)) lo = mid; else hi = mid;
          }
          camera.position.lerp(target, hi);
        } else if (within(0)) {
          // 4. Both still inside (a point on a roof the eye's tower overhangs): over the roof.
          camera.position.y = Math.max(camera.position.y, floorAt(camera.position.x, -camera.position.z));
        }
        if (!within(0) && inside(0)) {
          // 3.
          const length = Math.max(camera.position.distanceTo(target), 1e-6);
          const back = -BACK / length;
          if (!inside(back)) {
            let lo = back, hi = 0;
            for (let i = 0; i < 20; i++) {
              const mid = (lo + hi) / 2;
              if (inside(mid)) hi = mid; else lo = mid;
            }
            camera.position.lerp(target, lo);
          }
        }
      } else if (inside(0)) {
        if (inside(1)) camera.position.y = floorAt(camera.position.x, -camera.position.z);
        else {
          let lo = 0, hi = 1;
          for (let i = 0; i < 16; i++) {
            const mid = (lo + hi) / 2;
            if (inside(mid)) lo = mid; else hi = mid;
          }
          camera.position.lerp(target, hi);
        }
      }
      // The near plane short of the nearest building
      const gap = camera.position.y - floorAt(camera.position.x, -camera.position.z);
      persp.near = Math.max(m(0.08), Math.min(persp.near, camera.position.distanceTo(target) * 0.02, (gap + m(1)) * 0.5));
    }
    if (camera === persp && groundAt) {
      // And never under the ground where it stands: raised over it, still looking at the same point
      const floor = groundAt(camera.position.x, -camera.position.z) + GROUND_CLEARANCE;
      if (camera.position.y < floor) camera.position.y = floor;
    }
    camera.lookAt(target);
    // Pixels per unit where the view looks at the ground.
    scaleNow = camera === persp
      ? height / Math.max(1e-6, 2 * camera.position.distanceTo(target) * Math.tan((persp.fov * Math.PI) / 360))
      : height / Math.max(1e-6, halfHeight * 2);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };
  /** The view's scale at the centre, as `apply` last set it. */
  let scaleNow = 1;
  /** The pull as `apply` last found it wanted, and as shown (-1: not yet). */
  let pullWanted = 0;
  let pullShown = -1;
  /** Seconds a building has stood in the way, and seconds the nearest point is still held. */
  let pullBlocked = 0;
  let pullHold = 0;
  /** The drawn ground's height at a map point (`setGround`). */
  let groundAt: ((x: number, y: number) => number) | null = null;
  /** The lowest the eye may stand over buildings (`setSolids`). */
  let solidsAt: ((x: number, y: number) => number) | null = null;
  /** The roof over a point inside a building, -Infinity outside (`setSolids`). */
  let roofAt: ((x: number, y: number) => number) | null = null;
  const projected = new Vector3();

  /** The point under a pointer, on the horizontal plane at `atHeight` */
  const hitAt = (px: number, py: number, atHeight: number): Vec2 | null => {
    ndc.set((px / Math.max(1, width)) * 2 - 1, 1 - (py / Math.max(1, height)) * 2);
    raycaster.setFromCamera(ndc, camera);
    ground.constant = -atHeight;
    const ok = raycaster.ray.intersectPlane(ground, hit);
    ground.constant = 0;
    return ok ? { x: hit.x, y: -hit.z } : null;
  };
  /** The same; a pointer whose ray meets no ground reads the view's centre. */
  const worldAt = (px: number, py: number, atHeight = 0): Vec2 => hitAt(px, py, atHeight) ?? { x: target.x, y: -target.z };

  /** The plane a zoom or a turn holds under the pointer. */
  const holdHeight = (px: number, py: number, atHeight: number): number => {
    if (camera !== persp) return atHeight;
    ndc.set((px / Math.max(1, width)) * 2 - 1, 1 - (py / Math.max(1, height)) * 2);
    raycaster.setFromCamera(ndc, camera);
    const limit = 3 * camera.position.distanceTo(target);
    ground.constant = -atHeight;
    const t = raycaster.ray.distanceToPlane(ground);
    ground.constant = 0;
    if (t !== null && t <= limit) return atHeight;
    return raycaster.ray.origin.y + raycaster.ray.direction.y * limit;
  };
  /** Re-applies, keeping the ground point that was under (px, py) - at `atHeight` - under it. */
  const keeping = (px: number, py: number, change: () => void, groundHeight = 0, grabbed?: Vec2): void => {
    // A point grabbed when the gesture began is held on its own plane as it is.
    const atHeight = grabbed ? groundHeight : holdHeight(px, py, groundHeight);
    const before = grabbed ?? hitAt(px, py, atHeight);
    change();
    apply();
    // A pointer over the horizon holds no ground: the change is made about the view's centre.
    if (!before) return;
    // On the plane one step is exact; looking at the ground, the view's height moves with its centre
    for (let pass = camera === persp ? KEEP_PASSES : 1; pass > 0; pass--) {
      const found = hitAt(px, py, atHeight);
      if (!found) break;
      const dx = before.x - found.x, dy = before.y - found.y;
      if (Math.abs(dx) + Math.abs(dy) < m(0.004)) break;
      target.x += dx;
      target.z -= dy;
      apply();
    }
  };

  const viewport: Viewport = {
    kind: 'iso',
    toWorld: (px, py) => worldAt(px, py),
    toWorldAt: (px, py, atHeight) => worldAt(px, py, atHeight),
    // The camera's own ray (three's `Raycaster.setFromCamera`), in the map's axes.
    rayAt(px, py) {
      ndc.set((px / Math.max(1, width)) * 2 - 1, 1 - (py / Math.max(1, height)) * 2);
      raycaster.setFromCamera(ndc, camera);
      const { origin: o, direction: d } = raycaster.ray;
      return { ox: o.x, oy: -o.z, oz: o.y, dx: d.x, dy: -d.z, dz: d.y };
    },
    toScreen(p, cssW, cssH, atHeight = 0) {
      projected.set(p.x, atHeight, -p.y).project(camera);
      return {
        x: (projected.x * 0.5 + 0.5) * cssW,
        y: (-projected.y * 0.5 + 0.5) * cssH,
      };
    },
    // The same test the zoom's hold makes (`holdHeight`): met within three times the view's distance.
    holds: (px, py, atHeight) => camera !== persp || holdHeight(px, py, atHeight) === atHeight,
    panTo(grabbed, px, py, _cssW, _cssH, atHeight = 0) {
      // The grabbed point is held on its own plane (the height of what was under the pointer), as zoom and orbit hold theirs
      for (let pass = camera === persp && groundAt ? 2 : 1; pass > 0; pass--) {
        const found = hitAt(px, py, atHeight);
        if (!found) break;
        target.x += grabbed.x - found.x;
        target.z -= grabbed.y - found.y;
        apply();
      }
    },
    grab(px, py, atHeight) {
      const held = holdHeight(px, py, atHeight);
      const world = hitAt(px, py, held);
      return world ? { world, height: held } : null;
    },
    zoomAt(px, py, factor, _cssW, _cssH, atHeight = 0, grabbed) {
      if (!(factor > 0) || !Number.isFinite(factor)) return;
      const wanted = halfHeight / factor;
      // The closest zoom is a person's eyes on the ground, and the zoom stops there
      if (wanted < MIN_HALF_HEIGHT && halfHeight <= MIN_HALF_HEIGHT) return;
      keeping(px, py, () => {
        halfHeight = Math.min(MAX_HALF_HEIGHT, Math.max(MIN_HALF_HEIGHT, wanted));
      }, atHeight, grabbed);
    },
    slide(right, forward) {
      // Along the ground the camera faces: forward is away from the camera over the ground, whatever the tilt
      const fx = -Math.cos(azimuth), fz = -Math.sin(azimuth);
      target.x += fx * forward - fz * right;
      target.z += fz * forward + fx * right;
      apply();
    },
    rotate(quarterTurns, px, py) {
      keeping(px, py, () => {
        azimuth = wrapAzimuth(azimuth + quarterTurns * Math.PI * 0.5);
      });
    },
    orbit(dAzimuth, dElevation, pivot) {
      // About the point the player grabbed (the player, 2026-10-07)
      const turn = (): void => {
        azimuth = wrapAzimuth(azimuth + dAzimuth);
        askTilt(tiltNow() + dElevation);
      };
      if (pivot) keeping(pivot.px, pivot.py, turn, pivot.height);
      else { turn(); apply(); }
    },
    setOrbit(nextAzimuth, nextElevation) {
      azimuth = wrapAzimuth(Number.isFinite(nextAzimuth) ? nextAzimuth : DEFAULT_AZIMUTH);
      askTilt(Number.isFinite(nextElevation) ? nextElevation : DEFAULT_ELEVATION);
      apply();
    },
    get azimuth() {
      return azimuth;
    },
    get elevation() {
      return elevation;
    },
    get eye() {
      return { x: camera.position.x, y: -camera.position.z, z: camera.position.y };
    },
    get centre() {
      return { x: target.x, y: -target.z };
    },
    moveTo(p) {
      target.set(p.x, 0, -p.y);
      apply();
    },
    get zoom() {
      return height / Math.max(1, halfHeight * 2);
    },
    get facing() {
      const turns = Math.round((azimuth - DEFAULT_AZIMUTH) / (Math.PI * 0.5));
      return (((turns % 4) + 4) % 4) as Facing;
    },
    get scaleAtCentre() {
      return scaleNow;
    },
    get zoomBounds() {
      return isoZoomBounds(height);
    },
  };

  apply();
  return {
    get camera() {
      return camera;
    },
    get perspective() {
      return perspective;
    },
    setPerspective(on) {
      if (on === perspective) return;
      perspective = on;
      camera = on ? persp : ortho;
      apply();
    },
    viewport,
    target,
    setGround(next) {
      groundAt = next;
      apply();
    },
    settle(dt) {
      if (pullShown < 0 || dt <= 0) return false;
      const gap = pullWanted - pullShown;
      if (Math.abs(gap) < 1e-4) {
        pullBlocked = 0;
        if (gap !== 0) { pullShown = pullWanted; apply(); }
        return false;
      }
      if (gap > 0) {
        pullBlocked += dt;
        if (pullBlocked < PULL_WAIT) return true;
        pullShown += gap * (1 - Math.exp(-dt / PULL_IN));
        pullHold = PULL_HOLD;
      } else {
        pullBlocked = 0;
        if (pullHold > 0) { pullHold -= dt; return true; }
        pullShown += gap * (1 - Math.exp(-dt / PULL_OUT));
      }
      apply();
      return true;
    },
    setSolids(next, roof = null) {
      solidsAt = next;
      roofAt = roof;
      apply();
    },
    resize(nextWidth, nextHeight) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      apply();
    },
  };
}
