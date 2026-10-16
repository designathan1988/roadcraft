import {
  DataTexture,
  LinearFilter,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  type Material,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { m } from '@world/units';
import { TorusWindow } from './torusWindow';

/** Wear: streets and footways that age with use (the player's order of 2026-10-05). */

/** Texels across the window round the view: 5 m each over its 10,240 m (the old map's, so the same wear where it was). */
const RES = 2048;
const CELL = m(5);
/** How far the view goes from the window's middle before it follows (texels): an eighth of it, the texels that leave cleared. */
const HOLD = RES / 8;
/** Seconds between uploads of the field to the GPU. */
const UPLOAD_EVERY = 2;

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
export function createWearField(): WearField {
  const view = new TorusWindow(RES, CELL);
  const wheels = new Float32Array(RES * RES);
  const feet = new Float32Array(RES * RES);
  // RGBA though only red (wheels) and green (feet) are read: three uploads part of a texture
  const bytes = new Uint8Array(RES * RES * 4);
  const texture = new DataTexture(bytes, RES, RES, RGBAFormat, UnsignedByteType);
  /** Per row, the first and last cell changed since the last upload. */
  const rowFrom = new Int32Array(RES).fill(RES);
  const rowTo = new Int32Array(RES).fill(-1);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  const frame = { value: new Vector3(view.ox * CELL, view.oy * CELL, view.span) };
  let since = 0;
  let dirty = false;
  const touch = (row: number, from: number, to: number): void => {
    if (from < rowFrom[row]!) rowFrom[row] = from;
    if (to > rowTo[row]!) rowTo[row] = to;
    dirty = true;
  };
  const add = (field: Float32Array, x: number, y: number, amount: number): void => {
    const i = view.indexAt(x, y);
    if (i < 0) return;
    field[i] = Math.min(1, field[i]! + amount);
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
      add(wheels, x + nx * width / 2, y + ny * width / 2, k);
      add(wheels, x - nx * width / 2, y - ny * width / 2, k);
    },
    feet(x, y, dt) {
      add(feet, x, y, dt * 0.02);
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
          const row = view.texel(gy) * RES;
          if (wraps) { wheels.fill(0, row + c0, row + RES); feet.fill(0, row + c0, row + RES); wheels.fill(0, row, row + c1 + 1); feet.fill(0, row, row + c1 + 1); }
          else { wheels.fill(0, row + c0, row + c1 + 1); feet.fill(0, row + c0, row + c1 + 1); }
          touch(row / RES, wraps ? 0 : c0, wraps ? RES - 1 : c1);
        }
      }
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
