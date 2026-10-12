import {
  Color, DepthTexture, HalfFloatType, Matrix4, Mesh, NoBlending,
  RedFormat, Scene, ShaderMaterial, UnsignedByteType, Vector2, Vector3, Vector4, WebGLRenderTarget, type Camera, type Texture, type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { WORLD_HALF } from '@world/bounds';
import { PLANET_RADIUS } from '@core/cubeSphere';
import { planetCentre, planetDrawnSphere, planetInverse, planetMotion, planetPointInto } from './planet/bend';
import { AIR_GLSL, ATMOSPHERE_TOP, type Air, SURFACE_AIR } from './planet/air';
import { m, perM } from '@world/units';
import { drawnCloudHeight, driftedCloud, type PlacedCloud } from '@world/clouds';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

import type { QualityLevel, QualitySettings } from './quality';
import { fullScreenTriangle } from './uploads';

/**
 * The post chain: ambient occlusion, then anti-aliasing, then tone mapping.
 *
 * ## Why ambient occlusion earns its cost here
 *
 * Nearly every contact in this scene is a flat surface meeting another flat
 * surface at a small height difference — asphalt to kerb, kerb to footway,
 * footway to verge, a pier standing on the ground, a deck over a road. Direct
 * light cannot describe any of those: the two surfaces face the same way, so
 * they take the same amount of sun and the edge between them vanishes. Ground
 * truth ambient occlusion darkens exactly those creases, and it is the single
 * change that makes the road read as built into the ground rather than printed
 * on it.
 *
 * ## MSAA and SMAA
 *
 * The composer's half-float target is multisampled (4x where the GPU allows):
 * thin geometry - lane lines, kerbs, a road's edge seen from afar - is sampled
 * at every pixel it crosses. SMAA then runs on the resolved image, one pass,
 * and - unlike FXAA - keeps the thin bright lines of lane markings sharp
 * instead of smearing them.
 *
 * At the lowest quality tier the composer is skipped entirely and the scene is
 * drawn straight to the canvas with the driver's own MSAA, which is what keeps a
 * weak GPU playable.
 */


export interface PostChain {
  readonly enabled: boolean;
  /** What the scene is drawn into (null: the screen): shaders are compiled ahead for it. */
  readonly target: WebGLRenderTarget | null;
  render(delta: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /**
   * How dark it is, 0 by day to 1 at night: the bloom is for lights in the
   * dark (lamps, headlights, lit windows). By day it set the white paint of
   * every zebra and line glowing in the sun; it is off then (and its passes
   * with it), and comes up with the dusk.
   */
  setNight(dark: number): void;
  /**
   * How far the view has gone out to space (0 the ground .. 1), on the
   * planet: the sun's disc and the brightest stars bloom there, by day too.
   */
  setSpace(share: number): void;
  /**
   * How much of the light on the ground comes straight from the sun
   * (`SceneEnvironment.directShare`): all a cloud's shadow can take away.
   */
  setDirectShare(share: number): void;
  /**
   * On the planet, the air round it as drawn this frame (`planet/space.ts`
   * `Space.air`): a cloud's shadow takes from the ground's light seen through
   * it, never from the air's own.
   */
  setAir(air: Air): void;
  /**
   * The sky the player set (`Atmosphere`), the light it is lit by, and
   * whether the map is seen as a model over the void (building it), when
   * the air round it is drawn too: the backdrop and the haze of distance.
   */
  setAtmosphere(atmosphere: Atmosphere, sun: Vector3, skyColor: Color, sunLight: Color, backdrop: boolean,
    /** How far in front of the camera the view's equivalent eye stands (`uEyeShift`): 0 in perspective. */
    eyeShift?: number): void;
  /** The clouds the player placed (`world/clouds.ts`). */
  setPlacedClouds(clouds: readonly PlacedCloud[]): void;
  /** How far the wind has carried the clouds, on the map (`world/clouds.ts` driftedCloud). */
  setCloudDrift(x: number, y: number): void;
  /**
   * The painted fog (`render/fogLayer.ts`): its map, the slab of ground it
   * lies over, and the map's settings - or none.
   */
  setGroundFog(fog: { texture: Texture; low: number; high: number; density: number } | null): void;
  /**
   * The contact shading on or off. Out at the planet's globe it is a shade
   * of a unit on ground thousands away, and its depth-rebuilt normals drew a
   * dark line across the globe: off there.
   */
  setAmbientOcclusion(on: boolean): void;
  /**
   * The camera's motion blur (`MOTION_BLUR`): the share of a frame the
   * shutter is open (0 off). On in free flight only.
   */
  setMotionBlur(shutter: number): void;
  dispose(): void;
}

/**
 * THE CAMERA'S MOTION BLUR, as a full-screen pass from the depth alone
 * (Rosado, "Motion Blur as a Post-Processing Effect", GPU Gems 3 ch. 27):
 * each pixel's point rebuilt from the depth with the inverse view-projection,
 * projected by the last frame's, and the image sampled along the difference.
 * On the planet three's space is set down anew each frame (`planetMotion`):
 * the last frame's matrix is taken through it, so the still ground does not
 * smear when only the planet's setting moved. The camera's motion only
 * (still things blur, moving ones as the camera sees them); the blur is held
 * to `MOTION_BLUR_MOST` of the screen, so a turn never smears it whole.
 */
const MOTION_BLUR_SAMPLES = 9;
const MOTION_BLUR_MOST = 0.045;
const MOTION_BLUR = {
  uniforms: {
    tDiffuse: { value: null as Texture | null },
    tDepth: { value: null as Texture | null },
    uInverseViewProjection: { value: new Matrix4() },
    uLastViewProjection: { value: new Matrix4() },
    uShutter: { value: 0 },
  },
  vertexShader: `varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform mat4 uInverseViewProjection;
    uniform mat4 uLastViewProjection;
    uniform float uShutter;
    varying vec2 vUv;
    void main() {
      vec4 here = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).x;
      vec4 world = uInverseViewProjection * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      world /= world.w;
      vec4 last = uLastViewProjection * world;
      vec2 velocity = last.w > 0.0 ? (vUv - (last.xy / last.w * 0.5 + 0.5)) * uShutter : vec2(0.0);
      float length2 = length(velocity);
      if (length2 > ${MOTION_BLUR_MOST.toFixed(4)}) velocity *= ${MOTION_BLUR_MOST.toFixed(4)} / length2;
      if (length2 < 0.0008) { gl_FragColor = here; return; }
      vec4 sum = here;
      for (int i = 1; i < ${MOTION_BLUR_SAMPLES}; i++) {
        float t = float(i) / float(${MOTION_BLUR_SAMPLES - 1}) - 0.5;
        sum += texture2D(tDiffuse, vUv + velocity * t);
      }
      gl_FragColor = sum / float(${MOTION_BLUR_SAMPLES});
    }`,
};

/**
 * The player's sky (Paisagem > Céu e clima): how much of it is cloud, at
 * what height and how thick the layer is, and how much mist lies over the
 * land and how high it reaches. World units.
 */
export interface Atmosphere {
  /**
   * How much of the sky the old setting covered (0..1). The sky draws only
   * the map's own clouds now (`world/clouds.ts`); a cover still kept is
   * turned into clouds of the map once (`main.ts`).
   */
  readonly clouds: number;
  readonly cloudBase: number;
  readonly cloudThickness: number;
  /** 0 none (the default: the map seen clear), 1 a thick mist. */
  readonly fog: number;
  readonly fogHeight: number;
}
export const DEFAULT_ATMOSPHERE: Atmosphere = { clouds: 0.4, cloudBase: m(180), cloudThickness: m(150), fog: 0, fogHeight: m(60) };

export function createPostChain(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  quality: QualitySettings,
  level: QualityLevel,
): PostChain {
  if (!quality.postProcessing) {
    return {
      enabled: false,
      target: null,
      render() {
        renderer.render(scene, camera);
      },
      setSize() {
        /* the renderer's own resize is enough */
      },
      setAmbientOcclusion() {
        /* no contact shading without the chain */
      },
      setMotionBlur() {
        /* no motion blur without the chain */
      },
      setSpace() {
        /* no bloom without the chain */
      },
      setNight() {
        /* no bloom without the chain */
      },
      setDirectShare() {
        /* no cloud shadows without the chain */
      },
      setAir() {
        /* no cloud shadows without the chain */
      },
      setAtmosphere() {
        /* no clouds or mist without the chain */
      },
      setGroundFog() {
        /* no painted fog without the chain */
      },
      setCloudDrift() {},
      setPlacedClouds() {
        /* no clouds without the chain */
      },
      dispose() {
        /* nothing owned */
      },
    };
  }

  const size = renderer.getSize(new Vector2());
  // The scene is drawn into targets that keep their depth, so the occlusion
  // pass reads it rather than drawing the whole scene a second time.
  const ratio = renderer.getPixelRatio();
  const target = new WebGLRenderTarget(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), {
    type: HalfFloatType,
    depthTexture: new DepthTexture(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio)),
    // Multisampled, its depth resolved into the texture the occlusion reads
    // (three's `resolveDepthBuffer`). With SMAA alone, on the resolved image, a
    // lane line or a road's edge narrower than a pixel at a distance broke into
    // dots (the player, 2026-10-06): what was never sampled cannot be smoothed.
    samples: Math.min(4, renderer.capabilities.maxSamples),
  });
  const composer = new EffectComposer(renderer, target);
  /**
   * The programs being built ahead (`compileAsync` below): the chain is not
   * taken apart until they are done. Disposed while three still polled their
   * completion (KHR_parallel_shader_compile), the GPU process answered
   * "glGetProgramiv: Program object expected" dozens of times at every boot,
   * when the view's camera is chosen and the chain made again.
   */
  const warming: Promise<unknown>[] = [];
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);
  // The passes, for the browser checks (a pass switched off to find what draws a defect).
  if (import.meta.env.DEV) Object.assign(window, { __composer: composer });
  const scenePass = new RenderPass(scene, camera);
  composer.addPass(scenePass);
  /**
   * The depth the scene was drawn with THIS frame. The composer ping-pongs
   * two targets and an odd number of swaps leaves it starting on the other
   * one next frame, so a pass bound to one target's depth read a stale or
   * empty buffer every other frame - the cloud shadows flickered on and off.
   */
  let sceneDepth: DepthTexture | null = target.depthTexture;
  /**
   * How much each pixel may be sharpened (`SHARP_MASK`), worked out from the
   * scene's depth right after the scene is drawn: the full-screen passes after
   * it draw into the same targets and overwrite that depth, so the grade at
   * the end of the chain could not read it.
   */
  const sharpMask = quality.sharpen > 0
    ? new WebGLRenderTarget(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), { type: UnsignedByteType, format: RedFormat, depthBuffer: false })
    : null;
  const sharpMaskQuad = sharpMask ? new FullScreenQuad(new ShaderMaterial({
    uniforms: { tDepth: { value: null }, uProjectionInverse: { value: new Matrix4() }, uSharpSpan: { value: new Vector2(m(0.1), m(0.3)) } },
    vertexShader: SHARP_MASK.vertexShader, fragmentShader: SHARP_MASK.fragmentShader,
    blending: NoBlending, depthTest: false, depthWrite: false,
  })) : null;
  {
    const draw = scenePass.render.bind(scenePass);
    scenePass.render = (...args: Parameters<RenderPass['render']>) => {
      sceneDepth = args[2].depthTexture;
      draw(...args);
      if (sharpMask && sharpMaskQuad) {
        const u = (sharpMaskQuad.material as ShaderMaterial).uniforms;
        u['tDepth']!.value = sceneDepth;
        (u['uProjectionInverse']!.value as Matrix4).copy(camera.projectionMatrixInverse);
        const gl = args[0];
        const previous = gl.getRenderTarget();
        gl.setRenderTarget(sharpMask);
        sharpMaskQuad.render(gl);
        gl.setRenderTarget(previous);
      }
    };
  }

  let gtao: GTAOPass | null = null;
  if (quality.ambientOcclusion) {
    gtao = new GTAOPass(scene, camera, size.x, size.y);
    gtao.output = GTAOPass.OUTPUT.Default;
    // Tuned for world units where a kerb is 0.4 high and a pier is 15 tall.
    // At a radius of 4 (1.6 m) the crease at every kerb's foot became a wide,
    // blotchy dark halo across the asphalt - a stain along every road edge,
    // worst where junction corners gather it. A crease is darkened over about
    // its own height; piers and buildings still read from the tighter pass.
    gtao.updateGtaoMaterial({
      radius: level === 'ultra' ? 1.3 : 1.0,
      distanceExponent: 1.6,
      thickness: 0.8,
      scale: 1.05,
      samples: level === 'ultra' ? 16 : 8,
      screenSpaceRadius: false,
    });
    gtao.blendIntensity = 0.85;
    // The occlusion is worked out from the depth the scene was just drawn
    // with (normals rebuilt from it). Left to itself the pass drew the whole
    // scene a second time, every mesh with an override material, for its own
    // depth and normals - a third full draw of the town each frame, with the
    // shadow map and the picture.
    const pass = gtao;
    const draw = pass.render.bind(pass);
    pass.render = (...args: Parameters<GTAOPass['render']>) => {
      const depth = args[2].depthTexture;
      if (depth && pass.depthTexture !== depth) pass.setGBuffer(depth);
      draw(...args);
    };
    // At half the resolution, as games do: occlusion is a soft shade, and
    // worked out per pixel at full size it cost as much as drawing the town.
    const resize = pass.setSize.bind(pass);
    pass.setSize = (width: number, height: number) => resize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
    composer.addPass(gtao);
    // GTAO's denoise shader is the slowest program to link on a cold start.
    // Submit both fullscreen programs now, while the rest of the game boots,
    // using the same depth input and target format as the first real pass.
    gtao.setGBuffer(target.depthTexture!);
    const quad = fullScreenTriangle();
    const warm = new Scene();
    warm.add(new Mesh(quad, gtao.gtaoMaterial), new Mesh(quad, gtao.pdMaterial));
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(gtao.gtaoRenderTarget);
    warming.push(renderer.compileAsync(warm, camera).catch((error: unknown) => {
      console.error('Ambient occlusion shader precompile failed', error);
    }).finally(() => quad.dispose()));
    renderer.setRenderTarget(previous);
  }

  // Light that is brighter than white spills a little round itself: the sun
  // on glass, lit windows and lamps at night. Only what is really bright
  // blooms; the day scene keeps its edges.
  // Gentle and tight, and only for real lights (lamps, headlamps, lanterns
  // over 1.05): stronger and wider, with every lit window over the threshold,
  // the night town was washed out in halos (the player, 2026-10-09).
  // The camera's motion blur in free flight (`MOTION_BLUR`), before the bloom: the scene's light smeared, then spilled.
  const motionBlur = quality.motionBlur ? new ShaderPass(MOTION_BLUR) : null;
  /** Whether the last frame's view is kept (false from a take-off: no smear from where the view was before). */
  let motionBlurHistory = false;
  if (motionBlur) {
    motionBlur.enabled = false;
    const blur = motionBlur;
    const lastView = new Matrix4(), lastProjection = new Matrix4(), lastMotion = new Matrix4();
    const draw = blur.render.bind(blur);
    blur.render = (...args: Parameters<ShaderPass['render']>) => {
      const u = blur.uniforms as Record<string, { value: unknown }>;
      u['tDepth']!.value = sceneDepth;
      const now = (u['uInverseViewProjection']!.value as Matrix4).multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const last = u['uLastViewProjection']!.value as Matrix4;
      if (motionBlurHistory) {
        last.multiplyMatrices(lastProjection, lastView);
        if (__PLANET__) last.multiply(lastMotion).multiply(planetInverse());
      } else last.copy(now);
      now.invert();
      lastView.copy(camera.matrixWorldInverse);
      lastProjection.copy(camera.projectionMatrix);
      if (__PLANET__) lastMotion.copy(planetMotion());
      motionBlurHistory = true;
      draw(...args);
    };
    composer.addPass(blur);
  }
  const bloomStrength = level === 'ultra' ? 0.22 : 0.18;
  const bloom = new UnrealBloomPass(new Vector2(size.x, size.y), bloomStrength, 0.32, 1.05);
  bloom.enabled = false;
  composer.addPass(bloom);
  // Its shaders built now, in parallel (KHR_parallel_shader_compile), not at
  // the first dusk: the bloom is off by day, and the frame it first came on
  // stopped while its fourteen passes' programs were built. Compiled for one
  // of its own targets, as it draws them (render targets are part of a
  // program's key).
  {
    // FullScreenQuad's own triangle (position and uv, no normals): the
    // attributes are part of a program's key, and a plane's normals built
    // another program than the one drawn.
    const quad = fullScreenTriangle();
    const warm = new Scene();
    for (const material of [bloom.materialHighPassFilter, ...bloom.separableBlurMaterials, bloom.compositeMaterial, bloom.blendMaterial]) {
      warm.add(new Mesh(quad, material));
    }
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(bloom.renderTargetsHorizontal[0]!);
    warming.push(renderer.compileAsync(warm, camera).catch(() => {}).finally(() => quad.dispose()));
    renderer.setRenderTarget(previous);
  }
  // Cloud shadows: soft patches drifting over the land, on the linear image
  // before tone mapping. Each pixel's world position is rebuilt from the
  // depth the scene was drawn with, so the patches lie on the ground, the
  // roads and the roofs alike, and scroll with the wind.
  const clouds = quality.cloudShadows || quality.skyClouds ? new ShaderPass(CLOUD_SHADOWS) : null;
  /** Whether its program is built (compiled ahead below): until then the pass is not drawn. */
  let cloudsReady = false;
  let cloudClock = 0;
  let placedClouds: readonly PlacedCloud[] = [];
  const cloudDrift = { x: 0, y: 0 };
  /** The clouds' bodies at a quarter of the pixels (`CLOUD_BODIES_MAIN`), drawn just before the pass that blends them in. */
  const bodiesSize = (n: number): number => Math.max(1, Math.ceil(n / 2));
  // Two, one written each frame while the other is read as its history (`uHistory`).
  const bodiesTargets = [0, 1].map(() => new WebGLRenderTarget(bodiesSize(size.x * ratio), bodiesSize(size.y * ratio), { type: HalfFloatType, depthBuffer: false }));
  let bodiesWrite = 0;
  /** Whether the target not written this frame holds the last frame's clouds, for this same view. */
  let historyValid = false;
  /** The view the history was made from: the camera's world matrix and projection, as last drawn. */
  const lastView = new Matrix4(), lastProjection = new Matrix4();
  let cloudFrame = 0;
  /** Whether the last frame drew any cloud (a history of nothing is none). */
  let hadClouds = false;
  let bodiesQuad: FullScreenQuad | null = null;
  // The clouds' shadow map (`CLOUD_SHADOW_MAP_MAIN`): drawn once a frame, read once a pixel.
  const shadowMapTarget = new WebGLRenderTarget(CLOUD_SHADOW_MAP, CLOUD_SHADOW_MAP, { type: HalfFloatType, depthBuffer: false });
  let shadowMapQuad: FullScreenQuad | null = null;
  if (clouds) {
    const pass = clouds;
    const fragment = CLOUD_SHADOWS.fragmentShader;
    const functions = fragment.slice(0, fragment.indexOf('void main()'));
    bodiesQuad = new FullScreenQuad(new ShaderMaterial({
      uniforms: pass.uniforms, vertexShader: CLOUD_SHADOWS.vertexShader,
      fragmentShader: functions + CLOUD_BODIES_MAIN,
      blending: NoBlending, depthTest: false, depthWrite: false,
    }));
    shadowMapQuad = new FullScreenQuad(new ShaderMaterial({
      uniforms: pass.uniforms, vertexShader: CLOUD_SHADOWS.vertexShader,
      fragmentShader: functions + CLOUD_SHADOW_MAP_MAIN,
      blending: NoBlending, depthTest: false, depthWrite: false,
    }));
    pass.uniforms['tCloudShadow']!.value = shadowMapTarget.texture;
    const quad = bodiesQuad;
    const mapQuad = shadowMapQuad;
    const shade = pass.render.bind(pass);
    pass.render = (...args: Parameters<ShaderPass['render']>) => {
      pass.uniforms['tDepth']!.value = sceneDepth;
      if (__PLANET__ && planetAir?.inside) planetAir.renderPerspective(args[0], camera);
      const on = (pass.uniforms['uCloudCount']!.value as number) > 0;
      pass.uniforms['uCloudsOn']!.value = on ? 1 : 0;
      const gl = args[0];
      if (on && (pass.uniforms['uShadowMapOn']!.value as number) > 0.5 && (pass.uniforms['uStrength']!.value as number) > 0) {
        const previous = gl.getRenderTarget();
        gl.setRenderTarget(shadowMapTarget);
        mapQuad.render(gl);
        gl.setRenderTarget(previous);
      }
      if (on) {
        // With the view still, fewer steps and the last frame blended in
        // (Playdead's TAA feedback); moving, the full steps and no history -
        // nothing is carried across a change of view, so nothing trails.
        const u = pass.uniforms as Record<string, { value: unknown }>;
        const still = historyValid;
        u['uSteps']!.value = still ? CLOUD_STEPS_STILL : CLOUD_STEPS_MOVING;
        u['uHistory']!.value = still ? CLOUD_HISTORY : 0;
        u['uFrame']!.value = still ? cloudFrame++ % 4096 : 0;
        const write = bodiesTargets[bodiesWrite]!, read = bodiesTargets[1 - bodiesWrite]!;
        u['tCloudHistory']!.value = read.texture;
        const previous = gl.getRenderTarget();
        gl.setRenderTarget(write);
        quad.render(gl);
        gl.setRenderTarget(previous);
        u['tClouds']!.value = write.texture;
        bodiesWrite = 1 - bodiesWrite;
      }
      shade(...args);
    };
    composer.addPass(clouds);
    // Its program built now, in parallel (KHR_parallel_shader_compile), for
    // the composer's target it draws into, as the bloom's and GTAO's are: on
    // the planet it carries the whole air (`planet/air.ts`), and built at its
    // first frame it stopped the opening for 2.6 s (profile of 2026-10-10).
    // With its two inner programs, the bodies' and the shadow map's, each for
    // the target it draws into.
    {
      const quad = fullScreenTriangle();
      const previous = renderer.getRenderTarget();
      const builds = ([[clouds.material, composer.renderTarget1], [bodiesQuad!.material, bodiesTargets[0]!], [shadowMapQuad!.material, shadowMapTarget]] as const).map(([material, target]) => {
        const warm = new Scene();
        warm.add(new Mesh(quad, material));
        renderer.setRenderTarget(target);
        return renderer.compileAsync(warm, camera).catch(() => {});
      });
      renderer.setRenderTarget(previous);
      // Not drawn until they are built: drawn while the driver still builds
      // them, the frame waits all the same (three asks for the program's log,
      // which blocks until the link is done).
      warming.push(Promise.all(builds).finally(() => { quad.dispose(); cloudsReady = true; }));
    }
  }
  const smaa = quality.smaa ? new SMAAPass() : null;
  if (smaa) composer.addPass(smaa);
  const output = new OutputPass();
  composer.addPass(output);
  // The grade, on the finished image: a film's contrast and colour.
  const grade = new ShaderPass(GRADE);
  (grade.uniforms['uSharpen'] as { value: number }).value = quality.sharpen;
  grade.uniforms['tSharpMask']!.value = sharpMask?.texture ?? null;
  composer.addPass(grade);

  // A cloud's shadow takes the sun's direct light and leaves the sky's
  // (global = diffuse + direct * cos(zenith)): its strength is the direct
  // share, none by night. A fixed 0.62 took more than the whole sun gives in
  // the morning (some a fifth of the light at 06:30), and from the map's
  // zoom the land was covered in near-black blotches (2026-10-08).
  let night = 0;
  /** The planet's air (`setAir`): its aerial perspective volume is made for this camera before the pass reads it. */
  let planetAir: Air | null = null;
  /** How far out to space the view is (`setSpace`). */
  let space = 0;
  let directShare = CLOUD_SHADOW_STRENGTH;
  // On the planet the sun stands at another height at each place in view, and
  // night is where it has set: both are taken per pixel there
  // (CLOUD_SHADOWS), and this is the shadow under the zenith's sun.
  const shadowStrength = (): number => (__PLANET__ ? CLOUD_SHADOW_STRENGTH : directShare * Math.max(0, 1 - night * 1.5));

  return {
    enabled: true,
    target,
    setAmbientOcclusion(on) {
      if (gtao) gtao.enabled = on;
    },
    render(delta) {
      if (clouds) {
        camera.updateMatrixWorld();
        cloudClock += delta;
        (clouds.uniforms['uTime'] as { value: number }).value = cloudClock;
        const u = clouds.uniforms as Record<string, { value: unknown }>;
        const count = layClouds(u['uCloud']!.value as Vector4[], u['uPuff']!.value as Vector4[], u['uLife']!.value as number[], u['uBase']!.value as number[], u['uShow']!.value as number[], placedClouds, cloudDrift);
        u['uCloudCount']!.value = count;
        // On the planet no plane lies under every cloud: each shadow is marched.
        const plane = __PLANET__ ? null : cloudShadowFrame(u['uCloud']!.value as Vector4[], u['uBase']!.value as number[], count,
          u['uSunDir']!.value as Vector3, u['uShadowRect']!.value as Vector4);
        if (__PLANET__) {
          // The ground as drawn (`planetDrawnSphere`): the clouds' bases and their shadows on it.
          const drawnRadius = planetDrawnSphere(onPlanet);
          (u['uPlanet']!.value as Vector4).set(onPlanet.x, onPlanet.y, onPlanet.z, drawnRadius);
          planetCentre(onPlanet);
          (u['uPlanetInverse']!.value as Matrix4).copy(planetInverse());
          // The aerial perspective's distance scale by the eye's height: a
          // quarter of the true air by the ground, rising to the shell's own
          // share at the top (`SURFACE_AIR`), so crossing it changes nothing.
          const high = Math.min(1, Math.max(0, (camera.position.distanceTo(onPlanet) - PLANET_RADIUS) / (ATMOSPHERE_TOP - PLANET_RADIUS)));
          u['uAirScale']!.value = 0.25 + (SURFACE_AIR - 0.25) * high * high * (3 - 2 * high);
          // The air's own share comes in over the top 40% of its height only:
          // below, the view keeps the distance-scaled air it always had (taken
          // from mid altitude the whole path's light tinted the land blue).
          const late = Math.min(1, Math.max(0, (high - 0.6) / 0.4));
          u['uAirHigh']!.value = late * late * (3 - 2 * late);
          // The clouds and their shadows give way as the view takes in the
          // globe: by how tall the view is over the ground under the eye,
          // in planet widths - whole up to 0.2, gone at 0.6 (the whole globe
          // in view is some 0.8), so from mid altitude down they show whole and out at the globe the clouds
          // kept round the place looked at are not a clump of white balls
          // and dark stains in its middle. The eye's height, not the depth
          // in the middle of the screen: a low view's middle lies far down
          // the horizon, and the clouds went at mid altitude.
          const fov = (camera as Camera & { fov?: number }).fov ?? 35;
          const span = 2 * Math.max(0, camera.position.distanceTo(onPlanet) - PLANET_RADIUS) * Math.tan((fov * Math.PI) / 360);
          const t = Math.min(1, Math.max(0, (span / (2 * PLANET_RADIUS) - 0.2) / 0.4));
          const fade = 1 - t * t * (3 - 2 * t);
          u['uGlobeFade']!.value = fade;
          u['uStrength']!.value = CLOUD_SHADOW_STRENGTH * fade;
        }
        u['uShadowMapOn']!.value = plane === null ? 0 : 1;
        if (plane !== null) u['uShadowPlane']!.value = plane;
        (clouds.uniforms['uProjectionInverse'] as { value: Matrix4 }).value.copy(camera.projectionMatrixInverse);
        (clouds.uniforms['uCameraWorld'] as { value: Matrix4 }).value.copy(camera.matrixWorld);
        // The history holds for the same view only: the last frame drew
        // clouds, from this camera, at this size.
        const same = camera.matrixWorld.equals(lastView) && camera.projectionMatrix.equals(lastProjection);
        historyValid = same && count > 0 && hadClouds;
        hadClouds = count > 0;
        lastView.copy(camera.matrixWorld);
        lastProjection.copy(camera.projectionMatrix);
        // Nothing of it shows - no cloud, no mist, no painted fog, no air round
        // the map: the pass is skipped, not run over every pixel for nothing.
        clouds.enabled = cloudsReady && (count > 0 || (u['uFog']!.value as number) > 0 || (u['uGroundFog']!.value as Vector4).w > 0.5
          || (u['uBackdrop']!.value as number) > 0.5 || (__PLANET__ && !!planetAir?.inside));
      }
      composer.render(delta);
    },
    setMotionBlur(shutter) {
      if (!motionBlur) return;
      (motionBlur.uniforms['uShutter'] as { value: number }).value = shutter;
      if (!motionBlur.enabled && shutter > 0) motionBlurHistory = false;
      motionBlur.enabled = shutter > 0;
    },
    setSpace(share) {
      space = share;
      bloom.enabled = night > 0.05 || space > 0.01;
      bloom.strength = bloomStrength * Math.max(Math.min(1, night), space);
    },
    setNight(dark) {
      night = dark;
      bloom.enabled = dark > 0.05 || space > 0.01;
      bloom.strength = bloomStrength * Math.max(Math.min(1, dark), space);
      if (clouds) (clouds.uniforms['uStrength'] as { value: number }).value = shadowStrength();
      if (clouds) (clouds.uniforms['uDark'] as { value: number }).value = dark;
    },
    setAir(air) {
      planetAir = air;
      if (!clouds) return;
      const from = air.uniforms;
      for (const name of ['uAirCentre', 'uAirSun'] as const) {
        ((clouds.uniforms[name] as { value: Vector3 }).value).copy(from[name]!.value as Vector3);
      }
      for (const name of ['uAirIntensity', 'uAirInside', 'tAirTransmittance', 'tAirMulti', 'tAirSky', 'tAirPerspective'] as const) {
        clouds.uniforms[name]!.value = from[name]!.value;
      }
    },
    setDirectShare(share) {
      if (Math.abs(share - directShare) < 0.005) return;
      directShare = share;
      if (clouds) (clouds.uniforms['uStrength'] as { value: number }).value = shadowStrength();
    },
    setPlacedClouds(clouds) {
      placedClouds = clouds;
    },
    setCloudDrift(x, y) {
      cloudDrift.x = x;
      cloudDrift.y = y;
    },
    setGroundFog(fog) {
      if (!clouds) return;
      const u = clouds.uniforms as Record<string, { value: unknown }>;
      if (!fog) { (u['uGroundFog']!.value as Vector4).set(0, 0, 0, 0); return; }
      u['tGroundFog']!.value = fog.texture;
      (u['uGroundFog']!.value as Vector4).set(fog.density, 0, 0, 1);
      (u['uGroundFogSlab']!.value as Vector2).set(fog.low - 2, fog.high);
    },
    setAtmosphere(atmosphere, sun, skyColor, sunLight, backdrop, eyeShift = 0) {
      if (!clouds) return;
      const u = clouds.uniforms as Record<string, { value: unknown }>;
      u['uBackdrop']!.value = backdrop ? 1 : 0;
      u['uEyeShift']!.value = eyeShift;
      u['uCloudBase']!.value = atmosphere.cloudBase;
      (u['uSunLight']!.value as Color).copy(sunLight);
      u['uFog']!.value = atmosphere.fog;
      u['uFogHeight']!.value = Math.max(m(2), atmosphere.fogHeight);
      (u['uSunDir']!.value as Vector3).copy(sun).normalize();
      (u['uFogColor']!.value as Color).copy(skyColor);
    },
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      bloom.setSize(width, height);
      for (const t of bodiesTargets) t.setSize(bodiesSize(width * pixelRatio), bodiesSize(height * pixelRatio));
      sharpMask?.setSize(Math.max(1, width * pixelRatio), Math.max(1, height * pixelRatio));
      historyValid = false;
    },
    dispose() {
      // After the programs built ahead are done (`warming`).
      void Promise.allSettled(warming).then(disposeAll);
    },
  };
  function disposeAll(): void {
    composer.dispose();
    target.dispose();
    gtao?.dispose();
    bloom.dispose();
    smaa?.dispose();
    sharpMask?.dispose();
    sharpMaskQuad?.dispose();
    sharpMaskQuad?.material.dispose();
    output.dispose();
    grade.dispose();
    clouds?.dispose();
    (bodiesQuad?.material as ShaderMaterial | undefined)?.dispose();
    for (const t of bodiesTargets) t.dispose();
    (shadowMapQuad?.material as ShaderMaterial | undefined)?.dispose();
    shadowMapTarget.dispose();
  }
}

