import {
  MeshDepthMaterial,
  RGBADepthPacking,
  ShaderChunk,
  Vector2,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { m, perM } from '@world/units';

/**
 * Wind: the one moving thing in a scene of static props.
 *
 * Trees, bushes and grass bend in the vertex shader, so a thousand trees cost
 * one uniform write a frame and not one matrix. The motion is layered the way
 * real vegetation moves:
 *
 *  - a slow GUST that travels across the map, so neighbouring trees lean
 *    together and a wave of it can be seen crossing a field;
 *  - a SWAY, each plant at its own phase, bending harder towards the top
 *    (displacement grows with the square of height, as a cantilever does);
 *  - a fast FLUTTER of individual leaves and blades, keyed off the vertex
 *    position, which is what reads as foliage rather than as a rigid shape
 *    rocking.
 *
 * Every mesh here is an `InstancedMesh` whose geometry is authored ONE unit
 * tall with its root at the origin, so the local `y` is already "fraction of
 * height" and the instance's Y scale is the height in world units.
 *
 * The same bend is installed on a depth material, so the shadows move with
 * the trees instead of lying still under them.
 */

/** Shared by every material with wind; `renderer.ts` advances the time. */
export const windUniforms = {
  uWindTime: { value: 0 },
  /** Direction the wind blows TOWARDS, in three's XZ plane. */
  uWindDir: { value: new Vector2(0.82, -0.57).normalize() },
  /** How hard it blows, 1 the breeze the plants were tuned to (`setWindWeather`). */
  uWindStrength: { value: 1 },
};

/**
 * The map's wind (`world/weather.ts`): which way it blows, towards (three's
 * x and z), and how fast, metres a second. Still air leaves a breath of a
 * breeze; the plants were tuned to some 4.5 m/s, and a gale bends them
 * about four times as far.
 */
export function setWindWeather(dirX: number, dirZ: number, metresPerSecond: number): void {
  const length = Math.hypot(dirX, dirZ);
  if (length > 1e-6) windUniforms.uWindDir.value.set(dirX / length, dirZ / length);
  windUniforms.uWindStrength.value = Math.min(4.2, 0.3 + metresPerSecond / 6.5);
}

export interface WindResponse {
  /** Top displacement as a fraction of height, at a full gust. */
  readonly sway: number;
  /** Leaf or blade flutter, as a fraction of height. */
  readonly flutter: number;
}

const WIND_GLSL = /* glsl */ `
  uniform float uWindTime;
  uniform vec2 uWindDir;
  uniform float uWindStrength;
  uniform float uWindSway;
  uniform float uWindFlutter;

  vec3 windOffset(vec3 local, mat4 placement) {
    vec3 root = placement[3].xyz;
    float height = length(placement[1].xyz);
    float h = clamp(local.y, 0.0, 1.4);
    float bend = h * h;
    float phase = dot(root.xz, vec2(${perM(0.03275).toFixed(6)}, ${perM(0.04325).toFixed(6)}));
    // A gust front travelling downwind across the map.
    float front = dot(root.xz, uWindDir) * ${perM(0.03).toFixed(6)} - uWindTime * 0.42;
    float gust = 0.45 + 0.55 * smoothstep(-0.6, 1.0, sin(front) + 0.35 * sin(front * 2.3 + 1.7));
    float sway = 0.45
      + 0.4 * sin(uWindTime * 1.35 + phase * 7.0 + root.x * ${perM(0.0775).toFixed(6)})
      + 0.15 * sin(uWindTime * 2.9 + phase * 11.0);
    vec3 dir = vec3(uWindDir.x, 0.0, uWindDir.y);
    vec3 offset = dir * sway * gust * bend * uWindSway * uWindStrength * height;
    float leaf = sin(uWindTime * 7.3 + dot(local, vec3(37.0, 19.0, 29.0)) + phase * 17.0);
    float leaf2 = cos(uWindTime * 5.1 + dot(local, vec3(23.0, 41.0, 13.0)));
    offset += vec3(leaf, 0.35 * leaf2, leaf2) * uWindFlutter * h * height * (0.4 + gust) * min(uWindStrength, 2.0);
    // A bent stem is no longer: drop the tip by what it moved sideways, so a
    // tree leans rather than stretches.
    offset.y -= dot(offset.xz, offset.xz) / max(2.0 * height * max(h, 0.2), 0.001);
    return offset;
  }
`;

// Three's own `project_vertex`, with the wind added before the model-view
// matrix (read when a program is built).
const projectWithWind = (): string => ShaderChunk.project_vertex.replace(
  'mvPosition = modelViewMatrix * mvPosition;',
  `#ifdef USE_INSTANCING
     mvPosition.xyz += windOffset(transformed, instanceMatrix);
   #endif
   mvPosition = modelViewMatrix * mvPosition;`,
);

function install(shader: WebGLProgramParametersWithUniforms, response: WindResponse): void {
  Object.assign(shader.uniforms, windUniforms, {
    uWindSway: { value: response.sway },
    uWindFlutter: { value: response.flutter },
  });
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${WIND_GLSL}`)
    .replace('#include <project_vertex>', projectWithWind());
}

/**
 * Foliage the camera has come into fades out, a pixel at a time (Godot's
 * distance fade "Pixel Dither": a fraction of the pixels drawn, the material
 * kept opaque and its shadow whole): brought down to the street, the camera
 * stood inside a crown and the screen was leaves (2026-10-09). Ordered (a
 * 4x4 Bayer matrix), so it does not crawl from frame to frame. Gone nearer
 * than `NEAR_FADE[0]`, whole beyond `NEAR_FADE[1]`.
 */
const NEAR_FADE = [m(1.5), m(5)] as const;
const NEAR_FADE_GLSL = /* glsl */ `
  {
    float nearFade = clamp((length(vViewPosition) - ${NEAR_FADE[0].toFixed(3)}) / ${(NEAR_FADE[1] - NEAR_FADE[0]).toFixed(3)}, 0.0, 1.0);
    if (nearFade < 1.0) {
      ivec2 cell = ivec2(mod(gl_FragCoord.xy, 4.0));
      int k = cell.x + cell.y * 4;
      float bayer = float(k == 0 ? 0 : k == 1 ? 8 : k == 2 ? 2 : k == 3 ? 10 : k == 4 ? 12 : k == 5 ? 4 : k == 6 ? 14 : k == 7 ? 6
        : k == 8 ? 3 : k == 9 ? 11 : k == 10 ? 1 : k == 11 ? 9 : k == 12 ? 15 : k == 13 ? 7 : k == 14 ? 13 : 5) / 16.0 + 1.0 / 32.0;
      if (nearFade < bayer) discard;
    }
  }
`;

/** Makes a material's instances bend in the wind (and fade where the camera is among them). */
export function applyWind(material: Material, response: WindResponse, key: string): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    install(shader, response);
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
${NEAR_FADE_GLSL}`);
  };
  material.customProgramCacheKey = () => `wind-${key}-nearfade`;
}

