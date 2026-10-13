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
  type WebGLRenderer,
} from 'three';
import { m } from '@world/units';

/**
 * Sky, sun and atmosphere.
 *
 * The scene used to be lit by a hemisphere fill at 1.28, an ambient at 0.26 and
 * a sun almost overhead. Everything was therefore lit from every direction at
 * once, which is exactly the recipe for a flat image: measured on a hill fourteen
 * units high and a hundred and fifty across, the shading difference between its
 * slope and the flat ground beside it was under two percent — the hill was
 * invisible, and the terrain looked painted rather than modelled.
 *
 * What is here instead is one dominant, low, warm key light with real shadows, a
 * cool sky fill about a fifth of its strength, and a gradient sky that also
 * serves as the environment map so metal and water have something to reflect.
 * That ratio is what makes a slope read as a slope.
 */

/**
 * Sun elevation above the horizon.
 *
 * Low enough that a slope of a few degrees changes how much light it takes, and
 * that everything standing on the ground throws a shadow long enough to read.
 * Much higher and the scene flattens; much lower and shadows stretch until the
 * map is more shadow than ground.
 */
//
// It was 38 degrees: a shadow 1.28 times as long as what cast it, so a thin
// lamp column or a small figure seen from above threw a long dark shape that
// read as a shadow with nothing casting it. At 47 it is 0.93 times as long,
// and still falls clear of its caster onto the ground.
const SUN_ELEVATION = (47 * Math.PI) / 180;
/**
 * Sun bearing — and the one number that decides whether shadows are VISIBLE.
 *
 * The camera looks along the +x/+z diagonal (`isoViewport`, azimuth 45°). A sun
 * on the OPPOSITE diagonal back-lights the scene: every shadow then falls
 * towards the camera and hides behind the object that cast it. Measured with the
 * sun at -128°, turning shadows off changed the rendered image by 0.08 of a
 * luminance level — the shadow map was correct, fully populated, and invisible.
 *
 * Nearly behind the camera (14°, the camera's home bearing 13.5°) every face
 * the player saw was lit flat and each shadow lay hidden behind its caster:
 * the land read without depth, and a cloud covered its own shadow. The sun
 * now stands well to the camera's left and a little behind it - side light,
 * the diorama's (the player's picture, 2026-10-07): the relief modelled in
 * light and shade, the shadows thrown sideways across the ground where they
 * show, the faces towards the camera still lit.
 */
const SUN_AZIMUTH = (-87 * Math.PI) / 180;
const SUN_DISTANCE = m(640);
/**
 * Depth offset of the shadow test, WORLD units (4 cm): enough to keep a lit
 * surface out of its own shadow, far too little to part a shadow from its caster.
 */
const SHADOW_BIAS_WORLD = m(0.04);
/**
 * Smallest half-width of the shadow frustum, world units (5 m). Follows the
 * closest zoom (`MIN_HALF_HEIGHT` in isoViewport.ts), so a person seen close up
 * still casts a crisp shadow.
 */
const SHADOW_SPAN_MIN = m(4.8);
const WORLD_UP = new Vector3(0, 1, 0);

export interface EnvironmentQuality {
  /** Side of the sun's shadow map. */
  readonly shadowMapSize: number;
  readonly shadows: boolean;
}

export interface SceneEnvironment {
  readonly sun: DirectionalLight;
  readonly skyColor: Color;
  /** Points the shadow frustum at what the camera is looking at. */
  follow(target: Vector3, halfWidth: number, halfHeight: number, view?: Vector3, rise?: number): void;
  setQuality(quality: EnvironmentQuality): void;
  /**
   * The time of day, minutes after midnight: the sun's path, the sky, the
   * light; the moon at night. Returns how dark it is, 0 by day to 1 at night.
   */
  setTimeOfDay(minutes: number): number;
  /** Smoke in the air, 0..1: the fog closes in and browns, the light dims. */
  setSmog(k: number): void;
  /**
   * The weather on the light (`world/weather.ts`): how overcast (0 clear ..
   * 1 a storm sky - the sun dimmed behind the clouds, the sky greyed, the
   * shadows softened into the sky's light) and how bright a lightning flash
   * is this moment (0 none .. 1).
   */
  setWeather(overcast: number, flash: number): void;
  /**
   * How much of the light on level ground comes straight from the sun, 0..1
   * (global = diffuse + direct * cos(zenith); a shadow takes the direct part
   * only, the sky's light still arrives): what a cloud's shadow can take away.
   */
  directShare(): number;
  dispose(): void;
}

