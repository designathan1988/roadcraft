import {
  Color,
  DataTexture,
  FrontSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
  Vector2,
  Vector3,
  type Texture,
} from 'three';

import { fbm, makeNoise } from './mesh/textureBaker';
import { m } from '@world/units';

/**
 * River water: an extended `MeshStandardMaterial`, not a `ShaderMaterial`.
 *
 * The old surface was a flat blue disc at a fixed opacity, and every one of its
 * defects came from something it did not know:
 *
 *  - it did not move, so nothing told the eye it was liquid;
 *  - it did not know how deep it was, so the bank faded out at the same rate as
 *    the middle of the channel and the river had no visible bed and no shore;
 *  - it had one flat colour, so the only thing standing between it and painted
 *    card was the environment map.
 *
 * ## The approach
 *
 * Everything here is folded into the standard material through
 * `onBeforeCompile`, so the water keeps the scene's lights, its PMREM
 * environment map, its shadows and its ACES tone mapping. A stand-alone
 * `ShaderMaterial` would have had to reimplement all four, and would have
 * drifted away from them at the first lighting change.
 *
 * Four things are injected:
 *
 *  1. **Two scrolling normal layers.** One baked, tiling normal map sampled
 *     twice — at two world scales, drifting in two directions at two speeds —
 *     and summed in tangent space. That is the whole of the motion; it is also
 *     the whole of the sparkle, because a low roughness plus a perturbed normal
 *     is what lets the low sun throw glints off the surface.
 *  2. **A depth tint**, read from the `aDepth` vertex attribute the geometry
 *     builder writes: the surface level minus the ground under it. Shallow water
 *     is lighter and greener and largely transparent, so the bed shows through
 *     near the bank; deep water is darker, bluer and nearly opaque. Uniform
 *     opacity is what used to make the whole river read as one sheet of plastic.
 *  3. **A widened Schlick term.** See `FRESNEL_POWER` for why it is not 5.
 *  4. **A shore foam band**, also driven by `aDepth`, broken up by a noise
 *     channel carried in the alpha of the same normal map so it does not read as
 *     a contour line.
 *
 * ## The cost
 *
 * Two `texture2D` fetches per pixel, from one sampler, and arithmetic. The foam
 * noise rides in the alpha channel of the normal map rather than in a texture of
 * its own precisely so that the count stays at two. Everything else the fragment
 * does is what a `MeshStandardMaterial` already did. There is no render target,
 * no reflection pass and no depth pre-pass: water covers a small part of an
 * isometric frame and does not deserve one.
 *
 * The normal map is baked procedurally into a `DataTexture` — no canvas, no
 * file, no fetch — which also means the bake is a pure function that a headless
 * test can check.
 */

/** Side of the baked normal map at the top tier. Power of two, as GL wants. */
const TEXTURE_SIZE_HIGH = 256;
const TEXTURE_SIZE_LOW = 128;

/**
 * World units one tile of each layer covers.
 *
 * Two clearly different sizes, not two similar ones: layers an octave apart
 * beat against each other into a visible moire, and layers at the same size are
 * one layer with extra cost.
 */
const LAYER_A_TILE = m(13.6);
const LAYER_B_TILE = m(4.4);

/**
 * Scroll speed of each layer, in TILES per second.
 *
 * Both are whole multiples of a thousandth, so `CLOCK_WRAP * drift` is an
 * integer number of tiles for both layers: the clock can be wrapped to keep the
 * float32 uniform precise and the wrap lands exactly on a tile boundary, which
 * with `RepeatWrapping` is no jump at all.
 */
const DRIFT_A: readonly [number, number] = [0.035, 0.021];
const DRIFT_B: readonly [number, number] = [-0.026, 0.047];

/** Seconds after which the animation clock restarts. */
export const WATER_CLOCK_WRAP = 1_000;

/** Both layers' drifts, exposed so the wrap invariant can be tested. */
export const WATER_DRIFTS: readonly (readonly [number, number])[] = [DRIFT_A, DRIFT_B];

/** The per-vertex water depth the builder writes and the shader reads. */
export const WATER_DEPTH_ATTRIBUTE = 'aDepth';
/** The per-vertex way the water runs (three's x and z, unit down a river, nought in a lake). */
export const WATER_FLOW_ATTRIBUTE = 'aFlow';

/**
 * How the water looks and moves (`world/weather.ts`): waves 0..1, foam 0..1,
 * the current, world units a second down a river, and the wind's way
 * (three's x and z, unit) and speed, world units a second.
 */
