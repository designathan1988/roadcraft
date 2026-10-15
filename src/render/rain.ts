/**
 * RAIN (`world/weather.ts`): streaks falling through a box that goes with the
 * view - camera-centred rain, as games draw it (Microsoft Research's
 * "Real-Time Rendering of Realistic Rain"; Tatarchuk's ToyShop rain at ATI):
 * every drop's place is a hash in the box plus the rain's fall so far,
 * wrapped round the box in the vertex shader, so the CPU sends a few numbers
 * a frame and nothing else. The drops are anchored to the world (they do not
 * slide with the camera); the box is as wide as the view; the drops fall as
 * fast across it at any zoom, slanted by the wind, and fade towards its sides
 * so it has no edge.
 *
 * The fall is integrated frame by frame (velocity x the frame's time), as a
 * particle system advances its state (NVIDIA's Rain SDK, Tariq 2007), and kept
 * as an offset inside the box (`RainField.lattice`). DO NOT place the drops by
 * `velocity * total time`: the velocity follows the zoom, and every change of
 * zoom moved every drop by the change times all the time it had rained - the
 * rain jumped. DO NOT wrap world coordinates by a box that changes: a box a
 * hair wider moved drops far from the world's origin by its change times
 * their distance over the box. A new box scales the drops with it.
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

/** Where the rain is this frame: what the vertex shader places the drops by (`dropAt`). */
export interface RainField {
  /** The box's centre and size, world units (three's frame, y up). */
  readonly centre: Vector3;
  readonly box: Vector3;
  /** The drops' velocity, world units a second. */
  readonly velocity: Vector3;
  /** The drops' lattice: its offset from the box's low corner, each axis in [0, box). */
  readonly lattice: Vector3;
  /** False until the first frame has set the box. */
  started: boolean;
}

export function createRainField(): RainField {
  return { centre: new Vector3(), box: new Vector3(1, 1, 1), velocity: new Vector3(0, -1, 0), lattice: new Vector3(), started: false };
}

const wrap = (a: number, b: number): number => a - b * Math.floor(a / b);

/**
 * The rain one frame on: the box over `ground` as wide as the view (`span`),
 * the drops' velocity for that box and the `wind`, and the lattice moved by
 * the fall over `delta` seconds. A box of another size scales the lattice
 * about the ground point, as the box itself scales: a drop in view moves by
 * no more than the box's own sides do.
 */
export function advanceRain(field: RainField, ground: Vector3, span: number, wind: Vector2, delta: number): void {
  // As wide as the view, as tall as half of it, centred over the ground.
  const side = Math.min(m(1_200), Math.max(m(64), span * 1.1));
  const tall = side * 0.55;
  const cx = ground.x, cy = ground.y + tall * 0.42, cz = ground.z;
  // The lattice's origin in the world, carried into the new box.
  let ox = 0, oy = 0, oz = 0;
  if (field.started) {
    const { centre, box, lattice } = field;
    ox = centre.x - box.x * 0.5 + lattice.x;
    oy = centre.y - box.y * 0.5 + lattice.y;
    oz = centre.z - box.z * 0.5 + lattice.z;
    // About the ground point: the box hangs over it in the same proportions
    // at any size, so the old box maps onto the new one.
    ox = cx + (ox - cx) * (side / box.x);
    oy = ground.y + (oy - ground.y) * (tall / box.y);
    oz = cz + (oz - cz) * (side / box.z);
  }
  // Fast enough to cross the view in about a second at any zoom; the
  // wind's slant kept in proportion to it (some 9 m/s of fall).
  const fall = Math.max(m(8.8), tall * 1.6);
  const scale = fall / m(8.8);
  // The slant: the wind against the fall, never flatter than some 40
  // degrees off the vertical (a gale's rain, not scratches across the view).
  const windLength = Math.hypot(wind.x, wind.y);
  const across = Math.min(0.85 * fall, windLength * scale);
  const k = windLength > 1e-6 ? across / windLength : 0;
  field.velocity.set(wind.x * k, -fall, wind.y * k);
  ox += field.velocity.x * delta;
  oy += field.velocity.y * delta;
  oz += field.velocity.z * delta;
  field.box.set(side, tall, side);
  field.centre.set(cx, cy, cz);
  field.lattice.set(wrap(ox - (cx - side * 0.5), side), wrap(oy - (cy - tall * 0.5), tall), wrap(oz - (cz - side * 0.5), side));
  field.started = true;
}

/**
 * A drop's place - `seed` its hash in [0, 1) on each axis, `tip` 0 at its
 * head, 1 at its tail - as the vertex shader puts it.
 */
export function dropAt(field: RainField, seed: Vector3, tip: number, streak: number, out: Vector3): Vector3 {
  const { centre, box, lattice, velocity } = field;
  return out.set(
    centre.x - box.x * 0.5 + wrap(seed.x * box.x + lattice.x, box.x),
    centre.y - box.y * 0.5 + wrap(seed.y * box.y + lattice.y, box.y),
    centre.z - box.z * 0.5 + wrap(seed.z * box.z + lattice.z, box.z),
  ).addScaledVector(velocity, -streak * tip);
}

/** The streak's length in seconds of fall. */
const STREAK = 0.022;

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
  const field = createRainField();
  const material = new ShaderMaterial({
    uniforms: {
      // The field's own vectors: written by `advanceRain`, read as they are.
      uCentre: { value: field.centre },
      uBox: { value: field.box },
      uLattice: { value: field.lattice },
      uVelocity: { value: field.velocity },
      uStreak: { value: STREAK },
      uNear: { value: 10 },
      uOpacity: { value: 0.3 },
      uColour: { value: new Color(0.62, 0.68, 0.76) },
    },
    vertexShader: `
      attribute float tip;
      uniform vec3 uCentre;
      uniform vec3 uBox;
      uniform vec3 uLattice;
      uniform vec3 uVelocity;
      uniform float uStreak;
      uniform float uNear;
      varying float vFade;
      void main() {
        // The drop's place (\`dropAt\`): its hash in the box plus the fall so
        // far (the lattice), wrapped round the box.
        vec3 corner = uCentre - uBox * 0.5;
        vec3 p = corner + mod(position * uBox + uLattice, uBox);
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
  return {
    object,
    update(amount, centre, span, wind, delta) {
      object.visible = amount > 0.001;
      if (!object.visible) return;
      advanceRain(field, centre, span, wind, delta);
      u['uNear']!.value = field.box.x * 0.12;
      u['uOpacity']!.value = 0.1 + 0.12 * amount;
      geometry.setDrawRange(0, Math.round(MAX_DROPS * Math.min(1, amount)) * 2);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
