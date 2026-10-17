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

import type { CameraSolids, Rect, SolidVisit } from '@world/buildings/cameraSolids';
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
/** The window's corner moves in steps of this many cells: what a step brings in is a strip, laid in the frame it comes in. */
const SNAP = 32;
/** The field is a torus: world cell (i, j) is texel (i & MASK, j & MASK), so a window moved keeps every cell it still holds. */
const MASK = SIDE - 1;
/** Past this many rows written, the whole field goes up in one call (three sends one call a row of ranges). */
const WHOLE_ROWS = SIDE / 8;

export interface CanyonLight {
  readonly pass: ShaderPass;
  /** @rebuild The view's centre (map x, y), the town's solids, and where they changed since the last call */
  follow(cx: number, cy: number, solids: (() => CameraSolids) | null, changed: readonly (readonly [number, number, number, number])[] | null): void;
  /** The ambient occlusion multiplied into the picture first (GTAO's denoised target, its blend intensity), or none. */
  setOcclusion(texture: Texture | null, intensity: number): void;
  /** The sun's direction (world, to the sun) and its share of the light on the ground. */
  setSun(direction: Vector3, directShare: number): void;
  dispose(): void;
}

const FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tAO;
  uniform float uAO;
  uniform float uAOOn;
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
  uniform sampler2DShadow tSunShadow[2];
  uniform mat4 uSunShadowMatrix[2];
  uniform float uSunShadowOn;
  uniform vec2 uSunShadowBias[2];
  varying vec2 vUv;
  ${DEPTH_GLSL}

  vec3 worldAt(vec2 uv, float depth) {
    vec4 v = uProjectionInverse * vec4(uv * 2.0 - 1.0, depthToClipZ(depth), 1.0);
    return (uCameraWorld * vec4(v.xyz / v.w, 1.0)).xyz;
  }
  float heightAt(vec2 p) {
    vec2 c = (p - uWindow.xy) / uWindow.z;
    if (c.x < 0.0 || c.y < 0.0 || c.x >= uWindow.w || c.y >= uWindow.w) return -1e4;
    // The field wraps (canyonLight.ts MASK): a world cell's texel is its index modulo the side.
    vec4 t = texelFetch(uHeights, ivec2(mod(floor(p / uWindow.z), uWindow.w)), 0);
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
  // Where the sun's cascade k holds P, its coordinate (w = 1); else w = 0.
  vec4 sunCoord(int k, vec3 P, vec3 N, float grazing) {
    vec4 c = uSunShadowMatrix[k] * vec4(P + N * uSunShadowBias[k].y * (0.4 + 2.6 * grazing), 1.0);
    c.xyz /= c.w;
    if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0 || c.z < 0.0 || c.z > 1.0) return vec4(0.0);
    #ifdef USE_REVERSED_DEPTH_BUFFER
      c.z -= uSunShadowBias[k].x;
    #else
      c.z += uSunShadowBias[k].x;
    #endif
    return vec4(c.xyz, 1.0);
  }
  // The sun's two nearest cascades (sunCascades.ts): the contact shadows reach no farther than they do.
  float sunReaches(vec3 P, vec3 N) {
    if (uSunShadowOn < 0.5) return 1.0;
    float grazing = 1.0 - clamp(dot(N, uSunDir), 0.0, 1.0);
    vec4 c = sunCoord(0, P, N, grazing);
    if (c.w > 0.5) return texture(tSunShadow[0], c.xyz);
    if (uSunShadowOn < 1.5) return 1.0;
    c = sunCoord(1, P, N, grazing);
    return c.w > 0.5 ? texture(tSunShadow[1], c.xyz) : 1.0;
  }

  void main() {
    vec4 src = texture2D(tDiffuse, vUv);
    // The occlusion as GTAO's own blend laid it (three's GTAOBlendShader: dst * mix(1, ao, intensity), alpha * ao.a).
    if (uAOOn > 0.5) {
      vec4 ao = texture2D(tAO, vUv);
      src *= vec4(mix(vec3(1.0), ao.rgb, uAO), ao.a);
    }
    float depth = texture2D(tDepth, vUv).r;
    if (depthIsBackground(depth)) { gl_FragColor = src; return; }
    vec3 P = worldAt(vUv, depth);
    vec2 p = vec2(P.x, -P.z);
    vec2 inWindow = (p - uWindow.xy) / (uWindow.z * uWindow.w);
    bool skyOn = uSky > 0.0 && inWindow.x > 0.0 && inWindow.y > 0.0 && inWindow.x < 1.0 && inWindow.y < 1.0;
    float far = distance(uCameraPos, P);
    // DO NOT rebuild the normal (eight depth taps) where neither the sky nor the contact shadow reads it: the picture as it came.
    if (!skyOn && !(uContact > 0.0 && far < 120.0)) { gl_FragColor = src; return; }
    vec3 N = normalAt(vUv, depth, P);
    if (dot(N, uCameraPos - P) < 0.0) N = -N;

    // The sky past the buildings round it.
    float vis = 1.0;
    if (skyOn) {
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
    if (uContact > 0.0 && dot(N, uSunDir) > 0.05 && far < 120.0) {
      for (int i = 1; i <= 8; i++) {
        float t = float(i) / 8.0 * uContactLength;
        vec3 Q = P + N * 0.04 + uSunDir * t;
        vec4 clip = uViewProjection * vec4(Q, 1.0);
        vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
        // DO NOT sample with implicit derivatives in a loop that breaks: D3D's compiler (ANGLE) unrolls and analyses all of it (9 s for this program, wprof7). The depth has no mips and is nearest: its level 0 is what texture2D read.
        vec3 S = worldAt(uv, textureLod(tDepth, uv, 0.0).r);
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

/** `sunsOf`: the sun's cascades, nearest first (`sunCascades.ts`); the two nearest are read. */
export function createCanyonLight(camera: Camera, depthOf: () => Texture | null, sunsOf: () => readonly DirectionalLight[] = () => []): CanyonLight {
  const data = new Uint8Array(SIDE * SIDE * 4);
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
      tAO: { value: null },
      uAO: { value: 0 },
      uAOOn: { value: 0 },
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
      tSunShadow: { value: [null, null] as (Texture | null)[] },
      uSunShadowMatrix: { value: [new Matrix4(), new Matrix4()] },
      uSunShadowOn: { value: 0 },
      uSunShadowBias: { value: [new Vector2(), new Vector2()] },
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
    // The sun's shadow maps as the scene was lit with them this frame, the nearest two cascades
    const lights = sunsOf();
    const maps = u['tSunShadow']!.value as (Texture | null)[];
    let on = 0;
    for (let k = 0; k < 2; k++) {
      const light = lights[k];
      const map = light && light.castShadow ? light.shadow.map?.depthTexture ?? null : null;
      // Both samplers bound to something: a missing second cascade reads the first's map, never used
      maps[k] = map ?? maps[0] ?? null;
      if (!light || !map || on !== k) continue;
      on = k + 1;
      (u['uSunShadowMatrix']!.value as Matrix4[])[k]!.copy(light.shadow.matrix);
      (u['uSunShadowBias']!.value as Vector2[])[k]!.set(light.shadow.bias, light.shadow.normalBias);
    }
    u['uSunShadowOn']!.value = on;
    draw(...args);
  };

  /** The window's corner, in cells (null: nothing laid yet). */
  let laid: { gx: number; gy: number } | null = null;
  /** The texel rows written since the last upload. */
  const rowDirty = new Uint8Array(SIDE);
  let dirtyRows = 0;
  const markRow = (row: number): void => {
    if (rowDirty[row]) return;
    rowDirty[row] = 1;
    dirtyRows++;
  };
  /** One volume laid into the window's cells it covers (by the cell's centre), the highest kept. */
  const layVolume: SolidVisit = (bx, by, c, s, lx0, ly0, lx1, ly1, top) => {
    const gx = laid!.gx, gy = laid!.gy;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // The box's four corners in the world, written out (no array a corner: hundreds of thousands a window).
    for (let corner = 0; corner < 4; corner++) {
      const lx = corner === 0 || corner === 3 ? lx0 : lx1, ly = corner < 2 ? ly0 : ly1;
      const wx = bx + lx * c - ly * s, wy = by + lx * s + ly * c;
      minX = Math.min(minX, wx); maxX = Math.max(maxX, wx); minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
    }
    const v = Math.max(1, Math.min(65535, Math.round((top + OFFSET) / STEP)));
    const i0 = Math.max(gx, Math.floor(minX / CELL)), i1 = Math.min(gx + SIDE - 1, Math.floor(maxX / CELL));
    const j0 = Math.max(gy, Math.floor(minY / CELL)), j1 = Math.min(gy + SIDE - 1, Math.floor(maxY / CELL));
    for (let j = j0; j <= j1; j++) {
      const row = j & MASK;
      for (let k = i0; k <= i1; k++) {
        // The cell's centre in the building's frame, inside the volume's box.
        const dx = (k + 0.5) * CELL - bx, dy = (j + 0.5) * CELL - by;
        const lx = dx * c + dy * s, ly = -dx * s + dy * c;
        if (lx < lx0 || lx > lx1 || ly < ly0 || ly > ly1) continue;
        const at = (row * SIDE + (k & MASK)) * 4;
        const was = data[at]! * 256 + data[at + 1]!;
        if (v > was) { data[at] = v >> 8; data[at + 1] = v & 255; markRow(row); }
      }
    }
  };
  /** The window's cells i0..i1, j0..j1 (world cells, clipped to the window) cleared; their world rectangle, or null when none is in the window. */
  const clearCells = (i0: number, j0: number, i1: number, j1: number): Rect | null => {
    const { gx, gy } = laid!;
    i0 = Math.max(i0, gx); i1 = Math.min(i1, gx + SIDE - 1);
    j0 = Math.max(j0, gy); j1 = Math.min(j1, gy + SIDE - 1);
    if (i0 > i1 || j0 > j1) return null;
    const from = i0 & MASK, count = i1 - i0 + 1;
    // A span that wraps round the torus is two runs of the row.
    const first = Math.min(count, SIDE - from);
    for (let j = j0; j <= j1; j++) {
      const row = j & MASK;
      data.fill(0, (row * SIDE + from) * 4, (row * SIDE + from + first) * 4);
      if (first < count) data.fill(0, row * SIDE * 4, (row * SIDE + count - first) * 4);
      markRow(row);
    }
    return [i0 * CELL, j0 * CELL, (i1 + 1) * CELL, (j1 + 1) * CELL];
  };
  /** The rows written go up: each a range, or the whole field past `WHOLE_ROWS`. */
  const upload = (): void => {
    if (dirtyRows === 0) return;
    if (dirtyRows > WHOLE_ROWS) heights.clearUpdateRanges();
    else for (let row = 0; row < SIDE; row++) if (rowDirty[row]) heights.addUpdateRange(row * SIDE * 4, SIDE * 4);
    heights.needsUpdate = true;
    rowDirty.fill(0);
    dirtyRows = 0;
  };

  return {
    pass,
    follow(cx, cy, solids, changed) {
      if (!solids) return;
      const gx = Math.floor((cx - WINDOW / 2) / CELL / SNAP) * SNAP, gy = Math.floor((cy - WINDOW / 2) / CELL / SNAP) * SNAP;
      if (!laid || changed === null || Math.abs(gx - laid.gx) >= SIDE || Math.abs(gy - laid.gy) >= SIDE) {
        // @rebuild The whole window: at the first call, a jump past it, or a change the diary cannot place.
        laid = { gx, gy };
        window.set(gx * CELL, gy * CELL, CELL, SIDE);
        data.fill(0);
        solids().forEachIn(gx * CELL, gy * CELL, (gx + SIDE) * CELL, (gy + SIDE) * CELL, layVolume);
        heights.clearUpdateRanges();
        heights.needsUpdate = true;
        rowDirty.fill(0);
        dirtyRows = 0;
        return;
      }
      const rects: Rect[] = [];
      if (gx !== laid.gx || gy !== laid.gy) {
        // The strips the move brings in, cleared of what the cells a side away left there, then laid.
        const was = laid;
        laid = { gx, gy };
        window.set(gx * CELL, gy * CELL, CELL, SIDE);
        const columns = gx > was.gx ? clearCells(was.gx + SIDE, gy, gx + SIDE - 1, gy + SIDE - 1)
          : gx < was.gx ? clearCells(gx, gy, was.gx - 1, gy + SIDE - 1) : null;
        const rows = gy > was.gy ? clearCells(gx, was.gy + SIDE, gx + SIDE - 1, gy + SIDE - 1)
          : gy < was.gy ? clearCells(gx, gy, gx + SIDE - 1, was.gy - 1) : null;
        if (columns) rects.push(columns);
        if (rows) rects.push(rows);
      }
      // What changed in place: every rectangle cleared first, then what stands there now laid once for all of them.
      for (const rect of changed) {
        const cleared = clearCells(Math.floor(rect[0] / CELL), Math.floor(rect[1] / CELL), Math.floor(rect[2] / CELL), Math.floor(rect[3] / CELL));
        if (cleared) rects.push(cleared);
      }
      if (rects.length) solids().forEachInAny(rects, layVolume);
      upload();
    },
    setOcclusion(texture, intensity) {
      u['tAO']!.value = texture;
      u['uAO']!.value = intensity;
      u['uAOOn']!.value = texture ? 1 : 0;
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
