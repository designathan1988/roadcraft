import {
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
  WebGLRenderTarget,
  type Camera,
  type Light,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three';
import { m } from '@world/units';

/** THE SUN'S CASCADED SHADOW MAPS (cascaded shadow maps, Engel, ShaderX5; stable fitting after Valient, ShaderX6) */

/** The sun's cascades: three lights of one direction and colour, each with its own map; the shader lights a pixel once, with the finest map holding it. */
export const SUN_CASCADES = 3;
/** How far the cascades reach past the point looked at, eye depth: the street sees shadows this far (800 m). */
const SHADOW_REACH = m(800);
/** The most eye depth the cascades cover, the whole map seen from above at most. */
const SHADOW_DEPTH_MAX = m(8000);
/** How far the sun the shadows are cast by may drift from the true one before it is moved (rad): 0.1 degree. */
const SUN_STEP = (0.1 * Math.PI) / 180;
/** Depth offset of the shadow test, world units (4 cm). */
const SHADOW_BIAS_WORLD = m(0.04);
/** A cascade drawn over this many frames' worth of change at most: a missed change shows for half a second, never for good. */
const SAFETY_FRAMES = 30;
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
}

export interface ShadowPassInput {
  /** The world under the shadows changed (buildings streamed in, an edit): every cascade. */
  readonly changed: boolean;
  /** Effects in play (`playEffects.ts`): their pieces are in every cascade. */
  readonly effects: boolean;
  /** The wind sways the plants: the two near cascades, where a sway is wider than a texel. */
  readonly wind: boolean;
  /** Nothing that casts and stands still changed since the last pass, as the caller knows it (the view, what landed, came or went): a cascade's store may stand for its town. Absent: it may not. */
  readonly still?: boolean;
}

export interface SunCascades {
  /** Cascade 0 is the sun the rest of the game reads (its colour, intensity and direction). */
  readonly lights: readonly DirectionalLight[];
  /** Towards the sun the cascades are cast by (unit; zero before the first `follow`): the held sun itself, never a light's position less its target (those move with every fit, and their difference by the last bits). */
  readonly toSun: Vector3;
  setMovers(movers: readonly Movers[]): void;
  /** What chooses its casters by size, told each cascade's texel (m) before that cascade is drawn (a piece narrower than it is a smudge PCF spreads away), and null once the passes are done. */
  setCasters(casters: ((texel: number | null, cascade: number) => void) | null): void;
  /** Fits the cascades to what the camera sees of the ground and what stands on it */
  follow(camera: Camera, sunDirection: Vector3, groundAt: (x: number, y: number) => number, target: Vector3, top: number): boolean;
  /** Marks the cascades that must be drawn this frame; true when any is (the renderer's `shadowMap.needsUpdate`). */
  pass(input: ShadowPassInput): boolean;
  setEnabled(on: boolean, mapSize: number): void;
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