/** How much a cloud's shadow takes from the light under it at its heart, until the light's direct share is known (`setDirectShare`). */
const CLOUD_SHADOW_STRENGTH = 0.62;


/** Most cumulus clouds over the map at once, and the puffs each is built of. */
const MAX_CLOUDS = 24;
const CLOUD_PUFFS = 7;

/**
 * Each cloud's puffs, in units of its size: across, up from the base, along,
 * radius. A cumulus is a flat-bottomed heap - a row of broad puffs on the
 * base, two smaller ones over them and a crown (the sphere clusters of Maxime
 * Heckel's "Real-time dreamy Cloudscapes" and the three.js volume cloud's
 * spherical mask).
 */
const PUFFS: readonly (readonly [number, number, number, number])[] = [
  [-0.46, 0.26, 0.02, 0.4],
  [0.0, 0.3, 0.06, 0.48],
  [0.46, 0.25, -0.04, 0.4],
  [-0.2, 0.58, 0.1, 0.37],
  [0.24, 0.56, -0.08, 0.35],
  [0.02, 0.8, 0.0, 0.3],
  [0.12, 0.36, 0.38, 0.33],
];

/** 0..1 hash of an integer and a salt (the same puffs every visit). */
function cloudHash(i: number, salt: number): number {
  let h = Math.imul(i + 1, 374_761_393) ^ Math.imul(salt, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/**
 * Lays the clouds out: the map's own, each where the player put it or the
 * sky's spreader laid it (`world/clouds.ts`), whole. The sky invents none of
 * its own - every cloud can be moved, set and taken away (the player,
 * 2026-10-07). Writes each cloud's bounding sphere (centre, size), its puffs
 * (world centre, radius) and how grown it is (1).
 */
function layClouds(bounds: Vector4[], puffs: Vector4[], lives: number[], bases: number[], shows: number[], placed: readonly PlacedCloud[], drift: { x: number; y: number }): number {
  let slot = 0;
  for (const cloud of placed) {
    if (slot >= MAX_CLOUDS) break;
    // Where the wind has carried it, thinning away near the edge it wraps round.
    // The thinning scales its DENSITY (`uShow`: Beer-Lambert, the optical
    // depth goes with the concentration, so the whole cloud fades evenly).
    // Fed to `life` it eroded the shape instead, and a cloud near the edge
    // broke into loose white flecks, one lying over the land (2026-10-08).
    // (On the planet there is no edge to wrap round: `driftedCloud`.)
    const at = driftedCloud(cloud, drift);
    const height = drawnCloudHeight(cloud.height);
    layOne(slot, 1_000_003 + cloud.id * 7919, at.x, -at.y, height, cloud.size, cloud.yaw, cloud.density, 1, bounds, puffs, lives);
    shows[slot] = at.show;
    // Each its own flat base, at its own height (one height for the whole
    // sky cut away every cloud set lower than it, and its shadow with it).
    bases[slot] = height;
    slot++;
  }
  return slot;
}

const onPlanet = new Vector3();
/** A sphere of the flat sky (centre x, height y, z; radius w) where the planet draws it. */
function placeOnPlanet(v: Vector4): void {
  planetPointInto(v.x, v.y, v.z, onPlanet);
  v.set(onPlanet.x, onPlanet.y, onPlanet.z, v.w);
}

/** One cloud into slot `i`: its bounding sphere, its puffs (jittered by `id`), how grown it is (`life`). */
function layOne(i: number, id: number, x: number, z: number, base: number, size: number, yaw: number, life: number, grown: number,
  bounds: Vector4[], puffs: Vector4[], lives: number[]): void {
  lives[i] = life;
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  bounds[i]!.set(x, base + size * 0.5, z, size * 1.12);
  // On the planet: carried to where the planet draws that point of the sky.
  if (__PLANET__) placeOnPlanet(bounds[i]!);
  for (let k = 0; k < CLOUD_PUFFS; k++) {
    const [a, up, b, r] = PUFFS[k]!;
    const ja = a + (cloudHash(id * 11 + k, 6) - 0.5) * 0.16;
    const jb = b + (cloudHash(id * 11 + k, 7) - 0.5) * 0.16;
    const jr = r * (0.88 + 0.24 * cloudHash(id * 11 + k, 8)) * grown;
    puffs[i * CLOUD_PUFFS + k]!.set(x + (ja * c - jb * sn) * size, base + up * size * grown, z + (ja * sn + jb * c) * size, jr * size);
    if (__PLANET__) placeOnPlanet(puffs[i * CLOUD_PUFFS + k]!);
  }
}

/**
 * THE ATMOSPHERE, on the image (the player sets it: Paisagem > Céu e clima):
 *
 *  - CUMULUS CLOUDS, each its own heap over the map: puffs joined by a
 *    smooth union, their rims eaten by 3-D noise (the sphere-plus-fbm density
 *    of Heckel's cloudscapes), a flat base; lit by the directional derivative
 *    towards the sun (brighter where the cloud thins sunwards), absorbed by
 *    Beer's law. Marched only where the ray crosses a cloud's bounding
 *    sphere, nearest first, and faded within its own size of the camera, so a
 *    cloud is never a wall in front of it (the player, 2026-10-07).
 *  - Their SHADOWS: from each pixel towards the sun through the clouds'
 *    smooth shapes, one big soft shadow where the sun throws each cloud's.
 *  - MIST: exponential height fog, thickest in the low ground.
 *
 * Every pixel's world position is rebuilt from the depth the scene was drawn
 * with (the composer swaps its targets, so the depth is captured per frame).
 */
const CLOUD_SHADOWS = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uProjectionInverse: { value: new Matrix4() },
    uCameraWorld: { value: new Matrix4() },
    uTime: { value: 0 },
    uStrength: { value: CLOUD_SHADOW_STRENGTH },
    uDark: { value: 0 },
    uCloudCount: { value: 0 },
    uCloud: { value: Array.from({ length: MAX_CLOUDS }, () => new Vector4()) },
    uPuff: { value: Array.from({ length: MAX_CLOUDS * CLOUD_PUFFS }, () => new Vector4()) },
    uLife: { value: Array.from({ length: MAX_CLOUDS }, () => 0) },
    uBase: { value: Array.from({ length: MAX_CLOUDS }, () => 0) },
    // How much of each cloud shows (1, down to 0 near the edge it wraps round): a factor on its density.
    uShow: { value: Array.from({ length: MAX_CLOUDS }, () => 1) },
    uCloudBase: { value: DEFAULT_ATMOSPHERE.cloudBase },
    uFog: { value: DEFAULT_ATMOSPHERE.fog },
    uFogHeight: { value: DEFAULT_ATMOSPHERE.fogHeight },
    uSunDir: { value: new Vector3(0.5, 0.8, 0.3).normalize() },
    uSunLight: { value: new Color(3, 2.8, 2.5) },
    uFogColor: { value: new Color(0xc9dcea) },
    // The painted fog (`setGroundFog`): its map; the map's density, -, -, on;
    // the lowest and highest the bank reaches.
    tGroundFog: { value: null as Texture | null },
    uGroundFog: { value: new Vector4() },
    uGroundFogSlab: { value: new Vector2() },
    uMapHalf: { value: WORLD_HALF },
    uPlanet: { value: new Vector4() },
    uPlanetInverse: { value: new Matrix4() },
    // On the planet, how much of the clouds is drawn as the view takes in the globe (1 near the ground .. 0 at the whole globe).
    uGlobeFade: { value: 1 },
    // The planet's air (`planet/air.ts`, `setAir`): set each frame.
    ...(__PLANET__ ? {
      uAirCentre: { value: new Vector3() }, uAirSun: { value: new Vector3(0, 1, 0) }, uAirIntensity: { value: 1 }, uAirInside: { value: 0 },
      tAirTransmittance: { value: null as Texture | null }, tAirMulti: { value: null as Texture | null },
      tAirSky: { value: null as Texture | null }, tAirPerspective: { value: null as Texture | null },
      // How far the aerial perspective's distances are scaled (Unreal's
      // "Aerial Perspective Distance Scale"): the town seen from close by
      // keeps its colours, and it reaches the true air towards the top.
      uAirScale: { value: 1 },
      uAirHigh: { value: 0 },
    } : {}),
    uBackdrop: { value: 0 },
    // How far in front of the camera the view's equivalent eye stands, units
    // (`setAtmosphere`): 0 in perspective; in the orthographic view the camera
    // stands far back by construction, and the air is measured from where the
    // perspective camera would stand at the same scale.
    uEyeShift: { value: 0 },
    // The void round the map: its deep blue, the paler air towards the
    // horizon, and the abyss below (sRGB, as the page's own colours).
    uSkyDeep: { value: new Color(0x0c1a2c) },
    uSkyGlow: { value: new Color(0x3d5a82) },
    uSkyLow: { value: new Color(0x0a1830) },
    // The sky seen from near the ground: pale at the horizon, deeper above.
    // Sky blue, not grey (the player, 2026-10-07): a clear pale blue at
    // the horizon, a deep clear blue above.
    uSkyHorizon: { value: new Color(0x86bdf0) },
    uSkyHigh: { value: new Color(0x2a66c8) },
    // Below the map: a deep navy, never black (the player, 2026-10-09: "não
    // quero que fique preto, é azul escuro"); the earth-brown went black
    // looking straight down.
    uAbyss: { value: new Color(0x0b1a33) },
    // The clouds' bodies, marched at a quarter of the pixels (`CLOUD_BODIES_MAIN`): light, and what of the scene shows through.
    tClouds: { value: null as Texture | null },
    uCloudsOn: { value: 0 },
    // The bodies' accumulation (`CLOUD_BODIES_MAIN`): the last frame's
    // result, its weight (0: none), the frame number for the start's jitter,
    // and the steps across a cloud's diameter.
    tCloudHistory: { value: null as Texture | null },
    uHistory: { value: 0 },
    uFrame: { value: 0 },
    uSteps: { value: 24 },
    // The clouds' shadow map (`CLOUD_SHADOW_MAP_MAIN`), its plane's height and its rectangle (x0, z0, x1, z1).
    tCloudShadow: { value: null as Texture | null },
    uShadowMapOn: { value: 0 },
    uShadowPlane: { value: 0 },
    uShadowRect: { value: new Vector4() },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    #define MAX_CLOUDS ${MAX_CLOUDS}
    #define PUFFS ${CLOUD_PUFFS}
    ${__PLANET__ ? AIR_GLSL : ''}
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform mat4 uProjectionInverse;
    uniform mat4 uCameraWorld;
    uniform float uTime;
    uniform float uStrength;
    uniform float uDark;
    uniform int uCloudCount;
    uniform vec4 uCloud[MAX_CLOUDS];
    uniform vec4 uPuff[MAX_CLOUDS * PUFFS];
    uniform float uLife[MAX_CLOUDS];
    uniform float uBase[MAX_CLOUDS];
    uniform float uShow[MAX_CLOUDS];
    uniform float uCloudBase;
    uniform float uFog;
    uniform float uFogHeight;
    uniform vec3 uSunDir;
    uniform vec3 uSunLight;
    uniform vec3 uFogColor;
    uniform sampler2D tGroundFog;
    uniform vec4 uGroundFog;
    uniform vec2 uGroundFogSlab;
    uniform float uMapHalf;
    uniform float uBackdrop;
    uniform float uEyeShift;
    ${__PLANET__ ? 'uniform float uAirScale; uniform float uAirHigh;' : ''}
    // The planet as drawn (\`planet/bend.ts\`): its centre and radius; w 0 on the flat map.
    uniform vec4 uPlanet;
    uniform float uGlobeFade;
    // The drawn world back to the planet's own frame: what is fixed on the
    // planet (a cloud's billows) is read there, or it swims as the view moves.
    uniform mat4 uPlanetInverse;
    vec3 planetFixed(vec3 p) {
      return uPlanet.w > 0.0 ? (uPlanetInverse * vec4(p, 1.0)).xyz : p;
    }
    // Height over the ground's base level: over the sphere on the planet.
    float altitude(vec3 p) {
      return uPlanet.w > 0.0 ? length(p - uPlanet.xyz) - uPlanet.w : p.y;
    }
    uniform vec3 uSkyDeep;
    uniform vec3 uSkyGlow;
    uniform vec3 uSkyLow;
    uniform vec3 uSkyHorizon;
    uniform vec3 uSkyHigh;
    uniform vec3 uAbyss;
    varying vec2 vUv;
    vec3 worldAt(vec2 uv, float depth) {
      vec4 view = uProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      return (uCameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
    }
    // Where a ray enters and leaves a sphere (both negative: it misses).
    vec2 sphereSpan(vec3 ro, vec3 rd, vec4 s) {
      vec3 oc = ro - s.xyz;
      float b = dot(oc, rd);
      float h = b * b - (dot(oc, oc) - s.w * s.w);
      if (h < 0.0) return vec2(-1.0);
      h = sqrt(h);
      return vec2(-b - h, -b + h);
    }
    float smin(float a, float b, float k) {
      float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
      return mix(b, a, h) - k * h * (1.0 - h);
    }
    float hash3(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float noise3(vec3 x) {
      vec3 i = floor(x);
      vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
        mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0)), f.x), f.y),
        f.z);
    }
    // The heap's smooth shape: how far inside it a point is, in its own size (> 0 inside).
    float heap(int c, vec3 p) {
      float size = uCloud[c].w;
      float d = 1e5;
      for (int k = 0; k < PUFFS; k++) {
        vec4 s = uPuff[c * PUFFS + k];
        // Each puff a little flattened, and joined wide: one heap with a
        // lumpy top, not a bunch of balls.
        vec3 o = p - s.xyz;
        // Flattened along its own up: the world's y on the flat map, the
        // planet's radius over it on the planet.
        vec3 cloudUp = uPlanet.w > 0.0 ? normalize(s.xyz - uPlanet.xyz) : vec3(0.0, 1.0, 0.0);
        o += cloudUp * dot(o, cloudUp) * 0.3;
        d = smin(d, length(o) - s.w, size * 0.2);
      }
      // A flat base: the cloud stops at its condensation level.
      float base = smoothstep(uBase[c] - size * 0.12, uBase[c] + size * 0.08, altitude(p));
      return -d / size * base;
    }
    // Its density, as Horizon Zero Dawn's clouds are built (Schneider; the
    // TerrainEngine-OpenGL shader after it): a soft base shape - the heap
    // ramped over a wide band, its outline broken by large noise - and then
    // ERODED by fine billowy noise, remapped so the erosion eats the thin
    // edge away into wisps while the dense heart stays whole; wispy towards
    // the base, billowy towards the top. The noise only takes away, never
    // adds, so nothing lies past the heap's surface and no cloud is cut off
    // by its bounding sphere.
    float cloudDensity(int c, vec3 p) {
      float size = uCloud[c].w;
      // The billows boil: they rise and turn over as the cloud lives.
      vec3 drift = vec3(uTime * 0.05, -uTime * 0.04, uTime * 0.02);
      float life = uLife[c];
      vec3 fixedP = planetFixed(p);
      vec3 q = fixedP / (size * 0.3) + drift;
      float low = noise3(q) * 0.5 + noise3(q * 2.03 + 5.1) * 0.3 + noise3(q * 4.1 + 9.7) * 0.2;
      // The outline broken by that noise, deep enough that no puff keeps a
      // sphere's clean edge.
      float shape = clamp(heap(c, p) * 3.2 - (1.0 - low) * (0.55 + 0.4 * (1.0 - life)) - (1.0 - life) * 0.8, 0.0, 1.0);
      if (shape <= 0.0) return 0.0;
      vec3 r = fixedP / (size * 0.055) + drift * 2.3;
      float b1 = 1.0 - abs(noise3(r) * 2.0 - 1.0);
      float b2 = 1.0 - abs(noise3(r * 2.13 + 3.3) * 2.0 - 1.0);
      float detail = b1 * 0.65 + b2 * 0.35;
      float up = clamp((altitude(p) - uBase[c]) / size, 0.0, 1.0);
      detail = mix(1.0 - detail, detail, clamp(up * 3.0, 0.0, 1.0));
      // remap(base, detail * 0.35, 1, 0, 1): the heart (1) stays whole, the
      // thin edge is worn into wisps.
      float erode = detail * (0.55 + 0.3 * (1.0 - life));
      return clamp((shape - erode) / (1.0 - erode), 0.0, 1.0) * uShow[c];
    }
    uniform sampler2D tClouds;
    uniform float uCloudsOn;
    uniform sampler2D tCloudHistory;
    uniform float uHistory;
    uniform float uFrame;
    uniform float uSteps;
    // The clouds' shadow map (Unreal's cloud shadow map in place of a march
    // per pixel): what lies between a point of the plane under every cloud's
    // base and the sun, over the rectangle the shadows fall in.
    uniform sampler2D tCloudShadow;
    uniform float uShadowMapOn;
    uniform float uShadowPlane;
    uniform vec4 uShadowRect;
    // How much cloud lies from a point towards the sun, through each heap.
    // What a cloud's shadow is cast by: the density the cloud is drawn with
    // (\`cloudDensity\`) with its noises at their mean - the base shape less
    // the mean erosion - so the shadow is the cloud's own size. Cast by the
    // whole smooth heap, it was the cloud's bounding outline: shadows twice
    // the clouds' size, dark where no cloud was seen (2026-10-10).
    float shadowDensity(int c, vec3 p) {
      float life = uLife[c];
      float shape = clamp(heap(c, p) * 3.2 - 0.5 * (0.55 + 0.4 * (1.0 - life)) - (1.0 - life) * 0.8, 0.0, 1.0);
      float erode = 0.5 * (0.55 + 0.3 * (1.0 - life));
      return clamp((shape - erode) / (1.0 - erode), 0.0, 1.0) * uShow[c];
    }
    float shadowThrough(vec3 from) {
      float through = 0.0;
      for (int c = 0; c < MAX_CLOUDS; c++) {
        if (c >= uCloudCount) break;
        vec2 span = sphereSpan(from, uSunDir, uCloud[c]);
        if (span.y <= 0.0) continue;
        float a = max(span.x, 0.0);
        float len = (span.y - a) / 5.0;
        for (int i = 0; i < 5; i++) {
          through += shadowDensity(c, from + uSunDir * (a + (float(i) + 0.5) * len)) * len / uCloud[c].w;
        }
      }
      return through;
    }
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).r;
      bool sky = depth >= 0.9999;
      vec3 ro = worldAt(vUv, 0.0);
      vec3 hit = worldAt(vUv, sky ? 0.99999 : depth);
      vec3 rd = normalize(hit - ro);
      float tScene = sky ? 1e7 : length(hit - ro);
      vec3 colour = src.rgb;
      // The clouds' shadows. No cloud has anything below the plane of the
      // lowest base, so a point under it is shaded as the point where its ray
      // to the sun crosses that plane: one read of the map. Above the plane
      // (a roof over a low cloud's base) the march itself.
      if (!sky && uStrength > 0.0 && uCloudCount > 0) {
        float through = 0.0;
        if (uShadowMapOn > 0.5 && altitude(hit) <= uShadowPlane) {
          vec3 onPlane = hit + uSunDir * ((uShadowPlane - hit.y) / uSunDir.y);
          vec2 at = (onPlane.xz - uShadowRect.xy) / (uShadowRect.zw - uShadowRect.xy);
          if (at.x >= 0.0 && at.y >= 0.0 && at.x <= 1.0 && at.y <= 1.0) through = texture2D(tCloudShadow, at).r;
        } else {
          through = shadowThrough(hit);
        }
        // On the planet only ground turned to the sun has sunlight for a
        // cloud to take: on the night side its march still met clouds on the
        // far side of the globe, and laid their shadows where no sun falls.
        // And of the light on lit ground a cloud takes the sun's direct part
        // alone: the sky's own light (about a fifth of the sun's from the
        // zenith on a clear day) still falls in its shadow. Low sun, little
        // of the light is direct, and a shadow there is faint: per pixel, as
        // the sun stands at each place of the globe (one strength for the
        // whole view, read where it looks, laid the long shadows of an
        // evening town as dark as a noon one).
        float sunUp = uPlanet.w > 0.0 ? dot(normalize(hit - uPlanet.xyz), uSunDir) : 1.0;
        float facing = uPlanet.w > 0.0 ? smoothstep(0.0, 0.15, sunUp) * 1.2 * max(sunUp, 0.0) / (max(sunUp, 0.0) + 0.2) : 1.0;
        float shaded = 1.0 - uStrength * facing * (1.0 - exp(-through * 7.0));
        ${__PLANET__ ? `
        // Seen from above the planet the pixel is the air's own light plus the
        // ground's through it (the shell drawn with ONE, SRC_ALPHA,
        // planet/air.ts): the shadow takes from the ground's part only.
        // Taken from the whole, the air in front of a shadow went dark with
        // it and from space each was a black stain beside its cloud.
        // (From inside the air the air is laid on below, after the shadow.)
        if (shaded < 1.0 && uAirInside < 0.5) {
          vec3 airOwn = airRay(ro, rd, tScene).rgb;
          colour = airOwn + (colour - airOwn) * shaded;
        } else colour *= shaded;` : 'colour *= shaded;'}
      }
      ${__PLANET__ ? `
      // THE AIR in front of what the pixel sees, from inside it (Hillaire's
      // aerial perspective volume, \`planet/air.ts\`): what is seen through
      // it plus its own light. From space the shell over the scene draws it.
      if (!sky && uAirInside > 0.5) {
        // Near the ground the air's distances are scaled (Unreal's "Aerial
        // Perspective View Distance Scale"); as the eye climbs, what it gives
        // is scaled instead, as the shell over the ground from space scales
        // it (\`space.ts\`, \`SURFACE_AIR\`, with the limb's rays taking the
        // whole air): at the top of the air the two are one. A distance scaled
        // from high up kept only the thin top of each ray, and leaving the air
        // turned the land blue in one notch of the wheel (its blue 41 -> 66).
        vec4 near = airPerspective(vUv, tScene * uAirScale);
        vec4 whole = airPerspective(vUv, tScene);
        float pass = length(cross(ro - uAirCentre, rd));
        float share = mix(uAirScale, 1.0, smoothstep(AIR_R * 0.9, AIR_R * 1.002, pass));
        vec4 far = vec4(whole.rgb * share, mix(1.0, whole.a, share));
        vec4 ap = mix(near, far, uAirHigh);
        colour = colour * ap.a + ap.rgb;
      }` : ''}
      // The air between the eye and what the pixel sees: from the view's
      // equivalent eye (\`uEyeShift\`). Measured from the orthographic camera,
      // 5 000 units back whatever the zoom, rain mist covered half of every
      // close view and the haze lay over ground seen from a few metres.
      float tAir = max(tScene - uEyeShift, 0.0);
      vec3 eye = ro + rd * uEyeShift;
      // Mist: exponential in height, along the ray to what the pixel sees.
      if (uFog > 0.0) {
        float dist = min(tAir, ${m(2400).toFixed(2)});
        float yMid = eye.y + rd.y * dist * 0.5;
        float thickness = exp(-max(0.0, min(yMid, altitude(hit))) / uFogHeight);
        float amount = 1.0 - exp(-uFog * 0.0009 * dist * thickness);
        vec3 mist = mix(uFogColor, uFogColor * 0.18, uDark);
        colour = mix(colour, mist, clamp(amount, 0.0, 0.95));
      }
      // THE AIR round the map while it is built, seen as a model over the
      // void (the player, 2026-10-07). The path a ray takes through the air
      // grows towards the horizon - Preetham's optical length, as three's Sky
      // has it - so the backdrop pales there, round the map's edge, and deepens
      // up and further still down into the abyss. And the land beyond the
      // middle of the view takes on that air, L0 e^(-b s) plus the air's own
      // light (the aerial perspective of Preetham and of Hillaire's
      // atmosphere), by the real distance, so the far edge melts into the
      // pale horizon from afar and ground seen close up stays clear. The backdrop hangs on the view's direction, as a
      // sky infinitely far: the map slides over it, and it turns only with the
      // camera - its parallax.
      if (uBackdrop > 0.5) {
        float zen = acos(clamp(abs(rd.y), 0.0, 1.0));
        float air = 1.0 / (cos(zen) + 0.15 * pow(max(93.885 - degrees(zen), 1e-3), -1.253));
        float glow = 1.0 - exp(-air * 0.12);
        float sunSide = pow(max(dot(rd, uSunDir), 0.0), 3.0);
        vec3 haze = mix(uSkyGlow, uSkyGlow * vec3(1.4, 1.18, 0.9), sunSide * 0.6) * (1.0 - 0.85 * uDark);
        // Brought down near the ground the view gets a SKY: pale blue at the
        // horizon deepening upwards (the player, 2026-10-07: "azul mais
        // clarinho com transição para o mais escuro, só quando der zoom");
        // from high over the map it stays the dark blue round the model.
        // Dark blue down to the zoom of the whole map filling the view
        // (about 280 m up), pale sky only closer than that (the player,
        // 2026-10-09).
        float low = 1.0 - smoothstep(${m(100).toFixed(2)}, ${m(260).toFixed(2)}, ro.y);
        vec3 horizon = mix(uSkyHorizon, uSkyHorizon * vec3(1.12, 1.04, 0.92), sunSide * 0.5) * (1.0 - 0.85 * uDark);
        vec3 overhead = uSkyHigh * (1.0 - 0.7 * uDark);
        haze = mix(haze, horizon, low);
        if (sky) {
          vec3 backdrop = mix(uSkyDeep, haze, glow);
          backdrop = mix(backdrop, mix(horizon, overhead, smoothstep(0.0, 0.5, rd.y)), low * step(0.0, rd.y));
          // Below the horizon: a deeper blue at once, going down into the
          // earth's own dark brown (the player, 2026-10-07).
          backdrop = mix(backdrop, uSkyLow, smoothstep(0.0, 0.3, -rd.y) * 0.85);
          backdrop = mix(backdrop, uAbyss, smoothstep(0.18, 0.8, -rd.y) * 0.9);
          // A faint veil of high haze, fixed in the sky.
          float veil = noise3(rd * 4.0 + 3.1) * 0.6 + noise3(rd * 9.0 + 7.7) * 0.4;
          colour = backdrop * (0.88 + 0.24 * veil);
        } else {
          // By the real distance, as air is: the whole map seen from afar
          // takes it on, ground seen close up none (the player, 2026-10-07).
          // Koschmieder: contrast falls as exp(-beta d) from the eye, beta =
          // 3.912 / visibility; a clear day of 30 km. It began
          // only past 880 m, so ground at mid distance kept the foreground's
          // full colour and the town read as a model on a table (2026-10-08).
          // Held under 0.55: the map's edge never melts into the dark blue
          // round it (the player, 2026-10-08).
          //
          // The haze is the low air's (aerosols, scale height 1.2 km, as
          // Hillaire's atmosphere has its Mie layer): its density falls as
          // e^(-y/H) with height, so a ray down from high up crosses little
          // of it. Taken as uniform, the whole flat Earth seen from a few
          // kilometres up lay under a half-white veil (the player,
          // 2026-10-11). The optical depth along the ray in closed form
          // (Quilez, "Better fog": the integral of a e^(-b y) along it), from
          // its two ends' heights, so nothing overflows; level, the limit.
          const float HAZE_BETA = ${perM(3.912 / 30000).toExponential(6)};
          const float HAZE_H = ${m(1200).toFixed(2)};
          float hazeY0 = max(eye.y, 0.0), hazeY1 = max(eye.y + rd.y * tAir, 0.0);
          float hazeDepth = abs(rd.y) > 1e-4
            ? HAZE_H * (exp(-hazeY1 / HAZE_H) - exp(-hazeY0 / HAZE_H)) / -rd.y
            : tAir * exp(-hazeY0 / HAZE_H);
          float amount = (1.0 - exp(-HAZE_BETA * max(hazeDepth, 0.0))) * 0.55;
          colour = mix(colour, haze * (1.0 + 0.6 * glow), amount);
        }
      }
      // THE PAINTED FOG (world/fogPaint.ts): a bank of mist lying on the
      // land where the player laid it, thick near the ground and thinning
      // with height over it (Unreal's local fog volumes over an exponential
      // height fog), torn into drifting wisps by a noise the wind carries
      // through. The view's ray is marched through the slab of air the bank
      // can fill, as far as the scene; each step's density from the painted
      // map, the ground under it from the map's other channel. Lit by the
      // sky and, looking towards the sun, its warm glow (Inigo Quilez,
      // "Better Fog").
      if (uGroundFog.w > 0.5) {
        float t0 = 0.0, t1 = min(tScene, ${m(12000).toFixed(1)});
        // Into the slab [low, high] along the ray.
        if (abs(rd.y) > 1e-4) {
          float ta = (uGroundFogSlab.x - ro.y) / rd.y, tb = (uGroundFogSlab.y - ro.y) / rd.y;
          t0 = max(t0, min(ta, tb));
          t1 = min(t1, max(ta, tb));
        } else if (ro.y < uGroundFogSlab.x || ro.y > uGroundFogSlab.y) {
          t1 = -1.0;
        }
        if (t1 > t0) {
          const int FOG_STEPS = 36;
          float stepLen = (t1 - t0) / float(FOG_STEPS);
          // Interleaved gradient noise (Jimenez, "Next Generation Post
          // Processing in Call of Duty: Advanced Warfare", 2014) to start each
          // pixel's march: a sine hash drew a visible cross-hatch over the
          // bank (the player's screenshot, 2026-10-07).
          float jitterF = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          vec2 windDir = normalize(vec2(24.0, 9.0));
          // The FLOW MAP (Vlachos, "Water Flow in Portal 2", Valve 2010):
          // each texel's fog moves at its own speed, so the offset cannot
          // grow with time (neighbours of different speeds would shear the
          // wisps apart); two layers half a cycle apart each slide for one
          // cycle and start again, the one restarting always faded out.
          const float CYCLE = 9.0;
          float phaseA = fract(uTime / CYCLE);
          float phaseB = fract(uTime / CYCLE + 0.5);
          float blendB = abs(phaseA - 0.5) * 2.0;
          float transmit = 1.0;
          for (int i = 0; i < FOG_STEPS; i++) {
            float t = t0 + (float(i) + jitterF) * stepLen;
            vec3 q = ro + rd * t;
            vec2 uv = vec2(q.x + uMapHalf, -q.z + uMapHalf) / (2.0 * uMapHalf);
            if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
            vec4 m = texture2D(tGroundFog, uv);
            if (m.r < 0.003) continue;
            float over = q.y - m.g;
            if (over < ${m(-1.6).toFixed(4)}) continue;
            float thin = exp(-max(over, 0.0) / max(m.b, ${m(0.4).toFixed(4)}));
            vec2 flow = windDir * m.a * CYCLE;
            // Wisps: two layers of billows the wind carries at different
            // speeds and a little apart in heading, each rolling over in
            // time as it goes, so the bank streams, curls and frays instead
            // of sliding as one sheet (the player, 2026-10-07: "tem que se
            // mexer").
            // The rolling-over goes at the fog's own pace too: still fog
            // barely stirs, fast fog boils.
            float roll = uTime * (0.01 + m.a * 0.002);
            vec2 flow2 = vec2(flow.x * 1.7 - flow.y * 0.4, flow.y * 1.7 + flow.x * 0.4);
            float n = 0.0;
            for (int layer = 0; layer < 2; layer++) {
              float phase = layer == 0 ? phaseA : phaseB;
              // Each layer starts its cycle in a different place (Valve's noise against the pulsing).
              vec2 shift = layer == 0 ? vec2(0.0) : vec2(${m(14.84).toFixed(4)}, ${m(36.68).toFixed(4)});
              vec3 nq = vec3(q.x - flow.x * phase + shift.x, q.y * 1.6, -q.z - flow.y * phase + shift.y) / ${m(22).toFixed(4)} + vec3(0.0, roll, roll * 0.7);
              vec3 nr = vec3(q.x - flow2.x * phase + shift.y, q.y * 2.0, -q.z - flow2.y * phase + shift.x) / ${m(9.2).toFixed(4)} + vec3(roll * 1.4, 0.0, 0.0);
              float nl = noise3(nq) * 0.6 + noise3(nq * 2.1 + 4.1) * 0.15 + noise3(nr) * 0.25;
              n += nl * (layer == 0 ? 1.0 - blendB : blendB);
            }
            float wisp = smoothstep(0.25, 0.75, n * (0.7 + 0.6 * thin));
            float density = m.r * uGroundFog.x * thin * wisp * 0.012;
            transmit *= exp(-density * stepLen);
            if (transmit < 0.02) break;
          }
          float amount = 1.0 - transmit;
          if (amount > 0.001) {
            float sunAmount = pow(max(dot(rd, uSunDir), 0.0), 8.0);
            vec3 mist = mix(vec3(0.86, 0.9, 0.95), vec3(1.0, 0.95, 0.84), sunAmount) * (0.72 + 0.28 * max(uSunDir.y, 0.0));
            mist *= 1.0 - 0.85 * uDark;
            colour = mix(colour, mist, amount);
          }
        }
      }
      // The clouds' bodies, marched at a quarter of the pixels (CLOUD_BODIES_MAIN).
      if (uCloudsOn > 0.5) {
        vec4 bodies = texture2D(tClouds, vUv);
        colour = colour * bodies.a + bodies.rgb;
      }
      gl_FragColor = vec4(colour, src.a);
    }
  `,
};

/**
 * The clouds' shadow map (`CLOUD_SHADOWS`'s functions and uniforms): each
 * texel a point of the plane under every cloud's base, over the rectangle the
 * shadows fall in, and how much cloud lies from it towards the sun - the
 * march each pixel of the screen made for itself, made once a texel.
 */
const CLOUD_SHADOW_MAP_MAIN = /* glsl */ `
    void main() {
      vec3 from = vec3(mix(uShadowRect.x, uShadowRect.z, vUv.x), uShadowPlane, mix(uShadowRect.y, uShadowRect.w, vUv.y));
      gl_FragColor = vec4(shadowThrough(from), 0.0, 0.0, 1.0);
    }
