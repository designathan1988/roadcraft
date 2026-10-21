import {
  ACESFilmicToneMapping, BufferAttribute, BufferGeometry, Color, HalfFloatType, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, SphereGeometry, SRGBColorSpace, Scene, Vector2, WebGLRenderTarget,
  type Camera, type InterleavedBufferAttribute, type Light, type Material, type Object3D, type Texture, type WebGLRenderer,
} from 'three';
import { PMREMGenerator, RenderTarget, WebGPURenderer, type NodeMaterial } from 'three/webgpu';
import { createCompatibility, isDrawable } from './compatibility';
import { comparePictures, toDisplay, type PictureDifference } from './imageCompare';
import { createTwins } from './twins';

/** THE WEBGPU RENDERER, STAGE 1 (`MIGRACAO-WEBGPU.md`): three's `WebGPURenderer` drawing the game's scene as it stands. What it can draw
 *  as is (three's own materials) and what has a node twin (`twins.ts`) is drawn; what it cannot (`compatibility.ts`) is hidden for its
 *  frame alone and named once in the console. The WebGL renderer keeps everything else of the game (programs, uploads, shadows' stores) on a
 *  canvas of its own: this module only draws. Loaded on demand: the WebGL game never loads it. */

export interface CompareOptions {
  /** A pixel differs when its largest channel differs by more than this, in 8-bit steps. */
  threshold?: number;
  /** Frames drawn by each renderer to time it, GPU ms (median); 0 for none. */
  timingFrames?: number;
  /** Leave out of both pictures what only a simple twin draws (`twins.ts` kind): both renderers then draw the same things, the same way. */
  faithfulOnly?: boolean;
}

export interface CompareResult {
  width: number;
  height: number;
  /** The two pictures and their difference, PNG data URLs. */
  webgl: string;
  webgpu: string;
  diff: string;
  difference: Omit<PictureDifference, 'image'>;
  /** Each renderer's GPU time drawing that view, ms: the median of `timingFrames` draws (null when the browser does not time it). */
  gpuMs: { webgl: number | null; webgpu: number | null };
  /** What both left out of the view (no WebGPU equivalent yet), drawables by reason. */
  leftOut: Record<string, number>;
  /** What the WebGPU picture drew with a node twin instead of the game's material: drawables by name and kind. */
  twins: Record<string, number>;
  /** What both drew as it is (three's own materials): how many drawables, and some names. */
  asIs: { count: number; names: string[] };
}

export interface WebGpuView {
  readonly renderer: WebGPURenderer;
  /** Drawing buffer size, as the WebGL one (`screenSize.ts`). */
  setSize(width: number, height: number, ratio: number): void;
  /** The game's frame on this view's canvas. */
  render(scene: Scene, camera: Camera): void;
  /** The last frame's GPU time, ms (the timestamp queries come back a frame or two later), or null. */
  readonly gpuMs: number | null;
  /** Everything left out so far, drawables by reason. */
  leftOut(): Record<string, number>;
  /** The same view drawn by both renderers, the pictures compared (`scripts/look.mjs` "compare"). */
  compare(gl: WebGLRenderer, scene: Scene, camera: Camera, options?: CompareOptions): Promise<CompareResult>;
  dispose(): void;
}

