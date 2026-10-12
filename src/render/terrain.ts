import type { Aabb } from '@core/aabb';
import { Digest } from '@core/digest';
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  FrontSide,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  DataTexture,
  DataArrayTexture,
  NoColorSpace,
  RGBAFormat,
  UnsignedByteType,
  LinearFilter,
  ClampToEdgeWrapping,
  LinearMipmapLinearFilter,
  NearestFilter,
  RedFormat,
  FloatType,
  RepeatWrapping,
  SRGBColorSpace,
  Sphere,
  Vector3,
  Vector4,
  type Material,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { UNITS_PER_METER as UNITS_PER_METER_HERE, m, perM } from '@world/units';
import { TILES_PER_SIDE, TILE_COUNT as PLANET_TILE_COUNT } from '@core/planetTiles';
import { gridOrigin, onGridOrigin } from '@world/planet/charts';
import { PLATE_CELL } from '@world/planet/atlas';

import type { RoadDoc } from '@world/doc';
import { BIOME_KINDS, COVER_KINDS, PAINT_KINDS, isBiomeKind, isGeologyKind, type CoverKind, type GeologyKind, type PaintDab } from '@world/terrainPaint';
import { REGIONS, computeEcology, type EcologyField, type NatureSettings } from '@world/ecology';
import { GroundChanges } from './groundChanges';
import { createLandLighter, unionCorners, type CornerRect, type LightRequest, type LightResult } from './terrainLightCompute';
import { submitLight } from './terrainLightPool';
import { ecologyOffPage, readEcology } from './ecologyPool';
import { SEA_LEVEL } from '@world/planet/relief';
import { FLAT_EARTH_GLSL } from './flatEarthGlsl';
import type { PlateMesh } from './plateMesh';
import { steepnessInto } from './terrainSteep';
import type { ChangeJournal } from '@world/changes';
import { MAP_SIZE } from '@world/bounds';
import {
  MAX_TERRAIN_STAMPS,
  RELIEF_EARTH,
  RIVER_BED_FLOOR,
  TERRAIN_WATER_HEIGHT,
  TerrainIndex,
  sampleTerrainHeight,
  terrainInfluence,
  type TerrainStamp,
} from '@world/terrain';
import { bakeSurface, fbm, makeNoise, type SurfaceBake, type SurfaceRecipe } from './mesh/textureBaker';
import { DETAIL_GLSL, detailSwitch, detailTextures } from './mesh/detailLayer';
import { WATER_DEPTH_ATTRIBUTE, WATER_FLOW_ATTRIBUTE, createWaterSurface, type WaterLook } from './water';
import type { GullyDab } from '@world/gullies';
import { RELIEF_TEXTURE, createReliefBake } from './terrainRelief';
import { ICE_FIELD_GLSL } from './planet/iceField';

/** Pieces on a face of the planet's cube (`core/planetTiles.ts`). */
const TILES_PER_FACE = TILES_PER_SIDE * TILES_PER_SIDE;

/**
 * Side of the playable, editable terrain plate, in world units.
 *
 * The world the editor authors in is 4096 units across. The plate is a little
 * wider so the player never reaches its rim, and a separate, cheap backdrop
 * carries the view out to the horizon beyond it — a single large plate at the
 * resolution the play area needs would be most of the frame's vertex budget
 * spent on ground nobody builds on.
 */
const TERRAIN_SIZE = MAP_SIZE;
/**
 * Cells per side. 300 gives a 16-unit cell: 6.4 m, fine enough for a brush.
 * The planet's faces are wider (6 km): 375 keeps the same cell.
 */
const TERRAIN_SEGMENTS = __PLANET__ ? Math.round(MAP_SIZE / PLATE_CELL) : 300;
export const TERRAIN_BASE = m(-0.048);

/** Radius of a river's water disc, as a fraction of the stamp that carved it. */
const WATER_RADIUS = 0.92;
/** How far past the brush the surface may reach to find its shore. */
const WATER_SPREAD = 1.6;
/** Share of a channel's depth the water fills, measured down from its banks. */
const WATER_FILL = 0.45;
/** How far under the ground the surface stays, so its rim is never left dry. */
const WATER_MARGIN = m(0.16);
/** Grid resolution of the unified river surface. */
const WATER_CELL = m(1.6);

/**
 * THE PLANET'S CLIMATES in the ground's colour: value noise read at the point
 * of the sphere, so the biomes' borders wander the same on both sides of every
 * border between pieces (Catlike Coding, "Seamless Cube Sphere": noise at the
 * 3-D position, never per face). Empty on the flat map, whose shaders hold no
 * planet.
 */
const PLANET_BIOME_NOISE = `
  ${FLAT_EARTH_GLSL}
  ${ICE_FIELD_GLSL}
  // \`natureNoise.ts\` natureNoise, the same integer hash (uint wraps as Math.imul does).
  float woodsHash(int a, int b, int c, uint salt) {
    uint v = (uint(a) * 374761393u) ^ (uint(b) * 668265263u) ^ (uint(c) * 1440670441u) ^ (salt * 2246822519u);
    v = (v ^ (v >> 13u)) * 1274126177u;
    return float(v ^ (v >> 16u)) / 4294967296.0;
  }
  float woodsLayer(ivec3 c, vec2 sm, int z, uint salt) {
    float top = mix(woodsHash(c.x, c.y, z, salt), woodsHash(c.x + 1, c.y, z, salt), sm.x);
    float bottom = mix(woodsHash(c.x, c.y + 1, z, salt), woodsHash(c.x + 1, c.y + 1, z, salt), sm.x);
    return mix(top, bottom, sm.y);
  }
  // \`natureNoise.ts\` natureNoise3 at a point of the sphere (world units).
  float woodsNoise(vec3 p, float scale, uint salt) {
    vec3 g = p / scale, c = floor(g), f = g - c;
    vec3 sm = f * f * (3.0 - 2.0 * f);
    ivec3 ci = ivec3(c);
    return mix(woodsLayer(ci, sm.xy, ci.z, salt), woodsLayer(ci, sm.xy, ci.z + 1, salt), sm.z);
  }
  float planetBiomeHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float planetBiomeNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(planetBiomeHash(i), planetBiomeHash(i + vec3(1, 0, 0)), f.x), mix(planetBiomeHash(i + vec3(0, 1, 0)), planetBiomeHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(planetBiomeHash(i + vec3(0, 0, 1)), planetBiomeHash(i + vec3(1, 0, 1)), f.x), mix(planetBiomeHash(i + vec3(0, 1, 1)), planetBiomeHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
`;

/**
 * The biomes by latitude, as the Earth's (the planet's axis is its frame's z,
 * world/planet/sun.ts): ice caps over the poles (the polar circles, ~66
 * degrees), tundra and taiga below them, the dry belt of the subtropics where
 * the Hadley cells' air comes down (~30 degrees: the Sahara, the Atacama,
 * Australia's deserts), and the wet green of the tropics. Only the ground's
 * HUE turns - its own texture, brightness and contrast kept, as the savanna's
 * straw is - so it is the same land to build on.
 */
const PLANET_BIOMES = `
  {
    vec3 biomeE, biomeN;
    vec3 globe = planetDirection(vTerrainAtlas, biomeE, biomeN);
    // Continents of climate: a broad wander at the planet's scale, a finer one on its edges.
    float wander = (planetBiomeNoise(globe * 2.3) - 0.5) * 0.26 + (planetBiomeNoise(globe * 8.9 + 4.1) - 0.5) * 0.08
      + (planetBiomeNoise(globe * 31.0 + 9.3) - 0.5) * 0.025;
    float lat = clamp(abs(globe.z) + wander, 0.0, 1.0);
    float luma = dot(blended.rgb, vec3(0.3, 0.6, 0.1));
    // The texture's own light and shade, about its mean: carried onto every
    // biome's colour, so sand and snow keep the ground's grain.
    float grain = clamp(luma / 0.19, 0.55, 1.5);
    // Taiga and tundra: a cold, browner olive, thinning to lichen.
    float cold = smoothstep(0.7, 0.86, lat);
    vec3 tundra = luma * mix(vec3(0.92, 1.0, 0.72), vec3(1.2, 1.1, 0.88), smoothstep(0.8, 0.9, lat));
    blended.rgb = mix(blended.rgb, tundra, cold * 0.8 * living);
    // The dry belt: steppe gold over a wide band, the deserts in its heart
    // where the air is driest - whole regions, not stripes.
    float belt = exp(-pow((lat - 0.47) / 0.17, 2.0));
    float arid = planetBiomeNoise(globe * 2.1 + 11.0) * 0.75 + planetBiomeNoise(globe * 7.3 + 3.0) * 0.25;
    float dryness = belt * (0.35 + 1.1 * arid);
    float steppe = smoothstep(0.3, 0.6, dryness);
    float desert = smoothstep(0.55, 0.9, dryness);
    vec3 straw = luma * vec3(1.32, 1.06, 0.5);
    // Ochre, as the Earth's deserts seen from orbit (pale sand read as cloud from afar).
    vec3 sand = vec3(0.58, 0.42, 0.24) * grain * (0.9 + 0.2 * planetBiomeNoise(globe * 140.0));
    blended.rgb = mix(blended.rgb, straw, steppe * 0.7 * living);
    blended.rgb = mix(blended.rgb, sand, desert * 0.92 * living);
    // THE ICE (\`world/planet/ice.ts\`): where the relief stands it - a sheet
    // over the land, a shelf over the sea - its edge one pixel sharp, as the
    // cliff under it is (the paint was a white wash with a blurred rim, the
    // player 2026-10-11). Snow over it, albedo about 0.8; bare blue ice
    // (about 0.56, smoother) where the wind scours it, near the margin and
    // on every steep face, blue because dense ice absorbs the red (USGS);
    // transverse crevasses across the flow, which runs out to the edge, so
    // they follow the edge's own lines.
    // Only a polar face's pieces (and the far globe's one draw) can hold ice:
    // every point over |z| 0.707 is on the cube's faces 2 and 5, and the ice
    // begins past 0.85. A branch on the piece's uniform, so every pixel of a
    // draw takes it alike and the derivatives in it stay defined.
    if (uPlanetTile < 0.0 || int(uPlanetTile) / ${TILES_PER_FACE} == 2 || int(uPlanetTile) / ${TILES_PER_FACE} == 5) {
    vec2 iceIn2 = iceInside2(globe);
    float iceIn = iceIn2.x;
    float iceAA = max(fwidth(iceIn), 1e-4);
    vec3 iceAt = globe * PLANET_R;
    bool icePolar = abs(globe.z) >= ICE_CUT_Z;
    // The crevasses run along the edge's own lines, a little bent; their
    // coordinate and its screen footprint, out of any branch.
    float iceBend = icePolar ? iceNoise(iceAt, ${m(70).toFixed(4)}, 76u) : 0.0;
    float crevU = (iceIn2.y + iceBend * ${m(3).toFixed(4)}) / ${m(13).toFixed(4)};
    float crevAA = fwidth(crevU);
    // The face's layers fade before they are finer than the pixel (they ran into moire).
    float layersSeen = 1.0 - smoothstep(0.25, 0.6, fwidth(vTerrainWorld.y) / ${m(1.1).toFixed(4)});
    terrainIce = smoothstep(-0.5 * iceAA, 0.5 * iceAA, iceIn);
    if (terrainIce > 0.0) {
      float drift = iceNoise(iceAt, ${m(47).toFixed(4)}, 71u) * 0.6 + iceNoise(iceAt, ${m(13).toFixed(4)}, 72u) * 0.4;
      // The snow's small dunes and sastrugi, seen close.
      float dunes = iceNoise(iceAt, ${m(3.5).toFixed(4)}, 78u);
      vec3 snowTop = vec3(0.8, 0.84, 0.9) * (0.93 + 0.1 * drift);
      // Bare blue ice: the ablation zone by the margin, and a few patches
      // scoured inland (blue-ice areas are about 1% of Antarctica's ice).
      float scour = smoothstep(0.7, 0.82, iceNoise(iceAt, ${m(260).toFixed(4)}, 73u) * 0.7
        + iceNoise(iceAt, ${m(70).toFixed(4)}, 74u) * 0.3
        + 0.3 * (1.0 - smoothstep(${m(30).toFixed(4)}, ${m(260).toFixed(4)}, iceIn)));
      // The faces: the front and the margin's wall (the steep band the
      // relief rises over, \`ice.ts\` FRONT_WIDTH) - bare ice in the layers
      // the years laid down, blue as dense ice is.
      float face = max(smoothstep(12.0, 24.0, slopeDeg), 1.0 - smoothstep(ICE_FRONT_WIDTH * 0.55, ICE_FRONT_WIDTH * 0.9, iceIn));
      float layers = 0.5 + 0.5 * sin(vTerrainWorld.y * ${(Math.PI * 2 / m(1.1)).toFixed(4)} + iceBend * 5.0);
      vec3 blueIce = vec3(0.44, 0.6, 0.72) * (0.92 + 0.1 * drift);
      vec3 faceIce = mix(vec3(0.26, 0.46, 0.62), vec3(0.55, 0.7, 0.82), mix(0.5, layers, layersSeen) * 0.55 + drift * 0.25);
      vec3 iceColour = mix(snowTop, blueIce, scour * 0.75);
      iceColour = mix(iceColour, faceIce, face);
      // The crevasses (transverse: across the flow, which runs out to the
      // edge): bands of them a little in from the margin and along a few
      // shear zones inland, each crack a few tens of metres long, en
      // echelon, a metre or so wide - a dark slot, blue walls, white lips.
      float field = smoothstep(${m(35).toFixed(4)}, ${m(70).toFixed(4)}, iceIn) * (1.0 - smoothstep(${m(160).toFixed(4)}, ${m(300).toFixed(4)}, iceIn))
        + smoothstep(0.82, 0.88, iceNoise(iceAt, ${m(600).toFixed(4)}, 75u));
      // Each crack a run of the noise over its threshold: some 10 to 30 m.
      float crack = smoothstep(0.6, 0.68, iceNoise(iceAt, ${m(16).toFixed(4)}, 77u)) * clamp(field, 0.0, 1.0);
      float across = abs(fract(crevU) - 0.5);
      float halfWidth = 0.02 + 0.016 * drift;
      float crevasse = crack * (1.0 - smoothstep(halfWidth - crevAA, halfWidth + crevAA, across));
      // Seen from afar a crevasse is a line under a pixel: its share of the pixel, never a flicker.
      crevasse *= clamp(halfWidth / max(crevAA, 1e-4), 0.0, 1.0);
      // The slot in shadow, its walls deep blue only at the lips.
      vec3 crevColour = mix(vec3(0.015, 0.05, 0.1), vec3(0.12, 0.32, 0.5), smoothstep(0.7 * halfWidth, halfWidth, across));
      iceColour = mix(iceColour, crevColour, crevasse * (1.0 - face));
      blended.rgb = mix(blended.rgb, iceColour, terrainIce);
      terrainIceGlaze = max(max(scour * 0.75, face * 0.55), crevasse);
      terrainIceThin = max(face, crevasse);
      // The bumps: the crevasse sunk, the snow's drifts, fading with the pixel's footprint.
      float near = 1.0 - smoothstep(0.05, 0.4, crevAA);
      terrainIceBump = (-crevasse * (1.0 - face) * ${m(0.6).toFixed(4)} + (drift - 0.5) * ${m(0.7).toFixed(4)} + (dunes - 0.5) * ${m(0.18).toFixed(4)}) * near * terrainIce;
      // The face read as the wall it stands for: the relief can only rise
      // over three of its cells (\`ice.ts\` FRONT_WIDTH), so the light is
      // given the steepness of a cliff - twice the rise again over the band.
      terrainIceBump += 2.0 * ICE_FRONT_HEIGHT * smoothstep(0.0, ICE_FRONT_WIDTH, iceIn);
    }
    }
    // The tropics' wet green, a little deeper.
    float tropic = 1.0 - smoothstep(0.12, 0.32, lat);
    blended.rgb = mix(blended.rgb, blended.rgb * vec3(0.86, 1.04, 0.84), tropic * 0.6 * living);
  }
`;

/**
 * World size of one terrain quad.
 *
 * The terrain mesh holds one vertex per cell and interpolates linearly between
 * them, so anything laid on the ground must be tessellated to at most this step
 * or it chords across a bump it never sampled.
 */
export const TERRAIN_CELL = TERRAIN_SIZE / TERRAIN_SEGMENTS;


/** A shore texel with no water near it (`shoreLevels`). */
const NO_WATER = -100_000;

/** Corners per side of the terrain grid — one more than its cells. */
const GRID = TERRAIN_SEGMENTS + 1;
/**
 * Half the terrain plate's extent. Nothing may be placed outside it.
 *
 * The ground is a finite 4800-unit plate. Anything scattered beyond it hangs
 * in the void with no surface under it, which is exactly what happened to the
 * vegetation: it was spread over `max(900, networkBounds * 0.85)` about the
 * network centre with no reference to the terrain at all, so a network near an
 * edge planted trees off the end of the world.
 */
export const TERRAIN_HALF = TERRAIN_SIZE / 2;

/**
 * Where the grass field stands this frame (`grassField.ts`): world x, y, how
 * far it reaches, and 1 when it is drawn. The ground shades itself under it.
 */
export const GRASS_FIELD: { value: [number, number, number, number] } = { value: [0, 0, 0, 0] };
/**
 * The universal grid drawn by the ground itself (`SceneHandle.setGrid`): the
 * cell (world units), the strength (0: off) and the map's half size. Part of
 * the terrain's own colour, it lies on the ground as drawn whatever roads are
 * laid, changed or removed - a set of lines over the ground went under it
 * wherever the ground was cut or filled after them (the player, 2026-10-06).
 */
export const TERRAIN_GRID: { value: [number, number, number] } = { value: [m(10), 0, m(960)] };
/**
 * The planet's pieces drawn in full (`planet/terrainAtlas.ts`), one bit a
 * piece, 24 to a float (exact in a float's mantissa): the far globe's ground
 * draws the others only. A uniform array, not a texture: the terrain's
 * fragment shader already holds the 16 texture units WebGL guarantees.
 */
/**
 * The planet grid's origin (`world/planet/charts.ts` setGridOrigin): its
 * centre, east and north on the sphere, shared by every plate and moved with
 * the place the player builds.
 */
const GRID_ORIGIN_GLSL = 'uniform vec3 GRID_C; uniform vec3 GRID_E; uniform vec3 GRID_N;';
const GRID_FRAME = { c: { value: new Vector3() }, e: { value: new Vector3() }, n: { value: new Vector3() } };
const readGridFrame = (): void => {
  const o = gridOrigin();
  GRID_FRAME.c.value.set(o.c.x, o.c.y, o.c.z);
  GRID_FRAME.e.value.set(o.e.x, o.e.y, o.e.z);
  GRID_FRAME.n.value.set(o.n.x, o.n.y, o.n.z);
};
if (__PLANET__) { readGridFrame(); onGridOrigin(readGridFrame); }
export const PLANET_ACTIVE_WORDS = Math.ceil(PLANET_TILE_COUNT / 24);
export const PLANET_ACTIVE_TILES: { value: Float32Array } = { value: new Float32Array(PLANET_ACTIVE_WORDS) };
/**
 * How far into the dry season the land is, 0 (the rains: everything green)
 * to 1 (the height of the drought: the savanna's grass straw-gold). Shared
 * by the ground and the grass; the seasons set it.
 */
export const SEASON_DRY: { value: number } = { value: 0.4 };

/**
 * What the surface reads of the document: the map's own, or (on the planet)
 * one face's share of it, in the face's coordinates (`planet/terrainAtlas.ts`).
 */
export type TerrainSource = Pick<RoadDoc, 'changes' | 'terrainRevision' | 'terrainStamps' | 'terrainRelief' | 'natureRevision' | 'nature' | 'paintRevision' | 'terrainPaint'> & {
  /** The land under the stamps when it is not the plane's relief (a planet face's, `planet/relief.ts`). */
  readonly terrainGround?: (x: number, y: number) => number;
  /**
   * Where the sea may stand (the plate's own coordinates), when the land is
   * the Earth's only in part: the whole flat Earth round an old map, whose own
   * plate keeps its dry valleys (`world/flatEarth.ts` flatSeaFor). A map on
   * the Earth's relief has its sea everywhere.
   */
  readonly terrainSea?: (x: number, y: number) => boolean;
};

export interface TerrainSurface {
  readonly meshes: readonly Object3D[];
  readonly ground: Mesh;
  /**
   * Where the sun is (a direction towards it, three's axes): the relief's
   * shadows are cast again when it has moved, and its sky again when the
   * land has (`terrainLight`).
   */
  setSun(direction: { readonly x: number; readonly y: number; readonly z: number }): void;
  /**
   * Bakes the fine relief the light reads (`terrainRelief.ts`) when the land
   * has changed since - once a stroke is let go, as the water is.
   */
  bakeRelief(renderer: WebGLRenderer, focus: { readonly x: number; readonly z: number } | null): void;
  /** How the rivers and lakes look and move: waves, foam, current (`render/water.ts` WaterLook). */
  setWaterLook(look: WaterLook): void;
  /** The gullies the player cut or wiped, and how much of the steep land carries them of itself (`world/gullies.ts`). */
  setGullies(dabs: readonly GullyDab[], auto: number): void;
  /**
   * The terrain's own surface for the batter from a footway down to the
   * ground (`roadSurfaces.ts`): the same lawn, read as LEVEL ground whatever
   * its slope. The batter is steep over a short run, and the slope bands of
   * the terrain shader painted it as soil and rock - brown streaks along
   * every pavement.
   */
  readonly vergeMaterial: Material;
  /** The analytic height field: the smooth surface the stamps describe. */
  heightAt(x: number, y: number): number;
  /**
   * The ground as DRAWN, before any road cut or filled it.
   *
   * This is what the road profile is solved against. Solving it against the
   * shaped surface instead would feed the roads their own previous answer, and
   * the ground and the road would chase each other a little further apart on
   * every rebuild.
   */
  naturalRenderedHeightAt(x: number, y: number): number;
  /**
   * A digest of everything `renderedHeightAt` and `naturalRenderedHeightAt`
   * read inside a rectangle: the corners, shaped and natural, of every cell
   * they touch, and the stamps themselves where the rectangle leaves the plate
   * and the field is read analytically.
   */
  digest(minX: number, minY: number, maxX: number, maxY: number): number;
  /**
   * The height the terrain is actually DRAWN at.
   *
   * The mesh samples the field at cell corners and interpolates linearly across
   * the triangles between them, so the drawn surface differs from the field by
   * up to `(cell^2 / 8) * |H''|`. Anything laid on the ground must clear what is
   * on screen, not what the field says, or it sinks into a triangle.
   */
  renderedHeightAt(x: number, y: number): number;
  /**
   * Whether a point is under a river's water.
   *
   * NOT "the ground is low": the base relief dips well below zero over whole
   * valleys with no water in them, and planting was skipped wherever it did -
   * which left the ground around a crossroads in such a valley bare.
   */
  wetAt(x: number, y: number): boolean;
  /**
   * Rewrites the heightfield from the document's stamps alone.
   *
   * The first half of a two-pass build. Roads are solved against THIS surface,
   * because a road has to be laid on the natural ground before the ground can
   * be asked to come and meet it.
   */
  update(doc: TerrainSource, stroking?: boolean): boolean;
  /**
   * Brings the painted ground up to `doc.paintRevision`. `deferEcology`: the
   * ecosystem is left to `settleEcology` (the planet's atlas reads its 864
   * plates' a few at a time, nearest the view first).
   */
  updatePaint(doc: TerrainSource, deferEcology?: boolean): void;
  /** Whether the ecosystem waits to be read again (`settleEcology`). */
  readonly ecologyPending?: boolean;
  /** Reads the ecosystem again if it waits to be: true when it did. */
  settleEcology?(): boolean;
  /** How much forest was painted at a point, 0..1 (`world/terrainPaint.ts` 'forest'). */
  forestAt(x: number, y: number): number;
  /** How much of a cover (forest, scrub, flowers, rocks) was painted at a point, 0..1. */
  coverAt(kind: CoverKind, x: number, y: number): number;
  /** Moves whenever the covers painted change. */
  readonly forestRevision: number;
  /** Which rock the land is made of at a point (the painted geology; granite where none was). */
  geologyAt(x: number, y: number): GeologyKind;
  /** What grows on the land (`world/ecology.ts`), or null on a map with no ecosystem. */
  ecology(): EcologyField | null;
  /** Moves whenever `ecology()` changes. */
  readonly ecologyRevision: number;
  /** The ecology's ground classes per terrain corner, for the grass and the plants' shaders. */
  readonly ecologyTexture: Texture;
  /** Where the painted geology changed: the stones on the ground take its colour. */
  readonly geologyChanges: GroundChanges;
  /** The water's level near a point (lake or river, within a few cells of it), or null. */
  shoreLevelAt(x: number, y: number): number | null;
  /** Where water is, world (x, y), or null when there is none. */
  waterArea(): { minX: number; maxX: number; minY: number; maxY: number } | null;
  /** Moves whenever the water is rebuilt. */
  readonly waterRevision: number;
  /**
   * The grid cells (x0, x1, y0, y1) the last `update` rewrote, or null when it
   * rewrote the whole plate: where a stroke's dab changed the ground.
   */
  readonly lastRegion: TerrainRegion | null;
  /**
   * After a stroke: what was deferred while it was held (the water) is
   * brought up to date. Cheap when nothing was deferred.
   */
  settle(): void;
  /**
   * Cuts and fills the ground so it meets the roads.
   *
   * The second half. `shape` is the solved road field; every corner inside a
   * road's corridor is pulled to the road's subgrade, and the difference is
   * carried back to the natural ground over a wide batter. Returns true when
   * anything moved, so the caller knows whether the water needs rebuilding.
   */
  /**
   * `region`: one region or several, shaped in one pass (each region's own
   * pass walked every shaped corner, every road's box and the whole plate's
   * bounds again: an edit touching 20 blocks paid that 20 times).
   */
  shapeToRoads(shape: TerrainShaper | null, region?: TerrainRegion | readonly TerrainRegion[] | null): boolean;
  /** The grid corners a world box covers, as `shapeToRoads` takes them. */
  regionOf(box: readonly [number, number, number, number]): TerrainRegion;
  /** A region back as the world box it covers, a cell round. */
  rectOf(region: TerrainRegion): readonly [number, number, number, number];
  /** The plates the ground is made of, each with its own surface (`TerrainPart`). */
  readonly parts: readonly TerrainPart[];
  /**
   * The highest corner of the drawn ground, when the surface keeps it as its
   * ground moves (the planet's atlas, from its plates' horizon caps): read
   * instead of every corner of every plate (`SceneHandle.landTop`).
   */
  highest?(): number;
  /**
   * Where the view looks (atlas x, y) and how much ground it takes in (the
   * screen's half height, world units): the planet's atlas keeps in full the
   * pieces near it (`planet/terrainAtlas.ts`). Nothing on the flat map.
   */
  focus?(x: number, y: number, reach: number): void;
  /**
   * How much the sea holds a road up at a point (0..1, world x, y) over land
   * `land` high: where the land is the Earth's, its sea is a floor no road
   * goes under (`world/flatEarth.ts` seaRoadGround). None on a plate with no sea.
   */
  seaHold?(x: number, y: number, land: number): number;
  /**
   * The woods' density but the ecosystem's share per cell, made off the page
   * with the plate's first build (`woodsBase.ts`), while the natural land is
   * that build's (no stamp since); else null, and the sweep works it out.
   */
  woodsBase?(): Float32Array | null;
  dispose(): void;
}

/** A box of grid corners, inclusive: x0..x1 across, y0..y1 down. */
export type TerrainRegion = readonly [number, number, number, number];

/**
 * A plate of the ground and where its centre stands: the flat map is one, at
 * the origin; the planet's atlas six (`planet/terrainAtlas.ts`). `surface`
 * speaks the plate's own coordinates, about its centre.
 */
export interface TerrainPart {
  readonly surface: TerrainSurface;
  readonly cx: number;
  readonly cy: number;
}

/** What `shapeToRoads` needs to know about the road network. */
export interface TerrainShaper {
  shapeAt(x: number, y: number, naturalGround: number): { height: number; weight: number };
  /** Boxes outside which `shapeAt` always answers weight 0. */
  shapeBounds(): readonly Aabb[];
}

/** 0..1 hash of an integer lattice point. */
function latticeHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263) ^ Math.imul(seed, 2_246_822_519);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/**
 * Value noise tiling with its own period on each axis: a streak long down a
 * face and narrow across it, still seamless (`makeNoise` has one period).
 */
function makeNoiseXY(seed: number): (x: number, y: number, px: number, py: number) => number {
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x, y, px, py) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const ax = ((x0 % px) + px) % px, ay = ((y0 % py) + py) % py;
    const bx = ax + 1 === px ? 0 : ax + 1, by = ay + 1 === py ? 0 : ay + 1;
    const a = latticeHash(ax, ay, seed), b = latticeHash(bx, ay, seed);
    const c = latticeHash(ax, by, seed), d = latticeHash(bx, by, seed);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/** The nearest and second-nearest jittered points of an n x n tiling grid. */
const cell = { f1: 0, f2: 0, id: 0 };
function cellular(u: number, v: number, n: number, seed: number): typeof cell {
  const x = u * n, y = v * n;
  const ix = Math.floor(x), iy = Math.floor(y);
  cell.f1 = 9;
  cell.f2 = 9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      const wx = ((cx % n) + n) % n, wy = ((cy % n) + n) % n;
      const px = cx + 0.12 + 0.76 * latticeHash(wx, wy, seed);
      const py = cy + 0.12 + 0.76 * latticeHash(wx, wy, seed + 1);
      const d = Math.hypot(px - x, py - y);
      if (d < cell.f1) { cell.f2 = cell.f1; cell.f1 = d; cell.id = wy * n + wx; } else if (d < cell.f2) cell.f2 = d;
    }
  }
  return cell;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Mixes `out`'s colour towards an sRGB colour by `w`. */