/** The shadow-pass twin of a wind material, for `mesh.customDepthMaterial`. */
export function windDepthMaterial(response: WindResponse, key: string): MeshDepthMaterial {
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depth.onBeforeCompile = (shader) => install(shader, response);
  depth.customProgramCacheKey = () => `wind-depth-${key}`;
  return depth;
}

/** Advances the wind clock. Called once a frame; costs one uniform write. */
export function advanceWind(seconds: number): void {
  // A livelier wind than the first one (the player's order of 2026-10-05:
  // "vento de verdade", the wires and the trees moving faster).
  windUniforms.uWindTime.value = seconds * WIND_PACE;
}

/** How much faster than real time the wind's clock runs. */
const WIND_PACE = 1.6;

/**
 * Wires in the wind: a span swings sideways downwind and bobs a little,
 * most at mid-span and not at all at the insulators, each span at its own
 * phase, under the same travelling gust as the trees. `aSwing` is the weight
 * along the span (4 t (1 - t)), `aPhase` the span's phase.
 */
export function applyWireWind(material: Material, amplitude: number): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms, { uWireAmp: { value: amplitude } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uWindTime;
        uniform vec2 uWindDir;
        uniform float uWindStrength;
        uniform float uWireAmp;
        attribute float aSwing;
        attribute float aPhase;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float front = dot(transformed.xz, uWindDir) * ${perM(0.03).toFixed(6)} - uWindTime * 0.42;
        float gust = 0.45 + 0.55 * smoothstep(-0.6, 1.0, sin(front) + 0.35 * sin(front * 2.3 + 1.7));
        float swing = sin(uWindTime * 1.9 + aPhase) + 0.35 * sin(uWindTime * 3.7 + aPhase * 2.3);
        transformed.xz += uWindDir * (0.55 + 0.45 * swing) * gust * aSwing * uWireAmp * uWindStrength;
        transformed.y += 0.25 * cos(uWindTime * 1.9 + aPhase) * gust * aSwing * uWireAmp * uWindStrength;`);
  };
  material.customProgramCacheKey = () => 'wire-wind';
}

/**
 * A stiff structure in the wind - a signal post, its arm and heads: it barely
 * moves, a few centimetres at the top in a gust, bending from the foot
 * (displacement with the square of height, as a cantilever). For instanced
 * parts whose instance origin stands `originHeight` above the ground; `tall`
 * is the structure's height and `amplitude` the sway at that height.
 */
export function applyStructureSway(material: Material, originHeight: number, tall: number, amplitude: number, key: string): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, windUniforms, {
      uSwayOrigin: { value: originHeight }, uSwayTall: { value: tall }, uSwayAmp: { value: amplitude },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uWindTime;
        uniform vec2 uWindDir;
        uniform float uWindStrength;
        uniform float uSwayOrigin;
        uniform float uSwayTall;
        uniform float uSwayAmp;`)
      .replace('#include <project_vertex>', ShaderChunk.project_vertex.replace(
        'mvPosition = modelViewMatrix * mvPosition;',
        `#ifdef USE_INSTANCING
           float swayGround = instanceMatrix[3].y - uSwayOrigin;
           float swayH = clamp((mvPosition.y - swayGround) / uSwayTall, 0.0, 1.4);
           vec2 swayRoot = instanceMatrix[3].xz;
           float swayFront = dot(swayRoot, uWindDir) * ${perM(0.03).toFixed(6)} - uWindTime * 0.42;
           float swayGust = 0.45 + 0.55 * smoothstep(-0.6, 1.0, sin(swayFront));
           float swayPhase = dot(floor(swayRoot / ${m(1.6).toFixed(6)}), vec2(1.7, 2.3));
           float swayK = uSwayAmp * swayH * swayH * swayGust * (0.55 + 0.45 * sin(uWindTime * 2.3 + swayPhase)) * uWindStrength;
           mvPosition.xz += uWindDir * swayK;
         #endif
         mvPosition = modelViewMatrix * mvPosition;`,
      ));
  };
  material.customProgramCacheKey = () => `sway-${key}`;
}