/** A WebGPU renderer on `canvas` (an unseen one for a comparison alone), its device asked for and ready. */
export async function createWebGpuView(canvas: HTMLCanvasElement): Promise<WebGpuView> {
  const renderer = new WebGPURenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', reversedDepthBuffer: true, trackTimestamp: true });
  await renderer.init();
  // As the WebGL game's (`renderer.ts`): ACES, sRGB, exposure 1. No shadows yet (stage 3: the sun's cascades).
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = false;
  renderer.info.autoReset = true;
  const compatibility = createCompatibility();
  const twinOf = createTwins();

  /** Drawables left out, by reason, and a few names of each, for the console. */
  const reasons = new Map<string, { count: Set<Object3D>; names: Set<string> }>();
  /** When a reason came that the console was not told of yet (`performance.now()`), or null. */
  let untoldSince: number | null = null;
  const note = (reason: string, object: Object3D): void => {
    let entry = reasons.get(reason);
    if (!entry) {
      entry = { count: new Set(), names: new Set() };
      reasons.set(reason, entry);
      untoldSince = performance.now();
    }
    if (entry.count.has(object)) return;
    entry.count.add(object);
    if (entry.names.size < 6) entry.names.add(object.name || object.parent?.name || object.type);
  };
  const warnList = (): void => {
    const lines = [...reasons].sort((a, b) => b[1].count.size - a[1].count.size)
      .map(([reason, { count, names }]) => `  ${reason}: ${count.size} (${[...names].join(', ')})`);
    console.warn(`WebGPU renderer (stage 1): left out of the frame, no WebGPU equivalent yet (MIGRACAO-WEBGPU.md):\n${lines.join('\n')}`);
  };

  /** The sky's light for what reflects it (`environment.ts` makes WebGL's from its sky dome): this renderer's own, from the dome's twin. */
  let environment: Texture | null = null;
  const environmentFrom = (sky: NodeMaterial): void => {
    const pmrem = new PMREMGenerator(renderer);
    const probeScene = new Scene();
    const probe = new Mesh(new SphereGeometry(1, 32, 16), sky);
    probe.frustumCulled = false;
    probeScene.add(probe);
    environment = pmrem.fromScene(probeScene, 0, 0.1, 100).texture;
    probe.geometry.dispose();
    pmrem.dispose();
  };

  /** What one frame changed in the scene for this renderer, undone after it. */
  const hidden: Object3D[] = [];
  const swapped: { mesh: Mesh; material: Material | Material[] }[] = [];
  let keptEnvironment: Texture | null = null;
  let keptBackground: Scene['background'] = null;
  const stack: Object3D[] = [];
  /** What the last `prepare` found in the view: left out by reason, twins by name and kind, drawn as it is. */
  const tally = { leftOut: new Map<string, number>(), twins: new Map<string, number>(), asIs: 0, asIsNames: new Set<string>() };
  const count = <K>(map: Map<K, number>, key: K): void => { map.set(key, (map.get(key) ?? 0) + 1); };
  /** A grown instanced mesh's buffers (`agents.ts` growPart gives it new ones, and does not dispose it): three's WebGPU renderer keeps the
   *  nodes it built with the old ones (r186 `Instance.js`, its state kept per object) and draws past their end. Told the mesh is disposed,
   *  it builds them again with the new ones at its next draw. Only under WebGPU: the WebGL game is never told. */
  const instancesSeen = new WeakMap<Mesh, { matrix: unknown; colour: unknown }>();
  const rebuildIfGrown = (mesh: Mesh & { isInstancedMesh?: boolean; instanceMatrix?: unknown; instanceColor?: unknown }): void => {
    if (!mesh.isInstancedMesh) return;
    const seen = instancesSeen.get(mesh);
    if (!seen) { instancesSeen.set(mesh, { matrix: mesh.instanceMatrix, colour: mesh.instanceColor }); return; }
    if (seen.matrix === mesh.instanceMatrix && seen.colour === mesh.instanceColor) return;
    seen.matrix = mesh.instanceMatrix;
    seen.colour = mesh.instanceColor;
    mesh.dispatchEvent({ type: 'dispose' });
  };
  /** THE WEBGPU RENDERER'S OWN COPY OF A SMALL-INTEGER ATTRIBUTE: three r186 (`WebGPUAttributeUtils.createAttribute`) puts a Uint32Array in
   *  place of the array of every 8- or 16-bit integer attribute (and index) it sends. Shared with WebGL, that array then read UNSIGNED_INT,
   *  bound by WebGL with vertexAttribIPointer, and the ground's patches (`terrainLod.ts`, their corners in bytes, read as a float `position`)
   *  failed every draw: GL_INVALID_OPERATION "vertex shader input type does not match" (2026-10-21). This renderer draws a geometry of its
   *  own: the game's attributes as they are, those copied, kept up with the game's writes. */
  const ownGeometries = new WeakMap<BufferGeometry, { geometry: BufferGeometry; copies: Map<string, { from: BufferAttribute; to: BufferAttribute; version: number }> }>();
  // An array let go once sent (`cellInstances.ts` letGo: null) is never copied: there is nothing to copy, and three sends it no more.
  const smallInteger = (a: BufferAttribute | InterleavedBufferAttribute | null): a is BufferAttribute =>
    !!a && !(a as InterleavedBufferAttribute).isInterleavedBufferAttribute && !a.normalized && !!a.array
    && (a.array instanceof Uint8Array || a.array instanceof Uint16Array || a.array instanceof Int8Array || a.array instanceof Int16Array);
  const copyOf = (from: BufferAttribute): BufferAttribute => {
    const instanced = from as InstancedBufferAttribute;
    const to = instanced.isInstancedBufferAttribute
      ? new InstancedBufferAttribute(from.array.slice(), from.itemSize, false, instanced.meshPerAttribute)
      : new BufferAttribute(from.array.slice(), from.itemSize, false);
    to.setUsage(from.usage);
    return to;
  };
  const geometryFor = (source: BufferGeometry): BufferGeometry => {
    let own = ownGeometries.get(source);
    // Made again when the game gave the geometry other attributes (none of its own copied any more, or another copied).
    if (own) {
      for (const name in source.attributes) {
        const a = source.attributes[name]!, copy = own.copies.get(name);
        if (copy ? copy.from !== a || copy.to.array.length !== (a.array?.length ?? -1) : own.geometry.attributes[name] !== a) { own = undefined; break; }
      }
      const index = source.index, copy = own?.copies.get('index');
      if (own && (copy ? copy.from !== index || copy.to.array.length !== (index?.array?.length ?? -1) : own.geometry.index !== index)) own = undefined;
    }
    if (!own) {
      const names = Object.keys(source.attributes).filter((name) => smallInteger(source.attributes[name] as BufferAttribute));
      if (names.length === 0 && !smallInteger(source.index)) return source;
      const geometry = source instanceof InstancedBufferGeometry ? new InstancedBufferGeometry() : new BufferGeometry();
      const copies = new Map<string, { from: BufferAttribute; to: BufferAttribute; version: number }>();
      for (const name in source.attributes) {
        const a = source.attributes[name] as BufferAttribute;
        if (!names.includes(name)) { geometry.setAttribute(name, a); continue; }
        const to = copyOf(a);
        copies.set(name, { from: a, to, version: a.version });
        geometry.setAttribute(name, to);
      }
      if (source.index && smallInteger(source.index)) {
        const to = copyOf(source.index);
        copies.set('index', { from: source.index, to, version: source.index.version });
        geometry.setIndex(to);
      } else geometry.setIndex(source.index);
      ownGeometries.get(source)?.geometry.dispose();
      own = { geometry, copies };
      ownGeometries.set(source, own);
    }
    // The game's writes since: copied whole (three r186 converts what it sends anyway).
    for (const copy of own.copies.values()) {
      if (copy.version === copy.from.version || !copy.from.array) continue;
      copy.to.array.set(copy.from.array);
      copy.to.needsUpdate = true;
      copy.version = copy.from.version;
    }
    const g = own.geometry;
    g.drawRange.start = source.drawRange.start;
    g.drawRange.count = source.drawRange.count;
    g.groups = source.groups;
    g.boundingBox = source.boundingBox;
    g.boundingSphere = source.boundingSphere;
    if (source instanceof InstancedBufferGeometry) (g as InstancedBufferGeometry).instanceCount = source.instanceCount;
    return g;
  };
  const regeared: { mesh: Mesh; geometry: BufferGeometry }[] = [];
  /** This renderer's own geometry put in for its frame (`geometryFor`), the game's given back after it (`restoreTwins`). */
  const regear = (mesh: Mesh): void => {
    if (!mesh.geometry) return;
    const own = geometryFor(mesh.geometry);
    if (own !== mesh.geometry) { regeared.push({ mesh, geometry: mesh.geometry }); mesh.geometry = own; }
  };
  /** Walks what is visible: hides what cannot be drawn and (`twins`) puts the node twins in, or (`faithfulOnly`) hides what only a simple twin draws. */
  const prepare = (scene: Scene, twins: boolean, faithfulOnly = false): void => {
    // The sky's light from the dome's twin, made once: what reflects it lit by the same sky as the dome drawn.
    if (environment === null) {
      const sky = scene.getObjectByName('sky') as Mesh | undefined;
      const twin = sky && !Array.isArray(sky.material) ? twinOf(sky, sky.material) : null;
      if (twin) environmentFrom(twin.material);
    }
    tally.leftOut.clear(); tally.twins.clear(); tally.asIs = 0; tally.asIsNames.clear();
    stack.length = 0;
    stack.push(scene);
    while (stack.length) {
      const o = stack.pop()!;
      if (!o.visible) continue;
      for (const child of o.children) stack.push(child);
      if (!isDrawable(o)) continue;
      const mesh = o as Mesh;
      const material = mesh.material as Material | Material[];
      const twin = Array.isArray(material) ? null : twinOf(mesh, material);
      if (twin && faithfulOnly && twin.kind === 'simple') { o.visible = false; hidden.push(o); continue; }
      if (twin) {
        count(tally.twins, `${mesh.name} (${twin.kind})`);
        if (twins) { swapped.push({ mesh, material }); mesh.material = twin.material; regear(mesh); }
        continue;
      }
      const blocker = compatibility.drawable(o);
      if (blocker) { note(blocker, o); count(tally.leftOut, blocker); o.visible = false; hidden.push(o); continue; }
      tally.asIs++;
      if (tally.asIsNames.size < 12) tally.asIsNames.add(o.name || o.type);
      if (twins) { rebuildIfGrown(mesh); regear(mesh); }
    }
    if (twins) {
      keptEnvironment = scene.environment;
      keptBackground = scene.background;
      if (scene.environment) scene.environment = environment;
      // A colour stands as it is; a texture drawn by WebGL does not exist here.
      if (scene.background && !(scene.background as Color).isColor) scene.background = null;
    }
  };
  const restoreTwins = (scene: Scene): void => {
    for (const { mesh, geometry } of regeared) mesh.geometry = geometry;
    regeared.length = 0;
    if (swapped.length === 0 && keptEnvironment === null && keptBackground === null) return;
    for (const { mesh, material } of swapped) mesh.material = material;
    swapped.length = 0;
    scene.environment = keptEnvironment;
    scene.background = keptBackground;
    keptEnvironment = null;
    keptBackground = null;
  };
  const restoreHidden = (): void => {
    for (const o of hidden) o.visible = true;
    hidden.length = 0;
  };
  /** three's WebGPU renderer turns the camera to its clip space; the WebGL game's own frustums read the camera as WebGL's: given back. */
  const drawWith = (camera: Camera, draw: () => void): void => {
    const system = camera.coordinateSystem;
    try { draw(); } finally {
      if (camera.coordinateSystem !== system) {
        camera.coordinateSystem = system;
        (camera as Camera & { updateProjectionMatrix?: () => void }).updateProjectionMatrix?.();
      }
    }
  };

  let gpuMs: number | null = null;
  let timing = false;
  const view: WebGpuView = {
    renderer,
    get gpuMs() { return gpuMs; },
    setSize(width, height, ratio) {
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height, false);
    },
    render(scene, camera) {
      // Said once things settle, the whole list together: a city brings its layers in over seconds.
      if (untoldSince !== null && performance.now() - untoldSince > 3000) { untoldSince = null; warnList(); }
      prepare(scene, true);
      try { drawWith(camera, () => renderer.render(scene, camera)); } finally {
        restoreTwins(scene);
        restoreHidden();
      }
      if (!timing) {
        timing = true;
        void renderer.resolveTimestampsAsync('render').then((ms) => { if (typeof ms === 'number' && ms > 0) gpuMs = ms; }).finally(() => { timing = false; });
      }
    },
    leftOut: () => Object.fromEntries([...reasons].map(([reason, { count }]) => [reason, count.size])),
    async compare(gl, scene, camera, options = {}) {
      const threshold = options.threshold ?? 8;
      const timingFrames = options.timingFrames ?? 20;
      const faithfulOnly = options.faithfulOnly ?? false;
      const size = gl.getDrawingBufferSize(new Vector2());
      const width = size.x, height = size.y;
      // Both draw into a linear half-float target of the view's size, no multisampling, no tone mapping: the output transform is applied
      // to both the same way afterwards (`imageCompare.ts`). The WebGL picture without its post chain nor its shadows (the WebGPU one has
      // neither yet): the materials alone compared.
      const glTarget = new WebGLRenderTarget(width, height, { type: HalfFloatType, depthBuffer: true });
      const gpuTarget = new RenderTarget(width, height, { type: HalfFloatType, depthBuffer: true });
      const kept = gl.getRenderTarget();
      // DO NOT take `shadowMap.enabled = false` for no shadows: three's WebGL programs are not built again for it (their key follows the
      // lights that cast), and the WebGL picture came out with the sun's stored cascades - the shadows of the very buildings left out of it.
      // Its lights cast nothing while it draws: its programs without shadows, built for the comparison (a moment's compile, once each way).
      const casters: Light[] = [];
      scene.traverse((o) => { const light = o as Light; if (light.isLight && light.castShadow) casters.push(light); });
      const glHalf = new Uint16Array(width * height * 4);
      const glDraw = (): void => {
        gl.setRenderTarget(glTarget);
        gl.clear();
        gl.render(scene, camera);
      };
      const gpuDraw = (): void => {
        renderer.setRenderTarget(gpuTarget);
        renderer.clear();
        drawWith(camera, () => renderer.render(scene, camera));
      };
      /** Each renderer's draws issued in one go, the scene given back before anything waits: the game's own frames meanwhile see it whole. */
      const withView = <T>(twins: boolean, draw: () => T): T => {
        for (const light of casters) light.castShadow = false;
        prepare(scene, twins, faithfulOnly);
        try { return draw(); } finally {
          restoreTwins(scene);
          restoreHidden();
          gl.setRenderTarget(kept);
          renderer.setRenderTarget(null);
          for (const light of casters) light.castShadow = true;
        }
      };
      // The same instant for both: drawn one after the other in this task, no frame of the game between (the wind's clock moves only in a frame).
      withView(false, () => { glDraw(); gl.readRenderTargetPixels(glTarget, 0, 0, width, height, glHalf); });
      const reading = withView(true, () => { gpuDraw(); return renderer.readRenderTargetPixelsAsync(gpuTarget, 0, 0, width, height); });
      const leftOut = Object.fromEntries(tally.leftOut);
      const twins = Object.fromEntries(tally.twins);
      const asIs = { count: tally.asIs, names: [...tally.asIsNames] };
      const gpuHalf = (await reading) as Uint16Array;
      // WebGPU's rows come padded to 256 bytes (r186 `WebGPUTextureUtils.copyTextureToBuffer`): 128 half floats a block.
      const stride = Math.ceil((width * 8) / 256) * 128;
      const packed = stride === width * 4 ? gpuHalf : new Uint16Array(width * height * 4);
      if (packed !== gpuHalf) for (let y = 0; y < height; y++) packed.set(gpuHalf.subarray(y * stride, y * stride + width * 4), y * width * 4);
      const glPicture = toDisplay(glHalf, width, height, true);
      const gpuPicture = toDisplay(packed, width, height, false);
      const difference = comparePictures(glPicture, gpuPicture, threshold);

      const gpuMs = { webgl: null as number | null, webgpu: null as number | null };
      if (timingFrames > 0) {
        // An async function runs to its first wait at once: its draws are issued inside `withView`, their times read after.
        gpuMs.webgl = await withView(false, () => timeWebGl(gl, glDraw, timingFrames));
        const times: number[] = [];
        await renderer.resolveTimestampsAsync('render');
        for (let i = 0; i < timingFrames; i++) {
          withView(true, gpuDraw);
          const ms = await renderer.resolveTimestampsAsync('render');
          if (typeof ms === 'number' && ms > 0) times.push(ms);
        }
        gpuMs.webgpu = median(times);
      }
      glTarget.dispose();
      gpuTarget.dispose();
      const { image, ...numbers } = difference;
      return {
        width, height, webgl: await png(glPicture, width, height), webgpu: await png(gpuPicture, width, height), diff: await png(image, width, height),
        difference: numbers, gpuMs, leftOut, twins, asIs,
      };
    },
    dispose() {
      environment?.dispose();
      renderer.dispose();
    },
  };
  return view;
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]! * 1000) / 1000;
};

/** `draw` timed on the GPU `frames` times (EXT_disjoint_timer_query_webgl2), the median in ms; null when the browser does not time it. */
async function timeWebGl(gl: WebGLRenderer, draw: () => void, frames: number): Promise<number | null> {
  const context = gl.getContext() as WebGL2RenderingContext;
  const ext = context.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  if (!ext) return null;
  const queries: WebGLQuery[] = [];
  for (let i = 0; i < frames; i++) {
    const query = context.createQuery()!;
    context.beginQuery(ext.TIME_ELAPSED_EXT, query);
    draw();
    context.endQuery(ext.TIME_ELAPSED_EXT);
    queries.push(query);
  }
  const times: number[] = [];
  for (const query of queries) {
    for (let wait = 0; wait < 120 && !context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE); wait++) await new Promise((r) => requestAnimationFrame(r));
    if (context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE) && !context.getParameter(ext.GPU_DISJOINT_EXT)) {
      times.push((context.getQueryParameter(query, context.QUERY_RESULT) as number) / 1e6);
    }
    context.deleteQuery(query);
  }
  return median(times);
}

/** RGBA bytes as a PNG data URL. */
async function png(pixels: Uint8ClampedArray, width: number, height: number): Promise<string> {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}
