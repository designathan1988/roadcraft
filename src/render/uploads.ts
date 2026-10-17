import { BackSide, BufferGeometry, DoubleSide, Float32BufferAttribute, FrontSide, Group, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial, MeshDepthMaterial, Object3D, OrthographicCamera, Scene as ThreeScene, WebGLRenderTarget, type Camera, type Light, type Material, type Mesh, type Scene, type Side, type Texture, type WebGLRenderer } from 'three';

/** Textures waiting to be sent to the GPU ahead of their first use. three.js uploads a texture the first time something */
const queue: Texture[] = [];
const queued = new WeakSet<Texture>();
const sent = new WeakSet<Texture>();

export function queueUpload(...textures: (Texture | null | undefined)[]): void {
  for (const t of textures) {
    if (!t || sent.has(t) || queued.has(t)) continue;
    queued.add(t);
    queue.push(t);
  }
}

/** A model released before its scheduled upload must never reach the GPU later. */
export function cancelUploads(textures: Iterable<Texture>): void {
  const canceled = new Set(textures);
  for (let i = queue.length - 1; i >= 0; i--) if (canceled.has(queue[i]!)) {
    queued.delete(queue[i]!);
    queue.splice(i, 1);
  }
}

/** Sends queued textures to the GPU, at most `count` this frame. */
export function drainUploads(renderer: WebGLRenderer, count = 1): void {
  for (let i = 0; i < count && queue.length; i++) {
    const t = queue.shift()!;
    queued.delete(t);
    if (sent.has(t)) continue;
    sent.add(t);
    renderer.initTexture(t);
  }
}

/** A pass drawn into a target of its own, in a scene of its own: its programs are keyed by that scene's lights and that target (three's `WebGLPrograms` getParameters). */
interface OwnPass { readonly camera: Camera; readonly target: WebGLRenderTarget }
/** Objects whose shaders must be compiled before they are first drawn */
const toCompile: { object: Object3D; shadow: boolean; done: () => void; pass?: OwnPass }[] = [];
/** What a shadow program is built for: a render target as a shadow map is (no colour space, no tone mapping). */
let shadowTarget: WebGLRenderTarget | null = null;
/** Whether a renderer is answering (none in tests: nothing is waited for there). */
let compiler = false;

/** DO NOT give the stand-in RGBA packing: the packing is part of the program's key */
const SHADOW_SIDE: Record<Side, Side> = { [FrontSide]: BackSide, [BackSide]: FrontSide, [DoubleSide]: DoubleSide };
const plainDepth = new MeshDepthMaterial();
/** What three's shadow pass sets a caster's depth material to from the material it is drawn with (r186 `WebGLShadowMap` getDepthMaterial). */
interface DepthVariant {
  readonly side: Side; readonly alphaTest: number; readonly map: Texture | null; readonly alphaMap: Texture | null;
  readonly displacementMap: Texture | null;
}
const DEPTH_VARIANT = 'roadcraftDepthVariant';
type DepthMaterial = Material & { map?: Texture | null; alphaMap?: Texture | null; displacementMap?: Texture | null };
type CasterMaterial = DepthMaterial & { shadowSide?: Side | null };
const setDepth = (depth: DepthMaterial, v: DepthVariant): void => {
  depth.side = v.side;
  depth.alphaTest = v.alphaTest;
  depth.map = v.map;
  depth.alphaMap = v.alphaMap;
  depth.displacementMap = v.displacementMap;
};
const depthVariantOf = (material: CasterMaterial): DepthVariant => ({
  side: material.shadowSide ?? SHADOW_SIDE[material.side],
  alphaTest: material.alphaToCoverage ? 0.5 : material.alphaTest,
  map: material.map ?? null, alphaMap: material.alphaMap ?? null, displacementMap: material.displacementMap ?? null,
});
/** What of a variant is in the depth program's key (three's `getProgramCacheKey`: the side, the cut, which maps). */
const variantKey = (v: DepthVariant): string => `${v.side}|${v.alphaTest > 0}|${!!v.map}|${!!v.alphaMap}|${!!v.displacementMap}`;
/** A caster as the shadow pass draws it: on its own depth material (or three's plain one) */
export function shadowStandIn(mesh: Mesh): Object3D | null {
  if (!mesh.castShadow) return null;
  const custom = (mesh as Mesh & { customDepthMaterial?: Material }).customDepthMaterial as DepthMaterial | undefined;
  const depth = custom ?? plainDepth;
  const standIns: Mesh[] = [];
  const seen = new Set<string>();
  // A mesh of several materials is drawn into the shadow a group at a time, each group's material setting the depth's variant.
  for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as CasterMaterial[]) {
    const variant = depthVariantOf(material);
    const key = variantKey(variant);
    if (seen.has(key)) continue;
    seen.add(key);
    const copy = compileCopy(mesh) as Mesh;
    copy.material = depth;
    // DO NOT compile them with the material as the last one left it: a sign's plate (a map, cut by its alpha) and a bench
    copy.userData[DEPTH_VARIANT] = variant;
    copy.visible = true;
    standIns.push(copy);
  }
  if (standIns.length === 1) return standIns[0]!;
  const group = new Group();
  for (const standIn of standIns) group.add(standIn);
  return group;
}