function tintTowards(out: { r: number; g: number; b: number }, c: readonly [number, number, number], w: number): void {
  out.r += (c[0] - out.r) * w;
  out.g += (c[1] - out.g) * w;
  out.b += (c[2] - out.b) * w;
}

/** Texels across a rock layer; every layer of the array is this size. */
const ROCK_SIZE = 512;
/** World units one rock tile covers (`uRockScale`). */
const ROCK_WORLD = m(23.2);

/**
 * The rocks, two layers each - its FACE, read by the side projections of the
 * triplanar mapping (texture v is height, so beds lie level and streaks run
 * down), and its TOP, read from above on the gentler rock, with no direction
 * in it (a face texture laid flat drew parallel stripes over every outcrop).
 * In the shader's order: granite, sandstone, basalt.
 *
 *  - GRANITE / GNEISS, the land's own rock (Rio's sugarloaves, the Serra do
 *    Mar, the inselbergs of the sertão): grey slabs split by long sheeting
 *    joints, black streaks of the cyanobacteria the rain feeds running down
 *    the face, grooves (caneluras) and pale lichen.
 *  - SANDSTONE (the chapadas and their canyons): cross-bedded sets between
 *    level bounding surfaces, vertical joints, varnish hanging from the bed
 *    contacts. Its broad beds of colour are laid by the shader from the
 *    world height, so they never repeat with the tile.
 *  - BASALT (the Serra Geral, Itaimbezinho): dark columns of uneven width, each
 *    a facet, cross joints, rusty weathering; from above, the polygons of
 *    their tops.
 */
const ROCK_RECIPES: readonly (readonly [string, SurfaceRecipe])[] = (() => {
  const g1 = makeNoise(0x61a1), g2 = makeNoise(0x61d4), gs = makeNoiseXY(0x61b2), gf = makeNoise(0x61c3);
  const s1 = makeNoise(0x7a11), s2 = makeNoise(0x7a22), ss = makeNoiseXY(0x7a33);
  const b1 = makeNoise(0x8b11), bs = makeNoiseXY(0x8b22);
  const grey: readonly [number, number, number] = [0.46, 0.455, 0.44];
  const graniteFace = (x: number, y: number, out: { r: number; g: number; b: number; h: number; rough: number }): void => {
    const u = x / ROCK_SIZE, v = y / ROCK_SIZE;
    const slab = fbm(g1, u * 4, v * 4, 4, 3);
    // Sheeting joints: long cracks across the face, gently curved, broken.
    const jt = v * 5 + (fbm(g2, u * 3, v * 3, 3, 2) - 0.5) * 0.9;
    const jd = Math.abs(jt - Math.round(jt)) * (ROCK_SIZE / 5);
    const joint = (1 - smoothstep(1.2, 3, jd)) * smoothstep(0.5, 0.62, fbm(g2, u * 7 + 3.3, v * 7 + 1.1, 7, 1));
    // And a few running down it.
    const ju = u * 3 + (fbm(g2, u * 2 + 9, v * 2, 2, 2) - 0.5) * 0.5;
    const ud = Math.abs(ju - Math.round(ju)) * (ROCK_SIZE / 3);
    const upright = (1 - smoothstep(1.2, 3, ud)) * smoothstep(0.52, 0.64, fbm(g2, u * 5 + 1.7, v * 5 + 6.1, 5, 1));
    const crack = Math.max(joint, upright);
    // Streaks: water and the cyanobacteria it feeds, down from every crest.
    // Broad and faint: thin dark ones packed close read as straw on a dome
    // (the player, 2026-10-07).
    const st = gs(u * 8, v * 2, 8, 2) * 0.7 + gs(u * 20 + 7, v * 4, 20, 4) * 0.3;
    const streak = smoothstep(0.52, 0.8, st);
    const groove = gs(u * 150, v * 3 + 1.7, 150, 3);
    const lichen = smoothstep(0.72, 0.82, fbm(gf, u * 20 + 5, v * 20 + 9, 20, 2)) * (1 - streak);
    const fine = fbm(gf, u * 96, v * 96, 96, 2);
    const crystal = latticeHash(x, y, 0x61e5);
    out.r = grey[0] - 0.03 + slab * 0.07;
    out.g = grey[1] - 0.025 + slab * 0.05;
    out.b = grey[2] - 0.015 + slab * 0.03;
    const k = (0.9 + fine * 0.18) * (0.98 + groove * 0.03) * (crystal < 0.06 ? 0.72 : crystal > 0.93 ? 1.16 : 1);
    out.r *= k; out.g *= k; out.b *= k;
    tintTowards(out, [0.3, 0.3, 0.3], streak * 0.35);
    tintTowards(out, [0.6, 0.61, 0.54], lichen * 0.35);
    out.r *= 1 - crack * 0.38; out.g *= 1 - crack * 0.38; out.b *= 1 - crack * 0.38;
    out.h = slab * 0.4 + groove * 0.18 - crack * 0.55 + fine * 0.12 + lichen * 0.05;
    out.rough = 0.86;
  };
  const graniteTop = (x: number, y: number, out: { r: number; g: number; b: number; h: number; rough: number }): void => {
    const u = x / ROCK_SIZE, v = y / ROCK_SIZE;
    const c = cellular(u, v, 6, 0x61f1);
    const crack = 1 - smoothstep(0.02, 0.07, c.f2 - c.f1);
    const block = latticeHash(c.id, 3, 0x61f2);
    const stain = smoothstep(0.58, 0.8, fbm(g1, u * 8 + 2, v * 8 + 7, 8, 3));
    const lichen = smoothstep(0.62, 0.72, fbm(gf, u * 24 + 1, v * 24 + 4, 24, 2));
    const fine = fbm(gf, u * 96 + 3, v * 96 + 8, 96, 2);
    const crystal = latticeHash(x, y, 0x61f3);
    const k = (0.88 + block * 0.16) * (0.9 + fine * 0.18) * (crystal < 0.06 ? 0.74 : crystal > 0.93 ? 1.14 : 1);
    out.r = grey[0] * k; out.g = grey[1] * k; out.b = grey[2] * k;
    tintTowards(out, [0.27, 0.27, 0.26], stain * 0.45);
    tintTowards(out, [0.64, 0.65, 0.57], lichen * 0.3);
    // Grit and soil caught in the joints.
    tintTowards(out, [0.3, 0.25, 0.19], crack * 0.85);
    out.h = 0.5 + block * 0.2 - crack * 0.5 + fine * 0.15;
    out.rough = 0.88;
  };
  const sand: readonly [number, number, number] = [0.68, 0.48, 0.33];
  const sandstoneFace = (x: number, y: number, out: { r: number; g: number; b: number; h: number; rough: number }): void => {
    const u = x / ROCK_SIZE, v = y / ROCK_SIZE;
    // Sets of cross-beds between level bounding surfaces, four to a tile.
    const setT = v * 4 + (fbm(s1, u * 2, v * 2, 2, 2) - 0.5) * 0.22;
    const setI = Math.floor(setT), setF = setT - setI;
    const setId = ((setI % 4) + 4) % 4;
    const slope = [9, -7, 12, -5][setId]!;
    const lam = 0.5 + 0.5 * Math.sin(2 * Math.PI * (v * 40 + u * slope + fbm(s2, u * 6, v * 6, 6, 1) * 1.4));
    const bound = 1 - smoothstep(0.8, 2.4, Math.min(setF, 1 - setF) * (ROCK_SIZE / 4));
    const hard = latticeHash(setId, 1, 0x7a44);
    // Joints down the face, in pieces.
    const ju = u * 3 + (fbm(s2, u * 2 + 4, v * 2, 2, 2) - 0.5) * 0.35;
    const jd = Math.abs(ju - Math.round(ju)) * (ROCK_SIZE / 3);
    const joint = (1 - smoothstep(1, 2.6, jd)) * smoothstep(0.55, 0.68, fbm(s1, u * 6 + 2, v * 6 + 5, 6, 1));
    // Varnish hanging from the bed contacts (texture v runs down the face).
    const vs = ss(u * 8, v * 3, 8, 3) * 0.7 + ss(u * 20 + 3, v * 6, 20, 6) * 0.3;
    const varnish = smoothstep(0.5, 0.78, vs) * (0.3 + 0.7 * (1 - setF));
    const grain = fbm(s2, u * 128 + 7, v * 128 + 1, 128, 2);
    const speck = latticeHash(x, y, 0x7a55);
    const k = (0.94 + hard * 0.1) * (0.97 + lam * 0.06) * (0.92 + grain * 0.14) * (speck < 0.05 ? 0.86 : speck > 0.95 ? 1.08 : 1);
    out.r = sand[0] * k; out.g = sand[1] * k; out.b = sand[2] * k;
    tintTowards(out, [0.4, 0.27, 0.19], varnish * 0.3);
    out.r *= 1 - bound * 0.1 - joint * 0.3; out.g *= 1 - bound * 0.11 - joint * 0.32; out.b *= 1 - bound * 0.12 - joint * 0.33;
    out.h = 0.35 + hard * 0.3 + lam * 0.08 - bound * 0.3 - joint * 0.5 + grain * 0.12;
    out.rough = 0.93;
  };
  const sandstoneTop = (x: number, y: number, out: { r: number; g: number; b: number; h: number; rough: number }): void => {
    const u = x / ROCK_SIZE, v = y / ROCK_SIZE;
    const c = cellular(u, v, 5, 0x7a66);
    const edge = c.f2 - c.f1;
    const crack = 1 - smoothstep(0.015, 0.055, edge);
    const fill = (1 - smoothstep(0.05, 0.14, edge)) * (1 - crack);
    const block = latticeHash(c.id, 7, 0x7a77);
    const crust = fbm(s1, u * 10 + 3, v * 10 + 1, 10, 3);
    const grain = fbm(s2, u * 128 + 2, v * 128 + 9, 128, 2);
    const pit = latticeHash(x, y, 0x7a88) < 0.03 ? 1 : 0;
    const k = (0.9 + block * 0.14) * (0.9 + crust * 0.2) * (0.93 + grain * 0.12) * (1 - pit * 0.25);
    out.r = sand[0] * k; out.g = sand[1] * k; out.b = sand[2] * k;
    // Sand blown into the joints, paler; the joints themselves dark.
    tintTowards(out, [0.82, 0.7, 0.52], fill * 0.5);
    tintTowards(out, [0.36, 0.26, 0.19], crack * 0.8);
    tintTowards(out, [0.34, 0.33, 0.28], smoothstep(0.7, 0.8, fbm(s1, u * 22, v * 22 + 5, 22, 2)) * 0.5);
    out.h = 0.5 + block * 0.15 + crust * 0.15 - crack * 0.5 - fill * 0.15 + grain * 0.1;
    out.rough = 0.94;
  };
  const dark: readonly [number, number, number] = [0.4, 0.385, 0.37];
  const basaltFace = (x: number, y: number, out: { r: number; g: number; b: number; h: number; rough: number }): void => {
    const u = x / ROCK_SIZE, v = y / ROCK_SIZE;
    // Columns of uneven width, swaying a little as they rise.
    const cu = u * 9 + (bs(u * 9, v * 1.0, 9, 1) - 0.5) * 0.8 + (bs(u * 3 + 5, v * 2, 3, 2) - 0.5) * 0.4;
    const colI = Math.floor(cu), colF = cu - colI;
    const col = ((colI % 9) + 9) % 9;
    const ridge = 0.3 + 0.4 * latticeHash(col, 2, 0x8b33);
    const facet = 1 - Math.abs(colF - ridge) / Math.max(ridge, 1 - ridge);
    const gap = 1 - smoothstep(1, 2.6, Math.min(colF, 1 - colF) * (ROCK_SIZE / 9));
    // Cross joints at each column's own heights.
    const ct = v * 6 + latticeHash(col, 5, 0x8b44) * 3;
    const cd = Math.abs(ct - Math.round(ct)) * (ROCK_SIZE / 6);
    const cross = (1 - smoothstep(0.8, 2.2, cd)) * (latticeHash(col, Math.round(ct), 0x8b55) < 0.3 ? 1 : 0);
    const rust = smoothstep(0.6, 0.76, fbm(b1, u * 6 + 2, v * 6 + 9, 6, 3));
    const lichen = smoothstep(0.76, 0.86, fbm(b1, u * 18 + 5, v * 18 + 3, 18, 2));
    const streak = smoothstep(0.6, 0.85, bs(u * 40 + 3, v * 3, 40, 3));
    const grain = fbm(b1, u * 128, v * 128 + 4, 128, 2);
    const k = (0.86 + latticeHash(col, 9, 0x8b66) * 0.22) * (0.92 + facet * 0.12) * (0.9 + grain * 0.18);
    out.r = dark[0] * k; out.g = dark[1] * k; out.b = dark[2] * k;
    tintTowards(out, [0.42, 0.3, 0.22], rust * 0.25);
    tintTowards(out, [0.47, 0.49, 0.43], lichen * 0.3);
    tintTowards(out, [0.42, 0.41, 0.39], streak * 0.25);
    const shut = Math.max(gap, cross * 0.7);
    out.r *= 1 - shut * 0.45; out.g *= 1 - shut * 0.45; out.b *= 1 - shut * 0.45;
    out.h = facet * 0.45 - gap * 0.6 - cross * 0.35 + grain * 0.1 + 0.3;
    out.rough = 0.84;
  };
  const basaltTop = (x: number, y: number, out: { r: number; g: number; b: number; h: number; rough: number }): void => {
    const u = x / ROCK_SIZE, v = y / ROCK_SIZE;
    const c = cellular(u, v, 10, 0x8b77);
    const joint = 1 - smoothstep(0.03, 0.09, c.f2 - c.f1);
    const top = latticeHash(c.id, 4, 0x8b88);
    const rust = smoothstep(0.62, 0.78, fbm(b1, u * 7 + 4, v * 7 + 2, 7, 3));
    const lichen = smoothstep(0.66, 0.78, fbm(b1, u * 20 + 8, v * 20 + 1, 20, 2));
    const grain = fbm(b1, u * 128 + 5, v * 128 + 6, 128, 2);
    const k = (0.84 + top * 0.24) * (0.9 + grain * 0.18) * (0.94 + c.f1 * 0.1);
    out.r = dark[0] * k; out.g = dark[1] * k; out.b = dark[2] * k;
    tintTowards(out, [0.42, 0.3, 0.22], rust * 0.3);
    tintTowards(out, [0.48, 0.5, 0.44], lichen * 0.5);
    out.r *= 1 - joint * 0.6; out.g *= 1 - joint * 0.6; out.b *= 1 - joint * 0.6;
    out.h = 0.55 + top * 0.15 - c.f1 * 0.2 - joint * 0.55 + grain * 0.1;
    out.rough = 0.86;
  };
  const layer = (shade: SurfaceRecipe['shade'], relief: number): SurfaceRecipe => ({ size: ROCK_SIZE, worldSize: ROCK_WORLD, relief, shade });
  return [
    ['terrain-rock-granite', layer(graniteFace, 2.2)],
    ['terrain-rock-granite-top', layer(graniteTop, 2.2)],
    ['terrain-rock-sandstone', layer(sandstoneFace, 2.0)],
    ['terrain-rock-sandstone-top', layer(sandstoneTop, 2.0)],
    ['terrain-rock-basalt', layer(basaltFace, 2.6)],
    ['terrain-rock-basalt-top', layer(basaltTop, 2.4)],
  ];
})();

/**
 * Tiling noise stretched along v: the mean of samples stacked up the column,
 * which smears each blob into a streak while both axes keep the one period
 * `fbm` tiles on (a lower frequency along v alone would leave a seam).
 */
function streakNoise(noise: (x: number, y: number, period: number) => number, u: number, v: number, period: number): number {
  let sum = 0;
  for (let k = 0; k < 8; k++) sum += fbm(noise, u * period, v * period + k * 0.75, period, 2);
  // Averaging flattens the contrast; stretched back about the middle.
  return Math.min(1, Math.max(0, 0.5 + (sum / 8 - 0.5) * 2.2));
}

/**
 * The grass's tones, sRGB: deep clump green, sunlit green, dry straw, bare
 * soil. Their mean has the brightness of measured grass (Physically Based's
 * grass, linear 0.105 0.133 0.041: green about 0.13 linear); the old sunlit
 * green was 0.32 linear and nearly blue-free, a neon lawn brighter than the
 * buildings (the player, 2026-10-08: "extremamente brilhante").
 */
// The dark tone close to the lit one: at 0.22 0.32 0.12 the lawn's dark
// patches were the very green of the tree crowns, and a park's trees vanished
// into blotches of their own colour (the player, 2026-10-08: "olha o verde").
// Olive, not lime: the film grade's vibrance and warm highlights
// (postprocess.ts GRADE) push a yellow-green further, and at 0.40 0.49 0.20
// the lawn read as neon from the map's zoom (the player, 2026-10-09: "verde
// muito neon"). Lower chroma (lit green over blue 1.9x, was 2.45x), a touch darker.
export const GRASS_TONES = {
  dark: [0.27, 0.34, 0.19],
  lit: [0.33, 0.4, 0.21],
  dry: [0.41, 0.4, 0.28],
  soil: [0.36, 0.3, 0.2],
} as const;
/** The fields' tint factors (`macroTexture`): lush, yellowing meadow, deep green, olive. */
export const FIELD_TINTS = {
  lush: [0.9, 1.0, 0.9],
  meadow: [1.24, 1.1, 0.7],
  deep: [0.7, 0.86, 0.84],
  olive: [1.1, 0.96, 0.76],
} as const;

export function terrainBakes(anisotropy: number): {
  grass: SurfaceBake;
  rocks: readonly SurfaceBake[];
  dirt: SurfaceBake;
} {
  const grassFine = makeNoise(0x1234);
  const grassClump = makeNoise(0x9f2c);
  const grass = bakeSurface(
    'terrain-grass',
    {
      size: 1024,
      worldSize: m(38.4),
      // Read at map zoom, where a pixel is a metre or two: the detail that
      // shows is TUFTS a few metres across - dark clumps, sunlit olive, dry
      // straw spots, soil showing through - as SimCity 4's ground has. A grain
      // finer than a metre melts into the mip chain and leaves flat felt.
      relief: 0.9,
      shade: (x, y, out) => {
        const u = x / 1024;
        const v = y / 1024;
        // Domain-warped: value noise alone is laid on a square lattice and
        // its blobs read as camouflage squares; bending the lookup by a
        // second noise rounds them into tufts.
        // A light warp only: a strong one smeared the patches into swirls of
        // wet paint (the player, 2026-10-06).
        // One octave each: the warp only bends the patches' edges, and the
        // bake runs while the game loads.
        const wx = (fbm(grassClump, u * 24 + 11, v * 24, 24, 1) - 0.5) * 0.9;
        const wy = (fbm(grassClump, u * 24, v * 24 + 29, 24, 1) - 0.5) * 0.9;
        const speck = fbm(grassFine, u * 96 + wx * 2, v * 96 + wy * 2, 96, 2);
        const tuft = fbm(grassFine, u * 32 + wx + 3.1, v * 32 + wy + 7.7, 32, 2);
        const clump = fbm(grassClump, u * 10 + wx * 0.5, v * 10 + wy * 0.5, 10, 2);
        // sRGB: deep clump green, sunlit green, dry straw, bare soil (`GRASS_TONES`).
        const { dark, lit, dry, soil } = GRASS_TONES;
        const t = Math.min(1, Math.max(0, (tuft - 0.3) / 0.42));
        const k = t * t * (3 - 2 * t);
        let r = dark[0]! + (lit[0]! - dark[0]!) * k;
        let g = dark[1]! + (lit[1]! - dark[1]!) * k;
        let b = dark[2]! + (lit[2]! - dark[2]!) * k;
        // Dry patches over the higher, sunnier tufts of some clumps.
        const dryW = Math.min(1, Math.max(0, (clump - 0.6) / 0.12)) * k * 0.2;
        r += (dry[0]! - r) * dryW; g += (dry[1]! - g) * dryW; b += (dry[2]! - b) * dryW;
        // Soil showing in the gaps between tufts.
        const soilW = Math.min(1, Math.max(0, (speck - 0.7) / 0.08)) * (1 - k) * 0.45;
        r += (soil[0]! - r) * soilW; g += (soil[1]! - g) * soilW; b += (soil[2]! - b) * soilW;
        // GRAIN at the texel (9 cm): tufts of a couple of texels, dark gaps
        // where the blades shade the ground and pale tips in the sun. It is
        // what grass is made of at any distance a pixel is under a metre,
        // and the mip chain averages it away further out, so the far view
        // keeps its patches. Without it every patch was a smooth smear.
        const tuftlet = fbm(grassFine, u * 384 + 1.7, v * 384 + 5.3, 384, 2);
        const blade = fbm(grassClump, u * 768 + 9.1, v * 768 + 2.9, 768, 1);
        const gap = blade < 0.3 ? 0.72 : 1;
        const tip = blade > 0.78 ? 1.16 : 1;
        const grain = (0.84 + tuftlet * 0.3) * gap * tip * (0.96 + speck * 0.08);
        // Sunlit tips lean yellow, shaded gaps blue-green.
        out.r = r * grain * (tip > 1 ? 1.05 : 1);
        out.g = g * grain;
        out.b = b * grain * (gap < 1 ? 1.08 : 1);
        out.h = k * 0.45 + tuftlet * 0.35 + (blade > 0.78 ? 0.2 : 0) - (gap < 1 ? 0.15 : 0) - soilW * 0.3;
        out.rough = 0.99;
      },
    },
    anisotropy,
  );

  const rocks = ROCK_RECIPES.map(([key, recipe]) => bakeSurface(key, recipe, anisotropy));

  const dirtGrain = makeNoise(0x3311);
  const dirt = bakeSurface(
    'terrain-dirt',
    {
      size: 256,
      worldSize: m(13.6),
      relief: 2.4,
      shade: (x, y, out) => {
        const u = x / 256;
        const v = y / 256;
        const grain = fbm(dirtGrain, u * 90, v * 90, 90, 3);
        const patch = fbm(dirtGrain, u * 8 + 3, v * 8 + 9, 8, 3);
        // Gullies: narrow across, long up the face, so on a bank (read from
        // the side) they run down the slope as rain cuts them.
        const gully = streakNoise(dirtGrain, u, v, 48);
        const cut = Math.max(0, 0.5 - gully) * 2;
        const tone = 0.34 + (grain - 0.5) * 0.08 + patch * 0.07 - cut * 0.09 + Math.max(0, gully - 0.6) * 0.12;
        // Red-brown, the colour of the tropics' weathered soils (latossolo).
        out.r = tone * 1.22;
        out.g = tone * 0.8;
        out.b = tone * 0.58;
        out.h = grain * 0.7 + patch * 0.3;
        out.rough = 0.97;
      },
    },
    anisotropy,
  );

  return { grass, rocks, dirt };
}

/**
 * The terrain material: three surfaces blended by slope, height and noise.
 *
 * One texture stretched over four kilometres of ground is what made the terrain
 * read as painted paper. Three fixes are layered here, and each is visible on
 * its own:
 *
 *  - **Slope decides the surface.** Anything steeper than about 25 degrees is
 *    rock, which is what actually gives a hill a silhouette: the colour change
 *    follows the geometry, so a slope is legible even when the sun is behind it.
 *  - **Two scales of the same texture.** Each map is sampled at its own size and
 *    again about seven times larger, and the two are mixed. Their scales do
 *    not align on every eighth tile across the terrain plate.
 *  - **Macro variation.** A slow noise tints wide regions warm or cool, so the
 *    ground has weather in it rather than one flat green.
 */
/** Texels across the map in each painted-ground weight texture. */
const PAINT_RES = __PLANET__ ? 256 : 1024;

/**
 * The water's level at every terrain corner within a few cells of water, for
 * the shore bands of the terrain shader; NO_WATER elsewhere. Read off the
 * water surface itself (its vertices carry the level), so a lake and a river
 * are the same thing here, then spread outwards so the beach above the line
 * knows which water it belongs to.
 */
function shoreLevels(water: BufferGeometry, levels: Float32Array, ground: ArrayLike<number>): void {
  levels.fill(NO_WATER);
  const position = water.getAttribute('position');
  if (position) {
    for (let i = 0; i < position.count; i++) {
      const gx = (position.getX(i) + TERRAIN_HALF) / TERRAIN_CELL;
      const gy = (position.getZ(i) + TERRAIN_HALF) / TERRAIN_CELL;
      const ix = Math.round(gx);
      const iy = Math.round(gy);
      if (ix < 0 || iy < 0 || ix >= GRID || iy >= GRID) continue;
      const k = iy * GRID + ix;
      // Only a corner the water really stands over: a shore vertex marked
      // the nearest corner even where that corner was dry or past the
      // water, and the bed was painted a terrain cell beyond it, in steps.
      if ((ground[k] as number) >= position.getY(i)) continue;
      levels[k] = Math.max(levels[k] as number, position.getY(i));
    }
  }
  // Out three corners (48 units, about 19 m), each pass taking the highest
  // water next to it.
  for (let pass = 0; pass < 3; pass++) {
    const from = levels.slice();
    for (let iy = 0; iy < GRID; iy++) {
      for (let ix = 0; ix < GRID; ix++) {
        const k = iy * GRID + ix;
        if ((from[k] as number) > NO_WATER / 2) continue;
        let best = NO_WATER;
        if (ix > 0) best = Math.max(best, from[k - 1] as number);
        if (ix + 1 < GRID) best = Math.max(best, from[k + 1] as number);
        if (iy > 0) best = Math.max(best, from[k - GRID] as number);
        if (iy + 1 < GRID) best = Math.max(best, from[k + GRID] as number);
        // Only onto a BANK, ground above the water: a corner under the level
        // the water does not cover was drawn as a dry grey river bed, in
        // the grid's steps, beside every pool.
        if (best > NO_WATER / 2 && (ground[k] as number) < best) continue;
        levels[k] = best;
      }
    }
  }
}

/**
 * The ground texture the terrain shader reads per corner: R the water's level
 * (`shoreLevels`), G the painted flowers' density, B the painted scrub's, A
 * the painted forest's. One texture for all: the terrain material already binds sixteen textures, the
 * most a fragment shader may, and a texture of its own for the flowers took
 * the whole terrain off the screen.
 */
function packGroundCorners(texture: DataTexture, levels: Float32Array, flowers: Float32Array, scrub: Float32Array, forest: Float32Array, sand: Float32Array, basalt: Float32Array): void {
  const data = texture.image.data as Float32Array;
  const byte = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
  for (let k = 0; k < levels.length; k++) {
    data[k * 4] = levels[k] as number;
    // Two bytes to a channel, exact in a float: the flowers (the scrub) low,
    // the painted sandstone (basalt) high. The shader splits them per corner
    // before it interpolates.
    data[k * 4 + 1] = byte(flowers[k] as number) + 256 * byte(sand[k] as number);
    data[k * 4 + 2] = byte(scrub[k] as number) + 256 * byte(basalt[k] as number);
    data[k * 4 + 3] = forest[k] as number;
  }
  texture.needsUpdate = true;
}

/**
 * Lays one geology dab on the terrain's corners: within its radius the rock
 * moves towards the dab's (granite: towards neither sandstone nor basalt) by
 * its strength times a smooth falloff, as a cover does. Returns the world
 * rectangle it reached.
 */
