import { BackSide, BufferGeometry, DoubleSide, Float32BufferAttribute, FrontSide, MeshDepthMaterial, RGBADepthPacking, WebGLRenderTarget, type Camera, type Light, type Material, type Mesh, type Object3D, type Scene, type Side, type Texture, type WebGLRenderer } from 'three';

/**
 * Textures waiting to be sent to the GPU ahead of their first use.
 *
 * three.js uploads a texture the first time something using it is drawn, in
 * that frame: each new kind of person brought its skin, its garments and its
 * hair, and the frame it walked into view stalled on their upload. Loaders
 * queue what they make here; the renderer sends one a frame
 * (`renderer.initTexture`) before anybody needs it.
 */
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

/**
 * Objects whose shaders must be compiled before they are first drawn: a
 * loader awaits `compileAhead` before handing an object to the frame, and
 * the renderer compiles each in parallel (`compileAsync`). Drawn first, a new
 * shader stopped that frame for as long as the driver took to build it.
 */
const toCompile: { object: Object3D; shadow: boolean; done: () => void }[] = [];
/**
 * What a shadow program is built for: a render target as a shadow map is (no
 * colour space, no tone mapping). Built for the scene's target, a depth
 * material's program came out different and was built again, in the frame,
 * by the shadow pass.
 */
let shadowTarget: WebGLRenderTarget | null = null;
/** Whether a renderer is answering (none in tests: nothing is waited for there). */
let compiler = false;

/**
 * A stand-in drawn with the depth material the shadow pass will draw `mesh`
 * with, set as three's `WebGLShadowMap.getDepthMaterial` sets it (r186: the
 * object's own `customDepthMaterial` or the shared RGBA-packed depth
 * material; the side flipped for a PCF map, the colour map and alpha test
 * copied), for `compileAhead(..., true)`. three's `compile` builds the
 * scene's programs only, never a shadow's: the trees' wind-swayed depth
 * program was built in the first shadow pass, 3 s of the opening frozen on
 * the driver (profile of 2026-10-10). Null when the mesh casts no shadow.
 */
const SHADOW_SIDE: Record<Side, Side> = { [FrontSide]: BackSide, [BackSide]: FrontSide, [DoubleSide]: DoubleSide };
const plainDepth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
export function shadowStandIn(mesh: Mesh): Mesh | null {
  if (!mesh.castShadow || Array.isArray(mesh.material)) return null;
  const material = mesh.material as Material & { map?: Texture | null; shadowSide?: Side | null };
  const depth = ((mesh as Mesh & { customDepthMaterial?: Material }).customDepthMaterial ?? plainDepth) as Material & { map?: Texture | null };
  depth.side = material.shadowSide ?? SHADOW_SIDE[material.side];
  depth.alphaTest = material.alphaToCoverage ? 0.5 : material.alphaTest;
  depth.map = material.map ?? null;
  const copy = mesh.clone(false);
  copy.material = depth;
  copy.visible = true;
  return copy;
}

/** `shadow`: the object's material is a shadow's depth material, compiled for a shadow map. */
export function compileAhead(object: Object3D, shadow = false): Promise<void> {
  if (!compiler) return Promise.resolve();
  return new Promise((done) => toCompile.push({ object, shadow, done }));
}

/** Starts compiling what is waiting; each promise settles when its shaders are ready. */
export function drainCompiles(renderer: WebGLRenderer, camera: Camera, scene: Scene, target: WebGLRenderTarget | null): void {
  compiler = true;
  if (!toCompile.length) return;
  // For the target the scene is really drawn into: its colour space and tone
  // mapping are part of every program. Compiled for the screen, the wrong
  // programs were built and the right one still stalled the first frame.
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  while (toCompile.length) {
    const { object, shadow, done } = toCompile.shift()!;
    if (shadow) renderer.setRenderTarget(shadowTarget ??= new WebGLRenderTarget(1, 1));
    renderer.compileAsync(object, camera, scene).then(done, done);
    if (shadow) renderer.setRenderTarget(target);
  }
  renderer.setRenderTarget(previous);
}