/** What of a caster is in its depth program's key: one stand-in compiles every caster alike (`shadowStandIns`). */
function casterKey(mesh: Mesh): string {
  const custom = (mesh as Mesh & { customDepthMaterial?: Material }).customDepthMaterial;
  const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as CasterMaterial[];
  const instanced = mesh as Mesh & { isInstancedMesh?: boolean; instanceColor?: unknown; morphTexture?: unknown };
  const geometry = mesh.geometry;
  const morph = geometry.morphAttributes['position'] ?? geometry.morphAttributes['normal'] ?? geometry.morphAttributes['color'];
  return [custom?.uuid ?? 'plain', materials.map((m) => variantKey(depthVariantOf(m))).join(';'),
    !!instanced.isInstancedMesh, !!instanced.instanceColor, !!instanced.morphTexture, !!(mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh,
    Object.keys(geometry.attributes).sort().join(','), Object.keys(geometry.morphAttributes).sort().join(','), morph?.length ?? 0].join('/');
}

/** The casters under `root`, one stand-in for each depth program they are drawn with (`shadowStandIn`). Once, at load. */
export function shadowStandIns(root: Object3D): Group {
  const group = new Group();
  const seen = new Set<string>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || !mesh.castShadow) return;
    const key = casterKey(mesh);
    if (seen.has(key)) return;
    seen.add(key);
    const standIn = shadowStandIn(mesh);
    if (standIn) group.add(standIn);
  });
  return group;
}

/** A copy of `object` to build its programs with: the same geometry, material and variant */
export function compileCopy(object: Object3D): Object3D {
  const instanced = object as InstancedMesh;
  if (!instanced.isInstancedMesh) return object.clone(false);
  const copy = new InstancedMesh(instanced.geometry, instanced.material, 1);
  Object3D.prototype.copy.call(copy, instanced, false);
  if (instanced.instanceColor) copy.instanceColor = new InstancedBufferAttribute(new Float32Array(3).fill(1), 3);
  copy.morphTexture = instanced.morphTexture;
  return copy;
}

/** `shadow`: the object's material is a shadow's depth material, compiled for a shadow map. */
export function compileAhead(object: Object3D, shadow = false): Promise<void> {
  if (!compiler) return Promise.resolve();
  return new Promise((done) => toCompile.push({ object, shadow, done }));
}

/** DO NOT draw a pass of its own (`people/crowdAnimation.ts` palette pass) before its program is built: compiled on its first draw, in the frame (2026-10-16) */
export function compilePassAhead(scene: Scene, camera: Camera, target: WebGLRenderTarget): Promise<void> {
  if (!compiler) return Promise.resolve();
  return new Promise((done) => toCompile.push({ object: scene, shadow: false, done, pass: { camera, target } }));
}

