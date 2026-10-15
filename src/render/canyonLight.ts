import {
  DataTexture,
  Matrix4,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  type Camera,
  type Texture,
  UnsignedByteType,
  Vector3,
  Vector4,
} from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

import type { CameraSolids } from '@world/buildings/cameraSolids';
import { m } from '@world/units';
import { DEPTH_GLSL } from './depthConvention';

/**
 * THE LIGHT A TOWN SHUTS OUT, at two scales the shadow map and the small
 * ambient occlusion pass miss (the player, 2026-10-13: a street between
 * buildings lit like an open field; no shadow in the window reveals, under
 * the cornices and sills, the pilasters casting nothing):
 *
 * - The sky a point sees past the buildings round it - a street canyon's
 *   floor, the foot of its walls, a courtyard - from a field of the
 *   buildings' heights round the view: in eight directions the highest
 *   horizon the roofs make, and the cosine-weighted visibility of each pair
 *   of opposite horizons, (cos² e1 + cos² e2) / 2 (Jimenez et al., "Practical
 *   Realtime Strategies for Accurate Indirect Occlusion", 2016, eq. 7 with
 *   the integration axis on the normal; exact for a height field, which a
 *   town of blocks is), and their multi-bounce fit; on a wall, only the
 *   directions it faces. A point with something just over it (a canopy
 *   stamped into the field) loses most of its sky.
 * - The sun's contact shadows: from each pixel a short ray marched towards
 *   the sun through the depth buffer, a fixed number of steps over a short
 *   length (Unreal's Contact Shadows), so a sill, a cornice, a pilaster, a
 *   reveal or an awning shades what lies just behind it, where the shadow
 *   map's texel and its bias are too coarse.
 *
 * The field is a window of `WINDOW` metres round the view's centre in cells
 * of `CELL`, laid whole only when the centre has moved a quarter of it or the
 * diary cannot say what changed - a few hundred volumes a frame, never the
 * whole map - and uploaded once laid (1 MB). A change of the buildings or of
 * the ground under them clears and lays again only its own rectangles, and
 * only their rows go to the GPU. DO NOT lay the window again at every
 * building: in a growing town the key moved before the window was laid, it
 * started over, and the field was never put in place.
 */

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
  /**
   * The view's centre (map x, y), the town's solids, and where they changed
   * since the last call (the buildings' and the ground's rectangles from the
   * diary; null: anywhere, the window laid whole; empty: nothing).
   * @rebuild A few hundred volumes a frame while a new window is laid; a change's own rectangles otherwise.
   */
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

  void main() {
    vec4 src = texture2D(tDiffuse, vUv);
    float depth = texture2D(tDepth, vUv).r;
    if (depthIsBackground(depth)) { gl_FragColor = src; return; }
    vec3 P = worldAt(vUv, depth);
    vec3 N = normalize(cross(dFdx(P), dFdy(P)));
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
        // Fixed directions and steps: drawn at random per pixel with no filter
        // after them (three's GTAO denoises its random taps), the town was
        // grained all over (the player, 2026-10-13: "ficou tudo com noise").
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
      shade *= 1.0 - smoothstep(70.0, 120.0, far);
    }

    gl_FragColor = vec4(src.rgb * mix(1.0, vis, uSky) * (1.0 - shade * uContact), src.a);
  }
`
  .replace('m_lift_lo', m(0.4).toFixed(2))
  .replace('m_lift_hi', m(1.5).toFixed(2));

export function createCanyonLight(camera: Camera, depthOf: () => Texture | null): CanyonLight {
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
    draw(...args);
  };

  /**
   * The window being laid, and where: volumes still to lay (bx, by, cos, sin,
   * x0, y0, x1, y1, top a volume), and the changes that came meanwhile, laid
   * again over it once it is whole.
   */
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
  /**
   * The cells of `rect` cleared in `target` and laid again from what stands
   * there now (a volume reaching out of the rectangle lays its own height,
   * the same as before, outside it). The rows it spans, or null off the window.
   */
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
      // The sky's share of the light is what the canyon takes; the sun's
      // contact shadows are as strong as the sun is.
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