function rasterGeology(sand: Float32Array, basalt: Float32Array, dab: PaintDab): readonly [number, number, number, number] {
  const toSand = dab.kind === 'sandstone' ? 1 : 0;
  const toBasalt = dab.kind === 'basalt' ? 1 : 0;
  // Rows run from +y downwards, as the plane lays them.
  const cx = (dab.x + TERRAIN_HALF) / TERRAIN_CELL;
  const cy = (TERRAIN_HALF - dab.y) / TERRAIN_CELL;
  const r = dab.radius / TERRAIN_CELL;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(GRID - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(GRID - 1, Math.ceil(cy + r));
  for (let iy = y0; iy <= y1; iy++) {
    for (let ix = x0; ix <= x1; ix++) {
      const d = Math.hypot(ix - cx, iy - cy) / Math.max(1e-6, r);
      if (d >= 1) continue;
      // Flat to near its rim: a landform's cliff stands at the rim of its
      // dabs, and a falloff from the centre left every wall granite.
      const t = Math.min(1, Math.max(0, (d - 0.78) / 0.22));
      const w = Math.min(1, dab.strength * (1 - t * t * (3 - 2 * t)));
      const k = iy * GRID + ix;
      sand[k] = (sand[k] as number) + (toSand - (sand[k] as number)) * w;
      basalt[k] = (basalt[k] as number) + (toBasalt - (basalt[k] as number)) * w;
    }
  }
  return [dab.x - dab.radius, dab.y - dab.radius, dab.x + dab.radius, dab.y + dab.radius];
}

/**
 * Lays one biome dab on the terrain's corners: within its radius the painted
 * biome weights move towards the dab's biome (all of it at the centre, with
 * a falloff flat to near the rim, as the rock dabs), as a cover replaces another.
 */
function rasterBiome(weights: Float32Array, dab: PaintDab): void {
  const target = (BIOME_KINDS as readonly string[]).indexOf(dab.kind);
  const n = BIOME_KINDS.length;
  const cx = (dab.x + TERRAIN_HALF) / TERRAIN_CELL;
  const cy = (TERRAIN_HALF - dab.y) / TERRAIN_CELL;
  const r = dab.radius / TERRAIN_CELL;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(GRID - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(GRID - 1, Math.ceil(cy + r));
  for (let iy = y0; iy <= y1; iy++) {
    for (let ix = x0; ix <= x1; ix++) {
      const d = Math.hypot(ix - cx, iy - cy) / Math.max(1e-6, r);
      if (d >= 1) continue;
      const t = Math.min(1, Math.max(0, (d - 0.7) / 0.3));
      const w = Math.min(1, dab.strength * (1 - t * t * (3 - 2 * t)));
      const k = (iy * GRID + ix) * n;
      for (let b = 0; b < n; b++) {
        const goal = b === target ? 1 : 0;
        weights[k + b] = (weights[k + b] as number) + (goal - (weights[k + b] as number)) * w;
      }
    }
  }
}

/** The pixels of a baked texture, rows top first as its canvas holds them, or null. */
function bakedRows(texture: Texture): Uint8Array | Uint8ClampedArray | null {
  const image = texture.image as { data?: Uint8Array; width: number; height: number; getContext?: (kind: '2d') => CanvasRenderingContext2D | null };
  if (image.data) return image.data;
  const context = image.getContext?.('2d');
  return context ? context.getImageData(0, 0, image.width, image.height).data : null;
}

/**
 * The rock layers as ONE texture array: a single texture unit for all of them
 * (the terrain material is at the sixteen a fragment shader may bind), each
 * layer chosen in the shader by index (three's DataArrayTexture; Terrain3D
 * keeps its terrain textures the same way).
 */
/**
 * The rock layers and the macro map, made once and shared by every plate of
 * ground: the planet has 96 plates, and an array of the rock textures made
 * per plate was gigabytes of the same pixels.
 */
const layersMade = new Map<string, DataArrayTexture>();
function sharedLayers(key: string, textures: readonly Texture[], srgb: boolean, anisotropy: number): DataArrayTexture {
  const id = `${key}:${anisotropy}`;
  let made = layersMade.get(id);
  if (!made) layersMade.set(id, made = layeredTexture(textures, srgb, anisotropy));
  return made;
}
const macroMade = new Map<number, DataTexture>();
function sharedMacro(anisotropy: number): DataTexture {
  let made = macroMade.get(anisotropy);
  if (!made) macroMade.set(anisotropy, made = macroTexture(anisotropy));
  return made;
}

function layeredTexture(textures: readonly Texture[], srgb: boolean, anisotropy: number): DataArrayTexture {
  const first = textures[0]!.image as { width: number; height: number };
  const width = first.width, height = first.height;
  const layer = width * height * 4;
  const data = new Uint8Array(layer * textures.length);
  textures.forEach((texture, i) => {
    const rows = bakedRows(texture);
    if (!rows) {
      // No canvas (a headless test): flat grey, a flat normal.
      data.fill(srgb ? 110 : 128, i * layer, (i + 1) * layer);
      if (!srgb) for (let k = i * layer + 2; k < (i + 1) * layer; k += 4) data[k] = 255;
      return;
    }
    // A 2-D texture is uploaded flipped (flipY); an array cannot be, so the
    // rows are flipped here and each layer reads as its 2-D twin did.
    for (let y = 0; y < height; y++) data.set(rows.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), i * layer + y * width * 4);
  });
  const array = new DataArrayTexture(data, width, height, textures.length);
  array.format = RGBAFormat;
  array.type = UnsignedByteType;
  array.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  array.wrapS = RepeatWrapping;
  array.wrapT = RepeatWrapping;
  array.magFilter = LinearFilter;
  array.minFilter = LinearMipmapLinearFilter;
  array.generateMipmaps = true;
  array.anisotropy = anisotropy;
  array.needsUpdate = true;
  return array;
}

/**
 * The land's colour map: a tint per region, a few hundred metres to a field,
 * stored as half its factor (0.5 = unchanged) so the shader multiplies the
 * grass by it. Domain-warped, so fields have the soft, irregular edges of
 * country seen from the air, not noise blobs.
 */
function macroTexture(anisotropy: number): DataTexture {
  const res = 256;
  const fields = makeNoise(0x6d1c);
  const warp = makeNoise(0x2b77);
  // Tint factors: lush, yellowing meadow, deep green, olive (`FIELD_TINTS`).
  const { lush, meadow, deep, olive } = FIELD_TINTS;
  const data = new Uint8Array(res * res * 4);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const u = x / res;
      const v = y / res;
      const wx = (fbm(warp, u * 6, v * 6, 6, 3) - 0.5) * 1.6;
      const wy = (fbm(warp, u * 6 + 17, v * 6 + 5, 6, 3) - 0.5) * 1.6;
      const a = fbm(fields, u * 4 + wx, v * 4 + wy, 4, 4);
      const b = fbm(fields, u * 8 + wy + 31, v * 8 + wx + 7, 8, 3);
      const k1 = Math.min(1, Math.max(0, (a - 0.42) / 0.2));
      const k2 = Math.min(1, Math.max(0, (b - 0.55) / 0.15));
      const k3 = Math.min(1, Math.max(0, (0.4 - a) / 0.12));
      const i = (y * res + x) * 4;
      for (let c = 0; c < 3; c++) {
        let t = lush[c]! + (meadow[c]! - lush[c]!) * k1;
        t += (deep[c]! - t) * k2 * 0.8;
        t += (olive[c]! - t) * k3 * 0.7;
        data[i + c] = Math.round(Math.min(1, t / 2) * 255);
      }
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, res, res, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The painted ground's layers, as ONE texture array (one texture unit for all:
 * the terrain material is at the sixteen a fragment shader may bind): 0 and 1
 * the eight paint weights (`rasterPaint`), each updated alone
 * (`addLayerUpdate`). (The ecology's ground has its own texture,
 * `userData.ecology`: the layer it once had here was sent to the GPU empty.)
 */
const PAINT_LAYERS = 3;
/**
 * The array layer holding the land's own light and shape (`terrainLight`):
 * R the sun it sees past the relief, G the sky it sees past the hills round
 * it, B its convexity, A its steepness over 90 degrees; one texel a terrain
 * corner in the layer's first GRID x GRID texels.
 */
const LIGHT_LAYER = 2;
/**
 * The side of the painted ground's array before anything is painted on it:
 * the land's light layer (one texel a terrain corner) fits in it, and the
 * paint layers are empty. Grown to `PAINT_RES` by the first dab
 * (`growPaint`): on the planet each of the 864 plates kept a 256 x 256 x 3
 * array (786 KB) though almost none is ever painted - 680 MB of the page's
 * memory, and as much again on the GPU.
 */
const PAINT_START_RES = Math.min(PAINT_RES, 2 ** Math.ceil(Math.log2(TERRAIN_SEGMENTS + 1)));
function paintLayers(res = PAINT_START_RES): DataArrayTexture {
  const texture = new DataArrayTexture(new Uint8Array(res * res * 4 * PAINT_LAYERS), res, res, PAINT_LAYERS);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
/** One layer of the painted ground's array, as a view on its data. */
function paintLayer(texture: DataArrayTexture, layer: number): Uint8Array {
  const res = texture.image.width;
  const size = res * res * 4;
  return (texture.image.data as Uint8Array).subarray(layer * size, (layer + 1) * size);
}

/**
 * Lays one dab into the weight textures: within its radius every layer moves
 * toward the dab's (grass: toward none) by the dab's strength times a smooth
 * falloff, so the weights keep summing to at most one.
 */
function rasterPaint(layers: readonly Uint8Array[], dab: PaintDab): void {
  const a = layers[0]!;
  const b = layers[1]!;
  // Rocks lie on bare ground: they lay the soil layer part way.
  const layer = PAINT_KINDS.indexOf(dab.kind === 'rocks' ? 'soil' : dab.kind);
  const reach = dab.kind === 'rocks' ? 0.2 : 1;
  const cell = TERRAIN_SIZE / PAINT_RES;
  const cx = (dab.x + TERRAIN_HALF) / cell;
  const cy = (dab.y + TERRAIN_HALF) / cell;
  const r = dab.radius / cell;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(PAINT_RES - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(PAINT_RES - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / Math.max(1e-6, r);
      if (d >= 1) continue;
      const fall = 1 - d * d * (3 - 2 * d);
      const w = Math.min(1, dab.strength * fall) * reach;
      const i = (y * PAINT_RES + x) * 4;
      for (let k = 0; k < 8; k++) {
        const data = k < 4 ? a : b;
        const j = i + (k & 3);
        const target = k === layer ? 255 : 0;
        data[j] = Math.round(data[j]! + (target - data[j]!) * w);
      }
    }
  }
}

/** Side of the forest density grid over the plate (7.5 m a cell). */
const FOREST_RES = __PLANET__ ? 128 : 256;

/**
 * Lays one dab into the cover densities: its own cover towards full, every
 * other towards none (a cover replaces another, and any plain ground clears
 * them all), as the forest alone always did.
 */
function rasterCover(covers: Readonly<Record<CoverKind, Uint8Array>>, dab: PaintDab): void {
  const cell = TERRAIN_SIZE / FOREST_RES;
  const cx = (dab.x + TERRAIN_HALF) / cell, cy = (dab.y + TERRAIN_HALF) / cell, r = dab.radius / cell;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(FOREST_RES - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(FOREST_RES - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / Math.max(1e-6, r);
      if (d >= 1) continue;
      const w = Math.min(1, dab.strength * (1 - d * d * (3 - 2 * d)));
      const i = y * FOREST_RES + x;
      for (const kind of COVER_KINDS) {
        const density = covers[kind];
        const target = dab.kind === kind ? 255 : 0;
        density[i] = Math.round(density[i]! + (target - density[i]!) * w);
      }
    }
  }
}

function terrainMaterial(
  bakes: {
    grass: SurfaceBake;
    rocks: readonly SurfaceBake[];
    dirt: SurfaceBake;
  },
  anisotropy: number,
): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    map: bakes.grass.map,
    normalMap: bakes.grass.normalMap,
    roughness: 1,
    metalness: 0,
    side: FrontSide,
    // Almost no environment reflection: a dielectric's 4 % reflects the whole
    // sky at any roughness, and over a field of grass that is the plastic sheen.
    envMapIntensity: 0.12,
  });
  material.normalScale.set(0.8, 0.8);

  const grassDetail = detailTextures('grass', anisotropy);
  const soilDetail = detailTextures('soil', anisotropy);
  const paint = paintLayers();
  material.userData['paint'] = paint;
  // The water's level at each terrain corner near water (`shoreLevels`),
  // NO_WATER elsewhere: where the ground stands just above it is beach,
  // just at it is wet, under it is the bed.
  // R: the water's level at each corner near water, G: the painted flowers,
  // B: the painted scrub (`packGroundCorners`).
  const shoreLevelData = new Float32Array(GRID * GRID).fill(NO_WATER);
  const flowerCornerData = new Float32Array(GRID * GRID);
  const scrubCornerData = new Float32Array(GRID * GRID);
  const forestCornerData = new Float32Array(GRID * GRID);
  // The painted geology at each corner: how much is sandstone, how much basalt
  // (the rest granite).
  const sandCornerData = new Float32Array(GRID * GRID);
  const basaltCornerData = new Float32Array(GRID * GRID);
  const shore = new DataTexture(new Float32Array(GRID * GRID * 4), GRID, GRID, RGBAFormat, FloatType);
  shore.magFilter = NearestFilter;
  shore.minFilter = NearestFilter;
  shore.generateMipmaps = false;
  packGroundCorners(shore, shoreLevelData, flowerCornerData, scrubCornerData, forestCornerData, sandCornerData, basaltCornerData);
  material.userData['shore'] = shore;
  material.userData['sandCorners'] = sandCornerData;
  material.userData['basaltCorners'] = basaltCornerData;
  // The ecosystem's ground per corner (`refreshEcology`): R the forest floor,
  // G the dry savanna grass, B waterlogged ground, A bare soil.
  const ecologyTexture = new DataTexture(new Uint8Array(GRID * GRID * 4), GRID, GRID, RGBAFormat, UnsignedByteType);
  ecologyTexture.magFilter = LinearFilter;
  ecologyTexture.minFilter = LinearFilter;
  ecologyTexture.wrapS = ClampToEdgeWrapping;
  ecologyTexture.wrapT = ClampToEdgeWrapping;
  ecologyTexture.generateMipmaps = false;
  ecologyTexture.needsUpdate = true;
  material.userData['ecology'] = ecologyTexture;
  material.userData['shoreLevels'] = shoreLevelData;
  material.userData['flowerCorners'] = flowerCornerData;
  material.userData['scrubCorners'] = scrubCornerData;
  material.userData['forestCorners'] = forestCornerData;
  // Read by the relief's bake, which carries its brightness in its blue
  // channel: the terrain shader is at the sixteen textures a fragment shader
  // may bind, and the relief took the macro map's place.
  material.userData['macro'] = sharedMacro(anisotropy);
  const uniforms = {
    uPaint: { value: paint as Texture },
    uPaintRes: { value: paint.image.width },
    uPaintHalf: { value: TERRAIN_HALF },
    uPaintSize: { value: TERRAIN_SIZE },
    uGrassField: GRASS_FIELD,
    uGrid: TERRAIN_GRID,
    ...(__PLANET__ ? { GRID_C: GRID_FRAME.c, GRID_E: GRID_FRAME.e, GRID_N: GRID_FRAME.n } : {}),
    uShore: { value: shore as Texture },
    uShoreGrid: { value: new Vector3(TERRAIN_HALF, TERRAIN_CELL, GRID) },
    uRockMap: { value: sharedLayers('map', bakes.rocks.map((bake) => bake.map), true, anisotropy) as Texture },
    uRockNormal: { value: sharedLayers('normal', bakes.rocks.map((bake) => bake.normalMap), false, anisotropy) as Texture },
    uDirtMap: { value: bakes.dirt.map as Texture },
    uEcology: { value: ecologyTexture as Texture },
    uSeasonDry: SEASON_DRY,
    // One repeat of the grass texture over 32 units (13 m): its tufts some
    // 40 cm, its dry patches 1.3 m. Over 96 units the tufts were 1.2 m and
    // the patches 4 m - blotches the size of a car beside the houses (the
    // player, 2026-10-08: "muito grande a textura"); read without repeats.
    uGrassScale: { value: 1 / m(12.8) },
    uRockScale: { value: 1 / ROCK_WORLD },
    uDirtScale: { value: 1 / m(13.6) },
    // The close-zoom layer (see `mesh/detailLayer.ts`): blades over grass,
    // grit over dirt and rock, faded in by pixel footprint.
    uDetailOn: detailSwitch,
    uGrassDetail: { value: grassDetail.map },
    uGrassDetailN: { value: grassDetail.normalMap },
    uGrassDetailScale: { value: 1 / grassDetail.worldSize },
    uSoilDetail: { value: soilDetail.map },
    uSoilDetailN: { value: soilDetail.normalMap },
    uSoilDetailScale: { value: 1 / soilDetail.worldSize },
    // Set to the surface's own bake (`createTerrainSurface`).
    uRelief: RELIEF_TEXTURE,
    uReliefWindow: { value: new Vector4(0, 0, 1, 0) },
    // Where this plate stands in the world (the planet's atlas: each face's
    // own); the map's grids are read from it. Zero on the flat map.
    uTileOrigin: { value: new Vector3() },
    // The planet's piece this plate is (-1: none): it draws only its own part
    // of the sphere (\`planet/bend.ts\` planetOwns).
    uPlanetTile: { value: -1 },
    // The planet's pieces drawn in full this frame (`PLANET_ACTIVE_TILES`):
    // the far globe's ground (`uPlanetTile` -2) is not drawn over them.
    ...(__PLANET__ ? { uPlanetActive: PLANET_ACTIVE_TILES } : {}),
  };
  material.userData['terrainUniforms'] = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vTerrainWorld;
         varying vec3 vTerrainAtlas;
         varying vec3 vTerrainNormal;
         ${__PLANET__ ? 'varying vec3 vTerrainDir;' : ''}
         attribute float aSteep;
         varying float vTerrainSteep;
         uniform vec3 uTileOrigin;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         // The plate's own coordinates (its grids, its textures), and the
         // world's (what lies round the camera).
         vTerrainAtlas = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vTerrainWorld = vTerrainAtlas - uTileOrigin;
         ${__PLANET__ ? `
         // The point's direction from the planet's centre, once a vertex: the
         // fragments read it interpolated (a 16-unit cell's chord is off the
         // arc by a hundredth of a unit) instead of each working its piece's
         // frame and trigonometry out again.
         { vec3 pe, pn; vTerrainDir = planetDirection(vTerrainAtlas, pe, pn); }` : ''}
         vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);
         vTerrainSteep = aSteep;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <clipping_planes_fragment>',
        __PLANET__
          ? `#include <clipping_planes_fragment>
             // Each piece's ground draws its own part of the sphere, with half a
             // grid cell over its border so no hairline opens between two.
             if (uPlanetTile >= 0.0 && !planetOwnsDirection(normalize(vTerrainDir), uPlanetTile, ${(TERRAIN_CELL / 2).toFixed(1)})) discard;
             // The far globe's ground (\`planet/globeGround.ts\`): not over a piece drawn in full.
             if (uPlanetTile < -1.5) {
               vec2 globeLocal;
               int globeTile = planetTile(vTerrainAtlas, globeLocal);
               int globeWord = globeTile / 24;
               float globeBits = uPlanetActive[globeWord];
               if (mod(floor(globeBits / exp2(float(globeTile - globeWord * 24))), 2.0) > 0.5) discard;
             }`
          : '#include <clipping_planes_fragment>',
      )
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uPlanetTile;
         // The planet's ice here (\`planet/iceField.ts\`, set with the biomes;
         // none on the flat map): how much of the pixel it covers, the height
         // of its bumps (crevasses, the snow's drifts) for the normal, how much
         // of it is bare, glazed ice rather than snow, and how thin it is to
         // the light (its faces and crevasses).
         float terrainIce = 0.0;
         float terrainIceBump = 0.0;
         float terrainIceGlaze = 0.0;
         float terrainIceThin = 0.0;
         ${__PLANET__ ? `varying vec3 vTerrainDir; uniform float uPlanetActive[${PLANET_ACTIVE_WORDS}]; ${GRID_ORIGIN_GLSL}` : ''}
         ${PLANET_BIOME_NOISE}
         varying vec3 vTerrainWorld;
         varying vec3 vTerrainAtlas;
         varying vec3 vTerrainNormal;
         varying float vTerrainSteep;
         uniform sampler2DArray uRelief;
         uniform vec4 uReliefWindow; // x, z of the close window's corner, its side, on
         // One level of the relief round xz: its slope, its crease, its ridge
         // and macro brightness, read across a pixel's footprint or a texel,
         // whichever is wider, so a far view takes the mean and never shimmers.
         // The large octaves (R) weighted by how far out the view is (wide);
         // the small ones (A) gentler up close: at full height they are
         // wrinkles near 45 degrees every few metres, and grassland seen at
         // that scale only undulates.
         float terrainReliefHeight(vec4 t, float wide) { return t.r * wide + t.a * mix(0.5, 1.0, wide); }
         void terrainReliefLevel(vec2 uv, float layer, float span, float wide, out vec2 grad, out float crease, out vec2 rest) {
           // A texel of the level as baked: on the planet a plate off the view has a smaller one (terrainRelief.ts FAR_RES).
           float e = max(1.0 / float(textureSize(uRelief, 0).x), 0.5 * max(fwidth(uv.x), fwidth(uv.y)));
           vec4 t0 = texture(uRelief, vec3(uv, layer));
           vec3 c0 = vec3(terrainReliefHeight(t0, wide), t0.gb);
           float xp = terrainReliefHeight(texture(uRelief, vec3(uv + vec2(e, 0.0), layer)), wide);
           float xm = terrainReliefHeight(texture(uRelief, vec3(uv - vec2(e, 0.0), layer)), wide);
           float zp = terrainReliefHeight(texture(uRelief, vec3(uv + vec2(0.0, e), layer)), wide);
           float zm = terrainReliefHeight(texture(uRelief, vec3(uv - vec2(0.0, e), layer)), wide);
           float d = e * span;
           grad = vec2(xp - xm, zp - zm) / (2.0 * d);
           // The crease over four units at the least: read at a texel, the
           // finest octaves' curvature drowned the gullies in speckle.
           float ec = max(e, ${m(1.6).toFixed(6)} / span);
           float cxp = terrainReliefHeight(texture(uRelief, vec3(uv + vec2(ec, 0.0), layer)), wide);
           float cxm = terrainReliefHeight(texture(uRelief, vec3(uv - vec2(ec, 0.0), layer)), wide);
           float czp = terrainReliefHeight(texture(uRelief, vec3(uv + vec2(0.0, ec), layer)), wide);
           float czm = terrainReliefHeight(texture(uRelief, vec3(uv - vec2(0.0, ec), layer)), wide);
           float dc = ec * span;
           crease = (cxp + cxm + czp + czm - 4.0 * c0.r) / (dc * dc);
           rest = c0.gb;
         }
         // The fine relief here (terrainRelief.ts): its slope, how much of a
         // crease (+) or a crest (-) the point is, and the filter's ridge map.
         vec2 terrainGrad = vec2(0.0);
         float terrainCrease = 0.0;
         float terrainRidge = 0.0;
         float terrainMacro = 1.0;
         float terrainCarved = 0.0;
         float terrainWide = 1.0;
         uniform sampler2DArray uRockMap;
         uniform sampler2DArray uPaint;
         uniform float uPaintRes; // the array's side (\`growPaint\`)
         uniform float uPaintHalf;
         uniform float uPaintSize;
         uniform vec4 uGrassField; // world x, y, reach, on
         uniform vec3 uGrid; // cell, strength, map half
         uniform sampler2D uShore;
         float terrainHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
         float ecoHash(vec2 p) {
           vec3 p3 = fract(vec3(p.xyx) * 0.1031);
           p3 += dot(p3, p3.yzx + 33.33);
           return fract((p3.x + p3.y) * p3.z);
         }
         float ecoNoise(vec2 p) {
           vec2 i = floor(p);
           vec2 f = fract(p);
           vec2 u = f * f * (3.0 - 2.0 * f);
           return mix(mix(ecoHash(i), ecoHash(i + vec2(1.0, 0.0)), u.x), mix(ecoHash(i + vec2(0.0, 1.0)), ecoHash(i + vec2(1.0, 1.0)), u.x), u.y);
         }
         uniform vec3 uShoreGrid; // half, cell, corners per side
         // The water level here, bilinear over the corners that HAVE water
         // (NO_WATER if none). Read from the nearest corner only, the level
         // stepped at every grid line along a falling river and drew dark
         // bands across the shallows under the water.
         // x: that level; y: the painted flowers here, z: the painted scrub,
         // w: the painted forest, all bilinear (G, B and A channels).
         // The painted geology here: x sandstone, y basalt (the rest granite).
         vec2 terrainGeo = vec2(0.0);
         // How much of this point the corners with a water level cover, 0..1:
         // the shore's bands fade with it, instead of ending in the grid's polygons.
         float terrainShoreCover = 0.0;
         vec4 terrainShoreSample(vec3 world) {
           vec2 g = clamp((world.xz + uShoreGrid.x) / uShoreGrid.y, vec2(0.0), vec2(uShoreGrid.z - 1.001));
           vec2 i = floor(g);
           vec2 f = g - i;
           ivec2 p = ivec2(i);
           vec4 c00 = texelFetch(uShore, p, 0);
           vec4 c10 = texelFetch(uShore, p + ivec2(1, 0), 0);
           vec4 c01 = texelFetch(uShore, p + ivec2(0, 1), 0);
           vec4 c11 = texelFetch(uShore, p + ivec2(1, 1), 0);
           vec4 level = vec4(c00.x, c10.x, c01.x, c11.x);
           vec4 bilinear = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
           vec4 has = step(vec4(${NO_WATER / 2}.0), level);
           vec4 w = bilinear * has;
           float sum = w.x + w.y + w.z + w.w;
           terrainShoreCover = sum;
           // G and B carry two bytes each (packGroundCorners): flowers and
           // scrub low, sandstone and basalt high, split per corner first.
           vec4 gPair = vec4(c00.y, c10.y, c01.y, c11.y);
           vec4 bPair = vec4(c00.z, c10.z, c01.z, c11.z);
           vec4 gHigh = floor(gPair / 256.0);
           vec4 bHigh = floor(bPair / 256.0);
           float flowers = dot(gPair - gHigh * 256.0, bilinear) / 255.0;
           float scrub = dot(bPair - bHigh * 256.0, bilinear) / 255.0;
           terrainGeo = vec2(dot(gHigh, bilinear), dot(bHigh, bilinear)) / 255.0;
           float forest = dot(vec4(c00.w, c10.w, c01.w, c11.w), bilinear);
           return vec4(sum > 1e-5 ? dot(level, w) / sum : ${NO_WATER}.0, flowers, scrub, forest);
         }
         uniform sampler2DArray uRockNormal;
         uniform sampler2D uDirtMap;
         uniform sampler2D uEcology;
         uniform float uSeasonDry;
         uniform float uGrassScale;
         uniform float uRockScale;
         uniform float uDirtScale;
         uniform sampler2D uGrassDetail;
         uniform sampler2D uGrassDetailN;
         uniform float uGrassDetailScale;
         uniform sampler2D uSoilDetail;
         uniform sampler2D uSoilDetailN;
         uniform float uSoilDetailScale;
         ${DETAIL_GLSL}

         // Set once per fragment: how far the close-zoom layer has taken over.
         // The macro maps are NOT read softer under it any more: biased two
         // mips down, the ground at the player's height was one blur (the
         // player, 2026-10-06).
         float terrainDetailW = 0.0;

         // Rotate the wide octave, as well as using an incommensurate scale:
         // otherwise the most visible clumps line up with their own repeats.
         vec2 terrainWideUv(vec2 uv) {
           return vec2(uv.x * 0.9396926 - uv.y * 0.3420201,
                       uv.x * 0.3420201 + uv.y * 0.9396926) * 0.137;
         }
         vec4 dualScale(sampler2D tex, vec2 uv) {
           vec4 near = texture2D(tex, uv);
           vec4 far = texture2D(tex, terrainWideUv(uv));
           return mix(near, far, 0.42);
         }
         // THE TEXTURE WITHOUT ITS REPEAT (Quilez, "Texture Repetition",
         // technique 3): two reads of it at offsets picked by a slow noise,
         // eight versions blended where the noise steps, derivatives from the
         // unmoved coordinates (textureGrad), so the mips stay right across
         // the offsets. From the map's zoom the lawn's 96 m tile and its 700 m
         // octave read as a grid printed over the land.
         vec2 noTileOffset(float i) { return fract(sin(vec2(i * 127.1 + 1.3, i * 311.7 + 4.7)) * 43758.5453); }
         vec4 textureNoTile(sampler2D tex, vec2 uv) {
           float idx = ecoNoise(uv * 0.35) * 8.0;
           float i0 = floor(idx);
           vec2 dx = dFdx(uv), dy = dFdy(uv);
           vec4 a = textureGrad(tex, uv + noTileOffset(i0), dx, dy);
           vec4 b = textureGrad(tex, uv + noTileOffset(i0 + 1.0), dx, dy);
           return mix(a, b, smoothstep(0.2, 0.8, idx - i0));
         }
         // The wide octave as a MACRO variation only (landscape materials
         // pass from the detail texture to a macro one with distance, Unreal):
         // its brightness against the texture's mean, at a third of its
         // strength. Mixed in whole (0.42), it carried the tufts' full
         // contrast up to hundreds of metres, and from the map's zoom the
         // land was dark camouflage blotches.
         vec4 dualScaleNoTile(sampler2D tex, vec2 uv) {
           vec4 near = textureNoTile(tex, uv);
           vec3 far = textureNoTile(tex, terrainWideUv(uv)).rgb;
           float mean = max(dot(texture2D(tex, uv, 14.0).rgb, vec3(0.3, 0.6, 0.1)), 0.02);
           float macro = clamp(dot(far, vec3(0.3, 0.6, 0.1)) / mean, 0.7, 1.3);
           return vec4(near.rgb * mix(1.0, macro, 0.35), near.a);
         }
         vec3 dualScaleNormal(sampler2D tex, vec2 uv) {
           vec3 near = texture2D(tex, uv).xyz * 2.0 - 1.0;
           vec3 far = texture2D(tex, terrainWideUv(uv)).xyz * 2.0 - 1.0;
           // Bring the wide octave's tangent slope back into the ground frame.
           far.xy = vec2(far.x * 0.9396926 + far.y * 0.3420201,
                        -far.x * 0.3420201 + far.y * 0.9396926);
           return mix(near, far, 0.42);
         }

         // A WALL is not a floor. The ground's textures are read in a plan
         // view, which smears a 45-degree cliff into vertical stripes: the
         // steeper the land the more of the map's area it covers, and once the
         // brush could raise mountains, whole hillsides were stripes.
         //
         // A cliff is read by the projection that faces it instead - the rock
         // map sampled in the z-y plane for a face across z, in x-y for one
         // across x - blended by how much of the normal points each way. Only
         // the rock needs it: grass and soil live on ground gentle enough for
         // the plan view, and rockMix is zero there anyway.
         vec3 terrainWallAxis() {
           vec3 n = abs(normalize(vTerrainNormal));
           return vec3(n.x / max(0.0001, n.x + n.z), 0.0, 0.0);
         }
         vec2 terrainWallUv(vec3 world, float scale, float wXl) {
           // u runs across the face, v up it.
           vec2 acrossX = world.zy * scale;
           vec2 acrossZ = world.xy * scale;
           return mix(acrossZ, acrossX, wXl);
         }
         // TRIPLANAR (GPU Gems 3 ch. 1; Golus, "Normal Mapping for a Triplanar
         // Shader"): one sample per plane, the SAMPLES blended. Blending the
         // coordinates instead (terrainWallUv) twisted the rock into curved
         // wood grain wherever a face turned between the two axes.
         // The slope, in degrees: the smooth vertex normal's, or - where a
         // corner touches a WALL (a face over 50 degrees, \`aSteep\`) - the
         // wall's, so a cliff narrower than the grid is drawn as rock.
         // The land's light and shape per corner (terrainLight), bilinear.
         vec4 terrainLand() {
           vec2 cell = vec2((vTerrainWorld.x + uPaintHalf) / ${TERRAIN_CELL.toFixed(6)}, (uPaintHalf + vTerrainWorld.z) / ${TERRAIN_CELL.toFixed(6)});
           return texture(uPaint, vec3((cell + 0.5) / uPaintRes, ${LIGHT_LAYER.toFixed(1)}));
         }
         // The steepness that decides grass, soil and rock: the smooth
         // normal's, raised to a wall's where the corners say the land is one.
         // Those corners are read bilinearly from the texture: interpolated
         // per triangle (vTerrainSteep) the edge of a wall followed the mesh's
         // triangles in teeth.
         float terrainSlope() {
           float smoothSlope = degrees(acos(clamp(vTerrainNormal.y, 0.0, 1.0)));
           float landSlope = terrainLand().a * 90.0;
           return max(smoothSlope, mix(smoothSlope, landSlope, smoothstep(38.0, 60.0, landSlope)));
         }
         vec3 terrainTriWeights(vec3 n) {
           vec3 w = pow(abs(n), vec3(4.0));
           return w / max(w.x + w.y + w.z, 1e-4);
         }
         vec4 terrainTriColor(sampler2D tex, vec3 p, float scale, vec3 w) {
           return texture2D(tex, p.zy * scale) * w.x + texture2D(tex, p.xz * scale) * w.y + texture2D(tex, p.xy * scale) * w.z;
         }
         // The UDN blend with each axis's sign restored, in WORLD space.
         vec3 terrainTriNormal(sampler2D tex, vec3 p, float scale, vec3 n, vec3 w) {
           vec3 tx = texture2D(tex, p.zy * scale).xyz * 2.0 - 1.0;
           vec3 ty = texture2D(tex, p.xz * scale).xyz * 2.0 - 1.0;
           vec3 tz = texture2D(tex, p.xy * scale).xyz * 2.0 - 1.0;
           vec3 s = sign(n);
           tx = vec3(tx.xy + n.zy, abs(n.x) * s.x);
           ty = vec3(ty.xy + n.xz, abs(n.y) * s.y);
           tz = vec3(tz.xy + n.xy, abs(n.z) * s.z);
           return normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
         }
         // THE ROCKS: granite, sandstone, basalt, a face layer and a top layer
         // each in one texture array (layer = kind * 2, + 1 for the top),
         // read with gradients taken once in uniform control flow, so a kind
         // or a projection with no weight is skipped (MicroSplat's dynamic
         // branching over a texture array).
         vec3 rockDpdx = vec3(0.0);
         vec3 rockDpdy = vec3(0.0);
         // How much of each rock the colour took (granite, sandstone, basalt);
         // the normal reads the same.
         vec3 terrainRockMix = vec3(1.0, 0.0, 0.0);
         vec4 rockTriColor(float kind, vec3 p, vec3 w) {
           float face = kind * 2.0;
           vec4 c = vec4(0.0);
           float used = 0.0;
           if (w.x > 0.01) { c += textureGrad(uRockMap, vec3(p.zy * uRockScale, face), rockDpdx.zy, rockDpdy.zy) * w.x; used += w.x; }
           if (w.y > 0.01) { c += textureGrad(uRockMap, vec3(p.xz * uRockScale, face + 1.0), rockDpdx.xz, rockDpdy.xz) * w.y; used += w.y; }
           if (w.z > 0.01) { c += textureGrad(uRockMap, vec3(p.xy * uRockScale, face), rockDpdx.xy, rockDpdy.xy) * w.z; used += w.z; }
           return c / max(used, 1e-4);
         }
         vec3 rockTriNormal(float kind, vec3 p, vec3 n, vec3 w) {
           float face = kind * 2.0;
           vec3 s = sign(n);
           vec3 acc = vec3(0.0);
           if (w.x > 0.01) {
             vec3 t = textureGrad(uRockNormal, vec3(p.zy * uRockScale, face), rockDpdx.zy, rockDpdy.zy).xyz * 2.0 - 1.0;
             t = vec3(t.xy + n.zy, abs(n.x) * s.x);
             acc += t.zyx * w.x;
           }
           if (w.y > 0.01) {
             vec3 t = textureGrad(uRockNormal, vec3(p.xz * uRockScale, face + 1.0), rockDpdx.xz, rockDpdy.xz).xyz * 2.0 - 1.0;
             t = vec3(t.xy + n.xz, abs(n.y) * s.y);
             acc += t.xzy * w.y;
           }
           if (w.z > 0.01) {
             vec3 t = textureGrad(uRockNormal, vec3(p.xy * uRockScale, face), rockDpdx.xy, rockDpdy.xy).xyz * 2.0 - 1.0;
             t = vec3(t.xy + n.xy, abs(n.z) * s.z);
             acc += t.xyz * w.z;
           }
           return normalize(acc + n * 1e-4);
         }
         // One sandstone bed's tint over the face texture: mostly tan and
         // orange, now and then a cream, a rust or a brown-grey one.
         vec3 sandstoneBed(float i) {
           float r = terrainHash(vec2(i, 17.0));
           return r < 0.12 ? vec3(1.13, 1.12, 1.1)
             : r < 0.3 ? vec3(1.05, 1.0, 0.95)
             : r < 0.58 ? vec3(1.0)
             : r < 0.8 ? vec3(1.05, 0.9, 0.78)
             : r < 0.92 ? vec3(0.9, 0.72, 0.62)
             : vec3(0.84, 0.78, 0.74);
         }
         // The sandstone's beds by HEIGHT, level on every cliff and never
         // repeating: principal beds 34 units (14 m) apart and thinner ones
         // between at a third of the contrast (Terragen's strata), read at a
         // height a slow noise bends (Unity's strata noise), a shade where a
         // softer bed weathers back under a hard one.
         vec3 sandstoneBeds(float y, float warpA, float warpC) {
           float t = (y + (warpA - 0.5) * 30.0 + (warpC - 0.5) * 9.0) / 34.0;
           float i = floor(t);
           float f = t - i;
           vec3 tint = mix(sandstoneBed(i), sandstoneBed(i + 1.0), smoothstep(0.82, 1.0, f));
           float t2 = t * 3.3 + 0.37;
           float i2 = floor(t2);
           tint *= mix(vec3(1.0), mix(sandstoneBed(i2 + 40.0), sandstoneBed(i2 + 41.0), smoothstep(0.8, 1.0, t2 - i2)), 0.35);
           float hard = step(0.6, terrainHash(vec2(i + 1.0, 5.0)));
           tint *= 1.0 - hard * 0.18 * smoothstep(0.84, 0.92, f) * (1.0 - smoothstep(0.96, 1.0, f));
           return tint;
         }
         // Granite's exfoliation sheets: no beds, but broad shells of slightly
         // different weathering a dozen metres apart, warmer and cooler.
         vec3 graniteSheets(float y, float warpA, float warpC) {
           float t = (y + (warpA - 0.5) * 60.0 + (warpC - 0.5) * 20.0) / 30.0;
           float i = floor(t);
           float f = t - i;
           vec3 a = mix(vec3(0.9, 0.92, 0.95), vec3(1.06, 1.04, 1.0), terrainHash(vec2(i, 47.0)));
           vec3 b = mix(vec3(0.9, 0.92, 0.95), vec3(1.06, 1.04, 1.0), terrainHash(vec2(i + 1.0, 47.0)));
           return mix(a, b, smoothstep(0.7, 1.0, f));
         }
         // Basalt's lava flows, stacked some 22 m each: barely different
         // greys, the weathered, bubbly top of each a little redder.
         vec3 basaltFlows(float y, float warpA) {
           float t = (y + (warpA - 0.5) * 34.0) / 56.0;
           float i = floor(t);
           float f = t - i;
           vec3 tint = mix(vec3(0.84, 0.87, 0.9), vec3(1.12, 1.06, 1.0), terrainHash(vec2(i, 31.0)));
           tint *= mix(vec3(1.0), vec3(1.14, 0.97, 0.88), smoothstep(0.78, 0.92, f) * (1.0 - smoothstep(0.97, 1.0, f)));
           return tint;
         }
