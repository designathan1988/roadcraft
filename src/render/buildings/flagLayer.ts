import {
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { FLAG_PATTERNS, type FlagDesign } from '@world/buildings/flags';
import { windUniforms } from '../wind';

/**
 * Every flag in the city, one instanced draw: a cloth that waves in the wind.
 *
 * The cloth is a plane cut 24 x 12, hoist at local x = 0, top at y = 0. The
 * vertex shader lays a travelling wave along it - none at the mast, growing to
 * the fly - on the same clock and wind direction as the trees (`wind.ts`), so a
 * flag and the crowns beside it move together. The design is drawn in the
 * fragment shader from a pattern number and three colours per instance: any
 * flag the player composes costs the same, and nothing is a texture.
 */

/** One flag, in three's frame (y up): the top of the hoist, and its size. */
export interface FlagInstance {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
  readonly design: FlagDesign;
}

export interface FlagLayer {
  readonly group: Group;
  set(flags: readonly FlagInstance[]): void;
  dispose(): void;
}

const GLSL_PATTERN = /* glsl */ `
  vec3 flagColour(vec2 uv, float p, vec3 c0, vec3 c1, vec3 c2) {
    float x = uv.x, y = 1.0 - uv.y; // x from the hoist, y from the top
    int k = int(p + 0.5);
    if (k == 1) return y < 0.5 ? c0 : c1;
    if (k == 2) return x < 0.5 ? c0 : c1;
    if (k == 3) return y < 0.333 ? c0 : (y < 0.667 ? c1 : c2);
    if (k == 4) return x < 0.333 ? c0 : (x < 0.667 ? c1 : c2);
    if (k == 5) return (abs(x - 0.5) < 0.09 || abs(y - 0.5) < 0.12) ? c1 : c0;
    if (k == 6) return (abs(x - 0.36) < 0.07 || abs(y - 0.5) < 0.1) ? c1 : c0;
    if (k == 7) return y < x ? c0 : c1;
    if (k == 8) return (abs(y - x) < 0.11 || abs(y - (1.0 - x)) < 0.11) ? c1 : c0;
    if (k == 9) return (x < 0.42 && y < 0.5) ? c1 : c0;
    if (k == 10) { if (x < 0.42 && y < 0.54) return c2; return mod(floor(y * 13.0), 2.0) < 1.0 ? c0 : c1; }
    if (k == 11) return (x < 0.1 || x > 0.9 || y < 0.15 || y > 0.85) ? c1 : c0;
    if (k == 12) return length((uv - 0.5) * vec2(1.5, 1.0)) < 0.3 ? c1 : c0;
    if (k == 13) return x < 0.5 * (1.0 - abs(y - 0.5) * 2.0) ? c1 : c0;
    return c0;
  }
`;

function material(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: DoubleSide });
  m.name = 'flag-cloth';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uWindTime;
        attribute float aPattern;
        attribute vec3 aC0;
        attribute vec3 aC1;
        attribute vec3 aC2;
        attribute float aLength;
        varying float vPattern;
        varying vec3 vC0;
        varying vec3 vC1;
        varying vec3 vC2;
        varying vec2 vFlagUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vPattern = aPattern; vC0 = aC0; vC1 = aC1; vC2 = aC2; vFlagUv = uv;
        // A wave travelling from the hoist to the fly, none at the mast; a
        // second, shorter one on top so the cloth does not read as a sine.
        float fly = uv.x;
        #ifdef USE_INSTANCING
          float seed = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.07;
        #else
          float seed = 0.0;
        #endif
        float t = uWindTime * 4.2 + seed;
        float wave = sin(fly * 7.5 - t) * 0.6 + sin(fly * 13.0 - t * 1.7 + uv.y * 2.0) * 0.25;
        transformed.z += wave * fly * 0.11 * aLength;
        // The fly droops a little, more where the wave is slack.
        transformed.y -= fly * fly * 0.05 * (1.2 - abs(wave));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vPattern;
        varying vec3 vC0;
        varying vec3 vC1;
        varying vec3 vC2;
        varying vec2 vFlagUv;
        ${GLSL_PATTERN}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= flagColour(vFlagUv, vPattern, vC0, vC1, vC2);`);
  };
  m.customProgramCacheKey = () => 'flag-cloth-v1';
  return m;
}

export function createFlagLayer(): FlagLayer {
  const group = new Group();
  group.name = 'flags';
  const geometry = new PlaneGeometry(1, 1, 24, 12);
  // Hoist at x = 0, top at y = 0: the instance is placed at the mast's top.
  geometry.translate(0.5, -0.5, 0);
  const mat = material();
  let mesh: InstancedMesh | null = null;

  return {
    group,
    set(flags) {
      if (mesh) {
        group.remove(mesh);
        mesh.dispose();
        mesh = null;
      }
      if (flags.length === 0) return;
      const g = geometry.clone();
      const n = flags.length;
      const pattern = new Float32Array(n), length = new Float32Array(n);
      const c0 = new Float32Array(n * 3), c1 = new Float32Array(n * 3), c2 = new Float32Array(n * 3);
      const col = new Color();
      // Downwind, in three's XZ plane: the cloth's +x points where the wind goes.
      const dir = windUniforms.uWindDir.value;
      const yaw = Math.atan2(-dir.y, dir.x);
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
      const mtx = new Matrix4();
      mesh = new InstancedMesh(g, mat, n);
      mesh.name = 'flag-cloth';
      flags.forEach((f, i) => {
        mtx.compose(new Vector3(f.x, f.y, f.z), q, new Vector3(f.width, f.height, 1));
        mesh!.setMatrixAt(i, mtx);
        pattern[i] = Math.max(0, FLAG_PATTERNS.indexOf(f.design.pattern));
        length[i] = f.width;
        for (const [k, out] of [[0, c0], [1, c1], [2, c2]] as const) {
          col.setHex(f.design.colours[k]).convertSRGBToLinear();
          out[i * 3] = col.r; out[i * 3 + 1] = col.g; out[i * 3 + 2] = col.b;
        }
      });
      g.setAttribute('aPattern', new InstancedBufferAttribute(pattern, 1));
      g.setAttribute('aLength', new InstancedBufferAttribute(length, 1));
      g.setAttribute('aC0', new InstancedBufferAttribute(c0, 3));
      g.setAttribute('aC1', new InstancedBufferAttribute(c1, 3));
      g.setAttribute('aC2', new InstancedBufferAttribute(c2, 3));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    },
    dispose() {
      if (mesh) mesh.dispose();
      geometry.dispose();
      mat.dispose();
    },
  };
}
