import { BufferGeometry, InterleavedBufferAttribute, type InstancedInterleavedBuffer, Material, MeshDepthMaterial } from 'three';

/** A BUILDING PART'S PLACE AS THE GPU TAKES IT: a pose turned about the up axis - its place in three's axes, its turn's cosine and sine and its scale on three axes - 8 floats in place of a 16-float matrix; the vertex shader makes the matrix (as `cellInstances.ts` `posedMaterial` does) */

/** Floats a part's pose takes: x, y, z (three's axes), the turn's cosine; its sine, then the scale along the model's x, y and z. The turn kept as its cosine and sine, as the matrix kept it: the same numbers to the float. */
export const POSE_FLOATS = 8;

/** The pose's instanced attributes, as `posedMaterial` reads them (`cellInstances.ts` POSE_A, POSE_B): its first four floats, and the scale. */
const POSE_A = 'instancePoseA';
const POSE_B = 'instancePoseB';

/** A pose's matrix, column-major T * Ry * S, as its GLSL makes it (`partPoseShader`). */
export function poseMatrixInto(poses: ArrayLike<number>, at: number, out: Float32Array | number[], outAt: number): void {
  const c = poses[at + 3]!, s = poses[at + 4]!, sx = poses[at + 5]!, sy = poses[at + 6]!, sz = poses[at + 7]!;
  out[outAt] = c * sx; out[outAt + 1] = 0; out[outAt + 2] = -s * sx; out[outAt + 3] = 0;
  out[outAt + 4] = 0; out[outAt + 5] = sy; out[outAt + 6] = 0; out[outAt + 7] = 0;
  out[outAt + 8] = s * sz; out[outAt + 9] = 0; out[outAt + 10] = c * sz; out[outAt + 11] = 0;
  out[outAt + 12] = poses[at]!; out[outAt + 13] = poses[at + 1]!; out[outAt + 14] = poses[at + 2]!; out[outAt + 15] = 1;
}

/** Every pose of a batch as its matrix, 16 floats each: what a ruin is broken from (`fracture.ts`). */
export function poseMatrices(poses: Float32Array, count: number): Float32Array {
  const out = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) poseMatrixInto(poses, i * POSE_FLOATS, out, i * 16);
  return out;
}

/** A model with a batch's poses as its instanced attributes, bound at instance `at`: the model's own attributes and index shared (three keeps one buffer per attribute, r186 `WebGLAttributes`). */
export function posedCopy(model: BufferGeometry, poses: InstancedInterleavedBuffer, at = 0): BufferGeometry {
  const g = new BufferGeometry();
  g.name = model.name;
  g.setIndex(model.index);
  for (const name of Object.keys(model.attributes)) g.setAttribute(name, model.attributes[name]!);
  for (const group of model.groups) g.addGroup(group.start, group.count, group.materialIndex);
  g.setDrawRange(model.drawRange.start, model.drawRange.count);
  g.boundingBox = model.boundingBox;
  g.boundingSphere = model.boundingSphere;
  g.setAttribute(POSE_A, new InterleavedBufferAttribute(poses, 4, at * POSE_FLOATS));
  g.setAttribute(POSE_B, new InterleavedBufferAttribute(poses, 4, at * POSE_FLOATS + 4));
  return g;
}

/** A posed copy let go: the model's attributes and index taken off first, so three frees the poses' buffer only (r186 `WebGLGeometries` frees every attribute a disposed geometry holds). */
export function letGoPosed(g: BufferGeometry, model: BufferGeometry): void {
  for (const name of Object.keys(g.attributes)) if (g.attributes[name] === model.attributes[name]) g.deleteAttribute(name);
  if (g.index === model.index) g.setIndex(null);
  g.dispose();
}

/** GLSL `mat4 partPoseMatrix(vec4 a, vec4 b)`: `poseMatrixInto` in GLSL, a = x, y, z, the turn's cosine; b = its sine, the scale. */
const POSE_MATRIX_GLSL = /* glsl */ `
mat4 partPoseMatrix(vec4 a, vec4 b) {
  return mat4(a.w * b.y, 0.0, -b.x * b.y, 0.0, 0.0, b.z, 0.0, 0.0, b.x * b.w, 0.0, a.w * b.w, 0.0, a.x, a.y, a.z, 1.0);
}`;
const MAIN = /\bvoid\s+main\s*\(\s*\)\s*\{/;

/** A vertex shader drawn from poses: three's `instanceMatrix` (r186 `WebGLProgram` declares it in the prefix; `project_vertex`, `worldpos_vertex`, `defaultnormal_vertex` and the parts' own patches read it) becomes the matrix made from the pose at the top of `main`, the attribute left unread (as `cellInstances.ts` `poseVertexShader`). */
export function partPoseShader(source: string): string {
  if (!MAIN.test(source)) throw new Error('[buildings] a part\'s vertex shader with no main() to make its matrix in');
  return `#ifdef USE_INSTANCING
attribute vec4 ${POSE_A};
attribute vec4 ${POSE_B};
mat4 partInstanceMatrix;
#define instanceMatrix partInstanceMatrix
${POSE_MATRIX_GLSL}
#endif
${source.replace(MAIN, (open) => `${open}
#ifdef USE_INSTANCING
  partInstanceMatrix = partPoseMatrix(${POSE_A}, ${POSE_B});
#endif`)}`;
}

const POSED = Symbol('partPosed');
const POSE_DEPTH = Symbol('partPoseDepth');
type Posed = Material & { [POSED]?: true; [POSE_DEPTH]?: MeshDepthMaterial };

/** A material its instanced meshes draw from poses, patched once and for good, after its own patches (its non-instanced meshes draw as before): call it once every patch is set. */
export function posePart<M extends Material>(material: M): M {
  const marked = material as M & Posed;
  if (marked[POSED]) return material;
  marked[POSED] = true;
  const compile = material.onBeforeCompile, key = material.customProgramCacheKey;
  // three's own key is the patch's source (r186 `Material.customProgramCacheKey`): the one before this patch.
  const source = key === Material.prototype.customProgramCacheKey ? compile.toString() : null;
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(material, shader, renderer);
    shader.vertexShader = partPoseShader(shader.vertexShader);
  };
  material.customProgramCacheKey = () => `${source ?? key.call(material)}|part-pose`;
  material.needsUpdate = true;
  return material;
}

/** The shadow pass's material of a part's material: three's depth material drawn from the poses, one per material (r186 `WebGLShadowMap` copies its map and alpha test onto it each draw). */
export function partPoseDepth(material: Material): MeshDepthMaterial {
  const caster = material as Posed;
  // // No colour: the sun's maps are read by their depth texture alone (three r186 PCF compares `shadow.map.depthTexture`), nothing reads the packed colour (AGT-35).
  return posePart(caster[POSE_DEPTH] ??= new MeshDepthMaterial({ colorWrite: false }));
}