`,
      )
      .replace(
        '#include <map_fragment>',
        `terrainDetailW = detailWeight(vTerrainWorld.xz);
         {
           // Read across a pixel's footprint or a texel, whichever is wider,
           // so the far view takes the relief's mean and never shimmers.
           vec2 grad;
           float creaseAt;
           vec2 rest;
           // How much ground a pixel covers: the large gullies only where it
           // is two units or more, where the flat outline cannot give them away.
           float footprint = max(fwidth(vTerrainWorld.x), fwidth(vTerrainWorld.z));
           // From well out only: at the usual close zoom (a pixel a unit or two)
           // the gullies still read as folded cloth (the player, 2026-10-07:
           // "dar uma suavizada nessa textura do chão").
           float wide = smoothstep(${m(0.32).toFixed(6)}, ${m(1.2).toFixed(6)}, footprint);
           terrainWide = wide;
           terrainReliefLevel((vTerrainWorld.xz + uPaintHalf) / uPaintSize, 0.0, uPaintSize, wide, grad, creaseAt, rest);
           // The close window's finer level (the clipmap's nested grid),
           // blended in over the window's outer tenth. The test is on a
           // uniform, so the reads inside keep their derivatives.
           if (uReliefWindow.w > 0.5) {
             vec2 wuv = (vTerrainWorld.xz - uReliefWindow.xy) / uReliefWindow.z;
             vec2 fineGrad;
             float fineCrease;
             vec2 fineRest;
             terrainReliefLevel(wuv, 1.0, uReliefWindow.z, wide, fineGrad, fineCrease, fineRest);
             vec2 edge = min(wuv, 1.0 - wuv);
             float fine = smoothstep(0.0, 0.1, min(edge.x, edge.y));
             grad = mix(grad, fineGrad, fine);
             creaseAt = mix(creaseAt, fineCrease, fine);
             rest = mix(rest, fineRest, fine);
           }
           // Carved into the hillsides, the plains left smooth: over the
           // whole map it read as crumpled paper, and a town's ground has to
           // look level. Full from some seventeen degrees.
           float meshSlope = length(normalize(vTerrainNormal).xz) / max(normalize(vTerrainNormal).y, 0.25);
           float carved = smoothstep(0.06, 0.3, meshSlope);
           terrainCarved = carved;
           terrainGrad = grad * carved * mix(0.8, 1.0, wide);
           terrainCrease = creaseAt * carved;
           terrainRidge = rest.x;
           terrainMacro = rest.y;
         }
         // Taken here, in uniform control flow: the rock is read only where
         // rock shows, with these gradients.
         rockDpdx = dFdx(vTerrainWorld) * uRockScale;
         rockDpdy = dFdy(vTerrainWorld) * uRockScale;
         vec2 tGrass = vTerrainWorld.xz * uGrassScale;
         vec2 tDirt = vTerrainWorld.xz * uDirtScale;
         float wallX = terrainWallAxis().x;
         vec2 tRock = terrainWallUv(vTerrainWorld, uRockScale, wallX);
         vec3 triN = normalize(vTerrainNormal);
         vec3 triW = terrainTriWeights(triN);
         // In DEGREES, not in one-minus-cosine. The cosine of a small angle is
         // almost one, so thresholds written against it are unreadable and were
         // simply wrong: a 10-degree hillside came out at 0.015, under a
         // threshold meant to start at a gentle slope, and the whole map stayed
         // one flat green however steep it got.
         // And the steeper of the vertex normal and the drawn face: a cliff a
         // cell or two wide shares its corners with the flat ground above and
         // below it, so its averaged normals called the wall a 30-degree bank
         // and it was drawn as turf.
         float slopeDeg = terrainSlope();
         // High ground is bare whatever its slope: the quickest way to say
         // "mountain" is that nothing grows on the top of it.
         // Only the real summits: from 260 it greyed the top of every hill
         // and dome into an olive mat (the player, 2026-10-07).
         float altitude = smoothstep(${m(168).toFixed(4)}, ${m(232).toFixed(4)}, vTerrainWorld.y);
         // The bands are in degrees of slope, and they were set for land that
         // could not rise more than ten metres: soil from 9 degrees, rock from
         // 26. On a map with real hills that painted every hillside tan, and
         // the whole country read as savanna. Soil now starts where a slope
         // stops holding turf (18 degrees), rock where it stops holding soil.
         //
         // The bands WANDER: a slow noise shifts each threshold by up to some
         // fifteen degrees, so the soil and the rock follow the landform
         // loosely instead of drawing concentric rings round every hill.
         float wanderA = texture2D(uDirtMap, vTerrainWorld.xz * ${perM(0.00575).toFixed(6)}).g;
         float wanderB = texture2D(map, terrainWideUv(vTerrainWorld.xz * ${perM(0.0275).toFixed(6)})).g;
         // And a hill-sized one (about 50 m), or a hill still wears one
         // even, wobbly ring of soil round its foot.
         float wanderC = texture2D(uDirtMap, vTerrainWorld.xz * ${perM(0.05).toFixed(6)} + 0.37).g;
         // And a ragged one of about 12 m, so the edge itself frays.
         float wanderD = texture2D(uDirtMap, vTerrainWorld.xz * ${perM(0.2075).toFixed(6)} + 0.61).b;
         float wander = (wanderA - 0.5) * 14.0 + (wanderB - 0.5) * 10.0 + (wanderC - 0.5) * 30.0 + (wanderD - 0.5) * 16.0;
         // The wander eases on a cliff (nothing holds turf on a wall) but
         // never lets go: it frays the rim, where the cliff's triangles meet
         // the flat in the grid's zigzag, into ragged turf instead of teeth.
         // A wide FUZZY ZONE broken by a fine noise (Terragen's surface layers:
         // a slope constraint with a fuzzy zone, its mask broken up), so turf
         // and rock interfinger over a few metres instead of meeting on a line.
         float breakup = (texture2D(uDirtMap, vTerrainWorld.xz * ${perM(0.475).toFixed(6)} + 0.13).g - 0.5) * 26.0;
         float rockW = max(smoothstep(30.0, 56.0, slopeDeg + wander * (1.0 - 0.5 * smoothstep(45.0, 70.0, slopeDeg)) + breakup), altitude * 0.92);
         // Narrowed where the rock is near: turf meets the stone across a thin
         // band of soil, not a red ring drawn round every outcrop.
         // Grass holds a hillside to some thirty degrees: soil from fourteen
         // capped every hill and dome in a mat of brown straw (the player,
         // 2026-10-07).
         float dirtW = smoothstep(27.0, 42.0, slopeDeg + wander * 1.0) * (1.0 - rockW) * (1.0 - 0.6 * smoothstep(36.0, 48.0, slopeDeg + wander * 1.0));
         float grassW = max(0.0, 1.0 - rockW - dirtW);
         vec4 grassColor = dualScaleNoTile(map, tGrass);
         // Which rock breaks out here: the painted geology, granite where none
         // was painted. Each kind is its own pair of layers (face, top) and is
         // read only where it is and only where rock shows.
         vec4 shoreSample = terrainShoreSample(vTerrainWorld);
         vec3 geology = vec3(max(0.0, 1.0 - terrainGeo.x - terrainGeo.y), terrainGeo.x, terrainGeo.y);
         vec4 rockColor = vec4(0.45, 0.43, 0.4, 1.0);
         if (rockW > 0.001) {
           vec4 cGranite = vec4(0.0);
           vec4 cSand = vec4(0.0);
           vec4 cBasalt = vec4(0.0);
           if (geology.x > 0.01) { cGranite = rockTriColor(0.0, vTerrainWorld, triW); cGranite.rgb *= graniteSheets(vTerrainWorld.y, wanderA, wanderC); }
           if (geology.y > 0.01) { cSand = rockTriColor(1.0, vTerrainWorld, triW); cSand.rgb *= sandstoneBeds(vTerrainWorld.y, wanderA, wanderC); }
           if (geology.z > 0.01) { cBasalt = rockTriColor(2.0, vTerrainWorld, triW); cBasalt.rgb *= basaltFlows(vTerrainWorld.y, wanderA); }
           // Height-blended between the rocks too: a boundary breaks along the
           // stone instead of fading one rock into the other.
           vec3 has = step(vec3(0.01), geology);
           vec3 hk = (geology + vec3(dot(cGranite.rgb, vec3(0.3, 0.6, 0.1)), dot(cSand.rgb, vec3(0.3, 0.6, 0.1)), dot(cBasalt.rgb, vec3(0.3, 0.6, 0.1))) * 0.6) * has;
           float topK = max(hk.x, max(hk.y, hk.z)) - 0.12;
           vec3 bk = max(hk - topK, vec3(0.0)) * has;
           terrainRockMix = bk / max(bk.x + bk.y + bk.z, 1e-4);
           rockColor = cGranite * terrainRockMix.x + cSand * terrainRockMix.y + cBasalt * terrainRockMix.z;
         }
         // Soil on a slope is read from the side, as the rock is: from above
         // it smeared down every bank in long streaks.
         vec4 dirtPlan = dualScale(uDirtMap, tDirt);
         vec4 dirtSide = terrainTriColor(uDirtMap, vTerrainWorld, uDirtScale, triW);
         vec4 dirtColor = mix(dirtPlan, dirtSide, smoothstep(22.0, 42.0, slopeDeg));
         // The soil is the rock it weathered from: red-yellow over granite,
         // pale and sandy over sandstone, the dark purple-red terra roxa over
         // basalt.
         dirtColor.rgb *= geology.x * vec3(0.88, 0.86, 0.88) + geology.y * vec3(1.14, 1.06, 0.92) + geology.z * vec3(0.8, 0.56, 0.52);
         // Height blending (Mishkinis, "Advanced Terrain Texture Splatting"):
         // each surface rises by its own relief, read from its brightness, and
         // the highest within a thin depth wins, so soil fills the hollows
         // between stones and the turf breaks into tufts at its edge instead
         // of a soft fade. A surface with no weight gets no relief either.
         float hGrass = grassW + dot(grassColor.rgb, vec3(0.3, 0.6, 0.1)) * 1.4 * smoothstep(0.0, 0.35, grassW);
         float hDirt = dirtW + dot(dirtColor.rgb, vec3(0.3, 0.6, 0.1)) * 0.9 * smoothstep(0.0, 0.35, dirtW);
         float hRock = rockW + dot(rockColor.rgb, vec3(0.3, 0.6, 0.1)) * 1.1 * smoothstep(0.0, 0.35, rockW);
         float hTop = max(hGrass, max(hDirt, hRock)) - 0.3;
         float bGrass = max(hGrass - hTop, 0.0);
         float bDirt = max(hDirt - hTop, 0.0);
         float bRock = max(hRock - hTop, 0.0);
         float bSum = max(bGrass + bDirt + bRock, 1e-4);
         float rockMix = bRock / bSum;
         float dirtMix = bDirt / bSum;
         vec4 blended = (grassColor * bGrass + dirtColor * bDirt + rockColor * bRock) / bSum;
         // TALUS where the rock gives out: its own rubble and grit, darker,
         // mixed with the soil (each rock its own scree, so a sandstone foot is
         // orange and a basalt one near black), so the cliff stands on a
         // skirt of debris and not straight in the lawn.
         float talus = smoothstep(0.06, 0.4, rockW) * (1.0 - smoothstep(0.5, 0.92, rockW));
         if (talus > 0.001) {
           float pebbles = texture2D(uDirtMap, vTerrainWorld.xz * ${perM(1.325).toFixed(6)}).r;
           vec3 scree = mix(rockColor.rgb * 0.7, dirtColor.rgb * 0.8, 0.4) * mix(0.75, 1.2, pebbles);
           blended.rgb = mix(blended.rgb, scree, talus * 0.75);
           rockMix = max(rockMix, talus * 0.5);
         }
         // The terrain lets the blades in from much further than the shared
         // layer does (DETAIL_FAR is 0.16 units a pixel): between that and a
         // unit a pixel the grass had nothing finer than its patches.
         terrainDetailW = max(terrainDetailW, uDetailOn * (1.0 - smoothstep(${m(0.048).toFixed(6)}, ${m(0.44).toFixed(6)}, max(fwidth(vTerrainWorld.x), fwidth(vTerrainWorld.z)))) * 0.75);
         if (terrainDetailW > 0.001) {
           vec3 bladeDetail = detailSample(uGrassDetail, vTerrainWorld.xz * uGrassDetailScale);
           vec3 soilDetail = detailSample(uSoilDetail, terrainWallUv(vTerrainWorld, uSoilDetailScale, wallX));
           // Blades only where the ground is gentle: projected from above
           // onto a bank they stretched into long hairs.
           float soilMix = max(clamp(dirtMix + rockMix, 0.0, 1.0), smoothstep(12.0, 24.0, slopeDeg));
           vec3 fine = mix(bladeDetail, soilDetail, soilMix);
           blended.rgb *= mix(vec3(1.0), fine, terrainDetailW);
         }
         // The land's own colour map, as an aerial photograph shows it: wide
         // fields of lush green, yellowing meadow, deep green and olive, a few
         // hundred metres each (macroTexture). It tints the grass fully and
         // the bare ground a little, so a valley reads as country and not as
         // one lawn tiled to the horizon.
         // Light and dark only, and gently (Unreal's landscape macro
         // variation): fields of yellow, olive and deep green laid over the
         // lawn read as blotches from the map's zoom.
         // Its brightness, baked with the relief (terrainRelief.ts).
         // (No macro light and dark any more: the player asked for the
         // terrain's lights and effects to go, 2026-10-08 - "está feio".)
         // THE GRAIN AT EVERY ZOOM (distance tiling, as landscape materials
         // switch a texture to a larger tiling with the camera's distance):
         // the grass read again at the scale where its tufts are a few pixels
         // across, two neighbouring scales blended, and laid on the lawn as
         // light and shade. Up close the texture's own detail is that grain;
         // from the whole map's zoom the mip chain had averaged it into flat
         // felt, and the lawn read as paint, not grass.
         {
           vec2 grainFp = fwidth(vTerrainWorld.xz);
           // Tufts half a pixel to one: the mip chain has already averaged
           // what is finer than a pixel (mipmaps are pre-filtered), so it
           // does not shimmer. Set four times coarser (* 3.6) the patches grew
           // to the size of a house (the player, 2026-10-08: "muito grande a
           // textura"); the shimmer was the sharpening pass, now off. Read
           // without the texture's repeat.
           float grainLod = max(0.0, log2(max(grainFp.x, grainFp.y) * 0.9));
           float grainLevel = floor(grainLod);
           float grainBlend = grainLod - grainLevel;
           vec2 grainUv = vTerrainWorld.xz * uGrassScale * 2.7;
           float g0 = dot(textureNoTile(map, grainUv / exp2(grainLevel)).rgb, vec3(0.3, 0.6, 0.1));
           float g1 = dot(textureNoTile(map, grainUv / exp2(grainLevel + 1.0) + 0.37).rgb, vec3(0.3, 0.6, 0.1));
           float gAvg = dot(texture2D(map, grainUv, 14.0).rgb, vec3(0.3, 0.6, 0.1));
           float grain = mix(g0, g1, grainBlend) / max(gAvg, 0.02);
           float grainW = smoothstep(0.15, 0.6, grainLod) * grassW * (1.0 - clamp(rockMix + dirtMix, 0.0, 1.0));
           // Gently: at 0.55 to 1.5 the grain drew dark blotches as deep as the trees' green.
           blended.rgb *= mix(1.0, clamp(grain, 0.8, 1.25), grainW * 0.5);
         }
         // A hillshade written into the ALBEDO, on top of the light the surface
         // actually receives. Direct sun alone moves a 10-degree slope by about
         // a tenth, which is under what the eye reads as shape at map zoom; this
         // doubles that for the slopes that carry the landform and leaves flat
         // ground untouched, so the hills are legible without the scene turning
         // into a relief map.
         float relief = clamp(dot(normalize(vTerrainNormal), normalize(vec3(0.24, 0.62, -0.75))), -1.0, 1.0);
         // Painted flowers: blossoms a hand across scattered through the
         // grass, as many as the painted density, in a meadow's colours. Each
         // 0.4-unit cell holds at most one, at a jittered point; they fade to
         // their average tint where a pixel is wider than a blossom, so the
         // far view shows a flowering meadow and not flickering dots.
         // Derivatives taken outside any branch, where they are defined: how
         // many 0.4-unit blossom cells one pixel spans.
         vec2 fp = vTerrainWorld.xz / ${m(0.16).toFixed(6)};
         float footprint = max(fwidth(fp.x), fwidth(fp.y));
         // Scrubland: the ground under painted scrub goes the dark olive of
         // a thicket's shade, so the patch reads from the whole map's zoom
         // and not only where its bushes are big enough to see.
         blended.rgb = mix(blended.rgb, blended.rgb * vec3(0.42, 0.52, 0.32), clamp(shoreSample.z * 1.4, 0.0, 0.85));
         // Under a forest the floor is the canopy's shade: dark, mossy, with
         // leaf litter - so the gaps between crowns read as the depth of a
         // closed forest from above, not as a lawn showing through (near
         // trees drawn one by one, the forest's far effect on the ground:
         // Bruneton & Neyret, "Real-time realistic rendering and lighting of
         // forests").
         // THE ECOSYSTEM'S GROUND (world/ecology.ts), only where the ground is
         // vegetated (not on the rock or the bare slopes): the savanna's
         // tufts of straw-gold grass with red soil between them, going
         // greener with the rains; bare soil where the herbs are sparse (the
         // caatinga); the dark sodden green of veredas, brejos and várzeas;
         // and under a canopy the forest floor's litter. The fine detail fades
         // with the pixel's footprint, so the far view keeps the mix of colours
         // and never shimmers.
         vec4 eco = texture2D(uEcology, ((vec2(vTerrainWorld.x, vTerrainWorld.z) + uShoreGrid.x) / uShoreGrid.y + 0.5) / uShoreGrid.z);
         float living = 1.0 - clamp(rockMix + dirtMix, 0.0, 1.0);
         {
           vec2 q = vTerrainWorld.xz;
           // The grass's OWN texture, its HUE turned to straw where the
           // savanna is dry - the same brightness and the same contrast, so
           // the ground keeps its texture and is never lit any lighter (a
           // flat khaki laid over it washed the whole map out). Green stays
           // the rule; the gold comes in broad patches, most on the exposed
           // tops and the rocky fields (eco.g), more as the dry season deepens.
           float luma = dot(grassColor.rgb, vec3(0.3, 0.6, 0.1));
           vec3 straw = luma * vec3(1.32, 1.04, 0.46) * 1.05;
           float patchy = ecoNoise(q / 37.0 + 7.0) * 0.6 + ecoNoise(q / 13.0 + 3.0) * 0.4;
           float golden = clamp(eco.g * mix(0.25, 1.0, uSeasonDry) * (0.35 + 0.9 * patchy), 0.0, 1.0);
           // Each patch either green or gold, its edge broken by the tufts:
           // half of each mixed was an olive wash.
           float lift = clamp((luma - 0.17) / 0.2, 0.0, 1.0);
           float goldMask = smoothstep(0.35, 0.8, golden + (lift - 0.5) * 0.3) * 0.25;
           blended.rgb = mix(blended.rgb, straw, goldMask * living);
           // Bare red soil only where the herbs are sparse.
           blended.rgb = mix(blended.rgb, dirtColor.rgb * (0.85 + 0.25 * lift), eco.a * 0.4 * living);
           // Waterlogged: darker, deeper green, a little blue, in hummocks.
           vec3 sodden = blended.rgb * vec3(0.55, 0.72, 0.55);
           blended.rgb = mix(blended.rgb, sodden, eco.b * 0.85 * living);
           // The forest floor as the painted forest's always was: the grass
           // darkened under the canopy, its texture kept. The ecosystem's own
           // canopy (eco.r) darkens it only once its trees stand there.
           blended.rgb = mix(blended.rgb, blended.rgb * vec3(0.3, 0.36, 0.24), clamp(shoreSample.w * 1.6, 0.0, 0.9));
         }
         ${PLANET_BIOMES}
         ${__PLANET__ ? `
         // The woods' own tone under the trees and in their place from afar
         // (the trees end with the full pieces; past them only this tone):
         // the masses stay, as a forest seen from orbit is a darker tone of
         // the land - never a pop from trees to bare ground. Worked out per
         // pixel from the same noise the trees stand by (\`natureNoise.ts\`),
         // at the same map coordinates: one pattern on every piece.
         {
           vec3 woodsAt = normalize(vTerrainDir) * PLANET_R;
           float woodsPatch = woodsNoise(woodsAt, ${(170 * UNITS_PER_METER_HERE).toFixed(4)}, 7u) * 0.6
             + woodsNoise(woodsAt, ${(55 * UNITS_PER_METER_HERE).toFixed(4)}, 9u) * 0.3
             + woodsNoise(woodsAt, ${(18 * UNITS_PER_METER_HERE).toFixed(4)}, 11u) * 0.1;
           float woodsMass = clamp((woodsPatch - 0.47) / 0.3, 0.0, 1.0);
           float woodsDensity = woodsMass * 0.72 + 0.35 * 0.3 - 0.06;
           float woods = smoothstep(0.38, 0.7, woodsDensity);
           blended.rgb = mix(blended.rgb, blended.rgb * vec3(0.5, 0.68, 0.45), woods * living * (1.0 - terrainIce));
         }` : ''}
         // (No slope wear, dry tops, pale crests or dark hollows in the colours
         // any more: the player asked for the terrain's effects to go.)
         {
           float flowersW = shoreSample.y * (1.0 - clamp(dirtMix + rockMix, 0.0, 1.0));
           if (flowersW > 0.01) {
             // Blossoms at EVERY zoom, as levels of detail: a hand across up
             // close, and as the camera pulls back the cells double - patches
             // of flowers a metre, two, four across - so a flower is always a
             // few pixels wide, two neighbouring levels blended so nothing
             // pops. A painted meadow stays a flowering meadow on the map.
             float lod = max(0.0, log2(footprint * 2.5));
             float level0 = floor(lod);
             float between = lod - level0;
             vec3 bloom = vec3(0.0);
             float cover = 0.0;
             for (int k = 0; k < 2; k++) {
               float size = exp2(level0 + float(k));
               vec2 q = fp / size;
               vec2 cellId = floor(q) + (level0 + float(k)) * 17.0;
               float pick = terrainHash(cellId);
               vec2 centre = vec2(terrainHash(cellId + 7.1), terrainHash(cellId + 3.3)) * 0.6 + 0.2;
               float dist = length(fract(q) - centre);
               float roll = terrainHash(cellId + 11.9);
               vec3 petal = roll < 0.34 ? vec3(0.85, 0.66, 0.06) : roll < 0.46 ? vec3(0.86, 0.86, 0.82) : roll < 0.74 ? vec3(0.74, 0.22, 0.42) : vec3(0.44, 0.26, 0.7);
               float present = step(pick, flowersW * 0.36);
               float edge = footprint / size;
               float blossom = present * (1.0 - smoothstep(0.17, 0.17 + edge, dist));
               float weight = k == 0 ? 1.0 - between : between;
               bloom += petal * blossom * weight;
               cover += blossom * weight;
             }
             blended.rgb = mix(blended.rgb, bloom / max(cover, 1e-4), clamp(cover, 0.0, 1.0));
           }
         }
         // The shore (Terragen's "wet shores": a band set by height over the
         // water, darkened where it is wet). Under the water a muddy bed, at
         // the waterline a dark wet strip, above it a beach of pale sand that
         // only lies where the bank is gentle enough to hold it.
         float shoreLevel = shoreSample.x;
         if (shoreLevel > ${NO_WATER / 2}.0) {
           float above = vTerrainWorld.y - shoreLevel;
           float sandLuma = dot(dirtPlan.rgb, vec3(0.3, 0.6, 0.1));
           vec3 sand = vec3(0.42, 0.36, 0.23) * (0.82 + sandLuma * 1.4);
           float gentle = 1.0 - smoothstep(24.0, 40.0, slopeDeg);
           float shoreFade = smoothstep(0.15, 0.85, terrainShoreCover + (wanderD - 0.5) * 0.3);
           float beach = (1.0 - smoothstep(${m(1).toFixed(4)} + wanderD * ${m(1.2).toFixed(4)}, ${m(2.4).toFixed(4)} + wanderD * ${m(1.2).toFixed(4)}, above)) * gentle * shoreFade;
           blended.rgb = mix(blended.rgb, sand, beach * (1.0 - rockMix * 0.6));
           // A steep bank holds no beach: it is a cut of damp earth from the
           // water up to the turf, frayed at its top.
           float bank = (1.0 - smoothstep(${m(2).toFixed(4)} + wanderD * ${m(2).toFixed(4)}, ${m(4).toFixed(4)} + wanderD * ${m(2).toFixed(4)}, above)) * (1.0 - gentle) * shoreFade;
           blended.rgb = mix(blended.rgb, dirtColor.rgb * vec3(0.78, 0.72, 0.62), bank * (1.0 - rockMix));
           // Below the water: a bed of sand and pebbles, seen through the
           // shallows, going to silt as it deepens.
           float bed = smoothstep(0.0, ${m(-0.8).toFixed(4)}, above) * smoothstep(0.03, 0.35, terrainShoreCover);
           float pebble = texture2D(uDirtMap, vTerrainWorld.xz * ${perM(1.325).toFixed(6)}).r;
           float stones = texture2D(uDirtMap, vTerrainWorld.xz * ${perM(0.525).toFixed(6)} + 0.4).g;
           vec3 gravelBed = vec3(0.34, 0.3, 0.22) * mix(0.62, 1.3, pebble) * mix(0.85, 1.12, stones);
           vec3 silt = vec3(0.18, 0.17, 0.12) * (0.85 + sandLuma);
           vec3 bedColour = mix(gravelBed, silt, smoothstep(${m(-0.8).toFixed(4)}, ${m(-4.8).toFixed(4)}, above));
           blended.rgb = mix(blended.rgb, bedColour, bed * 0.9);
           // Wet: darker from a little above the line down into the water.
           float wet = (1.0 - smoothstep(${m(-0.08).toFixed(4)}, ${m(0.56).toFixed(4)}, above)) * smoothstep(0.03, 0.35, terrainShoreCover);
           blended.rgb *= mix(1.0, 0.6, wet);
         }
         // (No hillshade, dryness by height or damp hollows painted into the
         // colour any more: the player asked for the terrain's lights and
         // effects to go. The scene's own light shapes the hills.)
         // Under the grass field the ground is the shade between the blades:
         // darker, so the blades stand in a lawn and not on a bright card.
         float grassDist = distance(vec2(vTerrainAtlas.x, -vTerrainAtlas.z), uGrassField.xy);
         float grassUnder = uGrassField.w * (1.0 - smoothstep(uGrassField.z * 0.45, uGrassField.z * 0.95, grassDist));
         blended.rgb *= mix(1.0, 0.8, grassUnder * (1.0 - clamp(dirtMix + rockMix, 0.0, 1.0)) * (1.0 - terrainIce));
         // Painted ground (world/terrainPaint.ts): a weight per layer, the
         // grass showing through what the weights leave.
         vec2 paintUv = vec2((vTerrainWorld.x + uPaintHalf) / uPaintSize, (uPaintHalf - vTerrainWorld.z) / uPaintSize);
         vec4 pa = texture(uPaint, vec3(paintUv, 0.0));
         vec4 pb = texture(uPaint, vec3(paintUv, 1.0));
         float painted = pa.r + pa.g + pa.b + pa.a + pb.r + pb.g + pb.b;
         if (painted > 0.002) {
           float grain = texture2D(uDirtMap, vTerrainWorld.xz * ${perM(0.275).toFixed(6)}).r;
           float speck = texture2D(uDirtMap, vTerrainWorld.xz * ${perM(1.325).toFixed(6)}).r;
           vec3 soilTex = dirtColor.rgb;
           vec3 sand = vec3(0.80, 0.70, 0.50) * mix(0.86, 1.1, grain) * mix(0.94, 1.04, speck);
           vec3 soil = soilTex * vec3(0.92, 0.78, 0.62) * mix(0.8, 1.08, grain);
           vec3 meadow = grassColor.rgb * vec3(0.95, 1.08, 0.62) * mix(0.75, 1.15, speck);
           vec3 snow = vec3(0.92, 0.94, 0.97) * mix(0.93, 1.0, grain);
           vec3 gravel = vec3(0.55, 0.54, 0.51) * mix(0.6, 1.25, speck) * mix(0.9, 1.05, grain);
           vec3 asphalt = vec3(0.17, 0.17, 0.19) * mix(0.85, 1.15, speck);
           vec3 concrete = vec3(0.66, 0.65, 0.62) * mix(0.9, 1.06, grain) * mix(0.96, 1.03, speck);
           float keep = clamp(1.0 - painted, 0.0, 1.0);
           vec3 layered = sand * pa.r + soil * pa.g + meadow * pa.b + snow * pa.a +
             gravel * pb.r + asphalt * pb.g + concrete * pb.b;
           blended.rgb = blended.rgb * keep + layered / max(1.0, painted);
         }
         diffuseColor *= blended;
         // The grid: a line a pixel wide at every cell, on the map only.
         if (uGrid.y > 0.0) {
           ${__PLANET__ ? `
           // On the planet: one grid for the sphere, the map about the
           // grid's origin (\`world/planet/charts.ts\` setGridOrigin, the one the
           // road tool snaps to): smooth everywhere, no cube edge or corner.
           vec2 g;
           float onMap = 1.0;
           {
             vec3 d = normalize(vTerrainDir);
             vec2 en = vec2(dot(d, GRID_E), dot(d, GRID_N));
             float across = length(en);
             float arc = atan(across, dot(d, GRID_C));
             g = (across > 1e-7 ? en * (arc * PLANET_R / across) : vec2(0.0)) / uGrid.x;
           }` : `
           vec2 g = vec2(vTerrainWorld.x, -vTerrainWorld.z) / uGrid.x;
           float onMap = step(abs(vTerrainWorld.x), uGrid.z) * step(abs(vTerrainWorld.z), uGrid.z);`}
           vec2 gw = fwidth(g);
           vec2 toLine = abs(fract(g - 0.5) - 0.5) / max(gw, vec2(1e-4));
           float line = 1.0 - min(min(toLine.x, toLine.y), 1.0);
           // Gone before its cells shrink under a few pixels: a grid finer than
           // the screen is only a pale wash over the land.
           line *= 1.0 - smoothstep(0.1, 0.25, max(gw.x, gw.y));
           // White over the land, dark over snow and sand: seen on any ground.
           float bright = smoothstep(0.45, 0.7, dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)));
           vec3 ink = mix(vec3(1.0), vec3(0.08, 0.1, 0.12), bright);
           diffuseColor.rgb = mix(diffuseColor.rgb, ink, line * uGrid.y * onMap * (1.0 + 1.5 * bright));
         }`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         // Light thrown back from the sunlit land, on the ROCK TEXTURE only
         // (weighted by how much of the pixel is rock): a cliff turned from
         // the sun sees the lit ground, and without it a basalt or granite
         // wall in shade was a black hole. The grass, the soil and the rims
         // are lit exactly as before.
         #if NUM_DIR_LIGHTS > 0
           reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.3, 0.28, 0.23) * rockMix * (1.0 - terrainIce) * (1.0 - clamp(dot(normal, normalize(directionalLights[0].direction)), 0.0, 1.0));
           // The ice's light through it (Barre-Brisebois and Bouchard, GDC 2011,
           // Frostbite's translucency): the sun seen through a thin face or a
           // crevasse's lip glows blue - the red absorbed on its long path in
           // dense ice (USGS) - and a little of it everywhere in the ice.
           ${`if (terrainIce > 0.0) {
             vec3 iceL = normalize(directionalLights[0].direction);
             vec3 iceH = normalize(iceL + normal * 0.35);
             float iceBack = pow(clamp(dot(normalize(vViewPosition), -iceH), 0.0, 1.0), 5.0) * 1.4;
             float iceDay = planetDaylight(geometryPosition, iceL);
             reflectedLight.directDiffuse += directionalLights[0].color * iceDay * (iceBack + 0.08)
               * mix(0.18, 1.0, terrainIceThin) * vec3(0.08, 0.4, 0.6) * terrainIce;
           }`}
         #endif
         // (The land's own baked light - the relief's shadow, the sky a hollow
         // sees, the dark creases - is not applied any more: the player asked
         // for the terrain's lights to go, 2026-10-08.)`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         // Snow is matt; the wind-glazed and the bare blue ice are smooth
         // enough to throw the sun back (blue-ice areas: smooth, rippled).
         roughnessFactor = mix(roughnessFactor, mix(0.74, 0.3, terrainIceGlaze), terrainIce);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 grassN = dualScaleNormal(normalMap, vTerrainWorld.xz * uGrassScale);
         // The rock's bumps, triplanar in world space like its colour, then
         // brought into the geometry's tangent frame so the two can be mixed.
         vec3 rockWorldN = triN;
         if (rockMix > 0.001) {
           vec3 acc = vec3(0.0);
           if (terrainRockMix.x > 0.01) acc += rockTriNormal(0.0, vTerrainWorld, triN, triW) * terrainRockMix.x;
           if (terrainRockMix.y > 0.01) acc += rockTriNormal(1.0, vTerrainWorld, triN, triW) * terrainRockMix.y;
           if (terrainRockMix.z > 0.01) acc += rockTriNormal(2.0, vTerrainWorld, triN, triW) * terrainRockMix.z;
           rockWorldN = normalize(acc + triN * 1e-4);
         }
         vec3 rockN = vec3(dot(rockWorldN, tbn[0]), dot(rockWorldN, tbn[1]), dot(rockWorldN, tbn[2]));
         // Softened: with height blending the rock's edge is crisp, and its
         // full relief turned every facet facing away from the sun into a
         // black blot.
         rockN = normalize(mix(rockN, vec3(0.0, 0.0, 1.0), 0.45));
         vec3 mapN = normalize(mix(grassN, rockN, rockMix));
         mapN.xy *= normalScale;
         if (terrainDetailW > 0.001) {
           vec3 bladeN = detailNormal(uGrassDetailN, vTerrainWorld.xz * uGrassDetailScale);
           vec3 soilN = detailNormal(uSoilDetailN, vTerrainWorld.xz * uSoilDetailScale);
           vec3 fineN = mix(bladeN, soilN, clamp(dirtMix + rockMix, 0.0, 1.0));
           mapN.xy += fineN.xy * 1.2 * terrainDetailW;
         }
         // Ice and snow have none of the grass's or the rock's bumps: their own (below).
         mapN = normalize(mix(mapN, vec3(0.0, 0.0, 1.0), terrainIce));
         normal = normalize(tbn * mapN);
         // (The fine relief's bumps are not added to the normal any more: the
         // player asked for the terrain's effects to go.)
         ${`
         // The ice's own bumps (crevasses, drifts), by the height's screen
         // derivatives - taken here, out of any branch.
         if (uPlanetTile < 0.0 || int(uPlanetTile) / ${TILES_PER_FACE} == 2 || int(uPlanetTile) / ${TILES_PER_FACE} == 5) {
           vec2 iceDH = vec2(dFdx(terrainIceBump), dFdy(terrainIceBump));
           vec3 iceSX = dFdx(-vViewPosition), iceSY = dFdy(-vViewPosition);
           if (terrainIce > 0.0) normal = normalize(mix(normal, icePerturbNormal(iceSX, iceSY, normal, iceDH, faceDirection), terrainIce));
         }`}`,
      );
  };
  // A changed program key forces three to compile this variant separately from
  // any other standard material in the scene.
  material.customProgramCacheKey = () => 'terrain-splat-v31';
  return material;
}

/** Metres along the rim one strata texture spans before it repeats. */
const STRATA_SPAN_X = m(128);
/** Metres of depth one strata texture spans before it repeats. */
const STRATA_SPAN_Y = m(104);
/** How far the map's cut sides reach below the base level (SimCity 4's slab). */
const SLAB_DEPTH = m(128);
/** The darker topsoil band under the rim, in metres. */
const TOPSOIL = m(1.6);

/**
 * The soil layers of the map's cut sides: horizontal bands of earth, clay and
 * stone, wavy rather than ruled, with a fine grain over them. Periodic noise,
 * so it tiles along the rim and down the wall with no seam.
 */
function strataTexture(anisotropy: number): DataTexture {
  // 1.25 m a texel over the 320 m the texture spans along a wall: finer than
  // the wall is ever seen, and four times cheaper at load than 512.
  const res = 256;
  const noise = makeNoise(4_177);
  const grit = makeNoise(0x77a1);
  // One repeat of the section, top to bottom: a THICKNESS (share of the
  // repeat) and an sRGB colour per bed. Real beds are anything but even - a
  // thick sandstone, a thin dark shale, a lens of gravel - and a repeat of
  // equal wavy bands read as striped paper.
  const beds: readonly (readonly [number, number, number, number, number])[] = [
    // thickness, r, g, b, texture (0 fine, 1 gravel)
    [0.16, 168, 134, 94, 0],
    [0.035, 92, 74, 60, 0],
    [0.09, 140, 102, 70, 0],
    [0.05, 150, 140, 124, 1],
    [0.21, 178, 146, 104, 0],
    [0.03, 104, 82, 64, 0],
    [0.12, 126, 90, 64, 0],
    [0.065, 160, 128, 92, 1],
    [0.2, 148, 112, 78, 0],
    [0.04, 98, 80, 66, 0],
  ];
  const total = beds.reduce((sum, bed) => sum + bed[0], 0);
  const data = new Uint8Array(res * res * 4);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const u = x / res;
      const v = y / res;
      // Nearly level, with a long gentle undulation, not a wave every metre.
      const sway = (fbm(noise, u * 3, v * 3, 3, 2) - 0.5) * 0.035;
      const t = (((v + sway) % 1) + 1) % 1;
      // Each bed pinches and swells along the cut on its own noise.
      let top = 0;
      let bed = beds.length - 1;
      let depthIn = 0;
      for (let i = 0; i < beds.length; i++) {
        const swell = 1 + (fbm(noise, u * 5 + i * 3, i * 7.3, 5, 2) - 0.5) * 0.9;
        const thick = (beds[i]![0] / total) * swell;
        if (t < top + thick || i === beds.length - 1) { bed = i; depthIn = (t - top) / Math.max(thick, 1e-4); break; }
        top += thick;
      }
      const [, r, g, b, kind] = beds[bed]!;
      const fine = 0.9 + 0.2 * fbm(grit, u * 128, v * 128, 128, 2);
      const pebble = kind === 1 ? (fbm(grit, u * 256 + 9, v * 256 + 4, 256, 1) > 0.62 ? 1.22 : 0.92) : 1;
      // Rain wash: faint vertical streaks down the face.
      let wash = 0;
      for (let k = 0; k < 3; k++) wash += fbm(grit, u * 90, v * 90 + k, 90, 1);
      wash = 0.94 + 0.12 * (wash / 3);
      // The top of each bed a touch darker, where the one above weathers into it.
      const seam = 0.9 + 0.1 * Math.min(1, depthIn * 6);
      const shade = fine * pebble * wash * seam;
      const i = (y * res + x) * 4;
      data[i] = Math.min(255, r * shade);
      data[i + 1] = Math.min(255, g * shade);
      data[i + 2] = Math.min(255, b * shade);
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, res, res, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * THE WORLD'S SLAB: the cut sides round a whole rectangle of land (the whole
 * flat Earth's, `flatAtlas.ts`), as a plate's own (`rebuildWalls`): from the
 * land's drawn height (`topAt`, world x, y, read every `step`) down past a
 * topsoil band to a flat bottom `SLAB_DEPTH` under the base level and
 * below the lowest of the rim - SimCity 4's slab, the map a block of land on
 * its bedrock. For `wallMaterial`.
 */
export function slabGeometry(minX: number, maxX: number, minY: number, maxY: number, step: number, topAt: (x: number, y: number) => number): BufferGeometry {
  // Each side from corner to corner (three's x, z: z = -y), with its outward normal.
  const sides: readonly (readonly [number, number, number, number, number, number])[] = [
    [minX, -maxY, maxX, -maxY, 0, -1],
    [maxX, -maxY, maxX, -minY, 1, 0],
    [maxX, -minY, minX, -minY, 0, 1],
    [minX, -minY, minX, -maxY, -1, 0],
  ];
  let lowest = Infinity;
  const tops = sides.map(([x0, z0, x1, z1]) => {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / step));
    const row = new Float64Array(n + 1);
    for (let k = 0; k <= n; k++) {
      const y = topAt(x0 + ((x1 - x0) * k) / n, -(z0 + ((z1 - z0) * k) / n));
      row[k] = y;
      if (y < lowest) lowest = y;
    }
    return row;
  });
  const floor = Math.min(TERRAIN_BASE - SLAB_DEPTH, lowest - m(16));
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], colours: number[] = [], below: number[] = [];
  let along = 0;
  sides.forEach(([x0, z0, x1, z1, nx, nz], s) => {
    const top = tops[s]!;
    const n = top.length - 1;
    const length = Math.hypot(x1 - x0, z1 - z0);
    const vertex = (k: number, y: number, shade: number): void => {
      positions.push(x0 + ((x1 - x0) * k) / n, y, z0 + ((z1 - z0) * k) / n);
      normals.push(nx, 0, nz);
      uvs.push((along + (length * k) / n) / STRATA_SPAN_X, y / STRATA_SPAN_Y);
      colours.push(shade, shade, shade);
      below.push(top[k]! - y);
    };
    for (let k = 0; k < n; k++) {
      const ya = top[k]!, yb = top[k + 1]!;
      const bands: readonly (readonly [number, number, number])[] = [[ya, yb, 1], [ya - TOPSOIL, yb - TOPSOIL, 1], [floor, floor, 0.42]];
      for (let b = 0; b + 1 < bands.length; b++) {
        const [ua, ub, sa] = bands[b]!;
        const [la, lb, sl] = bands[b + 1]!;
        const ax = x0 + ((x1 - x0) * k) / n, az = z0 + ((z1 - z0) * k) / n;
        const cx = x0 + ((x1 - x0) * (k + 1)) / n, cz = z0 + ((z1 - z0) * (k + 1)) / n;
        // Wound so the face points OUT (as `rebuildWalls`).
        const outward = (la - ua) * (cz - az) * nx - (la - ua) * (cx - ax) * nz;
        const quad: [number, number, number][] = [[k, ua, sa], [k, la, sl], [k + 1, ub, sa], [k + 1, lb, sl]];
        const order = outward > 0 ? [0, 1, 2, 2, 1, 3] : [0, 2, 1, 2, 3, 1];
        for (const o of order) vertex(...quad[o]!);
      }
    }
    along += length;
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
  geometry.setAttribute('aBelow', new Float32BufferAttribute(below, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The cut sides' material: the strata texture, and over it what a painted
 * cross-section shows at its top - a ragged lip of turf hanging over the
 * edge, a dark band of topsoil with roots under it - and at its bottom the
 * layers giving way to grey bedrock. Drawn from the metres under the rim
 * (`aBelow`), so the lip follows a hill as the rim does.
 */
export function wallMaterial(anisotropy: number): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    map: strataTexture(anisotropy),
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.1,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
         attribute float aBelow;
         varying float vBelow;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
         vBelow = aBelow;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
         varying float vBelow;
         float wallHash(float n) { return fract(sin(n) * 43758.5453); }
         // 1-D value noise along the rim, in metres.
         float wallNoise(float x) {
           float i = floor(x);
           float f = fract(x);
           return mix(wallHash(i), wallHash(i + 1.0), f * f * (3.0 - 2.0 * f));
         }
         // 2-D value noise over the wall (along, below), in metres.
         float wallNoise2(vec2 p) {
           // The lattice wrapped at 289 so sin() stays precise on the GPU.
           vec2 i = mod(floor(p), 289.0);
           vec2 j = mod(i + 1.0, 289.0);
           vec2 f = fract(p);
           vec2 u = f * f * (3.0 - 2.0 * f);
           return mix(mix(wallHash(dot(i, vec2(12.9898, 78.233))), wallHash(dot(vec2(j.x, i.y), vec2(12.9898, 78.233))), u.x),
                      mix(wallHash(dot(vec2(i.x, j.y), vec2(12.9898, 78.233))), wallHash(dot(j, vec2(12.9898, 78.233))), u.x), u.y);
         }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
         // Along the rim and down from it in steps of 0.4 m, the scale this
         // pattern was drawn at, so it keeps its size whatever the world unit.
         float along = vMapUv.x * ${(STRATA_SPAN_X / m(0.4)).toFixed(1)};
         float below = vBelow / ${m(0.4).toFixed(6)};
         // The turf lip: 2 to 4.8 m, ragged in tufts, thick enough to read at map zoom.
         float lip = 5.0 + 5.0 * wallNoise(along * 0.12) + 2.5 * wallNoise(along * 0.6 + 11.0);
         // The topsoil under it, darker and redder, with a wavy bottom.
         float soil = lip + 10.0 + 8.0 * wallNoise(along * 0.04 + 5.0);
         // The strata without their 128 m repeat (Quilez, "Texture
         // Repetition", technique 3), shifted ALONG the rim only so the beds
         // stay level: two reads at offsets a slow noise picks, the mips from
         // the unmoved coordinates. Read plainly, the same wavy beds came
         // round again and again down every side of the map.
         vec3 strata;
         {
           float idx = wallNoise(vMapUv.x * 3.0 + 17.0) * 8.0;
           float i0 = floor(idx);
           vec2 sdx = dFdx(vMapUv), sdy = dFdy(vMapUv);
           vec3 sa = textureGrad(map, vMapUv + vec2(wallHash(i0 * 7.13 + 1.0), 0.0), sdx, sdy).rgb;
           vec3 sb = textureGrad(map, vMapUv + vec2(wallHash(i0 * 7.13 + 8.13), 0.0), sdx, sdy).rgb;
           strata = mix(sa, sb, smoothstep(0.2, 0.8, idx - i0));
         }
         vec3 topsoil = vec3(0.2, 0.13, 0.085) * (0.85 + 0.3 * wallNoise(along * 2.3 + below * 1.7));
         // Roots: thin pale streaks hanging into the topsoil.
         float root = step(0.9, wallNoise(along * 0.9)) * smoothstep(soil, lip, below);
         topsoil = mix(topsoil, vec3(0.42, 0.33, 0.22), root * 0.6);
         vec3 turf = mix(vec3(0.24, 0.34, 0.13), vec3(0.15, 0.22, 0.09), smoothstep(0.0, lip, below));
         vec3 wall = mix(topsoil, strata, smoothstep(soil - 0.6, soil + 0.6, below));
         // The base of the section, as the player's reference draws it: under
         // the beds a band of FRACTURED ROCK - angular stones packed together,
         // each a different grey, faceted (lit on the side facing the sun),
         // thin dark cracks between them - and under that the dark BEDROCK,
         // foliated: long wavy streaks flowing along the cut. Both boundaries
         // wavy; the bedrock swells up into the broken rock in humps.
         float bedTop = 200.0 + 16.0 * wallNoise(along * 0.025) + 5.0 * wallNoise(along * 0.11 + 3.0);
         // The bed right above the rock is a pale pinkish tan, plain (the strata's
         // own beds there carried a thin pale gravel line the player disliked).
         vec3 paleBed = vec3(0.5, 0.33, 0.22) * (0.88 + 0.24 * wallNoise2(vec2(along, below) * 0.35));
         wall = mix(wall, paleBed, smoothstep(bedTop - 34.0, bedTop - 31.0, below + 6.0 * (wallNoise(along * 0.04 + 2.0) - 0.5)));
         float rockBase = bedTop + 62.0 + 30.0 * (wallNoise(along * 0.012 + 40.0) - 0.5) + 10.0 * (wallNoise(along * 0.05 + 9.0) - 0.5);
         // Fractured rock: Voronoi stones, 3x3 search, ~8 x 5.2 m each.
         vec2 cp = vec2(along / 20.0, below / 13.0);
         vec2 ci = floor(cp);
         vec2 cf = fract(cp);
         float f1 = 9.0;
         float f2 = 9.0;
         float stoneId = 0.0;
         vec2 toCentre = vec2(0.0);
         for (int j = -1; j <= 1; j++) {
           for (int i = -1; i <= 1; i++) {
             vec2 g = vec2(float(i), float(j));
             float id = dot(mod(ci + g, 289.0), vec2(12.9898, 78.233));
             vec2 r = g + 0.1 + 0.8 * vec2(wallHash(id), wallHash(id + 57.3)) - cf;
             float d = dot(r, r);
             if (d < f1) { f2 = f1; f1 = d; stoneId = id; toCentre = r; } else if (d < f2) { f2 = d; }
           }
         }
         float edge = sqrt(f2) - sqrt(f1);
         float cw = max(fwidth(edge), 1e-4);
         float crack = 1.0 - smoothstep(0.02, 0.02 + cw * 1.5, edge);
         // A facet: the stone's surface tilts away from its centre, so the
         // side facing the light (up-left) is brighter - an angular, chipped look.
         float facet = clamp(dot(normalize(-toCentre + 1e-4), normalize(vec2(-0.6, -0.8))), -1.0, 1.0) * smoothstep(0.0, 0.25, sqrt(f1));
         vec3 stone = mix(vec3(0.075, 0.075, 0.078), vec3(0.17, 0.165, 0.16), wallHash(stoneId + 9.1));
         stone *= 0.85 + 0.3 * wallNoise2(vec2(along, below) * 0.8);
         stone *= 1.0 + 0.35 * facet;
         stone = mix(stone, vec3(0.02, 0.02, 0.022), crack * 0.85);
         // Filtered over the pixel: as a pixel covers whole stones, their mean.
         float stoneW = max(fwidth(cp.x), fwidth(cp.y));
         stone = mix(stone, vec3(0.09, 0.09, 0.092), smoothstep(0.35, 1.0, stoneW));
         // Bedrock: near-black, streaked along the cut by warped noise.
         float warp = 18.0 * wallNoise2(vec2(along * 0.01, below * 0.01) + 3.0) + 8.0 * wallNoise2(vec2(along * 0.035, below * 0.03) + 11.0);
         float streak = wallNoise2(vec2(along * 0.015, (below + warp) * 0.22));
         float streak2 = wallNoise2(vec2(along * 0.04, (below + warp * 1.3) * 0.6) + 21.0);
         vec3 bedrock = mix(vec3(0.016, 0.017, 0.021), vec3(0.085, 0.088, 0.1), smoothstep(0.3, 0.9, streak) * 0.75 + streak2 * 0.25);
         float br = smoothstep(rockBase - 1.0, rockBase + 1.0, below);
         vec3 rock = mix(stone, bedrock, br);
         wall = mix(wall, rock, smoothstep(bedTop - 0.8, bedTop + 0.8, below));
         wall = mix(wall, turf, 1.0 - smoothstep(lip - 0.6, lip + 0.6, below));
         diffuseColor.rgb = wall;`);
  };
  material.customProgramCacheKey = () => 'terrain-walls-v7';
  return material;
}

