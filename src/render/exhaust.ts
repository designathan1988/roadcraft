import {
  BufferAttribute,
  BufferGeometry,
  NormalBlending,
  Points,
  ShaderMaterial,
} from 'three';

import { windUniforms } from './wind';
import { m, TUNED_UNIT } from '@world/units';

/** Smoke and dust: soft puffs that rise, spread, thin out and drift downwind. */

/** Puffs alive at once, map-wide. */
const POOL = 4000;
/** Seconds an exhaust puff lives. */
const EXHAUST_LIFE = 2.6;

/** 0 exhaust, 1 dust (brown-grey, low and wide), 2 dark smoke (rises), 3 concrete dust (pale, billowing), 4 blood spray */
export type PuffKind = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface Exhaust {
  readonly points: Points;
  /** A vehicle at (x, y) on a deck at height `z`, heading `angle`, `length` long, moving at `speed` (units/s) */
  emit(x: number, y: number, z: number, angle: number, length: number, speed: number, dusty: boolean): void;
  /** `count` puffs of `kind` at once, scattered over `spread` round (x, y, z) */
  burst(x: number, y: number, z: number, count: number, kind: PuffKind, spread: number, size: number, life: number): void;
  /** Advances the clock the shader ages puffs by. */
  tick(seconds: number, halfHeight: number): void;
  dispose(): void;
}

