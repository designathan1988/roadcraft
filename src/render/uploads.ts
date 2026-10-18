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

/** Sends every queued texture to the GPU now (DO NOT go back to one a frame: a texture queued while it is already drawn waited behind the others, and three sent it in the draw that needed it). */
export function drainUploads(renderer: WebGLRenderer): void {
  while (queue.length) {
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
const toCompile: { object: Object3D; shadow: boolean; done: () => void; pass?: OwnPass; lights?: readonly Object3D[] }[] = [];
/** What a shadow program is built for: a render target as a shadow map is (no colour space, no tone mapping). */
let shadowTarget: WebGLRenderTarget | null = null;
/** Whether a renderer is answering (none in tests: nothing is waited for there). */
let compiler = false;
/** What came into the scene before the renderer first answered: taken through the door at its first drain (`drainCompiles`). DO NOT let them in unheld: a program first used in a frame waits there for its link. */
const early: Object3D[] = [];
/** The scene's lights as the last drain gathered them (`litScene`), by kind and shadow: part of every lit program's key (three's `WebGLPrograms` getParameters counts them), so a variant built under other lights is not taken for built. */
let lightsKey = '';

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
  // DO NOT let three copy the user data (r186 `Object3D.copy`: JSON.parse(JSON.stringify(userData))): a part's `posedFrom` is a geometry, serialized whole, and one whose arrays went to the GPU (`gpuOnly`) threw, leaving the job that asked unsettled (conferencia 31: no cell's detail, no new road).
  const kept = object.userData;
  object.userData = {};
  try {
    const instanced = object as InstancedMesh;
    if (!instanced.isInstancedMesh) return object.clone(false);
    const copy = new InstancedMesh(instanced.geometry, instanced.material, 1);
    Object3D.prototype.copy.call(copy, instanced, false);
    if (instanced.instanceColor) copy.instanceColor = new InstancedBufferAttribute(new Float32Array(3).fill(1), 3);
    copy.morphTexture = instanced.morphTexture;
    return copy;
  } finally {
    object.userData = kept;
  }
}

/** Every compile asked for and not settled, and since when (`performance.now`). DO NOT settle one after a count of frames: the door opened on a program still linking, its first draw waited for the link in the frame (three's onFirstUse, getProgramInfoLog: 716 ms of the conferencia 110 move). It settles when three says its programs are ready (linked, or failed: the error said by onShaderError at the first draw, as ever), when a material of it is disposed (its programs never come, nothing of it is drawn), or past `COMPILE_GIVE_UP_MS`, said. */
const inFlight = new Set<{ readonly since: number; readonly what: string; started: number; settle: () => void }>();
// TEMPORARY (DEV only, to be taken out): every compile at the door, asked, started, settled and how many were in flight (`window.__compileLog`).
const compileLog: { what: string; asked: number; started: number; settled: number; waitedMs: number; builtMs: number; inFlight: number; programs: number; how: string }[] = [];
const programSamples: { at: number; programs: number; inFlight: number; queued: number }[] = [];
if (import.meta.env.DEV && typeof window !== 'undefined') Object.assign(window, { __compileLog: compileLog, __programSamples: programSamples });
let lastProgramCount = 0;
// TEMPORARY (DEV only, to be taken out): the programs three built, by name and the end of their key (the material's customProgramCacheKey), with what differs between those of a group (`window.__programsTable()`).
let devRenderer: WebGLRenderer | null = null;
let devScene: Scene | null = null;
type BuiltProgram = { readonly name: string; readonly cacheKey: string; readonly usedTimes: number };
const programsTable = (): unknown => {
  const programs = ((devRenderer as unknown as { info?: { programs?: BuiltProgram[] | null } } | null)?.info?.programs ?? []).slice();
  // Who draws with each program: the meshes of the scene whose material holds it (none: a pass of the post chain, a stand-in, a scene of its own).
  const owners = new Map<BuiltProgram, Set<string>>();
  const properties = (devRenderer as unknown as { properties?: { get(material: Material): { currentProgram?: BuiltProgram; programs?: Map<string, BuiltProgram> } } } | null)?.properties;
  devScene?.traverse((o) => {
    const m = (o as Mesh).material;
    if (!m || !properties) return;
    for (const material of Array.isArray(m) ? m : [m]) {
      const held = properties.get(material).programs;
      for (const program of held?.values() ?? []) {
        let set = owners.get(program);
        if (!set) owners.set(program, set = new Set());
        if (set.size < 4) set.add(`${o.name || o.type}/${material.name || material.type}`);
      }
    }
  });
  const groups = new Map<string, BuiltProgram[]>();
  for (const p of programs) {
    const tokens = p.cacheKey.split(',');
    const key = `${p.name} | ${tokens[tokens.length - 1]!.slice(0, 90)}`;
    let list = groups.get(key);
    if (!list) groups.set(key, list = []);
    list.push(p);
  }
  const rows = [...groups].map(([key, list]) => {
    // The places of the key that differ between the group's programs, and their values: what makes the variants.
    const split = list.map((p) => p.cacheKey.split(','));
    const length = Math.max(...split.map((t) => t.length));
    const varies: Record<string, string[]> = {};
    for (let i = 0; i < length; i++) {
      const values = new Set(split.map((t) => t[i] ?? ''));
      if (values.size > 1) varies[`#${i}`] = [...values].map((v) => v.slice(0, 40)).slice(0, 6);
    }
    const drawnBy = new Set<string>();
    for (const p of list) for (const owner of owners.get(p) ?? ['(no mesh of the scene: post chain, stand-in or own scene)']) if (drawnBy.size < 12) drawnBy.add(owner);
    return { key, programs: list.length, used: list.reduce((n, p) => n + p.usedTimes, 0), varies: Object.fromEntries(Object.entries(varies).slice(0, 12)), drawnBy: [...drawnBy],
      ...(list.length > 8 ? { byOwner: list.map((p) => [...(owners.get(p) ?? ['(none)'])][0]).reduce<Record<string, number>>((n, o) => { n[o!] = (n[o!] ?? 0) + 1; return n; }, {}) } : {}) };
  }).sort((a, b) => b.programs - a.programs);
  const extensions = (devRenderer as unknown as { extensions?: { has?: (name: string) => boolean } } | null)?.extensions;
  return { total: programs.length, groups: rows.length, parallelCompile: extensions?.has?.('KHR_parallel_shader_compile') ?? null, rows };
};
if (import.meta.env.DEV && typeof window !== 'undefined') Object.assign(window, { __programsTable: programsTable });
const entryOf = new WeakMap<() => void, { started: number }>();
/** A driver that never says a program is built: given up on and said, never a mesh held for ever (a slow driver shows in the opening's time, `programsReady`). */
const COMPILE_GIVE_UP_MS = 10_000;
/** `done` once, however many times it is called, and taken off `inFlight`; settled too when a material of `object` is disposed. */
function once(done: () => void, object: Object3D): () => void {
  const materials = new Set<Material>();
  object.traverse((o) => {
    const m = (o as Mesh).material;
    if (m) for (const x of Array.isArray(m) ? m : [m]) materials.add(x);
  });
  // What it is, said if it is given up on: the object and its materials, by name or type.
  const what = `${object.name || object.type} [${[...materials].map((m) => m.name || m.type).slice(0, 4).join(', ')}]`;
  const entry = { since: performance.now(), what, started: -1, settle: () => {} };
  entry.settle = () => {
    if (!inFlight.delete(entry)) return;
    if (import.meta.env.DEV) {
      const now = performance.now();
      compileLog.push({ what, asked: Math.round(entry.since), started: Math.round(entry.started), settled: Math.round(now), waitedMs: Math.round((entry.started < 0 ? now : entry.started) - entry.since),
        builtMs: entry.started < 0 ? 0 : Math.round(now - entry.started), inFlight: inFlight.size + 1, programs: lastProgramCount, how: now - entry.since > COMPILE_GIVE_UP_MS ? 'given up' : 'built' });
      if (compileLog.length > 5000) compileLog.splice(0, 1000);
    }
    for (const m of materials) m.removeEventListener('dispose', entry.settle);
    done();
  };
  for (const m of materials) m.addEventListener('dispose', entry.settle);
  inFlight.add(entry);
  if (import.meta.env.DEV) entryOf.set(entry.settle, entry);
  return entry.settle;
}

/** What waits for the door to be quiet (`compilesQuiet`): told at the first drain with nothing asked and nothing in flight. */
const quietWaiters: (() => void)[] = [];
/** Settles at the first drain with no compile asked nor in flight: what the view does not need yet (a light's variants, `shaderCatalogue.ts`) asked after what it does, never alongside it (the driver builds a few programs at once, Chrome's limit on its compile threads: public_webgl 2019, KHR_parallel_shader_compile). At once where no renderer answers. */
export function compilesQuiet(): Promise<void> {
  if (!compiler) return Promise.resolve();
  return new Promise((done) => quietWaiters.push(done));
}

/** `shadow`: the object's material is a shadow's depth material, compiled for a shadow map. */
export function compileAhead(object: Object3D, shadow = false): Promise<void> {
  if (!compiler) return Promise.resolve();
  return new Promise((done) => toCompile.push({ object, shadow, done: once(done, object) }));
}

/** `object`'s programs as they are drawn under another set of the scene's lights (`lights`, every one counted lit or not): the variant a light switched on or off asks for, built before it is. */
export function compileAheadWith(object: Object3D, lights: readonly Object3D[]): Promise<void> {
  if (!compiler) return Promise.resolve();
  return new Promise((done) => toCompile.push({ object, shadow: false, done: once(done, object), lights }));
}

/** DO NOT draw a pass of its own (`people/crowdAnimation.ts` palette pass) before its program is built: compiled on its first draw, in the frame (2026-10-16) */
export function compilePassAhead(scene: Scene, camera: Camera, target: WebGLRenderTarget): Promise<void> {
  if (!compiler) return Promise.resolve();
  return new Promise((done) => toCompile.push({ object: scene, shadow: false, done: once(done, scene), pass: { camera, target } }));
}

/** Starts compiling what is waiting; each promise settles when its shaders are ready. */
export function drainCompiles(renderer: WebGLRenderer, camera: Camera, scene: Scene, target: WebGLRenderTarget | null): void {
  const first = !compiler;
  compiler = true;
  // The lights the last compile gathered, as they stand now (DO NOT walk the scene for them every frame: walked when something is compiled, `litScene`).
  if (!litScenes.has(scene)) litScene(scene);
  const known = litScenes.get(scene)?.lights;
  if (known) lightsKey = known.filter((l) => l.visible).map((l) => `${l.type}${(l as Light).castShadow ? '+' : ''}`).sort().join(',');
  if (first) for (const root of early.splice(0)) if (root.parent) gateUntilBuilt(root);
  // A compile the driver never answers: given up on, said; never a mesh held for ever.
  const now = performance.now();
  for (const entry of [...inFlight]) {
    if (now - entry.since <= COMPILE_GIVE_UP_MS) continue;
    console.warn('[uploads] a program was not built in', COMPILE_GIVE_UP_MS, 'ms: drawn as it is:', entry.what, `(${inFlight.size} compiles in flight)`);
    entry.settle();
  }
  if (import.meta.env.DEV) {
    devRenderer = renderer;
    devScene = scene;
    lastProgramCount = (renderer as { info?: { programs?: unknown[] | null } }).info?.programs?.length ?? 0;
    const last = programSamples[programSamples.length - 1];
    if (!last || now - last.at >= 250) { programSamples.push({ at: Math.round(now), programs: lastProgramCount, inFlight: inFlight.size, queued: toCompile.length }); if (programSamples.length > 5000) programSamples.splice(0, 1000); }
  }
  if (!toCompile.length) {
    if (inFlight.size === 0) for (const done of quietWaiters.splice(0)) done();
    return;
  }
  // Without the parallel compile, three's compileAsync polls each program with a timer: built here at once instead, off the draw, and settled.
  const extensions = (renderer as { extensions?: { has?: (name: string) => boolean } }).extensions;
  const parallel = extensions?.has?.('KHR_parallel_shader_compile') ?? true;
  const build = (object: Object3D, cameraFor: Camera, targetScene: Scene): Promise<unknown> => {
    if (parallel) return renderer.compileAsync(object, cameraFor, targetScene);
    renderer.compile(object, cameraFor, targetScene);
    return Promise.resolve();
  };
  // For the target the scene is really drawn into: its colour space and tone mapping are part of every program.
  const previous = renderer.getRenderTarget();
  // DO NOT let three walk the whole scene for its lights once per object compiled (`compile` traverses its target scene): gathered once for this drain.
  const lit = litScene(scene);
  try {
    while (toCompile.length) {
      const { object, shadow, done, pass, lights } = toCompile.shift()!;
      if (import.meta.env.DEV) { const asked = entryOf.get(done); if (asked && asked.started < 0) asked.started = performance.now(); }
      if (pass) {
        // Its own scene's lights (none) and its own target, as it is drawn.
        renderer.setRenderTarget(pass.target);
        try {
          build(object, pass.camera, object as Scene).then(() => done(), () => done());
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
          compiled.push(build(unit.object, camera, lightsFor(unit.object, scene, lights ?? litScenes.get(scene)!.lights, lights ? null : lit)));
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

/** The scene as three's `compile` reads its target (its lights, fog and environment), with its lights gathered once (`litScene`). */
const litScenes = new WeakMap<Scene, { readonly scene: Scene; readonly lights: Object3D[] }>();
/** `scene` with its visible lights gathered now: three's compile walks the stand-in's lights only, and reads the rest (fog, environment) from the scene. */
function litScene(scene: Scene): Scene {
  let lit = litScenes.get(scene);
  if (!lit) {
    const lights: Object3D[] = [];
    const proxy = Object.create(scene, {
      traverseVisible: { value: (visit: (object: Object3D) => void) => { for (const light of lights) visit(light); } },
    }) as Scene;
    lit = { scene: proxy, lights };
    litScenes.set(scene, lit);
  }
  const lights = lit.lights;
  lights.length = 0;
  scene.traverseVisible((o) => { if ((o as Light).isLight) lights.push(o); });
  return lit.scene;
}

/** `scene` as three's compile reads it with `lights` for its lights: the program variant those lights make. */
/** The scene to compile `object` under: DO NOT give it a light twice. three's compile takes the lights of the target scene and then those of the object when the two differ (r186 `WebGLRenderer.compile`): the scene compiled under its own lights' set counted every light twice (8 directional lights, 6 of their shadows, 2 hemispheres), and every material it held was built for a variant never drawn (the ~300 programs, prova motor-programas, 2026-10-18). The scene itself under itself; an object holding lights under the others only; any other under the set (`plain` when given). */
function lightsFor(object: Object3D, scene: Scene, lights: readonly Object3D[], plain: Scene | null): Scene {
  if (object === scene) return scene;
  const inside = new Set<Object3D>();
  object.traverse((o) => { if ((o as Light).isLight) inside.add(o); });
  if (inside.size === 0) return plain ?? lightSet(scene, lights);
  return lightSet(scene, lights.filter((light) => !inside.has(light)));
}

function lightSet(scene: Scene, lights: readonly Object3D[]): Scene {
  return Object.create(scene, {
    traverseVisible: { value: (visit: (object: Object3D) => void) => { for (const light of lights) visit(light); } },
  }) as Scene;
}

/** Meshes whose geometry must be on the GPU before they are first drawn. three.js sends a geometry's buffers */
const toWarm: { mesh: Mesh; geometries: readonly BufferGeometry[]; done: () => void }[] = [];
/** DO NOT queue loose meshes behind the scene's: one FIFO stopped at a scene job at its head, and the masses behind it kept their CPU arrays (110 MB, 2026-10-16). */
interface LooseJob { readonly mesh: Mesh; readonly done: () => void; readonly priority: () => number; rank: number; readonly bytes: number }
/** The bytes of the loose meshes waiting to go up: their arrays live on the page until they are on the GPU (`gpuOnly`). */
let queuedBytes = 0;
/** Past this the producers ask no new mesh with its arrays (`warmFull`): the queue drains `UPLOAD_BYTES` a frame, and its arrays live on the CPU until sent (the page's process reached 7.3 GB, ~3.7 GB native, at a re-bake: mu1, conf77). */
export const WARM_CEILING = 64 * 1024 * 1024;
/** The bytes of the loose meshes waiting to go to the GPU (`toWarmLoose`), kept as they are queued and sent: what the producers hold back by. */
export function warmQueuedBytes(): number {
  return queuedBytes;
}
/** Whether the queue holds more than it may: the producers (`farTree.ts`, `cellRequests.ts`, `massCells.ts`) ask no new mesh until it drains; never where no frame warms (tests). */
export function warmFull(): boolean {
  return warmer && queuedBytes > WARM_CEILING;
}
const toWarmLoose: LooseJob[] = [];
let warmer = false;
export function warmAhead(mesh: Mesh, geometries: readonly BufferGeometry[]): Promise<void> {
  if (!warmer) return Promise.resolve();
  return new Promise((done) => toWarm.push({ mesh, geometries, done }));
}
/** Meshes not in the scene yet (a batch of buildings put together to replace the one drawn); `priority`: the pixels of error their absence leaves on the screen, the largest sent first. Settles once their buffers are on the GPU and their programs, lit and in the shadow, are built (`programsReady`). */
export function warmLooseAhead(meshes: readonly Mesh[], priority: () => number = () => 0): Promise<void> | null {
  // Nothing to wait for where no frame warms (tests, before the first frame).
  if (!warmer || meshes.length === 0) return null;
  return Promise.all(meshes.map((mesh) => new Promise<void>((done) => {
    const bytes = meshBytes(mesh);
    queuedBytes += bytes;
    toWarmLoose.push({ mesh, done, priority, rank: 0, bytes });
  }))).then(() => {});
}
/** DO NOT dispose a mesh still waiting here without this */
export function cancelWarm(meshes: Iterable<Mesh>): void {
  const gone = new Set(meshes);
  for (const queue of [toWarm, toWarmLoose] as { mesh: Mesh; done: () => void; bytes?: number }[][]) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const job = queue[i]!;
      if (!gone.has(job.mesh)) continue;
      queue.splice(i, 1);
      queuedBytes -= job.bytes ?? 0;
      job.done();
    }
  }
}
/** The bytes a mesh's buffers take on the GPU: every attribute (an interleaved buffer once), the index, an instanced mesh's matrices and colours. */
export function meshBytes(mesh: Mesh, geometries: readonly BufferGeometry[] = [mesh.geometry]): number {
  const seen = new Set<unknown>();
  let bytes = 0;
  const add = (array: { readonly byteLength: number } | null | undefined, owner: unknown): void => {
    if (!array || seen.has(owner)) return;
    seen.add(owner);
    bytes += array.byteLength;
  };
  for (const g of geometries) {
    for (const a of Object.values(g.attributes)) {
      const interleaved = (a as { data?: { array: ArrayLike<number> & { byteLength: number } } }).data;
      if (interleaved) add(interleaved.array, interleaved);
      else add((a as { array: ArrayLike<number> & { byteLength: number } }).array, a);
    }
    if (g.index) add(g.index.array as ArrayLike<number> & { byteLength: number }, g.index);
  }
  const instanced = mesh as Mesh & { isInstancedMesh?: boolean; instanceMatrix?: { array: Float32Array }; instanceColor?: { array: Float32Array } | null };
  if (instanced.isInstancedMesh) {
    add(instanced.instanceMatrix?.array, instanced.instanceMatrix);
    add(instanced.instanceColor?.array, instanced.instanceColor);
  }
  return bytes;
}

/** Sends waiting meshes to the GPU after the frame (`renderer.ts`): the scene's first, then the loose ones by their error on the screen, up to `UPLOAD_BYTES` of buffers a frame (one at least, so the queue always moves). */
export function drainWarm(renderer: WebGLRenderer): void {
  warmer = true;
  let budget = UPLOAD_BYTES;
  // DO NOT measure the sending by the page's clock: `bufferData` returns once the browser has copied the arrays, the GPU process takes them in after, in the next frame; the bytes are what the GPU takes.
  while (toWarm.length > 0 && (budget === UPLOAD_BYTES || budget > 0)) {
    const one = toWarm.shift()!;
    budget -= meshBytes(one.mesh, one.geometries);
    try { warmLoose(renderer, one.mesh, one.geometries); } finally { one.done(); }
  }
  if (toWarmLoose.length === 0) return;
  // Ranked once a frame, the largest error last (popped first); the eye moved since they were queued.
  for (const job of toWarmLoose) job.rank = job.priority();
  toWarmLoose.sort((a, b) => a.rank - b.rank);
  while (toWarmLoose.length > 0 && (budget === UPLOAD_BYTES || budget > 0)) {
    const job = toWarmLoose.pop()!;
    budget -= job.bytes;
    queuedBytes -= job.bytes;
    try { warmLoose(renderer, job.mesh, [job.mesh.geometry]); } finally { void programsReady(job.mesh).then(job.done, job.done); }
  }
}

/** DO NOT let a mesh be drawn before its programs are built (a program first used in the frame's draw stalls it, three's onFirstUse): its own and its shadow's, compiled ahead at the next drain (`drainCompiles`, KHR_parallel_shader_compile); what waits for the mesh waits for them too. */
export function programsReady(mesh: Mesh): Promise<unknown> {
  // Nothing built ahead where no renderer answers (tests): nothing waited for.
  if (!compiler) return Promise.resolve();
  // Through the variants the door keeps (`programsOf`): a mesh warmed here goes in at once when it enters the scene.
  let waiting: Promise<unknown> | null;
  // DO NOT let a mesh that cannot be stood in for stop the queue (an exception here left its job unsettled): it goes as it is.
  try { waiting = programsOf(mesh); } catch (error) { console.error('[uploads] a mesh\'s programs could not be asked for', error); waiting = null; }
  if (!waiting) return Promise.resolve();
  pendingPrograms++;
  return waiting.finally(() => { pendingPrograms--; });
}
/** THE ONE DOOR INTO THE DRAWN SCENE: what comes in with a program not built yet waits on a layer no camera draws (the colour pass's nor the shadow's: three tests the main camera's layers in both) until its programs, lit and in the shadow, are built ahead; then it is drawn as it was. DO NOT gate by `visible`: the layers' level choices set it every frame. */
const GATE_LAYER = 30;
/** Each program variant asked for, by what of a mesh is in its key (its material and the mesh's own flags), and whether it is built: a mesh of a variant built goes in at once. */
const variants = new Map<string, { built: boolean; ready: Promise<unknown> }>();
/** What three's program key reads of a mesh lit (r186 `WebGLPrograms.getParameters`): its materials, how it is instanced, skinned, morphed, its attributes, whether it takes shadows. */
function litKey(mesh: Mesh): string {
  const m = mesh as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean; isBatchedMesh?: boolean; instanceColor?: unknown; morphTexture?: unknown };
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const g = mesh.geometry;
  return ['lit', lightsKey, materials.map((x) => `${x.uuid}:${x.version}`).join(','), !!m.isInstancedMesh, !!m.instanceColor, !!m.morphTexture, !!m.isSkinnedMesh, !!m.isBatchedMesh,
    mesh.receiveShadow, Object.keys(g.attributes).sort().join(','), Object.keys(g.morphAttributes).sort().join(',')].join('/');
}
/** A variant's programs asked for once, with `mesh` as its stand-in; the promise settles when they are built. */
function variantReady(key: string, build: () => Promise<unknown>): { built: boolean; ready: Promise<unknown> } {
  let known = variants.get(key);
  if (!known) {
    const made: { built: boolean; ready: Promise<unknown> } = { built: false, ready: Promise.resolve() };
    made.ready = build().finally(() => { made.built = true; });
    variants.set(key, made);
    known = made;
  }
  return known;
}
/** The programs a mesh is drawn with, lit and in the shadow (its variants, each asked for once): null when they are all built already. */
function programsOf(mesh: Mesh): Promise<unknown> | null {
  const waits: Promise<unknown>[] = [];
  const lit = variantReady(litKey(mesh), () => compileAhead(mesh));
  if (!lit.built) waits.push(lit.ready);
  if (mesh.castShadow) {
    // Its stand-in made only for a variant not asked for yet.
    const cast = variantReady(`cast/${casterKey(mesh)}`, () => { const shadow = shadowStandIn(mesh); return shadow ? compileAhead(shadow, true) : Promise.resolve(); });
    if (!cast.built) waits.push(cast.ready);
  }
  return waits.length ? Promise.all(waits) : null;
}
/** Each mesh held at the door, and the layers it had. */
const gated = new WeakMap<Object3D, number>();
/** What comes into the scene (`renderer.ts` childadded): every mesh, line and points under it whose programs are not built held off the drawn layers until they are (`programsOf`). Nothing is held where no renderer answers (tests, the opening before the first frame: the catalogue builds those). */
export function gateUntilBuilt(root: Object3D, opened?: () => void): void {
  if (!compiler) { early.push(root); return; }
  root.traverse((object) => {
    const mesh = object as Mesh & { isLine?: boolean; isPoints?: boolean };
    if (!(mesh.isMesh || mesh.isLine || mesh.isPoints) || gated.has(object) || !mesh.material) return;
    let waiting: Promise<unknown> | null;
    try { waiting = programsOf(mesh); } catch (error) { console.error('[uploads] a mesh\'s programs could not be asked for', error); waiting = null; }
    if (!waiting) return;
    gated.set(object, object.layers.mask);
    object.layers.set(GATE_LAYER);
    pendingPrograms++;
    const open = (): void => {
      pendingPrograms--;
      const mask = gated.get(object);
      gated.delete(object);
      if (mask !== undefined && object.layers.mask === 1 << GATE_LAYER) object.layers.mask = mask;
      opened?.();
    };
    // Built, failed (said at its first draw) or given up on (`COMPILE_GIVE_UP_MS`): the door opens.
    void waiting.then(open, open);
  });
}

/** Meshes whose programs are being built (`programsReady`): the renderer asks for frames meanwhile (`warmPending`). */
let pendingPrograms = 0;
/** Whether programs are built ahead here (a renderer answers; none in tests): a mesh waits for them only then. */
export function compilesAhead(): boolean {
  return compiler;
}
/** Buffers sent to the GPU a frame at most, bytes: 16 MiB took the page up to 42 ms in one frame of the conf27 move (bufferData at ~2.6 ms a MiB): 4 MiB, ~10 ms there. */
const UPLOAD_BYTES = 4 * 1024 * 1024;
/** Whether meshes still wait to go to the GPU: the renderer asks for another frame meanwhile. */
export function warmPending(): boolean {
  return toWarm.length > 0 || toWarmLoose.length > 0 || pendingPrograms > 0;
}

/** A loose mesh's buffers sent up in a scene of its own (`warmLoose`) */
const LOOSE = {
  scene: Object.assign(new ThreeScene(), { matrixWorldAutoUpdate: false }),
  // Every layer: a mesh held at the door (`gateUntilBuilt`) still has its buffers sent.
  camera: new OrthographicCamera(),
  material: new MeshBasicMaterial(),
  target: new WebGLRenderTarget(1, 1),
};
LOOSE.scene.overrideMaterial = LOOSE.material;
LOOSE.camera.layers.enableAll();

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

/** The geometry three's FullScreenQuad draws (`postprocessing/Pass.js`): one triangle with a position and a uv. */
export function fullScreenTriangle(): BufferGeometry {
  const quad = new BufferGeometry();
  quad.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  quad.setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  return quad;
}
