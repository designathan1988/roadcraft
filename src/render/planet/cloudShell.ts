import { DoubleSide, Matrix4, Mesh, Quaternion, ShaderMaterial, SphereGeometry, Vector3, type Camera, type Scene } from 'three';
import { PLANET_RADIUS } from '@core/cubeSphere';

/**
 * THE PLANET'S CLOUD COVER SEEN FROM AFAR: from the top of the air out to the
 * globe the Earth is two thirds under cloud, and a world drawn without it read
 * as a painted ball (the player, 2026-10-11: "os gráficos da Terra ... muito
 * simples"). As Earth renderers draw it (science-and-fiction.org "Rendering
 * the Earth from space": a second sphere over the terrain carrying the
 * clouds, lit by the sun, its relief read from the cover's gradient along
 * the light; Planetary Society "Rendering Earth"), here a shell a little over
 * the ground whose cover is made in the shader: domain-warped fractal noise
 * on the sphere's direction (Quilez, "Domain warping"), banded by latitude as
 * the Earth's are (the wet equator's towers, the dry subtropics' clear belts,
 * the mid-latitudes' storm tracks), drifting slowly - each octave at its own
 * rate, so the cover changes as it moves. Lit by the sun with a warm band at
 * the terminator; its relief from a second read a step towards the sun (the
 * near side of a thick cloud bright, the far side in its own shade).
 *
 * Shown with the globe: faded in as the view leaves the air and the planet is
 * drawn round (`bend.ts` curvature towards 1), out of the way of the near
 * clouds (`world/clouds.ts`, `postprocess.ts`) the ground keeps.
 */
export interface CloudShell {
  update(frame: CloudShellFrame): void;
  dispose(): void;
}

export interface CloudShellFrame {
  readonly camera: Camera;
  /** The planet's centre as drawn and the motion setting it down (`bend.ts` planetMotion). */
  readonly centre: Vector3;
  readonly motion: Matrix4;
  /** The sun's direction (three's space, unit). */
  readonly sun: Vector3;
  /** How round the planet is drawn (`bend.ts` planetCurvature: 1 the globe). */
  readonly curvature: number;
  /** The game's clock, seconds: the cover's drift. */
  readonly seconds: number;
}

/** The shell's height over the ground: well clear of the tallest land, under the air's top. */
const CLOUD_HEIGHT = PLANET_RADIUS * 0.025;
/** Eye heights over the ground between which the cover fades in (the air's lower part). */
const FADE_FROM = PLANET_RADIUS * 0.12;
const FADE_TO = PLANET_RADIUS * 0.3;