/**
 * `origin`: where the plate's centre stands in the world - the origin on the
 * flat map, a face's centre in the planet's atlas (`render/planet/terrainAtlas.ts`).
 * Every coordinate the surface is given or returns is the plate's own, about
 * its centre; only its meshes are moved there.
 */
/**
 * `tile`: the planet's piece the plate is (its shader reads it), -1 off the
 * planet. `plate`: the plate's key among many plates side by side (the
 * planet's pieces, the whole flat Earth's plates, `flatAtlas.ts`), -1 when it
 * is the only one: a plate among many has no rim (its neighbours meet it) and
 * shares the few light and ecology workers, keyed by it. `prebuilt`: the
 * plate's first build worked out off the page (`plateMesh.ts`), copied in by
 * the first `update` when no stamp reaches it.
 */
export function createTerrainSurface(anisotropy: number, origin: { readonly x: number; readonly y: number } = { x: 0, y: 0 }, tile = -1, plate = tile, prebuilt: PlateMesh | null = null): TerrainSurface {
  const bakes = terrainBakes(anisotropy);
  const material = terrainMaterial(bakes, anisotropy);

  const geometry = new PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  const ground = new Mesh(geometry, material);
  ground.name = 'terrain-ground';
  ground.receiveShadow = true;
  // The ground does NOT cast.
  //
  // It is a single 301x301 heightfield - 180 000 triangles - and casting meant
  // rasterising every one of them a second time into the shadow map each
  // frame. What that bought was self-shadowing across one wide cascade whose
  // texels are around a world unit across at play zoom, which does not resolve
  // a hillside; what it actually produced was acne, the irregular dark
  // diagonal banding on open grass that has nothing casting it. Roads,
  // structures, props and agents all still cast onto the ground, which is
  // every shadow the player is actually looking at.
  ground.castShadow = false;
  ground.matrixAutoUpdate = false;
  ground.position.set(origin.x, 0, -origin.y);
  ground.updateMatrix();

  // A planet piece (`tile` set) meets its neighbours' ground: it has no rim, so
  // neither the land beyond it nor its cut sides are built (on 96 pieces they
  // were over a second of the boot and 70 MB, all hidden).
  const rim = plate < 0;
  /** The woods' base made off the page with the first build (`woodsBase`), while it holds. */
  let woods: Float32Array | null = null;

  // Land beyond the editable plate, so the map does not end in mid-air.
  //
  // It is a FRAME, not a plane. A plane under the plate is the wrong shape: the
  // plate's own ground dips below it wherever the base relief goes negative, and
  // the plane then draws straight over the terrain, the roads and everything on
  // them — which is exactly how a full plane hid most of the road network behind
  // a grey sheet. A frame occupies only the ground the plate does not.
  //
  // Its INNER ring is stitched to the plate's own rim (see `rebuildFrame`): a
  // constant-height frame was fine while the land could only move ten metres
  // either way, and became a straight slice through mountains and pits the
  // moment the brush could make them.
  const backdrop = new Mesh(
    new BufferGeometry(),
    new MeshStandardMaterial({ color: new Color(0x53694a), roughness: 1, metalness: 0 }),
  );
  backdrop.name = 'terrain-backdrop';
  backdrop.receiveShadow = false;
  backdrop.matrixAutoUpdate = false;
  backdrop.position.set(origin.x, 0, -origin.y);
  backdrop.updateMatrix();

  // The map's cut sides, SimCity 4's slab: from the rim straight down to a flat
  // bottom, in soil layers, so the plate reads as a block of land standing on
  // the plain background rather than a sheet ending in mid-air. In play the
  // backdrop is drawn over the rim and hides them.
  const walls = new Mesh(
    new BufferGeometry(),
    // Without a rim nothing draws them: the strata texture is not baked.
    rim ? wallMaterial(anisotropy) : new MeshStandardMaterial(),
  );
  walls.name = 'terrain-walls';
  walls.receiveShadow = false;
  walls.castShadow = false;
  walls.matrixAutoUpdate = false;
  walls.position.set(origin.x, 0, -origin.y);
  walls.updateMatrix();

  const waterSurface = createWaterSurface(anisotropy);
  const water = new Mesh(new BufferGeometry(), waterSurface.material);
  water.name = 'terrain-water';
  water.receiveShadow = false;
  water.castShadow = false;
  water.matrixAutoUpdate = false;
  water.position.set(origin.x, 0, -origin.y);
  water.updateMatrix();
  // The river animates itself from here on: nothing in the draw loop has to
  // know that the terrain owns something with a clock in it.
  waterSurface.attach(water);
  // Hidden while it holds no water (`rebuildWater` shows it): three binds a
  // mesh's program and every texture of its material before it finds the
  // geometry empty (r186 `renderBufferDirect`), and on the planet the 864
  // pieces' empty water sheets were some 500 such binds a frame at the globe.
  water.visible = false;

  let index = new TerrainIndex([], 0);
  let revision = -1;

  /** The land the player sculpted, with no road in it. */
  const naturalHeightAt = (x: number, y: number): number =>
    TERRAIN_BASE + sampleTerrainHeight(index, x, y);

  // The heights the mesh actually carries, one per grid corner, so
  // `renderedHeightAt` interpolates exactly the numbers that are on screen.
  const grid = new Float64Array(GRID * GRID);
  /** The fine relief the light reads, baked from `grid` (`terrainRelief.ts`). */
  const relief = createReliefBake(GRID, TERRAIN_CELL, TERRAIN_HALF, material.userData['macro'] as Texture);
  {
    // The ground reads its own bake, and its grids from where it stands.
    const own = material.userData['terrainUniforms'] as { uRelief: { value: Texture }; uReliefWindow: { value: Vector4 }; uTileOrigin: { value: Vector3 }; uPlanetTile: { value: number } };
    own.uPlanetTile.value = tile;
    own.uRelief = relief.texture;
    own.uReliefWindow = relief.window;
    own.uTileOrigin.value.set(origin.x, 0, -origin.y);
  }
  /** The same corners before any road shaped them, so shaping is idempotent. */
  const natural = new Float64Array(GRID * GRID);
  /**
   * Corners a road has moved (1), so an unshaped one can be restored cheaply:
   * a mark per corner, read over a region's own corners - a list of them all
   * was walked whole for every quarter block of every road edit.
   */
  const shapedCorners = new Uint8Array(GRID * GRID);
  const spherePoint = new Vector3();
  /** The cells the last `update` rewrote (see `lastRegion`). */
  let lastRegion: TerrainRegion | null = null;
  /** The water waits for the end of a stroke (see `settle`). */
  let waterStale = false;
  /**
   * Where the land moved while the water waited, corners (`'all'`: anywhere,
   * or a river dab): `settle` rebuilds the water only when this reaches it
   * (a dirty region, Unity's `DirtyHeightmapRegion`; Nystrom's "Dirty Flag",
   * fine-grained). Every stroke anywhere rebuilt every pool and river of the
   * map, some 100 ms at its end.
   */
  let waterDirty: TerrainRegion | 'all' | null = null;
  const markWaterDirty = (box: TerrainRegion | null): void => {
    if (box === null || waterDirty === 'all') { waterDirty = 'all'; return; }
    waterDirty = waterDirty === null ? box : [
      Math.min(waterDirty[0], box[0]), Math.max(waterDirty[1], box[1]),
      Math.min(waterDirty[2], box[2]), Math.max(waterDirty[3], box[3]),
    ];
  };
  let lastStamps: readonly TerrainStamp[] = [];

  const heightAt = naturalHeightAt;

  // The drawn corners again, for the water to measure its depth per pixel
  // (`WaterSurface.setGround`). Refreshed with the water.
  const groundTexture = new DataTexture(new Float32Array(GRID * GRID), GRID, GRID, RedFormat, FloatType);
  groundTexture.magFilter = NearestFilter;
  groundTexture.minFilter = NearestFilter;
  groundTexture.generateMipmaps = false;
  waterSurface.setGround(groundTexture, TERRAIN_HALF, TERRAIN_CELL, GRID, origin);

  /**
   * Which diagonal each cell is drawn with: 0 the plane's own (b-d), 1 the
   * other (a-c). Chosen per cell as the one with the smaller rise along it - a
   * data-dependent triangulation (Garland & Heckbert): the triangles' edges
   * then follow the contour, and a cliff running across the grid's fixed
   * diagonal no longer breaks into a zigzag of teeth.
   */
  const flip = new Uint8Array(TERRAIN_SEGMENTS * TERRAIN_SEGMENTS);
  /**
   * The diagonals the land would be drawn with before any road shaped it, by
   * the same rule on the natural corners: the natural ground
   * (`naturalRenderedHeightAt`) the roads' heights are solved against must
   * not move when the roads shape the drawn one. Read through `flip`, every
   * cell a road had shaped changed it by millimetres to centimetres, every
   * road was solved anew on the next edit, and the whole map was cut, filled
   * and paved again (the player, 2026-10-08).
   */
  const naturalFlip = new Uint8Array(TERRAIN_SEGMENTS * TERRAIN_SEGMENTS);
  /** The cells round a box of corners (inclusive) and the diagonal `corners` gives each. */
  const chooseDiagonals = (corners: Float64Array, into: Uint8Array, x0: number, x1: number, y0: number, y1: number): void => {
    const cx0 = Math.max(0, x0 - 1), cx1 = Math.min(TERRAIN_SEGMENTS - 1, x1);
    const cy0 = Math.max(0, y0 - 1), cy1 = Math.min(TERRAIN_SEGMENTS - 1, y1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const a = cx + GRID * cy, b = cx + GRID * (cy + 1), c = cx + 1 + GRID * (cy + 1), d = cx + 1 + GRID * cy;
        // A margin, so near-flat cells keep the plane's diagonal.
        into[cx + cy * TERRAIN_SEGMENTS] = Math.abs((corners[a] as number) - (corners[c] as number)) + 0.5 < Math.abs((corners[b] as number) - (corners[d] as number)) ? 1 : 0;
      }
    }
  };
  const triangles = geometry.index!;
  /** Re-chooses the diagonals of the cells round a box of corners (inclusive). */
  const retriangulate = (x0: number, x1: number, y0: number, y1: number): void => {
    const cx0 = Math.max(0, x0 - 1), cx1 = Math.min(TERRAIN_SEGMENTS - 1, x1);
    const cy0 = Math.max(0, y0 - 1), cy1 = Math.min(TERRAIN_SEGMENTS - 1, y1);
    const index = triangles.array as Uint32Array | Uint16Array;
    chooseDiagonals(grid, flip, x0, x1, y0, y1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const a = cx + GRID * cy, b = cx + GRID * (cy + 1), c = cx + 1 + GRID * (cy + 1), d = cx + 1 + GRID * cy;
        const k = cx + cy * TERRAIN_SEGMENTS;
        const flipped = flip[k];
        const o = k * 6;
        if (flipped) {
          index[o] = a; index[o + 1] = b; index[o + 2] = c;
          index[o + 3] = a; index[o + 4] = c; index[o + 5] = d;
        } else {
          index[o] = a; index[o + 1] = b; index[o + 2] = d;
          index[o + 3] = b; index[o + 4] = c; index[o + 5] = d;
        }
      }
    }
    triangles.needsUpdate = true;
  };

  /** Bilinear read of one corner array, reproducing the plane's own diagonal. */
  const sampleGrid = (corners: Float64Array, diagonals: Uint8Array, x: number, y: number): number => {
    if (!(x >= -TERRAIN_HALF && x <= TERRAIN_HALF && y >= -TERRAIN_HALF && y <= TERRAIN_HALF)) {
      return naturalHeightAt(x, y);
    }
    // `PlaneGeometry` lays its rows from +y downwards, so the row index grows as
    // world y falls.
    const gx = (x + TERRAIN_HALF) / TERRAIN_CELL;
    const gy = (TERRAIN_HALF - y) / TERRAIN_CELL;
    const ix = Math.min(TERRAIN_SEGMENTS - 1, Math.floor(gx));
    const iy = Math.min(TERRAIN_SEGMENTS - 1, Math.floor(gy));
    const u = gx - ix;
    const v = gy - iy;
    const a = corners[ix + iy * GRID] as number;
    const b = corners[ix + (iy + 1) * GRID] as number;
    const c = corners[ix + 1 + (iy + 1) * GRID] as number;
    const d = corners[ix + 1 + iy * GRID] as number;
    // Each cell is split along the diagonal it is DRAWN with (`retriangulate`):
    // b-d into (a, b, d) and (b, c, d), or a-c into (a, d, c) and (a, b, c).
    if (diagonals[ix + iy * TERRAIN_SEGMENTS]) {
      return u >= v ? a * (1 - u) + d * (u - v) + c * v : a * (1 - v) + b * (v - u) + c * u;
    }
    return u + v <= 1 ? a * (1 - u - v) + d * u + b * v : b * (1 - u) + c * (u + v - 1) + d * (1 - v);
  };

  const renderedHeightAt = (x: number, y: number): number => sampleGrid(grid, flip, x, y);
  const naturalRenderedHeightAt = (x: number, y: number): number => sampleGrid(natural, naturalFlip, x, y);

  /**
   * Stitches the land outside the plate to the plate's own rim.
   *
   * The inner ring IS the rim: one vertex per plate cell, at the height the
   * triangles are drawn at (`grid`), so the seam is watertight whatever the
   * player sculpts — a mountain cut off by the map's edge, a pit at the
   * corner. From there the ground steps down to the distant level over two
   * wide rings, so a hillside at the edge reads as land falling away.
   *
   * It used to be one flat sheet at a fixed height, which was honest while
   * the brush could only move the ground ten metres; the moment it could
   * build a mountain, the sheet sliced through it.
   *
   * Rebuilt whenever the rim moves — a terrain edit or a road shaping the
   * ground near the edge — and it is 2 400 vertices, so that is a fraction of
   * a frame, not a budget.
   */
  const FRAME_STEP_OUT = m(280);
  const FRAME_FAR = m(5_200);
  const DISTANT_LEVEL = TERRAIN_BASE - m(1.4);
  const rebuildFrame = (): void => {
    if (!rim) return;
    const half = TERRAIN_HALF;
    const perSide = TERRAIN_SEGMENTS;
    const count = perSide * 4;
    /** Ring vertices, one per cell per side, anticlockwise in local x/z. */
    const ring = (h: number): { x: number; z: number }[] => {
      const out: { x: number; z: number }[] = [];
      for (let s = 0; s < 4; s++) {
        for (let k = 0; k < perSide; k++) {
          const t = -h + (2 * h * k) / perSide;
          if (s === 0) out.push({ x: t, z: -h });
          else if (s === 1) out.push({ x: h, z: t });
          else if (s === 2) out.push({ x: -t, z: h });
          else out.push({ x: -h, z: -t });
        }
      }
      return out;
    };
    const inner = ring(half);
    // The rim's own heights, and the level the land outside continues at.
    let sum = 0;
    const rimHeight = inner.map((p) => {
      const value = sampleGrid(grid, flip, p.x, -p.z);
      sum += value;
      return value;
    });
    const mean = sum / count;
    const levels = [null, FRAME_STEP_OUT, FRAME_STEP_OUT * 2, FRAME_FAR];
    const rings = [inner, ring(half + levels[1]!), ring(half + levels[2]!), ring(half + levels[3]!)];
    const heightOf = (r: number, k: number): number => {
      if (r === 0) return rimHeight[k] as number;
      if (r === 1) return mean;
      if (r === 2) return (mean + DISTANT_LEVEL) / 2;
      return DISTANT_LEVEL;
    };
    const positions: number[] = [];
    /** Wound so the face points UP, measured rather than assumed. */
    const pushQuad = (a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): void => {
      const area = (p: readonly number[], q: readonly number[], r: readonly number[]): number =>
        (q[0]! - p[0]!) * (r[2]! - p[2]!) - (r[0]! - p[0]!) * (q[2]! - p[2]!);
      const forward = area(a, b, c) < 0;
      if (forward) positions.push(...a, ...b, ...c, ...a, ...c, ...d);
      else positions.push(...a, ...d, ...c, ...a, ...c, ...b);
    };
    const at = (r: number, k: number): number[] => {
      const point = rings[r]![k % count] as { x: number; z: number };
      return [point.x, heightOf(r, k % count), point.z];
    };
    for (let r = 0; r + 1 < rings.length; r++) {
      for (let k = 0; k < count; k++) pushQuad(at(r, k), at(r, k + 1), at(r + 1, k + 1), at(r + 1, k));
    }
    const next = new BufferGeometry();
    next.setAttribute('position', new Float32BufferAttribute(positions, 3));
    // Lit as level ground, every face alike: its faces are long thin slivers
    // from the rim outwards, and each lit by its own slope they drew dark
    // streaks fanning out from the map.
    const up = new Float32Array(positions.length);
    for (let k = 1; k < up.length; k += 3) up[k] = 1;
    next.setAttribute('normal', new Float32BufferAttribute(up, 3));
    next.computeBoundingSphere();
    const previous = backdrop.geometry;
    backdrop.geometry = next;
    previous.dispose();
    rebuildWalls();
  };

  /**
   * The cut sides, sewn to the same rim: per side one column per plate cell,
   * from the rim's drawn height down past a topsoil band to a flat bottom
   * below the lowest point of the rim. The layers are laid by ABSOLUTE height,
   * so they run level under a hill as real strata do.
   */
  const rebuildWalls = (): void => {
    const h = TERRAIN_HALF;
    const n = TERRAIN_SEGMENTS;
    // Each side from corner to corner, with its outward normal (local x/z).
    const sides: readonly (readonly [number, number, number, number, number, number])[] = [
      [-h, -h, h, -h, 0, -1],
      [h, -h, h, h, 1, 0],
      [h, h, -h, h, 0, 1],
      [-h, h, -h, -h, -1, 0],
    ];
    let lowest = Infinity;
    const tops = sides.map(([x0, z0, x1, z1]) => {
      const row: number[] = [];
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const z = z0 + ((z1 - z0) * k) / n;
        const y = sampleGrid(grid, flip, x, -z);
        row.push(y);
        lowest = Math.min(lowest, y);
      }
      return row;
    });
    const floor = Math.min(TERRAIN_BASE - SLAB_DEPTH, lowest - m(16));
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colours: number[] = [];
    /** Metres under the rim, for the shader's grass lip and topsoil (`wallMaterial`). */
    const below: number[] = [];
    // Row shades: full under the rim (the shader draws the lip), shaded to the bottom.
    const LIP = 1;
    const BODY = 1;
    const BOTTOM = 0.42;
    sides.forEach(([x0, z0, x1, z1, nx, nz], s) => {
      const top = tops[s]!;
      const length = Math.hypot(x1 - x0, z1 - z0);
      const vertex = (k: number, y: number, shade: number): void => {
        const x = x0 + ((x1 - x0) * k) / n;
        const z = z0 + ((z1 - z0) * k) / n;
        positions.push(x, y, z);
        normals.push(nx, 0, nz);
        uvs.push(((s * length + (length * k) / n) / STRATA_SPAN_X), y / STRATA_SPAN_Y);
        colours.push(shade, shade, shade);
        below.push(top[k]! - y);
      };
      for (let k = 0; k < n; k++) {
        const ya = top[k]!;
        const yb = top[k + 1]!;
        const bands: readonly (readonly [number, number, number, number])[] = [
          [ya, yb, LIP, LIP],
          [ya - TOPSOIL, yb - TOPSOIL, BODY, BODY],
          [floor, floor, BOTTOM, BOTTOM],
        ];
        for (let b = 0; b + 1 < bands.length; b++) {
          const [ua, ub, sa] = bands[b]!;
          const [la, lb, sl] = bands[b + 1]!;
          // Wound so the face points OUT, measured rather than assumed:
          // (b - a) x (c - a) for a = upper k, b = lower k, c = upper k+1.
          const ax = x0 + ((x1 - x0) * k) / n;
          const az = z0 + ((z1 - z0) * k) / n;
          const cx = x0 + ((x1 - x0) * (k + 1)) / n;
          const cz = z0 + ((z1 - z0) * (k + 1)) / n;
          // b - a = (0, la - ua, 0); c - a = (cx - ax, ., cz - az).
          const outward = (la - ua) * (cz - az) * nx - (la - ua) * (cx - ax) * nz;
          const quad: [number, number, number][] = [[k, ua, sa], [k, la, sl], [k + 1, ub, sa], [k + 1, lb, sl]];
          const order = outward > 0 ? [0, 1, 2, 2, 1, 3] : [0, 2, 1, 2, 3, 1];
          for (const o of order) vertex(...quad[o]!);
        }
      }
    });
    const next = new BufferGeometry();
    next.setAttribute('position', new Float32BufferAttribute(positions, 3));
    next.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    next.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    next.setAttribute('color', new Float32BufferAttribute(colours, 3));
    next.setAttribute('aBelow', new Float32BufferAttribute(below, 1));
    next.computeBoundingSphere();
    const previous = walls.geometry;
    walls.geometry = next;
    previous.dispose();
  };
  rebuildFrame();

  const position = geometry.getAttribute('position');

  const rewrite = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const i = iy * GRID + ix;
        const x = position.getX(i);
        const worldY = -position.getZ(i);
        const height = naturalHeightAt(x, worldY);
        position.setY(i, height);
        grid[i] = height;
        natural[i] = height;
      }
    }
    chooseDiagonals(natural, naturalFlip, x0, x1, y0, y1);
  };

  /**
   * Pulls the ground towards the roads, and carries the difference away over a
   * batter wide enough to read as an embankment rather than as a wall.
   *
   * This is the answer to the oldest complaint about this renderer: a road laid
   * across rolling ground has to sit at ONE height across its full width, so
   * where the ground falls away there is a difference to absorb. Absorbing it in
   * the road's own skirt draws a vertical face — the "wall" — and absorbing it
   * nowhere leaves the road hanging. Absorbing it in the TERRAIN is what a road
   * actually does to a landscape, and it is the only version that looks built.
   *
   * It is also, with no extra code, how tunnels work: `shapeAt` fades its own
   * weight out where the road is buried deeply, so the ground closes over the
   * bore and stays open at the portals.
   */
  /** Corners visited by the current shaping pass, by stamp, so boxes that overlap visit each once. */
  const visited = new Int32Array(GRID * GRID);
  let pass = 0;

  /** The corners the last shaping pass moved (`touchesWater`). */
  let lastChanged: readonly number[] = [];
  const shapeToRoads = (shape: TerrainShaper | null, region: TerrainRegion | readonly TerrainRegion[] | null = null): boolean => {
    const regions: readonly TerrainRegion[] | null = region === null ? null
      : typeof region[0] === 'number' ? [region as TerrainRegion] : region as readonly TerrainRegion[];
    // The corners whose height this pass changes, whichever way.
    const changed: number[] = [];
    // Restore whatever the last shaping moved, so this is a pure function of
    // the current network rather than an accumulation over every edit. With a
    // region (a brush dab while the stroke is held) only the corners in it
    // are shaped again: every other one keeps its cut and fill. The whole
    // plate was re-shaped on every dab - every road and every building pad of
    // the town, sixty-odd times a stroke.
    const before = new Map<number, number>();
    const restore = (i: number): void => {
      if (!shapedCorners[i]) return;
      shapedCorners[i] = 0;
      before.set(i, grid[i] as number);
      grid[i] = natural[i] as number;
    };
    if (!regions) for (let i = 0; i < shapedCorners.length; i++) restore(i);
    else for (const r of regions) {
      for (let iy = Math.max(0, r[2]); iy <= Math.min(GRID - 1, r[3]); iy++) {
        for (let ix = Math.max(0, r[0]); ix <= Math.min(GRID - 1, r[1]); ix++) restore(ix + iy * GRID);
      }
    }
    const fresh: number[] = [];

    if (shape) {
      // Only the corners some road could shape: everywhere else `shapeAt`
      // answers weight 0, and asking all 90 601 of them was most of the pass.
      pass++;
      for (const box of shape.shapeBounds()) {
        const bx0 = Math.max(0, Math.floor((box.minX + TERRAIN_HALF) / TERRAIN_CELL));
        const bx1 = Math.min(GRID - 1, Math.ceil((box.maxX + TERRAIN_HALF) / TERRAIN_CELL));
        const by0 = Math.max(0, Math.floor((TERRAIN_HALF - box.maxY) / TERRAIN_CELL));
        const by1 = Math.min(GRID - 1, Math.ceil((TERRAIN_HALF - box.minY) / TERRAIN_CELL));
        for (const r of regions ?? [null]) {
          const x0 = r ? Math.max(bx0, r[0]) : bx0, x1 = r ? Math.min(bx1, r[1]) : bx1;
          const y0 = r ? Math.max(by0, r[2]) : by0, y1 = r ? Math.min(by1, r[3]) : by1;
          for (let iy = y0; iy <= y1; iy++) {
            for (let ix = x0; ix <= x1; ix++) {
              const i = ix + iy * GRID;
              if (visited[i] === pass) continue;
              visited[i] = pass;
              const x = position.getX(i);
              const worldY = -position.getZ(i);
              const ground = natural[i] as number;
              const { height, weight } = shape.shapeAt(x, worldY, ground);
              if (weight <= 0.001) continue;
              const blended = ground + (height - ground) * weight;
              if (Math.abs(blended - ground) < 0.002) continue;
              grid[i] = blended;
              shapedCorners[i] = 1;
              fresh.push(i);
            }
          }
        }
      }
    }

    for (const i of fresh) {
      const was = before.get(i) ?? (natural[i] as number);
      if (grid[i] !== was) changed.push(i);
      before.delete(i);
    }
    for (const [i, was] of before) if (grid[i] !== was) changed.push(i);
    if (changed.length === 0) return false;
    for (const i of changed) position.setY(i, grid[i] as number);
    position.needsUpdate = true;
    {
      let x0 = GRID, x1 = -1, y0 = GRID, y1 = -1;
      for (const i of changed) {
        const ix = i % GRID, iy = (i - ix) / GRID;
        if (ix < x0) x0 = ix; if (ix > x1) x1 = ix; if (iy < y0) y0 = iy; if (iy > y1) y1 = iy;
      }
      retriangulate(x0, x1 + 1, y0, y1 + 1);
      // The land's light is worked out again round these corners only (`setSun`).
      markLand({ x0, x1, y0, y1 });
    }
    refreshNormals(changed);
    // The bounds grown over the corners that moved (`Sphere.expandByPoint`
    // keeps everything it held): worked out again over all 90 601 corners it
    // was 0.8 ms for each of the hundred-odd quarter blocks of a road edit.
    if (geometry.boundingSphere) for (const i of changed) geometry.boundingSphere.expandByPoint(spherePoint.fromBufferAttribute(position, i));
    else geometry.computeBoundingSphere();
    for (const i of changed) if (onRim(i)) { rebuildFrame(); break; }
    lastChanged = changed;
    return true;
  };

  /** Whether a grid corner is on the plate's rim, which the backdrop is sewn to. */
  const onRim = (i: number): boolean => {
    const ix = i % GRID;
    const iy = (i - ix) / GRID;
    return ix === 0 || iy === 0 || ix === GRID - 1 || iy === GRID - 1;
  };

  const normal = geometry.getAttribute('normal');
  const pa = new Vector3();
  const pb = new Vector3();
  const pc = new Vector3();
  const cb = new Vector3();
  const ab = new Vector3();
  const sum = new Vector3();
  /**
   * The steepest face round each corner, in degrees: what the shader calls a
   * WALL. A cliff a cell or two wide shares its corners with the flat above
   * and below it, so its smooth normals called it a bank and drew turf on it,
   * and its drawn faces alone alternate steep and gentle along the grid's
   * diagonals (rock in teeth). Read per corner, both triangles of a wall cell
   * are steep, and the rock frays one cell onto the rim as a cliff edge does.
   */
  // Written through the attribute's own array: Float32BufferAttribute copies
  // the array it is given.
  const steepAttribute = new Float32BufferAttribute(new Float32Array(GRID * GRID), 1);
  const steep = steepAttribute.array as Float32Array;
  geometry.setAttribute('aSteep', steepAttribute);
  let faceSteep = 0;
  /** Adds one face's area-weighted normal, as `computeVertexNormals` forms it. */
  const addFace = (a: number, b: number, c: number): void => {
    pa.fromBufferAttribute(position, a);
    pb.fromBufferAttribute(position, b);
    pc.fromBufferAttribute(position, c);
    cb.subVectors(pc, pb);
    ab.subVectors(pa, pb);
    cb.cross(ab);
    sum.add(cb);
    const length = cb.length();
    if (length > 1e-9) faceSteep = Math.max(faceSteep, Math.acos(Math.min(1, Math.abs(cb.y) / length)) * (180 / Math.PI));
  };
  /** Every corner's steepest face, over the whole plate (`terrainSteep.ts`). */
  const cellSteep = new Float32Array(TERRAIN_SEGMENTS * TERRAIN_SEGMENTS);
  const refreshAllSteep = (): void => {
    steepnessInto(position.array as ArrayLike<number>, flip, GRID, cellSteep, steep);
    steepAttribute.needsUpdate = true;
  };
  /**
   * Recomputes the normals round the corners that moved: the corners
   * themselves and every corner sharing a face with one, which is all a moved
   * corner can tilt. The whole plate's `computeVertexNormals` was the other
   * large share of every road edit.
   */
  const refreshNormals = (moved: readonly number[]): void => {
    const touched = new Set<number>();
    for (const i of moved) {
      const ix = i % GRID;
      const iy = (i - ix) / GRID;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = ix + dx;
          const y = iy + dy;
          if (x >= 0 && y >= 0 && x < GRID && y < GRID) touched.add(x + y * GRID);
        }
      }
    }
    for (const v of touched) {
      sum.set(0, 0, 0);
      faceSteep = 0;
      const ix = v % GRID;
      const iy = (v - ix) / GRID;
      // The cells round the corner, split as `PlaneGeometry` splits them:
      // (a, b, d) and (b, c, d).
      for (let cy = iy - 1; cy <= iy; cy++) {
        for (let cx = ix - 1; cx <= ix; cx++) {
          if (cx < 0 || cy < 0 || cx >= TERRAIN_SEGMENTS || cy >= TERRAIN_SEGMENTS) continue;
          const a = cx + GRID * cy;
          const b = cx + GRID * (cy + 1);
          const c = cx + 1 + GRID * (cy + 1);
          const d = cx + 1 + GRID * cy;
          if (flip[cx + cy * TERRAIN_SEGMENTS]) {
            if (v === a || v === b || v === c) addFace(a, b, c);
            if (v === a || v === c || v === d) addFace(a, c, d);
          } else {
            if (v === a || v === b || v === d) addFace(a, b, d);
            if (v === b || v === c || v === d) addFace(b, c, d);
          }
        }
      }
      sum.normalize();
      normal.setXYZ(v, sum.x, sum.y, sum.z);
      steep[v] = faceSteep;
    }
    normal.needsUpdate = true;
    steepAttribute.needsUpdate = true;
  };

  let wetDiscs: readonly WaterStamp[] = [];
  /** Where the water's mesh lies, world units (`touchesWater`). */
  let waterBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  let waterRevision = 0;
  /** The cells water flooded into past the brush (`floodBasins`), with their level. */
  let floodCells = new Map<string, number>();
  const wetAt = (x: number, y: number): boolean => {
    if (floodCells.size) {
      const level = floodCells.get(`${Math.round(x / WATER_CELL)}:${Math.round(y / WATER_CELL)}`);
      if (level !== undefined && renderedHeightAt(x, y) < level + 0.6) return true;
    }
    for (const disc of wetDiscs) {
      const reach = disc.radius * WATER_SPREAD;
      if (Math.abs(x - disc.x) > reach || Math.abs(y - disc.y) > reach) continue;
      if (Math.hypot(x - disc.x, y - disc.y) > reach) continue;
      // A margin, so nothing stands with its root on the waterline.
      if (renderedHeightAt(x, y) < disc.level + 0.6) return true;
    }
    return false;
  };

  // ---- the ecosystem (world/ecology.ts)
  const ecologyTexture = material.userData['ecology'] as DataTexture;
  /** The biomes painted per corner, `REGIONS.length` weights a corner (`rasterBiome`). */
  const biomeCorners = new Float32Array(GRID * GRID * REGIONS.length);
  let biomePainted = false;
  let nature: NatureSettings | null = null;
  let natureSeen = -1;
  let ecologyField: EcologyField | null = null;
  /** Where the land has a sea (the Earth's), a byte a corner, or null: its bed is water for what grows. */
  let seaMask: Uint8Array | null = null;
  let seaSource: true | ((x: number, y: number) => boolean) | null = null;
  let ecologyRevision = 0;
  /** The ecosystem must be read again; done when no stroke is held (as the water is). */
  let ecologyStale = true;
  /**
   * Where: the corners terrain strokes moved since it was last read, or the
   * whole map (the water, the paint, the biome or the map changed). A stroke
   * re-read the whole map, 82 ms, and could change trees far from the brush.
   */
  let ecologyDirty: TerrainRegion | 'all' | null = 'all';
  const ecologyAll = (): void => { ecologyStale = true; ecologyDirty = 'all'; };
  const ecologyOver = (box: TerrainRegion): void => {
    ecologyStale = true;
    if (ecologyDirty === 'all') return;
    ecologyDirty = ecologyDirty === null ? box : [
      Math.min(ecologyDirty[0], box[0]), Math.max(ecologyDirty[1], box[1]),
      Math.min(ecologyDirty[2], box[2]), Math.max(ecologyDirty[3], box[3]),
    ];
  };
  const refreshEcology = (): void => {
    ecologyStale = false;
    const dirty = ecologyDirty;
    ecologyDirty = null;
    const data = ecologyTexture.image.data as Uint8Array;
    if (!nature) {
      if (ecologyField) {
        ecologyField = null;
        data.fill(0);
        ecologyTexture.needsUpdate = true;
        ecologyRevision++;
      }
      return;
    }
    const levels = material.userData['shoreLevels'] as Float32Array;
    const wet = new Uint8Array(GRID * GRID);
    for (let i = 0; i < wet.length; i++) {
      const level = levels[i] as number;
      wet[i] = (level > NO_WATER / 2 && level >= (grid[i] as number) + 0.05) || (seaMask !== null && seaMask[i] === 1 && (natural[i] as number) < SEA_LEVEL) ? 1 : 0;
    }
    const over = ecologyField && dirty !== 'all' && dirty !== null && !ecologyInFlight ? dirty : null;
    const sand = material.userData['sandCorners'] as Float32Array, basalt = material.userData['basaltCorners'] as Float32Array;
    const ask = ++ecologyAsk;
    // A planet plate's whole field is read off the page (`ecologyPool.ts`):
    // 90 ms of a frame each time the view brought a plate in. The plate shows
    // the field it had (none, new) until it comes back; a newer reading
    // asked meanwhile wins. A stroke's small region stays here.
    if (plate >= 0 && !over && ecologyOffPage()) {
      const input = {
        side: GRID, cell: TERRAIN_CELL, heights: Float64Array.from(natural), water: wet,
        sandstone: Float32Array.from(sand), basalt: Float32Array.from(basalt),
        painted: biomePainted ? Float32Array.from(biomeCorners) : null, settings: nature,
      };
      const transfer: ArrayBuffer[] = [input.heights.buffer, wet.buffer, input.sandstone.buffer, input.basalt.buffer];
      if (input.painted) transfer.push(input.painted.buffer);
      ecologyInFlight = true;
      readEcology(plate, input, transfer, (field) => {
        if (ask !== ecologyAsk || disposed) return;
        ecologyInFlight = false;
        applyEcology(field);
      }, () => {
        if (ask !== ecologyAsk || disposed) return;
        ecologyInFlight = false;
        ++ecologyAsk;
        readOnPage(null);
      });
      return;
    }
    ecologyInFlight = false;
    readOnPage(over, wet);
  };
  /** Whether a plate's field is being read off the page (`refreshEcology`). */
  let ecologyInFlight = false;
  /** The latest reading asked: an older one coming back is dropped. */
  let ecologyAsk = 0;
  let disposed = false;
  const readOnPage = (over: TerrainRegion | null, wetGiven?: Uint8Array): void => {
    if (!nature) return;
    let wet = wetGiven;
    if (!wet) {
      const levels = material.userData['shoreLevels'] as Float32Array;
      wet = new Uint8Array(GRID * GRID);
      for (let i = 0; i < wet.length; i++) {
        const level = levels[i] as number;
        wet[i] = (level > NO_WATER / 2 && level >= (grid[i] as number) + 0.05) || (seaMask !== null && seaMask[i] === 1 && (natural[i] as number) < SEA_LEVEL) ? 1 : 0;
      }
    }
    const startedAt = performance.now();
    const field = computeEcology({
      side: GRID, cell: TERRAIN_CELL, heights: natural, water: wet,
      sandstone: material.userData['sandCorners'] as Float32Array, basalt: material.userData['basaltCorners'] as Float32Array,
      painted: biomePainted ? biomeCorners : null, settings: nature,
    }, over && ecologyField ? { previous: ecologyField, ix0: over[0], ix1: over[1], iy0: over[2], iy1: over[3] } : undefined);
    performance.measure('hitch:ecology', { start: startedAt, end: performance.now() });
    applyEcology(field);
  };
  const applyEcology = (field: EcologyField): void => {
    ecologyField = field;
    const data = ecologyTexture.image.data as Uint8Array;
    const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
    for (let i = 0; i < GRID * GRID; i++) {
      const canopy = field.canopy[i] as number, trees = field.trees[i] as number, grass = field.grass[i] as number;
      data[i * 4] = byte(canopy + trees * 0.3 + (field.palm[i] as number) * 0.25);
      data[i * 4 + 1] = byte(grass * (field.dry[i] as number));
      data[i * 4 + 2] = byte(field.wet[i] as number);
      data[i * 4 + 3] = byte((1 - grass) * (1 - Math.min(1, canopy + trees)));
    }
    ecologyTexture.needsUpdate = true;
    ecologyRevision++;
  };

  const rebuildWater = (stamps: readonly TerrainStamp[]): void => {
    // A river stands at the level its channel was cut INTO, below the banks: at
    // a fixed world datum it vanished under raised ground, and level with the
    // banks it covered the whole valley as one flat sheet.
    const land = stamps.filter((stamp) => stamp.mode !== 'river');
    const landIndex = new TerrainIndex(land, 0, index.relief, index.ground);
    const landAt = (x: number, y: number): number => TERRAIN_BASE + sampleTerrainHeight(landIndex, x, y);

    // A river drawn as a stroke is ONE body of water along its course: a
    // ribbon down the channel, its level only ever falling downstream (the
    // spline rivers of Unreal's Water and of Unity's river tools). Built
    // from discs on a grid, a river crossing lower ground ended in steps.
    const strokes = new Map<number, TerrainStamp[]>();
    for (const stamp of stamps) {
      if (stamp.mode !== 'river' || stamp.stroke === undefined) continue;
      const list = strokes.get(stamp.stroke);
      if (list) list.push(stamp);
      else strokes.set(stamp.stroke, [stamp]);
    }
    const ribbonStamps = new Set<TerrainStamp>();
    const ribbons: RiverPath[] = [];
    const bankLevel = (stamp: TerrainStamp): number => {
      let bank = landAt(stamp.x, stamp.y);
      for (let k = 0; k < 8; k++) {
        const angle = (k / 8) * Math.PI * 2;
        bank = Math.min(bank, landAt(stamp.x + Math.cos(angle) * stamp.radius, stamp.y + Math.sin(angle) * stamp.radius));
      }
      const bed = heightAt(stamp.x, stamp.y);
      return bank - Math.max(WATER_MARGIN, WATER_FILL * (bank - bed));
    };
    for (const list of strokes.values()) {
      if (list.length < 3) continue;
      for (const stamp of list) ribbonStamps.add(stamp);
      ribbons.push(list.map((stamp) => ({ x: stamp.x, y: stamp.y, half: stamp.radius * RIBBON_HALF_WIDTH, level: bankLevel(stamp) })));
    }

    const discs: WaterStamp[] = [];
    for (const stamp of stamps) {
      if (stamp.mode !== 'river' || discs.length >= MAX_TERRAIN_STAMPS || ribbonStamps.has(stamp)) continue;
      // The LOWEST bank round the dab, not the ground at its centre: on a
      // hillside one bank is lower than the other, and water standing at the
      // centre's level spilled over it, flooded the slope past the basin
      // limit and was dropped, leaving a stepped sheet at the brush's reach.
      let bank = landAt(stamp.x, stamp.y);
      for (let k = 0; k < 8; k++) {
        const angle = (k / 8) * Math.PI * 2;
        bank = Math.min(bank, landAt(stamp.x + Math.cos(angle) * stamp.radius, stamp.y + Math.sin(angle) * stamp.radius));
      }
      const bed = heightAt(stamp.x, stamp.y);
      const level = bank - Math.max(WATER_MARGIN, WATER_FILL * (bank - bed));
      if (bed + TERRAIN_WATER_HEIGHT >= level) continue;
      discs.push({ x: stamp.x, y: stamp.y, radius: stamp.radius * WATER_RADIUS, level });
    }
    wetDiscs = discs;
    (groundTexture.image.data as Float32Array).set(grid);
    groundTexture.needsUpdate = true;
    const previous = water.geometry;
    floodCells = new Map();
    water.geometry = unifiedWaterGeometry(discs, renderedHeightAt, floodCells, ribbons);
    previous.dispose();
    shoreLevels(water.geometry, material.userData['shoreLevels'] as Float32Array, grid);
    packGroundCorners(material.userData['shore'] as DataTexture, material.userData['shoreLevels'] as Float32Array, material.userData['flowerCorners'] as Float32Array, material.userData['scrubCorners'] as Float32Array, material.userData['forestCorners'] as Float32Array, material.userData['sandCorners'] as Float32Array, material.userData['basaltCorners'] as Float32Array);
    water.geometry.computeBoundingBox();
    const box = water.geometry.boundingBox;
    // In world (x, y): the mesh is three's (x, height, -y).
    waterBox = box && !box.isEmpty() ? { minX: box.min.x, maxX: box.max.x, minY: -box.max.z, maxY: -box.min.z } : null;
    water.visible = waterBox !== null;
    waterRevision++;
    // The water moved, and with it the rivers' forests and the veredas.
    ecologyAll();
  };
  /** How near the water a moved corner can be and still leave it as it was: two water cells and two terrain cells. */
  const WATER_REACH = 2 * WATER_CELL + 2 * TERRAIN_CELL;
  /**
   * Whether the last shaping moved ground under or beside the water. A road
   * edit re-cut the ground under that road only, but rebuilt the whole water
   * mesh every time (about 90 ms on a town with a river); away from the water
   * the mesh is the same, as the rivers' levels read the unshaped land.
   */
  /**
   * Whether land moved in `box` (corners) can change the water: it reaches
   * the water's mesh, or a river's banks (each river dab reads the land round
   * it out to its radius, `rebuildWater`), or the flood's way out past the
   * mesh (`WATER_REACH`). A basin can only flood across cells next to the
   * water it floods from, so land moved farther off leaves every pool as it is.
   */
  const waterReaches = (box: TerrainRegion): boolean => {
    const minX = box[0] * TERRAIN_CELL - TERRAIN_HALF, maxX = box[1] * TERRAIN_CELL - TERRAIN_HALF;
    const maxY = TERRAIN_HALF - box[2] * TERRAIN_CELL, minY = TERRAIN_HALF - box[3] * TERRAIN_CELL;
    const near = (x0: number, y0: number, x1: number, y1: number, reach: number): boolean =>
      minX <= x1 + reach && maxX >= x0 - reach && minY <= y1 + reach && maxY >= y0 - reach;
    if (waterBox && near(waterBox.minX, waterBox.minY, waterBox.maxX, waterBox.maxY, WATER_REACH)) return true;
    for (const stamp of lastStamps) {
      if (stamp.mode !== 'river') continue;
      const reach = stamp.radius * WATER_SPREAD + WATER_REACH;
      if (near(stamp.x, stamp.y, stamp.x, stamp.y, reach)) return true;
    }
    return false;
  };
  const touchesWater = (): boolean => {
    if (!waterBox) return wetDiscs.length > 0;
    for (const i of lastChanged) {
      const ix = i % GRID, iy = (i - ix) / GRID;
      const x = ix * TERRAIN_CELL - TERRAIN_HALF, y = TERRAIN_HALF - iy * TERRAIN_CELL;
      if (x >= waterBox.minX - WATER_REACH && x <= waterBox.maxX + WATER_REACH
        && y >= waterBox.minY - WATER_REACH && y <= waterBox.maxY + WATER_REACH) return true;
    }
    return false;
  };

  // Cloned without the userData: `Material.copy` copies it through
  // JSON.stringify (three r186), and the land's textures and fields kept
  // there were serialised image by image - 283 ms of the opening for a copy
  // nothing reads. The verge reads the land's own (its uniforms come from
  // `material.onBeforeCompile`), so both share the one object.
  const landData = material.userData;
  material.userData = {};
  const vergeMaterial = material.clone();
  material.userData = landData;
  vergeMaterial.userData = landData;
  vergeMaterial.onBeforeCompile = (shader, renderer) => {
    material.onBeforeCompile(shader, renderer);
    // The batter belongs to a road, not to a piece of the planet's ground: never cut away.
    shader.uniforms['uPlanetTile'] = { value: -1 };
    shader.fragmentShader = shader.fragmentShader.replace(
      'float slopeDeg = terrainSlope();',
      'float slopeDeg = 0.0;',
    );
  };
  vergeMaterial.customProgramCacheKey = () => 'terrain-splat-v31-verge';

  let paintArray = material.userData['paint'] as DataArrayTexture;
  let paintRes = paintArray.image.width;
  let paint = [paintLayer(paintArray, 0), paintLayer(paintArray, 1)];
  // The land's own light (`terrainLight`): lit and open to the sky until it
  // is first worked out.
  let lightLayer = paintLayer(paintArray, LIGHT_LAYER);
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) lightLayer.set([255, 255, 128, 0], (i * paintRes + j) * 4);
  }
  /**
   * The painted ground's array at its full size (`PAINT_RES`), made when the
   * first dab reaches this ground (`PAINT_START_RES`): the land's light
   * carried over row by row, the shader given the new array and its side.
   */
  const growPaint = (): void => {
    if (paintRes >= PAINT_RES) return;
    const small = paintArray, was = paintRes;
    const next = paintLayers(PAINT_RES);
    const from = paintLayer(small, LIGHT_LAYER), to = paintLayer(next, LIGHT_LAYER);
    for (let y = 0; y < GRID; y++) to.set(from.subarray(y * was * 4, (y * was + GRID) * 4), y * PAINT_RES * 4);
    const own = material.userData['terrainUniforms'] as { uPaint: { value: Texture }; uPaintRes: { value: number } };
    own.uPaint.value = next;
    own.uPaintRes.value = PAINT_RES;
    material.userData['paint'] = next;
    paintArray = next;
    paintRes = PAINT_RES;
    paint = [paintLayer(next, 0), paintLayer(next, 1)];
    lightLayer = paintLayer(next, LIGHT_LAYER);
    small.dispose();
  };
  paintArray.addLayerUpdate(LIGHT_LAYER);
  paintArray.needsUpdate = true;
  // The corners whose heights moved since the light was last asked for
  // ('all': the whole land), joined over every shaping step of an edit.
  let landMoved: CornerRect | 'all' | null = 'all';
  const markLand = (rect: CornerRect | 'all'): void => {
    landMoved = rect === 'all' || landMoved === 'all' ? 'all' : landMoved ? unionCorners(landMoved, rect) : rect;
  };
  const litSun = { x: 0, y: -1, z: 0 };
  // Worked out in a worker (`terrainLight.worker.ts`), one request at a time:
  // the edits and sun turns made meanwhile wait, joined, for the next.
  const lightGrid = { n: GRID, cell: TERRAIN_CELL };
  let lightWorker: Worker | null = null;
  let lightLocal: ((request: LightRequest) => LightResult) | null = null;
  let lightBusy = false;
  /** The document's diary (`world/changes.ts`), as the last `update` saw it, and the entry the light in flight follows from. */
  let diary: ChangeJournal | null = null;
  let lightCause = 0;
  const applyLight = (result: LightResult): void => {
    const startedAt = performance.now();
    const { rect, rgba } = result;
    const width = rect.x1 - rect.x0 + 1;
    for (let iy = rect.y0; iy <= rect.y1; iy++) {
      const row = (iy - rect.y0) * width * 4;
      lightLayer.set(rgba.subarray(row, row + width * 4), (iy * paintRes + rect.x0) * 4);
    }
    paintArray.addLayerUpdate(LIGHT_LAYER);
    paintArray.needsUpdate = true;
    performance.measure('hitch:terrain-light', { start: startedAt, end: performance.now() });
    performance.measure('terrain-light/worker', { start: startedAt - result.ms, end: startedAt, detail: `${width}x${rect.y1 - rect.y0 + 1} corners` });
    // Rows run from +y downwards.
    diary?.record('light', [[origin.x - TERRAIN_HALF + rect.x0 * TERRAIN_CELL, origin.y + TERRAIN_HALF - rect.y1 * TERRAIN_CELL, origin.x - TERRAIN_HALF + rect.x1 * TERRAIN_CELL, origin.y + TERRAIN_HALF - rect.y0 * TERRAIN_CELL]],
      { cause: 'luz do terreno refeita', ...(lightCause ? { parent: lightCause } : {}), ms: result.ms, detail: `${width}×${rect.y1 - rect.y0 + 1} cantos, num worker` });
  };
  // A planet plate (`tile` >= 0) shares the planet's few light workers
  // (`terrainLightPool.ts`): a worker of its own each was 864 threads.
  if (typeof Worker !== 'undefined' && plate < 0) {
    try {
      lightWorker = new Worker(new URL('./terrainLight.worker.ts', import.meta.url), { type: 'module' });
      lightWorker.postMessage({ grid: lightGrid });
      lightWorker.onmessage = (event: MessageEvent<LightResult | { error: string }>) => {
        lightBusy = false;
        if ('error' in event.data) console.warn('[terrain] the land\'s light failed in its worker', event.data.error);
        else applyLight(event.data);
      };
      lightWorker.onerror = (event) => {
        console.warn('[terrain] the land\'s light worker is unavailable; it is worked out on the page', event.message);
        lightWorker?.terminate();
        lightWorker = null;
        lightBusy = false;
        landMoved = 'all';
      };
    } catch (error) {
      console.warn('[terrain] the land\'s light worker is unavailable; it is worked out on the page', error);
      lightWorker = null;
    }
  }
  const setSun = (sun: { readonly x: number; readonly y: number; readonly z: number }): void => {
    // A stroke held: the water waits for its end, and so does this.
    if (waterStale || lightBusy) return;
    const len = Math.hypot(sun.x, sun.y, sun.z) || 1;
    const turned = (sun.x * litSun.x + sun.y * litSun.y + sun.z * litSun.z) / len < Math.cos((2 * Math.PI) / 180);
    if (!landMoved && !turned) return;
    litSun.x = sun.x / len; litSun.y = sun.y / len; litSun.z = sun.z / len;
    const request: LightRequest = { heights: grid.slice(), sun: { ...litSun }, moved: landMoved, relightAll: turned };
    landMoved = null;
    lightCause = diary?.version ?? 0;
    if (lightWorker) {
      lightBusy = true;
      lightWorker.postMessage(request, [request.heights.buffer]);
      return;
    }
    if (plate >= 0) {
      lightBusy = true;
      const sent = submitLight(lightGrid, plate, request,
        (result) => { lightBusy = false; applyLight(result); },
        () => { lightBusy = false; landMoved = 'all'; });
      if (sent) return;
      lightBusy = false;
    }
    lightLocal ??= createLandLighter(lightGrid);
    applyLight(lightLocal(request));
  };
  let paintRevision = 0;
  let paintCount = 0;
  let paintFirst: PaintDab | undefined;
  const covers: Record<CoverKind, Uint8Array> = {
    forest: new Uint8Array(FOREST_RES * FOREST_RES),
    scrub: new Uint8Array(FOREST_RES * FOREST_RES),
    flowers: new Uint8Array(FOREST_RES * FOREST_RES),
    rocks: new Uint8Array(FOREST_RES * FOREST_RES),
  };
  let forestRevision = 0;
  const coverAt = (kind: CoverKind, x: number, y: number): number => {
    const cell = TERRAIN_SIZE / FOREST_RES;
    const gx = Math.floor((x + TERRAIN_HALF) / cell), gy = Math.floor((y + TERRAIN_HALF) / cell);
    if (gx < 0 || gy < 0 || gx >= FOREST_RES || gy >= FOREST_RES) return 0;
    return covers[kind][gy * FOREST_RES + gx]! / 255;
  };
  const sandCorners = material.userData['sandCorners'] as Float32Array;
  const basaltCorners = material.userData['basaltCorners'] as Float32Array;
  const geologyChanges = new GroundChanges();
  const updatePaint = (doc: TerrainSource, deferEcology = false): void => {
    if (doc.natureRevision !== natureSeen) {
      natureSeen = doc.natureRevision;
      nature = doc.nature;
      ecologyAll();
    }
    paintStep(doc);
    // The ecosystem follows the land, the water and the paint, once no stroke
    // is held (a stroke defers the water, and with it this).
    if (ecologyStale && !waterStale && !deferEcology) refreshEcology();
  };
  const paintStep = (doc: TerrainSource): void => {
    if (doc.paintRevision === paintRevision) return;
    paintRevision = doc.paintRevision;
    const dabs = doc.terrainPaint;
    // Whether a dab of ground or cover was laid: the plants follow those, and
    // a dab of geology changes neither.
    let covered = false;
    const geologyRects: (readonly [number, number, number, number])[] = [];
    // Something to lay: the array at its full size first.
    if (dabs.length > 0) growPaint();
    const lay = (dab: PaintDab): void => {
      if (isGeologyKind(dab.kind)) {
        geologyRects.push(rasterGeology(sandCorners, basaltCorners, dab));
        ecologyAll();
        return;
      }
      if (isBiomeKind(dab.kind)) {
        rasterBiome(biomeCorners, dab);
        biomePainted = true;
        ecologyAll();
        return;
      }
      rasterPaint(paint, dab);
      rasterCover(covers, dab);
      covered = true;
    };
    // Dabs only added since the last time: lay just those. Anything else (an
    // undo, a load, the oldest dabs dropped): lay them all again.
    if (dabs.length >= paintCount && dabs[0] === paintFirst && paintCount > 0) {
      for (let i = paintCount; i < dabs.length; i++) lay(dabs[i]!);
      if (geologyRects.length > 0) geologyChanges.mark(geologyRects);
    } else {
      for (const layer of paint) layer.fill(0);
      for (const kind of COVER_KINDS) covers[kind].fill(0);
      sandCorners.fill(0);
      basaltCorners.fill(0);
      biomeCorners.fill(0);
      biomePainted = false;
      ecologyAll();
      for (const dab of dabs) lay(dab);
      covered = true;
      geologyChanges.mark(null);
    }
    paintCount = dabs.length;
    paintFirst = dabs[0];
    if (!covered) {
      packGroundCorners(material.userData['shore'] as DataTexture, material.userData['shoreLevels'] as Float32Array, material.userData['flowerCorners'] as Float32Array, material.userData['scrubCorners'] as Float32Array, material.userData['forestCorners'] as Float32Array, sandCorners, basaltCorners);
      return;
    }
    forestRevision++;
    paintArray.addLayerUpdate(0);
    paintArray.addLayerUpdate(1);
    paintArray.needsUpdate = true;
    {
      // The flowers and the scrub at each terrain corner, into the shader's
      // ground texture.
      const flowers = material.userData['flowerCorners'] as Float32Array;
      const scrub = material.userData['scrubCorners'] as Float32Array;
      const forest = material.userData['forestCorners'] as Float32Array;
      for (let iy = 0; iy < GRID; iy++) {
        for (let ix = 0; ix < GRID; ix++) {
          const x = -TERRAIN_HALF + ix * TERRAIN_CELL, y = TERRAIN_HALF - iy * TERRAIN_CELL;
          flowers[iy * GRID + ix] = coverAt('flowers', x, y);
          scrub[iy * GRID + ix] = coverAt('scrub', x, y);
          forest[iy * GRID + ix] = coverAt('forest', x, y);
        }
      }
      packGroundCorners(material.userData['shore'] as DataTexture, material.userData['shoreLevels'] as Float32Array, flowers, scrub, forest, sandCorners, basaltCorners);
    }
  };

  const parts: TerrainPart[] = [];
  const surface: TerrainSurface = {
    meshes: rim ? [backdrop, walls, ground, water] : [ground, water],
    parts,
    regionOf(box) {
      const last = TERRAIN_SEGMENTS;
      const clamp = (v: number): number => Math.max(0, Math.min(last, v));
      return [
        clamp(Math.floor((box[0] + TERRAIN_HALF) / TERRAIN_CELL)), clamp(Math.ceil((box[2] + TERRAIN_HALF) / TERRAIN_CELL)),
        clamp(Math.floor((TERRAIN_HALF - box[3]) / TERRAIN_CELL)), clamp(Math.ceil((TERRAIN_HALF - box[1]) / TERRAIN_CELL)),
      ];
    },
    rectOf(region) {
      return [
        (region[0] - 1) * TERRAIN_CELL - TERRAIN_HALF, TERRAIN_HALF - (region[3] + 1) * TERRAIN_CELL,
        (region[1] + 1) * TERRAIN_CELL - TERRAIN_HALF, TERRAIN_HALF - (region[2] - 1) * TERRAIN_CELL,
      ];
    },
    ground,
    setSun,
    setGullies(dabs, auto) { relief.setGullies(dabs, auto); },
    setWaterLook(look) { waterSurface.setLook(look); },
    bakeRelief(renderer, focus) {
      if (!waterStale) relief.bake(renderer, grid, focus);
    },
    vergeMaterial,
    updatePaint,
    get ecologyPending() { return ecologyStale && !waterStale; },
    settleEcology() {
      if (!ecologyStale || waterStale) return false;
      refreshEcology();
      return true;
    },
    forestAt(x, y) {
      return coverAt('forest', x, y);
    },
    coverAt,
    ecology: () => ecologyField,
    get ecologyRevision() {
      return ecologyRevision;
    },
    ecologyTexture,
    get forestRevision() {
      return forestRevision;
    },
    geologyAt(x, y) {
      const ix = Math.round((x + TERRAIN_HALF) / TERRAIN_CELL);
      const iy = Math.round((TERRAIN_HALF - y) / TERRAIN_CELL);
      if (ix < 0 || iy < 0 || ix >= GRID || iy >= GRID) return 'granite';
      const sand = sandCorners[iy * GRID + ix] as number, basalt = basaltCorners[iy * GRID + ix] as number;
      return sand >= 0.5 && sand >= basalt ? 'sandstone' : basalt >= 0.5 ? 'basalt' : 'granite';
    },
    geologyChanges,
    shoreLevelAt(x, y) {
      const ix = Math.round((x + TERRAIN_HALF) / TERRAIN_CELL);
      const iy = Math.round((TERRAIN_HALF - y) / TERRAIN_CELL);
      if (ix < 0 || iy < 0 || ix >= GRID || iy >= GRID) return null;
      const level = (material.userData['shoreLevels'] as Float32Array)[iy * GRID + ix] as number;
      return level > NO_WATER / 2 ? level : null;
    },
    waterArea: () => waterBox,
    get waterRevision() {
      return waterRevision;
    },
    heightAt,
    naturalRenderedHeightAt,
    renderedHeightAt,
    wetAt,
    digest(minX, minY, maxX, maxY) {
      const digest = new Digest();
      if (minX < -TERRAIN_HALF || maxX > TERRAIN_HALF || minY < -TERRAIN_HALF || maxY > TERRAIN_HALF) {
        digest.add(revision);
      }
      // Rows run from +y downwards (see `sampleGrid`).
      const clampCorner = (value: number): number => Math.min(GRID - 1, Math.max(0, value));
      const x0 = clampCorner(Math.floor((minX + TERRAIN_HALF) / TERRAIN_CELL));
      const x1 = clampCorner(Math.floor((maxX + TERRAIN_HALF) / TERRAIN_CELL) + 1);
      const y0 = clampCorner(Math.floor((TERRAIN_HALF - maxY) / TERRAIN_CELL));
      const y1 = clampCorner(Math.floor((TERRAIN_HALF - minY) / TERRAIN_CELL) + 1);
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) digest.add(natural[ix + iy * GRID] as number).add(grid[ix + iy * GRID] as number);
      }
      return digest.value();
    },
    get lastRegion() { return lastRegion; },
    settle() {
      if (!waterStale) return;
      waterStale = false;
      const dirty = waterDirty;
      waterDirty = null;
      if (dirty !== null && dirty !== 'all' && !waterReaches(dirty)) {
        // The water stands as it was; what it reads of the ground is copied,
        // and the ecosystem, which reads the land's heights, is read again.
        (groundTexture.image.data as Float32Array).set(grid);
        groundTexture.needsUpdate = true;
        ecologyOver(dirty);
        return;
      }
      rebuildWater(lastStamps);
    },
    shapeToRoads(shape, region = null) {
      const shapeAt = performance.now();
      const moved = shapeToRoads(shape, region);
      performance.measure('hitch:road-edit/ground shape', { start: shapeAt, end: performance.now() });
      // A road that cut through a valley changes where the water's shore is:
      // at once, or once the stroke is over when one is held (`settle`).
      if (moved && touchesWater()) {
        if (region) { waterStale = true; markWaterDirty(null); }
        else { waterStale = false; waterDirty = null; rebuildWater(lastStamps); }
      }
      return moved;
    },
    update(doc, stroking = false) {
      diary = doc.changes;
      if (revision === doc.terrainRevision) return false;
      const firstBuild = revision < 0;
      const previous = index;
      const before = revision;
      revision = doc.terrainRevision;
      index = new TerrainIndex(doc.terrainStamps, revision, doc.terrainRelief, doc.terrainGround);
      // The Earth's land has a sea: under its level the ground is sea bed (`refreshEcology`).
      const sea = doc.terrainRelief === RELIEF_EARTH ? true : doc.terrainSea ?? null;
      if (sea !== seaSource) {
        seaSource = sea;
        seaMask = sea === null ? null : new Uint8Array(GRID * GRID).fill(sea === true ? 1 : 0);
        if (seaMask && typeof sea === 'function') {
          // Rows run down the map (y falling), as the grid's corners.
          for (let row = 0; row < GRID; row++) for (let col = 0; col < GRID; col++) {
            if (sea(-TERRAIN_HALF + col * TERRAIN_CELL, TERRAIN_HALF - row * TERRAIN_CELL)) seaMask[row * GRID + col] = 1;
          }
        }
        ecologyAll();
      }

      // Only the cells a new stamp reaches are rewritten. A brush stroke adds
      // one 80-unit stamp; rewriting all 90 601 corners for it is what made
      // painting terrain drop frames on a large map.
      const added = doc.terrainStamps.length === previous.stamps.length + 1
        ? doc.terrainStamps[doc.terrainStamps.length - 1]
        : undefined;
      // The first stamp of a map with none (a bomb's crater in a generated
      // city) is an addition too when the diary says only it moved: taken for
      // a new map, it rewrote and re-shaped the whole map - 2.7 s in the
      // click of a bomb on a city of 1 530 buildings (2026-10-09).
      const sameHistory = added !== undefined && stampAppended(previous.stamps, doc.terrainStamps, doc.changes.since(before, ['terrain']));

      // The first build worked out off the page (`plateMesh.ts`, as Cesium
      // builds its terrain meshes in a worker): its corners, normals and
      // steepness copied in, the diagonals and triangles chosen from the same
      // corners as below - none of the 90 601 corners worked out here.
      const made = firstBuild && prebuilt && doc.terrainStamps.length === 0 ? prebuilt : null;
      prebuilt = null;
      // The woods' base holds only on the land it was worked out on.
      woods = made?.woods ?? null;
      if (made) {
        const pos = position.array as Float32Array;
        const h = made.heights;
        for (let i = 0; i < GRID * GRID; i++) pos[i * 3 + 1] = h[i]!;
        grid.set(h);
        natural.set(h);
        naturalFlip.set(made.flip);
        lastRegion = null;
        position.needsUpdate = true;
        retriangulate(0, GRID - 1, 0, GRID - 1);
        (normal.array as Float32Array).set(made.normals);
        normal.needsUpdate = true;
        steep.set(made.steep);
        steepAttribute.needsUpdate = true;
        rebuildFrame();
        geometry.boundingSphere = new Sphere(new Vector3(0, (made.low + made.high) / 2, 0), Math.hypot(TERRAIN_HALF * Math.SQRT2, (made.high - made.low) / 2));
        lastStamps = doc.terrainStamps;
        if (stroking) { waterStale = true; markWaterDirty(null); } else { waterStale = false; waterDirty = null; rebuildWater(lastStamps); }
        markLand('all');
        relief.markDirty();
        return true;
      }

      let box: readonly [number, number, number, number] | null = null;
      if (firstBuild || !added || !sameHistory) {
        rewrite(0, GRID - 1, 0, GRID - 1);
        lastRegion = null;
      } else {
        const reach = added.radius + TERRAIN_CELL;
        const cx0 = Math.max(0, Math.floor((added.x - reach + TERRAIN_HALF) / TERRAIN_CELL));
        const cx1 = Math.min(GRID - 1, Math.ceil((added.x + reach + TERRAIN_HALF) / TERRAIN_CELL));
        const cy0 = Math.max(0, Math.floor((TERRAIN_HALF - (added.y + reach)) / TERRAIN_CELL));
        const cy1 = Math.min(GRID - 1, Math.ceil((TERRAIN_HALF - (added.y - reach)) / TERRAIN_CELL));
        // A `flatten` stamp scales everything under it, so it can move ground
        // the disc does not cover if an earlier stamp reached further; the box
        // above is still the only place its influence is non-zero.
        rewrite(cx0, cx1, cy0, cy1);
        box = [cx0, cx1, cy0, cy1];
        lastRegion = box;
      }

      position.needsUpdate = true;
      if (box) retriangulate(box[0], Math.min(GRID - 1, box[1] + 1), box[2], Math.min(GRID - 1, box[3] + 1));
      else retriangulate(0, GRID - 1, 0, GRID - 1);
      let rimMoved = !box;
      if (box) {
        // Only the corners the dab rewrote can have tilted, with their ring of
        // neighbours; the whole plate's normals were a third of a dab.
        const moved: number[] = [];
        for (let iy = box[2]; iy <= box[3]; iy++) {
          for (let ix = box[0]; ix <= box[1]; ix++) moved.push(iy * GRID + ix);
        }
        refreshNormals(moved);
        rimMoved = moved.some(onRim);
      } else {
        geometry.computeVertexNormals();
        refreshAllSteep();
      }
      // The backdrop is sewn to the rim (see `rebuildFrame`): a dab that moved
      // an edge corner re-sews it, and one in the middle of the plate does not.
      if (rimMoved) rebuildFrame();
      geometry.computeBoundingSphere();
      lastStamps = doc.terrainStamps;
      // The water - every pool and river on the map - is the deferred part of
      // a stroke (Unity's SetHeightsDelayLOD then SyncHeightmap on release):
      // rebuilt on every dab, it was the largest single cost of painting.
      if (stroking) {
        waterStale = true;
        // A river dab makes water; any other dab is its box.
        markWaterDirty(added && added.mode !== 'river' ? box : null);
      } else { waterStale = false; waterDirty = null; rebuildWater(lastStamps); }
      markLand(box ? { x0: box[0], x1: box[1], y0: box[2], y1: box[3] } : 'all');
      relief.markDirty();
      return true;
    },
    woodsBase: () => woods,
    dispose() {
      disposed = true;
      relief.dispose();
      geometry.dispose();
      material.dispose();
      backdrop.geometry.dispose();
      (backdrop.material as MeshStandardMaterial).dispose();
      walls.geometry.dispose();
      (walls.material as MeshStandardMaterial).map?.dispose();
      (walls.material as MeshStandardMaterial).dispose();
      water.geometry.dispose();
      waterSurface.dispose();
      groundTexture.dispose();
    },
  };
  parts.push({ surface, cx: 0, cy: 0 });
  return surface;
}