export function createExhaust(): Exhaust {
  const origin = new Float32Array(POOL * 3);
  const born = new Float32Array(POOL).fill(-1e6);
  const kind = new Float32Array(POOL);
  const seed = new Float32Array(POOL);
  const size = new Float32Array(POOL);
  const life = new Float32Array(POOL).fill(1);
  for (let i = 0; i < POOL; i++) seed[i] = Math.random();
  const geometry = new BufferGeometry();
  // BufferAttribute (not Float32BufferAttribute, which copies): the pool is written in place through these same arrays.
  geometry.setAttribute('position', new BufferAttribute(origin, 3));
  geometry.setAttribute('aBorn', new BufferAttribute(born, 1));
  geometry.setAttribute('aKind', new BufferAttribute(kind, 1));
  geometry.setAttribute('aSeed', new BufferAttribute(seed, 1));
  geometry.setAttribute('aSize', new BufferAttribute(size, 1));
  geometry.setAttribute('aLife', new BufferAttribute(life, 1));
  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWindDir: windUniforms.uWindDir,
      uHalfH: { value: 400 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec2 uWindDir;
      uniform float uHalfH;
      attribute float aBorn;
      attribute float aKind;
      attribute float aSeed;
      attribute float aSize;
      attribute float aLife;
      varying float vAlpha;
      varying float vKind;
      varying float vSeed;
      varying float vAge;
      void main() {
        float t = uTime - aBorn;
        float age = t / aLife;
        vKind = aKind;
        vSeed = aSeed;
        vAge = age;
        if (age < 0.0 || age > 1.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          gl_PointSize = 0.0;
          vAlpha = 0.0;
          return;
        }
        vec3 p = position;
        // The motions below are written in steps of 0.4 m (TUNED_UNIT), the scale they were tuned at
        vec3 born = position;
        // Rise: smoke climbs, dust hangs low, a collapse cloud billows up and out.
        float rise = aKind < 0.5 ? 2.4 : aKind < 1.5 ? 1.0 : aKind < 2.5 ? 3.5 : 1.8;
        vec2 out2 = vec2(sin(aSeed * 40.0), cos(aSeed * 40.0));
        bool flung = (aKind > 3.5 && aKind < 4.5) || (aKind > 5.5 && aKind < 7.5);
        if (aKind > 8.5) {
          // Paper: blown up and out by the blast, then drifting down slowly, swinging side to side, carried by the wind.
          float up = 9.0 * (1.0 - exp(-t * 2.0)) - 0.55 * t;
          p.y += up + 0.4 * sin(t * 2.3 + aSeed * 9.0);
          p.xz += out2 * (5.0 + 6.0 * fract(aSeed * 7.0)) * (1.0 - exp(-t * 1.5)) + uWindDir * 0.9 * t
            + vec2(sin(t * 1.7 + aSeed * 13.0), cos(t * 1.3 + aSeed * 5.0)) * 0.8;
        } else if (aKind > 7.5) {
          // A broken hydrant's jet: straight up, fanning a little, falling back.
          p.y += (30.0 + 6.0 * fract(aSeed * 13.0)) * clamp(aSize / ${m(0.8).toFixed(6)}, 0.15, 1.0) * t - 9.8 * t * t;
          p.xz += out2 * (0.6 + 1.6 * fract(aSeed * 7.0)) * t + uWindDir * 0.8 * t;
        } else if (flung) {
          // Blood, sparks, grit: flung up and out, falling back under gravity.
          float fling = aKind > 5.5 && aKind < 6.5 ? 3.0 : 1.0;
          p.y += (5.0 + 10.0 * fract(aSeed * 17.0)) * fling * t - 12.25 * t * t;
          p.xz += out2 * (3.0 + 8.0 * fract(aSeed * 7.0)) * fling * t;
        } else if (aKind > 4.5) {
          // Flame: bursting out, licking upwards fast, gone in a moment.
          p.y += 6.0 * t + 0.3 * sin(t * 9.0 + aSeed * 6.28);
          p.xz += out2 * 4.0 * t * (1.0 - age * 0.6) + uWindDir * 1.5 * t;
        } else {
          p.y += rise * t * (1.0 - 0.3 * age) + 0.15 * sin(t * 3.0 + aSeed * 6.28);
          float spreadOut = aKind > 2.5 ? 2.2 : aKind > 0.5 ? 1.2 : 0.5;
          p.xz += uWindDir * (3.0 * t + 0.6 * t * t) + out2 * spreadOut * t;
        }
        p = born + (p - born) * ${TUNED_UNIT.toFixed(6)};
        vec4 mv = viewMatrix * vec4((modelMatrix * vec4(p, 1.0)).xyz, 1.0);
        gl_Position = projectionMatrix * mv;
        float grow = aKind > 8.5 ? 0.0 : aKind > 7.5 ? 1.2 : aKind > 5.5 ? 0.2 : aKind > 4.5 ? 1.6 : aKind > 3.5 ? 0.6 : aKind > 2.5 ? 3.2 : aKind > 1.5 ? 2.6 : 2.0;
        float s = aSize * (0.5 + grow * age);
        bool ortho = projectionMatrix[3][3] == 1.0;
        gl_PointSize = s * projectionMatrix[1][1] * uHalfH / (ortho ? 1.0 : max(${m(0.4).toFixed(6)}, -mv.z));
        float peak = aKind > 8.5 ? 1.0 : aKind > 7.5 ? 0.55 : aKind < 0.5 ? 0.16 : aKind < 1.5 ? 0.45 : aKind < 2.5 ? 0.5 : aKind < 3.5 ? 0.42 : aKind < 4.5 ? 0.95 : aKind < 5.5 ? 0.8 : 1.0;
        vAlpha = peak * smoothstep(0.0, 0.06, age) * (1.0 - age) * (1.0 - age * 0.3);
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vKind;
      varying float vSeed;
      varying float vAge;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        // A soft, round puff: gaussian falloff, a faint unevenness inside it
        float inner = 0.9 + 0.1 * sin(d.x * 9.0 + vSeed * 20.0) * sin(d.y * 7.0 - vSeed * 13.0);
        float soft = exp(-r * r * 3.2) * inner * smoothstep(1.0, 0.7, r);
        vec3 smoke = vec3(0.55, 0.56, 0.58);
        vec3 dust = vec3(0.6, 0.53, 0.43);
        vec3 dark = vec3(0.16, 0.15, 0.15);
        vec3 concrete = vec3(0.74, 0.71, 0.66);
        vec3 blood = vec3(0.2, 0.008, 0.014);
        vec3 c = vKind < 0.5 ? smoke : vKind < 1.5 ? dust : vKind < 2.5 ? dark : vKind < 3.5 ? concrete : blood;
        if (vKind > 3.5) soft = smoothstep(1.0, 0.55, r);
        if (vKind > 4.5 && vKind < 5.5) {
          // Flame: white-yellow at the heart, orange, then red at the edge, brighter than white.
          vec2 q = vec2(d.x * (1.6 + 0.8 * (0.5 - d.y)), d.y * 1.1 + 0.08);
          float flick = 0.75 + 0.25 * sin(d.y * 14.0 + vSeed * 40.0 + vAge * 25.0) * sin(d.x * 11.0 - vSeed * 17.0);
          float rf = length(q) * 2.0 / flick;
          vec3 hot = mix(vec3(3.4, 2.6, 1.4), vec3(2.4, 0.9, 0.18), smoothstep(0.0, 0.7, rf * 0.6 + vAge * 0.9));
          c = mix(hot, vec3(0.12, 0.1, 0.09), smoothstep(0.6, 1.0, vAge));
          soft = exp(-rf * rf * 2.2) * smoothstep(1.2, 0.6, rf);
        } else if (vKind > 5.5 && vKind < 6.5) {
          c = vec3(4.0, 2.6, 1.0);
          soft = smoothstep(1.0, 0.2, r);
        } else if (vKind > 8.5) {
          // A sheet of paper, turning: a thin bright square flickering edge-on.
          float turn = abs(sin(vAge * 40.0 + vSeed * 30.0));
          vec2 q = abs(d) * vec2(1.0, 1.0 / max(0.15, turn));
          soft = step(max(q.x, q.y), 0.42);
          c = mix(vec3(0.95, 0.94, 0.9), vec3(0.85, 0.82, 0.74), fract(vSeed * 3.0));
        } else if (vKind > 7.5) {
          c = vec3(0.82, 0.9, 0.97);
          soft = exp(-r * r * 2.5);
        } else if (vKind > 6.5) {
          c = vec3(0.3, 0.24, 0.18);
          soft = smoothstep(1.0, 0.5, r);
        }
        // Shaded a little darker underneath, lighter on top.
        c *= 0.85 + 0.3 * (0.5 - d.y);
        gl_FragColor = vec4(c, vAlpha * soft);
      }`,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
  });
  const points = new Points(geometry, material);
  points.name = 'exhaust';
  points.frustumCulled = false;
  points.renderOrder = 5;

  const pools = ['position', 'aBorn', 'aKind', 'aSeed', 'aSize', 'aLife']
    .map((name) => geometry.getAttribute(name) as BufferAttribute);

  let next = 0;
  let now = 0;
  let owed = 0;
  let frameDt = 1 / 60;
  let lastWall = -1;
  const spawn = (x: number, y: number, z: number, k: PuffKind, s: number, l: number): void => {
    const i = next;
    next = (next + 1) % POOL;
    // World y is three's -z, as everywhere in this layer.
    origin[i * 3] = x;
    origin[i * 3 + 1] = z;
    origin[i * 3 + 2] = -y;
    born[i] = now;
    kind[i] = k;
    size[i] = s;
    life[i] = l;
    seed[i] = Math.random();
    // Only the slot written goes to the graphics card: flagged with no range, the whole pool
    for (const pool of pools) {
      pool.addUpdateRange(i * pool.itemSize, pool.itemSize);
      pool.needsUpdate = true;
    }
  };
  return {
    points,
    emit(x, y, z, angle, length, speed, dusty) {
      const dt = frameDt;
      const moving = Math.abs(speed) > 0.5;
      // A running engine puffs a little standing still, more pulling away.
      owed += dt * (moving ? 0.5 + Math.min(1, Math.abs(speed) * 0.02) : 0.15);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const tailX = x - cos * length * 0.5, tailY = y - sin * length * 0.5;
      // The puff's place and size in steps of 0.4 m (`TUNED_UNIT`), as the shader's motions
      const u = TUNED_UNIT;
      while (owed >= 1) {
        owed -= 1;
        spawn(tailX + (Math.random() - 0.5) * 0.8 * u, tailY + (Math.random() - 0.5) * 0.8 * u, z + 1.0 * u, 0, 2.4 * u, EXHAUST_LIFE);
      }
      if (dusty && moving && Math.random() < dt * 6) spawn(tailX, tailY, z + 0.2 * u, 1, 6 * u, EXHAUST_LIFE * 1.5);
    },
    burst(x, y, z, count, k, spread, s, l) {
      for (let n = 0; n < count; n++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
        spawn(x + Math.cos(a) * r, y + Math.sin(a) * r, z + (Math.random() - 0.3) * spread * 0.4,
          k, s * (0.6 + Math.random() * 0.8), l * (0.7 + Math.random() * 0.6));
      }
    },
    tick(seconds, halfHeight) {
      now = seconds;
      const wall = typeof performance !== 'undefined' ? performance.now() / 1000 : seconds;
      frameDt = lastWall < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, wall - lastWall));
      lastWall = wall;
      material.uniforms['uHalfH']!.value = halfHeight;
      material.uniforms['uTime']!.value = seconds;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
