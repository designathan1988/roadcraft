import {
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';

import type { Vec2 } from '@core/vec2';
import { MAP_HALF, MAP_SIZE } from '@world/bounds';
import { m } from '@world/units';
import type { Facing, Viewport } from '@view/viewport';
import { FAR_TILT, eyeLift, fieldOfView, minTilt, profileTilt, pullWeight, viewDistance } from '@view/cameraProfile';

/**
 * Close inspection of pedestrian faces, gaits and the people inside vehicles.
 * A view 14 m tall showed a person about eighty pixels high; at 4 m a person
 * fills about half of it; at 1.6 m (the player asked to come closer,
 * 2026-10-02) the view is a face and shoulders.
 */
export const MIN_HALF_HEIGHT = m(0.8);
/** Out to the whole map (`world/bounds.ts`): its side and a tenth more. */
export const MAX_HALF_HEIGHT = Math.round(MAP_SIZE * 0.55);

/**
 * The zoom range the iso rig can represent at a given viewport height.
 *
 * `zoom` is `height / (halfHeight * 2)` and `halfHeight` is clamped to
 * [MIN_HALF_HEIGHT, MAX_HALF_HEIGHT], so this is the rig's own range and NOT the
 * flat camera's `MIN_ZOOM`/`MAX_ZOOM`. Restoring a session clamps against it, so
 * a zoom the rig produced (up to 80 at 800 px tall) is never rejected by a
 * narrower fallback range. One definition, used by the rig's `zoomBounds` and by
 * the boot-time clamp before the rig exists.
 */
export function isoZoomBounds(height: number): { min: number; max: number } {
  return { min: height / (MAX_HALF_HEIGHT * 2), max: height / (MIN_HALF_HEIGHT * 2) };
}

/**
 * The orbit the camera starts in, and the one "reset view" returns to: looking
 * north-west-ish down at 48 degrees, the angle the whole game was drawn for.
 */
export const DEFAULT_AZIMUTH = Math.PI / 4;
export const DEFAULT_ELEVATION = (48 * Math.PI) / 180;
/**
 * How low the camera may look. The view is orthographic: there is no horizon to
 * look at, and below about thirty degrees the ground seen grows to twice the
 * screen's height in depth, which is paid for in shadows and detail with little
 * gained. Straight down (90) is a true plan view.
 */
export const MIN_ELEVATION = (20 * Math.PI) / 180;
export const MAX_ELEVATION = Math.PI / 2;
/** The orthographic camera's distance from the view's centre: past the farthest ground a zoomed-out low view takes in. */
const DISTANCE = m(2000);
/**
 * The perspective camera's vertical field of view far away, degrees: a long
 * lens, so a street keeps its proportions and the town still reads as a
 * model. Close up it widens to a person's view (`view/cameraProfile.ts`
 * `fieldOfView`); the camera's own `fov` is the one in use.
 */
export const PERSPECTIVE_FOV = 35;
const TAU = Math.PI * 2;
/** The most steps a zoom or a turn takes to bring the point it holds back under the pointer (`keeping`). */
const KEEP_PASSES = 8;

export function clampElevation(e: number): number {
  return Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, e));
}

export function wrapAzimuth(a: number): number {
  return ((a % TAU) + TAU) % TAU;
}

export interface IsoRig {
  /** The camera drawn with: orthographic, or perspective (`setPerspective`). */
  readonly camera: OrthographicCamera | PerspectiveCamera;
  readonly perspective: boolean;
  /**
   * Perspective on or off. The view keeps its centre, its orbit and its scale
   * at the centre (`zoom` is still pixels per unit there).
   */
  setPerspective(on: boolean): void;
  readonly viewport: Viewport;
  readonly target: Vector3;
  resize(width: number, height: number): void;
  /**
   * The height of what is drawn at a map point (x, y): the perspective view
   * looks at the ground there, and never goes under it (`apply`).
   */
  setGround(groundAt: (x: number, y: number) => number): void;
  /**
   * The lowest the perspective camera's eye may stand at a map point, world
   * height: over the roofs near a building (`world/buildings/cameraSolids.ts`).
   * A continuous function of position, so the camera is lifted out of a
   * building without a jump and never blocked.
   */
  setSolids(floorAt: ((x: number, y: number) => number) | null, roofAt?: ((x: number, y: number) => number) | null): void;
  /**
   * One frame of the pull's own time, `dt` seconds, as Cinemachine's
   * Deoccluder times it: nothing until a building has stood in the way
   * `PULL_WAIT` ("Minimum Occlusion Time"), then eased in ("Damping When
   * Occluded"), held at the nearest point ("Smoothing Time"), eased back out
   * ("Damping"). Whether it is still moving (draw again).
   */
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
  /**
   * The player's tilt, as it would be far away. The orthographic view uses
   * it as it is; the perspective view adds what the distance does by itself
   * (`tiltNow`): the camera eases towards the street as it comes closer, and
   * the player's own tilt rides on top of that.
   */
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
    // The view's centre stays over the map: dragged off it, the view
    // showed nothing but sky - a white screen.
    const edge = MAP_HALF + m(80);
    target.x = Math.max(-edge, Math.min(edge, target.x));
    target.z = Math.max(-edge, Math.min(edge, target.z));
    let distance = DISTANCE;
    if (camera === ortho) {
      ortho.left = -halfHeight * aspect;
      ortho.right = halfHeight * aspect;
      ortho.top = halfHeight;
      ortho.bottom = -halfHeight;
      // The ground the view takes in runs `halfHeight` cot(elevation) nearer
      // and farther than the point looked at: the camera stands behind its
      // near edge and sees past its far one (out on the whole map some
      // kilometres; the fixed distance alone cut the ground off).
      const deep = halfHeight / Math.tan(Math.max(elevation, MIN_ELEVATION));
      distance = Math.max(distance, deep + m(400));
      ortho.far = Math.max(m(5600), distance + deep + m(800));
    } else {
      // As far back as makes the view `halfHeight` tall at the centre: the
      // same scale there as the orthographic view had, through a lens that
      // widens in the street (`cameraProfile`).
      persp.fov = fieldOfView(halfHeight);
      distance = viewDistance(halfHeight);
      persp.aspect = aspect;
      persp.near = Math.max(m(0.08), distance * 0.02);
      persp.far = distance * 4 + m(2400);
    }

