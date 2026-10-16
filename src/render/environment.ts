import {
  ShaderChunk,
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Camera,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { m } from '@world/units';
import { cascadedSunChunks, createSunCascades, SUN_CASCADES, type Movers, type ShadowPassInput } from './sunCascades';

/** Sky, sun and atmosphere. */

/** Sun elevation above the horizon. */
// It was 38 degrees: a shadow 1.28 times as long as what cast it
const SUN_ELEVATION = (47 * Math.PI) / 180;
/** Sun bearing — and the one number that decides whether shadows are VISIBLE. */
const SUN_AZIMUTH = (-87 * Math.PI) / 180;

export interface EnvironmentQuality {
  /** Side of each of the sun's cascade maps (`sunCascades.ts`). */
  readonly shadowMapSize: number;
  readonly shadows: boolean;
}

export interface SceneEnvironment {
  /** The sun as the game reads it (colour, intensity, direction): the first of its cascades. */
  readonly sun: DirectionalLight;
  readonly skyColor: Color;
  /** Fits the sun's cascades to what the camera sees (`sunCascades.ts`). */
  follow(camera: Camera, target: Vector3, top: number, groundAt: (x: number, y: number) => number): void;
  /** Marks the cascades to draw this frame; true when any is (the renderer's `shadowMap.needsUpdate`). */
  shadowPass(input: ShadowPassInput): boolean;
  /** What moves and is drawn into the shadows (`sunCascades.ts` `Movers`). */
  setMovers(movers: readonly Movers[]): void;
  /** What chooses its casters by each cascade's texel (`SunCascades.setCasters`). */
  setCasters(casters: ((texel: number) => void) | null): void;
  /** The cascades' maps, for the video memory count. */
  shadowMaps(): (WebGLRenderTarget | null)[];
  setQuality(quality: EnvironmentQuality): void;
  /** The time of day, minutes after midnight: the sun's path, the sky, the light; the moon at night. */
  setTimeOfDay(minutes: number): number;
  /** Smoke in the air, 0..1: the fog closes in and browns, the light dims. */
  setSmog(k: number): void;
  /** The weather on the light (`world/weather.ts`): how overcast */
  setWeather(overcast: number, flash: number): void;
  /** How much of the light on level ground comes straight from the sun, 0..1 */
  directShare(): number;
  dispose(): void;
}

const SKY_VERTEX = `
  varying vec3 vSkyDirection;
  void main() {
    vSkyDirection = normalize(position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
    // On the far plane: z = w (depth 1) in the standard buffer, z = 0 in the reversed one
    #ifdef USE_REVERSED_DEPTH_BUFFER
      gl_Position.z = 0.0;
    #else
      gl_Position.z = gl_Position.w;
    #endif
  }
`;

const SKY_FRAGMENT = `
  varying vec3 vSkyDirection;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;

  void main() {
    // Height over the horizon: the level is the horizon.
    float h = normalize(vSkyDirection).y;
    vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.62));
    sky = mix(uGround, sky, smoothstep(-0.12, 0.02, h));
    // A broad, soft glow around the sun, and a tighter core inside it.
    float sun = max(dot(normalize(vSkyDirection), uSunDirection), 0.0);
    sky += uSunColor * (pow(sun, 7.0) * 0.28 + pow(sun, 120.0) * 0.9);
    gl_FragColor = vec4(sky, 1.0);
  }
`;

const DAY_ZENITH = new Color(0x4d7fc4);
const NIGHT_ZENITH = new Color(0x0b1424);
const DAY_HORIZON = new Color(0xc9dcea);
const DUSK_HORIZON = new Color(0xf0b383);
const NIGHT_HORIZON = new Color(0x1c2638);
const DAY_SUN = new Color(0xfff0d2);
const DUSK_SUN = new Color(0xffa860);
const MOON = new Color(0x9fb4d8);

export function createEnvironment(
  scene: Scene,
  renderer: WebGLRenderer,
  quality: EnvironmentQuality,
): SceneEnvironment {
  const zenith = new Color(0x4d7fc4);
  const horizon = new Color(0xc9dcea);
  const groundTint = new Color(0x6f7a68);
  const sunColor = new Color(0xfff0d2);

  const sunDirection = new Vector3(
    Math.cos(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
    Math.sin(SUN_ELEVATION),
    Math.sin(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
  ).normalize();

  const skyMaterial = new ShaderMaterial({
    uniforms: {
      uZenith: { value: zenith },
      uHorizon: { value: horizon },
      uGround: { value: groundTint },
      uSunDirection: { value: sunDirection },
      uSunColor: { value: sunColor },
    },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const sky = new Mesh(new SphereGeometry(1, 32, 16), skyMaterial);
  sky.name = 'sky';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  scene.add(sky);

  // The sky doubles as the environment map, so water
  const pmrem = new PMREMGenerator(renderer);
  const probeScene = new Scene();
  const probe = new Mesh(new SphereGeometry(1, 32, 16), skyMaterial.clone());
  probe.frustumCulled = false;
  probeScene.add(probe);
  const envTarget = pmrem.fromScene(probeScene, 0, 0.1, 100);
  scene.environment = envTarget.texture;
  // Enough for paint, glass and wet or polished surfaces to show the sky.
  scene.environmentIntensity = 0.6;
  probe.geometry.dispose();
  (probe.material as ShaderMaterial).dispose();
  pmrem.dispose();

  // No fog: the map is seen clear to its edges (the player, 2026-10-06).
  scene.fog = null;
  scene.background = null;

  // A near-neutral sky fill: the saturated blue it was tinted every shadow blue at close zoom
  const hemisphere = new HemisphereLight(0xe6e4da, 0x6a6b4c, 0.8);
  hemisphere.name = 'sky-fill';
  scene.add(hemisphere);

  const ambient = new AmbientLight(0xdfe9f2, 0.07);
  ambient.name = 'ambient-floor';
  scene.add(ambient);

  const sun = new DirectionalLight(0xfff0cf, 3.6);
  sun.name = 'sun';
  // The sun's other cascades: the same light, each with a map of its own over a farther part of the view (`sunCascades.ts`)
  const cascadeLights: DirectionalLight[] = [];
  for (let i = 1; i < SUN_CASCADES; i++) {
    const light = new DirectionalLight(0xfff0cf, 3.6);
    light.name = `sun-cascade-${i}`;
    cascadeLights.push(light);
  }
  // The edge of a shadow filtered over two texels (three's PCF: a Vogel disc of `radius` texels)
  const cascades = createSunCascades(sun, cascadeLights, 2);
  cascades.setEnabled(quality.shadows, quality.shadowMapSize);
  // In this order: three draws the lights that cast shadows first, in the order it meets them, and the shader takes them as cascades 0, 1, 2
  for (const light of cascades.lights) scene.add(light, light.target);
  // What a cascade's pass hid (the movers too small for its texels) is put back once the frame is drawn.
  scene.onAfterRender = () => cascades.restore();

  // THE FILL LIGHT, the second light of the standard rig
  const fill = new DirectionalLight(0xf2f2ee, 0);
  fill.name = 'fill';
  fill.castShadow = false;
  scene.add(fill);

  /** Smoke in the air (`setSmog`), and the brown-grey it turns the fog. */
  let smog = 0;
  const SMOG = new Color(0xc9a27a);
  let overcast = 0;
  let flash = 0;
  const STORM_SKY = new Color(0x6f7782);
  const FLASH = new Color(0xdfe6ff);
  const FILL_WHITE = new Color(0xf2f2ee);
  return {
    sun,
    skyColor: horizon,
    follow(camera, target, top, groundAt) {
      sky.position.copy(target);
      sky.scale.setScalar(m(3_600));
      cascades.follow(camera, sunDirection, groundAt, target, top);
    },
    shadowPass: (input) => cascades.pass(input),
    setMovers: (movers) => cascades.setMovers(movers),
    setCasters: (casters) => cascades.setCasters(casters),
    shadowMaps: () => cascades.maps(),
    setTimeOfDay(minutes) {
      const hour = (((minutes / 60) % 24) + 24) % 24;
      // The sun's day: up at six, highest at noon, down at six
      const day = (hour - 6) / 12;
      const height = Math.sin(Math.PI * day);
      // How much daylight: full from a few degrees up, none below the horizon.
      const light = Math.min(1, Math.max(0, (height + 0.1) / 0.25));
      const dark = 1 - light;
      if (height > -0.1) {
        const elevation = Math.max(0.12, height) * (58 * Math.PI) / 180;
        const azimuth = SUN_AZIMUTH + (Math.min(1, Math.max(0, day)) - 0.5) * (110 * Math.PI) / 180;
        sunDirection.set(Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation)).normalize();
      } else {
        // The moon: high, cold and faint, from a fixed bearing.
        sunDirection.set(Math.cos(SUN_AZIMUTH + 0.6) * 0.55, 0.83, Math.sin(SUN_AZIMUTH + 0.6) * 0.55).normalize();
      }
      // Low sun is warm and weaker; the moon is blue.
      const warm = Math.max(0, 1 - height * 1.6);
      sun.color.setRGB(1, 0.96 - warm * 0.12, 0.9 - warm * 0.28).lerp(MOON, dark);
      sun.intensity = 4.2 * (0.25 + 0.75 * Math.min(1, height * 2.5 + 0.2)) * light + 0.85 * dark;
      // 0.58 (a darker shade for "volume") left the whole town dark and grey (the player, 2026-10-09): the sky light as it was.
      hemisphere.intensity = 0.8 * light + 0.4 * dark;
      {
        // A right angle and a little more round from the sun, lower than it.
        const fillAzimuth = Math.atan2(sunDirection.z, sunDirection.x) + (100 * Math.PI) / 180;
        const fillElevation = (32 * Math.PI) / 180;
        fill.position.set(Math.cos(fillAzimuth) * Math.cos(fillElevation), Math.sin(fillElevation), Math.sin(fillAzimuth) * Math.cos(fillElevation)).multiplyScalar(1000);
        // Never more than half the key on level ground (three-point lighting: the fill "up to half" the key).
        const keyOnGround = sun.intensity * Math.max(0, sunDirection.y);
        fill.intensity = Math.min(1.0 * light, (0.5 * keyOnGround) / Math.sin(fillElevation));
      }
      ambient.intensity = 0.07 * light + 0.08 * dark;
      fill.color.copy(FILL_WHITE);
      zenith.copy(DAY_ZENITH).lerp(NIGHT_ZENITH, dark);
      horizon.copy(DAY_HORIZON).lerp(DUSK_HORIZON, warm * light * 0.7).lerp(NIGHT_HORIZON, dark);
      // An overcast sky: the sun behind the clouds - much less of it, and what light there is comes from the whole grey sky
      if (overcast > 0) {
        sun.intensity *= 1 - 0.85 * overcast;
        hemisphere.intensity *= 1 + 0.15 * overcast;
        fill.intensity *= 1 - 0.4 * overcast;
        zenith.lerp(STORM_SKY, overcast * 0.85 * light);
        horizon.lerp(STORM_SKY, overcast * 0.7 * light);
      }
      // A lightning flash: the whole scene lit at once from the sky, cold white.
      if (flash > 0) {
        hemisphere.intensity += 2.6 * flash;
        ambient.intensity += 0.6 * flash;
        zenith.lerp(FLASH, flash * 0.6);
        horizon.lerp(FLASH, flash * 0.5);
      }
      sunColor.copy(DAY_SUN).lerp(DUSK_SUN, warm).multiplyScalar(light);
      // No town-wide haze (the player: the smoke stays where the fire is).
      void smog; void SMOG;
      scene.environmentIntensity = 0.6 * (0.2 + 0.8 * light) * (1 - smog * 0.4);
      cascades.syncLight();
      return dark;
    },
    directShare() {
      // On level ground: the sun by the sine of its height, the sky fill whole
      const direct = sun.intensity * Math.max(0, sunDirection.y);
      const fillUp = fill.intensity * Math.max(0, fill.position.y / Math.max(1e-6, fill.position.length()));
      const diffuse = hemisphere.intensity + fillUp + ambient.intensity;
      return direct / Math.max(1e-6, direct + diffuse);
    },
    setSmog(k) { smog = Math.max(0, Math.min(1, k)); },
    setWeather(k, f) { overcast = Math.max(0, Math.min(1, k)); flash = Math.max(0, Math.min(1.5, f)); },
    setQuality(next) {
      cascades.setEnabled(next.shadows, next.shadowMapSize);
    },
    dispose() {
      scene.onAfterRender = () => {};
      for (const light of cascades.lights) scene.remove(light, light.target);
      scene.remove(sky, hemisphere, ambient, fill);
      sky.geometry.dispose();
      skyMaterial.dispose();
      envTarget.dispose();
      scene.environment = null;
      hemisphere.dispose();
      ambient.dispose();
      cascades.dispose();
    },
  };
}

/** The sun's shadow in three's shaders: its cascades (`sunCascades.ts`) and its normal offset by the slope of the receiver */
export function sunShadowChunks(): void {
  cascadedSunChunks();
  slopeScaledShadowOffset();
}

/** The sun's normal offset by the slope of the receiver: as Unity's URP biases a shadow */
function slopeScaledShadowOffset(): void {
  const chunk = ShaderChunk.shadowmap_vertex;
  const plain = 'shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );';
  if (!chunk.includes(plain)) {
    if (chunk.includes('sunAxis')) return;
    throw new Error('three.js shadowmap_vertex changed: the slope-scaled sun offset no longer applies');
  }
  ShaderChunk.shadowmap_vertex = chunk.replace(plain, `{ vec3 sunAxis = normalize( vec3( directionalShadowMatrix[ i ][ 0 ][ 2 ], directionalShadowMatrix[ i ][ 1 ][ 2 ], directionalShadowMatrix[ i ][ 2 ][ 2 ] ) );
			#ifdef USE_REVERSED_DEPTH_BUFFER
				sunAxis = - sunAxis; // the shadow depth runs from the sun, not into it (three's LightShadow: the reversed projection, no z remap)
			#endif
			float grazing = 1.0 - clamp( - dot( shadowWorldNormal, sunAxis ), 0.0, 1.0 );
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias * ( 0.4 + 2.6 * grazing ), 0 ); }`);
}