export interface WaterStamp {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly level: number;
}

interface WaterVertex {
  readonly ix: number;
  readonly iy: number;
  weightedLevel: number;
  weight: number;
}

type WaterKey = number | string;
const WATER_KEY_STRIDE = 65_536;
const WATER_KEY_OFFSET = 32_768;

/** Exact numeric cell IDs on the playable map; a string preserves arbitrary out-of-map coordinates. */
function waterKey(ix: number, iy: number): WaterKey {
  return ix >= -WATER_KEY_OFFSET && ix < WATER_KEY_OFFSET && iy >= -WATER_KEY_OFFSET && iy < WATER_KEY_OFFSET
    ? (ix + WATER_KEY_OFFSET) * WATER_KEY_STRIDE + iy + WATER_KEY_OFFSET
    : `${ix}:${iy}`;
}

function waterCell(key: WaterKey): readonly [number, number] {
  if (typeof key === 'number') {
    const x = Math.floor(key / WATER_KEY_STRIDE);
    return [x - WATER_KEY_OFFSET, key - x * WATER_KEY_STRIDE - WATER_KEY_OFFSET];
  }
  const [x, y] = key.split(':');
  return [Number(x), Number(y)];
}

/** Most cells one body of water may spread over into a basin: about 400 m square. */
const MAX_FLOOD_CELLS = 40_000;

