import { DoubleSide, MeshStandardMaterial, ShaderChunk, type WebGLProgramParametersWithUniforms } from 'three';

import { type Finish, FINISHES } from '@world/buildings/materials';
import { LOOKS, finishTiles } from '../bake/finishRecipes';
import { type SurfaceBake, surfaceMaps } from '../surfaceTextures';
import { applyLotOverlay } from '../lotOverlay';
import { FINISH_ATTRIBUTE } from './cellArrays';

/** The building finishes ("Materials"): their recipes in `bake/finishRecipes.ts`, baked at build time as one texture array per map, a layer per finish */

/** Four-number rows a finish takes in the look table: (uv scale, normal scale, metalness, envMapIntensity), then (metal read from the map, roof, glassy, 0). */
const LOOK_ROWS = 2;

/** Each finish's scalars, indexed by its id (its place in `FINISHES`, its layer in the arrays); `baked`: its maps are loaded. */
export function finishLookTable(baked: boolean): Float32Array {
  const table = new Float32Array(FINISHES.length * LOOK_ROWS * 4);
  FINISHES.forEach((finish, id) => {
    const look = LOOKS[finish];
    const at = id * LOOK_ROWS * 4;
    // A smaller finish is tiled in its layer (`bake/catalogue.ts`): its uv shrunk by as much, the same texels a metre.
    table[at] = 1 / look.worldSize / finishTiles(finish);
    table[at + 1] = look.normalScale;
    // No map to say where the metal is: the larger part, the glass.
    table[at + 2] = look.metallic && !baked ? 0 : look.metalness;
    table[at + 3] = look.envMapIntensity;
    table[at + 4] = look.metallic && baked ? 1 : 0;
    table[at + 5] = finish === 'roofing' || finish === 'tile' || finish === 'slate' ? 1 : 0;
    table[at + 6] = finish === 'glass' || finish === 'metal' ? 1 : 0;
  });
  return table;
}

/** GLSL: the pixel's finish rows, and the sky's share it reflects (read by three's IBL in place of the material's one `envMapIntensity`). */
const FINISH_PARS = `
uniform vec4 shellLooks[${FINISHES.length * LOOK_ROWS}];
flat varying int vShellFinish;
varying vec2 vShellUv;
vec4 shellLook = vec4(0.0);
vec4 shellKind = vec4(0.0);
float shellEnvScale = 1.0;`;

/** GLSL: the finishes' maps as texture arrays, and the tangent frame three builds for a normal map without tangents (r186 `normalmap_pars_fragment`; C. Schueler, "Normal Mapping Without Precomputed Tangents"). */
const MAP_PARS = `
uniform sampler2DArray shellMaps;
uniform sampler2DArray shellNormals;
uniform sampler2DArray shellRough;
vec4 shellRoughTexel = vec4(1.0);
mat3 shellTangentFrame(vec3 eye_pos, vec3 surf_norm, vec2 uv) {
  vec3 q0 = dFdx(eye_pos.xyz);
  vec3 q1 = dFdy(eye_pos.xyz);
  vec2 st0 = dFdx(uv.st);
  vec2 st1 = dFdy(uv.st);
  vec3 N = surf_norm;
  vec3 q1perp = cross(q1, N);
  vec3 q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  return mat3(T * scale, B * scale, N);
}`;

/** GLSL: the weathering's noise. */
const WEATHER_PARS = `
varying float vDecay;
varying vec3 vDecayWorld;
varying vec3 vDecayNormal;
float dHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float dNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dHash(i), dHash(i + vec3(1, 0, 0)), f.x), mix(dHash(i + vec3(0, 1, 0)), dHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(dHash(i + vec3(0, 0, 1)), dHash(i + vec3(1, 0, 1)), f.x), mix(dHash(i + vec3(0, 1, 1)), dHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`;