/** Starts compiling what is waiting; each promise settles when its shaders are ready. */
export function drainCompiles(renderer: WebGLRenderer, camera: Camera, scene: Scene, target: WebGLRenderTarget | null): void {
  compiler = true;
  if (!toCompile.length) return;
  // For the target the scene is really drawn into: its colour space and tone mapping are part of every program.
  const previous = renderer.getRenderTarget();
  try {
    while (toCompile.length) {
      const { object, shadow, done, pass } = toCompile.shift()!;
      if (pass) {
        // Its own scene's lights (none) and its own target, as it is drawn.
        renderer.setRenderTarget(pass.target);
        try {
          renderer.compileAsync(object, pass.camera, object as Scene).then(() => done(), () => done());
        } catch (error) {
          console.error('[uploads] the program of a pass could not be compiled ahead', error);
          done();
        }
        continue;
      }
      renderer.setRenderTarget(shadow ? shadowTarget ??= new WebGLRenderTarget(1, 1) : target);
      // Each stand-in on its depth material set to its own variant (`shadowStandIn`), then the whole if anything else is in it
      const units: { readonly object: Object3D; readonly variant?: DepthVariant }[] = [];
      let others = false;
      object.traverse((o) => {
        const variant = o.userData[DEPTH_VARIANT] as DepthVariant | undefined;
        if (variant) units.push({ object: o, variant });
        else if ((o as Mesh).isMesh) others = true;
      });
      // DO NOT compile the stand-ins again with the whole: a depth material shared by several is left at the last one's variant.
      if (others || units.length === 0) units.push({ object });
      const compiled: Promise<unknown>[] = [];
      for (const unit of units) {
        if (unit.variant) setDepth((unit.object as Mesh).material as DepthMaterial, unit.variant);
        // DO NOT let one program that cannot be built stop the others, nor the frame: said, and the promise still settles.
        try {
          compiled.push(renderer.compileAsync(unit.object, camera, scene));
        } catch (error) {
          console.error('[uploads] a program could not be compiled ahead', error);
        }
      }
      Promise.all(compiled).then(() => done(), () => done());
    }
  } finally {
    renderer.setRenderTarget(previous);
  }
}

/** Meshes whose geometry must be on the GPU before they are first drawn. three.js sends a geometry's buffers */
const WARM_LAYER = 31;
const toWarm: { mesh: Mesh; geometries: readonly BufferGeometry[]; done: () => void }[] = [];
/** DO NOT queue loose meshes behind the scene's: one FIFO stopped at a scene job at its head, and the masses behind it kept their CPU arrays (110 MB, 2026-10-16). */
interface LooseJob { readonly mesh: Mesh; readonly done: () => void; readonly priority: () => number; rank: number }
const toWarmLoose: LooseJob[] = [];
let warmer = false;
const lightsOf = new WeakMap<Scene, Light[]>();
export function warmAhead(mesh: Mesh, geometries: readonly BufferGeometry[]): Promise<void> {
  if (!warmer) return Promise.resolve();
  return new Promise((done) => toWarm.push({ mesh, geometries, done }));
}
/** Meshes not in the scene yet (a batch of buildings put together to replace the one drawn); `priority`: the pixels of error their absence leaves on the screen, the largest sent first. */
export function warmLooseAhead(meshes: readonly Mesh[], priority: () => number = () => 0): Promise<void> | null {
  // Nothing to wait for where no frame warms (tests, before the first frame).
  if (!warmer || meshes.length === 0) return null;
  return Promise.all(meshes.map((mesh) => new Promise<void>((done) => toWarmLoose.push({ mesh, done, priority, rank: 0 })))).then(() => {});
}
/** DO NOT dispose a mesh still waiting here without this */
export function cancelWarm(meshes: Iterable<Mesh>): void {
  const gone = new Set(meshes);
  for (const queue of [toWarm, toWarmLoose] as { mesh: Mesh; done: () => void }[][]) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const job = queue[i]!;
      if (!gone.has(job.mesh)) continue;
      queue.splice(i, 1);
      job.done();
    }
  }
}
/** Sends one waiting scene mesh's geometry to the GPU, after the frame (`renderer.ts`), and loose meshes by their error on the screen within a few milliseconds (one at least, so the queue always moves). */
export function drainWarm(renderer: WebGLRenderer, camera: Camera, scene: Scene, target: WebGLRenderTarget | null): void {
  warmer = true;
  warmOne(renderer, camera, scene, target);
  if (toWarmLoose.length === 0) return;
  const until = performance.now() + WARM_SLICE_MS;
  // Ranked once a frame, the largest error last (popped first); the eye moved since they were queued.
  for (const job of toWarmLoose) job.rank = job.priority();
  toWarmLoose.sort((a, b) => a.rank - b.rank);
  do {
    const job = toWarmLoose.pop()!;
    try { warmLoose(renderer, job.mesh, [job.mesh.geometry]); } finally { job.done(); }
  } while (toWarmLoose.length > 0 && performance.now() < until);
}
/** Milliseconds a frame for loose meshes (`drainWarm`). */
const WARM_SLICE_MS = 6;
/** Whether meshes still wait to go to the GPU: the renderer asks for another frame meanwhile. */
export function warmPending(): boolean {
  return toWarm.length > 0 || toWarmLoose.length > 0;
}