`;

/**
 * The clouds' bodies' steps across a cloud's diameter: the full 24 with the
 * camera moving (no history then), 10 with it still, each frame's start
 * moved on and the last frames blended in with this weight (Playdead's TAA
 * feedback; with ten jittered steps a frame it gathers the full count's
 * samples within three frames).
 */
const CLOUD_STEPS_MOVING = 24;
const CLOUD_STEPS_STILL = 16;
const CLOUD_HISTORY = 0.9;

/** Texels a side of the clouds' shadow map: some 10 world units a texel over the whole map, for shadows tens to hundreds of units soft. */
const CLOUD_SHADOW_MAP = 512;

/**
 * The plane under every cloud (none has density below `uBase - 0.12 size`,
 * `heap`) and the rectangle on it where their shadows fall: each cloud's
 * bounding sphere carried down the sun's ray to the plane, stretched by the
 * sun's slant. Null with no cloud or the sun too low for a map.
 */
function cloudShadowFrame(bounds: readonly Vector4[], bases: readonly number[], count: number, sun: Vector3,
  rect: Vector4): number | null {
  if (count === 0 || sun.y < 0.08) return null;
  let plane = Infinity;
  for (let c = 0; c < count; c++) plane = Math.min(plane, bases[c]! - bounds[c]!.w / 1.12 * 0.12);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let c = 0; c < count; c++) {
    const s = bounds[c]!;
    const down = (s.y - plane) / sun.y;
    const x = s.x - sun.x * down, z = s.z - sun.z * down;
    const reach = s.w / sun.y;
    x0 = Math.min(x0, x - reach); x1 = Math.max(x1, x + reach);
    z0 = Math.min(z0, z - reach); z1 = Math.max(z1, z + reach);
  }
  rect.set(x0, z0, x1, z1);
  return plane;
}

/**
 * The clouds' bodies (`CLOUD_SHADOWS`'s functions and uniforms), nearest
 * first, into a target of half the width and half the height: a quarter of
 * the pixels, as volumetric clouds are marched in games (Horizon Zero Dawn's
 * cloudscapes, the Nubis line of work) - they are soft, and every pixel of
 * them cost up to 24 clouds of 24 steps of noise. Each is marched to the
 * nearest of the scene's four depths under it, so no cloud is laid over the
 * edge of something in front of it; the full-size pass blends them in
 * (light, and what of the scene shows through).
 */
const CLOUD_BODIES_MAIN = /* glsl */ `
    void main() {
      ivec2 full = textureSize(tDepth, 0);
      ivec2 at = ivec2(gl_FragCoord.xy) * 2;
      float depth = 1.0;
      for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) depth = min(depth, texelFetch(tDepth, min(at + ivec2(i, j), full - 1), 0).r);
      bool sky = depth >= 0.9999;
      vec3 ro = worldAt(vUv, 0.0);
      vec3 hit = worldAt(vUv, sky ? 0.99999 : depth);
      vec3 rd = normalize(hit - ro);
      float tScene = sky ? 1e7 : length(hit - ro);
      float transmit = 1.0;
      vec3 light = vec3(0.0);
      // The clouds, nearest first.
      if (uCloudCount > 0) {
        float focusDepth = texture2D(tDepth, vec2(0.5)).r;
        float tFocus = focusDepth >= 0.9999 ? 1e5 : length(worldAt(vec2(0.5), focusDepth) - ro);
        // Drawn from up close only: from far enough to take in the whole
        // diorama every cloud stands out against the empty space round it,
        // a ball hanging in the void (the player, 2026-10-07); there only
        // their shadows cross the land.
        // How tall the view is there, in world units: the same measure in
        // the orthographic view and in perspective (both ends of the
        // screen's middle column at the depth of its centre).
        float spanFocus = focusDepth >= 0.9999 ? 1e5 : length(worldAt(vec2(0.5, 1.0), focusDepth) - worldAt(vec2(0.5, 0.0), focusDepth));
        // Over the map only now (layClouds), so they show from every zoom
        // (the player, 2026-10-07: "quero que as nuvens apareçam"); only
        // past the whole map's width do they give way to their shadows.
        // On the planet the clouds show at every zoom, out to the whole globe:
        // given way to their shadows past a width, they came and went in a
        // notch of the wheel (the player, 2026-10-10).
        float bodies = 1.0 - smoothstep(${m(3600).toFixed(2)}, ${m(5600).toFixed(2)}, spanFocus);
        if (uPlanet.w > 0.0) {
          // On the planet they give way as the view takes in the globe, over
          // a wide span of zoom, not a notch (\`uGlobeFade\`): out there the
          // clouds kept round the place looked at (layClouds) were a clump of
          // white balls in the middle of the globe, one of them hanging past
          // its limb (the player, 2026-10-10).
          bodies = uGlobeFade;
          // And, high enough for them to start giving way, never past the
          // limb: only where the view's ray meets the ground does a cloud
          // stand between the eye and it. Lower down a cloud over the
          // horizon stands against the sky, and is drawn whole.
          if (uGlobeFade < 1.0 && sphereSpan(ro, rd, uPlanet).y <= 0.0) bodies = 0.0;
        }
        vec2 spans[MAX_CLOUDS];
        for (int c = 0; c < MAX_CLOUDS; c++) {
          spans[c] = vec2(-1.0);
          if (c < uCloudCount) spans[c] = sphereSpan(ro, rd, uCloud[c]);
        }
        // Each pixel its own start, moved on every frame (the golden ratio's
        // step) so the accumulation sees other depths each time (arXiv
        // 1609.05344, 3.2); with the camera moving no history is kept and the
        // start stays put, as before.
        // Interleaved gradient noise (Jimenez, "Next Generation Post Processing
        // in Call of Duty: Advanced Warfare", 2014): a start that reads as a
        // fine even texture in one frame, where a white-noise hash grained the
        // clouds whenever the view moved and no history smoothed it.
        float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uFrame * 5.588238, vec2(0.06711056, 0.00583715))));
        // Lit by the sun on its sunward side, by the sky elsewhere; dim at night.
        vec3 skyLight = mix(uFogColor * 0.55 + vec3(0.12), vec3(0.03, 0.035, 0.05), uDark);
        vec3 baseShade = mix(vec3(0.22, 0.24, 0.3), vec3(0.02, 0.025, 0.035), uDark);
        float done = -1.0;
        for (int pass = 0; pass < MAX_CLOUDS; pass++) {
          if (pass >= uCloudCount || transmit < 0.03 || bodies <= 0.0) break;
          int best = -1;
          float bestKey = 1e9;
          for (int c = 0; c < MAX_CLOUDS; c++) {
            if (c >= uCloudCount || spans[c].y <= 0.0) continue;
            float key = max(spans[c].x, 0.0) + float(c) * 0.001;
            if (key > done && key < bestKey) { bestKey = key; best = c; }
          }
          if (best < 0) break;
          done = bestKey;
          float size = uCloud[best].w;
          float t0 = max(spans[best].x, 0.0);
          float t1 = min(spans[best].y, tScene);
          if (t1 <= t0) continue;
          // Steps of one length through every cloud: 24 across its diameter,
          // fewer through a chord near its rim or cut short by the scene.
          // Each step's opacity is integrated over its length (Beer's law),
          // so its light does not depend on how long the step is (Högfeldt,
          // "Optimisations for Real-Time Volumetric Cloudscapes", 3.1).
          const int STEPS = 24;
          // uSteps across the diameter: 24 with the camera moving, fewer
          // with it still, the history filling in what a frame leaves out.
          int steps = int(clamp(ceil(uSteps * (t1 - t0) / (2.0 * uCloud[best].w)), 4.0, float(STEPS)));
          float stepLen = (t1 - t0) / float(steps);
          for (int i = 0; i < STEPS; i++) {
            if (i >= steps) break;
            float t = t0 + (float(i) + jitter) * stepLen;
            vec3 q = ro + rd * t;
            float density = cloudDensity(best, q);
            // Never pressed against the camera: a cloud within its own size
            // of the eye fades out. (Fading every cloud nearer than most of
            // the way to the ground looked at hid them all from above - the
            // camera looks down through the sky at the land - and no cloud
            // ever showed: the player, 2026-10-07.)
            float near = size * 1.3;
            density *= smoothstep(near * 0.4, near, t) * bodies;
            if (density < 0.01) continue;
            // The sun's light reaching this point: a short march towards it
            // through the cloud itself (Horizon Zero Dawn's light samples,
            // Beer's law), so every billow shades its neighbours - bright
            // crowns, grey hollows and undersides - and the heap's smooth
            // form facing the sun on top of it.
            float towards = cloudDensity(best, q + uSunDir * size * 0.06) * 0.06
              + cloudDensity(best, q + uSunDir * size * 0.18) * 0.12;
            float sunT = exp(-towards * size * 0.02 * 2.2);
            float facing = smoothstep(-0.05, 0.1, heap(best, q) - heap(best, q + uSunDir * size * 0.16));
            float lit = sunT * mix(0.55, 1.0, facing);
            float up = clamp((altitude(q) - uBase[best]) / size, 0.0, 1.0);
            vec3 c = mix(baseShade, skyLight, 0.25 + 0.75 * up) * 0.85 + uSunLight * 0.36 * lit * (1.0 - uDark);
            // Little extinction: the eroded edge is a veil the land shows through.
            float alpha = 1.0 - exp(-density * stepLen * 0.015);
            light += transmit * alpha * c;
            transmit *= 1.0 - alpha;
            if (transmit < 0.03) break;
          }
        }
      }
      vec4 now = vec4(light, transmit);
      // The view unchanged since the last frame: this pixel's last result is
      // at this same place, blended in (Playdead's TAA: lerp(current,
      // history, feedback)).
      if (uHistory > 0.0) now = mix(now, texture2D(tCloudHistory, vUv), uHistory);
      gl_FragColor = now;
    }
