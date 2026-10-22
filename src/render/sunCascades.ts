import {
  BasicShadowMap,
  type Box3,
  DepthFormat,
  DepthTexture,
  DirectionalLight,
  GreaterEqualCompare,
  LessEqualCompare,
  LightShadow,
  LinearFilter,
  NearestFilter,
  Object3D,
  OrthographicCamera,
  RedFormat,
  type Mesh,
  type Scene,
  ShaderChunk,
  UnsignedByteType,
  UnsignedIntType,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Light,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three';
import { m } from '@world/units';
import type { ChangeBox } from './changeBoxes';

/** THE SUN'S CASCADED SHADOW MAPS (cascaded shadow maps, Engel, ShaderX5; stable fitting after Valient, ShaderX6; the still casters' store scrolled with the view after Acton, "CSM Scrolling", SIGGRAPH 2012; the cascades' whole draws spread over frames as Dybisz, "Shadows optimizations in Cyberpunk 2077", SIGGRAPH 2021) */

/** The sun's cascades: three lights of one direction and colour, each with its own map; the shader lights a pixel once, with the finest map holding it. */
export const SUN_CASCADES = 3;
/** How far the cascades reach past the point looked at, eye depth: the street sees shadows this far (800 m). */
const SHADOW_REACH = m(800);
/** The most eye depth the cascades cover, the whole map seen from above at most. */
const SHADOW_DEPTH_MAX = m(8000);
/** How far the sun the shadows are cast by may drift from the true one before it is moved (rad), at the least: 0.1 degree. Each cascade holds its own sun and lets it drift as far as one of its texels of shadow displacement allows (`sunTolerance`): DO NOT refit the three cascades at every 0.1 degree of the city's sun (0.05-0.07 degrees a real second, `city.ts` TIME_SCALE): every 1.5-2 s of play the whole town was drawn into the three maps in one frame. */
const SUN_STEP = (0.1 * Math.PI) / 180;
/** A cascade whose square only moved by whole texels keeps the store's depth where the squares overlap and draws the strips uncovered alone (`scrollInto`); strips over this share of the map's area are a whole draw instead (two strip passes and their blits cost more than one whole pass there). */
const SCROLL_MOST = 0.5;
/** The near cascades whose casters the layers keep off the frame (`coverBox`): cascade 0 is the one drawn whole most often in a move (318
 *  of 606 passes, `npm run diagnose`, 2026-10-22). Keeping cascade 1 too held 21 → 27 M triangles in the district view for 318 → 281
 *  whole redraws; DO NOT take the far ones: from the map's view they cover the whole city, and every prop of it would be drawn. */
const KEEP_CASCADES = 1;
/** The most strips a cascade clears in one pass for its changed casters (`rectsOf`): each is a scissored clear, the town drawn once over their union (`drawStrips`). */
const MOST_STRIPS = 32;
/** The union of a cascade's strips past this share of its map: drawn whole instead (the same raster, and no store blitted back first). */
const UNION_MOST = 0.85;
/** Depth offset of the shadow test, world units (4 cm). */
const SHADOW_BIAS_WORLD = m(0.04);
/** A cascade drawn whole after this many frames however still, a last resort for a change nothing told it of (ten seconds at 60 Hz): the casters' signature tells it of every change of what it draws (`renderer.ts` casterSignature, a batch's pieces too). DO NOT redraw it every half second: a whole cascade every ten frames was the frame that missed its vsync in every still view of a large city (a tenth of the frames, measured 2026-10-20). */
const SAFETY_FRAMES = 600;
/** DO NOT let the cascades' safety draws fall in one frame: three whole passes at once every half second (RND-03). Each cascade's count starts this many frames apart after a draw they all made; one drawn for safety alone keeps its place. */
const SAFETY_STAGGER = 10;
/** A cascade's half-side is one of the steps 2^(k/4) m; it is fitted to what it must hold with this much room (`fit`). */
const ROOM = 1.2;
/** Fitted again smaller once the cascade is this many times wider than what it must hold. */
const SHRINK = 1.7;
/** The ground below the lowest ground sampled that is still taken as ground (a dip between the samples). */
const GROUND_DIP = m(8);

/** One cascade's shadow; three's `WebGLShadowMap` calls `updateMatrices` right before it draws that light's map, which is when `beforeDraw` runs. */
class CascadeShadow extends LightShadow<OrthographicCamera> {
  readonly isDirectionalLightShadow = true;
  beforeDraw: (() => void) | null = null;
  constructor() {
    super(new OrthographicCamera(-5, 5, 5, -5, 0.5, 500));
  }
  override updateMatrices(light: Light): void {
    this.beforeDraw?.();
    super.updateMatrices(light);
  }
}

/** A part of a cascade's square drawn alone (`drawStrips`): its bounds in the light's square about the centre (the camera's), and on the map in pixels (the viewport's). */
interface Strip { readonly left: number; readonly right: number; readonly bottom: number; readonly top: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** Where a cascade stands in the light's axes: centre (right, up), half-side, and the depth range along the sun it holds. */
interface Fit {
  cr: number;
  cu: number;
  half: number;
  sLo: number;
  sHi: number;
  placed: boolean;
}

/** What moves and is drawn into the shadows: when it moves, every cascade it is drawn into is drawn again. */
export interface Movers {
  readonly roots: readonly Object3D[];
  moving(): boolean;
  /** Its roots never change size (what the wind sways in place): each one's reach measured once, not every frame. */
  readonly fixedSize?: boolean;
  /** The last cascade it is drawn into (cascades are 0 near to the farthest): the people and the vehicles stop at the mid one, where their shadows are under a texel's spread (the far cascades redraw a million of their triangles a frame). */
  readonly maxCascade?: number;
  /** Past `maxCascade` it casts as it stands, kept in the store with the still casters (what the wind sways: a far texel blurs the swing, never the tree), not left out. */
  readonly keptPast?: boolean;
}

export interface ShadowPassInput {
  /** The world under the shadows changed (buildings streamed in, an edit): every cascade. */
  readonly changed: boolean;
  /** Effects in play (`playEffects.ts`): their pieces are in every cascade. */
  readonly effects: boolean;
  /** Nothing that casts and stands still changed since the last pass, as the caller knows it (the view, what landed, came or went): a cascade's store may stand for its town. Absent: it may not. */
  readonly still?: boolean;
  /** The view stands where it stood (the camera unmoved): a cascade drawn whole now is kept as its store though its casters changed, the next frames standing on it. Absent: only a still pass keeps its store. */
  readonly keep?: boolean;
  /** With `still` false: the world boxes holding every still caster that changed since the last pass (`renderer.ts` casterChanges, a few apart from each other) - each cascade's store is drawn again under them alone (`patched`), and stands untouched where they fall outside its square; null: a change with no box to tell, the stores thrown away as before. Absent: the stores thrown away. */
  readonly patch?: readonly Box3[] | null | undefined;
  /** The town is shown (the curtain is down, `renderer.ts` reveal): a cascade drawn whole is kept as its store whatever the view does, the
   *  frames after it scrolling and patching it. Absent: kept only as above (behind the curtain the town is hidden, and no store of it stands). */
  readonly opened?: boolean;
}

export interface SunCascades {
  /** Cascade 0 is the sun the rest of the game reads (its colour, intensity and direction). */
  readonly lights: readonly DirectionalLight[];
  /** Towards the sun the cascades are cast by (unit; zero before the first `follow`): the held sun itself, never a light's position less its target (those move with every fit, and their difference by the last bits). */
  readonly toSun: Vector3;
  setMovers(movers: readonly Movers[]): void;
  /** What chooses its casters by size, told each cascade's texel and half side (m) before that cascade is drawn (a piece narrower than it is a smudge PCF spreads away), and null once the passes are done. */
  setCasters(casters: ((texel: number | null, cascade: number, half: number) => void) | null): void;
  /** Fits the cascades to what the camera sees of the ground and what stands on it */
  follow(camera: Camera, sunDirection: Vector3, groundAt: (x: number, y: number) => number, target: Vector3, top: number): boolean;
  /** Marks the cascades that must be drawn this frame; true when any is (the renderer's `shadowMap.needsUpdate`). */
  pass(input: ShadowPassInput): boolean;
  /** How the passes went since the last call (counts, then zeroed): each cascade's whole draws and draws over its store, and why a whole draw was asked (`scripts/layers.mjs`). */
  takeStats(): { readonly passes: number; readonly whole: readonly number[]; readonly over: readonly number[]; readonly why: Readonly<Record<string, number>> };
  /** `mapSize`: one size for every cascade, or a size for each: the near cascade carries the shadow detail, the far ones are filtered over a texel's spread (a 2048 far map held 12.6 M texels for 6.2 M pixels, 2026-10-20). */
  setEnabled(on: boolean, mapSize: number | readonly number[]): void;
  /** The far cascades (1 and on) drawn at most every `n` passes, what changed meanwhile kept for their turn (the lab's optimisations, `optimizationsApply.ts`); 1: every pass, as the game draws. */
  setFarEvery(n: number): void;
  /** The world box (three's axes) round the near cascades' squares (0 to `KEEP_CASCADES` - 1) through their depth ranges, grown by `margin`:
   *  what the layers keep their casters for whatever the camera frames (`cellInstances.ts` keep); false when none is placed. */
  coverBox(target: Box3, margin: number): boolean;
  /** The maps made again, for the renderer's shadow map type changed (`shadowMap.type`: PCF compares its depth, Basic reads it): every cascade drawn whole next. */
  remakeMaps(): void;
  /** Copies the sun's colour and intensity to the other cascades. */
  syncLight(): void;
  /** Every cascade's map, for the video memory count. */
  maps(): (WebGLRenderTarget | null)[];
  /** Puts back what a cascade's pass hid (`Scene.onAfterRender`). */
  restore(): void;
  dispose(): void;
}

/** The sun held in steps of `SUN_STEP`, and the light's axes (right, up) turned with it by the least turn */
class SunHold {
  readonly s = new Vector3();
  readonly r = new Vector3();
  readonly u = new Vector3();
  private held = false;

  /** Takes the true sun; true when the held one moved: when the true sun left `tolerance` (rad) of it. */
  take(sun: Vector3, tolerance = SUN_STEP): boolean {
    if (this.held && this.s.angleTo(sun) <= tolerance) return false;
    if (!this.held) {
      this.held = true;
      this.s.copy(sun).normalize();
      const ref = new Vector3(0, Math.abs(this.s.y) < 0.95 ? 1 : 0, Math.abs(this.s.y) < 0.95 ? 0 : 1);
      this.r.crossVectors(ref, this.s).normalize();
    } else {
      this.s.copy(sun).normalize();
      // The right kept, made square to the new sun
      this.r.addScaledVector(this.s, -this.r.dot(this.s)).normalize();
    }
    this.u.crossVectors(this.s, this.r).normalize();
    return true;
  }
}

const NDC: readonly (readonly [number, number])[] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];

/** A cascade's map as three's PCF shadow map makes it (r186 `WebGLShadowMap`: a depth texture compared, linear), its colour, which nothing reads, one byte a texel instead of four. `basic`: as its Basic map (no comparison, nearest: `sampler2D` read by `getShadow`, a compare mode under it is undefined in GLSL ES 3.0). */
function cascadeMap(size: number, name: string, reversed: boolean, basic = false): WebGLRenderTarget {
  const map = new WebGLRenderTarget(size, size, { format: RedFormat, type: UnsignedByteType, depthTexture: new DepthTexture(size, size, UnsignedIntType) });
  const depth = map.depthTexture!;
  depth.name = name;
  depth.format = DepthFormat;
  depth.compareFunction = basic ? null : reversed ? GreaterEqualCompare : LessEqualCompare;
  depth.minFilter = basic ? NearestFilter : LinearFilter;
  depth.magFilter = basic ? NearestFilter : LinearFilter;
  return map;
}

/** Where a cascade's still casters are kept between its whole draws: a depth as its map's, copied by a blit (three's `copyTextureToTexture`). */
function staticStore(size: number): WebGLRenderTarget {
  const store = new WebGLRenderTarget(size, size, { format: RedFormat, type: UnsignedByteType, depthTexture: new DepthTexture(size, size, UnsignedIntType) });
  store.depthTexture!.format = DepthFormat;
  store.depthTexture!.minFilter = NearestFilter;
  store.depthTexture!.magFilter = NearestFilter;
  return store;
}

/** `renderer`: with it, each cascade keeps the depth of its still casters (STATIC SHADOW CACHE): what moves is drawn over a copy of it, the town drawn again only when it changed, the cascade was fitted again, or `SAFETY_FRAMES` passed. */
export function createSunCascades(sun: DirectionalLight, others: readonly DirectionalLight[], radius: number, renderer: WebGLRenderer | null = null): SunCascades {
  const lights = [sun, ...others];
  const shadows = lights.map((light) => {
    const shadow = new CascadeShadow();
    shadow.radius = radius;
    light.shadow.dispose();
    light.shadow = shadow;
    // Drawn when this module says so (`pass`), each cascade on its own.
    shadow.autoUpdate = false;
    return shadow;
  });
  const fits: Fit[] = lights.map(() => ({ cr: 0, cu: 0, half: 0, sLo: 0, sHi: 0, placed: false }));
  const refitted = lights.map(() => true);
  /** Whether the cascade's map was ever drawn whole since it was made: a refit of one never drawn (the first frame, the maps made again) waits for no turn, it has no map to stand on. */
  const everDrawn = lights.map(() => false);
  const framesSince = lights.map((_light, i) => -i * SAFETY_STAGGER);
  /** What `takeStats` tells. */
  const stats = { passes: 0, whole: lights.map(() => 0), over: lights.map(() => 0), why: { refit: 0, changed: 0, effects: 0, safety: 0, noStore: 0, scroll: 0, patch: 0, deferred: 0, thrown: 0, noBox: 0, tooBig: 0, tooBigNear: 0, refitSun: 0, refitSize: 0, refitDepth: 0, refitMove: 0 } };
  /** Each cascade's held sun and light axes: a cascade is fitted again for the sun only when the true sun left its own tolerance (`sunTolerance`), the far cascades, with texels of metres, far less often than the near one. Cascade 0's is the sun the rest of the game reads (`toSun`, the light's direction). */
  const holds = lights.map(() => new SunHold());
  const sunStepped = lights.map(() => true);
  /** A cascade whose square only moved this frame, by whole texels of its grid (`fit`): asked to scroll its store into its map and draw the strips uncovered alone (`pass` takes it into `scrolled`, or into a whole draw when the store cannot stand). */
  const scroll: ({ readonly dx: number; readonly dy: number } | null)[] = lights.map(() => null);
  /** The scrolls this pass draws (`blitShift`, `stripsOfShift`), with the cascade kept whole after (`whole`). */
  const scrolled: ({ readonly dx: number; readonly dy: number } | null)[] = lights.map(() => null);
  /** The parts of each cascade's square its changed casters fall in this pass (`ShadowPassInput.patch`, `rectOf`): cleared and drawn again alone, the rest of the store standing. */
  const patched: (Strip[] | null)[] = lights.map(() => null);
  let movers: readonly Movers[] = [];
  let casters: ((texel: number | null, cascade: number, half: number) => void) | null = null;
  let enabled = true;
  /** The far cascades drawn every this many passes (`setFarEvery`), and whether each had a change or effects asked while it waited. */
  let farEvery = 1;
  const carried = lights.map(() => false);
  /** The roots hidden in this frame's shadow pass, put back after it (`restore`). */
  const hidden: Object3D[] = [];
  /** Each cascade's still casters' depth, whether it holds this cascade's town as it stands, and what this frame draws of the cascade: all of it (`whole`), or what moves over the store (`over`). */
  const stores: (WebGLRenderTarget | null)[] = lights.map(() => null);
  const storeValid = lights.map(() => false);
  const whole = lights.map(() => false);
  const over = lights.map(() => false);
  /** Which pass three is drawing: the still casters (every mover hidden), or the movers alone over them. */
  let drawingMovers = false;
  /** The movers drawn over a cascade's store: a root that is no parent, its children the movers as they stand in the scene. */
  const moverRoot = new Object3D();
  const moverList: Object3D[] = [];
  /** Each mover root's radius this frame (`sphereOf`), worked out once a frame at `pass`. */
  const radii = new Map<Object3D, number>();

  // The view's four corner rays: where each starts (three's space) and its step per unit of eye depth.
  const stepOf = NDC.map(() => new Vector3());
  const startOf = NDC.map(() => new Vector3());
  const p = new Vector3();
  const q = new Vector3();
  const a = new Vector3();
  const b = new Vector3();
  const eye = new Vector3();
  const look = new Vector3();
  /** Each corner ray's eye depths between the ground and the tops, and the cascades' split depths. */
  const enter = new Float64Array(4), leave = new Float64Array(4);
  const splits = new Float64Array(SUN_CASCADES + 1);

  /** The radius a root's casters reach (largest piece), for the texel test: an instanced piece at its largest instance's scale (a train's cars, a platform's bays are a unit geometry scaled by their instances: read at the geometry's own size they lost their shadow in the far cascade). */
  /** DO NOT walk it with `traverse` and a closure: the closure and its boxed `radius` were made again for every root, cascade and frame (sunCascades.ts was the page's first source of garbage, 109 MB in 20 s, 2026-10-18). */
  const walk: Object3D[] = [];
  const measureSphere = (object: Object3D): number => {
    let radius = 0;
    walk.length = 0;
    walk.push(object);
    while (walk.length > 0) {
      const o = walk.pop()!;
      for (const child of o.children) walk.push(child);
      const mesh = o as Mesh & { isInstancedMesh?: boolean; count?: number; instanceMatrix?: { array: ArrayLike<number> } };
      if (!mesh.isMesh) continue;
      const geometry = mesh.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      let scale = 1;
      if (mesh.isInstancedMesh && mesh.instanceMatrix) {
        const m = mesh.instanceMatrix.array;
        scale = 0;
        for (let k = 0, n = mesh.count ?? 0; k < n; k++) {
          const e = k * 16;
          scale = Math.max(scale, m[e]! * m[e]! + m[e + 1]! * m[e + 1]! + m[e + 2]! * m[e + 2]!, m[e + 4]! * m[e + 4]! + m[e + 5]! * m[e + 5]! + m[e + 6]! * m[e + 6]!,
            m[e + 8]! * m[e + 8]! + m[e + 9]! * m[e + 9]! + m[e + 10]! * m[e + 10]!);
        }
        scale = Math.sqrt(scale);
      }
      radius = Math.max(radius, (geometry.boundingSphere?.radius ?? 0) * scale * mesh.matrixWorld.getMaxScaleOnAxis());
    }
    return radius;
  };
  /** DO NOT walk a root's tree for every cascade and twice a frame: each root's radius once a frame (`pass` clears it). */
  const spheres = new Map<Object3D, number>();
  const sphereOf = (object: Object3D, fixed = false): number => {
    if (fixed) {
      // Measured again only when its instances changed in number (a tree planted, a cell's trees made again).
      const count = (object as { count?: number }).count ?? -1;
      const kept = fixedSpheres.get(object);
      if (kept && kept.count === count) return kept.radius;
      const radius = measureSphere(object);
      // Its record written again in place: DO NOT make one a measure (the movers are measured every few passes).
      if (kept) { kept.radius = radius; kept.count = count; } else fixedSpheres.set(object, { radius, count });
      return radius;
    }
    let radius = spheres.get(object);
    if (radius !== undefined) return radius;
    // DO NOT read every instance's matrix of every mover each frame for the largest scale (the probe, 2026-10-19: the page's first CPU cost
    // with the camera turning, and growing with the city's vehicles and people). Kept across frames: measured again when the instances change
    // in number (one more car, a bigger one among them) and every `REMEASURE_PASSES` passes for a scale changed in place.
    const count = instancesUnder(object);
    const kept = moverSpheres.get(object);
    // A count changed is measured again at most every `RECOUNT_PASSES`: the town's vehicles and people come and go at nearly every pass, and
    // every instance's matrix was read again each time (404 MB of a 13 s flight's garbage, `npm run diagnose`, 2026-10-22). The reach only
    // says which cascades a root casts into; a few passes late, a new bus casts from its next measure.
    if (kept && (kept.count === count || passNo - kept.pass < RECOUNT_PASSES) && passNo - kept.pass < REMEASURE_PASSES) radius = kept.radius;
    else {
      radius = measureSphere(object);
      if (kept) { kept.radius = radius; kept.count = count; kept.pass = passNo; } else moverSpheres.set(object, { radius, count, pass: passNo });
    }
    spheres.set(object, radius);
    return radius;
  };
  /** The movers' reach, kept from pass to pass with the instances it was measured at and when. */
  const moverSpheres = new WeakMap<Object3D, { radius: number; count: number; pass: number }>();
  /** Passes a mover's reach is trusted for (half a second at 60 Hz): a scale changed in place is seen within it; a count changed at once. */
  const REMEASURE_PASSES = 30;
  /** Passes a mover's reach is kept for after its instances changed in number (`sphereOf`). */
  const RECOUNT_PASSES = 10;
  /** The passes run, for `moverSpheres`' age. */
  let passNo = 0;
  /** How many instances a root draws (an instanced mesh by its count, any other mesh as one): its meshes walked, never their matrices. */
  const instancesUnder = (object: Object3D): number => {
    let n = 0;
    walk.length = 0;
    walk.push(object);
    while (walk.length > 0) {
      const o = walk.pop()!;
      for (const child of o.children) walk.push(child);
      const mesh = o as Mesh & { isInstancedMesh?: boolean; count?: number };
      if (mesh.isMesh) n += mesh.isInstancedMesh ? (mesh.count ?? 0) + 1 : 1;
    }
    return n;
  };
  /** The reach of the roots that never change size (`Movers.fixedSize`), kept from frame to frame with the instances it was measured at. */
  const fixedSpheres = new WeakMap<Object3D, { radius: number; count: number }>();
  const texelOf = (i: number): number => (2 * fits[i]!.half) / Math.max(1, lights[i]!.shadow.mapSize.x);
  /** How far the true sun may leave cascade `i`'s held one, rad: until the shadow of the tallest caster in the view (`height` over the lowest ground) would move by one of the cascade's texels, never under `SUN_STEP`. A sun `e` high moves a shadow's tip by h / sin²e per radian of elevation and h · cot e per radian of azimuth. */
  const sunTolerance = (i: number, height: number): number => {
    const f = fits[i]!;
    if (!f.placed) return SUN_STEP;
    const e = Math.asin(Math.min(1, Math.max(0.05, holds[i]!.s.y)));
    const reach = Math.max(m(1), height) * Math.max(1 / Math.sin(e) ** 2, 1 / Math.tan(e));
    return Math.max(SUN_STEP, texelOf(i) / reach);
  };
  /** A mover is drawn into cascade `i` only if it is wider than two of its texels: under that, its shadow is a smudge PCF spreads away. */
  const drawnIn = (root: Object3D, i: number, fixed = false): boolean => {
    let r = radii.get(root);
    if (r === undefined) { r = sphereOf(root, fixed); radii.set(root, r); }
    return r >= texelOf(i);
  };

  shadows.forEach((shadow, i) => {
    shadow.beforeDraw = () => {
      // The last cascade's hidden roots back; its casters left chosen, this cascade chooses them all again.
      restore(false);
      // The movers alone over the store: nothing hidden, and the town's casters left as they are.
      if (drawingMovers) return;
      for (const mover of movers) {
        // Past its last cascade a mover casts nothing: hidden from the still casters' store and drawn over none (`drawOver`).
        const past = i > (mover.maxCascade ?? Infinity);
        // Kept in the store past its last cascade (`keptPast`): drawn with the still casters, as it stands.
        if (past && mover.keptPast) continue;
        for (const root of mover.roots) {
          // Kept in a store this frame (`whole`): every mover is drawn over it after the still casters (`drawOver`); else drawn with them, those too small for the texels left out.
          if (!root.visible || (!past && !whole[i] && drawnIn(root, i, mover.fixedSize))) continue;
          root.visible = false;
          hidden.push(root);
        }
      }
      casters?.(texelOf(i), i, fits[i]!.half);
      castersChosen = casters !== null;
    };
  });

  /** Cascade `i`'s map as three made it, or ours: one byte of colour, its depth compared. */
  const ensureMap = (i: number): void => {
    if (!renderer) return;
    const shadow = lights[i]!.shadow;
    const size = shadow.mapSize.x;
    if (!shadow.map) shadow.map = cascadeMap(size, `${lights[i]!.name}.shadowMap`, renderer.capabilities.reversedDepthBuffer, renderer.shadowMap.type === BasicShadowMap);
    let store = stores[i];
    if (!store || store.width !== size) {
      store?.dispose();
      store = stores[i] = staticStore(size);
      renderer.initRenderTarget(store);
      storeValid[i] = false;
    }
  };

  /** The meshes under a mover `root` drawn into a cascade of `texel`: each part that casts, holds instances, and is at least a texel wide (its model's sphere), not the root whole for its widest part (a group of people's levels, a car's parts with none drawn). */
  const castersIn = (object: Object3D, texel: number, out: Object3D[]): void => {
    if (!object.visible) return;
    const mesh = object as Mesh & { isInstancedMesh?: boolean; count?: number };
    if (mesh.isMesh && mesh.castShadow && !(mesh.isInstancedMesh && mesh.count === 0)) {
      const geometry = mesh.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      // Pushed whole (three draws its children with it), or its children looked at one by one.
      if ((geometry.boundingSphere?.radius ?? 0) * mesh.matrixWorld.getMaxScaleOnAxis() >= texel) { out.push(mesh); return; }
    }
    for (const child of object.children) castersIn(child, texel, out);
  };

  /** What moves drawn into cascade `i` over what its map holds, by three's own shadow pass (depth materials and all) with its clear left out. */
  const drawOver = (i: number, base: (lights: Light[], scene: Scene, camera: Camera) => void, camera: Camera): void => {
    if (!renderer) return;
    moverList.length = 0;
    const texel = texelOf(i);
    // A mover past its last cascade is not drawn over the store (the people and the vehicles in the far one).
    for (const mover of movers) if (i <= (mover.maxCascade ?? Infinity)) for (const root of mover.roots) if (root.visible && drawnIn(root, i, mover.fixedSize)) castersIn(root, texel, moverList);
    if (moverList.length === 0) return;
    moverRoot.children = moverList;
    const clear = renderer.clear;
    drawingMovers = true;
    lights[i]!.shadow.needsUpdate = true;
    renderer.shadowMap.needsUpdate = true;
    // DO NOT clear the map: it holds the still casters (`over`) or was just drawn with them (`whole`).
    renderer.clear = () => {};
    try {
      base([lights[i]!], moverRoot as unknown as Scene, camera);
    } finally {
      renderer.clear = clear;
      drawingMovers = false;
      moverRoot.children = [];
    }
  };

  /** Cascade `i`'s square moved by (`dx`, `dy`) whole texels of its grid (`fit`, the store standing for its town): the store's depth where the squares overlap blitted into the map shifted by (-dx, -dy) (Acton, "CSM Scrolling", SIGGRAPH 2012). The strips uncovered are `stripsOfShift`. */
  const blitShift = (i: number, dx: number, dy: number): void => {
    if (!renderer) return;
    const map = lights[i]!.shadow.map, store = stores[i];
    if (!map?.depthTexture || !store?.depthTexture) return;
    const size = map.width;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    // The overlap, blitted on the GPU. DO NOT take three's `copyTextureToTexture` for a region off the origin: r186 hands `blitFramebuffer` the region's width where it wants the region's far edge, and the overlap came out scaled.
    const from = renderer.properties.get(store) as { __webglFramebuffer?: WebGLFramebuffer | null };
    const to = renderer.properties.get(map) as { __webglFramebuffer?: WebGLFramebuffer | null };
    const w = size - Math.abs(dx), h = size - Math.abs(dy);
    const sx = Math.max(dx, 0), sy = Math.max(dy, 0), tx = Math.max(-dx, 0), ty = Math.max(-dy, 0);
    // The blit writes the depth whatever the last material left (the depth mask, the scissor): the state said so.
    renderer.state.setScissorTest(false);
    renderer.state.buffers.depth.setMask(true);
    if (w > 0 && h > 0 && from.__webglFramebuffer && to.__webglFramebuffer) {
      renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, from.__webglFramebuffer);
      renderer.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.__webglFramebuffer);
      gl.blitFramebuffer(sx, sy, sx + w, sy + h, tx, ty, tx + w, ty + h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      renderer.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
  };

  /** The strips a shift of (`dx`, `dy`) texels uncovers in cascade `i`: in the light's square (the camera's bounds, about its centre) and on the map (pixels, the viewport's share). */
  const stripsOfShift = (i: number, dx: number, dy: number): Strip[] => {
    const size = Math.max(1, lights[i]!.shadow.mapSize.x);
    const half = fits[i]!.half, texel = (2 * half) / size;
    const strips: Strip[] = [];
    if (dx > 0) strips.push({ left: half - dx * texel, right: half, bottom: -half, top: half, x: size - dx, y: 0, w: dx, h: size });
    else if (dx < 0) strips.push({ left: -half, right: -half - dx * texel, bottom: -half, top: half, x: 0, y: 0, w: -dx, h: size });
    if (dy > 0) strips.push({ left: -half, right: half, bottom: half - dy * texel, top: half, x: 0, y: size - dy, w: size, h: dy });
    else if (dy < 0) strips.push({ left: -half, right: half, bottom: -half, top: -half - dy * texel, x: 0, y: 0, w: size, h: -dy });
    return strips;
  };

  /** Where a world box falls in cascade `i`'s square, a texel of margin round it, on whole texels: the strip to draw again; undefined when it falls outside the square (nothing of the cascade changed). A caster's footprint on the map is its box's corners cast along the sun onto the light's right and up: the box's own extent on those two axes. */
  const rectOf = (i: number, box: Box3): Strip | undefined => {
    const f = fits[i]!, hold = holds[i]!;
    const size = Math.max(1, lights[i]!.shadow.mapSize.x);
    const texel = (2 * f.half) / size;
    let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity;
    for (let k = 0; k < 8; k++) {
      corner.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z);
      const r = corner.dot(hold.r) - f.cr, u = corner.dot(hold.u) - f.cu;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
    }
    if (!(minR <= maxR)) return undefined;
    // On whole texels, a texel of margin either way, within the square.
    const x0 = Math.max(0, Math.floor((minR + f.half) / texel) - 1), x1 = Math.min(size, Math.ceil((maxR + f.half) / texel) + 1);
    const y0 = Math.max(0, Math.floor((minU + f.half) / texel) - 1), y1 = Math.min(size, Math.ceil((maxU + f.half) / texel) + 1);
    if (x1 <= x0 || y1 <= y0) return undefined;
    return { left: -f.half + x0 * texel, right: -f.half + x1 * texel, bottom: -f.half + y0 * texel, top: -f.half + y1 * texel, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  /** The strips of cascade `i` the changed casters' boxes fall in, at most `MOST_STRIPS` (the nearest two joined while there are more): an empty list when none does (the store stands), null when their union covers more than `UNION_MOST` of the map (`drawStrips` draws the union: a whole draw costs the same). DO NOT join them into two: each strip was a pass of three over the scene, so they were joined to two, and two changes at opposite edges of the near cascade made one strip over most of its map - the store thrown away in 322 of 420 passes of a move (`npm run diagnose`, 2026-10-22). */
  const rectsOf = (i: number, boxes: readonly Box3[]): Strip[] | null => {
    const size = Math.max(1, lights[i]!.shadow.mapSize.x);
    const strips: Strip[] = [];
    const texel = texelOf(i);
    for (const box of boxes) {
      // A change of a caster too small for this cascade's texels (`ChangeBox.reach`): nothing of it drawn here, nothing to draw again.
      if (((box as ChangeBox).reach ?? Infinity) < texel) continue;
      const rect = rectOf(i, box);
      if (rect !== undefined) strips.push(rect);
    }
    while (strips.length > MOST_STRIPS) {
      // The pair whose union adds the least area, worked out without making each union (a strip a pair, every pass of a move).
      let a = 0, b = 1, least = Infinity;
      for (let p = 0; p < strips.length; p++) {
        const sp = strips[p]!;
        for (let q = p + 1; q < strips.length; q++) {
          const sq = strips[q]!;
          const w = Math.max(sp.x + sp.w, sq.x + sq.w) - Math.min(sp.x, sq.x), h = Math.max(sp.y + sp.h, sq.y + sq.h) - Math.min(sp.y, sq.y);
          const added = w * h - sp.w * sp.h - sq.w * sq.h;
          if (added < least) { least = added; a = p; b = q; }
        }
      }
      strips[a] = unionStrip(strips[a]!, strips[b]!);
      strips.splice(b, 1);
    }
    if (strips.length === 0) return strips;
    const all = strips.reduce(unionStrip);
    return all.w * all.h > UNION_MOST * size * size ? null : strips;
  };
  /** The strip round two. */
  const unionStrip = (p: Strip, q: Strip): Strip => {
    const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y);
    const x1 = Math.max(p.x + p.w, q.x + q.w), y1 = Math.max(p.y + p.h, q.y + q.h);
    return { left: Math.min(p.left, q.left), right: Math.max(p.right, q.right), bottom: Math.min(p.bottom, q.bottom), top: Math.max(p.top, q.top), x, y, w: x1 - x, h: y1 - y };
  };
  const corner = new Vector3();

  /** Cascade `i`'s `strips` cleared to the far depth and their still casters drawn alone - the shadow camera narrowed to each strip and the shadow's viewport set to it (three's `WebGLShadowMap` reads `LightShadow.getViewport`; the narrowed projection culls the objects and the batches' pieces to the strip) - then the full camera and the matrix the shader samples by put back. The map then holds under each strip what a whole draw would, to the texel: the same grid, the same depth range. The movers are drawn over after, as after a whole draw (`whole`). */
  const drawStrips = (i: number, strips: readonly Strip[], base: (lights: Light[], scene: Scene, camera: Camera) => void, scene: Scene, camera: Camera): void => {
    if (!renderer) return;
    const light = lights[i]!, shadow = light.shadow, map = shadow.map;
    if (!map?.depthTexture) return;
    const size = map.width, half = fits[i]!.half;
    const cam = shadow.camera;
    const viewport = (shadow as unknown as { _viewports: Vector4[] })._viewports[0]!;
    const clear = renderer.clear;
    try {
      if (strips.length === 0) return;
      // Each strip cleared alone (a scissored clear costs next to nothing) ...
      renderer.setRenderTarget(map as WebGLRenderTarget);
      for (const strip of strips) {
        map.scissorTest = true;
        map.scissor.set(strip.x, strip.y, strip.w, strip.h);
        renderer.setRenderTarget(map as WebGLRenderTarget);
        // The clear writes the depth whatever the last material left (the depth mask): the state said so.
        renderer.state.buffers.depth.setMask(true);
        renderer.clear(false, true, false);
      }
      map.scissorTest = false;
      map.scissor.set(0, 0, size, size);
      // ... and the town drawn once over their union: between the strips it writes the depth the store holds already (the same casters, the
      // same light, the depth test passing on equal), in them what changed. DO NOT draw a pass of three a strip: each walks the whole scene.
      const all = strips.reduce(unionStrip);
      cam.left = all.left; cam.right = all.right; cam.bottom = all.bottom; cam.top = all.top;
      cam.updateProjectionMatrix();
      viewport.set(all.x / size, all.y / size, all.w / size, all.h / size);
      shadow.needsUpdate = true;
      renderer.shadowMap.needsUpdate = true;
      // DO NOT let three clear the map: it holds the store, the strips cleared above.
      renderer.clear = () => {};
      base([light], scene, camera);
      renderer.clear = clear;
    } finally {
      renderer.clear = clear;
      map.scissorTest = false;
      map.scissor.set(0, 0, size, size);
      viewport.set(0, 0, 1, 1);
      cam.left = -half; cam.right = half; cam.bottom = -half; cam.top = half;
      cam.updateProjectionMatrix();
      // The matrix the shader samples by, for the whole square at its centre, without the hook of a draw (`CascadeShadow.updateMatrices`).
      LightShadow.prototype.updateMatrices.call(shadow, light);
    }
  };

  if (renderer) {
    const shadowMap = renderer.shadowMap;
    const base = shadowMap.render.bind(shadowMap) as (lights: Light[], scene: Scene, camera: Camera) => void;
    shadowMap.render = (shadowLights: Light[], scene: Scene, camera: Camera): void => {
      // A render of another scene (its own lights): nothing of the cascades' here.
      if (!shadowLights.includes(sun)) { base(shadowLights, scene, camera); return; }
      for (let i = 0; i < lights.length; i++) if (whole[i] || over[i]) ensureMap(i);
      // Nothing reads a cascade's colour (PCF samples its depth texture, `cascadeMap`): clear the depth alone and spare a byte a texel of dead colour per map and pass.
      const clear = renderer.clear;
      renderer.clear = (_color, depth, stencil) => clear.call(renderer, false, depth ?? true, stencil ?? true);
      try {
        base(shadowLights, scene, camera);
      } finally {
        renderer.clear = clear;
      }
      // Nothing kept nor drawn over: what the passes hid and chose given back now. DO NOT leave it for the next frame's first cascade: the
      // movers too small for the last cascade's texel stayed hidden through the colour pass, and the casters at their last cascade's counts.
      if (!whole.includes(true) && !over.includes(true)) { restore(); return; }
      const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), level = renderer.getActiveMipmapLevel();
      // The cascades whose square only moved, or whose casters changed under a known box: the store scrolled into the map, the strips uncovered and the box's part drawn alone; kept whole below, the movers drawn over.
      for (let i = 0; i < lights.length; i++) {
        const shift = scrolled[i], rects = patched[i];
        scrolled[i] = null;
        patched[i] = null;
        if (!shift && !rects) continue;
        const strips: Strip[] = [];
        // The map holds last frame's movers drawn over the store (`drawOver`): the store put back first, shifted or not. DO NOT patch the map as it
        // stands: the movers outside the strips were copied into the store with it, and a car's shadow stayed where it had passed.
        blitShift(i, shift?.dx ?? 0, shift?.dy ?? 0);
        if (shift) { strips.push(...stripsOfShift(i, shift.dx, shift.dy)); stats.why.scroll++; }
        if (rects) { strips.push(...rects); stats.why.patch++; }
        drawStrips(i, strips, base, scene, camera);
      }
      restore();
      for (let i = 0; i < lights.length; i++) {
        if (!whole[i] && !over[i]) continue;
        const map = lights[i]!.shadow.map, store = stores[i];
        if (map?.depthTexture && store?.depthTexture) {
          // Drawn whole: its still casters kept. Movers only: the still casters put back, as kept.
          if (whole[i]) { renderer.copyTextureToTexture(map.depthTexture, store.depthTexture); storeValid[i] = true; }
          else renderer.copyTextureToTexture(store.depthTexture, map.depthTexture);
          drawOver(i, base, camera);
        }
        whole[i] = false;
        over[i] = false;
      }
      // The blits leave the framebuffers unbound: the frame's own target bound again before the scene is drawn into it.
      renderer.setRenderTarget(target, face, level);
    };
  }
  /** Whether the casters were chosen for a cascade since they were last given back (`restore`). */
  let castersChosen = false;
  /** What a cascade's pass hid put back; `settled`: the passes are over, the casters chosen by cascade given back too, once (DO NOT walk every caster between two cascades: the next one sets them all). */
  function restore(settled = true): void {
    for (const root of hidden) root.visible = true;
    hidden.length = 0;
    if (settled && castersChosen) { castersChosen = false; casters?.(null, -1, 0); }
  }

  /** Writes a fit into its light: the light stands at the top of the depth range, looking down the sun. */
  const place = (i: number): void => {
    const light = lights[i]!;
    const fit = fits[i]!;
    const camera = light.shadow.camera;
    const hold = holds[i]!;
    light.position.set(0, 0, 0).addScaledVector(hold.r, fit.cr).addScaledVector(hold.u, fit.cu).addScaledVector(hold.s, fit.sHi);
    light.target.position.copy(light.position).sub(hold.s);
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();
    // The shadow camera's axes are the light's: right `r`, up `u` (three's `LightShadow` looks at the target with the camera's `up`).
    camera.up.copy(hold.u);
    camera.left = -fit.half;
    camera.right = fit.half;
    camera.top = fit.half;
    camera.bottom = -fit.half;
    camera.near = 0;
    camera.far = fit.sHi - fit.sLo;
    camera.updateProjectionMatrix();
    // Bias in proportion to one texel of this cascade (world units across)
    const texel = texelOf(i);
    light.shadow.normalBias = Math.max(m(0.02), texel * 1.5);
    light.shadow.bias = -Math.max(SHADOW_BIAS_WORLD, texel * 1.2) / Math.max(1e-6, camera.far - camera.near);
  };

  /** Fits cascade `i` to the box (right, up) and depth range given; true when it moved */
  const fit = (i: number, minR: number, maxR: number, minU: number, maxU: number, sLo: number, sHi: number): boolean => {
    const f = fits[i]!;
    const need = Math.max(maxR - minR, maxU - minU) / 2;
    // The same half-side, sun and depth range: the map's grid stands, and the store's texels with it.
    const same = f.placed && !sunStepped[i] && f.half >= need && f.half <= need * SHRINK * ROOM && sLo >= f.sLo && sHi <= f.sHi;
    // Why it is fitted again, the near cascade's (`takeStats`): the sun stepped, its size, its depth range, or a move its store cannot follow.
    if (i === 0 && f.placed && !(same && minR >= f.cr - f.half && maxR <= f.cr + f.half && minU >= f.cu - f.half && maxU <= f.cu + f.half)) {
      if (sunStepped[i]) stats.why.refitSun++;
      else if (!(f.half >= need && f.half <= need * SHRINK * ROOM)) stats.why.refitSize++;
      else if (!(sLo >= f.sLo && sHi <= f.sHi)) stats.why.refitDepth++;
      else stats.why.refitMove++;
    }
    if (same && minR >= f.cr - f.half && maxR <= f.cr + f.half && minU >= f.cu - f.half && maxU <= f.cu + f.half) return false;
    if (same && renderer !== null && storeValid[i]) {
      // The square moved: its centre on the same texel grid, the store scrolled to it and the strips uncovered drawn alone (`scrollInto`). DO NOT draw the whole town again for a pan of a fifth of the square: the store holds every texel of the overlap, to the bit.
      const size = Math.max(1, lights[i]!.shadow.mapSize.x);
      const texel = (2 * f.half) / size;
      const cr = Math.round((minR + maxR) / 2 / texel) * texel;
      const cu = Math.round((minU + maxU) / 2 / texel) * texel;
      // Added to a scroll not yet drawn (a far cascade out of its turn, `setFarEvery`; a pass skipped, `shadowEvery`): the store moves by
      // every step since it was drawn. DO NOT keep the last step alone: the light had moved by them all, and the far shadows stood off by
      // the steps skipped - broken bands while the camera moved (the lab's `farCascadeEvery`, diagnosis 2026-10-22).
      const pending = scroll[i] ?? null;
      const dx = Math.round((cr - f.cr) / texel) + (pending?.dx ?? 0), dy = Math.round((cu - f.cu) / texel) + (pending?.dy ?? 0);
      const inside = minR >= cr - f.half && maxR <= cr + f.half && minU >= cu - f.half && maxU <= cu + f.half;
      const kept = (size - Math.abs(dx)) * (size - Math.abs(dy));
      if (inside && (dx !== 0 || dy !== 0) && Math.abs(dx) < size && Math.abs(dy) < size && kept >= (1 - SCROLL_MOST) * size * size) {
        f.cr = cr;
        f.cu = cu;
        place(i);
        scroll[i] = { dx, dy };
        return false;
      }
      // Too far for the store to follow: drawn whole at the new centre, the pending scroll let go with it.
      scroll[i] = null;
    }
    // A half-side on the ladder 2^(k/4) m: the same cascade size over a range of views, so its texels stay where they were
    const step = Math.ceil(4 * Math.log2(Math.max(m(1), need * ROOM) / m(1)));
    f.half = m(1) * 2 ** (step / 4);
    // The centre on whole texels of the light's grid: the map moves by whole texels, so a shadow's edge never crawls
    const texel = (2 * f.half) / Math.max(1, lights[i]!.shadow.mapSize.x);
    f.cr = Math.round((minR + maxR) / 2 / texel) * texel;
    f.cu = Math.round((minU + maxU) / 2 / texel) * texel;
    // Room for the ground and the tops a move brings under the square (a taller building, a dip): DO NOT fit the depth range tight - the
    // near cascade was fitted again for its depth 25 times in a flight of ~600 passes, its store thrown away each time (`refitDepth`,
    // `npm run diagnose` on a clean tree, 2026-10-22). The map's depth is 24 bits: a kilometre of range still holds under 0.1 mm a step.
    const slack = m(40) + 0.25 * (sHi - sLo);
    f.sLo = sLo - slack;
    f.sHi = sHi + slack;
    f.placed = true;
    place(i);
    return true;
  };

  return {
    toSun: holds[0]!.s,
    lights,
    setMovers(next) { movers = next; },
    setCasters(next) { casters = next; },
    follow(camera, sunDirection, groundAt, target, top) {
      if (!enabled) return false;
      camera.updateMatrixWorld();
      const perspective = (camera as PerspectiveCamera).isPerspectiveCamera === true;
      const near = (camera as PerspectiveCamera | OrthographicCamera).near;
      const far = (camera as PerspectiveCamera | OrthographicCamera).far;
      eye.setFromMatrixPosition(camera.matrixWorld);
      camera.getWorldDirection(look);
      // Each corner ray: its point at eye depth d is start + step * d (no scale on the camera: depth in world units).
      for (let k = 0; k < 4; k++) {
        const [x, y] = NDC[k]!;
        p.set(x, y, 0.5).applyMatrix4(camera.projectionMatrixInverse);
        if (perspective) { q.copy(p).divideScalar(-p.z); p.set(0, 0, 0); } else { p.z = 0; q.set(0, 0, -1); }
        startOf[k]!.copy(p).applyMatrix4(camera.matrixWorld);
        stepOf[k]!.copy(q).add(p).applyMatrix4(camera.matrixWorld).sub(startOf[k]!);
      }
      // The ground under the view: the target and where the corner rays meet its level, the lowest of them a little lower.
      let low = target.y, high = Math.max(target.y, top);
      for (let k = 0; k < 4; k++) {
        const s = startOf[k]!, d = stepOf[k]!;
        if (Math.abs(d.y) < 1e-6) continue;
        const t = (target.y - s.y) / d.y;
        if (t < near || t > far) continue;
        const h = groundAt(s.x + d.x * t, -(s.z + d.z * t));
        if (!Number.isFinite(h)) continue;
        low = Math.min(low, h);
        high = Math.max(high, h);
      }
      low -= GROUND_DIP;
      high += m(2);
      // The eye depths over which the corner rays are between the ground and the tops
      let dNear = Infinity, dFar = -Infinity;
      for (let k = 0; k < 4; k++) {
        const s = startOf[k]!, d = stepOf[k]!;
        let t0 = near, t1 = far;
        if (Math.abs(d.y) < 1e-9) {
          if (s.y < low || s.y > high) { t0 = 1; t1 = 0; }
        } else {
          const ta = (low - s.y) / d.y, tb = (high - s.y) / d.y;
          t0 = Math.max(t0, Math.min(ta, tb));
          t1 = Math.min(t1, Math.max(ta, tb));
        }
        enter[k] = t0;
        leave[k] = t1;
        if (t0 <= t1) { dNear = Math.min(dNear, t0); dFar = Math.max(dFar, t1); }
      }
      // The near and far planes' rectangles meet the slab in their middle too
      for (let end = 0; end < 2; end++) {
        const d = end === 0 ? near : far;
        let y0 = Infinity, y1 = -Infinity;
        for (let k = 0; k < 4; k++) { const y = startOf[k]!.y + stepOf[k]!.y * d; y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        if (y1 >= low && y0 <= high) { dNear = Math.min(dNear, d); dFar = Math.max(dFar, d); }
      }
      if (!(dNear < dFar)) return false;
      const dTarget = Math.max(dNear, a.subVectors(target, eye).dot(look));
      const dEnd = Math.min(dFar, dNear + SHADOW_DEPTH_MAX, Math.max(dTarget + SHADOW_REACH, dNear + 3 * (dTarget - dNear)));
      // The splits: the first just past the point looked at, the second halfway in ratio to the end
      const d1 = Math.min(dTarget * 1.5, dNear + (dEnd - dNear) * 0.34);
      const d2 = Math.min(Math.sqrt(d1 * dEnd), d1 + (dEnd - d1) * 0.5);
      splits[0] = dNear; splits[1] = d1; splits[2] = d2; splits[3] = dEnd;
      let any = false;
      for (let i = 0; i < SUN_CASCADES; i++) {
        const from = splits[i]!, to = splits[i + 1]!;
        // Each cascade's sun, held until the true one left its tolerance: a texel of shadow displacement at the tallest caster.
        const hold = holds[i]!;
        sunStepped[i] = hold.take(sunDirection, sunTolerance(i, high - low));
        const sy = Math.max(0.08, hold.s.y);
        let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity, minS = Infinity, maxS = -Infinity;
        const add = (v: Vector3): void => {
          const r = v.dot(hold.r), u = v.dot(hold.u), s = v.dot(hold.s);
          minR = Math.min(minR, r); maxR = Math.max(maxR, r);
          minU = Math.min(minU, u); maxU = Math.max(maxU, u);
          minS = Math.min(minS, s);
          // What stands up to the tops over this point casts onto it: the light reaches that far up the sun
          maxS = Math.max(maxS, s + Math.max(0, high - v.y) / sy);
        };
        for (let k = 0; k < 4; k++) {
          const t0 = Math.max(from, enter[k]!), t1 = Math.min(to, leave[k]!);
          if (t0 > t1) continue;
          add(a.copy(startOf[k]!).addScaledVector(stepOf[k]!, t0));
          add(a.copy(startOf[k]!).addScaledVector(stepOf[k]!, t1));
        }
        // The slice's end rectangles where they cross the ground and the tops
        for (let end = 0; end < 2; end++) {
          const d = end === 0 ? from : to;
          for (let k = 0; k < 4; k++) {
            a.copy(startOf[k]!).addScaledVector(stepOf[k]!, d);
            b.copy(startOf[(k + 1) % 4]!).addScaledVector(stepOf[(k + 1) % 4]!, d);
            for (let level = 0; level < 2; level++) {
              const h = level === 0 ? low : high;
              if ((a.y - h) * (b.y - h) >= 0) continue;
              add(q.copy(a).lerp(b, (h - a.y) / (b.y - a.y)));
            }
          }
        }
        if (!(minR <= maxR)) continue;
        if (fit(i, minR, maxR, minU, maxU, minS, maxS)) { refitted[i] = true; any = true; }
      }
      return any || sunStepped.includes(true);
    },
    takeStats() {
      const out = { passes: stats.passes, whole: [...stats.whole], over: [...stats.over], why: { ...stats.why } };
      stats.passes = 0; stats.whole.fill(0); stats.over.fill(0);
      for (const k of Object.keys(stats.why) as (keyof typeof stats.why)[]) stats.why[k] = 0;
      return out;
    },
    pass({ changed, effects, still = false, keep = false, patch, opened = false }) {
      if (!enabled) return false;
      stats.passes++;
      // DO NOT walk every mover's meshes for its radius once per cascade and draw: once a frame.
      passNo++;
      spheres.clear();
      radii.clear();
      let any = false;
      /** A cascade drawn whole this frame for a refit alone: the others' refits wait their turn, a frame each (Dybisz 2021). */
      let refitDrawn = false;
      for (let i = 0; i < SUN_CASCADES; i++) {
        let moved = false;
        for (const mover of movers) {
          // Past its last cascade a mover is drawn over none (`drawOver`): DO NOT take it for one moving there - the far cascade had its store copied back and a pass over it every frame with nothing to draw (2026-10-21).
          if (moved || !mover.moving() || i > (mover.maxCascade ?? Infinity)) continue;
          for (const root of mover.roots) if (root.visible && drawnIn(root, i, mover.fixedSize)) { moved = true; break; }
        }
        framesSince[i]!++;
        // A store stands for its town only while nothing of it changed since it was taken - or while what changed is known by its box: the store drawn again under the box alone (`patched`), untouched where the box falls outside the square.
        patched[i] = null;
        if (!still && storeValid[i]) {
          const rects = patch === undefined || patch === null || !renderer ? null : rectsOf(i, patch);
          if (rects === null) {
            // Why the store goes (`takeStats`): no box given, a change with no box to tell, or boxes over half the map together.
            if (patch === undefined) stats.why.thrown++; else if (patch === null) stats.why.noBox++; else { stats.why.tooBig++; if (i === 0) stats.why.tooBigNear++; }
            storeValid[i] = false;
          } else if (rects.length > 0) patched[i] = rects;
        } else if (!still) storeValid[i] = false;
        // A far cascade out of its turn (`setFarEvery`): what asked it to be drawn kept for its turn, its map and its matrix left as they were drawn (three updates a light's shadow matrix only as it draws it).
        if (i > 0 && farEvery > 1 && (passNo + i) % farEvery !== 0) {
          carried[i] = carried[i]! || changed || effects;
          continue;
        }
        const wasCarried = carried[i]!;
        carried[i] = false;
        // Its square moved by whole texels (`fit`): scrolled while its store stands and nothing else asks for the whole; else the square is at its new centre and the map is not: drawn whole, as a refit.
        const asked = scroll[i] ?? null;
        scroll[i] = null;
        if (asked !== null && !(renderer !== null && storeValid[i])) refitted[i] = true;
        // The town under the cascade drawn again: it changed, the cascade moved, or no store stands for it. What the wind sways is a mover (`wind.ts` markSway, `renderer.ts`): drawn over the store each frame, never frozen in it (2cc436e0), and the town under a near cascade no longer drawn again every frame for it.
        const all = refitted[i]! || changed || wasCarried || effects || framesSince[i]! >= SAFETY_FRAMES || (moved && (!renderer || !storeValid[i]));
        const scrolling = asked !== null && !all;
        const patching = patched[i] !== null && !all;
        if (!fits[i]!.placed || !(all || moved || scrolling || patching)) continue;
        if (all) {
          // A refit alone, nothing changed: one cascade a frame, the others their turn in the frames after (`refitted` kept), each map and the matrix it was drawn with standing together until then (three sets a light's shadow matrix only as it draws that light). DO NOT draw the three cascades whole in one frame for a sun that moved a tenth of a degree.
          const refitAlone = refitted[i]! && everDrawn[i]! && !changed && !wasCarried && !effects && framesSince[i]! < SAFETY_FRAMES && !(moved && (!renderer || !storeValid[i]));
          if (refitAlone && refitDrawn) { stats.why.deferred++; patched[i] = null; continue; }
          if (refitAlone) refitDrawn = true;
          everDrawn[i] = true;
          stats.whole[i]!++;
          if (refitted[i]) stats.why.refit++; else if (changed || wasCarried) stats.why.changed++; else if (effects) stats.why.effects++; else if (framesSince[i]! >= SAFETY_FRAMES) stats.why.safety++; else stats.why.noStore++;
          lights[i]!.shadow.needsUpdate = true;
          // Kept whenever the town is shown (`opened`): the frames after it scroll and patch it. DO NOT draw it whole unkept in a move: the next
          // frame's movers found no store and drew it whole again (`noStore`), a move's near cascade drawn whole at one pass in five, its
          // scrolls and patches lost (`npm run diagnose`, 2026-10-22). A store costs a copy of the map, and the movers drawn over it.
          // Kept where the view stands (`keep`) as well: DO NOT draw the town whole twice for one change of a caster in a still view (once unkept, then again to keep it, the next frame): two cascade passes of 11 M triangles each for a signal head written again (2026-10-21).
          // Kept as well when what changed is known by its box: the next frames scroll and patch it rather than draw the town again.
          whole[i] = renderer !== null && (opened || still || keep || (patch !== undefined && patch !== null));
          patched[i] = null;
          // Drawn for safety alone: its turn kept; drawn with the others (a change, a refit, effects): its turn set apart from theirs.
          const safetyAlone = !refitted[i] && !changed && !wasCarried && !effects && framesSince[i]! >= SAFETY_FRAMES;
          refitted[i] = false;
          framesSince[i] = safetyAlone ? 0 : -i * SAFETY_STAGGER;
        } else if (scrolling || patching) {
          // Kept whole after the scroll and the patch: the map copied to the store, the movers drawn over it (`shadowMap.render`).
          scrolled[i] = scrolling ? asked : null;
          whole[i] = true;
        } else { over[i] = true; stats.over[i]!++; }
        any = true;
      }
      return any;
    },
    setEnabled(on, mapSize) {
      enabled = on;
      lights.forEach((light, i) => {
        light.castShadow = on;
        // The other cascades light nothing of their own: without shadows they are not lights at all
        if (i > 0) light.visible = on;
        // The near cascade at the full size; the far ones at half (a quarter of the texels each): their shadows are filtered over a texel's spread anyway.
        const size = typeof mapSize === 'number' ? (i === 0 ? mapSize : Math.max(512, Math.floor(mapSize / 2))) : mapSize[i] ?? mapSize[0]!;
        if (light.shadow.mapSize.x !== size) {
          light.shadow.mapSize.set(size, size);
          light.shadow.map?.dispose();
          light.shadow.map = null;
          fits[i]!.placed = false;
        }
        // Off: the map and the store given back (`ensureMap` makes them again when the cascade is next drawn, `refitted` below).
        if (!on) {
          light.shadow.map?.dispose();
          light.shadow.map = null;
          stores[i]?.dispose();
          stores[i] = null;
        }
        storeValid[i] = false;
        refitted[i] = true;
        everDrawn[i] = false;
      });
    },
    coverBox(target, margin) {
      target.makeEmpty();
      if (!enabled) return false;
      for (let i = 0; i < Math.min(KEEP_CASCADES, SUN_CASCADES); i++) {
        const f = fits[i]!;
        if (!f.placed) continue;
        const hold = holds[i]!;
        // The square's eight corners in the world: light right, up and toward the sun its basis (`place`).
        for (let c = 0; c < 8; c++) {
          const r = f.cr + ((c & 1) ? f.half : -f.half), u = f.cu + ((c & 2) ? f.half : -f.half), s = (c & 4) ? f.sHi : f.sLo;
          corner.set(0, 0, 0).addScaledVector(hold.r, r).addScaledVector(hold.u, u).addScaledVector(hold.s, s);
          target.expandByPoint(corner);
        }
      }
      if (target.isEmpty()) return false;
      target.expandByScalar(margin);
      return true;
    },
    setFarEvery(n) {
      farEvery = Math.max(1, Math.floor(n));
      if (farEvery === 1) carried.fill(false);
    },
    remakeMaps() {
      lights.forEach((light, i) => {
        light.shadow.map?.dispose();
        light.shadow.map = null;
        storeValid[i] = false;
        refitted[i] = true;
        everDrawn[i] = false;
      });
    },
    syncLight() {
      for (let i = 1; i < lights.length; i++) {
        lights[i]!.color.copy(sun.color);
        lights[i]!.intensity = sun.intensity;
      }
    },
    maps: () => [...lights.map((light) => light.shadow.map as WebGLRenderTarget | null), ...stores],
    restore,
    dispose() {
      restore();
      for (const store of stores) store?.dispose();
      for (const light of lights) light.dispose();
    },
  };
}

/** The sun's cascades in three's shaders: the directional lights that cast shadows are the sun's cascades, all of one direction and colour */
export function cascadedSunChunks(): void {
  // The cascades' coordinates worked out in the fragment, from its world position and normal (`SUN_CASCADE_COORD`): the vertex passes those two, not three coordinates.
  const varyingCoords = 'varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];';
  for (const name of ['shadowmap_pars_vertex', 'shadowmap_pars_fragment'] as const) {
    const pars = ShaderChunk[name];
    if (pars.includes('vSunCascadeWorld')) continue;
    if (!pars.includes(varyingCoords)) throw new Error(`three.js ${name} changed: the sun cascades' world varyings no longer apply`);
    const matrices = name === 'shadowmap_pars_fragment' ? '\n\t\tuniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];' : '';
    ShaderChunk[name] = pars.replace(varyingCoords, `#if NUM_DIR_LIGHT_SHADOWS == ${SUN_CASCADES}
		varying vec3 vSunCascadeWorld;
		varying vec3 vSunCascadeNormal;${matrices}
		#else
		${varyingCoords}
		#endif`);
  }
  const parsEnd = '\n#endif\n';
  if (!ShaderChunk.shadowmap_pars_fragment.includes('sunCascadeShadow')) {
    const pars = ShaderChunk.shadowmap_pars_fragment;
    const at = pars.lastIndexOf(parsEnd.trim());
    if (at < 0) throw new Error('three.js shadowmap_pars_fragment changed: the sun cascades no longer apply');
    ShaderChunk.shadowmap_pars_fragment = `${pars.slice(0, at)}${CASCADE_PARS}\n${pars.slice(at)}`;
  }
  const lights = ShaderChunk.lights_fragment_begin;
  if (lights.includes('sunCascadeShadow')) return;
  const head = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )\n';
  const at = lights.indexOf(head);
  if (at < 0 || !lights.includes('directionalShadowMap[ i ]')) throw new Error('three.js lights_fragment_begin changed: the sun cascades no longer apply');
  ShaderChunk.lights_fragment_begin = `${lights.slice(0, at)}${CASCADE_LIGHTS}#elif ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )\n${lights.slice(at + head.length)}`;
}

