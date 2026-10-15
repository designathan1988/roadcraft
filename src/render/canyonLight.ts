import {
  DataTexture,
  Matrix4,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  type Camera,
  type DirectionalLight,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

import type { CameraSolids } from '@world/buildings/cameraSolids';
import { m } from '@world/units';
import { DEPTH_GLSL } from './depthConvention';

/** DO NOT lay the window again at every building */

/** The field's side, world units, and its cell. */
const WINDOW = m(2048);
const CELL = m(4);
const SIDE = Math.round(WINDOW / CELL);
/** Heights stored in 16 bits: (h + OFFSET) / STEP. */
const STEP = m(0.05);
const OFFSET = m(100);
/** Volumes laid into the field a frame. */
const VOLUMES_PER_FRAME = 400;

export interface CanyonLight {
  readonly pass: ShaderPass;
  /** @rebuild The view's centre (map x, y), the town's solids, and where they changed since the last call */
  follow(cx: number, cy: number, solids: (() => CameraSolids) | null, changed: readonly (readonly [number, number, number, number])[] | null): void;
  /** The sun's direction (world, to the sun) and its share of the light on the ground. */
  setSun(direction: Vector3, directShare: number): void;
  dispose(): void;
}

const FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform sampler2D uHeights;
  uniform mat4 uProjectionInverse;
  uniform mat4 uCameraWorld;
  uniform mat4 uViewProjection;
  uniform vec3 uCameraPos;
  uniform vec4 uWindow;
  uniform vec3 uSunDir;
  uniform float uSky;
  uniform float uContact;
  uniform float uContactLength;
  uniform sampler2DShadow tSunShadow;
  uniform mat4 uSunShadowMatrix;
  uniform float uSunShadowOn;
  uniform vec2 uSunShadowBias;
  varying vec2 vUv;
  ${DEPTH_GLSL}

  vec3 worldAt(vec2 uv, float depth) {
    vec4 v = uProjectionInverse * vec4(uv * 2.0 - 1.0, depthToClipZ(depth), 1.0);
    return (uCameraWorld * vec4(v.xyz / v.w, 1.0)).xyz;
  }
  float heightAt(vec2 p) {
    vec2 c = (p - uWindow.xy) / uWindow.z;
    if (c.x < 0.0 || c.y < 0.0 || c.x >= uWindow.w || c.y >= uWindow.w) return -1e4;
    vec4 t = texelFetch(uHeights, ivec2(c), 0);
    float v = t.r * 65280.0 + t.g * 255.0;
    return v < 0.5 ? -1e4 : v * ${STEP.toFixed(4)} - ${OFFSET.toFixed(1)};
  }
  float depthTap(ivec2 p, ivec2 hi) {
    return texelFetch(tDepth, clamp(p, ivec2(0), hi), 0).r;
  }
  // DO NOT take dFdx/dFdy of the position: they are differences over a 2x2 block of pixels, and a block straddling an edge
  vec3 normalAt(vec2 uv, float c0, vec3 C) {
    ivec2 size = textureSize(tDepth, 0);
    ivec2 hi = size - 1;
    ivec2 p = ivec2(uv * vec2(size));
    vec2 texel = 1.0 / vec2(size);
    float l1 = depthTap(p - ivec2(1, 0), hi), l2 = depthTap(p - ivec2(2, 0), hi);
    float r1 = depthTap(p + ivec2(1, 0), hi), r2 = depthTap(p + ivec2(2, 0), hi);
    float b1 = depthTap(p - ivec2(0, 1), hi), b2 = depthTap(p - ivec2(0, 2), hi);
    float t1 = depthTap(p + ivec2(0, 1), hi), t2 = depthTap(p + ivec2(0, 2), hi);
    vec3 dx = abs(2.0 * l1 - l2 - c0) < abs(2.0 * r1 - r2 - c0)
      ? C - worldAt(uv - vec2(texel.x, 0.0), l1)
      : worldAt(uv + vec2(texel.x, 0.0), r1) - C;
    vec3 dy = abs(2.0 * b1 - b2 - c0) < abs(2.0 * t1 - t2 - c0)
      ? C - worldAt(uv - vec2(0.0, texel.y), b1)
      : worldAt(uv + vec2(0.0, texel.y), t1) - C;
    return normalize(cross(dx, dy));
  }

  // DO NOT darken what the shadow map has already shaded
  float sunReaches(vec3 P, vec3 N) {
    if (uSunShadowOn < 0.5) return 1.0;
    float grazing = 1.0 - clamp(dot(N, uSunDir), 0.0, 1.0);
    vec4 c = uSunShadowMatrix * vec4(P + N * uSunShadowBias.y * (0.4 + 2.6 * grazing), 1.0);
    c.xyz /= c.w;
    if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0 || c.z < 0.0 || c.z > 1.0) return 1.0;
    #ifdef USE_REVERSED_DEPTH_BUFFER
      c.z -= uSunShadowBias.x;
    #else
      c.z += uSunShadowBias.x;
    #endif
    return texture(tSunShadow, c.xyz);
  }

  void main() {
    vec4 src = texture2D(tDiffuse, vUv);
    float depth = texture2D(tDepth, vUv).r;
    if (depthIsBackground(depth)) { gl_FragColor = src; return; }
    vec3 P = worldAt(vUv, depth);
    vec3 N = normalAt(vUv, depth, P);
    if (dot(N, uCameraPos - P) < 0.0) N = -N;

    // The sky past the buildings round it.
    float vis = 1.0;
    vec2 p = vec2(P.x, -P.z);
    vec2 inWindow = (p - uWindow.xy) / (uWindow.z * uWindow.w);
    if (uSky > 0.0 && inWindow.x > 0.0 && inWindow.y > 0.0 && inWindow.x < 1.0 && inWindow.y < 1.0) {
      vec2 facing = vec2(N.x, -N.z);
      bool wall = abs(N.y) < 0.6;
      if (wall) facing = normalize(facing);
      float sum = 0.0, count = 0.0;
      for (int k = 0; k < 8; k++) {
        // Fixed directions and steps: drawn at random per pixel with no filter after them
        float a = (float(k) + 0.5) * 0.7853982;
        vec2 d = vec2(cos(a), sin(a));
        if (wall && dot(d, facing) < 0.15) continue;
        float rise = 0.0;
        for (int s = 0; s < 3; s++) {
          float r = ${CELL.toFixed(1)} * (0.9 + float(s * s) * 2.4);
          rise = max(rise, (heightAt(p + d * r) - P.y) / r);
        }
        sum += 1.0 / (1.0 + rise * rise);
        count += 1.0;
      }
      vis = count > 0.0 ? sum / count : 1.0;
      if (!wall) vis *= mix(1.0, 0.35, smoothstep(m_lift_lo, m_lift_hi, heightAt(p) - P.y));
      // Light bounced between the walls gives some back (Jimenez et al.'s fit, albedo 0.5).
      vis = max(vis, ((vis * 0.6878 - 1.7559) * vis + 2.0679) * vis);
    }

    // The sun's contact shadows.
    float shade = 0.0;
    float far = distance(uCameraPos, P);
    if (uContact > 0.0 && dot(N, uSunDir) > 0.05 && far < 120.0) {
      for (int i = 1; i <= 8; i++) {
        float t = float(i) / 8.0 * uContactLength;
        vec3 Q = P + N * 0.04 + uSunDir * t;
        vec4 clip = uViewProjection * vec4(Q, 1.0);
        vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
        vec3 S = worldAt(uv, texture2D(tDepth, uv).r);
        float dQ = distance(uCameraPos, Q), dS = distance(uCameraPos, S);
        if (dS < dQ - 0.03 && dQ - dS < 0.8) { shade = 1.0; break; }
      }
      shade *= (1.0 - smoothstep(70.0, 120.0, far)) * sunReaches(P, N);
    }

    gl_FragColor = vec4(src.rgb * mix(1.0, vis, uSky) * (1.0 - shade * uContact), src.a);
  }