`;

/**
 * Where the final image may be sharpened, 1 to 0, from the scene's depth.
 * CAS "enhances ... local high-frequency contrast" (AMD, ffx_cas.h); where a
 * pixel spans more than a few decimetres of the world (the town from afar)
 * the high frequencies left are windows and frames smaller than a pixel - the
 * aliasing of them, which it turned into a speckle over every facade (the
 * player, 2026-10-09). The pixel's span is measured in the world, from the
 * depth and the lens, so it holds in either camera at any zoom; the sky, at
 * the far plane, is never sharpened.
 */
const SHARP_MASK = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDepth;
    uniform mat4 uProjectionInverse;
    uniform vec2 uSharpSpan;
    varying vec2 vUv;
    vec3 viewAt(vec2 uv, float depth) {
      vec4 v = uProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      return v.xyz / v.w;
    }
    void main() {
      float depth = texture2D(tDepth, vUv).r;
      float across = 1.0 / float(textureSize(tDepth, 0).x);
      float span = length(viewAt(vUv + vec2(across, 0.0), depth) - viewAt(vUv, depth));
      gl_FragColor = vec4(depth < 1.0 ? 1.0 - smoothstep(uSharpSpan.x, uSharpSpan.y, span) : 0.0, 0.0, 0.0, 1.0);
    }
  `,
};

