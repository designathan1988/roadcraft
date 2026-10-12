import {
  Color,
  DataTexture,
  FloatType,
  FrontSide,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  NearestFilter,
  PlaneGeometry,
  RedFormat,
  Vector2,
} from 'three';

import { FLAT_COLUMNS, FLAT_PLATE, FLAT_PLATES, FLAT_ROWS, flatPlateCentre } from '@world/flatEarth';
import { SEA_LEVEL } from '@world/planet/seaLevel';
import { type WaterLook, sharedWaterNormals, waterClock } from './water';

/**
 * THE FLAT EARTH'S SEAS (docs/MAPA-PLANO-COMPLETO.md): the sea's surface at
 * sea level over every plate of the flat Earth whose land goes under it, one
 * flat plate a plate, all of them ONE instanced draw - the planet's ocean
 * (`planet/ocean.ts`) on one plane, with no bend: the coast is where the
 * terrain's triangles meet the water's plane.
 *
 * It looks as the planet's does, by the same rules: colour by the depth of
 * water under it (Beer-Lambert through four stops, read per pixel from the
 * plates' ground corners in one texture), the shore's wash and the wind's
 * whitecaps, and the ripples too small for a pixel filtered into the
 * roughness (Bruneton, Neyret and Holzschuch 2010; Cox and Munk's slope
 * variance for a breeze), so from high the sun is a broad glitter on it.
 */

/** Corners along each side of a plate's ground in the texture. */
const CORNERS = 33;
const CELL = FLAT_PLATE / (CORNERS - 1);
/** Depth over which the water fades in at the shore, so the coastline is never a cut edge. */
const RIM_AT = 0.6;
const SEA_SLOPE_VARIANCE = 0.003 + 0.00512 * 6;
const RESOLVED_VARIANCE = 0.0006;

export interface FlatOcean {
  readonly mesh: InstancedMesh;
  /** Reads the whole flat Earth's ground (world x, y) into the sea's depth, and lays the water where it goes under. */
  build(ground: (x: number, y: number) => number): void;
  /** Reads one plate's ground again (its land was edited: an island raised, a channel dug); `commit` lays the water. */
  setPlate(plate: number, ground: (x: number, y: number) => number): void;
  /** Uploads what `setPlate` changed. */
  commit(): void;
  setLook(look: WaterLook): void;
  dispose(): void;
}