/**
 * Water runs into the hollow beside it and fills it to its own level.
 *
 * The surface used to stop where the brush's reach stopped. A river led into
 * a pit stood at its own level out over the pit and simply ended there in the
 * air, a sheet with a sawtooth edge hanging over the hole. Each body of water
 * (the stamps' vertices, taken a connected group at a time) now floods out,
 * cell by cell, into every neighbouring cell whose ground is below its level -
 * the flood fill depression-filling algorithms are built on (Barnes, Lehman &
 * Mulla, "Priority-Flood", 2014) - so the pit becomes a lake whose edge is its
 * shore. A flood that runs on past `MAX_FLOOD_CELLS` is not a basin but open
 * low country the water would drain into; it is withdrawn and that water keeps
 * the extent the brush gave it.
 */
/** How many water cells (24 units, about 10 m) of an over-large flood stay, so a river meets its own banks. */
const SHORE_BAND = 6;
function floodBasins(
  vertices: Map<WaterKey, WaterVertex>,
  groundAt: (x: number, y: number) => number,
  flooded?: Map<string, number>,
): void {
  const seen = new Set<WaterKey>();
  const seeds = [...vertices.values()];
  const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (const seed of seeds) {
    const seedKey = waterKey(seed.ix, seed.iy);
    if (seen.has(seedKey)) continue;
    // The body of water this stamp vertex belongs to.
    const body: WaterVertex[] = [];
    const stack = [seed];
    seen.add(seedKey);
    while (stack.length) {
      const v = stack.pop() as WaterVertex;
      body.push(v);
      for (const [dx, dy] of NEIGHBOURS) {
        const key = waterKey(v.ix + dx, v.iy + dy);
        const next = vertices.get(key);
        if (next && !seen.has(key)) { seen.add(key); stack.push(next); }
      }
    }
    // Its flood, breadth first from its whole edge, each new cell at the level
    // of the water that reached it.
    const added: WaterKey[] = [];
    /** How many cells out from the body each flooded cell is. */
    const steps = new Map<WaterKey, number>();
    const queue = body.slice();
    let overflow = false;
    for (let head = 0; head < queue.length && !overflow; head++) {
      const v = queue[head] as WaterVertex;
      const out = steps.get(waterKey(v.ix, v.iy)) ?? 0;
      const level = v.weightedLevel / v.weight;
      for (const [dx, dy] of NEIGHBOURS) {
        const ix = v.ix + dx;
        const iy = v.iy + dy;
        const key = waterKey(ix, iy);
        if (vertices.has(key)) continue;
        if (groundAt(ix * WATER_CELL, iy * WATER_CELL) >= level - TERRAIN_WATER_HEIGHT) continue;
        const wet: WaterVertex = { ix, iy, weightedLevel: level, weight: 1 };
        vertices.set(key, wet);
        seen.add(key);
        added.push(key);
        steps.set(key, out + 1);
        queue.push(wet);
        if (added.length > MAX_FLOOD_CELLS) { overflow = true; break; }
      }
    }
    // Open country is not a basin: that flood is withdrawn - but not the
    // band next to the water, or the sheet stopped at the brush's reach in
    // steps over a bed it left dry. Within SHORE_BAND cells it reaches its
    // bank; beyond, the water keeps the extent the brush gave it.
    if (overflow) {
      for (const key of added) if ((steps.get(key) ?? 0) > SHORE_BAND) vertices.delete(key);
    } else if (flooded) for (const key of added) {
      const v = vertices.get(key) as WaterVertex;
      flooded.set(`${v.ix}:${v.iy}`, v.weightedLevel / v.weight);
    }
  }
}