/**
 * A film grade on the display image: a gentle S-curve of contrast, colour
 * kept rich without neon (vibrance lifts the dull colours more than the
 * strong), warm light and cool shade (split toning), a vignette that holds
 * the eye in the frame. No film grain: noise added to every pixel is noise
 * in the picture (the player, 2026-10-09: "ruído na imagem").
 */
const GRADE = {
  uniforms: {
    tDiffuse: { value: null },
    uSharpen: { value: 0 },
    /** How much each pixel may be sharpened, 0..1 (`SHARP_MASK`). */
    tSharpMask: { value: null as Texture | null },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSharpen;
    uniform sampler2D tSharpMask;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      // SHARPENING, AMD FidelityFX CAS (ffx_cas.h, the sharpen-only path):
      // each pixel against the cross of its neighbours, weighted down where
      // the local contrast is already high, so detail comes out crisp
      // without halos or noise.
      // On LINEAR colour, as CAS requires ("needs linear input color to
      // perform correctly", AMD FidelityFX SDK, Contrast Adaptive
      // Sharpening): the image here is display sRGB, so the five taps are
      // taken to linear (gamma 2.2) and the result back. Run on the sRGB
      // values it over-sharpened the dark side of every edge - the jaggies
      // and the brick moire it was switched off for (2026-10-08).
      // Only where a pixel sees real detail (SHARP_MASK).
      float sharpen = uSharpen > 0.0 ? uSharpen * texture2D(tSharpMask, vUv).r : 0.0;
      if (sharpen > 0.0) {
        vec2 texel = 1.0 / vec2(textureSize(tDiffuse, 0));
        vec3 cl = pow(c, vec3(2.2));
        vec3 b = pow(texture2D(tDiffuse, vUv + vec2(0.0, -texel.y)).rgb, vec3(2.2));
        vec3 d = pow(texture2D(tDiffuse, vUv + vec2(-texel.x, 0.0)).rgb, vec3(2.2));
        vec3 f = pow(texture2D(tDiffuse, vUv + vec2(texel.x, 0.0)).rgb, vec3(2.2));
        vec3 h = pow(texture2D(tDiffuse, vUv + vec2(0.0, texel.y)).rgb, vec3(2.2));
        vec3 mn = min(min(min(d, cl), min(f, b)), h);
        vec3 mx = max(max(max(d, cl), max(f, b)), h);
        vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
        float w = amp.g * (-1.0 / mix(8.0, 5.0, uSharpen));
        cl = clamp(((b + d + f + h) * w + cl) / (1.0 + 4.0 * w), 0.0, 1.0);
        c = mix(c, pow(cl, vec3(1.0 / 2.2)), sharpen / max(uSharpen, 1e-4));
      }
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // Contrast, an S round the middle grey.
      c = mix(c, smoothstep(0.0, 1.0, c), 0.25);
      // Vibrance: the dull colours gain more than the vivid. Held back to
      // 0.93 it left the town grey and dark (the player, 2026-10-09).
      float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
      float sat = mx - mn;
      c = mix(vec3(l), c, 1.0 + 0.3 * (1.0 - sat));
      // Split toning: warm highlights, cool shadows.
      // Warm light, shadows left neutral: a blue push in them read as a
      // teal cast over every shaded slope.
      c += mix(vec3(0.0), vec3(0.02, 0.008, -0.014), smoothstep(0.15, 0.85, l));
      // Vignette.
      vec2 d = vUv - 0.5;
      c *= mix(1.0, 0.78, smoothstep(0.3, 0.85, dot(d, d) * 2.4));
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
    }
  `,
};
