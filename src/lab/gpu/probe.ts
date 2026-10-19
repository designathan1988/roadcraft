import type { BufferGeometry, Camera, Light, Material, Object3D, RenderTarget, Scene, WebGLRenderer } from 'three';
import { POST_PASS_HOOK, type PostPassHook } from '@render/postprocess';
import type { PassTimer } from './passTimer';

/** THE LAB'S HOOKS INTO THE RENDERER: round every composer pass (`PostPassHook` on the scene's userData), round the shadow maps (`renderer.shadowMap.render`, wrapped from outside) and round every draw (`renderer.renderBufferDirect`, which three r186 calls for every object of a list, the shadow maps' casters and the full-screen quads alike). Installed while something of the lab listens, a straight call through otherwise. */

/** One draw call as the frame capture saw it. */
export interface DrawRecord {
  readonly index: number;
  /** The object drawn (the inspector's `drawsOf`), and its uuid. */
  readonly object: Object3D;
  readonly uuid: string;
  readonly name: string;
  readonly path: string;
  /** The top-level group under the scene it hangs from. */
  readonly layer: string;
  readonly kind: string;
  readonly instances: number;
  readonly material: string;
  readonly materialName: string;
  readonly program: string;
  readonly programKey: string;
  readonly triangles: number;
  readonly lines: number;
  readonly points: number;
  readonly vertices: number;
  readonly calls: number;
  /** The composer pass it was drawn in ('fora da cadeia': after or before the chain). */
  readonly pass: string;
  readonly target: string;
  readonly transparent: boolean;
  readonly depthWrite: boolean;
  readonly side: string;
}

/** Draws and triangles by layer, one frame. */
export interface LayerCount { calls: number; triangles: number }

export interface GpuProbe {
  /** The per-pass timer told of the passes (null: off). */
  timer: PassTimer | null;
  /** Every draw recorded while set (the frame capture). */
  capture: DrawRecord[] | null;
  /** The render targets drawn into while capturing. */
  readonly targets: Set<RenderTarget>;
  /** Draws counted by layer while set (the live counters). */
  layers: Map<string, LayerCount> | null;
  /** The debug views whose materials stand in for the scene pass's (`views.ts`): hooked in while one is on. */
  views: { readonly substituting: boolean; substitute(material: Material): Material | null } | null;
  /** The pass being drawn now. */
  readonly pass: string | null;
  /** Hooks in while anything above is set; out (as far as nobody wrapped over them) when nothing is. */
  update(): void;
  dispose(): void;
}

const SIDES = ['frente', 'verso', 'dupla'];
const PASS_NAMES: Record<string, string> = { scene: 'cena', gtao: 'GTAO', canyon: 'cânion', bloom: 'bloom', clouds: 'nuvens', smaa: 'SMAA', output: 'saída' };