/**
 * One triangulated surface for every overlapping river stamp.
 *
 * Drawing one translucent disc per brush sample stacked forty alpha layers into
 * the pale cloud saved maps showed. Accumulating them on a shared grid performs
 * the union before rendering: overlap changes the local level, never the
 * opacity. The level each vertex carries is the weighted average of the stamps
 * reaching it, so the surface runs DOWN the channel's own profile instead of
 * standing at one height along a river that drops seventeen units across a map.
 *
 * Every vertex also carries its DEPTH — its own level minus the ground under it
 * — which is the one number the shader needs to tell a bank from a channel. It
 * is free here and impossible there: only this builder holds the terrain
 * sampler. See `water.ts` for what is made of it.
 */
export function unifiedWaterGeometry(
  stamps: readonly WaterStamp[],
  terrainHeightAt: (x: number, y: number) => number,
  /** Filled with the cells the water flooded into, and their level. */
  flooded?: Map<string, number>,
  /** Rivers drawn as strokes (`riverRibbon`). */
  ribbons: readonly RiverPath[] = [],
): BufferGeometry {
  const geometry = new BufferGeometry();
  if (stamps.length === 0 && ribbons.length === 0) return geometry;

  const vertices = new Map<WaterKey, WaterVertex>();
  for (const stamp of stamps) {
    const reach = stamp.radius * WATER_SPREAD;
    const minX = Math.floor((stamp.x - reach) / WATER_CELL);
    const maxX = Math.ceil((stamp.x + reach) / WATER_CELL);
    const minY = Math.floor((stamp.y - reach) / WATER_CELL);
    const maxY = Math.ceil((stamp.y + reach) / WATER_CELL);
    for (let ix = minX; ix <= maxX; ix++) {
      const x = ix * WATER_CELL;
      for (let iy = minY; iy <= maxY; iy++) {
        const y = iy * WATER_CELL;
        const distance = Math.hypot(x - stamp.x, y - stamp.y);
        if (distance >= reach) continue;
        const weight =
          distance < stamp.radius
            ? Math.max(0.001, terrainInfluence(1 - distance / stamp.radius))
            : 0.001;
        const key = waterKey(ix, iy);
        const vertex = vertices.get(key);
        if (vertex) {
          vertex.weightedLevel += stamp.level * weight;
          vertex.weight += weight;
        } else {
          vertices.set(key, { ix, iy, weightedLevel: stamp.level * weight, weight });
        }
      }
    }
  }

  floodBasins(vertices, terrainHeightAt, flooded);

  const levelAt = (ix: number, iy: number): number | null => {
    const vertex = vertices.get(waterKey(ix, iy));
    return vertex ? vertex.weightedLevel / vertex.weight : null;
  };
  const positions: number[] = [];
  const depths: number[] = [];
  const cells = new Set<WaterKey>();
  // The contour builders consume these immediately; reuse them across cells
  // instead of allocating five points and three arrays for every quad.
  const points: WaterPoint[] = Array.from({ length: 4 }, () => ({ x: 0, y: 0, level: 0, depth: 0 }));
  const centre: WaterPoint = { x: 0, y: 0, level: 0, depth: 0 };
  for (const vertex of vertices.values()) {
    cells.add(waterKey(vertex.ix, vertex.iy));
    cells.add(waterKey(vertex.ix - 1, vertex.iy));
    cells.add(waterKey(vertex.ix, vertex.iy - 1));
    cells.add(waterKey(vertex.ix - 1, vertex.iy - 1));
  }

  // Which way the water runs at every vertex (three's x and z, unit length
  // down a river's course; still in a lake): the shader carries its ripples
  // that way (`water.ts`, a flow map).
  const flows: number[] = [];
  for (const path of ribbons) riverRibbon(path, terrainHeightAt, positions, depths, flows);
  for (const cell of cells) {
    const [ix, iy] = waterCell(cell);
    const k0 = levelAt(ix, iy), k1 = levelAt(ix + 1, iy);
    const k2 = levelAt(ix + 1, iy + 1), k3 = levelAt(ix, iy + 1);
    // A flooded basin carries a level only at its WET corners (`floodBasins`),
    // so every cell on a lake's shore had a corner with none, and dropping
    // those cells cut the lake's outline into a staircase of whole cells. The
    // missing corners take the water's level instead: they stand above it, so
    // the clip against the ground below draws the shore where it really is.
    let known = 0, sum = 0;
    for (const level of [k0, k1, k2, k3]) if (level !== null) { known++; sum += level; }
    if (known === 0) continue;
    const fill = sum / known;
    const l0 = k0 ?? fill, l1 = k1 ?? fill, l2 = k2 ?? fill, l3 = k3 ?? fill;
    const wx = ix * WATER_CELL, wy = iy * WATER_CELL;
    const p0 = points[0]!, p1 = points[1]!, p2 = points[2]!, p3 = points[3]!;
    p0.x = wx; p0.y = wy; p0.level = l0; p0.depth = l0 - terrainHeightAt(wx, wy);
    p1.x = wx + WATER_CELL; p1.y = wy; p1.level = l1; p1.depth = l1 - terrainHeightAt(p1.x, p1.y);
    p2.x = wx + WATER_CELL; p2.y = wy + WATER_CELL; p2.level = l2; p2.depth = l2 - terrainHeightAt(p2.x, p2.y);
    p3.x = wx; p3.y = wy + WATER_CELL; p3.level = l3; p3.depth = l3 - terrainHeightAt(p3.x, p3.y);
    // A corner past the water's extent is DRY even over ground below the
    // level (a canyon the river crosses): as wet, every such cell was drawn
    // whole and the sheet ended in steps of a cell in mid-air. Its edge is
    // cut where the contour crosses, interpolated (marching squares).
    p0.outside = k0 === null; p1.outside = k1 === null; p2.outside = k2 === null; p3.outside = k3 === null;
    for (const p of points) if (p.outside) p.depth = -Math.max(0.5, Math.abs(p.depth));
    centre.x = wx + WATER_CELL / 2;
    centre.y = wy + WATER_CELL / 2;
    centre.level = (l0 + l1 + l2 + l3) / 4;
    centre.depth = centre.level - terrainHeightAt(centre.x, centre.y);
    centre.outside = false;
    const wetCorners = Number(p0.depth > TERRAIN_WATER_HEIGHT) + Number(p1.depth > TERRAIN_WATER_HEIGHT) +
      Number(p2.depth > TERRAIN_WATER_HEIGHT) + Number(p3.depth > TERRAIN_WATER_HEIGHT);
    if (wetCorners === 0 && centre.depth <= TERRAIN_WATER_HEIGHT) continue;
    // Wound anticlockwise seen from above, so the surface is a FRONT face. The
    // old winding pointed every face at the ground and needed `DoubleSide` and a
    // back-face normal flip to be lit at all — which also meant the water was
    // rasterised twice.
    if (wetCorners === 4 && centre.depth > TERRAIN_WATER_HEIGHT) {
      pushTriangle(positions, depths, points[0]!, points[1]!, points[2]!);
      pushTriangle(positions, depths, points[0]!, points[2]!, points[3]!);
    } else {
      // Only the shore cells need a contour. Their wet triangles are clipped
      // against the actual ground, so the edge follows the bank between grid
      // corners instead of jumping one whole square at a time.
      for (let i = 0; i < 4; i++) {
        pushWetTriangle(positions, depths, points[i]!, points[(i + 1) % 4]!, centre, terrainHeightAt);
      }
    }
  }

  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute(WATER_DEPTH_ATTRIBUTE, new Float32BufferAttribute(depths, 1));
  while (flows.length < depths.length * 2) flows.push(0, 0);
  geometry.setAttribute(WATER_FLOW_ATTRIBUTE, new Float32BufferAttribute(flows, 2));
  const uvs: number[] = [];
  // Flat UP, not the face normals `computeVertexNormals` would give. The level
  // field steps by a fraction of a unit per cell, and on a surface this
  // reflective those steps show as a quilt of four-unit facets in the Fresnel
  // term and in the sun's glint. The ripple the eye reads comes from the normal
  // map, so the geometry's own normal should be the plane's.
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    uvs.push((positions[i] as number) / 40, (positions[i + 2] as number) / 40);
    normals[i + 1] = 1;
  }
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** One point of a river's course: where, how wide its water each side, at what level. */
export interface RiverPoint {
  readonly x: number;
  readonly y: number;
  readonly half: number;
  readonly level: number;
}
export type RiverPath = readonly RiverPoint[];

/** The river's water reaches this share of its brush each side (the banks clip the rest). */
const RIBBON_HALF_WIDTH = RIVER_BED_FLOOR;
/** The least water over a river's bed, units (half a metre). */
const RIVER_MIN_DEPTH = m(0.5);
/** Most units between two cross-sections of a ribbon. */
const RIBBON_STEP = m(2.4);
/** Strips across a ribbon. */
const RIBBON_ACROSS = 6;

/**
 * A river's water as one ribbon down its course: resampled along a smooth
 * curve through the stroke's dabs (Catmull-Rom), at the level of each
 * reach's banks, smoothed (the end whose banks stand higher is the source).
 * The ribbon is wider than the water: where a bank rises over the level the
 * ground hides it, so the shore is where the ground meets the water, with no
 * grid in it.
 */
export function riverRibbon(path: RiverPath, groundAt: (x: number, y: number) => number, positions: number[], depths: number[], flows?: number[]): void {
  if (path.length < 2) return;
  // Downstream: from the higher end (the order the falls are read in).
  const n = path.length;
  const head = path.slice(0, Math.max(1, Math.floor(n / 3))).reduce((s, p) => s + p.level, 0) / Math.max(1, Math.floor(n / 3));
  const tail = path.slice(n - Math.max(1, Math.floor(n / 3))).reduce((s, p) => s + p.level, 0) / Math.max(1, Math.floor(n / 3));
  const course = head >= tail ? path : [...path].reverse();
  // Resample on a Catmull-Rom curve.
  const pts: { x: number; y: number; half: number; level: number }[] = [];
  const at = (i: number): RiverPoint => course[Math.max(0, Math.min(course.length - 1, i))]!;
  for (let i = 0; i + 1 < course.length; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const span = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(1, Math.ceil(span / RIBBON_STEP));
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      pts.push({ x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y), half: p1.half + (p2.half - p1.half) * t, level: p1.level + (p2.level - p1.level) * t });
    }
  }
  const last = at(course.length - 1);
  pts.push({ x: last.x, y: last.y, half: last.half, level: last.level });
  // The level follows each reach's own banks, smoothed. Held never to rise
  // downstream, a river that crossed lower ground (a canyon) dropped to its
  // floor and ran dry, under its own bed, the rest of its course.
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i + 1 < pts.length; i++) pts[i]!.level = (pts[i - 1]!.level + pts[i]!.level * 2 + pts[i + 1]!.level) / 4;
  }
  // Never dry: at least RIVER_MIN_DEPTH over the bed along the whole course,
  // or a reach over higher ground broke the river into ponds.
  for (const p of pts) p.level = Math.max(p.level, groundAt(p.x, p.y) + RIVER_MIN_DEPTH);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i + 1 < pts.length; i++) pts[i]!.level = Math.max(groundAt(pts[i]!.x, pts[i]!.y) + RIVER_MIN_DEPTH, (pts[i - 1]!.level + pts[i]!.level * 2 + pts[i + 1]!.level) / 4);
  }
  // Cross-sections.
  const rows: { x: number; y: number; level: number; depth: number; fx: number; fz: number }[][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!;
    let tx = b.x - a.x, ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    const nx = -ty, ny = tx;
    const p = pts[i]!;
    const row: { x: number; y: number; level: number; depth: number; fx: number; fz: number }[] = [];
    for (let j = 0; j <= RIBBON_ACROSS; j++) {
      const s = (j / RIBBON_ACROSS) * 2 - 1;
      const x = p.x + nx * p.half * s, y = p.y + ny * p.half * s;
      // Fastest down the middle, slower towards the banks.
      const pace = 1 - 0.6 * s * s;
      row.push({ x, y, level: p.level, depth: p.level - groundAt(x, y), fx: tx * pace, fz: -ty * pace });
    }
    rows.push(row);
  }
  // Quads, anticlockwise seen from above (as the grid's cells are wound).
  const push = (v: { x: number; y: number; level: number; depth: number; fx: number; fz: number }): void => {
    positions.push(v.x, v.level, -v.y);
    depths.push(v.depth);
    flows?.push(v.fx, v.fz);
  };
  for (let i = 0; i + 1 < rows.length; i++) {
    for (let j = 0; j < RIBBON_ACROSS; j++) {
      const a = rows[i]![j]!, b = rows[i]![j + 1]!, c = rows[i + 1]![j + 1]!, d = rows[i + 1]![j]!;
      // Skip a quad over ground or under a film of water: a sheet a few
      // centimetres deep over the floodplain drew grey slabs off the river.
      if (Math.max(a.depth, b.depth, c.depth, d.depth) < 0.75) continue;
      const cross = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
      if (cross > 0) { push(a); push(b); push(c); push(a); push(c); push(d); }
      else { push(a); push(c); push(b); push(a); push(d); push(c); }
    }
  }
}

interface WaterPoint {
  x: number;
  y: number;
  level: number;
  depth: number;
  /** A corner past the water's extent (no level of its own): dry, whatever the ground under it. */
  outside?: boolean;
}

function pushTriangle(
  out: number[],
  depths: number[],
  a: WaterPoint,
  b: WaterPoint,
  c: WaterPoint,
): void {
  out.push(a.x, a.level, -a.y, b.x, b.level, -b.y, c.x, c.level, -c.y);
  depths.push(a.depth, b.depth, c.depth);
}

function pushWetTriangle(
  positions: number[], depths: number[], a: WaterPoint, b: WaterPoint, c: WaterPoint,
  groundAt: (x: number, y: number) => number,
): void {
  const corners = [a, b, c];
  const polygon: WaterPoint[] = [];
  for (let i = 0; i < 3; i++) {
    const from = corners[i]!;
    const to = corners[(i + 1) % 3]!;
    const fromWet = from.depth > TERRAIN_WATER_HEIGHT;
    const toWet = to.depth > TERRAIN_WATER_HEIGHT;
    if (fromWet) polygon.push(from);
    if (fromWet === toWet) continue;
    let wet = fromWet ? from : to;
    let dry = fromWet ? to : from;
    if (dry.outside) {
      // Past the water's extent: the crossing by the depths, as marching
      // squares interpolates along an edge - if the ground there is under
      // the water; on a bank, it is resolved against the ground below.
      const t = wet.depth / Math.max(1e-6, wet.depth - dry.depth);
      const x = wet.x + (dry.x - wet.x) * t, y = wet.y + (dry.y - wet.y) * t;
      const cut = { x, y, level: wet.level, depth: wet.level - groundAt(x, y) };
      if (cut.depth > TERRAIN_WATER_HEIGHT) { polygon.push(cut); continue; }
      dry = cut;
    }
    // Resolve against the ground sampler itself. A linear depth estimate can
    // place the vertex in air where the terrain bends or has a step.
    for (let step = 0; step < 8; step++) {
      const x = (wet.x + dry.x) / 2;
      const y = (wet.y + dry.y) / 2;
      const level = (wet.level + dry.level) / 2;
      const middle = { x, y, level, depth: level - groundAt(x, y) };
      if (middle.depth > TERRAIN_WATER_HEIGHT) wet = middle;
      else dry = middle;
    }
    polygon.push(wet);
  }
  for (let i = 1; i + 1 < polygon.length; i++) {
    const a = polygon[0]!, b = polygon[i]!, c = polygon[i + 1]!;
    if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 1e-9) {
      pushTriangle(positions, depths, a, b, c);
    }
  }
}

/**
 * Whether the land changed by one stamp added to the stamps it had (only its
 * box is rewritten), rather than by a map replaced. The first stamp of a map
 * with none - a bomb's crater in a generated city - is an addition when the
 * diary's terrain entries since (`entries`) all name where they moved:
 * taken for a new map, it rewrote and re-shaped the whole map, 2.7 s in the
 * click of a bomb on a city of 1 530 buildings (2026-10-09).
 */
export function stampAppended(previous: readonly unknown[], now: readonly unknown[], entries: readonly { readonly rects: unknown }[] | null): boolean {
  if (now.length !== previous.length + 1) return false;
  if (previous.length > 0) return previous[0] === now[0];
  return entries !== null && entries.length > 0 && entries.every((c) => c.rects !== null);
}