/** GLSL after the map: buildings that are not maintained run down (the player's order of 2026-10-05), each finish as its row says (roof, glassy) */
const WEATHERING = `
{
  vec3 w = vDecayWorld;
  // MACRO VARIATION, on every building
  float macro = dNoise(w * 0.045) * 0.55 + dNoise(w * 0.17) * 0.3 + dNoise(w * 0.6) * 0.15;
  diffuseColor.rgb *= 0.9 + 0.2 * macro;
}
{
  // After the texture: the stains darken the finish as painted (streaks, grime), heavier as a building runs down (aDecay).
  float d = max(vDecay, shellKind.z > 0.5 ? 0.0 : 0.3);
  vec3 w = vDecayWorld;
  bool wall = abs(vDecayNormal.y) < 0.5;
  // Rain streaks: thin, long, running down from sills and copings.
  float streak = smoothstep(0.55, 0.85, dNoise(vec3(w.x * 2.2, w.y * 0.08, w.z * 2.2)));
  // Grime: darker towards the foot of the wall and in soft patches.
  float grime = 0.5 + 0.5 * dNoise(w * 0.22);
  float darken = d * (0.18 + 0.12 * grime + (wall ? 0.28 * streak : 0.1));
  diffuseColor.rgb *= 1.0 - darken;
}
if (vDecay > 0.001 && shellKind.z < 0.5) {
  float d = vDecay;
  vec3 w = vDecayWorld;
  bool wall = abs(vDecayNormal.y) < 0.5;
  if (shellKind.y > 0.5) {
    // Dark moss in the low corners of the roof.
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.55, 0.62, 0.45), d * 0.6 * smoothstep(0.6, 0.85, dNoise(w * 0.3)));
  } else {
    // Paint gone in a few small patches, the darker render showing.
    float peel = smoothstep(0.8 - d * 0.12, 0.83 - d * 0.12, dNoise(w * 1.3 + 7.0));
    if (wall) diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.72, 0.68, 0.62), peel * d);
  }
}`;

/** The shell's program: each pixel's finish (a byte a vertex, `FINISH_ATTRIBUTE`) picks its layer of the maps and its rows of the look table; `weathered` adds the wear */
function shellShader(shader: WebGLProgramParametersWithUniforms, maps: SurfaceBake | undefined, looks: { value: Float32Array }, weathered: boolean): void {
  shader.uniforms['shellLooks'] = looks;
  if (maps) {
    shader.uniforms['shellMaps'] = { value: maps.map };
    shader.uniforms['shellNormals'] = { value: maps.normalMap };
    shader.uniforms['shellRough'] = { value: maps.roughnessMap };
  }
  const layer = 'vec3(vShellUv, float(vShellFinish))';
  // Each addition lands right after its chunk: a material built on this one (`facadeLevel.ts`) adds its own after it.
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
attribute float ${FINISH_ATTRIBUTE};
uniform vec4 shellLooks[${FINISHES.length * LOOK_ROWS}];
flat varying int vShellFinish;
varying vec2 vShellUv;
${weathered ? 'attribute float aDecay;\nvarying float vDecay;\nvarying vec3 vDecayWorld;\nvarying vec3 vDecayNormal;' : ''}`)
    // The finish's tile, as each finish's map repeat was.
    .replace('#include <uv_vertex>', `#include <uv_vertex>
vShellFinish = int(${FINISH_ATTRIBUTE} + 0.5);
vShellUv = uv * shellLooks[vShellFinish * ${LOOK_ROWS}].x;`);
  if (weathered) {
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vDecay = aDecay;
vDecayWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vDecayNormal = normalize(mat3(modelMatrix) * objectNormal);`);
  }
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FINISH_PARS}\n${maps ? MAP_PARS : ''}\n${weathered ? WEATHER_PARS : ''}`)
    .replace('#include <envmap_physical_pars_fragment>', ShaderChunk.envmap_physical_pars_fragment.replace(/\benvMapIntensity\b/g, '( envMapIntensity * shellEnvScale )'))
    .replace('#include <map_fragment>', `#include <map_fragment>