/**
 * Meshes whose geometry must be on the GPU before they are first drawn.
 *
 * three.js sends a geometry's buffers (`WebGLObjects.update`) and builds its
 * morph target texture (`WebGLMorphtargets.update`) the first time the mesh
 * is drawn, in that frame; `compile` builds programs only. A new kind of
 * person walking into view stopped that frame on its body's upload. As the
 * three.js community does it ("render all the different meshes once", one a
 * frame to spread the cost: discourse.threejs.org/t/64940, /t/15549), each
 * waiting mesh is drawn once after the frame, alone - on a layer of its own,
 * into the target the scene is drawn into, under the scene's own lights, so
 * that the program used is the one already built for it - with no instance:
 * the buffers go up, nothing is drawn.
 */
const WARM_LAYER = 31;
const toWarm: { mesh: Mesh; geometries: readonly BufferGeometry[]; done: () => void; loose?: boolean }[] = [];
let warmer = false;
const lightsOf = new WeakMap<Scene, Light[]>();
export function warmAhead(mesh: Mesh, geometries: readonly BufferGeometry[]): Promise<void> {
  if (!warmer) return Promise.resolve();
  return new Promise((done) => toWarm.push({ mesh, geometries, done }));
}
/**
 * Meshes not in the scene yet (a batch of buildings put together to replace
 * the one drawn), each sent to the GPU one a frame before it is swapped in:
 * drawn first in the frame of the swap, a bomb's cells of buildings uploaded
 * 1.8-2.5 s of buffers in one frame (2026-10-09).
 */
export function warmLooseAhead(meshes: readonly Mesh[]): Promise<void> | null {
  // Nothing to wait for where no frame warms (tests, before the first frame).
  if (!warmer || meshes.length === 0) return null;
  return Promise.all(meshes.map((mesh) => new Promise<void>((done) => toWarm.push({ mesh, geometries: [mesh.geometry], done, loose: true })))).then(() => {});
}
/** Sends one waiting mesh's geometry to the GPU, after the frame (`renderer.ts`). */
export function drainWarm(renderer: WebGLRenderer, camera: Camera, scene: Scene, target: WebGLRenderTarget | null): void {
  warmer = true;
  // Loose meshes (a batch of buildings) several a frame within a few
  // milliseconds; one at least, so the queue always moves.
  const until = performance.now() + WARM_SLICE_MS;
  do warmOne(renderer, camera, scene, target);
  while (toWarm.length > 0 && toWarm[0]!.loose && performance.now() < until);
}
/** Milliseconds a frame for loose meshes (`drainWarm`). */
const WARM_SLICE_MS = 6;
function warmOne(renderer: WebGLRenderer, camera: Camera, scene: Scene, target: WebGLRenderTarget | null): void {
  const job = toWarm.shift();
  if (!job) return;
  const { mesh, geometries, done, loose } = job;
  // A loose mesh is put in the scene for the moment, where it stands, never culled.
  const parent = mesh.parent;
  const culled = mesh.frustumCulled;
  if (loose && !parent) { scene.add(mesh); mesh.updateMatrixWorld(true); mesh.frustumCulled = false; }
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
    if (loose && !parent) { scene.remove(mesh); mesh.frustumCulled = culled; }
    mesh.layers.disable(WARM_LAYER);
    for (const light of lights) light.layers.disable(WARM_LAYER);
    camera.layers.mask = mask;
    renderer.autoClear = autoClear;
    scene.matrixWorldAutoUpdate = autoUpdate;
    renderer.setRenderTarget(previous);
    done();
  }
}

/**
 * The geometry three's FullScreenQuad draws (`postprocessing/Pass.js`): one
 * triangle with a position and a uv. A pass's program compiled ahead must be
 * compiled with it: the attributes are part of the program's key (three's
 * `vertexNormals`), and compiled on a plane, with normals, it was another
 * program, and the real one was still built in the frame it was first drawn.
 */
export function fullScreenTriangle(): BufferGeometry {
  const quad = new BufferGeometry();
  quad.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  quad.setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  return quad;
}