`
  .replace('m_lift_lo', m(0.4).toFixed(2))
  .replace('m_lift_hi', m(1.5).toFixed(2));

export function createCanyonLight(camera: Camera, depthOf: () => Texture | null, sunOf: () => DirectionalLight | null = () => null): CanyonLight {
  const data = new Uint8Array(SIDE * SIDE * 4);
  const next = new Uint8Array(SIDE * SIDE * 4);
  const heights = new DataTexture(data, SIDE, SIDE, RGBAFormat, UnsignedByteType);
  heights.magFilter = NearestFilter;
  heights.minFilter = NearestFilter;
  heights.generateMipmaps = false;
  heights.needsUpdate = true;
  const window = new Vector4(0, 0, CELL, SIDE);
  const sun = new Vector3(0, 1, 0);
  const material = new ShaderMaterial({
    name: 'canyon-light',
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uHeights: { value: heights },
      uProjectionInverse: { value: new Matrix4() },
      uCameraWorld: { value: new Matrix4() },
      uViewProjection: { value: new Matrix4() },
      uCameraPos: { value: new Vector3() },
      uWindow: { value: window },
      uSunDir: { value: sun },
      uSky: { value: 0.8 },
      uContact: { value: 0.5 },
      uContactLength: { value: m(1.2) },
      tSunShadow: { value: null as Texture | null },
      uSunShadowMatrix: { value: new Matrix4() },
      uSunShadowOn: { value: 0 },
      uSunShadowBias: { value: new Vector2() },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: FRAGMENT,
  });
  const pass = new ShaderPass(material);
  const u = material.uniforms;
  const draw = pass.render.bind(pass);
  pass.render = (...args: Parameters<ShaderPass['render']>) => {
    u['tDepth']!.value = depthOf();
    (u['uProjectionInverse']!.value as Matrix4).copy(camera.projectionMatrixInverse);
    (u['uCameraWorld']!.value as Matrix4).copy(camera.matrixWorld);
    (u['uViewProjection']!.value as Matrix4).multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    (u['uCameraPos']!.value as Vector3).setFromMatrixPosition(camera.matrixWorld);
    // The sun's shadow map as the scene was lit with it this frame.
    const light = sunOf();
    const map = light && light.castShadow ? light.shadow.map?.depthTexture ?? null : null;
    u['tSunShadow']!.value = map;
    u['uSunShadowOn']!.value = map ? 1 : 0;
    if (light && map) {
      (u['uSunShadowMatrix']!.value as Matrix4).copy(light.shadow.matrix);
      (u['uSunShadowBias']!.value as Vector2).set(light.shadow.bias, light.shadow.normalBias);
    }
    draw(...args);
  };

  /** The window being laid, and where: volumes still to lay */
  let laid = { cx: Number.NaN, cy: Number.NaN, ox: 0, oy: 0 };
  let pending: { cx: number; cy: number; ox: number; oy: number; volumes: number[]; at: number; after: (readonly [number, number, number, number])[] } | null = null;

  const lay = (target: Uint8Array, volumes: readonly number[], from: number, to: number, ox: number, oy: number): void => {
    for (let i = from * 9; i < to * 9; i += 9) {
      const bx = volumes[i]!, by = volumes[i + 1]!, c = volumes[i + 2]!, s = volumes[i + 3]!;
      const lx0 = volumes[i + 4]!, ly0 = volumes[i + 5]!, lx1 = volumes[i + 6]!, ly1 = volumes[i + 7]!, top = volumes[i + 8]!;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      // The box's four corners in the world, written out (no array a corner: hundreds of thousands a window).
      for (let corner = 0; corner < 4; corner++) {
        const lx = corner === 0 || corner === 3 ? lx0 : lx1, ly = corner < 2 ? ly0 : ly1;
        const wx = bx + lx * c - ly * s, wy = by + lx * s + ly * c;
        minX = Math.min(minX, wx); maxX = Math.max(maxX, wx); minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
      }
      const v = Math.max(1, Math.min(65535, Math.round((top + OFFSET) / STEP)));
      const i0 = Math.max(0, Math.floor((minX - ox) / CELL)), i1 = Math.min(SIDE - 1, Math.floor((maxX - ox) / CELL));
      const j0 = Math.max(0, Math.floor((minY - oy) / CELL)), j1 = Math.min(SIDE - 1, Math.floor((maxY - oy) / CELL));
      for (let j = j0; j <= j1; j++) {
        for (let k = i0; k <= i1; k++) {
          // The cell's centre in the building's frame, inside the volume's box.
          const dx = ox + (k + 0.5) * CELL - bx, dy = oy + (j + 0.5) * CELL - by;
          const lx = dx * c + dy * s, ly = -dx * s + dy * c;
          if (lx < lx0 || lx > lx1 || ly < ly0 || ly > ly1) continue;
          const at = (j * SIDE + k) * 4;
          const was = target[at]! * 256 + target[at + 1]!;
          if (v > was) { target[at] = v >> 8; target[at + 1] = v & 255; }
        }
      }
    }
  };

  /** The volumes the solids hold in a box, as `lay` reads them. */
  const volumesIn = (solids: () => CameraSolids, x0: number, y0: number, x1: number, y1: number): number[] => {
    const volumes: number[] = [];
    solids().forEachIn(x0, y0, x1, y1, (bx, by, c, s, lx0, ly0, lx1, ly1, top) => { volumes.push(bx, by, c, s, lx0, ly0, lx1, ly1, top); });
    return volumes;
  };
  /** The cells of `rect` cleared in `target` and laid again from what stands there now */
  const relay = (target: Uint8Array, solids: () => CameraSolids, rect: readonly [number, number, number, number], ox: number, oy: number): [number, number] | null => {
    const i0 = Math.max(0, Math.floor((rect[0] - ox) / CELL)), i1 = Math.min(SIDE - 1, Math.floor((rect[2] - ox) / CELL));
    const j0 = Math.max(0, Math.floor((rect[1] - oy) / CELL)), j1 = Math.min(SIDE - 1, Math.floor((rect[3] - oy) / CELL));
    if (i0 > i1 || j0 > j1) return null;
    for (let j = j0; j <= j1; j++) target.fill(0, (j * SIDE + i0) * 4, (j * SIDE + i1 + 1) * 4);
    const volumes = volumesIn(solids, ox + i0 * CELL, oy + j0 * CELL, ox + (i1 + 1) * CELL, oy + (j1 + 1) * CELL);
    lay(target, volumes, 0, volumes.length / 9, ox, oy);
    return [j0, j1];
  };

  return {
    pass,
    follow(cx, cy, solids, changed) {
      if (!solids) return;
      const moved = !(Math.abs(cx - laid.cx) < WINDOW / 4 && Math.abs(cy - laid.cy) < WINDOW / 4);
      const away = !pending || Math.abs(cx - pending.cx) >= WINDOW / 4 || Math.abs(cy - pending.cy) >= WINDOW / 4;
      if ((moved && away) || changed === null) {
        const ox = Math.floor((cx - WINDOW / 2) / CELL) * CELL, oy = Math.floor((cy - WINDOW / 2) / CELL) * CELL;
        next.fill(0);
        pending = { cx, cy, ox, oy, volumes: volumesIn(solids, ox, oy, ox + WINDOW, oy + WINDOW), at: 0, after: [] };
      } else if (changed.length) {
        if (pending) pending.after.push(...changed);
        else {
          // In place, in the field drawn: its rows alone go up (three sends an update range as one row).
          let rows = 0;
          for (const rect of changed) {
            const span = relay(data, solids, rect, laid.ox, laid.oy);
            if (!span) continue;
            // A volume laid again may reach rows past the rectangle: there it wrote its own height, as before.
            for (let row = span[0]; row <= span[1]; row++) heights.addUpdateRange(row * SIDE * 4, SIDE * 4);
            rows++;
          }
          if (rows) heights.needsUpdate = true;
        }
      }
      if (!pending) return;
      const total = pending.volumes.length / 9;
      const to = Math.min(total, pending.at + VOLUMES_PER_FRAME);
      lay(next, pending.volumes, pending.at, to, pending.ox, pending.oy);
      pending.at = to;
      if (to < total) return;
      // What changed while it was laid, over it.
      for (const rect of pending.after) relay(next, solids, rect, pending.ox, pending.oy);
      data.set(next);
      heights.clearUpdateRanges();
      heights.needsUpdate = true;
      window.set(pending.ox, pending.oy, CELL, SIDE);
      laid = { cx: pending.cx, cy: pending.cy, ox: pending.ox, oy: pending.oy };
      pending = null;
    },
    setSun(direction, directShare) {
      sun.copy(direction).normalize();
      // The sky's share of the light is what the canyon takes; the sun's contact shadows are as strong as the sun is.
      u['uSky']!.value = 0.85 - 0.35 * directShare;
      u['uContact']!.value = 0.55 * directShare * Math.min(1, Math.max(0, direction.y * 4));
    },
    dispose() {
      heights.dispose();
      material.dispose();
      pass.dispose();
    },
  };
}
