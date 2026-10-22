import {
  BasicShadowMap,
  LinearMipmapLinearFilter,
  MeshLambertMaterial,
  NearestFilter,
  NearestMipmapLinearFilter,
  PCFShadowMap,
  type Material,
  type Mesh,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { PostSwitches } from './effectSwitches';
import type { SceneEnvironment } from './environment';
import { DEFAULT_OPTIMIZATIONS, type Optimizations } from './optimizations';

/** THE OPTIMISATIONS IN THE RENDERER (`optimizations.ts`, the lab's "Optimisations"): what `renderer.ts` asks of them each frame, and what they change in three's renderer, its materials and textures. Every one at its default: nothing here touches the drawing. */

/** A render list's item as three's sort functions read it (r186 `WebGLRenderLists` painterSortStable). */
interface SortItem {
  readonly groupOrder: number;
  readonly renderOrder: number;
  readonly material: { readonly id: number };
  readonly z: number;
  readonly id: number;
}

/** DO NOT sort by material first: front to back alone, the most early-z can reject (three's default groups by material, then by depth). Its depth already turned for a reversed buffer (r186 `WebGLRenderList.push`). */
const depthFirst = (a: SortItem, b: SortItem): number =>
  a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || a.z - b.z || a.material.id - b.material.id || a.id - b.id;
/** The scene's own order: no sort at all, only the groups and render orders three must keep. */
const sceneOrder = (a: SortItem, b: SortItem): number => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder;

/** The materials, textures and meshes looked at again this often, frames, while an option that changes them is on: what came into the scene since is given it. */
const REWALK_FRAMES = 90;

export interface OptimizerDeps {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly environment: SceneEnvironment;
  /** The rivers and lakes of the plates shown. */
  waterMeshes(): readonly Object3D[];
}

export interface Optimizer {
  readonly values: Optimizations;
  /** The options taken: whether the lit programs must be built again, and the shadows drawn again. */
  set(next: Optimizations): { readonly programs: boolean; readonly shadows: boolean };
  /** The pixels a metre spans, as the buildings' levels are chosen by (`buildingLod`). */
  readonly buildingPx: number;
  /** The screen's height the terrain's levels are chosen by, times this (`terrainLod`). */
  readonly terrainPixels: number;
  /** A shadow texel, as the buildings' parts are cast by (`castTexel`). */
  readonly castTexel: number;
  /** The first cascade the buildings cast into by their masses alone (`castMasses`). */
  readonly coarseFrom: number;
  readonly agentShadows: boolean;
  readonly focusDetail: boolean;
  readonly exhaust: boolean;
  readonly wear: boolean;
  /** Whether this frame does it (`shadowEvery`, `reliefEvery`, `uploadEvery`): each asked once a frame, its own count. */
  shadowDue(): boolean;
  reliefDue(): boolean;
  uploadsDue(): boolean;
  /** The post chain's switches as the optimisations leave them: the street light off with Basic shadows (`canyonLight.ts` reads the cascades through a `sampler2DShadow`, which a Basic map, not compared, cannot be read by: GL_INVALID_OPERATION). The same object otherwise. */
  postSwitches(switches: PostSwitches): PostSwitches;
  /** Before the frame's drawing: the water's material swapped. */
  beforeRender(): void;
  /** After it: the water given back; every `REWALK_FRAMES`, what came in given the options. True when programs must be built (a material's precision changed). */
  afterRender(): boolean;
  /** What the options hold now (the lab's report). */
  report(): Readonly<Record<string, number>>;
  dispose(): void;
}

export function createOptimizer(deps: OptimizerDeps): Optimizer {
  const { renderer, scene, environment } = deps;
  let values: Optimizations = DEFAULT_OPTIMIZATIONS;
  const counts = { shadow: 0, relief: 0, uploads: 0, walk: 0 };
  const due = (key: 'shadow' | 'relief' | 'uploads', every: number): boolean => every <= 1 || counts[key]++ % every === 0;
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);
  // The defaults that are not the environment's own, set once: `set` applies only what changes from `values`, the defaults never.
  environment.setFarCascadeEvery(num(DEFAULT_OPTIMIZATIONS.farCascadeEvery, 1));

  // ---- materials, textures and meshes: what each was before, given back at the default
  const precisionWas = new Map<Material, Material['precision']>();
  const anisotropyWas = new Map<Texture, number>();
  const cullForced = new Set<Object3D>();
  // three r163 on draws with WebGL 2 only.
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const anisotropic = renderer.extensions.has('EXT_texture_filter_anisotropic')
    ? renderer.extensions.get('EXT_texture_filter_anisotropic') as { TEXTURE_MAX_ANISOTROPY_EXT: number } : null;
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

  /** A texture's anisotropy set, and on the GPU at once when it is there: three sets it only as it uploads (r186 `WebGLTextures.setTextureParameters`), so the texture already sent is given it straight, as three would (same conditions). */
  const setAnisotropy = (texture: Texture, value: number): void => {
    if (texture.anisotropy === value) return;
    texture.anisotropy = value;
    const props = renderer.properties.get(texture) as { __webglTexture?: WebGLTexture; __currentAnisotropy?: number };
    if (!anisotropic || !props.__webglTexture) return;
    if (texture.magFilter === NearestFilter) return;
    if (texture.minFilter !== NearestMipmapLinearFilter && texture.minFilter !== LinearMipmapLinearFilter) return;
    const t = texture as Texture & { isCubeTexture?: boolean; isDataArrayTexture?: boolean; isCompressedArrayTexture?: boolean; isData3DTexture?: boolean };
    const type = t.isCubeTexture ? gl.TEXTURE_CUBE_MAP : t.isDataArrayTexture || t.isCompressedArrayTexture ? gl.TEXTURE_2D_ARRAY : t.isData3DTexture ? gl.TEXTURE_3D : gl.TEXTURE_2D;
    // Through three's state, so its record of what is bound stays true.
    renderer.state.bindTexture(type, props.__webglTexture);
    gl.texParameterf(type, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, Math.max(1, Math.min(value, maxAnisotropy)));
    props.__currentAnisotropy = value;
  };

  const texturesOf = (material: Material, out: Set<Texture>): void => {
    const record = material as unknown as Record<string, unknown> & { uniforms?: Record<string, { value: unknown }> };
    for (const key in record) {
      const v = record[key] as Texture | null | undefined;
      if (v && (v as { isTexture?: boolean }).isTexture) out.add(v);
    }
    for (const key in record.uniforms ?? {}) {
      const v = record.uniforms![key]!.value;
      if (v && (v as { isTexture?: boolean }).isTexture) out.add(v as Texture);
      else if (Array.isArray(v)) for (const x of v) if (x && (x as { isTexture?: boolean }).isTexture) out.add(x as Texture);
    }
  };

  /** The scene walked once: every option on that changes materials, textures or meshes given to what has not had it. True when a material's precision changed. */
  const walk = (): boolean => {
    const precision = values.precision === 'mediump' ? 'mediump' : null;
    const cap = typeof values.anisotropy === 'number' ? values.anisotropy : null;
    // The tier's field set by hand (`q.anisotropy`): exactly that, over the cap.
    const exact = typeof values['q.anisotropy'] === 'number' ? values['q.anisotropy'] : null;
    const cull = values.frustumCull === 'plain';
    if (!precision && cap === null && exact === null && !cull) return false;
    let programs = false;
    const textures = new Set<Texture>();
    const seen = new Set<Material>();
    scene.traverse((object) => {
      const mesh = object as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean; isBatchedMesh?: boolean };
      if (cull && mesh.isMesh && !mesh.frustumCulled && !mesh.isInstancedMesh && !mesh.isSkinnedMesh && !mesh.isBatchedMesh) {
        mesh.frustumCulled = true;
        cullForced.add(mesh);
      }
      const material = mesh.material as Material | Material[] | undefined;
      if (!material) return;
      for (const m of Array.isArray(material) ? material : [material]) {
        if (seen.has(m)) continue;
        seen.add(m);
        if (precision && m.precision !== precision) {
          if (!precisionWas.has(m)) precisionWas.set(m, m.precision);
          m.precision = precision;
          m.needsUpdate = true;
          programs = true;
        }
        if (cap !== null || exact !== null) texturesOf(m, textures);
      }
    });
    for (const texture of textures) {
      if (!anisotropyWas.has(texture)) anisotropyWas.set(texture, texture.anisotropy);
      setAnisotropy(texture, Math.max(1, exact ?? Math.min(anisotropyWas.get(texture)!, cap!)));
    }
    return programs;
  };

  /** Each option that changed what the scene holds given back where it is at its default now. */
  const giveBack = (): boolean => {
    let programs = false;
    if (values.precision !== 'mediump' && precisionWas.size) {
      for (const [m, was] of precisionWas) { m.precision = was; m.needsUpdate = true; }
      precisionWas.clear();
      programs = true;
    }
    if (typeof values.anisotropy !== 'number' && typeof values['q.anisotropy'] !== 'number' && anisotropyWas.size) {
      for (const [texture, was] of anisotropyWas) setAnisotropy(texture, was);
      anisotropyWas.clear();
    }
    if (values.frustumCull !== 'plain' && cullForced.size) {
      for (const object of cullForced) object.frustumCulled = false;
      cullForced.clear();
    }
    return programs;
  };

  // ---- the water drawn plain for the frame
  const plainWater = new MeshLambertMaterial({ color: 0x3d6f86 });
  const swapped: Mesh[] = [];
  const kept: (Material | Material[])[] = [];

  /** The switches last given and what they became with Basic shadows: made again only when they change. */
  let switchesIn: PostSwitches | null = null;
  let switchesOut: PostSwitches | null = null;

  return {
    get values() { return values; },
    postSwitches(switches) {
      if (values.shadowType !== 'basic' || !switches.canyonLight) return switches;
      if (switchesIn !== switches) { switchesIn = switches; switchesOut = { ...switches, canyonLight: false }; }
      return switchesOut!;
    },
    set(next) {
      const before = values;
      values = next;
      let programs = false;
      let shadows = false;
      if (before.opaqueSort !== next.opaqueSort) {
        renderer.setOpaqueSort(next.opaqueSort === 'depth' ? depthFirst : next.opaqueSort === 'none' ? sceneOrder : null);
      }
      if (before.shadowType !== next.shadowType) {
        // Every lit program has the type in its key (r186 `WebGLPrograms` shadowMapType); the maps made again for it.
        renderer.shadowMap.type = next.shadowType === 'basic' ? BasicShadowMap : PCFShadowMap;
        environment.remakeShadowMaps();
        programs = true;
        shadows = true;
      }
      if (before.farCascadeEvery !== next.farCascadeEvery) {
        environment.setFarCascadeEvery(num(next.farCascadeEvery, 1));
        shadows = true;
      }
      if (before.castMasses !== next.castMasses || before.castTexel !== next.castTexel || before.agentShadows !== next.agentShadows) shadows = true;
      if (before.precision !== next.precision || before.anisotropy !== next.anisotropy || before['q.anisotropy'] !== next['q.anisotropy'] || before.frustumCull !== next.frustumCull) {
        programs = giveBack() || programs;
        programs = walk() || programs;
        counts.walk = 0;
      }
      return { programs, shadows };
    },
    get buildingPx() { return 1 / num(values.buildingLod, 1); },
    get terrainPixels() { return 1 / num(values.terrainLod, 1); },
    get castTexel() { return values.castTexel === 'none' ? Infinity : num(values.castTexel, 1); },
    get coarseFrom() { return values.castMasses === 'all' ? 0 : values.castMasses === 'none' ? Infinity : 1; },
    get agentShadows() { return values.agentShadows !== 'disc'; },
    get focusDetail() { return values.focusDetail !== 'off'; },
    get exhaust() { return values.exhaust !== 'off'; },
    get wear() { return values.wear !== 'off'; },
    shadowDue: () => due('shadow', num(values.shadowEvery, 1)),
    reliefDue: () => due('relief', num(values.reliefEvery, 1)),
    uploadsDue: () => due('uploads', num(values.uploadEvery, 1)),
    beforeRender() {
      if (values.waterMaterial !== 'plain') return;
      for (const root of deps.waterMeshes()) {
        root.traverse((object) => {
          const mesh = object as Mesh;
          if (!mesh.isMesh || !mesh.visible) return;
          swapped.push(mesh);
          kept.push(mesh.material);
          mesh.material = plainWater;
        });
      }
    },
    afterRender() {
      for (let i = 0; i < swapped.length; i++) swapped[i]!.material = kept[i]!;
      swapped.length = 0;
      kept.length = 0;
      if (values.precision === 'highp' && values.anisotropy === 'tier' && values['q.anisotropy'] === 'tier' && values.frustumCull === 'as-is') return false;
      if (++counts.walk % REWALK_FRAMES !== 0) return false;
      return walk();
    },
    report: () => ({ materialsWithPrecision: precisionWas.size, texturesCapped: anisotropyWas.size, meshesCullForced: cullForced.size, maxAnisotropy }),
    dispose() {
      plainWater.dispose();
    },
  };
}
