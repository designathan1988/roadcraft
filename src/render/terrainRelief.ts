import {
  ClampToEdgeWrapping,
  DataArrayTexture,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RedFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  Vector4,
  WebGLArrayRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { DEFAULT_GULLY_AUTO, gulliesAt, type GullyDab } from '@world/gullies';
import { m, perM } from '@world/units';

/**
 * THE FINE RELIEF: the land's gullies, spurs and wrinkles, far finer than the
 * terrain mesh (16 units a cell), baked into a texture the terrain shader
 * lights by - the normal map a landscape is drawn with over a coarse mesh
 * (World Machine's "Create Normals": a low-resolution mesh drawn with the
 * shading of a high-resolution terrain). Only the light reads it: the mesh,
 * the roads on it and every pick keep the mesh's height.
 *
 * The relief is Rune Skovbo Johansen's erosion filter (2025-2026, after Clay
 * John's and Fewes's eroded noise): stripes of "phacelle" noise laid down
 * every slope, so they read as gullies; each octave's slopes bend the next
 * octave's, so small gullies branch off big ones; a mask from the slope
 * fades it all out on flat ground. Ported from the reference shader as the
 * bevy_erosion_filter crate publishes it. Evaluated per texel on the GPU,
 * once each time the land changes, over the mesh's height read smoothly
 * (Catmull-Rom between its corners).
 *
 * Two levels, as a clipmap's nested grids (Asirvatham and Hoppe, "Terrain
 * Rendering Using GPU-Based Geometry Clipmaps", GPU Gems 2 ch. 2): layer 0
 * the whole map, layer 1 a window round the ground the camera looks at,
 * eight times finer and with more octaves of gullies, baked again as the
 * view moves on - so zooming in sharpens the land instead of blurring it
 * (the player, 2026-10-07). The terrain shader blends the fine level into
 * the coarse one over the window's outer tenth.
 *
 * Each layer: R the height the three largest octaves add (world units:
 * gullies 150, 75 and 37 apart, wider than the mesh's 16-unit cells can
 * hold), A the height the smaller ones add - kept apart because the large gullies are
 * shapes a normal map cannot carry close up (a normal map leaves the outline
 * flat and has no parallax: big forms belong to the geometry, a normal map
 * to small detail - Polycount, Blender Artists; the player, 2026-10-07: the
 * land read as draped cloth up close), so the terrain shader draws them
 * only where a pixel covers enough ground for the outline not to tell -,
 * G its ridge map
 * (about +1 on crests, -1 in creases), B the brightness of the land's macro
 * colour map (`terrain.ts` macroTexture) - carried here because the terrain
 * shader is at the sixteen textures a fragment shader may bind.
 */

/** Texels across a level: 2.3 units a texel over the 4800-unit map, 0.3 in the close window. */
export const RELIEF_RES = 2048;
/** The close window's side: 240 m. */
const WINDOW_SPAN = m(240);
/** How far the view's ground may wander from the window's centre before it is baked again. */
const WINDOW_SLACK = m(44);
/** Octaves of gullies over the whole map, and in the close window. */
const OCTAVES_MAP = 5;
const OCTAVES_CLOSE = 8;
/** One unit of the filter's own space, 560 m (its first gullies some 60 m apart). */
const RELIEF_LENGTH = m(560);

/** A flat relief until the first bake: one texel a level, nothing added. */
export const RELIEF_TEXTURE: { value: Texture } = {
  value: (() => {
    const flat = new DataArrayTexture(new Uint8Array([0, 0, 255, 255, 0, 0, 255, 255]), 1, 1, 2);
    flat.format = RGBAFormat;
    flat.type = UnsignedByteType;
    flat.needsUpdate = true;
    return flat;
  })(),
};

/**
 * The close window: x, z of its corner (three's axes), its side, and 1 while
 * it holds a bake (0 off - the coarse level alone).
 */
export const RELIEF_WINDOW: { value: Vector4 } = { value: new Vector4(0, 0, WINDOW_SPAN, 0) };

const BAKE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uHeights;
  uniform sampler2D uMacro;
  // Where gullies are cut (R) or wiped (G) by the player's brush, over the
  // map; and how much of the steep land carries them of itself.
  uniform sampler2D uGullies;
  uniform float uGullyAuto;
  float gullyHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float gullyNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(gullyHash(i), gullyHash(i + vec2(1.0, 0.0)), f.x), mix(gullyHash(i + vec2(0.0, 1.0)), gullyHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  uniform float uGridN;
  uniform float uCell;
  uniform float uHalf;
  uniform float uLength;
  uniform vec3 uFrame; // x, z of the level's corner, its side
  uniform float uOctaves;
  varying vec2 vUv;

  #define TAU 6.283185307
  // The reference's defaults.
  #define SCALE 0.15
  #define STRENGTH 0.22
  #define GULLY 0.5
  #define DETAIL 1.5
  const vec4 ROUND = vec4(0.1, 0.0, 0.1, 2.0);
  const vec4 ONSET = vec4(1.25, 1.25, 2.8, 1.5);
  const vec2 ASSUMED = vec2(0.7, 1.0);
  #define CELL_SCALE 0.7
  #define NORMALIZATION 0.5
  #define OCTAVES 9
  #define LACUNARITY 2.0
  #define GAIN 0.5

  // The mesh's height, smooth between its corners: a bilinear read has a
  // slope that jumps at every cell edge, and the gullies would follow the grid.
  float corner(ivec2 c) {
    int n = int(uGridN) - 1;
    return texelFetch(uHeights, clamp(c, ivec2(0), ivec2(n)), 0).r;
  }
  float catmull(float a, float b, float c, float d, float t) {
    return b + 0.5 * t * (c - a + t * (2.0 * a - 5.0 * b + 4.0 * c - d + t * (3.0 * (b - c) + d - a)));
  }
  float heightAt(vec2 xz) {
    vec2 g = (xz + uHalf) / uCell;
    vec2 i = floor(g);
    vec2 f = g - i;
    ivec2 k = ivec2(i);
    float r[4];
    for (int j = 0; j < 4; j++) {
      int y = k.y + j - 1;
      r[j] = catmull(corner(ivec2(k.x - 1, y)), corner(ivec2(k.x, y)), corner(ivec2(k.x + 1, y)), corner(ivec2(k.x + 2, y)), f.x);
    }
    return catmull(r[0], r[1], r[2], r[3], f.y);
  }

  // Inigo Quilez's 2-D hash, both components in [-1, 1].
  vec2 hash2(vec2 x) {
    const vec2 k = vec2(0.3183099, 0.3678794);
    x = x * k + k.yx;
    return -1.0 + 2.0 * fract(16.0 * k * fract(x.x * x.y * (x.x + x.y)));
  }
  float easeOut(float t) { float v = 1.0 - clamp(t, 0.0, 1.0); return 1.0 - v * v; }
  float smoothStart(float t, float s) { return t >= s ? t - 0.5 * s : 0.5 * t * t / max(s, 1e-12); }
  float powInv(float t, float p) { return 1.0 - pow(1.0 - clamp(t, 0.0, 1.0), p); }

  // Phacelle noise: a stripe pattern along dir, a cosine across it (x) and
  // its sine (y), interpolated over jittered cells; zw the side direction
  // times freq * TAU.
  vec4 phacelle(vec2 p, vec2 dir, float freq, float offsetCycles, float normalization) {
    vec2 side = vec2(-dir.y, dir.x) * freq * TAU;
    float offset = offsetCycles * TAU;
    vec2 i = floor(p);
    vec2 f = p - i;
    vec2 acc = vec2(0.0);
    float weights = 0.0;
    for (int a = -1; a <= 2; a++) {
      for (int b = -1; b <= 2; b++) {
        vec2 g = vec2(float(a), float(b));
        vec2 v = f - g - hash2(i + g) * 0.5;
        float w = max(0.0, exp(-dot(v, v) * 2.0) - 0.01111);
        weights += w;
        float wave = dot(v, side) + offset;
        acc += vec2(cos(wave), sin(wave)) * w;
      }
    }
    acc /= max(weights, 1e-6);
    float magnitude = max(1.0 - normalization, length(acc));
    return vec4(acc / magnitude, side);
  }

  // The filter at p over a height h with slope d: x the height to add, y the
  // ridge map, z of x the part the three largest octaves add.
  vec3 erosion(vec2 p, float h, vec2 d, float fadeTargetIn) {
    float strength = STRENGTH * SCALE;
    float fadeTarget = clamp(fadeTargetIn, -1.0, 1.0);
    float hh = h;
    float large = 0.0;
    float freq = 1.0 / (SCALE * CELL_SCALE);
    float slopeLength = max(length(d), 1e-10);
    float roundingMult = 1.0;
    float roundingForInput = mix(ROUND.y, ROUND.x, clamp(fadeTarget + 0.5, 0.0, 1.0)) * ROUND.z;
    float combiMask = easeOut(smoothStart(slopeLength * ONSET.x, roundingForInput * ONSET.x));
    float ridgeMask = easeOut(slopeLength * ONSET.z);
    float ridgeTarget = fadeTarget;
    // The gully direction: the real slope, its length replaced by an ideal one.
    vec2 g = mix(d, d / slopeLength * ASSUMED.x, ASSUMED.y);
    for (int i = 0; i < OCTAVES; i++) {
      if (float(i) >= uOctaves) break;
      float gl = length(g);
      vec2 n = gl > 1e-10 ? g / gl : g;
      vec4 ph = phacelle(p * freq, n, CELL_SCALE, 0.25, NORMALIZATION);
      vec2 z = ph.zw * -freq;
      float sloping = abs(ph.y);
      // Smaller gullies branch off this octave's.
      g += (ph.y >= 0.0 ? 1.0 : -1.0) * z * strength * GULLY;
      float fh = mix(fadeTarget, ph.x * GULLY, combiMask);
      hh += fh * strength;
      if (i == 2) large = hh - h;
      fadeTarget = fh;
      float roundingForOctave = mix(ROUND.y, ROUND.x, clamp(ph.x + 0.5, 0.0, 1.0)) * roundingMult;
      float newMask = easeOut(smoothStart(sloping * ONSET.y, roundingForOctave * ONSET.y));
      combiMask = powInv(combiMask, DETAIL) * newMask;
      ridgeTarget = mix(ridgeTarget, ph.x, ridgeMask);
      ridgeMask *= easeOut(sloping * ONSET.w);
      strength *= GAIN;
      freq *= LACUNARITY;
      roundingMult *= ROUND.w;
    }
    return vec3(hh - h, ridgeTarget * (1.0 - ridgeMask), large);
  }

  void main() {
    vec2 xz = uFrame.xy + vUv * uFrame.z;
    float h = heightAt(xz);
    float e = ${m(1.2).toFixed(6)};
    vec2 slope = vec2(heightAt(xz + vec2(e, 0.0)) - heightAt(xz - vec2(e, 0.0)), heightAt(xz + vec2(0.0, e)) - heightAt(xz - vec2(0.0, e))) / (2.0 * e);
    vec3 r = erosion(xz / uLength, h / uLength, slope, 0.0);
    // GULLIES ONLY WHERE THEY BELONG (world/gullies.ts): of itself only on
    // steep ground (some 17 to 33 degrees and up) and there in scattered
    // patches - as much of it as the map's setting asks - and wherever the
    // player cut them; nowhere they were wiped away.
    vec2 g = texture2D(uGullies, (xz + uHalf) / (2.0 * uHalf)).rg;
    float steep = smoothstep(0.3, 0.65, length(slope));
    float patchN = gullyNoise(xz / ${m(440).toFixed(4)}) * 0.65 + gullyNoise(xz / ${m(152).toFixed(4)} + 17.0) * 0.35;
    float own = steep * smoothstep(1.0 - uGullyAuto - 0.08, 1.0 - uGullyAuto + 0.08, patchN) * step(0.001, uGullyAuto);
    float mask = clamp(own + g.r, 0.0, 1.0) * (1.0 - g.g);
    r *= mask;
    // The macro map as the terrain shader read it (terrainWideUv, 0.006 a metre).
    vec2 wide = vec2(xz.x * 0.9396926 - xz.y * 0.3420201, xz.x * 0.3420201 + xz.y * 0.9396926) * 0.137 * ${perM(0.006).toFixed(8)};
    float macro = dot(texture2D(uMacro, wide).rgb * 2.0, vec3(0.3, 0.59, 0.11));
    gl_FragColor = vec4(r.z * uLength, r.y, macro, (r.x - r.z) * uLength);
  }
`;

export interface ReliefBake {
  /** This bake's relief, for its own ground's shader (each plate has one). */
  readonly texture: { value: Texture };
  /** This bake's close window (`RELIEF_WINDOW` alike). */
  readonly window: { value: Vector4 };
  /** The land moved: bake again at the next chance. */
  markDirty(): void;
  /** The player's gully dabs and how much of the steep land carries gullies of itself (0..1): bake again. */
  setGullies(dabs: readonly GullyDab[], auto: number): void;
  /**
   * Bakes the relief over these corner heights (row by row, GRID by GRID) if
   * it is stale, and the close window round `focus` (three's x, z) - or turns
   * it off when there is none (the view too far out for it to show). The
   * window's layer is let go when another ground has the focus (`keepWindow`
   * false), and kept while none has (true): zooming out and in again bakes no
   * plate twice.
   */
  bake(renderer: WebGLRenderer, heights: Float64Array, focus: { readonly x: number; readonly z: number } | null, keepWindow?: boolean): void;
  dispose(): void;
}

/** Texels across the map of the gully brush's mask. */
const GULLY_RES = 256;

/**
 * The bake's program, built ahead in parallel (three's compileAsync,
 * KHR_parallel_shader_compile) the first time a plate would bake, and no
 * plate baked until it is: built in the frame of the first bake it stopped
 * the opening for 2.9 s (profile of the play build, 2026-10-10). Every
 * plate's material builds the same program, so one flag stands for all.
 */
let bakeProgram: 'none' | 'building' | 'ready' = 'none';

export function createReliefBake(gridN: number, cell: number, half: number, macro: Texture): ReliefBake {
  /**
   * The gully brush's mask: one texel (none cut, none wiped) until a dab of it
   * reaches this ground, then \`GULLY_RES\` across (\`gullyMask\`): every plate
   * keeping a 256 x 256 mask (262 KB) though the brush is seldom used was
   * hundreds of MB of the page's memory, and as much on the GPU.
   */
  const gullyMask = (res: number): DataTexture => {
    const mask = new DataTexture(new Uint8Array(res * res * 4), res, res, RGBAFormat, UnsignedByteType);
    mask.magFilter = LinearFilter;
    mask.minFilter = LinearFilter;
    mask.generateMipmaps = false;
    mask.needsUpdate = true;
    return mask;
  };
  let gullies = gullyMask(1);
  /** The bake's target: the plate's own level, and the close window's while the view looks at this plate. */
  const targetFor = (res: number, levels: number): WebGLArrayRenderTarget => new WebGLArrayRenderTarget(res, res, levels, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    generateMipmaps: true,
    depthBuffer: false,
  });
  /**
   * The plate's own level alone, and the close window's layer only while the view looks at this
   * plate (`bake`'s focus): one plate holds the window at a time. DO NOT give every plate the
   * window's layer: each plate drawn in full held two 2048-texel layers of half floats with their
   * mips (about 89 MB of the graphics card a plate), the second unused on all but one.
   */
  let target = targetFor(RELIEF_RES, 1);
  const corners = new Float32Array(gridN * gridN);
  const heights = new DataTexture(corners, gridN, gridN, RedFormat, FloatType);
  heights.minFilter = NearestFilter;
  heights.magFilter = NearestFilter;
  heights.generateMipmaps = false;
  const material = new ShaderMaterial({
    uniforms: {
      uHeights: { value: heights },
      uMacro: { value: macro },
      uGullies: { value: gullies },
      uGullyAuto: { value: DEFAULT_GULLY_AUTO },
      uGridN: { value: gridN },
      uCell: { value: cell },
      uHalf: { value: half },
      uLength: { value: RELIEF_LENGTH },
      uFrame: { value: new Vector3() },
      uOctaves: { value: OCTAVES_MAP },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: BAKE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new Scene();
  scene.add(quad);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const frame = material.uniforms['uFrame']!.value as Vector3;
  const octaves = material.uniforms['uOctaves']!;
  // Its own uniforms: every plate is baked apart.
  const textureUniform = { value: RELIEF_TEXTURE.value };
  const windowUniform = { value: new Vector4(0, 0, WINDOW_SPAN, 0) };
  const window = windowUniform.value;
  let dirty = true;
  let closeDirty = true;
  /** The target made again with `layers` layers (1: the plate's; 2: and the close window): everything baked again. */
  const layersNow = (layers: number): void => {
    if (target.depth === layers) return;
    target.dispose();
    target = targetFor(RELIEF_RES, layers);
    dirty = true;
    closeDirty = true;
  };
  const layer = (renderer: WebGLRenderer, index: number, x: number, z: number, span: number, count: number): void => {
    frame.set(x, z, span);
    octaves.value = count;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target, index);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
  };
  return {
    texture: textureUniform,
    window: windowUniform,
    markDirty() { dirty = true; closeDirty = true; },
    setGullies(dabs, auto) {
      // None here and none laid before: the one empty texel stands.
      if (dabs.length > 0 && gullies.image.width < GULLY_RES) {
        gullies.dispose();
        gullies = gullyMask(GULLY_RES);
        material.uniforms['uGullies']!.value = gullies;
      }
      const gullyData = gullies.image.data as Uint8Array;
      if (gullies.image.width < GULLY_RES) {
        material.uniforms['uGullyAuto']!.value = auto;
        dirty = true;
        closeDirty = true;
        return;
      }
      // Rasterised with the dabs culled per row, as the fog's map is.
      const step = (2 * half) / GULLY_RES;
      for (let j = 0; j < GULLY_RES; j++) {
        // Texture rows run along +z (three's), which is -y on the map.
        const z = -half + (j + 0.5) * step;
        const y = -z;
        const row = dabs.filter((d) => Math.abs(d.y - y) < d.radius);
        for (let i = 0; i < GULLY_RES; i++) {
          const x = -half + (i + 0.5) * step;
          const k = (j * GULLY_RES + i) * 4;
          const near = row.length ? row.filter((d) => Math.abs(d.x - x) < d.radius) : row;
          const { cut, wipe } = near.length ? gulliesAt(near, x, y) : { cut: 0, wipe: 0 };
          gullyData[k] = Math.round(cut * 255);
          gullyData[k + 1] = Math.round(wipe * 255);
        }
      }
      gullies.needsUpdate = true;
      material.uniforms['uGullyAuto']!.value = auto;
      dirty = true;
      closeDirty = true;
    },
    bake(renderer, grid, focus, keepWindow = false) {
      if (bakeProgram !== 'ready') {
        if (bakeProgram === 'none') {
          bakeProgram = 'building';
          const previous = renderer.getRenderTarget();
          renderer.setRenderTarget(target, 0);
          renderer.compileAsync(scene, camera).then(() => { bakeProgram = 'ready'; }, () => { bakeProgram = 'ready'; });
          renderer.setRenderTarget(previous);
        }
        return;
      }
      // The window's layer while the focus is on this plate, let go when another plate has it.
      layersNow(focus ? 2 : keepWindow ? target.depth : 1);
      if (dirty) {
        dirty = false;
        const startedAt = performance.now();
        for (let i = 0; i < corners.length; i++) corners[i] = grid[i]!;
        heights.needsUpdate = true;
        layer(renderer, 0, -half, -half, 2 * half, OCTAVES_MAP);
        textureUniform.value = target.texture;
        performance.measure('hitch:terrain-relief', { start: startedAt, end: performance.now() });
      }
      if (!focus) { window.w = 0; return; }
      const cx = window.x + window.z / 2, cz = window.y + window.z / 2;
      if (!closeDirty && window.w > 0 && Math.abs(focus.x - cx) < WINDOW_SLACK && Math.abs(focus.z - cz) < WINDOW_SLACK) return;
      closeDirty = false;
      const startedAt = performance.now();
      // On whole texels of the window, so a re-bake lays the same relief
      // where the two windows overlap.
      const texel = WINDOW_SPAN / RELIEF_RES;
      const x0 = Math.round((focus.x - WINDOW_SPAN / 2) / texel) * texel;
      const z0 = Math.round((focus.z - WINDOW_SPAN / 2) / texel) * texel;
      layer(renderer, 1, x0, z0, WINDOW_SPAN, OCTAVES_CLOSE);
      window.set(x0, z0, WINDOW_SPAN, 1);
      performance.measure('hitch:terrain-relief-close', { start: startedAt, end: performance.now() });
    },
    dispose() {
      target.dispose();
      heights.dispose();
      gullies.dispose();
      material.dispose();
      quad.geometry.dispose();
    },
  };
}