  /** Takes the true sun; true when the held one moved. */
  take(sun: Vector3): boolean {
    if (this.held && this.s.angleTo(sun) <= SUN_STEP) return false;
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

/** A cascade's map as three's PCF shadow map makes it (r186 `WebGLShadowMap`: a depth texture compared, linear), its colour, which nothing reads, one byte a texel instead of four. */
function cascadeMap(size: number, name: string, reversed: boolean): WebGLRenderTarget {
  const map = new WebGLRenderTarget(size, size, { format: RedFormat, type: UnsignedByteType, depthTexture: new DepthTexture(size, size, UnsignedIntType) });
  const depth = map.depthTexture!;
  depth.name = name;
  depth.format = DepthFormat;
  depth.compareFunction = reversed ? GreaterEqualCompare : LessEqualCompare;
  depth.minFilter = LinearFilter;
  depth.magFilter = LinearFilter;
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
  const framesSince = lights.map(() => 0);
  const hold = new SunHold();
  let sunStepped = true;
  let movers: readonly Movers[] = [];
  let casters: ((texel: number | null, cascade: number) => void) | null = null;
  let enabled = true;
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
  const measureSphere = (object: Object3D): number => {
    let radius = 0;
    object.traverse((o) => {
      const mesh = o as Mesh & { isInstancedMesh?: boolean; count?: number; instanceMatrix?: { array: ArrayLike<number> } };
      if (!mesh.isMesh) return;
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
    });
    return radius;
  };
  /** DO NOT walk a root's tree for every cascade and twice a frame: each root's radius once a frame (`pass` clears it). */
  const spheres = new Map<Object3D, number>();
  const sphereOf = (object: Object3D): number => {
    let radius = spheres.get(object);
    if (radius === undefined) spheres.set(object, radius = measureSphere(object));
    return radius;
  };
  const texelOf = (i: number): number => (2 * fits[i]!.half) / Math.max(1, lights[i]!.shadow.mapSize.x);
  /** A mover is drawn into cascade `i` only if it is wider than two of its texels: under that, its shadow is a smudge PCF spreads away. */
  const drawnIn = (root: Object3D, i: number): boolean => {
    let r = radii.get(root);
    if (r === undefined) { r = sphereOf(root); radii.set(root, r); }
    return r >= texelOf(i);
  };

  shadows.forEach((shadow, i) => {
    shadow.beforeDraw = () => {
      // The last cascade's hidden roots back; its casters left chosen, this cascade chooses them all again.
      restore(false);
      // The movers alone over the store: nothing hidden, and the town's casters left as they are.
      if (drawingMovers) return;
      for (const mover of movers) {
        for (const root of mover.roots) {
          // Kept in a store this frame (`whole`): every mover is drawn over it after the still casters (`drawOver`); else drawn with them, those too small for the texels left out.
          if (!root.visible || (!whole[i] && drawnIn(root, i))) continue;
          root.visible = false;
          hidden.push(root);
        }
      }
      casters?.(texelOf(i), i);
      castersChosen = casters !== null;
    };
  });

  /** Cascade `i`'s map as three made it, or ours: one byte of colour, its depth compared. */
  const ensureMap = (i: number): void => {
    if (!renderer) return;
    const shadow = lights[i]!.shadow;
    const size = shadow.mapSize.x;
    if (!shadow.map) shadow.map = cascadeMap(size, `${lights[i]!.name}.shadowMap`, renderer.capabilities.reversedDepthBuffer);
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
    for (const mover of movers) for (const root of mover.roots) if (root.visible && drawnIn(root, i)) castersIn(root, texel, moverList);
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

  if (renderer) {
    const shadowMap = renderer.shadowMap;
    const base = shadowMap.render.bind(shadowMap) as (lights: Light[], scene: Scene, camera: Camera) => void;
    shadowMap.render = (shadowLights: Light[], scene: Scene, camera: Camera): void => {
      // A render of another scene (its own lights): nothing of the cascades' here.
      if (!shadowLights.includes(sun)) { base(shadowLights, scene, camera); return; }
      for (let i = 0; i < lights.length; i++) if (whole[i] || over[i]) ensureMap(i);
      base(shadowLights, scene, camera);
      if (!whole.includes(true) && !over.includes(true)) return;
      restore();
      const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), level = renderer.getActiveMipmapLevel();
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
    if (settled && castersChosen) { castersChosen = false; casters?.(null, -1); }
  }

  /** Writes a fit into its light: the light stands at the top of the depth range, looking down the sun. */
  const place = (i: number): void => {
    const light = lights[i]!;
    const fit = fits[i]!;
    const camera = light.shadow.camera;
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
    const fits0 = f.placed && !sunStepped
      && f.half >= need && f.half <= need * SHRINK * ROOM
      && minR >= f.cr - f.half && maxR <= f.cr + f.half && minU >= f.cu - f.half && maxU <= f.cu + f.half
      && sLo >= f.sLo && sHi <= f.sHi;
    if (fits0) return false;
    // A half-side on the ladder 2^(k/4) m: the same cascade size over a range of views, so its texels stay where they were
    const step = Math.ceil(4 * Math.log2(Math.max(m(1), need * ROOM) / m(1)));
    f.half = m(1) * 2 ** (step / 4);
    // The centre on whole texels of the light's grid: the map moves by whole texels, so a shadow's edge never crawls
    const texel = (2 * f.half) / Math.max(1, lights[i]!.shadow.mapSize.x);
    f.cr = Math.round((minR + maxR) / 2 / texel) * texel;
    f.cu = Math.round((minU + maxU) / 2 / texel) * texel;
    const slack = m(10) + 0.1 * (sHi - sLo);
    f.sLo = sLo - slack;
    f.sHi = sHi + slack;
    f.placed = true;
    place(i);
    return true;
  };

  return {
    toSun: hold.s,
    lights,
    setMovers(next) { movers = next; },
    setCasters(next) { casters = next; },
    follow(camera, sunDirection, groundAt, target, top) {
      if (!enabled) return false;
      sunStepped = hold.take(sunDirection);
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
      const sy = Math.max(0.08, hold.s.y);
      let any = false;
      for (let i = 0; i < SUN_CASCADES; i++) {
        const from = splits[i]!, to = splits[i + 1]!;
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
      return any || sunStepped;
    },
    pass({ changed, effects, wind, still = false }) {
      if (!enabled) return false;
      // DO NOT walk every mover's meshes for its radius once per cascade and draw: once a frame.
      spheres.clear();
      radii.clear();
      let any = false;
      for (let i = 0; i < SUN_CASCADES; i++) {
        let moved = false;
        for (const mover of movers) {
          if (moved || !mover.moving()) continue;
          for (const root of mover.roots) if (root.visible && drawnIn(root, i)) { moved = true; break; }
        }
        framesSince[i]!++;
        // A store stands for its town only while nothing of it changed since it was taken.
        if (!still) storeValid[i] = false;
        // The town under the cascade drawn again: it changed, the cascade moved, the wind sways its plants, or no store stands for it.
        // DO NOT draw a near cascade over its store: the plants and flags sway at every strength of the wind (`wind.ts` uWindStrength, never 0), wider than its texels; a frame of movers drew them swaying.
        const all = refitted[i]! || changed || effects || (wind && i < SUN_CASCADES - 1) || framesSince[i]! >= SAFETY_FRAMES
          || (moved && (!renderer || !storeValid[i] || i < SUN_CASCADES - 1));
        if (!fits[i]!.placed || !(all || moved)) continue;
        if (all) {
          lights[i]!.shadow.needsUpdate = true;
          // DO NOT keep a store no frame will use: the view moving (`still` false, it stands for nothing next frame), or a near cascade (drawn whole whenever anything moves, the sway): the movers drawn in the same pass, no copy, no second pass over them.
          whole[i] = renderer !== null && still && i === SUN_CASCADES - 1;
          refitted[i] = false;
          framesSince[i] = 0;
        } else over[i] = true;
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
        if (light.shadow.mapSize.x !== mapSize) {
          light.shadow.mapSize.set(mapSize, mapSize);
          light.shadow.map?.dispose();
          light.shadow.map = null;
          fits[i]!.placed = false;
        }
        storeValid[i] = false;
        refitted[i] = true;
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
		#define SUN_CASCADE_SHADOW( i ) getShadow( directionalShadowMap[ i ], directionalLightShadows[ i ].shadowMapSize, directionalLightShadows[ i ].shadowIntensity, directionalLightShadows[ i ].shadowBias, directionalLightShadows[ i ].shadowRadius, vDirectionalShadowCoord[ i ] )
		float sunCascadeShadow() {
			const float BAND = 0.08;
			float e0 = sunCascadeRim( vDirectionalShadowCoord[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowRadius );
			float e1 = sunCascadeRim( vDirectionalShadowCoord[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowRadius );
			float e2 = sunCascadeRim( vDirectionalShadowCoord[ 2 ], directionalLightShadows[ 2 ].shadowMapSize, directionalLightShadows[ 2 ].shadowRadius );
			// One return, every path assigned (fxc warns X4000 on the early returns through ANGLE).
			float shadow = 1.0;
			if ( e0 > 0.0 ) {
				float near = SUN_CASCADE_SHADOW( 0 );
				float next = near;
				if ( e0 < BAND ) next = e1 > 0.0 ? SUN_CASCADE_SHADOW( 1 ) : e2 > 0.0 ? SUN_CASCADE_SHADOW( 2 ) : near;
				shadow = mix( next, near, min( 1.0, e0 / BAND ) );
			} else if ( e1 > 0.0 ) {
				float near = SUN_CASCADE_SHADOW( 1 );
				float next = near;
				if ( e1 < BAND ) next = e2 > 0.0 ? SUN_CASCADE_SHADOW( 2 ) : near;
				shadow = mix( next, near, min( 1.0, e1 / BAND ) );
			} else if ( e2 > 0.0 ) {
				shadow = mix( 1.0, SUN_CASCADE_SHADOW( 2 ), min( 1.0, e2 / BAND ) );
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
