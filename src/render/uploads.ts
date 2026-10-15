import { BackSide, BufferGeometry, DoubleSide, Float32BufferAttribute, FrontSide, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial, MeshDepthMaterial, Object3D, OrthographicCamera, Scene as ThreeScene, WebGLRenderTarget, type Camera, type Light, type Material, type Mesh, type Scene, type Side, type Texture, type WebGLRenderer } from 'three';

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
 * object's own `customDepthMaterial` or its shared depth material, which is
 * `new MeshDepthMaterial()` - BASIC packing, `WebGLShadowMap.js` 44 - the
 * side flipped for a PCF map, the colour and alpha maps and alpha test
 * copied), for `compileAhead(..., true)`. DO NOT give the stand-in RGBA
 * packing: the packing is part of the program's key (`WebGLPrograms`), so a
 * program no shadow pass uses was built and the real one was linked in the
 * first shadow pass that drew the mesh. three's `compile` builds the
 * scene's programs only, never a shadow's: the trees' wind-swayed depth
 * program was built in the first shadow pass, 3 s of the opening frozen on
 * the driver (profile of 2026-10-10). Null when the mesh casts no shadow.
 */
const SHADOW_SIDE: Record<Side, Side> = { [FrontSide]: BackSide, [BackSide]: FrontSide, [DoubleSide]: DoubleSide };
const plainDepth = new MeshDepthMaterial();
/** What a stand-in's plain depth material is set to (`userData`), at the moment it is compiled (`drainCompiles`). */
interface DepthVariant { readonly side: Side; readonly alphaTest: number; readonly map: Texture | null; readonly alphaMap: Texture | null }
const DEPTH_VARIANT = 'roadcraftDepthVariant';
type DepthMaterial = Material & { map?: Texture | null; alphaMap?: Texture | null };
const setDepth = (depth: DepthMaterial, v: DepthVariant): void => {
  depth.side = v.side;
  depth.alphaTest = v.alphaTest;
  depth.map = v.map;
  depth.alphaMap = v.alphaMap;
};
export function shadowStandIn(mesh: Mesh): Mesh | null {
  if (!mesh.castShadow || Array.isArray(mesh.material)) return null;
  const material = mesh.material as Material & { map?: Texture | null; alphaMap?: Texture | null; shadowSide?: Side | null };
  const custom = (mesh as Mesh & { customDepthMaterial?: Material }).customDepthMaterial as DepthMaterial | undefined;
  const variant: DepthVariant = { side: material.shadowSide ?? SHADOW_SIDE[material.side], alphaTest: material.alphaToCoverage ? 0.5 : material.alphaTest,
    map: material.map ?? null, alphaMap: material.alphaMap ?? null };
  setDepth(custom ?? plainDepth, variant);
  const copy = compileCopy(mesh) as Mesh;
  copy.material = custom ?? plainDepth;
  // The plain depth material is shared by every stand-in, and they are compiled later, together: each
  // set to its own variant as it is compiled (`drainCompiles`). DO NOT compile them with the material as
  // the last one left it: a sign's plate (a map, cut by its alpha) and a bench (neither) in one batch
  // built only the plate's shadow program, and the bench's was linked in the first shadow pass drawing it.
  if (!custom) copy.userData[DEPTH_VARIANT] = variant;
  copy.visible = true;
  return copy;
}

/**
 * A copy of `object` to build its programs with: the same geometry, material
 * and variant (instanced, with instance colours or not), where it stands.
 * An instanced mesh's copy has ONE instance: NOT `clone`, which copies every
 * instance's matrix and colour (`InstancedMesh.copy`) to compile a shader -
 * thousands of a cell's parts copied for nothing, and nothing to copy at all
 * once their arrays are let go on the GPU (`mesh/gpuOnly.ts`).
 */
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
    // Each stand-in on the plain depth material with its own variant (`shadowStandIn`), then the whole:
    // three builds a material's program from its state when compiled, and keeps every program it built for it.
    const units: { readonly object: Object3D; readonly variant?: DepthVariant }[] = [];
    object.traverse((o) => {
      const variant = o.userData[DEPTH_VARIANT] as DepthVariant | undefined;
      if (variant) units.push({ object: o, variant });
    });
    units.push({ object });
    const compiled: Promise<unknown>[] = [];
    for (const unit of units) {
      if (unit.variant) setDepth(plainDepth, unit.variant);
      compiled.push(renderer.compileAsync(unit.object, camera, scene));
    }
    Promise.all(compiled).then(() => done(), () => done());
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
/**
 * Meshes let go before their turn in the queue: taken out, their promises
 * settled. DO NOT dispose a mesh still waiting here without this: `warmOne`
 * drew it anyway and its geometry went back to the GPU with no owner left to
 * free it (`buildings/cellRequests.ts`, a cell dropped before it landed).
 */
export function cancelWarm(meshes: Iterable<Mesh>): void {
  const gone = new Set(meshes);
  for (let i = toWarm.length - 1; i >= 0; i--) {
    const job = toWarm[i]!;
    if (!gone.has(job.mesh)) continue;
    toWarm.splice(i, 1);
    job.done();
  }
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
/** Whether meshes still wait to go to the GPU: the renderer asks for another frame meanwhile. */
export function warmPending(): boolean {
  return toWarm.length > 0;
}

/**
 * A loose mesh's buffers sent up in a scene of its own (`warmLoose`): three uploads every attribute
 * of a drawn geometry, whatever its material (`WebGLObjects.update`), so one plain material and a
 * 1x1 target do; its programs are built apart (`compileAhead`). Matrices are not touched.
 */
const LOOSE = {
  scene: Object.assign(new ThreeScene(), { matrixWorldAutoUpdate: false }),
  camera: new OrthographicCamera(),
  material: new MeshBasicMaterial(),
  target: new WebGLRenderTarget(1, 1),
};
LOOSE.scene.overrideMaterial = LOOSE.material;

/**
 * Sends one loose mesh's geometry to the GPU, alone. DO NOT draw the whole scene for it (on a layer
 * of its own): three walks every object of the scene for each such draw, a few milliseconds each in
 * a city, a few blocks a frame - the road blocks of a generated city queued for minutes, and every
 * one kept its arrays on the CPU meanwhile (`mesh/gpuOnly.ts`; 476 MB at 2 560 m, 2026-10-15).
 */
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
  const { mesh, geometries, done, loose } = job;
  if (loose) {
    try { warmLoose(renderer, mesh, geometries); } finally { done(); }
    return;
  }
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