/** The vertex's part of the cascades (after `environment.ts` slopeScaledShadowOffset): its world position and normal passed on, each cascade's coordinate worked out in the fragment (`SUN_CASCADE_COORD`). The loop for any other count of directional shadows stays as three wrote it. */
export function cascadedSunVertexChunk(): void {
  const chunk = ShaderChunk.shadowmap_vertex;
  if (chunk.includes('vSunCascadeWorld')) return;
  const head = '#if NUM_DIR_LIGHT_SHADOWS > 0';
  if (chunk.split(head).length !== 2) throw new Error("three.js shadowmap_vertex changed: the sun cascades' world varyings no longer apply");
  ShaderChunk.shadowmap_vertex = chunk.replace(head, `#if NUM_DIR_LIGHT_SHADOWS == ${SUN_CASCADES}

		vSunCascadeWorld = worldPosition.xyz;
		vSunCascadeNormal = shadowWorldNormal;

	#elif NUM_DIR_LIGHT_SHADOWS > 0`);
}

/** The finest cascade that holds the point, blended into the next one over the outer `BAND` of its map; past the last, no shadow */
const CASCADE_PARS = /* glsl */ `
	#if NUM_DIR_LIGHT_SHADOWS == ${SUN_CASCADES}
		// How far inside its map a point is, in the map's own measure (negative: outside), the PCF taps' reach kept inside
		float sunCascadeRim( vec4 coord, vec2 mapSize, float radius ) {
			vec3 c = coord.xyz / coord.w;
			if ( c.z < 0.0 || c.z > 1.0 ) return - 1.0;
			vec2 inset = vec2( radius + 1.5 ) / mapSize;
			vec2 d = min( c.xy - inset, 1.0 - inset - c.xy );
			return min( d.x, d.y );
		}
		// A cascade's coordinate of the fragment: its world position offset along its normal by the slope of the receiver (Unity URP's bias, environment.ts slopeScaledShadowOffset), as three's shadowmap_vertex did per vertex for every cascade. DO NOT work the three out in the vertex: the city's 15-20 M vertices a frame each paid three matrices and three normalised axes, and the frame is bound by its vertices (a quarter of the pixels saved 1.2 ms of 18.5, shadows off 3.7, measured 2026-10-20).
		vec4 sunCascadeCoordOf( mat4 shadowMatrix, float normalBias ) {
			vec3 sunAxis = normalize( vec3( shadowMatrix[ 0 ][ 2 ], shadowMatrix[ 1 ][ 2 ], shadowMatrix[ 2 ][ 2 ] ) );
			#ifdef USE_REVERSED_DEPTH_BUFFER
				sunAxis = - sunAxis;
			#endif
			float grazing = 1.0 - clamp( - dot( vSunCascadeNormal, sunAxis ), 0.0, 1.0 );
			return shadowMatrix * vec4( vSunCascadeWorld + vSunCascadeNormal * normalBias * ( 0.4 + 2.6 * grazing ), 1.0 );
		}
		#define SUN_CASCADE_COORD( i ) sunCascadeCoordOf( directionalShadowMatrix[ i ], directionalLightShadows[ i ].shadowNormalBias )
		#define SUN_CASCADE_RIM( i, c ) sunCascadeRim( c, directionalLightShadows[ i ].shadowMapSize, directionalLightShadows[ i ].shadowRadius )
		#define SUN_CASCADE_SHADOW( i, c ) getShadow( directionalShadowMap[ i ], directionalLightShadows[ i ].shadowMapSize, directionalLightShadows[ i ].shadowIntensity, directionalLightShadows[ i ].shadowBias, directionalLightShadows[ i ].shadowRadius, c )
		// The last cascade's shadow where it holds the point, else the fallback.
		float sunCascadeLast( float fallback ) { vec4 c2 = SUN_CASCADE_COORD( 2 ); return SUN_CASCADE_RIM( 2, c2 ) > 0.0 ? SUN_CASCADE_SHADOW( 2, c2 ) : fallback; }
		float sunCascadeShadow() {
			const float BAND = 0.08;
			// Each cascade's coordinate only when it is read: the finest that holds the point, the next only in the band it is blended over.
			vec4 c0 = SUN_CASCADE_COORD( 0 );
			float e0 = SUN_CASCADE_RIM( 0, c0 );
			// One return, every path assigned (fxc warns X4000 on the early returns through ANGLE).
			float shadow = 1.0;
			if ( e0 > 0.0 ) {
				float near = SUN_CASCADE_SHADOW( 0, c0 ), next = near;
				if ( e0 < BAND ) { vec4 c1 = SUN_CASCADE_COORD( 1 ); next = SUN_CASCADE_RIM( 1, c1 ) > 0.0 ? SUN_CASCADE_SHADOW( 1, c1 ) : sunCascadeLast( near ); }
				shadow = mix( next, near, min( 1.0, e0 / BAND ) );
			} else {
				vec4 c1 = SUN_CASCADE_COORD( 1 );
				float e1 = SUN_CASCADE_RIM( 1, c1 );
				if ( e1 > 0.0 ) {
					float near = SUN_CASCADE_SHADOW( 1, c1 );
					shadow = mix( e1 < BAND ? sunCascadeLast( near ) : near, near, min( 1.0, e1 / BAND ) );
				} else {
					vec4 c2 = SUN_CASCADE_COORD( 2 );
					float e2 = SUN_CASCADE_RIM( 2, c2 );
					if ( e2 > 0.0 ) shadow = mix( 1.0, SUN_CASCADE_SHADOW( 2, c2 ), min( 1.0, e2 / BAND ) );
				}
			}
			return shadow;
		}
	#endif
`;

/** The sun lit once, by its cascades' shadow; the other directional lights (the fill) as three lights them */
const CASCADE_LIGHTS = /* glsl */ `#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct ) && NUM_DIR_LIGHT_SHADOWS == ${SUN_CASCADES}

	DirectionalLight directionalLight;
	getDirectionalLightInfo( directionalLights[ 0 ], directLight );
	#if defined( USE_SHADOWMAP )
	directLight.color *= ( directLight.visible && receiveShadow ) ? sunCascadeShadow() : 1.0;
	#endif
	RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	#if NUM_DIR_LIGHTS > ${SUN_CASCADES}
	#pragma unroll_loop_start
	for ( int i = ${SUN_CASCADES}; i < NUM_DIR_LIGHTS; i ++ ) {

		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	}
	#pragma unroll_loop_end
	#endif

`;
