import {
  Color, DepthTexture, type DirectionalLight, FloatType, HalfFloatType, Matrix4, Mesh, NoBlending,
  RedFormat, Scene, ShaderMaterial, UnsignedByteType, Vector2, Vector3, Vector4, WebGLRenderTarget, type Camera, type Texture, type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { m, perM } from '@world/units';
import { driftedCloud, type PlacedCloud } from '@world/clouds';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

import type { QualityLevel, QualitySettings } from './quality';
import { fullScreenTriangle } from './uploads';
import { createCanyonLight } from './canyonLight';
import { DEPTH_GLSL } from './depthConvention';
import type { CameraSolids } from '@world/buildings/cameraSolids';

/** The post chain: ambient occlusion, then anti-aliasing */


export interface PostChain {
  readonly enabled: boolean;
  /** What the scene is drawn into (null: the screen): shaders are compiled ahead for it. */
  readonly target: WebGLRenderTarget | null;
  /** Every render target the chain holds (the scene's, the composer's two, the masks, the clouds', the occlusion's), for the video memory count (`targetBytes.ts`). */
  targets(): readonly WebGLRenderTarget[];
  render(delta: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /** How dark it is, 0 by day to 1 at night: the bloom is for lights in the dark (lamps, headlights, lit windows). */
  setNight(dark: number): void;
  /** How much of the light on the ground comes straight from the sun (`SceneEnvironment.directShare`) */
  setDirectShare(share: number): void;
  /** The view's centre (map x, y), the town's solids and where they changed since the last call (null: anywhere) */
  followTown(cx: number, cy: number, solids: (() => CameraSolids) | null, changed: readonly (readonly [number, number, number, number])[] | null): void;
  /** The sky the player set (`Atmosphere`) and the light it is lit by */
  setAtmosphere(atmosphere: Atmosphere, sun: Vector3, skyColor: Color, sunLight: Color,
    /** How far in front of the camera the view's equivalent eye stands (`uEyeShift`): 0 in perspective. */
    eyeShift?: number): void;
  /** The clouds the player placed (`world/clouds.ts`). */
  setPlacedClouds(clouds: readonly PlacedCloud[]): void;
  /** How far the wind has carried the clouds, on the map (`world/clouds.ts` driftedCloud). */
  setCloudDrift(x: number, y: number): void;
  /** The painted fog (`render/fogLayer.ts`): its map, the slab of ground it lies over, and the map's settings - or none. */
  setGroundFog(fog: { texture: Texture; low: number; high: number; density: number; window: readonly [number, number, number] } | null): void;
  dispose(): void;
}

/** The player's sky (Landscape > Sky and weather) */
export interface Atmosphere {
  /** How much of the sky the old setting covered (0..1). */
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
      targets: () => [],
      render() {
        renderer.render(scene, camera);
      },
      setSize() {
        /* the renderer's own resize is enough */
      },
      setNight() {
        /* no bloom without the chain */
      },
      setDirectShare() {
        /* no cloud shadows without the chain */
      },
      followTown() {
        /* no street light without the chain */
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
  // The scene is drawn into ITS OWN target, which keeps its depth
  const ratio = renderer.getPixelRatio();
  const sceneTarget = new WebGLRenderTarget(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), {
    type: HalfFloatType,
    // A float depth buffer: the reversed Z the renderer draws with keeps its precision only in floats
    depthTexture: new DepthTexture(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), FloatType),
    // Multisampled, its depth resolved into the texture the occlusion reads (three's `resolveDepthBuffer`).
    samples: Math.min(quality.msaa, renderer.capabilities.maxSamples),
  });
  /** DO NOT hand the composer the scene's multisampled target again: it clones it */
  const target = new WebGLRenderTarget(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), { type: HalfFloatType, depthBuffer: false });
  /** The scene's resolved picture into the composer's buffer the passes read (`scenePass`). */
  const copyQuad = new FullScreenQuad(new ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, opacity: { value: 1 } },
    vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader,
    blending: NoBlending, depthTest: false, depthWrite: false,
  }));
  const composer = new EffectComposer(renderer, target);
  /** The programs being built ahead (`compileAsync` below): the chain is not taken apart until they are done. */
  const warming: Promise<unknown>[] = [];
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);
  // The passes, for the browser checks (a pass switched off to find what draws a defect).
  if (import.meta.env.DEV) Object.assign(window, { __composer: composer });
  const scenePass = new RenderPass(scene, camera);
  composer.addPass(scenePass);
  /** The depth the scene was drawn with THIS frame. */
  const sceneDepth: DepthTexture | null = sceneTarget.depthTexture;
  /** How much each pixel may be sharpened (`SHARP_MASK`), worked out from the scene's depth right after the scene is drawn */
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
      // Into the scene's own target, then its resolved picture into the buffer the next pass reads.
      const [, writeBuffer, readBuffer, delta, mask] = args;
      draw(args[0], writeBuffer, sceneTarget, delta, mask);
      {
        const gl = args[0];
        (copyQuad.material as ShaderMaterial).uniforms['tDiffuse']!.value = sceneTarget.texture;
        const previous = gl.getRenderTarget();
        gl.setRenderTarget(readBuffer);
        copyQuad.render(gl);
        gl.setRenderTarget(previous);
      }
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
    gtao.updateGtaoMaterial({
      radius: level === 'ultra' ? 1.3 : 1.0,
      distanceExponent: 1.6,
      thickness: 0.8,
      scale: 1.05,
      samples: level === 'ultra' ? 16 : 8,
      screenSpaceRadius: false,
    });
    gtao.blendIntensity = 0.85;
    // The occlusion is worked out from the depth the scene was just drawn with (normals rebuilt from it).
    const pass = gtao;
    const draw = pass.render.bind(pass);
    pass.render = (...args: Parameters<GTAOPass['render']>) => {
      const depth = sceneDepth;
      if (depth && pass.depthTexture !== depth) pass.setGBuffer(depth);
      draw(...args);
    };
    // At the scene's resolution, or half of it (`QualitySettings.aoFull`): scaled up, the half one blurs every edge the occlusion lies along
    const resize = pass.setSize.bind(pass);
    const share = quality.aoFull ? 1 : 2;
    pass.setSize = (width: number, height: number) => resize(Math.max(1, Math.ceil(width / share)), Math.max(1, Math.ceil(height / share)));
    composer.addPass(gtao);
    // GTAO's denoise shader is the slowest program to link on a cold start.
    gtao.setGBuffer(sceneTarget.depthTexture!);
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

  // The light the town shuts out of its streets, and the sun's contact shadows (`canyonLight.ts`)
  let sunLights: DirectionalLight[] | null = null;
  const canyon = quality.ambientOcclusion
    ? createCanyonLight(camera, () => sceneDepth, () => (sunLights ??= ['sun', 'sun-cascade-1'].map((name) => scene.getObjectByName(name) as DirectionalLight | undefined).filter((light): light is DirectionalLight => light !== undefined)))
    : null;
  if (canyon) {
    composer.addPass(canyon.pass);
    const quad = fullScreenTriangle();
    const warm = new Scene();
    warm.add(new Mesh(quad, canyon.pass.material));
    warming.push(renderer.compileAsync(warm, camera).catch((error: unknown) => {
      console.error('Street light shader precompile failed', error);
    }).finally(() => quad.dispose()));
  }

  // Light that is brighter than white spills a little round itself: the sun on glass, lit windows and lamps at night.
  const bloomStrength = level === 'ultra' ? 0.22 : 0.18;
  const bloom = new UnrealBloomPass(new Vector2(size.x, size.y), bloomStrength, 0.32, 1.05);
  bloom.enabled = false;
  composer.addPass(bloom);
  // Its shaders built now, in parallel (KHR_parallel_shader_compile), not at the first dusk
  {
    // FullScreenQuad's own triangle (position and uv, no normals)
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
  // Cloud shadows: soft patches drifting over the land, on the linear image before tone mapping.
  const clouds = quality.cloudShadows || quality.skyClouds ? new ShaderPass(CLOUD_SHADOWS) : null;
  /** Whether its program is built (compiled ahead below): until then the pass is not drawn. */
  let cloudsReady = false;
  let cloudClock = 0;
  let placedClouds: readonly PlacedCloud[] = [];
  const cloudDrift = { x: 0, y: 0 };
  /** Where the view looks on the ground (world x, y) and the camera's forward, reused each frame. */
  const cloudAbout = { x: 0, y: 0 };
  const cloudLook = new Vector3();
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
        // With the view still, fewer steps and the last frame blended in (Playdead's TAA feedback)
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
    // Its program built now, in parallel
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
      // Not drawn until they are built: drawn while the driver still builds them, the frame waits all the same
      warming.push(Promise.all(builds).finally(() => { quad.dispose(); cloudsReady = true; }));
    }
  }
  const smaa = quality.smaa ? new SMAAPass() : null;
  if (smaa) {
    // three ships SMAA at its *Medium* preset
    const tune = (material: ShaderMaterial, defines: Record<string, string>): void => {
      Object.assign(material.defines as Record<string, string>, defines);
      material.needsUpdate = true;
    };
    const pass = smaa as unknown as {
      _materialEdges: ShaderMaterial;
      _materialWeights: ShaderMaterial;
    };
    tune(pass._materialEdges, { SMAA_THRESHOLD: '0.04' });
    tune(pass._materialWeights, { SMAA_MAX_SEARCH_STEPS: '16' });
    composer.addPass(smaa);
  }
  // The output and the grade in ONE pass: tone mapping, the sRGB transfer and the film grade
  const output = new OutputPass();
  output.material.fragmentShader = GRADED_OUTPUT_FRAGMENT;
  output.uniforms['uSharpen'] = { value: quality.sharpen };
  output.uniforms['tSharpMask'] = { value: sharpMask?.texture ?? null };
  // The OutputPass's material is raw GLSL ES 1.00 (no `textureSize`): the texel is a uniform, set with the size (`setSize`).
  output.uniforms['uTexel'] = { value: new Vector2(1 / Math.max(1, size.x * ratio), 1 / Math.max(1, size.y * ratio)) };
  output.material.needsUpdate = true;
  composer.addPass(output);

  // A cloud's shadow takes the sun's direct light and leaves the sky's (global = diffuse + direct * cos(zenith))
  let night = 0;
  let directShare = CLOUD_SHADOW_STRENGTH;
  const shadowStrength = (): number => directShare * Math.max(0, 1 - night * 1.5);

  return {
    enabled: true,
    target: sceneTarget,
    // The occlusion's two targets too (its `normalRenderTarget` is never bound once `setGBuffer` is handed the scene's depth: no GPU memory)
    // The bloom's bright pass and its five mips each way (made at construction, on or off) and SMAA's edges and weights (r186 `_edgesRT`, `_weightsRT`)
    targets: () => [sceneTarget, composer.renderTarget1, composer.renderTarget2, ...(sharpMask ? [sharpMask] : []), ...bodiesTargets, shadowMapTarget, ...(gtao ? [gtao.gtaoRenderTarget, gtao.pdRenderTarget] : []),
      bloom.renderTargetBright, ...bloom.renderTargetsHorizontal, ...bloom.renderTargetsVertical,
      ...(smaa ? [(smaa as unknown as { _edgesRT: WebGLRenderTarget })._edgesRT, (smaa as unknown as { _weightsRT: WebGLRenderTarget })._weightsRT] : [])],
    render(delta) {
      if (clouds) {
        camera.updateMatrixWorld();
        cloudClock += delta;
        (clouds.uniforms['uTime'] as { value: number }).value = cloudClock;
        const u = clouds.uniforms as Record<string, { value: unknown }>;
        // The sky repeats (`CLOUD_SPAN`): each cloud's repeat nearest the ground the camera looks at.
        camera.getWorldDirection(cloudLook);
        const ahead = cloudLook.y < -1e-3 ? -camera.position.y / cloudLook.y : 0;
        cloudAbout.x = camera.position.x + cloudLook.x * ahead;
        cloudAbout.y = -(camera.position.z + cloudLook.z * ahead);
        const count = layClouds(u['uCloud']!.value as Vector4[], u['uPuff']!.value as Vector4[], u['uLife']!.value as number[], u['uBase']!.value as number[], u['uShow']!.value as number[], placedClouds, cloudDrift, cloudAbout);
        u['uCloudCount']!.value = count;
        const plane = cloudShadowFrame(u['uCloud']!.value as Vector4[], u['uBase']!.value as number[], count,
          u['uSunDir']!.value as Vector3, u['uShadowRect']!.value as Vector4);
        u['uShadowMapOn']!.value = plane === null ? 0 : 1;
        if (plane !== null) u['uShadowPlane']!.value = plane;
        (clouds.uniforms['uProjectionInverse'] as { value: Matrix4 }).value.copy(camera.projectionMatrixInverse);
        (clouds.uniforms['uCameraWorld'] as { value: Matrix4 }).value.copy(camera.matrixWorld);
        // The history holds for the same view only: the last frame drew clouds, from this camera, at this size.
        const same = camera.matrixWorld.equals(lastView) && camera.projectionMatrix.equals(lastProjection);
        historyValid = same && count > 0 && hadClouds;
        hadClouds = count > 0;
        lastView.copy(camera.matrixWorld);
        lastProjection.copy(camera.projectionMatrix);
        // The air round the map is always drawn: the pass runs once it is built.
        clouds.enabled = cloudsReady;
      }
      composer.render(delta);
    },
    setNight(dark) {
      night = dark;
      bloom.enabled = dark > 0.05;
      bloom.strength = bloomStrength * Math.min(1, dark);
      if (clouds) (clouds.uniforms['uStrength'] as { value: number }).value = shadowStrength();
      if (clouds) (clouds.uniforms['uDark'] as { value: number }).value = dark;
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
      (u['uFogWindow']!.value as Vector3).set(fog.window[0], fog.window[1], fog.window[2]);
    },
    followTown(cx, cy, solids, changed) {
      canyon?.follow(cx, cy, solids, changed);
    },
    setAtmosphere(atmosphere, sun, skyColor, sunLight, eyeShift = 0) {
      canyon?.setSun(sun, directShare);
      if (!clouds) return;
      const u = clouds.uniforms as Record<string, { value: unknown }>;
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
      // DO NOT size the bloom again in CSS pixels
      composer.setSize(width, height);
      sceneTarget.setSize(Math.max(1, width * pixelRatio), Math.max(1, height * pixelRatio));
      for (const t of bodiesTargets) t.setSize(bodiesSize(width * pixelRatio), bodiesSize(height * pixelRatio));
      sharpMask?.setSize(Math.max(1, width * pixelRatio), Math.max(1, height * pixelRatio));
      (output.uniforms['uTexel']!.value as Vector2).set(1 / Math.max(1, width * pixelRatio), 1 / Math.max(1, height * pixelRatio));
      historyValid = false;
    },
    dispose() {
      // After the programs built ahead are done (`warming`) - the canyon's is one of them.
      void Promise.allSettled(warming).then(disposeAll);
    },
  };
  function disposeAll(): void {
    canyon?.dispose();
    composer.dispose();
    target.dispose();
    sceneTarget.dispose();
    copyQuad.dispose();
    copyQuad.material.dispose();
    gtao?.dispose();
    bloom.dispose();
    smaa?.dispose();
    sharpMask?.dispose();
    sharpMaskQuad?.dispose();
    sharpMaskQuad?.material.dispose();
    output.dispose();
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

/** Each cloud's puffs, in units of its size: across, up from the base, along, radius. */
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

/** Lays the clouds out: the map's own, each where the player put it or the sky's spreader laid it */
function layClouds(bounds: Vector4[], puffs: Vector4[], lives: number[], bases: number[], shows: number[], placed: readonly PlacedCloud[], drift: { x: number; y: number },
  about: { x: number; y: number }): number {
  let slot = 0;
  for (const cloud of placed) {
    if (slot >= MAX_CLOUDS) break;
    // Where the wind has carried it, its repeat round the view, thinning away near the edge it wraps round.
    const at = driftedCloud(cloud, drift, about);
    const height = cloud.height;
    layOne(slot, 1_000_003 + cloud.id * 7919, at.x, -at.y, height, cloud.size, cloud.yaw, cloud.density, 1, bounds, puffs, lives);
    shows[slot] = at.show;
    // Each its own flat base, at its own height
    bases[slot] = height;
    slot++;
  }
  return slot;
}

/** One cloud into slot `i`: its bounding sphere, its puffs (jittered by `id`), how grown it is (`life`). */
function layOne(i: number, id: number, x: number, z: number, base: number, size: number, yaw: number, life: number, grown: number,
  bounds: Vector4[], puffs: Vector4[], lives: number[]): void {
  lives[i] = life;
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  bounds[i]!.set(x, base + size * 0.5, z, size * 1.12);
  for (let k = 0; k < CLOUD_PUFFS; k++) {
    const [a, up, b, r] = PUFFS[k]!;
    const ja = a + (cloudHash(id * 11 + k, 6) - 0.5) * 0.16;
    const jb = b + (cloudHash(id * 11 + k, 7) - 0.5) * 0.16;
    const jr = r * (0.88 + 0.24 * cloudHash(id * 11 + k, 8)) * grown;
    puffs[i * CLOUD_PUFFS + k]!.set(x + (ja * c - jb * sn) * size, base + up * size * grown, z + (ja * sn + jb * c) * size, jr * size);
  }
}

/** THE ATMOSPHERE, on the image (the player sets it: Landscape > Sky and weather): */
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
    // The painted fog (`setGroundFog`): its map; the map's density, -, -, on; the lowest and highest the bank reaches.
    tGroundFog: { value: null as Texture | null },
    uGroundFog: { value: new Vector4() },
    uGroundFogSlab: { value: new Vector2() },
    // The fog's window (`fogLayer.ts`): its low corner (world x, y) and side; the texture repeats over it.
    uFogWindow: { value: new Vector3(0, 0, 1) },
    // How far in front of the camera the view's equivalent eye stands, units (`setAtmosphere`): 0 in perspective
    uEyeShift: { value: 0 },
    // The void round the map: its deep blue, the paler air towards the horizon, and the abyss below
    uSkyDeep: { value: new Color(0x0c1a2c) },
    uSkyGlow: { value: new Color(0x3d5a82) },
    uSkyLow: { value: new Color(0x0a1830) },
    // The sky seen from near the ground: pale at the horizon, deeper above.
    uSkyHorizon: { value: new Color(0x86bdf0) },
    uSkyHigh: { value: new Color(0x2a66c8) },
    // Below the map: a deep navy, never black (the player, 2026-10-09: "I do not want it black, it is dark blue")
    uAbyss: { value: new Color(0x0b1a33) },
    // The clouds' bodies, marched at a quarter of the pixels (`CLOUD_BODIES_MAIN`): light, and what of the scene shows through.
    tClouds: { value: null as Texture | null },
    uCloudsOn: { value: 0 },
    // The bodies' accumulation (`CLOUD_BODIES_MAIN`): the last frame's result, its weight
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
    uniform vec3 uFogWindow;
    uniform float uEyeShift;
    // Height over the ground's base level.
    float altitude(vec3 p) {
      return p.y;
    }
    uniform vec3 uSkyDeep;
    uniform vec3 uSkyGlow;
    uniform vec3 uSkyLow;
    uniform vec3 uSkyHorizon;
    uniform vec3 uSkyHigh;
    uniform vec3 uAbyss;
    varying vec2 vUv;
    ${DEPTH_GLSL}
    vec3 worldAt(vec2 uv, float depth) {
      vec4 view = uProjectionInverse * vec4(uv * 2.0 - 1.0, depthToClipZ(depth), 1.0);
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
        // Each puff a little flattened, and joined wide: one heap with a lumpy top, not a bunch of balls.
        vec3 o = p - s.xyz;
        // Flattened along its own up: the world's y.
        o.y += o.y * 0.3;
        d = smin(d, length(o) - s.w, size * 0.2);
      }
      // A flat base: the cloud stops at its condensation level.
      float base = smoothstep(uBase[c] - size * 0.12, uBase[c] + size * 0.08, altitude(p));
      return -d / size * base;
    }
    // Its density, as Horizon Zero Dawn's clouds are built (Schneider; the TerrainEngine-OpenGL shader after it)
    float cloudDensity(int c, vec3 p) {
      float size = uCloud[c].w;
      // The billows boil: they rise and turn over as the cloud lives.
      vec3 drift = vec3(uTime * 0.05, -uTime * 0.04, uTime * 0.02);
      float life = uLife[c];
      vec3 q = p / (size * 0.3) + drift;
      float low = noise3(q) * 0.5 + noise3(q * 2.03 + 5.1) * 0.3 + noise3(q * 4.1 + 9.7) * 0.2;
      // The outline broken by that noise, deep enough that no puff keeps a sphere's clean edge.
      float shape = clamp(heap(c, p) * 3.2 - (1.0 - low) * (0.55 + 0.4 * (1.0 - life)) - (1.0 - life) * 0.8, 0.0, 1.0);
      if (shape <= 0.0) return 0.0;
      vec3 r = p / (size * 0.055) + drift * 2.3;
      float b1 = 1.0 - abs(noise3(r) * 2.0 - 1.0);
      float b2 = 1.0 - abs(noise3(r * 2.13 + 3.3) * 2.0 - 1.0);
      float detail = b1 * 0.65 + b2 * 0.35;
      float up = clamp((altitude(p) - uBase[c]) / size, 0.0, 1.0);
      detail = mix(1.0 - detail, detail, clamp(up * 3.0, 0.0, 1.0));
      // remap(base, detail * 0.35, 1, 0, 1): the heart (1) stays whole, the thin edge is worn into wisps.
      float erode = detail * (0.55 + 0.3 * (1.0 - life));
      return clamp((shape - erode) / (1.0 - erode), 0.0, 1.0) * uShow[c];
    }
    uniform sampler2D tClouds;
    uniform float uCloudsOn;
    uniform sampler2D tCloudHistory;
    uniform float uHistory;
    uniform float uFrame;
    uniform float uSteps;
    // The clouds' shadow map (Unreal's cloud shadow map in place of a march per pixel)
    uniform sampler2D tCloudShadow;
    uniform float uShadowMapOn;
    uniform float uShadowPlane;
    uniform vec4 uShadowRect;
    // How much cloud lies from a point towards the sun, through each heap.
    // (\`cloudDensity\`) with its noises at their mean - the base shape less
    // the mean erosion - so the shadow is the cloud's own size.
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
      bool sky = depthIsBackground(depth);
      vec3 ro = worldAt(vUv, DEPTH_NEAR);
      vec3 hit = worldAt(vUv, sky ? depthNearlyFar() : depth);
      vec3 rd = normalize(hit - ro);
      float tScene = sky ? 1e7 : length(hit - ro);
      vec3 colour = src.rgb;
      // The clouds' shadows.
      if (!sky && uStrength > 0.0 && uCloudCount > 0) {
        float through = 0.0;
        if (uShadowMapOn > 0.5 && altitude(hit) <= uShadowPlane) {
          vec3 onPlane = hit + uSunDir * ((uShadowPlane - hit.y) / uSunDir.y);
          vec2 at = (onPlane.xz - uShadowRect.xy) / (uShadowRect.zw - uShadowRect.xy);
          if (at.x >= 0.0 && at.y >= 0.0 && at.x <= 1.0 && at.y <= 1.0) through = texture2D(tCloudShadow, at).r;
        } else {
          through = shadowThrough(hit);
        }
        // Of the light on lit ground a cloud takes the sun's direct part alone (uStrength, setDirectShare)
        float shaded = 1.0 - uStrength * (1.0 - exp(-through * 7.0));
        colour *= shaded;
      }
      // The air between the eye and what the pixel sees: from the view's
      // equivalent eye (\`uEyeShift\`). Measured from the orthographic camera,
      // 5 000 units back whatever the zoom
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
      // THE AIR round the map while it is built, seen as a model over the void (the player, 2026-10-07).
      {
        float zen = acos(clamp(abs(rd.y), 0.0, 1.0));
        float air = 1.0 / (cos(zen) + 0.15 * pow(max(93.885 - degrees(zen), 1e-3), -1.253));
        float glow = 1.0 - exp(-air * 0.12);
        float sunSide = pow(max(dot(rd, uSunDir), 0.0), 3.0);
        vec3 haze = mix(uSkyGlow, uSkyGlow * vec3(1.4, 1.18, 0.9), sunSide * 0.6) * (1.0 - 0.85 * uDark);
        // Brought down near the ground the view gets a SKY: pale blue at the horizon deepening upwards
        float low = 1.0 - smoothstep(${m(100).toFixed(2)}, ${m(260).toFixed(2)}, ro.y);
        vec3 horizon = mix(uSkyHorizon, uSkyHorizon * vec3(1.12, 1.04, 0.92), sunSide * 0.5) * (1.0 - 0.85 * uDark);
        vec3 overhead = uSkyHigh * (1.0 - 0.7 * uDark);
        haze = mix(haze, horizon, low);
        if (sky) {
          vec3 backdrop = mix(uSkyDeep, haze, glow);
          backdrop = mix(backdrop, mix(horizon, overhead, smoothstep(0.0, 0.5, rd.y)), low * step(0.0, rd.y));
          // Below the horizon: a deeper blue at once, going down into the earth's own dark brown (the player, 2026-10-07).
          backdrop = mix(backdrop, uSkyLow, smoothstep(0.0, 0.3, -rd.y) * 0.85);
          backdrop = mix(backdrop, uAbyss, smoothstep(0.18, 0.8, -rd.y) * 0.9);
          // A faint veil of high haze, fixed in the sky.
          float veil = noise3(rd * 4.0 + 3.1) * 0.6 + noise3(rd * 9.0 + 7.7) * 0.4;
          colour = backdrop * (0.88 + 0.24 * veil);
        } else {
          // By the real distance, as air is: the whole map seen from afar takes it on, ground seen close up none
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
      // THE PAINTED FOG (world/fogPaint.ts)
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
          // Interleaved gradient noise (Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare", 2014) to start
          float jitterF = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          vec2 windDir = normalize(vec2(24.0, 9.0));
          // The FLOW MAP (Vlachos, "Water Flow in Portal 2", Valve 2010)
          const float CYCLE = 9.0;
          float phaseA = fract(uTime / CYCLE);
          float phaseB = fract(uTime / CYCLE + 0.5);
          float blendB = abs(phaseA - 0.5) * 2.0;
          float transmit = 1.0;
          for (int i = 0; i < FOG_STEPS; i++) {
            float t = t0 + (float(i) + jitterF) * stepLen;
            vec3 q = ro + rd * t;
            vec2 fogAt = vec2(q.x, -q.z);
            vec2 fogLocal = (fogAt - uFogWindow.xy) / uFogWindow.z;
            if (fogLocal.x < 0.0 || fogLocal.y < 0.0 || fogLocal.x > 1.0 || fogLocal.y > 1.0) continue;
            vec2 uv = fogAt / uFogWindow.z;
            vec4 m = texture2D(tGroundFog, uv);
            if (m.r < 0.003) continue;
            float over = q.y - m.g;
            if (over < ${m(-1.6).toFixed(4)}) continue;
            float thin = exp(-max(over, 0.0) / max(m.b, ${m(0.4).toFixed(4)}));
            vec2 flow = windDir * m.a * CYCLE;
            // Wisps: two layers of billows the wind carries at different speeds and a little apart in heading
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

/** The clouds' shadow map (`CLOUD_SHADOWS`'s functions and uniforms) */
const CLOUD_SHADOW_MAP_MAIN = /* glsl */ `
    void main() {
      vec3 from = vec3(mix(uShadowRect.x, uShadowRect.z, vUv.x), uShadowPlane, mix(uShadowRect.y, uShadowRect.w, vUv.y));
      gl_FragColor = vec4(shadowThrough(from), 0.0, 0.0, 1.0);
    }
`;

/** The clouds' bodies' steps across a cloud's diameter: the full 24 with the camera moving */
const CLOUD_STEPS_MOVING = 24;
const CLOUD_STEPS_STILL = 16;
const CLOUD_HISTORY = 0.9;

/** Texels a side of the clouds' shadow map: some 10 world units a texel over the whole map, for shadows tens to hundreds of units soft. */
const CLOUD_SHADOW_MAP = 512;

/** The plane under every cloud (none has density below `uBase - 0.12 size`, `heap`) and the rectangle on it where their */
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

/** The clouds' bodies (`CLOUD_SHADOWS`'s functions and uniforms), nearest first */
const CLOUD_BODIES_MAIN = /* glsl */ `
    void main() {
      ivec2 full = textureSize(tDepth, 0);
      ivec2 at = ivec2(gl_FragCoord.xy) * 2;
      float depth = DEPTH_FAR;
      for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) depth = nearerDepth(depth, texelFetch(tDepth, min(at + ivec2(i, j), full - 1), 0).r);
      bool sky = depthIsBackground(depth);
      vec3 ro = worldAt(vUv, DEPTH_NEAR);
      vec3 hit = worldAt(vUv, sky ? depthNearlyFar() : depth);
      vec3 rd = normalize(hit - ro);
      float tScene = sky ? 1e7 : length(hit - ro);
      float transmit = 1.0;
      vec3 light = vec3(0.0);
      // The clouds, nearest first.
      if (uCloudCount > 0) {
        float focusDepth = texture2D(tDepth, vec2(0.5)).r;
        float tFocus = depthIsBackground(focusDepth) ? 1e5 : length(worldAt(vec2(0.5), focusDepth) - ro);
        // Drawn from up close only: from far enough to take in the whole diorama every cloud stands out against the empty space
        float spanFocus = depthIsBackground(focusDepth) ? 1e5 : length(worldAt(vec2(0.5, 1.0), focusDepth) - worldAt(vec2(0.5, 0.0), focusDepth));
        // Over the map only now (layClouds), so they show from every zoom (the player, 2026-10-07: "I want the clouds to show")
        float bodies = 1.0 - smoothstep(${m(3600).toFixed(2)}, ${m(5600).toFixed(2)}, spanFocus);
        vec2 spans[MAX_CLOUDS];
        for (int c = 0; c < MAX_CLOUDS; c++) {
          spans[c] = vec2(-1.0);
          if (c < uCloudCount) spans[c] = sphereSpan(ro, rd, uCloud[c]);
        }
        // Each pixel its own start, moved on every frame
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
          // Steps of one length through every cloud
          const int STEPS = 24;
          // uSteps across the diameter: 24 with the camera moving, fewer with it still
          int steps = int(clamp(ceil(uSteps * (t1 - t0) / (2.0 * uCloud[best].w)), 4.0, float(STEPS)));
          float stepLen = (t1 - t0) / float(steps);
          for (int i = 0; i < STEPS; i++) {
            if (i >= steps) break;
            float t = t0 + (float(i) + jitter) * stepLen;
            vec3 q = ro + rd * t;
            float density = cloudDensity(best, q);
            // Never pressed against the camera: a cloud within its own size of the eye fades out.
            float near = size * 1.3;
            density *= smoothstep(near * 0.4, near, t) * bodies;
            if (density < 0.01) continue;
            // The sun's light reaching this point: a short march towards it through the cloud itself
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
      // The view unchanged since the last frame: this pixel's last result is at this same place, blended in
      if (uHistory > 0.0) now = mix(now, texture2D(tCloudHistory, vUv), uHistory);
      gl_FragColor = now;
    }
`;

/** Where the final image may be sharpened, 1 to 0, from the scene's depth. */
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
    ${DEPTH_GLSL}
    vec3 viewAt(vec2 uv, float depth) {
      vec4 v = uProjectionInverse * vec4(uv * 2.0 - 1.0, depthToClipZ(depth), 1.0);
      return v.xyz / v.w;
    }
    void main() {
      float depth = texture2D(tDepth, vUv).r;
      float across = 1.0 / float(textureSize(tDepth, 0).x);
      float span = length(viewAt(vUv + vec2(across, 0.0), depth) - viewAt(vUv, depth));
      gl_FragColor = vec4(depth != DEPTH_FAR ? 1.0 - smoothstep(uSharpSpan.x, uSharpSpan.y, span) : 0.0, 0.0, 0.0, 1.0);
    }
  `,
};

/** A film grade on the display image: a gentle S-curve of contrast, colour kept rich without neon */
const GRADED_OUTPUT_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform sampler2D tDiffuse;
  uniform float uSharpen;
  uniform sampler2D tSharpMask;
  uniform vec2 uTexel;

  #include <tonemapping_pars_fragment>
  #include <colorspace_pars_fragment>

  varying vec2 vUv;

  // The OutputPass's own work: tone mapping and colour space, by its defines.
  vec4 display(vec4 c) {
    #ifdef LINEAR_TONE_MAPPING
      c.rgb = LinearToneMapping( c.rgb );
    #elif defined( REINHARD_TONE_MAPPING )
      c.rgb = ReinhardToneMapping( c.rgb );
    #elif defined( CINEON_TONE_MAPPING )
      c.rgb = CineonToneMapping( c.rgb );
    #elif defined( ACES_FILMIC_TONE_MAPPING )
      c.rgb = ACESFilmicToneMapping( c.rgb );
    #elif defined( AGX_TONE_MAPPING )
      c.rgb = AgXToneMapping( c.rgb );
    #elif defined( NEUTRAL_TONE_MAPPING )
      c.rgb = NeutralToneMapping( c.rgb );
    #elif defined( CUSTOM_TONE_MAPPING )
      c.rgb = CustomToneMapping( c.rgb );
    #endif
    #ifdef SRGB_TRANSFER
      c = sRGBTransferOETF( c );
    #endif
    return c;
  }

  void main() {
    vec4 src = display(texture2D(tDiffuse, vUv));
    vec3 c = src.rgb;
    // SHARPENING, AMD FidelityFX CAS (ffx_cas.h, the sharpen-only path)
    float sharpen = uSharpen > 0.0 ? uSharpen * texture2D(tSharpMask, vUv).r : 0.0;
    if (sharpen > 0.0) {
      vec2 texel = uTexel;
      vec3 cl = pow(c, vec3(2.2));
      vec3 b = pow(display(texture2D(tDiffuse, vUv + vec2(0.0, -texel.y))).rgb, vec3(2.2));
      vec3 d = pow(display(texture2D(tDiffuse, vUv + vec2(-texel.x, 0.0))).rgb, vec3(2.2));
      vec3 f = pow(display(texture2D(tDiffuse, vUv + vec2(texel.x, 0.0))).rgb, vec3(2.2));
      vec3 h = pow(display(texture2D(tDiffuse, vUv + vec2(0.0, texel.y))).rgb, vec3(2.2));
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
    // Vibrance: the dull colours gain more than the vivid.
    float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
    float sat = mx - mn;
    c = mix(vec3(l), c, 1.0 + 0.3 * (1.0 - sat));
    // Split toning: warm highlights, cool shadows.
    c += mix(vec3(0.0), vec3(0.02, 0.008, -0.014), smoothstep(0.15, 0.85, l));
    // Vignette.
    vec2 d = vUv - 0.5;
    c *= mix(1.0, 0.78, smoothstep(0.3, 0.85, dot(d, d) * 2.4));
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
  }
`;
