import { Material, Object3D, type BufferGeometry, type Mesh } from 'three';

/** WHAT THE WEBGPU RENDERER CAN DRAW AS IT STANDS (`MIGRACAO-WEBGPU.md`, stage 1): three's WebGPURenderer turns only its own material types
 *  into node materials (r186 `StandardNodeLibrary`: no ShaderMaterial, no depth material in the scene), never runs `onBeforeCompile`, and has
 *  no `GLBufferAttribute` (a WebGL buffer of the game's own) nor a texture another renderer drew. What cannot be drawn is left out of its frame
 *  and named, never drawn wrong. This module imports no WebGPU code: the WebGL game loads none of it. */

/** The material types three's WebGPU renderer turns into node materials (r186 `StandardNodeLibrary.addMaterial`). */
const NODE_LIBRARY_TYPES: readonly string[] = Object.freeze([
  'MeshPhongMaterial', 'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshToonMaterial', 'MeshBasicMaterial', 'MeshLambertMaterial',
  'MeshNormalMaterial', 'MeshMatcapMaterial', 'LineBasicMaterial', 'LineDashedMaterial', 'PointsMaterial', 'SpriteMaterial',
]);

/** A material's own texture slots that another renderer may have drawn into. */
const TEXTURE_SLOTS = ['map', 'alphaMap', 'aoMap', 'bumpMap', 'normalMap', 'displacementMap', 'emissiveMap', 'envMap', 'lightMap', 'metalnessMap', 'roughnessMap', 'specularMap', 'gradientMap', 'matcap'] as const;

export interface Compatibility {
  /** Why the WebGPU renderer cannot draw this material as it stands, or null when it can. Kept per material (a material does not change kind). */
  material(material: Material): string | null;
  /** Why its geometry cannot go to the WebGPU renderer (a buffer of WebGL's own), or null. Kept per geometry, its attributes as first seen. */
  geometry(geometry: BufferGeometry): string | null;
  /** Why this drawable cannot be drawn by the WebGPU renderer, or null: its materials, its geometry, a hook of its own run at each draw. */
  drawable(object: Object3D): string | null;
}

/** The verdicts, each kept for the renderer that asks them. */
export function createCompatibility(): Compatibility {
  const materialVerdicts = new WeakMap<Material, string | null>();
  const geometryVerdicts = new WeakMap<BufferGeometry, string | null>();
  const compatibility: Compatibility = {
    material: (material) => materialBlocker(material, materialVerdicts),
    geometry: (geometry) => geometryBlocker(geometry, geometryVerdicts),
    drawable: (object) => drawableBlocker(object, compatibility),
  };
  return compatibility;
}

function materialBlocker(material: Material, materialVerdicts: WeakMap<Material, string | null>): string | null {
  let verdict = materialVerdicts.get(material);
  if (verdict !== undefined) return verdict;
  const m = material as Material & { isNodeMaterial?: boolean } & Partial<Record<(typeof TEXTURE_SLOTS)[number], { isRenderTargetTexture?: boolean } | null>>;
  verdict = null;
  if (m.isNodeMaterial) verdict = null;
  else if (m.onBeforeCompile !== Material.prototype.onBeforeCompile) verdict = `onBeforeCompile (${m.type})`;
  else if (!NODE_LIBRARY_TYPES.includes(m.type)) verdict = m.type;
  else {
    for (const slot of TEXTURE_SLOTS) {
      if (m[slot]?.isRenderTargetTexture) { verdict = `${slot} drawn by WebGL`; break; }
    }
  }
  materialVerdicts.set(material, verdict);
  return verdict;
}

function geometryBlocker(geometry: BufferGeometry, geometryVerdicts: WeakMap<BufferGeometry, string | null>): string | null {
  let verdict = geometryVerdicts.get(geometry);
  if (verdict !== undefined) return verdict;
  verdict = null;
  for (const name in geometry.attributes) {
    if ((geometry.attributes[name] as { isGLBufferAttribute?: boolean }).isGLBufferAttribute) { verdict = `GLBufferAttribute (${name})`; break; }
  }
  geometryVerdicts.set(geometry, verdict);
  return verdict;
}

function drawableBlocker(object: Object3D, verdicts: Compatibility): string | null {
  const mesh = object as Mesh;
  if (object.onBeforeRender !== Object3D.prototype.onBeforeRender) return 'onBeforeRender hook';
  const geometry = mesh.geometry as BufferGeometry | undefined;
  if (geometry) {
    const g = verdicts.geometry(geometry);
    if (g) return g;
  }
  const material = mesh.material as Material | Material[] | undefined;
  if (Array.isArray(material)) {
    for (const one of material) { const m = verdicts.material(one); if (m) return m; }
    return null;
  }
  return material ? verdicts.material(material) : null;
}

/** Whether three draws it itself (a mesh, line, points or sprite), as opposed to a group, a light or a camera. */
export const isDrawable = (object: Object3D): boolean => {
  const o = object as Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
  return !!(o.isMesh || o.isLine || o.isPoints || o.isSprite);
};