const VERTEX = /* glsl */ `
  varying vec3 vDir;
  varying vec3 vWorld;
  void main() {
    vDir = normalize(position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uSunLocal;
  uniform vec3 uCentre;
  uniform vec3 uSun;
  uniform float uTime;
  uniform float uShow;
  varying vec3 vDir;
  varying vec3 vWorld;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  // Value noise in 3-D (Quilez): smooth, cheap, enough under the warp.
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i + vec3(0, 0, 0)), hash(i + vec3(1, 0, 0)), f.x),
                   mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                   mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  // A direction turned about the planet's axis (its frame's z).
  vec3 spin(vec3 d, float a) {
    float c = cos(a), s = sin(a);
    return vec3(c * d.x - s * d.y, s * d.x + c * d.y, d.z);
  }
  float fbm(vec3 p, float t) {
    float v = 0.0, amp = 0.5;
    for (int i = 0; i < 5; i++) {
      // Each octave drifts at its own rate: the cover changes as it moves.
      v += amp * noise(spin(p, t * (0.6 + 0.35 * float(i))) );
      p = p * 2.03 + vec3(1.7, -2.3, 0.9);
      amp *= 0.5;
    }
    return v;
  }
  // The cover at a direction of the planet (0 clear .. 1 thick).
  float cover(vec3 d) {
    float t = uTime * 0.0006;
    vec3 p = d * 3.2;
    // Domain warp: the swirls and the long fronts of the storm tracks.
    vec3 w = vec3(fbm(p + vec3(0.0, 0.0, 3.1), t), fbm(p + vec3(5.2, 1.3, 0.0), t), fbm(p + vec3(2.1, 7.7, 1.4), t));
    float n = fbm(p * 1.4 + 2.2 * w, t * 1.3);
    // Latitude bands, as the Earth's: wet at the equator, clear subtropics,
    // the storm tracks at mid-latitudes, thinner over the poles.
    float lat = abs(d.z);
    float bands = 0.48
      + 0.12 * exp(-pow(lat / 0.12, 2.0))
      - 0.10 * exp(-pow((lat - 0.42) / 0.12, 2.0))
      + 0.10 * exp(-pow((lat - 0.78) / 0.12, 2.0))
      - 0.06 * smoothstep(0.92, 1.0, lat);
    return smoothstep(1.0 - bands - 0.08, 1.0 - bands + 0.16, n);
  }

  void main() {
    vec3 d = normalize(vDir);
    float c = cover(d);
    if (c < 0.01) discard;
    // Relief from the cover a step towards the sun: the far side of a thick
    // cloud in its own shade (science-and-fiction.org: the gradient along the light).
    vec3 towards = normalize(uSunLocal - dot(uSunLocal, d) * d + 1e-5);
    float ahead = cover(normalize(d + towards * 0.012));
    float relief = clamp(1.0 - 1.6 * max(0.0, ahead - c), 0.45, 1.0);
    vec3 n = normalize(vWorld - uCentre);
    float day = dot(n, uSun);
    float lit = smoothstep(-0.12, 0.25, day);
    // The warm band at the terminator: the clouds caught by a low sun.
    vec3 sunColour = mix(vec3(1.0, 0.55, 0.32), vec3(1.0, 0.98, 0.95), smoothstep(0.0, 0.35, day));
    vec3 colour = sunColour * (0.35 + 0.65 * relief) * lit;
    // Night: a faint grey, the moon's and the stars' light.
    colour += vec3(0.02, 0.025, 0.035) * (1.0 - lit);
    float alpha = c * uShow * mix(0.55, 0.92, c);
    gl_FragColor = vec4(colour * alpha, alpha);
  }
`;

export function createCloudShell(scene: Scene): CloudShell {
  const uniforms = {
    uSunLocal: { value: new Vector3() },
    uCentre: { value: new Vector3() },
    uSun: { value: new Vector3() },
    uTime: { value: 0 },
    uShow: { value: 0 },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    // Premultiplied: the colour over what is behind, by what the cloud covers.
    premultipliedAlpha: true,
  });
  const shell = new Mesh(new SphereGeometry(1, 160, 80), material);
  shell.name = 'planet-clouds';
  shell.frustumCulled = false;
  shell.renderOrder = 2;
  shell.scale.setScalar(PLANET_RADIUS + CLOUD_HEIGHT);
  shell.visible = false;
  scene.add(shell);
  const rotation = new Quaternion();
  const inverse = new Quaternion();
  const scale = new Vector3();
  const position = new Vector3();
  const eye = new Vector3();
  return {
    update(frame) {
      eye.subVectors(frame.camera.position, frame.centre);
      const height = eye.length() - PLANET_RADIUS;
      const t = Math.min(1, Math.max(0, (height - FADE_FROM) / (FADE_TO - FADE_FROM)));
      const round = Math.min(1, Math.max(0, (frame.curvature - 0.85) / 0.15));
      const show = t * t * (3 - 2 * t) * round;
      uniforms.uShow.value = show;
      shell.visible = show > 0.001;
      if (!shell.visible) return;
      // Fixed to the planet: its frame (the motion's rotation) turns the shell.
      frame.motion.decompose(position, rotation, scale);
      shell.position.copy(frame.centre);
      shell.quaternion.copy(rotation);
      inverse.copy(rotation).invert();
      uniforms.uSunLocal.value.copy(frame.sun).applyQuaternion(inverse).normalize();
      uniforms.uCentre.value.copy(frame.centre);
      uniforms.uSun.value.copy(frame.sun);
      uniforms.uTime.value = frame.seconds;
    },
    dispose() {
      scene.remove(shell);
      shell.geometry.dispose();
      material.dispose();
    },
  };
}
