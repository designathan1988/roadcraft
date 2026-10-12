import {
  Color,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  FrontSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  NearestFilter,
  PlaneGeometry,
  RedFormat,
  Vector2,
} from 'three';

import { PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { TILES, TILE_COUNT, tileToSphereInto } from '@core/planetTiles';
import { ATLAS_COLUMNS, ATLAS_PITCH, ATLAS_ROWS, TILE_PLATE_HALF, TILE_REACH, tileCentre } from '@world/planet/atlas';
import { ICE_CUT, ICE_DRAFT, iceFloats, iceInside } from '@world/planet/ice';
import { SEA_LEVEL, earthHeight } from '@world/planet/relief';
import { m } from '@world/units';
import { type WaterLook, sharedWaterNormals, waterClock } from '../water';
import { ICE_FIELD_GLSL } from './iceField';

/**
 * THE PLANET'S OCEANS: the sea's surface at sea level (`world/planet/relief.ts`
 * `SEA_LEVEL`) over every piece whose ground goes under it - one flat plate a
 * piece, all of them ONE instanced draw, bent onto the sphere by the planet's
 * own chunks (`bend.ts`) as the ground is, so the coast is exactly where the
 * terrain's triangles meet the water's plane.
 *
 * How it looks follows how ocean renderers draw it:
 *  - COLOUR BY DEPTH, read per pixel from the ground under it (a texture of
 *    every piece's terrain corners): pale turquoise over the shallows, teal
 *    over the shelf, navy over the deep, through Beer-Lambert falloffs
 *    (1 - exp(-depth / k)) as the light under water dies - the Earth's coasts
 *    from orbit. Sebastian Lague's ocean (`OceanEffect.shader`,
 *    SebLague/Solar-System) mixes its shallow and deep colours and its alpha
 *    the same way, by the depth of water the eye looks through.
 *  - THE SUN'S GLINT FROM ORBIT: close up the ripples are the normal map's
 *    (the rivers', `water.ts`); farther away, waves smaller than a pixel can
 *    no longer be drawn and their slopes go into the roughness instead, as
 *    Bruneton, Neyret and Holzschuch filter the ocean ("Real-time Realistic
 *    Ocean Lighting using Seamless Transitions from Geometry to BRDF", 2010:
 *    the unresolved slope variance added to the BRDF's). The variance is
 *    Cox and Munk's (1954) for a moderate wind, 0.003 + 0.00512 U, so from
 *    orbit the sun is a broad bright glitter on the sea, as photographs from
 *    the station show, and close up a sharp spark on each ripple.
 *  - THE ICE (`world/planet/ice.ts`): the shelves stand in the terrain, the
 *    sea runs on under them (their base is the ice's draft, nine tenths of
 *    them under the water), so the waterline meets the ice front where the
 *    two surfaces cross. Beyond the front the PACK ICE: angular, polygonal
 *    floes of some tens of metres (wave-broken floes, Frontiers 2021: 13 to
 *    51 m), each a Voronoi cell with its true distance to the border
 *    (Quilez, "Voronoi edges"), smaller and sparser out to the open sea; a
 *    floe's edge bevelled by its height's screen derivatives (Mikkelsen) and
 *    its submerged foot a band of aquamarine through the water. Inside the
 *    ice's edge the sea is drawn as the shelf's snow, so wherever the coarse
 *    far globe dips the shelf under the plane it is still ice.
 *  - Foam where the sea meets the shore, and whitecaps with the wind.
 *
 * The cost: one draw for the whole planet; 289 vertices a piece; in the
 * fragment four texel fetches of the ground and the river's two or three of
 * the ripples. The ground texture is filled once a piece, again only for a
 * piece whose terrain moved (`update`).
 */

/** Corners along each side of a piece's ground in the texture: the terrain's own grid (16 units over the plate). */
const CORNERS = 33;
/** The plate's cell, world units: its corners are the terrain's. */
const CELL = (2 * TILE_PLATE_HALF) / (CORNERS - 1);
/** Cells along each side of a piece's water plate: flat, so it needs vertices only to bend. */
const SEGMENTS = 16;

/** Depth over which the water fades in at the shore, so the coastline is never a cut edge. */
const RIM_AT = 0.6;

/**
 * Slope variance of the sea's surface (Cox and Munk 1954, total of both
 * directions, 0.003 + 0.00512 U) for a breeze of 6 m/s: what the glint's
 * width is made of once the ripples are smaller than a pixel.
 */
const SEA_SLOPE_VARIANCE = 0.003 + 0.00512 * 6;
/** The slope variance left in the material when every ripple is drawn by the normal map. */
const RESOLVED_VARIANCE = 0.0006;

/** The pack ice's floes: the Voronoi cell's size, how high a floe stands, its bevel, and its submerged foot seen through the water. */
const FLOE_CELL = m(34);
const FLOE_FREEBOARD = m(0.45);
const FLOE_BEVEL = m(0.6);
const FLOE_FOOT = m(1.8);
/** A piece's map reaches this far from its centre, as |z|: a piece further than this under `ICE_CUT` has no ice. */
const PIECE_ICE_REACH = (2 * TILE_PLATE_HALF + 2 * TILE_REACH) / PLANET_RADIUS;

export interface PlanetOcean {
  readonly mesh: InstancedMesh;
  /** Reads a piece's ground (its own map's coordinates) into the sea's depth, and lays or lifts its water. */
  setPiece(tile: number, heightAt: (x: number, y: number) => number): void;
  /** Takes the sea off a piece (its land never goes under sea level, or the map has no sea). */
  clearPiece(tile: number): void;
  /** Uploads what `setPiece` changed: once after a batch of pieces. */
  commit(): void;
  setLook(look: WaterLook): void;
  dispose(): void;
}

export function createPlanetOcean(anisotropy: number): PlanetOcean {
  const normalMap = sharedWaterNormals(anisotropy);
  // Every piece's terrain corners, laid as the atlas lays the pieces.
  const width = ATLAS_COLUMNS * CORNERS, height = ATLAS_ROWS * CORNERS;
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
    // Linear colours from the Earth's waters photographed from orbit: the
    // Bahamas' shallows, a shelf sea, the open ocean, the abyss.
    uShallow: { value: new Color(0x5ccfc6) },
    uShelf: { value: new Color(0x1d7f9c) },
    uDeep: { value: new Color(0x0d3a66) },
    uAbyss: { value: new Color(0x061c3c) },
    uHorizon: { value: new Color(0x8fb4d6) },
    uFoamTint: { value: new Color(0xeef4f6) },
    uIce: { value: new Color(0xe4eef4) },
    uWaves: { value: 0.3 },
    uFoamAmount: { value: 0.4 },
    uWaveDrift: { value: new Vector2(0.004, 0.002) },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aOceanTile;
         varying vec3 vOceanWorld;
         varying float vOceanTile;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         // The flat world point, before the planet bends it: the ground and the ripples are read there.
         vec4 oceanFlat = vec4(transformed, 1.0);
         #ifdef USE_INSTANCING
           oceanFlat = instanceMatrix * oceanFlat;
         #endif
         vOceanWorld = (modelMatrix * oceanFlat).xyz;
         vOceanTile = aOceanTile;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vOceanWorld;
         varying float vOceanTile;
         uniform float uOceanTime;
         uniform sampler2D uOceanGround;
         uniform vec3 uShallow;
         uniform vec3 uShelf;
         uniform vec3 uDeep;
         uniform vec3 uAbyss;
         uniform vec3 uHorizon;
         uniform vec3 uFoamTint;
         uniform vec3 uIce;
         uniform float uWaves;
         uniform float uFoamAmount;
         uniform vec2 uWaveDrift;
         ${ICE_FIELD_GLSL}
         // The ice here: how much of the pixel is ice, its bump's height.
         float oceanIce = 0.0;
         float oceanIceBump = 0.0;
         // A cell's point of the floes' Voronoi (integer hash, as the ice field's).
         vec2 floePoint(ivec2 c) { return vec2(iceHashU(c.x, c.y, 7, 91u), iceHashU(c.x, c.y, 11, 92u)); }
         // Quilez, "Voronoi edges": the nearest point (3x3), then the true
         // distance to the nearest border round ITS cell (3x3 here, the 5x5
         // of the article but for the rare far neighbour). x: the distance,
         // in cells; y: the nearest cell's hash.
         vec2 floeVoronoi(vec2 q) {
           ivec2 n = ivec2(floor(q));
           vec2 f = q - floor(q);
           ivec2 mb = ivec2(0);
           vec2 mr = vec2(0.0);
           float best = 8.0;
           for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
             ivec2 b = ivec2(i, j);
             vec2 r = vec2(b) + floePoint(n + b) - f;
             float d = dot(r, r);
             if (d < best) { best = d; mr = r; mb = b; }
           }
           float edge = 8.0;
           for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
             ivec2 b = mb + ivec2(i, j);
             vec2 r = vec2(b) + floePoint(n + b) - f;
             if (dot(mr - r, mr - r) > 1e-5) edge = min(edge, dot(0.5 * (mr + r), normalize(r - mr)));
           }
           ivec2 cell = n + mb;
           return vec2(edge, iceHashU(cell.x, cell.y, 13, 93u));
         }
         float oceanHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
         float oceanNoise(vec3 x) {
           vec3 i = floor(x), f = fract(x);
           f = f * f * (3.0 - 2.0 * f);
           return mix(mix(mix(oceanHash(i), oceanHash(i + vec3(1, 0, 0)), f.x), mix(oceanHash(i + vec3(0, 1, 0)), oceanHash(i + vec3(1, 1, 0)), f.x), f.y),
                      mix(mix(oceanHash(i + vec3(0, 0, 1)), oceanHash(i + vec3(1, 0, 1)), f.x), mix(oceanHash(i + vec3(0, 1, 1)), oceanHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
         }
         // The ground under the sea: the piece's terrain corners, bilinear
         // (three's x, z about the piece's centre; rows run with z, as the terrain's).
         float oceanGroundAt(float tile, vec3 world) {
           float col = mod(tile, ${ATLAS_COLUMNS.toFixed(1)});
           float row = floor(tile / ${ATLAS_COLUMNS.toFixed(1)} + 0.001);
           vec2 centre = vec2((col - ${(ATLAS_COLUMNS / 2).toFixed(1)}) * ${ATLAS_PITCH.toFixed(1)}, -(row - ${(ATLAS_ROWS / 2).toFixed(1)}) * ${ATLAS_PITCH.toFixed(1)});
           vec2 g = clamp((world.xz - centre + ${TILE_PLATE_HALF.toFixed(1)}) / ${CELL.toFixed(4)}, vec2(0.0), vec2(${(CORNERS - 1.001).toFixed(3)}));
           vec2 i = floor(g), f = g - i;
           ivec2 p = ivec2(int(col) * ${CORNERS} + int(i.x), int(row) * ${CORNERS} + int(i.y));
           float a = texelFetch(uOceanGround, p, 0).r;
           float b = texelFetch(uOceanGround, p + ivec2(1, 0), 0).r;
           float c = texelFetch(uOceanGround, p + ivec2(0, 1), 0).r;
           float d = texelFetch(uOceanGround, p + ivec2(1, 1), 0).r;
           return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
         }`,
      )
      .replace(
        '#include <map_fragment>',
        `// Each piece's plate draws only its own part of the sphere: two plates over one place would blend twice.
         // The piece's number, whole: interpolated across the triangle it comes
         // back a hair off (37.99999), and read raw one pixel took the next
         // piece's column of the ground texture - a stipple of wrong depths
         // in the shape of the triangles.
         float oceanTile = floor(vOceanTile + 0.5);
         if (!planetOwns(vOceanWorld, oceanTile, 0.05)) discard;
         float oceanDepth = ${SEA_LEVEL.toFixed(1)} - oceanGroundAt(oceanTile, vOceanWorld);
         // How much ground one pixel covers: past the ripples' size they are
         // filtered into the roughness (Bruneton et al. 2010), and the normal
         // map, mipped flat, is let go.
         float oceanFootprint = length(fwidth(vOceanWorld.xz));
         float oceanFar = smoothstep(1.5, 14.0, oceanFootprint);
         vec2 oceanPoint = vOceanWorld.xz;
         vec4 oceanA = texture2D(normalMap, oceanPoint * ${(1 / 34).toFixed(5)} + uOceanTime * vec2(0.035, 0.021));
         vec4 oceanB = texture2D(normalMap, oceanPoint * ${(1 / 11).toFixed(5)} + uOceanTime * vec2(-0.026, 0.047));
         vec4 oceanW = texture2D(normalMap, oceanPoint * ${(1 / 90).toFixed(5)} + uOceanTime * uWaveDrift);
         // Where on the planet: the polar seas freeze (\`world/planet/ice.ts\`).
         vec3 oceanE, oceanN;
         vec3 oceanDir = planetDirection(vOceanWorld, oceanE, oceanN);
         float oceanIn = iceInside(oceanDir);
         float oceanInAA = max(fwidth(oceanIn), 1e-4);
         // The floes on a polar stereographic plane (conformal, its scale 1.05
         // at the ice's edge): one pattern round each pole, over every piece.
         vec2 floeAt = oceanDir.xy * (2.0 * PLANET_R / (1.0 + abs(oceanDir.z))) / ${FLOE_CELL.toFixed(4)};
         float packAt = clamp(-oceanIn / ICE_PACK_REACH, 0.0, 1.0);
         bool inPack = oceanIn < 0.0 && oceanIn > -ICE_PACK_REACH;
         // Out to the open sea the floes break smaller and drift apart (the
         // marginal ice zone): how much each is worn from its cell, and how
         // many cells hold one.
         float erode = mix(${m(0.5).toFixed(4)}, ${m(9).toFixed(4)}, pow(packAt, 1.3));
         float concentration = mix(0.96, 0.04, pow(packAt, 0.7)) + (oceanNoise(oceanDir * 340.0) - 0.5) * 0.3;
         // Floes a few pixels across are drawn as what they cover, not one by
         // one: a cell's pattern under a pixel was a shimmering speckle from
         // orbit. (The Voronoi is skipped there.)
         float floeCells = max(fwidth(floeAt.x), fwidth(floeAt.y));
         float floeFar = smoothstep(0.1, 0.28, floeCells);
         float floeMean = clamp(concentration, 0.0, 1.0) * pow(clamp(1.0 - erode / ${(FLOE_CELL * 0.42).toFixed(4)}, 0.0, 1.0), 2.0);
         // Within a floe (+) or out of one (-), world units from its edge.
         float floeEdge = -${FLOE_CELL.toFixed(4)};
         float floeTone = 0.5;
         if (inPack && floeFar < 0.999) {
           vec2 v = floeVoronoi(floeAt);
           float kept = step(v.y, concentration);
           floeEdge = mix(-${FLOE_CELL.toFixed(4)}, v.x * ${FLOE_CELL.toFixed(4)} - erode, kept);
           floeTone = v.y;
         }
         float floeAA = max(fwidth(floeEdge), 1e-4);
         // Only on water deep enough to float in: over the low strand the
         // sea's plane, pulled towards the eye, won over the land in the
         // terrain's triangles, and the floes drew the grid there in white teeth.
         float floeWater = smoothstep(${m(0.8).toFixed(4)}, ${m(2.6).toFixed(4)}, oceanDepth);
         float floe = mix(smoothstep(-0.5 * floeAA, 0.5 * floeAA, floeEdge), inPack ? floeMean : 0.0, floeFar) * floeWater;
         float shelf = smoothstep(-0.5 * oceanInAA, 0.5 * oceanInAA, oceanIn);
         oceanIce = max(floe, shelf);
         // The floe's bevelled edge, by the height its bump reads.
         oceanIceBump = ${FLOE_FREEBOARD.toFixed(4)} * smoothstep(0.0, max(${FLOE_BEVEL.toFixed(4)}, floeAA * 1.5), floeEdge) * (1.0 - shelf) * (1.0 - floeFar) * floeWater;
         // The pack calms the sea between its floes.
         float oceanCalm = 1.0 - 0.85 * (1.0 - packAt) * step(-ICE_PACK_REACH, oceanIn);
         // Light under the water dies with depth (Beer-Lambert), through four stops.
         float oceanD = max(oceanDepth, 0.0);
         vec3 oceanTint = mix(uShallow, uShelf, 1.0 - exp(-oceanD / 3.0));
         oceanTint = mix(oceanTint, uDeep, 1.0 - exp(-oceanD / 28.0));
         oceanTint = mix(oceanTint, uAbyss, 1.0 - exp(-oceanD / 90.0));
         // A slow swing in tone over the open sea, currents and plankton, never one flat blue.
         float oceanSlick = oceanNoise(oceanDir * 22.0) * 0.6 + oceanNoise(oceanDir * 70.0) * 0.4;
         oceanTint *= 0.9 + 0.2 * oceanSlick;
         // The wash on the shore: a band set in from the waterline, frayed by the ripples' noise.
         float oceanLace = oceanA.a * 0.55 + oceanB.a * 0.65;
         float oceanShore = smoothstep(${(RIM_AT * 0.8).toFixed(2)}, ${(RIM_AT * 1.4).toFixed(2)}, oceanD)
           * (1.0 - smoothstep(0.9, 2.2, oceanD + (oceanLace - 0.6) * 1.2));
         float oceanCaps = smoothstep(0.8 - 0.22 * uWaves, 0.97, oceanW.a) * smoothstep(0.25, 0.8, uWaves) * smoothstep(2.0, 8.0, oceanD) * oceanCalm;
         float oceanFoam = clamp((oceanShore * 0.85 + oceanCaps * 1.6) * uFoamAmount * 1.6, 0.0, 1.0) * (1.0 - oceanFar * 0.85);
         oceanTint = mix(oceanTint, uFoamTint, oceanFoam);
         // A floe's foot under the water, aquamarine through it, round its edge.
         float floeFoot = (1.0 - smoothstep(0.0, ${FLOE_FOOT.toFixed(4)}, -floeEdge)) * step(floeEdge, 0.0) * (1.0 - packAt * 0.6) * (1.0 - floeFar) * floeWater;
         oceanTint = mix(oceanTint, vec3(0.16, 0.5, 0.52), floeFoot * 0.55);
         // The floes: snow-covered, a few the grey of young ice; the shelf's snow inside the edge.
         vec3 floeTop = floeTone < 0.14 ? vec3(0.46, 0.55, 0.62) : uIce * (0.9 + 0.12 * floeTone);
         vec3 shelfTop = vec3(0.8, 0.84, 0.9) * (0.93 + 0.1 * iceNoise(oceanDir * PLANET_R, ${m(47).toFixed(4)}, 71u));
         oceanTint = mix(oceanTint, mix(floeTop, shelfTop, shelf), oceanIce);
         // The shallows show their bed; the deep does not.
         float oceanAlpha = mix(0.5, 0.97, 1.0 - exp(-oceanD / 2.0));
         oceanAlpha = max(max(oceanAlpha, oceanFoam * 0.9), oceanIce);
         float oceanRim = smoothstep(0.0, ${RIM_AT.toFixed(2)}, oceanDepth);
         diffuseColor.rgb = oceanTint;
         diffuseColor.a = oceanAlpha;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `// The glint's width: the slopes no pixel can draw, as roughness (Cox-Munk variance, GGX alpha = sqrt(2 variance)).
         float oceanVariance = ${RESOLVED_VARIANCE.toFixed(4)} + ${(SEA_SLOPE_VARIANCE - RESOLVED_VARIANCE).toFixed(4)} * oceanFar;
         float roughnessFactor = sqrt(sqrt(2.0 * oceanVariance));
         roughnessFactor = mix(roughnessFactor, 0.75, max(oceanFoam, oceanIce));`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 oceanNa = oceanA.xyz * 2.0 - 1.0;
         vec3 oceanNb = oceanB.xyz * 2.0 - 1.0;
         vec3 oceanNw = oceanW.xyz * 2.0 - 1.0;
         float oceanSwell = uWaves * 1.3 * smoothstep(0.8, 5.0, oceanD) * oceanCalm;
         vec3 mapN = normalize(vec3(oceanNa.xy * 0.62 + oceanNb.xy * 0.48 + oceanNw.xy * oceanSwell, oceanNa.z * oceanNb.z));
         mapN.xy *= normalScale * (1.0 - oceanFar) * (1.0 - oceanIce);
         mapN = normalize(mix(mapN, vec3(0.0, 0.0, 1.0), oceanFoam * 0.6));
         normal = normalize(tbn * mapN);
         // The floes' bevelled edges (their height's screen derivatives, out of any branch).
         {
           vec2 floeDH = vec2(dFdx(oceanIceBump), dFdy(oceanIceBump));
           vec3 floeSX = dFdx(-vViewPosition), floeSY = dFdy(-vViewPosition);
           if (oceanIce > 0.0) normal = icePerturbNormal(floeSX, floeSY, normal, floeDH, faceDirection);
         }`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
         float oceanNdv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
         float oceanFresnel = 0.02 + 0.98 * pow(1.0 - oceanNdv, 5.0);
         vec3 oceanSpecular = mix(vec3(0.02), vec3(1.0), oceanFresnel) * (1.0 - oceanIce * 0.7);
         material.specularColor = oceanSpecular;
         material.specularColorBlended = oceanSpecular;
         material.specularF90 = 1.0;
         // Water's body colour is the little light scattered back from under it.
         material.diffuseContribution *= mix(0.7, 1.0, max(oceanFoam, oceanIce));
         material.diffuseContribution = mix(material.diffuseContribution, uHorizon * 0.6, oceanFresnel * 0.3 * (1.0 - oceanIce));
         diffuseColor.a = clamp(diffuseColor.a + oceanFresnel * 0.4, 0.0, 1.0) * oceanRim;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         // The night side takes no sky: the sky's light and its reflection fade where the sun has set.
         #if NUM_DIR_LIGHTS > 0
           float oceanDay = planetDaylight(geometryPosition, directionalLights[0].direction);
           reflectedLight.indirectSpecular *= mix(0.06, 1.0, oceanDay);
           reflectedLight.indirectDiffuse *= mix(0.25, 1.0, oceanDay);
         #endif`,
      );
  };
  material.customProgramCacheKey = () => 'planet-ocean-v2';

  const geometry = new PlaneGeometry(2 * TILE_PLATE_HALF, 2 * TILE_PLATE_HALF, SEGMENTS, SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  const tiles = new Float32Array(TILE_COUNT);
  const tileAttribute = new InstancedBufferAttribute(tiles, 1);
  tileAttribute.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aOceanTile', tileAttribute);
  const mesh = new InstancedMesh(geometry, material, TILE_COUNT);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  mesh.name = 'planet-ocean';
  // One draw over the whole atlas: three's culling of the instanced mesh's
  // box would test the atlas, not the planet (bend.ts).
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  /** Which pieces have sea, and in which slot of the instances. */
  const wet = new Uint8Array(TILE_COUNT);
  let dirty = false;
  const placed = new Matrix4();
  const onSphere: Vec3 = { x: 0, y: 0, z: 0 };
  const started = performance.now();
  mesh.onBeforeRender = () => {
    time.value = waterClock(performance.now() - started);
  };

  return {
    mesh,
    setPiece(tile, heightAt) {
      const col = tile % ATLAS_COLUMNS, row = Math.floor(tile / ATLAS_COLUMNS);
      const icy = Math.abs(TILES[tile]!.centre.z) > ICE_CUT - PIECE_ICE_REACH;
      let lowest = Infinity;
      for (let j = 0; j < CORNERS; j++) {
        // Rows run with three's z (map y falling), as the terrain's own grid.
        const y = TILE_PLATE_HALF - j * CELL;
        const base = (row * CORNERS + j) * width + col * CORNERS;
        for (let i = 0; i < CORNERS; i++) {
          const x = -TILE_PLATE_HALF + i * CELL;
          let h = heightAt(x, y);
          if (icy) {
            // A shelf floats: the sea runs on under it, down to its base. (The
            // sea is the Earth's only: its bed is the Earth's.)
            tileToSphereInto(tile, x, y, onSphere);
            const inside = iceInside(onSphere.x, onSphere.y, onSphere.z);
            if (inside > 0 && iceFloats(earthHeight(onSphere.x, onSphere.y, onSphere.z), inside)) h = SEA_LEVEL - ICE_DRAFT;
          }
          groundData[base + i] = h;
          if (h < lowest) lowest = h;
        }
      }
      const sea = lowest < SEA_LEVEL ? 1 : 0;
      if (sea !== wet[tile]) dirty = true;
      wet[tile] = sea;
      ground.needsUpdate = true;
    },
    clearPiece(tile) {
      if (wet[tile]) dirty = true;
      wet[tile] = 0;
    },
    commit() {
      if (!dirty) return;
      dirty = false;
      let count = 0;
      for (let t = 0; t < TILE_COUNT; t++) {
        if (!wet[t]) continue;
        const c = tileCentre(t);
        placed.makeTranslation(c.x, SEA_LEVEL, -c.y);
        mesh.setMatrixAt(count, placed);
        tiles[count] = t;
        count++;
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      tileAttribute.needsUpdate = true;
    },
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
      mesh.dispose();
    },
  };
}