export interface WaterLook {
  readonly waves: number;
  readonly foam: number;
  readonly current: number;
  readonly windX: number;
  readonly windZ: number;
  readonly windSpeed: number;
}

/** Seconds of one phase of the flow map (Vlachos, "Water Flow in Portal 2"). */
const FLOW_CYCLE = 2;
/** World units across one tile of the wave layer. */
const WAVE_TILE = m(36);

/** Depth, in world units, at which the tint has reached its deep-water value. */
const DEEP_AT = m(2.4);
/** Depth over which the shore foam band fades out. */
const FOAM_AT = m(1.6);
/**
 * Depth over which the sheet fades in from nothing.
 *
 * The geometry stops exactly where the surface would leave the carved ground,
 * which is the right place for it to stop but the wrong place for it to stop
 * ABRUPTLY: a constant alpha ends the river on a cut line. Fading the last third
 * of a unit of depth hides the edge under the bank instead.
 */
const RIM_AT = m(0.28);

/**
 * Reflectance straight down at the surface, before the angular term.
 *
 * Water's real value is 0.02. This is raised because the scene is lit by one
 * low sun and a sky, and a 2% floor leaves the river reading as a hole.
 */
const FRESNEL_BASE = 0.06;
/**
 * The Schlick exponent, lowered from the physical 5.
 *
 * The camera is orthographic and fixed at 48 degrees of elevation, so the view
 * angle onto a flat water surface is very nearly constant and never approaches
 * the grazing angles where a physical Fresnel term actually switches on. At 48
 * degrees the physical curve returns four percent, which is why the water looked
 * like paint however good the environment map was. A gentler exponent spreads
 * the same transition across the range of angles the rippled normals do reach.
 */
const FRESNEL_POWER = 3;

/** Low enough for the sun to catch, high enough not to alias into fireflies. */
const WATER_ROUGHNESS = 0.15;
const FOAM_ROUGHNESS = 0.72;

/**
 * The surface's height field, in one sweep, as a tiling normal map plus a
 * coarse noise for the foam to break itself up on.
 *
 * Pure and DOM-free: the result is a byte array, so this is the one part of the
 * water that a node test can assert against.
 */
export function waterNormalTexels(size: number): Uint8Array {
  const ripple = makeNoise(0x2f81);
  const swell = makeNoise(0x77d3);
  const churn = makeNoise(0x5be2);
  const height = new Float32Array(size * size);
  const foam = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const fine = fbm(ripple, u * 24, v * 24, 24, 3);
      const long = fbm(swell, u * 6, v * 6, 6, 3);
      // Ridged, not smooth. Plain value noise gives rounded blobs, which read as
      // a quilted bedspread rather than as water; folding it about its midpoint
      // creases the crests, which is the shape a capillary wave actually has.
      const crest = 1 - Math.abs(fine - 0.5) * 2;
      const index = y * size + x;
      height[index] = crest * 0.62 + long * 0.38;
      foam[index] = fbm(churn, u * 9, v * 9, 9, 3);
    }
  }

  // Relief in TEXELS, so the same number is the same visual slope at either
  // texture size — otherwise the low tier's water is twice as choppy.
  const relief = size * 0.014;
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number =>
    height[((y + size) % size) * size + ((x + size) % size)] as number;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * relief;
      const dy = (at(x, y + 1) - at(x, y - 1)) * relief;
      const length = Math.hypot(dx, dy, 1);
      const index = (y * size + x) * 4;
      data[index] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      data[index + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      data[index + 2] = Math.round((1 / length) * 255);
      data[index + 3] = Math.round((foam[y * size + x] as number) * 255);
    }
  }
  return data;
}

/** Texture side for a tier, derived from the anisotropy the tier already sets. */
export const waterTextureSize = (anisotropy: number): number =>
  anisotropy >= 8 ? TEXTURE_SIZE_HIGH : TEXTURE_SIZE_LOW;

/** Where the animation clock stands, given milliseconds of uptime. */
export const waterClock = (elapsedMs: number): number =>
  (elapsedMs / 1_000) % WATER_CLOCK_WRAP;