    // In perspective the view looks at the ground itself, at its height
    // there: at the height of the plane at zero, a camera brought close over
    // a hill or a chapada ended inside it and showed the land from below
    // (the player, 2026-10-07).
    // Close up, the point looked at rises to a person's eyes: the closest
    // view is a pedestrian's, looking down the street, not at the asphalt.
    if (camera === persp) target.y = (groundAt ? groundAt(target.x, -target.z) : 0) + eyeLift(halfHeight);
    const horizontal = Math.cos(elevation) * distance;
    camera.position.set(
      target.x + Math.cos(azimuth) * horizontal,
      (camera === persp ? target.y : 0) + Math.sin(elevation) * distance,
      target.z + Math.sin(azimuth) * horizontal,
    );
    // "Up" on screen: the camera's own up with no roll, the world's up tipped
    // forward by the tilt - straight up looking level, the way the camera
    // faces over the ground looking straight down (where the world's up is
    // the view direction itself and `lookAt` would spin the plan view at
    // random). The way it faces alone, used at every tilt, turned the picture
    // upside down once the camera looked up from the street (the player,
    // 2026-10-10; master 2feec96a): three's `lookAt` keeps the part of `up`
    // across the view, and looking up that direction falls DOWN the screen.
    camera.up.set(-Math.cos(azimuth) * Math.sin(elevation), Math.cos(elevation), -Math.sin(azimuth) * Math.sin(elevation));
    // Never behind a building from the point looked at, close up: the eye is
    // brought in along the line of sight to just short of the building that
    // stands between (camera-controls' `_collisionTest`; Cinemachine's
    // Deoccluder, "Pull Camera Forward"). Each sample of the sightline weighs
    // by how deep it stands in a building's margin (`cameraSolids.ts` eases
    // its floor down over 2 m round the walls), so the pull grows as a
    // corner comes in rather than flipping from nothing to metres. And it is
    // taken as the Deoccluder takes it (`settle`): only once the building
    // has stood in the way a moment, eased in, held, eased back out. Taken
    // whole in every frame, every corner a drag carried through the sightline
    // jerked the eye by metres and the camera shook (the player,
    // 2026-10-13: "a câmera fica tripidando").
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
      // At any distance, never inside a building: the eye stood inside the
      // towers it orbited, the walls cut by the near plane (the player,
      // 2026-10-13: "a câmera não pode atravessar o prédio").
      // Brought forward along the line of sight to where it leaves the
      // building (Cinemachine's Deoccluder, "Pull Camera Forward"); with the
      // point looked at inside too, lifted over the roof.
      const floorAt = solidsAt;
      const inside = (t: number): boolean => {
        const y = camera.position.y + (target.y - camera.position.y) * t;
        return y < floorAt(camera.position.x + (target.x - camera.position.x) * t, -(camera.position.z + (target.z - camera.position.z) * t));
      };
      // Inside a building's walls, not merely in the margin round them that
      // the floor above eases down over (`cameraSolids.ts` `roofAt`, no margin).
      const roof = roofAt;
      const within = (t: number): boolean => {
        const y = camera.position.y + (target.y - camera.position.y) * t;
        return y < roof!(camera.position.x + (target.x - camera.position.x) * t, -(camera.position.z + (target.z - camera.position.z) * t));
      };
      if (roof) {
        // Decided by the walls, NOT by the margin round them alone: the point
        // looked at in a podium by a tower, the eye in the tower, took the eye
        // up to the eased floor over it - 58 m up, looking down into its own
        // roof, a grey screen; an eye merely beside a wall was lifted half the
        // tower's height, or left a hand from a window looking into the room
        // (2026-10-14). In turn:
        // 1. The point looked at inside a building goes onto the roof over it,
        //    the eye with it: the view turns round what is seen there (Cesium
        //    picks its pivot on the scene's content); a building grown where
        //    the view looked does the same.
        if (within(1)) {
          const lift = roof(target.x, -target.z) + eyeLift(halfHeight) - target.y;
          target.y += lift;
          camera.position.y += lift;
        }
        if (within(0) && !within(1)) {
          // 2. The eye inside a building, the point outside it: the eye brought
          //    along the line of sight to where it leaves the walls
          //    (Cinemachine's Deoccluder, "Pull Camera Forward"), past them.
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
          // 3. The eye outside the walls but nearer one than the camera's
          //    radius (the margin, Cinemachine's "Camera Radius": "distance to
          //    maintain from any obstacle"): a step back along the line of
          //    sight, away from the wall, as far as the margin, at most `BACK`.
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
      // The near plane short of the nearest building: at 2 % of a long view
      // distance it stood metres ahead of the eye and cut the facade open.
      const gap = camera.position.y - floorAt(camera.position.x, -camera.position.z);
      persp.near = Math.max(m(0.08), Math.min(persp.near, camera.position.distanceTo(target) * 0.02, (gap + m(1)) * 0.5));
    }
    if (camera === persp && groundAt) {
      // And never under the ground where it stands: raised over it, still
      // looking at the same point (the camera-terrain clamp of Cesium's and
      // Unity's orbit cameras, read from the height field).
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

  /**
   * The point under a pointer, on the horizontal plane at `atHeight`, or null
   * where the pointer's ray does not reach that plane (three's
   * `Ray.intersectPlane`: above its horizon).
   *
   * Height is not cosmetic here. The camera looks down at an angle, so a
   * surface fifteen units up projects about thirteen units away from the ground
   * point beneath it at 48 degrees. Solving on the wrong plane is why pointing
   * at the end of an elevated road picked open ground thirteen units away and
   * the snap never found the node that was plainly drawn there.
   */
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

  /**
   * The plane a zoom or a turn holds under the pointer. Far down a street, at
   * a grazing angle, the ground under the pointer lies many times the view's
   * distance away, and holding it swung the view metres per notch for a tiny
   * change of tilt (an ill-conditioned hold); over the horizon there is no
   * ground at all. The point held is then the one on the pointer's ray at
   * three times the view's distance: the zoom still goes towards the pointer.
   */
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
    // A pointer over the horizon holds no ground: the change is made about
    // the view's centre. (Its old stand-in, the centre itself, set against a
    // real point after the change, threw the view across the map.)
    if (!before) return;
    // On the plane one step is exact; looking at the ground, the view's
    // height moves with its centre, and a second step takes up what the
    // first left. Close up the tilt, the lens and the eye's lift change with
    // the zoom too: the steps go on until the point stands within a hundredth
    // of a unit (`KEEP_PASSES` at most), as a fixed three left a point far
    // down the road pixels off and the place pointed at slid away.
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
    // The same test the zoom's hold makes (`holdHeight`): met within three
    // times the view's distance.
    holds: (px, py, atHeight) => camera !== persp || holdHeight(px, py, atHeight) === atHeight,
    panTo(grabbed, px, py, _cssW, _cssH, atHeight = 0) {
      // The grabbed point is held on its own plane (the height of what was
      // under the pointer), as zoom and orbit hold theirs (`keeping`): on the
      // plane at zero, close over a hill a pixel moved the view far, and a
      // ray above that plane's horizon jumped it to the target. Looking at the
      // ground, the view's height moves with its centre: a second step takes
      // up what the first left. A ray that misses the plane moves nothing.
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
      // The closest zoom is a person's eyes on the ground, and the zoom stops
      // there (the player, 2026-10-10: "zoom máximo até pegar o nível do chão
      // e encaixar, pronto, aí não vai mais"; master 2feec96a).
      if (wanted < MIN_HALF_HEIGHT && halfHeight <= MIN_HALF_HEIGHT) return;
      keeping(px, py, () => {
        halfHeight = Math.min(MAX_HALF_HEIGHT, Math.max(MIN_HALF_HEIGHT, wanted));
      }, atHeight, grabbed);
    },
    slide(right, forward) {
      // Along the ground the camera faces: forward is away from the camera
      // over the ground, whatever the tilt (straight down included).
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
      // About the point the player grabbed (the player, 2026-10-07): that
      // ground stays under the pointer while the camera swings round and over
      // it. Without a pivot, about the centre of the view.
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