/** A loose mesh's buffers sent up in a scene of its own (`warmLoose`) */
const LOOSE = {
  scene: Object.assign(new ThreeScene(), { matrixWorldAutoUpdate: false }),
  camera: new OrthographicCamera(),
  material: new MeshBasicMaterial(),
  target: new WebGLRenderTarget(1, 1),
};
LOOSE.scene.overrideMaterial = LOOSE.material;

/** DO NOT draw the whole scene for it (on a layer of its own) */
function warmLoose(renderer: WebGLRenderer, mesh: Mesh, geometries: readonly BufferGeometry[]): void {
  const parent = mesh.parent;
  const at = parent ? parent.children.indexOf(mesh) : -1;
  const visible = mesh.visible, culled = mesh.frustumCulled, original = mesh.geometry;
  const previous = renderer.getRenderTarget();
  LOOSE.scene.add(mesh);
  try {
    mesh.visible = true;
    mesh.frustumCulled = false;
    renderer.setRenderTarget(LOOSE.target);
    for (const geometry of geometries) {
      mesh.geometry = geometry;
      renderer.render(LOOSE.scene, LOOSE.camera);
    }
  } finally {
    mesh.geometry = original;
    mesh.visible = visible;
    mesh.frustumCulled = culled;
    LOOSE.scene.remove(mesh);
    // Back where it was among its group's children: the order meshes of one render order are drawn in.
    if (parent) { parent.add(mesh); parent.children.splice(parent.children.length - 1, 1); parent.children.splice(at, 0, mesh); }
    renderer.setRenderTarget(previous);
  }
}

function warmOne(renderer: WebGLRenderer, camera: Camera, scene: Scene, target: WebGLRenderTarget | null): void {
  const job = toWarm.shift();
  if (!job) return;
  const { mesh, geometries, done } = job;
  let lights = lightsOf.get(scene);
  if (!lights) {
    lights = [];
    scene.traverse((o) => { if ((o as Light).isLight) lights!.push(o as Light); });
    lightsOf.set(scene, lights);
  }
  const mask = camera.layers.mask;
  const visible = mesh.visible;
  const original = mesh.geometry;
  const previous = renderer.getRenderTarget();
  const autoClear = renderer.autoClear;
  // The world's matrices were brought up to date by the frame just drawn.
  const autoUpdate = scene.matrixWorldAutoUpdate;
  try {
    scene.matrixWorldAutoUpdate = false;
    for (const light of lights) light.layers.enable(WARM_LAYER);
    mesh.layers.enable(WARM_LAYER);
    mesh.visible = true;
    camera.layers.set(WARM_LAYER);
    renderer.setRenderTarget(target);
    // The frame in the target has been shown already; nothing is cleared.
    renderer.autoClear = false;
    for (const geometry of geometries) {
      mesh.geometry = geometry;
      renderer.render(scene, camera);
    }
  } finally {
    mesh.geometry = original;
    mesh.visible = visible;
    mesh.layers.disable(WARM_LAYER);
    for (const light of lights) light.layers.disable(WARM_LAYER);
    camera.layers.mask = mask;
    renderer.autoClear = autoClear;
    scene.matrixWorldAutoUpdate = autoUpdate;
    renderer.setRenderTarget(previous);
    done();
  }
}

/** The geometry three's FullScreenQuad draws (`postprocessing/Pass.js`): one triangle with a position and a uv. */
export function fullScreenTriangle(): BufferGeometry {
  const quad = new BufferGeometry();
  quad.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  quad.setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  return quad;
}