/** FNV-1a of a string, 8 hex digits: a program's cache key shown short. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function createGpuProbe(renderer: WebGLRenderer, scene: Scene): GpuProbe {
  const passes: string[] = [];
  let shadowLight: string | null = null;
  const layerOf = new WeakMap<Object3D, string>();
  const pathOf = new WeakMap<Object3D, string>();
  const targetIds = new WeakMap<object, number>();
  let nextTarget = 1;
  let installed = false;
  let drawIndex = 0;

  const hook: PostPassHook = {
    before(name) {
      passes.push(name);
      probe.timer?.push(name);
    },
    after() {
      passes.pop();
      probe.timer?.pop();
    },
  };

  const shadowMap = renderer.shadowMap;
  /** What was there when hooked in (another wrapper's, `sunCascades.ts`): called through. */
  let shadowBase = shadowMap.render;
  let shadowIn = false;
  const shadowRender = function (this: unknown, lights: Light[], s: Scene, camera: Camera): void {
    // r186 WebGLShadowMap.render returns at once when nothing is to be drawn (`autoUpdate` off, `needsUpdate` false): not a segment then.
    const drawn = shadowMap.enabled && (shadowMap.autoUpdate || shadowMap.needsUpdate) && passes.length > 0;
    if (!drawn) { shadowBase.call(shadowMap, lights, s, camera); return; }
    probe.timer?.push('shadows');
    shadowLight = lights.filter((l) => l.castShadow).map((l) => l.name || l.type).join(', ') || 'sombra';
    try { shadowBase.call(shadowMap, lights, s, camera); } finally { shadowLight = null; probe.timer?.pop(); }
  };

  let drawBase = renderer.renderBufferDirect;
  let drawIn = false;
  const info = renderer.info.render;
  const draw = function (this: unknown, ...[camera, s, geometry, material, object, group]: Parameters<WebGLRenderer['renderBufferDirect']>): void {
    const capture = probe.capture, layers = probe.layers, views = probe.views;
    // The scene's objects in the scene pass only: the shadow maps keep their depth materials, the passes' quads (no parent: the scene's copy) their own.
    const drawn = views?.substituting && shadowLight === null && object.parent !== null && passes[passes.length - 1] === 'scene' ? views.substitute(material) : material;
    if (!drawn) return;
    if (!capture && !layers) { drawBase.call(renderer, camera, s, geometry, drawn, object, group); return; }
    const calls = info.calls, triangles = info.triangles, lines = info.lines, points = info.points;
    drawBase.call(renderer, camera, s, geometry, drawn, object, group);
    const layer = layerFor(object);
    const dTriangles = info.triangles - triangles;
    if (layers) {
      const row = layers.get(layer) ?? { calls: 0, triangles: 0 };
      row.calls += info.calls - calls;
      row.triangles += dTriangles;
      layers.set(layer, row);
    }
    if (capture) capture.push(record(object, geometry, material, layer, info.calls - calls, dTriangles, info.lines - lines, info.points - points));
  };

  function layerFor(object: Object3D): string {
    const known = layerOf.get(object);
    if (known !== undefined) return known;
    // The groups from the scene down to it: the layer is the top one, and the one under it when the top holds groups (the game's scene is one 'world' over its layers).
    const chain: Object3D[] = [];
    let at: Object3D | null = object;
    for (; at && !(at as Scene).isScene; at = at.parent) chain.unshift(at);
    const named = (o: Object3D): string => o.name || o.type;
    const layer = !at ? `quad: ${object.name || PASS_NAMES[passes[passes.length - 1] ?? ''] || 'fora da cena'}`
      : chain.length >= 3 ? `${named(chain[0]!)} / ${named(chain[1]!)}` : named(chain[0]!);
    layerOf.set(object, layer);
    return layer;
  }
  function pathFor(object: Object3D): string {
    const known = pathOf.get(object);
    if (known !== undefined) return known;
    const parts: string[] = [];
    for (let o: Object3D | null = object.parent; o && !(o as Scene).isScene; o = o.parent) parts.unshift(o.name || o.type);
    const path = parts.join(' / ');
    pathOf.set(object, path);
    return path;
  }
  function targetName(): string {
    if (shadowLight !== null) return `sombra: ${shadowLight}`;
    const target = renderer.getRenderTarget() as RenderTarget | null;
    if (!target) return 'tela';
    probe.targets.add(target);
    let id = targetIds.get(target);
    if (id === undefined) { id = nextTarget++; targetIds.set(target, id); }
    const name = target.texture?.name;
    return `RT#${id} ${target.width}×${target.height}${target.samples > 0 ? ` msaa${target.samples}` : ''}${name ? ` ${name}` : ''}`;
  }
  function record(object: Object3D, geometry: BufferGeometry, material: Material, layer: string, calls: number, triangles: number, lines: number, points: number): DrawRecord {
    const o = object as Object3D & { isInstancedMesh?: boolean; isBatchedMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean; count?: number; instanceCount?: number; _multiDrawCount?: number };
    const kind = o.isInstancedMesh ? 'InstancedMesh' : o.isBatchedMesh ? 'BatchedMesh' : o.isPoints ? 'Points' : o.isLine ? o.type : o.isSprite ? 'Sprite' : o.type;
    const instances = o.isInstancedMesh ? o.count ?? 1 : o.isBatchedMesh ? o._multiDrawCount ?? o.instanceCount ?? 1 : 1;
    const program = (renderer.properties.get(material) as { currentProgram?: { name: string; cacheKey: string; id: number } }).currentProgram;
    const counted = geometry.index ? geometry.index.count : (geometry.attributes['position']?.count ?? 0);
    const vertices = Math.max(0, Math.min(counted, geometry.drawRange.count) - geometry.drawRange.start);
    return {
      index: drawIndex++,
      object,
      uuid: object.uuid,
      name: object.name || '(sem nome)',
      path: pathFor(object),
      layer,
      kind,
      instances,
      material: material.type,
      materialName: material.name,
      // r186 names a program after the material it was built for (`shaderName: material.name`): often empty.
      program: program ? `${program.name || material.type} #${program.id}` : '?',
      programKey: program ? shortHash(program.cacheKey) : '',
      triangles,
      lines,
      points,
      vertices: vertices * instances,
      calls,
      pass: shadowLight !== null ? 'shadows' : passes[passes.length - 1] ?? 'fora da cadeia',
      target: targetName(),
      transparent: material.transparent,
      depthWrite: material.depthWrite,
      side: SIDES[material.side] ?? String(material.side),
    };
  }

  const probe: GpuProbe = {
    timer: null,
    capture: null,
    views: null,
    targets: new Set(),
    layers: null,
    get pass() { return passes[passes.length - 1] ?? null; },
    update() {
      const want = probe.timer !== null || probe.capture !== null || probe.layers !== null || probe.views?.substituting === true;
      if (want === installed) return;
      installed = want;
      if (want) {
        drawIndex = 0;
        scene.userData[POST_PASS_HOOK] = hook;
        // Hooked in on top of what is there now; still in the chain from before (wrapped over since): left as it is.
        if (!shadowIn) { shadowBase = shadowMap.render; shadowMap.render = shadowRender as typeof shadowMap.render; shadowIn = true; }
        if (!drawIn) { drawBase = renderer.renderBufferDirect; renderer.renderBufferDirect = draw; drawIn = true; }
        return;
      }
      if (scene.userData[POST_PASS_HOOK] === hook) delete scene.userData[POST_PASS_HOOK];
      // Wrapped over since (another wrapper bound ours): left in, a straight call through while nothing is set.
      if (shadowMap.render === (shadowRender as unknown)) { shadowMap.render = shadowBase; shadowIn = false; }
      if (renderer.renderBufferDirect === (draw as unknown)) { renderer.renderBufferDirect = drawBase; drawIn = false; }
      passes.length = 0;
    },
    dispose() {
      probe.timer = null;
      probe.capture = null;
      probe.layers = null;
      probe.views = null;
      probe.targets.clear();
      probe.update();
    },
  };
  return probe;
}