shellLook = shellLooks[vShellFinish * ${LOOK_ROWS}];
shellKind = shellLooks[vShellFinish * ${LOOK_ROWS} + 1];
shellEnvScale = shellLook.w;
${maps ? `diffuseColor *= texture(shellMaps, ${layer});` : ''}
${weathered ? WEATHERING : ''}`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
${maps ? `shellRoughTexel = texture(shellRough, ${layer});\nroughnessFactor *= shellRoughTexel.g;` : ''}`)
    // The glass's metal (its mullions) read from the roughness map's blue, as three reads a metalness map.
    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor *= shellLook.z;
${maps ? 'if (shellKind.x > 0.5) metalnessFactor *= shellRoughTexel.b;' : ''}`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
${maps ? `{
  mat3 shellTbn = shellTangentFrame(- vViewPosition, normal, vShellUv);
  #ifdef DOUBLE_SIDED
    shellTbn[0] *= faceDirection;
    shellTbn[1] *= faceDirection;
  #endif
  vec3 mapN = texture(shellNormals, ${layer}).xyz * 2.0 - 1.0;
  mapN.xy *= shellLook.y;
  normal = normalize(shellTbn * mapN);
}` : ''}`);
}

/**
 * THE ONE SHELL MATERIAL: every finish of a cell's shells in one draw, textured where the build's baked surfaces are loaded (`surfaceBakeClient.ts`; none in a worker or a test).
 * `plain`: the faded copy's look ("Ocultar outros"): the finishes' maps and scalars without the wear or the lots, as the per-finish clones drew it.
 */
export function createShellMaterial(options: { readonly plain?: boolean } = {}, anisotropy = 8): MeshStandardMaterial {
  const plain = options.plain === true;
  const maps = surfaceMaps('building-finishes', anisotropy);
  // The shell is not a closed solid (openings, no underside), so it casts from both sides; roughness, metalness and the sky's share are each finish's row times these.
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: maps ? 1 : 0.9, metalness: 1, envMapIntensity: 1, shadowSide: DoubleSide });
  material.name = plain ? 'building-shell-plain' : 'building-shell';
  const looks = { value: finishLookTable(maps !== undefined) };
  material.onBeforeCompile = (shader) => shellShader(shader, maps, looks, !plain);
  const key = `building-shell-v1-${plain ? 'plain' : 'weathered'}-${maps ? 'maps' : 'none'}`;
  material.customProgramCacheKey = () => key;
  // A built lot's yard - the paving and paths are this shell's level faces at the lot's ground
  if (!plain) applyLotOverlay(material, 'building-shell', { building: true });
  return material;
}

/** Each finish's colour as it reads from afar, three numbers to multiply a wall's tint by: the mean of its texture */
export function finishAlbedo(): Record<Finish, readonly [number, number, number]> {
  const out = {} as Record<Finish, readonly [number, number, number]>;
  const STEPS = 48;
  for (const finish of FINISHES) {
    const look = LOOKS[finish];
    const shade = look.shade(look.size);
    const texel = { r: 0, g: 0, b: 0, h: 0, rough: 0, metal: 0 };
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < STEPS; i++) {
      for (let j = 0; j < STEPS; j++) {
        texel.metal = 0;
        shade(((i + 0.5) / STEPS) * look.size, ((j + 0.5) / STEPS) * look.size, texel);
        r += texel.r; g += texel.g; b += texel.b;
      }
    }
    const n = STEPS * STEPS;
    const weathered = finish === 'glass' || finish === 'metal' ? 1 : WEATHERED_MEAN;
    out[finish] = [(r / n) * weathered, (g / n) * weathered, (b / n) * weathered];
  }
  return out;
}

/** How dark the light weathering of every wall leaves it on average (`WEATHERING`, `d` of 0.3: 0.3 x (0.18 + 0.12 x 0.75 + a few streaks)). */
const WEATHERED_MEAN = 0.91;
