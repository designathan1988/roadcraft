import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RGBAFormat,
  UnsignedByteType,
  type Material,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';

/**
 * Wear: streets and footways that age with use (the player's order of
 * 2026-10-05). Every vehicle drawn lays rubber along its two wheel tracks,
 * every walker scuffs the paving under their feet; where a lane is used hard
 * enough the surface breaks into potholes. The marks accumulate in a map-wide
 * field (R: wheels, G: feet), uploaded every few seconds as a texture that the
 * asphalt and footway shaders read by world position. Nothing is stored in
 * the document: a city wears as it is lived in.
 */

/** Texels across the map: about 0.94 m each on the 4 800-unit map. */
const RES = 2048;
/** Seconds between uploads of the field to the GPU. */
const UPLOAD_EVERY = 2;

export interface WearField {
  readonly texture: Texture;
  /** A vehicle at (x, y) heading `angle`, `width` across its wheels, for `dt` seconds. */
  wheels(x: number, y: number, angle: number, width: number, dt: number): void;
  /** A walker at (x, y), for `dt` seconds. */
  feet(x: number, y: number, dt: number): void;
  /** Uploads the field when it is due. */
  tick(dt: number): void;
  dispose(): void;
}

export function createWearField(mapSize: number): WearField {
  const half = mapSize / 2;
  const cell = mapSize / RES;
  const wheels = new Float32Array(RES * RES);
  const feet = new Float32Array(RES * RES);
  // RGBA though only red (wheels) and green (feet) are read: three uploads
  // part of a texture (`updateRanges`) only for RGBA, and re-sending the whole
  // 2048-square field every two seconds was a hitch of its own.
  const bytes = new Uint8Array(RES * RES * 4);
  const texture = new DataTexture(bytes, RES, RES, RGBAFormat, UnsignedByteType);
  /** Per row, the first and last cell changed since the last upload. */
  const rowFrom = new Int32Array(RES).fill(RES);
  const rowTo = new Int32Array(RES).fill(-1);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  let since = 0;
  let dirty = false;
  const add = (field: Float32Array, x: number, y: number, amount: number): void => {
    const gx = Math.floor((x + half) / cell), gy = Math.floor((y + half) / cell);
    if (gx < 0 || gy < 0 || gx >= RES || gy >= RES) return;
    const i = gy * RES + gx;
    field[i] = Math.min(1, field[i]! + amount);
    if (gx < rowFrom[gy]!) rowFrom[gy] = gx;
    if (gx > rowTo[gy]!) rowTo[gy] = gx;
    dirty = true;
  };
  return {
    texture,
    wheels(x, y, angle, width, dt) {
      // Rubber on the two tracks: a busy lane darkens in a few minutes of
      // traffic, and keeps darkening towards potholes.
      const nx = -Math.sin(angle), ny = Math.cos(angle);
      const k = dt * 0.05;
      add(wheels, x + nx * width / 2, y + ny * width / 2, k);
      add(wheels, x - nx * width / 2, y - ny * width / 2, k);
    },
    feet(x, y, dt) {
      add(feet, x, y, dt * 0.02);
    },
    tick(dt) {
      since += dt;
      if (!dirty || since < UPLOAD_EVERY) return;
      since = 0;
      dirty = false;
      // Only the stretches of rows that changed: converted and sent alone.
      for (let gy = 0; gy < RES; gy++) {
        const from = rowFrom[gy]!, to = rowTo[gy]!;
        if (to < 0) continue;
        for (let gx = from; gx <= to; gx++) {
          const i = gy * RES + gx;
          bytes[i * 4] = Math.round(wheels[i]! * 255);
          bytes[i * 4 + 1] = Math.round(feet[i]! * 255);
        }
        texture.addUpdateRange((gy * RES + from) * 4, (to - from + 1) * 4);
        rowFrom[gy] = RES;
        rowTo[gy] = -1;
      }
      texture.needsUpdate = true;
    },
    dispose() {
      texture.dispose();
    },
  };
}

/**
 * Makes a road surface material show the wear field: `channel` 0 reads the
 * wheels (asphalt: tyre marks, then potholes), 1 the feet (paving: scuffs and
 * stains). Chained after whatever the material already does to its shader.
 */
export function applyWear(material: Material, field: WearField, mapSize: number, channel: 0 | 1, key: string): void {
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, { uWear: { value: field.texture }, uWearHalf: { value: mapSize / 2 }, uWearSize: { value: mapSize } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWearWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWearWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWearWorld;
        uniform sampler2D uWear;
        uniform float uWearHalf;
        uniform float uWearSize;
        float wearHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float wearNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(wearHash(i), wearHash(i + vec2(1.0, 0.0)), f.x), mix(wearHash(i + vec2(0.0, 1.0)), wearHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 wearUv = vec2((vWearWorld.x + uWearHalf) / uWearSize, (uWearHalf - vWearWorld.z) / uWearSize);
          float wear = texture2D(uWear, wearUv)[${channel}];
          ${channel === 0 ? `
          // Tyre rubber darkens the tracks; hard-used, the surface breaks up.
          diffuseColor.rgb *= 1.0 - 0.38 * smoothstep(0.0, 0.8, wear);
          float holes = smoothstep(0.55, 1.0, wear) * smoothstep(0.62, 0.8, wearNoise(vWearWorld.xz * 0.45));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.06, 0.065), holes * 0.9);
          float cracks = smoothstep(0.3, 0.9, wear) * smoothstep(0.47, 0.5, abs(wearNoise(vWearWorld.xz * 1.7) - 0.5) * -1.0 + 0.5);
          diffuseColor.rgb *= 1.0 - 0.3 * cracks;` : `
          // Feet scuff and stain the paving where people walk most.
          float stain = smoothstep(0.0, 0.9, wear) * (0.6 + 0.4 * wearNoise(vWearWorld.xz * 0.8));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.62, 0.6, 0.55), stain);`}
        }`);
  };
  material.customProgramCacheKey = () => `${previousKey()}-wear-${key}`;
}