export function createFlatOcean(anisotropy: number): FlatOcean {
  const normalMap = sharedWaterNormals(anisotropy);
  const width = FLAT_COLUMNS * CORNERS, height = FLAT_ROWS * CORNERS;
  const groundData = new Float32Array(width * height);
  const ground = new DataTexture(groundData, width, height, RedFormat, FloatType);
  ground.magFilter = NearestFilter;
  ground.minFilter = NearestFilter;
  ground.generateMipmaps = false;
  ground.needsUpdate = true;

  const material = new MeshStandardMaterial({
    color: 0xffffff,
    normalMap,
    roughness: 0.2,
    metalness: 0,
    transparent: true,
    side: FrontSide,
    envMapIntensity: 0.5,
  });
  material.normalScale.set(0.85, 0.85);
  // Pulled a little towards the eye in depth (glPolygonOffset): where the bed
  // lies close under it the depth buffer cannot tell them apart from afar.
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -4;

  const time = { value: 0 };
  const uniforms = {
    uOceanTime: time,
    uOceanGround: { value: ground },
    // The planet's ocean's colours (`planet/ocean.ts`).
    uShallow: { value: new Color(0x5ccfc6) },
    uShelf: { value: new Color(0x1d7f9c) },
    uDeep: { value: new Color(0x0d3a66) },
    uAbyss: { value: new Color(0x061c3c) },
    uHorizon: { value: new Color(0x8fb4d6) },
    uFoamTint: { value: new Color(0xeef4f6) },
    uWaves: { value: 0.3 },
    uFoamAmount: { value: 0.4 },
    uWaveDrift: { value: new Vector2(0.004, 0.002) },
  };
  const first = flatPlateCentre(0);
  // The texture's corner (0, 0): plate 0's south-west corner, three's x and z.
  const originX = first.x - FLAT_PLATE / 2, originY = first.y - FLAT_PLATE / 2;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
         varying vec3 vOceanWorld;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
         vec4 oceanAt = vec4(transformed, 1.0);
         #ifdef USE_INSTANCING
           oceanAt = instanceMatrix * oceanAt;
         #endif
         vOceanWorld = (modelMatrix * oceanAt).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
         varying vec3 vOceanWorld;
         uniform float uOceanTime;
         uniform sampler2D uOceanGround;
         uniform vec3 uShallow;
         uniform vec3 uShelf;
         uniform vec3 uDeep;
         uniform vec3 uAbyss;
         uniform vec3 uHorizon;
         uniform vec3 uFoamTint;
         uniform float uWaves;
         uniform float uFoamAmount;
         uniform vec2 uWaveDrift;
         float oceanHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
         float oceanNoise(vec3 x) {
           vec3 i = floor(x), f = fract(x);
           f = f * f * (3.0 - 2.0 * f);
           return mix(mix(mix(oceanHash(i), oceanHash(i + vec3(1, 0, 0)), f.x), mix(oceanHash(i + vec3(0, 1, 0)), oceanHash(i + vec3(1, 1, 0)), f.x), f.y),
                      mix(mix(oceanHash(i + vec3(0, 0, 1)), oceanHash(i + vec3(1, 0, 1)), f.x), mix(oceanHash(i + vec3(0, 1, 1)), oceanHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
         }
         // The ground under the sea: the plates' corners, bilinear (world x, y).
         float oceanGroundAt(vec2 world) {
           vec2 g = (world - vec2(${originX.toFixed(2)}, ${originY.toFixed(2)})) / ${CELL.toFixed(4)};
           // The plate, then its corners: a plate's last corner is its neighbour's first.
           vec2 plate = clamp(floor(g / ${(CORNERS - 1).toFixed(1)}), vec2(0.0), vec2(${(FLAT_COLUMNS - 1).toFixed(1)}, ${(FLAT_ROWS - 1).toFixed(1)}));
           vec2 local = clamp(g - plate * ${(CORNERS - 1).toFixed(1)}, vec2(0.0), vec2(${(CORNERS - 1.001).toFixed(3)}));
           vec2 i = floor(local), f = local - i;
           ivec2 p = ivec2(plate) * ${CORNERS} + ivec2(i);
           float a = texelFetch(uOceanGround, p, 0).r;
           float b = texelFetch(uOceanGround, p + ivec2(1, 0), 0).r;
           float c = texelFetch(uOceanGround, p + ivec2(0, 1), 0).r;
           float d = texelFetch(uOceanGround, p + ivec2(1, 1), 0).r;
           return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
         }`)
      .replace('#include <map_fragment>', `
         vec2 oceanMap = vec2(vOceanWorld.x, -vOceanWorld.z);
         float oceanDepth = ${SEA_LEVEL.toFixed(2)} - oceanGroundAt(oceanMap);
         // Past the ripples' size they are filtered into the roughness (Bruneton et al. 2010).
         float oceanFootprint = length(fwidth(vOceanWorld.xz));
         float oceanFar = smoothstep(1.5, 14.0, oceanFootprint);
         vec2 oceanPoint = vOceanWorld.xz;
         vec4 oceanA = texture2D(normalMap, oceanPoint * ${(1 / 34).toFixed(5)} + uOceanTime * vec2(0.035, 0.021));
         vec4 oceanB = texture2D(normalMap, oceanPoint * ${(1 / 11).toFixed(5)} + uOceanTime * vec2(-0.026, 0.047));
         vec4 oceanW = texture2D(normalMap, oceanPoint * ${(1 / 90).toFixed(5)} + uOceanTime * uWaveDrift);
         // Light under the water dies with depth (Beer-Lambert), through four stops.
         float oceanD = max(oceanDepth, 0.0);
         vec3 oceanTint = mix(uShallow, uShelf, 1.0 - exp(-oceanD / 3.0));
         oceanTint = mix(oceanTint, uDeep, 1.0 - exp(-oceanD / 28.0));
         oceanTint = mix(oceanTint, uAbyss, 1.0 - exp(-oceanD / 90.0));
         // A slow swing in tone over the open sea, never one flat blue.
         vec3 oceanSlickAt = vec3(oceanMap * 0.0026, 0.0);
         float oceanSlick = oceanNoise(oceanSlickAt * 22.0) * 0.6 + oceanNoise(oceanSlickAt * 70.0) * 0.4;
         oceanTint *= 0.9 + 0.2 * oceanSlick;
         // The wash on the shore, frayed by the ripples; whitecaps with the wind.
         float oceanLace = oceanA.a * 0.55 + oceanB.a * 0.65;
         float oceanShore = smoothstep(${(RIM_AT * 0.8).toFixed(2)}, ${(RIM_AT * 1.4).toFixed(2)}, oceanD)
           * (1.0 - smoothstep(0.9, 2.2, oceanD + (oceanLace - 0.6) * 1.2));
         float oceanCaps = smoothstep(0.8 - 0.22 * uWaves, 0.97, oceanW.a) * smoothstep(0.25, 0.8, uWaves) * smoothstep(2.0, 8.0, oceanD);
         float oceanFoam = clamp((oceanShore * 0.85 + oceanCaps * 1.6) * uFoamAmount * 1.6, 0.0, 1.0) * (1.0 - oceanFar * 0.85);
         oceanTint = mix(oceanTint, uFoamTint, oceanFoam);
         // The shallows show their bed; the deep does not.
         float oceanAlpha = max(mix(0.5, 0.97, 1.0 - exp(-oceanD / 2.0)), oceanFoam * 0.9);
         float oceanRim = smoothstep(0.0, ${RIM_AT.toFixed(2)}, oceanDepth);
         diffuseColor.rgb = oceanTint;
         diffuseColor.a = oceanAlpha;`)
      .replace('#include <roughnessmap_fragment>', `
         float oceanVariance = ${RESOLVED_VARIANCE.toFixed(4)} + ${(SEA_SLOPE_VARIANCE - RESOLVED_VARIANCE).toFixed(4)} * oceanFar;
         float roughnessFactor = sqrt(sqrt(2.0 * oceanVariance));
         roughnessFactor = mix(roughnessFactor, 0.75, oceanFoam);`)
      .replace('#include <normal_fragment_maps>', `
         vec3 oceanNa = oceanA.xyz * 2.0 - 1.0;
         vec3 oceanNb = oceanB.xyz * 2.0 - 1.0;
         vec3 oceanNw = oceanW.xyz * 2.0 - 1.0;
         float oceanSwell = uWaves * 1.3 * smoothstep(0.8, 5.0, oceanD);
         vec3 mapN = normalize(vec3(oceanNa.xy * 0.62 + oceanNb.xy * 0.48 + oceanNw.xy * oceanSwell, oceanNa.z * oceanNb.z));
         mapN.xy *= normalScale * (1.0 - oceanFar);
         mapN = normalize(mix(mapN, vec3(0.0, 0.0, 1.0), oceanFoam * 0.6));
         normal = normalize(tbn * mapN);`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
         float oceanNdv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
         float oceanFresnel = 0.02 + 0.98 * pow(1.0 - oceanNdv, 5.0);
         vec3 oceanSpecular = mix(vec3(0.02), vec3(1.0), oceanFresnel);
         material.specularColor = oceanSpecular;
         material.specularColorBlended = oceanSpecular;
         material.specularF90 = 1.0;
         // Water's body colour is the little light scattered back from under it.
         material.diffuseContribution *= mix(0.7, 1.0, oceanFoam);
         material.diffuseContribution = mix(material.diffuseContribution, uHorizon * 0.6, oceanFresnel * 0.3);
         diffuseColor.a = clamp(diffuseColor.a + oceanFresnel * 0.4, 0.0, 1.0) * oceanRim;`);
  };
  material.customProgramCacheKey = () => 'flat-ocean-v1';

  const geometry = new PlaneGeometry(FLAT_PLATE, FLAT_PLATE, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new InstancedMesh(geometry, material, FLAT_PLATES);
  mesh.count = 0;
  mesh.name = 'flat-ocean';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  // The instances span the whole flat Earth: three's sphere of the one plate would cull them all.
  mesh.frustumCulled = false;
  const started = performance.now();
  mesh.onBeforeRender = () => { time.value = waterClock(performance.now() - started); };
  const placed = new Matrix4();

  /** Which plates have sea. */
  const wet = new Uint8Array(FLAT_PLATES);
  let dirty = false;
  const setPlate = (plate: number, groundAt: (x: number, y: number) => number): void => {
    const col = plate % FLAT_COLUMNS, row = Math.floor(plate / FLAT_COLUMNS);
    const c = flatPlateCentre(plate);
    let lowest = Infinity;
    for (let j = 0; j < CORNERS; j++) {
      const y = c.y - FLAT_PLATE / 2 + j * CELL;
      const base = (row * CORNERS + j) * width + col * CORNERS;
      for (let i = 0; i < CORNERS; i++) {
        const h = groundAt(c.x - FLAT_PLATE / 2 + i * CELL, y);
        groundData[base + i] = h;
        if (h < lowest) lowest = h;
      }
    }
    const sea = lowest < SEA_LEVEL ? 1 : 0;
    if (sea !== wet[plate]) dirty = true;
    wet[plate] = sea;
    ground.needsUpdate = true;
  };
  const commit = (): void => {
    if (!dirty) return;
    dirty = false;
    let count = 0;
    for (let plate = 0; plate < FLAT_PLATES; plate++) {
      if (!wet[plate]) continue;
      const c = flatPlateCentre(plate);
      placed.makeTranslation(c.x, SEA_LEVEL, -c.y);
      mesh.setMatrixAt(count++, placed);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  };

  return {
    mesh,
    build(groundAt) {
      for (let plate = 0; plate < FLAT_PLATES; plate++) setPlate(plate, groundAt);
      dirty = true;
      commit();
    },
    setPlate,
    commit,
    setLook(look) {
      uniforms.uWaves.value = look.waves;
      uniforms.uFoamAmount.value = look.foam;
      const speed = (1.5 + look.windSpeed * 0.35) / 90;
      uniforms.uWaveDrift.value.set(look.windX * speed, look.windZ * speed);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      ground.dispose();
    },
  };
}