const SKY_VERTEX = `
  varying vec3 vSkyDirection;
  void main() {
    vSkyDirection = normalize(position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
    gl_Position.z = gl_Position.w;
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
    // A broad, soft glow around the sun, and a tighter core inside it. Enough
    // to tell the eye where the light comes from without drawing a disc.
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

/** How far the sun the shadows are cast by may drift from the true one before it is moved (rad): 0.1 degree. */
const SUN_STEP = (0.1 * Math.PI) / 180;
/** How far the view may go from the ground point the shadow grid hangs on before it is hung on another. */
const GRID_REACH = m(100);

/**
 * THE SHADOW MAP MOVED IN WHOLE TEXELS OF THE GROUND (Microsoft, "Common
 * Techniques to Improve Shadow Depth Maps", Moving the Light in Texel-Sized
 * Increments): the light's frustum is centred on the view, its middle rounded
 * to a texel grid that stays put on the ground, so a shadow's edge lands on
 * the same texels frame after frame and does not shimmer as the view moves.
 * The grid hangs on a frame of the ground: a point of the map near the view
 * (`origin`), its east and its up. Hung on another point when the view goes
 * on, it is hung so the texel under the view stays where it was.
 *
 * The sun the light falls from is held in that frame and moved only once the
 * true one has drifted `SUN_STEP` from it: a sun turning every frame turns
 * the grid with it - the same shimmer.
 */
class GroundShadowGrid {
  /** The map point the frame hangs on, and whether there is one. */
  private ox = 0;
  private oy = 0;
  private hung = false;
  /** The frame, three's space: origin and axes (east, up, south). */
  private readonly o = new Vector3();
  private readonly fx = new Vector3();
  private readonly fy = new Vector3();
  private readonly fz = new Vector3();
  /** The grid's offset in the frame (light-space u, v), so a new hanging keeps the texels. */
  private gu = 0;
  private gv = 0;
  /** The sun held, in the frame. */
  private readonly held = new Vector3();
  private holding = false;
  /** How many times the sun was moved (`SUN_STEP`): the F9 monitor and the specs read it. */
  steps = 0;
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly r = new Vector3();
  private readonly u = new Vector3();
  private readonly ref = new Vector3();
  private readonly c = new Vector3();
  /** The last rounded centre, in the frame (from its origin). */
  private readonly last = new Vector3();

  /** Where a point of the ground (map x, y, height) is drawn, three's space, into `out`. */
  private drawn(x: number, y: number, h: number, out: Vector3): Vector3 {
    return out.set(x, h, -y);
  }

  /** The frame at the map point (ox, oy), drawn now. */
  private frame(): void {
    this.drawn(this.ox, this.oy, 0, this.o);
    this.drawn(this.ox + m(1), this.oy, 0, this.fx).sub(this.o);
    this.drawn(this.ox, this.oy, m(1), this.fy).sub(this.o).normalize();
    this.fx.addScaledVector(this.fy, -this.fx.dot(this.fy)).normalize();
    this.fz.crossVectors(this.fx, this.fy);
  }

  /** A three's-space direction in the frame, into `out`. */
  private toFrame(d: Vector3, out: Vector3): Vector3 {
    return out.set(d.dot(this.fx), d.dot(this.fy), d.dot(this.fz));
  }

  /** A frame direction in three's space, into `out`. */
  private fromFrame(d: Vector3, out: Vector3): Vector3 {
    return out.set(0, 0, 0).addScaledVector(this.fx, d.x).addScaledVector(this.fy, d.y).addScaledVector(this.fz, d.z);
  }

  /**
   * The light space for this frame. `centre` (three's space) is what the map
   * is centred on, at map point (mapX, mapY); `sun` the true sun (three's
   * space, unit); `texel` the map's texel (world units). Into `outCentre` the
   * rounded centre, into `outSun` the sun to cast by, into `outRight`/`outUp`
   * the light space's axes - the shadow camera's x and y: its `up` must be
   * `outUp`, or the map's texels are not the grid rounded to.
   */
  place(
    centre: Vector3, mapX: number, mapY: number, sun: Vector3, texel: number,
    outCentre: Vector3, outSun: Vector3, outRight: Vector3, outUp: Vector3,
  ): void {
    if (this.hung) this.frame();
    if (!this.hung || this.o.distanceTo(centre) > GRID_REACH) {
      // Carry the held sun, the last rounded centre and the light's axes
      // over to the new frame as they are.
      const hadGrid = this.hung;
      if (hadGrid) {
        this.fromFrame(this.held, this.s);
        this.fromFrame(this.last, this.p).add(this.o);
        this.fromFrame(this.r, this.ref);
        this.fromFrame(this.u, this.c);
      }
      this.ox = mapX;
      this.oy = mapY;
      this.hung = true;
      this.frame();
      if (hadGrid) {
        this.toFrame(this.s, this.held);
        this.toFrame(this.ref, this.r);
        this.toFrame(this.c, this.u);
        // The last rounded centre stays a corner of the grid.
        this.toFrame(this.p.sub(this.o), this.p);
        this.gu = this.p.dot(this.r);
        this.gv = this.p.dot(this.u);
      } else {
        this.gu = 0;
        this.gv = 0;
      }
    }
    // The centre in the frame.
    this.toFrame(this.p.subVectors(centre, this.o), this.p);
    // The sun, held in the ground's frame.
    this.toFrame(sun, this.s);
    if (!this.holding || this.held.angleTo(this.s) > SUN_STEP) {
      if (this.holding) {
        // Turned by the least turn taking the old sun to the new: the right
        // kept, made square to the new sun - no twist about it on top. And
        // turned about the ground under the view, not about the frame's
        // origin up to 100 m off: the centre keeps its place in its texel.
        this.steps++;
        const pu = this.p.dot(this.r) - this.gu, pv = this.p.dot(this.u) - this.gv;
        this.held.copy(this.s);
        this.r.addScaledVector(this.held, -this.r.dot(this.held)).normalize();
        this.u.crossVectors(this.held, this.r).normalize();
        this.gu = this.p.dot(this.r) - pu;
        this.gv = this.p.dot(this.u) - pv;
      } else {
        this.held.copy(this.s);
        this.holding = true;
        this.axes(this.held);
      }
    }
    // The centre rounded to the grid in the light's axes.
    const cu = Math.round((this.p.dot(this.r) - this.gu) / texel) * texel + this.gu;
    const cv = Math.round((this.p.dot(this.u) - this.gv) / texel) * texel + this.gv;
    const cw = this.p.dot(this.held);
    this.p.copy(this.r).multiplyScalar(cu).addScaledVector(this.u, cv).addScaledVector(this.held, cw);
    this.last.copy(this.p);
    this.fromFrame(this.p, outCentre).add(this.o);
    this.fromFrame(this.held, outSun);
    this.fromFrame(this.r, outRight);
    this.fromFrame(this.u, outUp);
  }

  /**
   * The light's first right and up (in the frame) for a sun (in the frame):
   * right level, square to the ground's up, unless the
   * sun is nearly overhead, then square to the ground's south.
   */
  private axes(sun: Vector3): void {
    this.ref.set(0, Math.abs(sun.y) < 0.95 ? 1 : 0, Math.abs(sun.y) < 0.95 ? 0 : 1);
    this.r.crossVectors(this.ref, sun).normalize();
    this.u.crossVectors(sun, this.r).normalize();
  }
}

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

  // The sky doubles as the environment map, so water, glass and metal reflect
  // the same sky the player sees instead of a flat grey.
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

  // A near-neutral sky fill: the saturated blue it was tinted every shadow
  // blue at close zoom (a parapet's shadow on a roof read as blue paint).
  // Neutral, a touch warm: the blue-white sky fill turned every shadow on
  // the grass teal (the player, 2026-10-07: dark, ugly colours).
  // Strong enough that a shaded hillside stays green: at a tenth of the sun
  // the side of every hill turned near black and the land read as mud (the
  // player, 2026-10-07); open sky gives shade a fifth to a third of the light.
  const hemisphere = new HemisphereLight(0xe6e4da, 0x6a6b4c, 0.8);
  hemisphere.name = 'sky-fill';
  scene.add(hemisphere);

  const ambient = new AmbientLight(0xdfe9f2, 0.07);
  ambient.name = 'ambient-floor';
  scene.add(ambient);

  const sun = new DirectionalLight(0xfff0cf, 3.6);
  sun.name = 'sun';
  sun.castShadow = quality.shadows;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  // Shadow bias: enough to kill acne on the terrain, not enough to detach a
  // shadow from the thing casting it.
  //
  // normalBias was 0.6 world units. That is 24 cm at this scale, and it is
  // applied along the receiver's normal BEFORE the depth comparison, so every
  // shadow was shifted off its caster - classic peter-panning. On a viaduct
  // it is at its most obvious, because the deck is thin, high above its
  // receiver and casts the longest shadow in the scene: the dark band on the
  // grass detached from the piers holding it up and read as a separate,
  // broken smear. A pier 1.8 units across cast a shadow offset by a third of
  // its own width.
  //
  // And `bias` is in NORMALISED depth, so what it means in the world is the
  // bias times the shadow camera's depth range. It was -0.0005 over a fixed
  // range of 20 to 3840 units: 1.9 units (0.76 m) of offset along the light,
  // which slid every shadow off its caster - a car's shadow drawn apart from
  // the car, a pole's apart from the pole. The range now follows the frustum
  // (`fitDepth`) and the bias is stated in world units, `SHADOW_BIAS_WORLD`.
  sun.shadow.normalBias = m(0.02); // then scaled to the texel in `fitDepth`
  /** Height above the view's ground that the depth range last made room for. */
  let depthRise = 0;
  /** How far back along the sun the light stands (`fitDepth`). */
  let sunDistance = SUN_DISTANCE;
  const fitDepth = (halfSpan: number): void => {
    // Room along the light for everything in the frustum, the tallest roof
    // included: a tower whose top lay nearer the sun than `near` cast nothing.
    const reach = halfSpan * 1.6 + m(96) + depthRise;
    // The light stands as far back as the frustum reaches: at the fixed
    // 1600 units, a view of the whole map put the ground on the sun's side
    // more than that away BEHIND the light, out of the shadow map - half
    // the map in shadow, half not (the player, 2026-10-07).
    sunDistance = Math.max(SUN_DISTANCE, reach + m(20));
    sun.shadow.camera.near = Math.max(m(0.4), sunDistance - reach);
    sun.shadow.camera.far = sunDistance + reach;
    // Bias in proportion to one shadow texel (world units across): a fixed
    // 0.1 / 0.05 unit held at close zoom, but from the middle distance a
    // texel is 0.4-1 unit, far more than the bias, and every wall and roof
    // shadowed itself in diagonal stripes - the "noise" over the whole town
    // (the player, 2026-10-09; gone on the shadowless low tier). Microsoft,
    // "Common Techniques to Improve Shadow Depth Maps": the slope/normal
    // offset must cover the texel footprint. Close up the texel is small and
    // so is the bias, so shadows stay on their casters.
    const texel = (2 * halfSpan) / Math.max(1, sun.shadow.mapSize.x);
    sun.shadow.normalBias = Math.max(m(0.02), texel * 1.5);
    sun.shadow.bias = -Math.max(SHADOW_BIAS_WORLD, texel * 1.2) / (sun.shadow.camera.far - sun.shadow.camera.near);
  };
  fitDepth(SHADOW_SPAN_MIN);
  scene.add(sun, sun.target);

  // THE FILL LIGHT, the second light of the standard rig (Shawn Hargreaves,
  // "The standard lighting rig"; three-point lighting): dimmer than the key,
  // from about a right angle to it, casting no shadow. It gives the slopes
  // turned from the sun their own shading instead of one flat dark, so a
  // hill reads round from every side (the player, 2026-10-07: "more lights").
  // Directional, at the scene's origin, its direction set with the sun's.
  const fill = new DirectionalLight(0xf2f2ee, 0);
  fill.name = 'fill';
  fill.castShadow = false;
  scene.add(fill);

  let span = -1;
  const lightRight = new Vector3();
  const lightUp = new Vector3();
  const snapped = new Vector3();
  /** The sun the light falls from: the true one, moved in steps (`GroundShadowGrid`). */
  const castSun = new Vector3();
  const grid = new GroundShadowGrid();
  const top = new Vector3();
  const offset = new Vector3();
  const centre = new Vector3();

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
    follow(target, halfWidth, halfHeight, view, rise = 0) {
      sky.position.copy(target);
      sky.scale.setScalar(m(3_600));
      lightRight.crossVectors(WORLD_UP, sunDirection).normalize();
      lightUp.crossVectors(sunDirection, lightRight).normalize();
      // What the camera sees is not a patch of ground but a column: the
      // ground under the middle of the screen AND everything standing on the
      // same line of sight up to the tallest roof. Fitted to the ground alone,
      // a terrace 60 m up at close zoom lay outside the shadow map - drawn in
      // full sun with a tower right beside it. The frustum is centred on the
      // column and widened by its extent in the light's view.
      let du = 0;
      let dv = 0;
      if (view && rise > 0 && view.y < -0.05) {
        top.copy(target).addScaledVector(view, -rise / -view.y);
        offset.subVectors(top, target);
        du = offset.dot(lightRight);
        dv = offset.dot(lightUp);
      }
      centre.copy(target)
        .addScaledVector(lightRight, du / 2)
        .addScaledVector(lightUp, dv / 2);
      // The shadow frustum is fitted to what the camera can see. Too wide and
      // every shadow is a blurred smear; too narrow and shadows pop in at the
      // edge of the screen.
      //
      // The floor used to be 220 units — a frustum 440 units across however
      // far the camera zoomed in. At 2048 texels that is 8 cm a texel, wider
      // than a person's leg, and the filtered shadow of a walking citizen
      // dissolved into smoke. It now follows the view down to close zoom.
      const want = Math.max(SHADOW_SPAN_MIN, Math.max(halfWidth, halfHeight) * 1.25) +
        Math.max(Math.abs(du), Math.abs(dv)) / 2;
      if (Math.abs(want - span) > span * 0.08 || Math.abs(rise - depthRise) > 20) {
        span = want;
        depthRise = rise;
        sun.shadow.camera.left = -span;
        sun.shadow.camera.right = span;
        sun.shadow.camera.top = span;
        sun.shadow.camera.bottom = -span;
        fitDepth(span);
        sun.shadow.camera.updateProjectionMatrix();
      }
      // Snap the frustum to whole shadow texels of the ground (`GroundShadowGrid`).
      // Following the view continuously slid every texel under the scene each
      // frame, so small shadows crawled and flickered whenever the camera or
      // the figure moved, and read as visible "only in motion".
      const texel = (2 * span) / sun.shadow.mapSize.x;
      grid.place(centre, centre.x, -centre.z, sunDirection, texel, snapped, castSun, lightRight, lightUp);
      sun.position.copy(snapped).addScaledVector(castSun, sunDistance);
      sun.target.position.copy(snapped);
      sun.target.updateMatrixWorld();
      // The shadow camera's axes are the grid's (three's `LightShadow`
      // looks at the target with the camera's `up`).
      sun.shadow.camera.up.copy(lightUp);
    },
    setTimeOfDay(minutes) {
      const hour = (((minutes / 60) % 24) + 24) % 24;
      // The sun's day: up at six, highest at noon, down at six, crossing the
      // sky from east to west round the bearing that throws shadows well.
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
      // Low sun is warm and weaker; the moon is blue. Daylight is near white
      // (some 5500 K with the sun high); a sun of (1, 0.94, 0.81), and half
      // the blue at the morning the game opens on, turned the whole land a
      // yellow olive (the player, 2026-10-07).
      const warm = Math.max(0, 1 - height * 1.6);
      sun.color.setRGB(1, 0.96 - warm * 0.12, 0.9 - warm * 0.28).lerp(MOON, dark);
      sun.intensity = 4.2 * (0.25 + 0.75 * Math.min(1, height * 2.5 + 0.2)) * light + 0.85 * dark;
      // 0.58 (a darker shade for "volume") left the whole town dark and
      // grey (the player, 2026-10-09): the sky light as it was.
      // At night the town is lit from its own sky - the glow of its lights
      // off the haze and the clouds, a bluish grey - enough that a facade
      // reads as a facade, not as a black stain round its windows (the
      // player, 2026-10-13); 0.2 drew the night town as a silhouette.
      hemisphere.intensity = 0.8 * light + 0.4 * dark;
      {
        // A right angle and a little more round from the sun, lower than it.
        const fillAzimuth = Math.atan2(sunDirection.z, sunDirection.x) + (100 * Math.PI) / 180;
        const fillElevation = (32 * Math.PI) / 180;
        fill.position.set(Math.cos(fillAzimuth) * Math.cos(fillElevation), Math.sin(fillElevation), Math.sin(fillAzimuth) * Math.cos(fillElevation)).multiplyScalar(1000);
        // Never more than half the key on level ground (three-point
        // lighting: the fill "up to half" the key). With the sun a few
        // degrees up at the morning the game opens on, a fixed 1.0 at 32
        // degrees out-lit the sun and drew every hill from the side: dark
        // blotches over the whole map from afar (the player, 2026-10-08).
        const keyOnGround = sun.intensity * Math.max(0, sunDirection.y);
        fill.intensity = Math.min(1.0 * light, (0.5 * keyOnGround) / Math.sin(fillElevation));
      }
      ambient.intensity = 0.07 * light + 0.08 * dark;
      fill.color.copy(FILL_WHITE);
      zenith.copy(DAY_ZENITH).lerp(NIGHT_ZENITH, dark);
      horizon.copy(DAY_HORIZON).lerp(DUSK_HORIZON, warm * light * 0.7).lerp(NIGHT_HORIZON, dark);
      // An overcast sky: the sun behind the clouds - much less of it, and
      // what light there is comes from the whole grey sky - and the sky greyed.
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
      return dark;
    },
    directShare() {
      // On level ground: the sun by the sine of its height, the sky fill
      // whole (its sky side faces up), the fill light by its own height, the
      // ambient floor.
      const direct = sun.intensity * Math.max(0, sunDirection.y);
      const fillUp = fill.intensity * Math.max(0, fill.position.y / Math.max(1e-6, fill.position.length()));
      const diffuse = hemisphere.intensity + fillUp + ambient.intensity;
      return direct / Math.max(1e-6, direct + diffuse);
    },
    setSmog(k) { smog = Math.max(0, Math.min(1, k)); },
    setWeather(k, f) { overcast = Math.max(0, Math.min(1, k)); flash = Math.max(0, Math.min(1.5, f)); },
    setQuality(next) {
      sun.castShadow = next.shadows;
      if (sun.shadow.mapSize.x !== next.shadowMapSize) {
        sun.shadow.mapSize.set(next.shadowMapSize, next.shadowMapSize);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
    },
    dispose() {
      scene.remove(sky, hemisphere, ambient, sun, sun.target, fill);
      sky.geometry.dispose();
      skyMaterial.dispose();
      envTarget.dispose();
      scene.environment = null;
      hemisphere.dispose();
      ambient.dispose();
      sun.dispose();
    },
  };
}

/**
 * The sun's normal offset by the slope of the receiver: as Unity's URP biases
 * a shadow (`Shadows.hlsl` `ApplyShadowBias`: the normal bias times
 * `1 - saturate(dot(lightDirection, normalWS))`), small on a face turned to
 * the sun, large where the light grazes it. Fixed for every face, a low sun
 * (the morning, the evening) drew every paving and porch floor shadowing
 * itself in diagonal stripes (the player, 2026-10-13, "pisca pisca"); raised
 * for every face, every shadow parted from its caster. The light's direction
 * is the depth axis of its shadow matrix (an orthographic light: the third
 * row), so nothing new is passed in. In its own block: three unrolls the
 * loop without braces. Patched once, before any program is built.
 */
export function slopeScaledShadowOffset(): void {
  const chunk = ShaderChunk.shadowmap_vertex;
  const plain = 'shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );';
  if (!chunk.includes(plain)) {
    if (chunk.includes('sunAxis')) return;
    throw new Error('three.js shadowmap_vertex changed: the slope-scaled sun offset no longer applies');
  }
  ShaderChunk.shadowmap_vertex = chunk.replace(plain, `{ vec3 sunAxis = normalize( vec3( directionalShadowMatrix[ i ][ 0 ][ 2 ], directionalShadowMatrix[ i ][ 1 ][ 2 ], directionalShadowMatrix[ i ][ 2 ][ 2 ] ) );
			float grazing = 1.0 - clamp( - dot( shadowWorldNormal, sunAxis ), 0.0, 1.0 );
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias * ( 0.4 + 2.6 * grazing ), 0 ); }`);
}
