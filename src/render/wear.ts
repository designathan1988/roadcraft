import {
  DataTexture,
  LinearFilter,
  RepeatWrapping,
  RGFormat,
  UnsignedByteType,
  Vector3,
  type Material,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { m } from '@world/units';
import { TorusWindow } from './torusWindow';

/** Wear: streets and footways that age with use (the player's order of 2026-10-05). */

/** Texels across the window round the view: 5 m each over 10,240 m, the reach the wear had (DO NOT shrink it without the player's yes on shots: wear past it is let go). */
export const WEAR_RES = 2048;
const RES = WEAR_RES;
const CELL = m(5);
/** How far the view goes from the window's middle before it follows (texels): an eighth of it, the texels that leave cleared. */
const HOLD = RES / 8;
/** Seconds between uploads of the field to the GPU. */
const UPLOAD_EVERY = 2;
/** three r186 counts a data texture's update ranges in RGBA components whatever its format (`WebGLTextures.js` updateTexture, "only RGBA supported"): 4 a texel. */
export const RANGE_STRIDE = 4;

export interface WearField {
  readonly texture: Texture;
  /** The window's low corner (world x, y) and side, for the shader (`applyWear`). */
  readonly window: { readonly value: Vector3 };
  /** A vehicle at (x, y) heading `angle`, `width` across its wheels, for `dt` seconds. */
  wheels(x: number, y: number, angle: number, width: number, dt: number): void;
  /** A walker at (x, y), for `dt` seconds. */
  feet(x: number, y: number, dt: number): void;
  /** The window kept round where the view looks: wear is only kept near it (the traffic it shows is the micro window's). */
  follow(x: number, y: number): void;
  /** Uploads the field when it is due. */
  tick(dt: number): void;
  dispose(): void;
}

/** DO NOT hold a texture over a map: the world has none; the wear lives in a window that wraps round (`torusWindow.ts`) */
export function createWearField(seed = 0x9e3779b9): WearField {
  const view = new TorusWindow(RES, CELL);
  // DO NOT keep the field in floats beside its texture: RG8 (red the wheels, green the feet) is both the field and what the GPU reads.
  const bytes = new Uint8Array(RES * RES * 2);
  const texture = new DataTexture(bytes, RES, RES, RGFormat, UnsignedByteType);
  /** Per row, the first and last cell changed since the last upload. */
  const rowFrom = new Int32Array(RES).fill(RES);
  const rowTo = new Int32Array(RES).fill(-1);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const frame = { value: new Vector3(view.ox * CELL, view.oy * CELL, view.span) };
  let since = 0;
  let dirty = false;
  // Xorshift32 (Marsaglia, "Xorshift RNGs", J. Stat. Softw. 2003) for the stochastic rounding of `add`.
  let state = seed >>> 0 || 1;
  const random = (): number => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state / 4294967296;
  };
  const touch = (row: number, from: number, to: number): void => {
    if (from < rowFrom[row]!) rowFrom[row] = from;
    if (to > rowTo[row]!) rowTo[row] = to;
    dirty = true;
  };
  const add = (channel: 0 | 1, x: number, y: number, amount: number): void => {
    const i = view.indexAt(x, y);
    if (i < 0) return;
    // A frame's wear is a fraction of a byte's step: one step more with that fraction's chance, the sum keeping its mean (stochastic rounding, Gupta et al., ICML 2015).
    const q = amount * 255;
    const whole = Math.floor(q);
    const step = whole + (random() < q - whole ? 1 : 0);
    if (step <= 0) return;
    const k = i * 2 + channel;
    bytes[k] = Math.min(255, bytes[k]! + step);
    const gx = i % RES;
    touch((i - gx) / RES, gx, gx);
  };
  return {
    texture,
    window: frame,
    wheels(x, y, angle, width, dt) {
      // Rubber on the two tracks: a busy lane darkens in a few minutes of traffic, and keeps darkening towards potholes.
      const nx = -Math.sin(angle), ny = Math.cos(angle);
      const k = dt * 0.05;
      add(0, x + nx * width / 2, y + ny * width / 2, k);
      add(0, x - nx * width / 2, y - ny * width / 2, k);
    },
    feet(x, y, dt) {
      add(1, x, y, dt * 0.02);
    },
    follow(x, y) {
      const bands = view.follow(x, y, HOLD);
      if (!bands) return;
      frame.value.set(view.ox * CELL, view.oy * CELL, view.span);
      // The texels that came in held the place that left: cleared, and sent with the next upload.
      for (const [gx0, gx1, gy0, gy1] of bands) {
        const c0 = view.texel(gx0), c1 = view.texel(gx1);
        const wraps = c0 > c1;
        for (let gy = gy0; gy <= gy1; gy++) {
          const row = view.texel(gy);
          const at = row * RES * 2;
          if (wraps) { bytes.fill(0, at + c0 * 2, at + RES * 2); bytes.fill(0, at, at + (c1 + 1) * 2); }
          else bytes.fill(0, at + c0 * 2, at + (c1 + 1) * 2);
          touch(row, wraps ? 0 : c0, wraps ? RES - 1 : c1);
        }
      }
    },
    tick(dt) {
      since += dt;
      if (!dirty || since < UPLOAD_EVERY) return;
      since = 0;
      dirty = false;
      // Only the stretches of rows that changed, sent from the field itself.
      for (let gy = 0; gy < RES; gy++) {
        const from = rowFrom[gy]!, to = rowTo[gy]!;
        if (to < 0) continue;
        texture.addUpdateRange((gy * RES + from) * RANGE_STRIDE, (to - from + 1) * RANGE_STRIDE);
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

/** Makes a road surface material show the wear field: `channel` 0 reads the wheels */
export function applyWear(material: Material, field: WearField, channel: 0 | 1, key: string): void {
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, { uWear: { value: field.texture }, uWearWindow: field.window });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWearWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWearWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWearWorld;
        uniform sampler2D uWear;
        uniform vec3 uWearWindow; // low corner x, y and side, world
        float wearHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float wearNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(wearHash(i), wearHash(i + vec2(1.0, 0.0)), f.x), mix(wearHash(i + vec2(0.0, 1.0)), wearHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // World (x, y) over the window's side: the texture repeats, the window's texels where it wraps (\`torusWindow.ts\`); none off it.
          vec2 wearAt = vec2(vWearWorld.x, -vWearWorld.z);
          vec2 wearLocal = (wearAt - uWearWindow.xy) / uWearWindow.z;
          float wearOn = step(0.0, wearLocal.x) * step(wearLocal.x, 1.0) * step(0.0, wearLocal.y) * step(wearLocal.y, 1.0);
          float wear = texture2D(uWear, wearAt / uWearWindow.z)[${channel}] * wearOn;
          ${channel === 0 ? `
          // Tyre rubber darkens the tracks; hard-used, the surface breaks up.
          diffuseColor.rgb *= 1.0 - 0.38 * smoothstep(0.0, 0.8, wear);
          // DO NOT work the noise out under each term's threshold: its smoothstep is 0 there, the term multiplied by 0 (8 sines a pixel of every road, VIA-09).
          if (wear > 0.55) {
            float holes = smoothstep(0.55, 1.0, wear) * smoothstep(0.62, 0.8, wearNoise(vWearWorld.xz * 0.45));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.06, 0.065), holes * 0.9);
          }
          if (wear > 0.3) {
            float cracks = smoothstep(0.3, 0.9, wear) * smoothstep(0.47, 0.5, abs(wearNoise(vWearWorld.xz * 1.7) - 0.5) * -1.0 + 0.5);
            diffuseColor.rgb *= 1.0 - 0.3 * cracks;
          }` : `
          // Feet scuff and stain the paving where people walk most.
          // None where nobody walked: its smoothstep is 0 there (VIA-09).
          if (wear > 0.0) {
            float stain = smoothstep(0.0, 0.9, wear) * (0.6 + 0.4 * wearNoise(vWearWorld.xz * 0.8));
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.62, 0.6, 0.55), stain);
          }`}
        }`);
  };
  material.customProgramCacheKey = () => `${previousKey()}-wear-${key}`;
}