function waterNormalTexture(size: number, anisotropy: number): DataTexture {
  const texture = new DataTexture(waterNormalTexels(size), size, size, RGBAFormat, UnsignedByteType);
  texture.name = 'water-normal';
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  // A `DataTexture` defaults to nearest filtering and no mipmaps, which on a
  // surface this texture is scrolled across leaves the ripple crawling with
  // aliasing at any distance from the camera.
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The ripple texture, baked once per size and filtering and shared by every
 * water surface (the planet has one per piece): a texture is not freed with
 * the material that uses it (three.js manual, "How to dispose of Objects"),
 * so the surfaces never dispose it.
 */
const normalsMade = new Map<string, DataTexture>();
export function sharedWaterNormals(anisotropy: number): DataTexture {
  const size = waterTextureSize(anisotropy);
  const id = `${size}:${anisotropy}`;
  let made = normalsMade.get(id);
  if (!made) normalsMade.set(id, made = waterNormalTexture(size, anisotropy));
  return made;
}

export interface WaterSurface {
  readonly material: MeshStandardMaterial;
  /** The clock the shader scrolls by, in seconds. Exposed so it can be read. */
  readonly time: { value: number };
  /**
   * Makes the mesh drive its own animation.
   *
   * The draw loop belongs to the renderer and knows nothing about water; asking
   * it to tick a uniform would put a frame-by-frame dependency on the terrain
   * into a module that otherwise only rebuilds behind revision gates. The mesh's
   * own `onBeforeRender` runs exactly when the water is about to be drawn, and
   * not at all when it is off screen or when there is no river.
   */
  attach(mesh: Mesh): void;
  /**
   * The ground under the water as a texture of the terrain's grid heights
   * (one texel per grid corner, `half` and `cell` in world units), so the
   * depth is measured per PIXEL. Interpolated per vertex across the shore's
   * fan triangles, the depth bent at every triangle edge, and the foam band
   * and the fade drawn from it came out as a sawtooth along every bank.
   */
  setGround(texture: Texture, half: number, cell: number, size: number, origin?: { readonly x: number; readonly y: number }): void;
  /** The waves, foam and current (`WaterLook`). */
  setLook(look: WaterLook): void;
  dispose(): void;
}

export function createWaterSurface(anisotropy: number): WaterSurface {
  const normalMap = sharedWaterNormals(anisotropy);

  const material = new MeshStandardMaterial({
    // White: the colour that reaches the lighting is mixed per pixel from the
    // depth attribute, so a constant tint here would only dim it.
    color: 0xffffff,
    normalMap,
    roughness: WATER_ROUGHNESS,
    // Water is a dielectric. The old material used 0.32 to force a reflection
    // out of the environment map, which tinted that reflection with the water's
    // own colour and killed the diffuse — the widened Fresnel below buys the
    // same brightness without lying about the material.
    metalness: 0,
    transparent: true,
    opacity: 1,
    side: FrontSide,
    // Stylised, not a mirror: the sky shows as a soft sheen and a horizon
    // tint (below), not as a chrome reflection of the environment map.
    envMapIntensity: 0.42,
  });
  // Measured against a screenshot at the zoom the game is actually played at,
  // not at a close-up: below about 0.8 the mip chain washes the ripple out
  // entirely once the camera pulls back and the river goes glassy again.
  material.normalScale.set(0.85, 0.85);

  const time = { value: 0 };
  const uniforms = {
    uWaterTime: time,
    // Three stops after SimCity 4's water: a pale blue over the shelf, a soft
    // periwinkle, a dense blue in the channel - a painted ramp, not navy, and
    // not the icy cyan a single light blue gave.
    uShallow: { value: new Color(0x7fb2a8) },
    uMid: { value: new Color(0x3d7a8e) },
    uDeep: { value: new Color(0x245a74) },
    uHorizon: { value: new Color(0x6f95b8) },
    uFoamTint: { value: new Color(0xe6eef2) },
    uScaleA: { value: 1 / LAYER_A_TILE },
    uScaleB: { value: 1 / LAYER_B_TILE },
    uDriftA: { value: new Vector2(DRIFT_A[0], DRIFT_A[1]) },
    uDriftB: { value: new Vector2(DRIFT_B[0], DRIFT_B[1]) },
    uGround: { value: null as Texture | null },
    // half extent, cell, corners per side; z = 0 until a ground is set.
    uGroundGrid: { value: new Vector3(0, 1, 0) },
    // Where the ground's grid is centred, three's x, z (a planet face's centre).
    uGroundOrigin: { value: new Vector2() },
    uWaves: { value: 0.3 },
    uFoamAmount: { value: 0.4 },
    uCurrent: { value: 3 },
    uScaleWave: { value: 1 / WAVE_TILE },
    uWaveDrift: { value: new Vector2(0.004, 0.002) },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float ${WATER_DEPTH_ATTRIBUTE};
         attribute vec2 ${WATER_FLOW_ATTRIBUTE};
         varying float vWaterDepth;
         varying vec2 vWaterFlow;
         varying vec3 vWaterWorld;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         // Computed here rather than read from \`worldPosition\`, which three
         // only declares for a handful of feature combinations.
         vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vWaterDepth = ${WATER_DEPTH_ATTRIBUTE};
         vWaterFlow = ${WATER_FLOW_ATTRIBUTE};`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vWaterDepth;
         varying vec2 vWaterFlow;
         varying vec3 vWaterWorld;
         uniform float uWaves;
         uniform float uFoamAmount;
         uniform float uCurrent;
         uniform float uScaleWave;
         uniform vec2 uWaveDrift;
         uniform float uWaterTime;
         uniform vec3 uShallow;
         uniform vec3 uMid;
         uniform vec3 uDeep;
         uniform vec3 uHorizon;
         uniform vec3 uFoamTint;
         uniform float uScaleA;
         uniform float uScaleB;
         uniform vec2 uDriftA;
         uniform vec2 uDriftB;
         uniform sampler2D uGround;
         uniform vec3 uGroundGrid;
         uniform vec2 uGroundOrigin;
         // The terrain mesh's own surface at a world (x, z): the same corners
         // and the same diagonal split as \`sampleGrid\` in terrain.ts, read
         // with texelFetch so nothing is filtered.
         float waterGroundAt(vec2 world) {
           vec2 xz = world - uGroundOrigin;
           float gx = (xz.x + uGroundGrid.x) / uGroundGrid.y;
           float gy = (xz.y + uGroundGrid.x) / uGroundGrid.y;
           float last = uGroundGrid.z - 2.0;
           float ix = clamp(floor(gx), 0.0, last);
           float iy = clamp(floor(gy), 0.0, last);
           float u = clamp(gx - ix, 0.0, 1.0);
           float v = clamp(gy - iy, 0.0, 1.0);
           ivec2 p = ivec2(int(ix), int(iy));
           float a = texelFetch(uGround, p, 0).r;
           float b = texelFetch(uGround, p + ivec2(0, 1), 0).r;
           float c = texelFetch(uGround, p + ivec2(1, 1), 0).r;
           float d = texelFetch(uGround, p + ivec2(1, 0), 0).r;
           return u + v <= 1.0 ? a * (1.0 - u - v) + d * u + b * v : b * (1.0 - u) + c * (u + v - 1.0) + d * (1.0 - v);
         }`,
      )
      .replace(
        '#include <map_fragment>',
        `// Depth per pixel against the ground (see \`setGround\`), the vertex
         // value only until a ground is set.
         float waterDepthPx = uGroundGrid.z > 0.5 ? vWaterWorld.y - waterGroundAt(vWaterWorld.xz) : vWaterDepth;
         // The two layers, and the only two texture fetches this material adds.
         // Sampled in WORLD space, not from the mesh uv, so the pattern does not
         // stretch where the surface grid is cut at an angle by the shore.
         vec2 waterPoint = vWaterWorld.xz;
         vec4 waterA = texture2D(normalMap, waterPoint * uScaleA + uWaterTime * uDriftA);
         vec4 waterB = texture2D(normalMap, waterPoint * uScaleB + uWaterTime * uDriftB);
         // THE CURRENT: down a river the ripples are carried the way the water
         // runs - a flow map (Vlachos, "Water Flow in Portal 2"; Catlike
         // Coding's "Texture Distortion"): each layer read twice, pushed
         // downstream over a cycle, the two reads half a cycle apart and
         // weighted by a triangle wave so neither's restart is ever seen. A
         // lake keeps the still layers above. Read in every pixel, not behind
         // a branch, so the mip derivatives stay whole.
         float waterFlowing = clamp(length(vWaterFlow), 0.0, 1.0);
         float waterCycle = uWaterTime / ${FLOW_CYCLE.toFixed(1)};
         float waterP0 = fract(waterCycle), waterP1 = fract(waterCycle + 0.5);
         float waterW0 = 1.0 - abs(1.0 - 2.0 * waterP0);
         vec2 waterShift = vWaterFlow * uCurrent * ${FLOW_CYCLE.toFixed(1)};
         vec4 waterFA = texture2D(normalMap, (waterPoint - waterShift * waterP0) * uScaleA) * waterW0
           + texture2D(normalMap, (waterPoint - waterShift * waterP1) * uScaleA + vec2(0.37, 0.61)) * (1.0 - waterW0);
         vec4 waterFB = texture2D(normalMap, (waterPoint - waterShift * waterP0) * uScaleB + vec2(0.13, 0.29)) * waterW0
           + texture2D(normalMap, (waterPoint - waterShift * waterP1) * uScaleB + vec2(0.71, 0.43)) * (1.0 - waterW0);
         float waterRun = smoothstep(0.02, 0.3, waterFlowing) * step(0.001, uCurrent);
         waterA = mix(waterA, waterFA, waterRun);
         waterB = mix(waterB, waterFB, waterRun);
         // THE WAVES: a broad swell travelling with the wind, as tall as the
         // map's setting asks, calm in the shallows.
         vec4 waterW = texture2D(normalMap, waterPoint * uScaleWave + uWaterTime * uWaveDrift);

         // Shallow reads green and lets the bed through; deep reads blue and
         // does not. One opacity for both is what left the river with no bed.
         // Beer-Lambert absorption, 1 - exp(-depth / k), through three stops,
         // so the ramp keeps changing across a deep channel instead of
         // reaching its deep colour a metre from the bank.
         float waterDeep = 1.0 - exp(-max(waterDepthPx, 0.0) / ${(DEEP_AT * 0.6).toFixed(2)});
         vec3 waterTint = waterDeep < 0.5
           ? mix(uShallow, uMid, waterDeep * 2.0)
           : mix(uMid, uDeep, waterDeep * 2.0 - 1.0);

         // A BAND, not a threshold: foam that simply grows towards zero depth is
         // brightest exactly where the sheet fades out, so none of it is ever
         // seen. Broken up by the noise the normal map carries in its alpha, or
         // it draws a contour line along the bank.
         float waterShore = smoothstep(0.0, ${FOAM_AT.toFixed(2)}, waterDepthPx);
         // A crisp edge, as stylised foam is drawn: the band is cut by the
         // drifting noise at a hard-ish threshold, so it frays into lacy
         // scallops instead of a soft white smear.
         float waterLace = waterA.a * 0.55 + waterB.a * 0.65;
         float waterEdge = 1.0 - waterShore;
         // A band set IN from the shore, never on it: the outline itself is
         // where the surface is clipped against the ground, cell by cell, and
         // foam drawn there traced every tooth of it. The outline is faded
         // out instead (RIM_AT), as soft particles fade where they meet a
         // surface, and the foam starts just inside it. The lace only moves
         // the band's inner edge; it never adds foam over open water.
         float waterFoamOuter = smoothstep(${(RIM_AT * 0.7).toFixed(2)}, ${(RIM_AT * 1.3).toFixed(2)}, waterDepthPx);
         float waterFoam = waterFoamOuter * smoothstep(0.34, 0.4, waterEdge + (waterLace - 0.6) * 0.22);
         // A hint of a wash line, not a white outline drawn round the water.
         waterFoam = clamp(waterFoam * uFoamAmount, 0.0, 1.0);
         // Whitecaps on the crests of tall waves, and streaks where a fast
         // current churns: as much as the foam setting asks.
         float waterOpen = smoothstep(${m(0.6).toFixed(3)}, ${m(2.4).toFixed(3)}, waterDepthPx);
         float waterCaps = smoothstep(0.8 - 0.22 * uWaves, 0.97, waterW.a) * smoothstep(0.25, 0.8, uWaves) * waterOpen;
         float waterChurn = waterRun * waterFlowing * smoothstep(0.66, 0.78, waterLace) * smoothstep(${m(0.8).toFixed(3)}, ${m(3.2).toFixed(3)}, uCurrent);
         waterFoam = clamp(max(waterFoam, (waterCaps + waterChurn * 0.6) * uFoamAmount * 1.6), 0.0, 1.0);
         waterTint = mix(waterTint, uFoamTint, waterFoam);

         // The first shallow stretch reveals the actual bed. Starting at
         // 0.34 opacity mixed green water with brown ground into a bright
         // cyan outline before the river became deep blue a few pixels in.
         // The bed shows through until some five and a half metres: a river of a
         // couple of metres is clear to its stones, only the deep goes opaque.
         float waterAlpha = mix(0.05, 0.88, smoothstep(${m(0.12).toFixed(3)}, ${m(5.6).toFixed(3)}, waterDepthPx));
         waterAlpha = max(waterAlpha, waterFoam * 0.9);
         float waterRim = smoothstep(0.0, ${RIM_AT.toFixed(2)}, waterDepthPx);

         // Slicks and currents: a slow, wide swing in tone, so a long river is
         // not one flat colour from bank to horizon. One more fetch.
         float waterSlick = texture2D(normalMap, waterPoint * 0.0031 + uWaterTime * vec2(0.0011, 0.0006)).a;
         waterTint *= 0.94 + 0.12 * waterSlick;
         diffuseColor.rgb = waterTint;
         diffuseColor.a = waterAlpha;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
         // Foam is churn, not a mirror.
         roughnessFactor = mix(roughnessFactor, ${FOAM_ROUGHNESS.toFixed(2)}, waterFoam);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 waterNormalA = waterA.xyz * 2.0 - 1.0;
         vec3 waterNormalB = waterB.xyz * 2.0 - 1.0;
         // The tangent-space SLOPES are summed; the vectors are not blended. A
         // lerp between two opposed normals cancels to flat, so a mixed
         // two-layer surface goes glassy exactly where the layers cross — which
         // is everywhere, a few times a second.
         vec3 waterNormalW = waterW.xyz * 2.0 - 1.0;
         float waterSwell = uWaves * 1.3 * smoothstep(${m(0.32).toFixed(3)}, ${m(2).toFixed(3)}, waterDepthPx);
         vec3 mapN = normalize(vec3(
           waterNormalA.xy * 0.62 + waterNormalB.xy * 0.48 + waterNormalW.xy * waterSwell,
           waterNormalA.z * waterNormalB.z
         ));
         mapN.xy *= normalScale;
         mapN = normalize(mix(mapN, vec3(0.0, 0.0, 1.0), waterFoam * 0.6));
         normal = normalize(tbn * mapN);`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
         float waterNdv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
         float waterFresnel = ${FRESNEL_BASE.toFixed(2)} +
           (1.0 - ${FRESNEL_BASE.toFixed(2)}) * pow(1.0 - waterNdv, ${FRESNEL_POWER.toFixed(1)});
         // Both fields, because three reads \`specularColorBlended\` for the
         // direct lobe and \`specularColor\` for the environment one.
         vec3 waterSpecular = mix(vec3(0.04), vec3(1.0), waterFresnel);
         material.specularColor = waterSpecular;
         material.specularColorBlended = waterSpecular;
         material.specularF90 = 1.0;
         // What is reflected is not transmitted: the bed goes away under the
         // glancing parts of the surface, and the body of the water dims by as
         // much as the reflection gains.
         material.diffuseContribution *= 1.0 - waterFresnel * 0.6;
         // Water absorbs most of the light that enters it: its body colour is
         // the light scattered back, a fraction of what a matte surface of
         // that colour would return under the same sun. Lit as paint, the
         // river read as a pale sheet of plastic.
         material.diffuseContribution *= mix(0.65, 1.0, waterFoam);
         // The horizon tint: what faces away from the eye takes the sky's pale
         // colour as a painted wash, instead of a sharp reflection.
         material.diffuseContribution = mix(material.diffuseContribution, uHorizon, waterFresnel * 0.35 * (1.0 - waterFoam));
         diffuseColor.a = clamp(diffuseColor.a + waterFresnel * 0.5, 0.0, 1.0) * waterRim;`,
      );
  };
  // A changed key keeps this variant out of the cache slot the road and terrain
  // standard materials share.
  material.customProgramCacheKey = () => 'water-flow-waves-v6';

  const started = performance.now();
  return {
    material,
    time,
    setGround(texture, half, cell, size, origin) {
      uniforms.uGround.value = texture;
      uniforms.uGroundGrid.value.set(half, cell, size);
      if (origin) uniforms.uGroundOrigin.value.set(origin.x, -origin.y);
    },
    setLook(look) {
      uniforms.uWaves.value = look.waves;
      uniforms.uFoamAmount.value = look.foam;
      uniforms.uCurrent.value = look.current;
      // The swell runs with the wind, a little faster the harder it blows
      // (tiles a second; a breath of a drift in still air).
      const speed = (m(0.6) + look.windSpeed * 0.35) / WAVE_TILE;
      uniforms.uWaveDrift.value.set(look.windX * speed, look.windZ * speed);
    },
    attach(mesh) {
      mesh.onBeforeRender = () => {
        time.value = waterClock(performance.now() - started);
      };
    },
    dispose() {
      material.dispose();
    },
  };
}
