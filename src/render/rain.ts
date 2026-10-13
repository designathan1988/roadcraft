/**
 * RAIN (`world/weather.ts`): streaks falling through a box that goes with the
 * view - camera-centred rain, as games draw it (Microsoft Research's
 * "Real-Time Rendering of Realistic Rain"; Tatarchuk's ToyShop rain at ATI):
 * every drop's place is a hash in the box plus its fall, wrapped round the
 * box in the vertex shader, so the CPU sends one time a frame and nothing
 * else. The box is anchored to the world (the drops do not slide with the
 * camera) and as wide as the view; the drops fall as fast across it at any
 * zoom, slanted by the wind, and fade towards its sides so it has no edge.
 */
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, LineSegments, ShaderMaterial, Vector2, Vector3,
} from 'three';
import { m } from '@world/units';

/** Streaks at a downpour; a lighter rain draws the first part of them. */
const MAX_DROPS = 10_000;

export interface Rain {
  readonly object: LineSegments;
  /**
   * The rain this frame: how hard (0..1), the ground point under the view
   * and the view's width there (world units), the wind (world units a second,
   * along three's x and z), the seconds since the last frame.
   */
  update(amount: number, centre: Vector3, span: number, wind: Vector2, delta: number): void;
  dispose(): void;
}

export function createRain(): Rain {
  const seeds = new Float32Array(MAX_DROPS * 2 * 3);
  const tips = new Float32Array(MAX_DROPS * 2);
  // A fixed hash, the same drops every visit.
  let h = 0x9e3779b9;
  const next = (): number => {
    h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    return h / 4_294_967_296;
  };
  for (let i = 0; i < MAX_DROPS; i++) {
    const x = next(), y = next(), z = next();
    for (let k = 0; k < 2; k++) {
      seeds.set([x, y, z], (i * 2 + k) * 3);
      tips[i * 2 + k] = k;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(seeds, 3));
  geometry.setAttribute('tip', new BufferAttribute(tips, 1));
  const material = new ShaderMaterial({
    uniforms: {
      uCentre: { value: new Vector3() },
      uBox: { value: new Vector3(1, 1, 1) },
      uTime: { value: 0 },
      uVelocity: { value: new Vector3(0, -1, 0) },
      uStreak: { value: 0.05 },
      uNear: { value: 10 },
      uOpacity: { value: 0.3 },
      uColour: { value: new Color(0.62, 0.68, 0.76) },
    },
    vertexShader: `
      attribute float tip;
      uniform vec3 uCentre;
      uniform vec3 uBox;
      uniform float uTime;
      uniform vec3 uVelocity;
      uniform float uStreak;
      uniform float uNear;
      varying float vFade;
      void main() {
        // The drop's place: its hash in the box plus its fall, wrapped round
        // a box anchored to the world.
        vec3 corner = uCentre - uBox * 0.5;
        vec3 p = position * uBox + uVelocity * uTime;
        p = corner + mod(p - corner, uBox);
        // The streak: its tail where it was a moment ago.
        p -= uVelocity * uStreak * tip;
        // Faded towards the box's sides, top and foot: no edge to the rain.
        vec3 q = abs(p - uCentre) / (uBox * 0.5);
        vFade = (1.0 - smoothstep(0.6, 1.0, max(q.x, q.z))) * (1.0 - smoothstep(0.7, 1.0, q.y)) * (1.0 - tip * 0.7);
        // None right before the lens: a drop there is a scratch across the screen.
        vFade *= smoothstep(uNear, uNear * 2.5, distance(p, cameraPosition));
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColour;
      uniform float uOpacity;
      varying float vFade;
      void main() {
        gl_FragColor = vec4(uColour * uOpacity * vFade, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const object = new LineSegments(geometry, material);
  object.name = 'rain';
  object.frustumCulled = false;
  object.visible = false;
  object.renderOrder = 5;
  const u = material.uniforms as Record<string, { value: unknown }>;
  let time = 0;
  return {
    object,
    update(amount, centre, span, wind, delta) {
      object.visible = amount > 0.001;
      if (!object.visible) return;
      time += delta;
      // As wide as the view, as tall as half of it, centred over the ground.
      const side = Math.min(m(1_200), Math.max(m(64), span * 1.1));
      const tall = side * 0.55;
      (u['uBox']!.value as Vector3).set(side, tall, side);
      (u['uCentre']!.value as Vector3).set(centre.x, centre.y + tall * 0.42, centre.z);
      // Fast enough to cross the view in about a second at any zoom; the
      // wind's slant kept in proportion to it (some 9 m/s of fall).
      const fall = Math.max(m(8.8), tall * 1.6);
      const scale = fall / m(8.8);
      // The slant: the wind against the fall, never flatter than some 40
      // degrees off the vertical (a gale's rain, not scratches across the view).
      const across = Math.min(0.85 * fall, Math.hypot(wind.x, wind.y) * scale);
      const windLength = Math.hypot(wind.x, wind.y);
      const k = windLength > 1e-6 ? across / windLength : 0;
      (u['uVelocity']!.value as Vector3).set(wind.x * k, -fall, wind.y * k);
      u['uStreak']!.value = 0.022;
      u['uNear']!.value = side * 0.12;
      u['uTime']!.value = time;
      u['uOpacity']!.value = 0.1 + 0.12 * amount;
      geometry.setDrawRange(0, Math.round(MAX_DROPS * Math.min(1, amount)) * 2);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
