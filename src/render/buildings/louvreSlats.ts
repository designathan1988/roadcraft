import { MeshStandardMaterial } from 'three';

/** THE SHUTTER LEAVES' SLATS DRAWN BY THEIR MATERIAL (`kit.ts` louvreGeometry): one box where nine slats were modelled, each pixel of it
 *  drawing the slat its ray meets, or nothing; the shadow's depth material the same (`partPose.ts` depthPatch). */

/** A louvred shutter leaf's slats (`louvreGeometry`, `LOUVRE_SLATS_GLSL`): nine, from y -0.42 every 0.105, about z -0.1, tilted -0.6 rad about x,
 *  0.07 thick and 0.7 deep, across the frame's opening. */
export const LOUVRE_FRAME = 0.09;
/** The box the slats are drawn in (`LOUVRE_SLATS_GLSL`): the frame's opening, its sides in the frame's inner faces (`louvreGeometry` leaves
 *  them out), and the slats' depth. Its corners are the model's only vertices at |x| = |y| = this half side (the frame's lie at 0.5 on one
 *  axis or the other): how the shader knows its faces. */
export const LOUVRE_BOX_HALF = 0.5 - LOUVRE_FRAME;
export const LOUVRE_BOX_Z0 = -0.41, LOUVRE_BOX_Z1 = 0.21;

/** GLSL of the slats in their box (`louvreGeometry`): `louvreSlat(o, d, n)`, the first slat a ray from `o` along `d` (the model's axes) meets
 *  inside the box, its distance along `d` (negative: none) and its face's normal toward the ray's start in `n`. Each slat a slab of two axes
 *  (its thickness and its depth, turned with it) and the opening's width. */
const LOUVRE_SLATS_GLSL = /* glsl */ `
float louvreSlat(vec3 o, vec3 d, out vec3 n) {
  const float A = -0.6;
  vec3 thick = vec3(0.0, cos(A), sin(A));
  vec3 deep = vec3(0.0, -sin(A), cos(A));
  float best = -1.0;
  n = vec3(0.0, 0.0, 1.0);
  for (int k = 0; k < 9; k++) {
    vec3 c = vec3(0.0, -0.42 + float(k) * 0.105, -0.1);
    vec3 oc = o - c;
    float t0 = -1e9, t1 = 1e9;
    vec3 n0 = vec3(0.0);
    // Its thickness, its depth and the opening's width, each a slab the ray enters and leaves.
    for (int a = 0; a < 3; a++) {
      vec3 u = a == 0 ? thick : a == 1 ? deep : vec3(1.0, 0.0, 0.0);
      float h = a == 0 ? 0.035 : a == 1 ? 0.35 : ${LOUVRE_BOX_HALF.toFixed(4)};
      float od = dot(oc, u), dd = dot(d, u);
      if (abs(dd) < 1e-6) { if (abs(od) > h) { t0 = 1.0; t1 = 0.0; } continue; }
      float ta = (-h - od) / dd, tb = (h - od) / dd;
      float tn = min(ta, tb), tf = max(ta, tb);
      if (tn > t0) { t0 = tn; n0 = -sign(dd) * u; }
      t1 = min(t1, tf);
    }
    if (t0 > t1 || t1 < 0.0) continue;
    float t = max(t0, 0.0);
    // Inside the box only: past it the frame's rails cover the slat, or it stands out of the leaf.
    vec3 p = o + d * t;
    if (abs(p.y) > ${LOUVRE_BOX_HALF.toFixed(4)} || p.z < ${(LOUVRE_BOX_Z0 - 0.001).toFixed(4)} || p.z > ${(LOUVRE_BOX_Z1 + 0.001).toFixed(4)}) continue;
    if (best < 0.0 || t < best) { best = t; n = t0 > 0.0 ? n0 : -d; }
  }
  return best;
}`;

/** The vertex half of the slats (`louvreSlats`): the model's point, the ray to it from the camera in the model's axes (the light's way for a
 *  shadow map: an orthographic camera looks along one direction), whether the vertex is the slats' box's, and the model-to-view normal matrix. */
const LOUVRE_VERTEX_HEAD = /* glsl */ `
varying vec3 vLouvreAt;
varying vec3 vLouvreRay;
varying float vLouvreBox;
varying vec3 vLouvreN0;
varying vec3 vLouvreN1;
varying vec3 vLouvreN2;`;
const LOUVRE_VERTEX_BODY = /* glsl */ `
#ifdef USE_INSTANCING
mat4 louvreModel = modelMatrix * instanceMatrix;
#else
mat4 louvreModel = modelMatrix;
#endif
vLouvreAt = position;
vLouvreBox = step(abs(abs(position.x) - ${LOUVRE_BOX_HALF.toFixed(4)}), 0.002) * step(abs(abs(position.y) - ${LOUVRE_BOX_HALF.toFixed(4)}), 0.002);
vec3 louvreWorld = (louvreModel * vec4(position, 1.0)).xyz;
vec3 louvreAhead = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
vec3 louvreRayWorld = projectionMatrix[3][3] == 1.0 ? louvreAhead : louvreWorld - cameraPosition;
vLouvreRay = (inverse(louvreModel) * vec4(louvreRayWorld, 0.0)).xyz;
mat3 louvreNormal = transpose(inverse(mat3(viewMatrix * louvreModel)));
vLouvreN0 = louvreNormal[0]; vLouvreN1 = louvreNormal[1]; vLouvreN2 = louvreNormal[2];`;

/** The slats drawn in their box (`louvreGeometry`), on a part's material or its shadow's depth material (`colour`): a pixel of the box whose
 *  ray meets no slat is not drawn (the wall behind, or the light past it); one that meets one takes its face's normal. The frame as it is. */
function louvreSlats(shader: { vertexShader: string; fragmentShader: string }, colour: boolean): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>${LOUVRE_VERTEX_HEAD}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>${LOUVRE_VERTEX_BODY}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>${LOUVRE_VERTEX_HEAD}${LOUVRE_SLATS_GLSL}`)
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
vec3 louvreFace = vec3(0.0, 0.0, 1.0);
if (vLouvreBox > 0.5) {
  if (louvreSlat(vLouvreAt, ${colour ? '' : '-'}normalize(vLouvreRay), louvreFace) < 0.0) discard;
}`);
  // The shadow pass draws a front-sided material's back faces (three r186 `shadowSide`): there the light's ray has crossed the box, so the
  // slats it met are back along it, toward the light.
  if (colour) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
if (vLouvreBox > 0.5) {
  normal = normalize(mat3(vLouvreN0, vLouvreN1, vLouvreN2) * louvreFace);
  nonPerturbedNormal = normal;
}`);
  }
}

/** The shutter leaves' material: its slats drawn in their box (`louvreSlats`), and its shadow's depth material the same (`partPose.ts`
 *  depthPatch): the light passes between the slats as the eye does. */
export function louvreMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, metalness: 0 });
  material.onBeforeCompile = (shader) => louvreSlats(shader, true);
  material.customProgramCacheKey = () => 'louvre-slats';
  material.userData['depthPatch'] = { key: 'louvre-slats-depth', patch: (shader: { vertexShader: string; fragmentShader: string }) => louvreSlats(shader, false) };
  return material;
}
