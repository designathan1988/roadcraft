import { CanvasTexture, Color, DoubleSide, FrontSide, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';

import { bakedTexture, bakeSurface, disposeBakedTextures, fbm, makeNoise, rememberBakedTexture, type SurfaceBake } from './mesh/textureBaker';
import { applyDetail, detailSwitch, disposeDetailTextures } from './mesh/detailLayer';
import { applyRoadEdges } from './mesh/roadEdges';
import { applyLotOverlay } from './lotOverlay';
import { m } from '@world/units';

/**
 * Every material the scene uses, baked once and shared.
 *
 * A material here owns its textures. The road network is rebuilt on every edit,
 * and the previous code baked a fresh 160x160 canvas per band per structure on
 * each of those rebuilds — a stutter the player felt as a hitch while drawing.
 * Nothing in this module is rebuilt; the meshes are swapped and the materials
 * stay.
 *
 * ## Texture scale
 *
 * Each recipe declares the world size one tile covers. UVs are handed to the
 * mesh builder in WORLD UNITS, and the material divides by that world size, so
 * scale is stated once and can never drift between a road and the junction it
 * runs into. Asphalt aggregate at a 10.4 m tile (`ASPHALT_TILE`) is close
 * enough to a real surfacing course that the eye reads
 * texture rather than pattern.
 *
 * ## Close zoom
 *
 * The macro textures carry tone, wear, slabs and joints - everything visible
 * from the play zoom. The fine structure a player sees with the camera a few
 * metres off the ground (stones in the asphalt, sand in the concrete, blades in
 * the grass) comes from the detail layer in `mesh/detailLayer.ts`, which fades
 * in by pixel footprint. See that file for why a larger macro texture was not
 * the answer.
 */

export interface SceneMaterials {
  readonly asphalt: MeshStandardMaterial;
  readonly asphaltRaised: MeshStandardMaterial;
  readonly footway: MeshStandardMaterial;
  readonly kerb: MeshStandardMaterial;
  readonly verge: MeshStandardMaterial;
  readonly deck: MeshStandardMaterial;
  /**
   * The deck's concrete again, for the parapets. The same look in its own
   * material, because the parapets are instanced and the deck is not: one
   * material drawn both ways makes three switch its program between the two
   * variants on every frame.
   */
  readonly parapet: MeshStandardMaterial;
  readonly concrete: MeshStandardMaterial;
  readonly steel: MeshStandardMaterial;
  /** World units one tile of each surface covers, for UV generation. */
  readonly scale: {
    readonly asphalt: number;
    readonly footway: number;
    readonly kerb: number;
    readonly verge: number;
    readonly deck: number;
  };
  /** Switches the close-zoom detail layer on every material that has one. */
  setDetail(enabled: boolean): void;
  dispose(): void;
}

const ASPHALT_TILE = m(10.4);
const ASPHALT_SIZE = 512;
const ASPHALT_BASE = 0.215;
const RAISED_ASPHALT_BASE = 0.245;
const raisedAsphaltMaps = new WeakMap<Texture, Texture>();
const FOOTWAY_TILE = m(7.2);
const KERB_TILE = m(3.2);
const VERGE_TILE = m(8.8);
const DECK_TILE = m(8);

/** A small integer hash, for per-slab variation that is stable and tiles. */
function cellHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

function asphaltBake(key: string, base: number, anisotropy: number, raisedPixels?: Uint8ClampedArray): SurfaceBake {
  const grain = makeNoise(0x51ed);
  const macro = makeNoise(0x9a17);
  const patch = makeNoise(0x2b64);
  const oil = makeNoise(0x6d05);
  const size = ASPHALT_SIZE;
  return bakeSurface(
    key,
    {
      size,
      worldSize: ASPHALT_TILE,
      relief: 1.2,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        // Aggregate at the macro scale: kept LOW in contrast, because it is
        // what gets magnified at close zoom. The stones themselves are the
        // detail layer's job.
        const chips = fbm(grain, u * 128, v * 128, 128, 3);
        // Wear and repair patches: slow, wide, low contrast.
        const wear = fbm(macro, u * 6, v * 6, 6, 4);
        const repair = fbm(patch, u * 3 + 11, v * 3 + 7, 3, 2);
        // Drip stains down the middle of a lane, where engines stand.
        const stain = fbm(oil, u * 14, v * 3, 14, 3);
        const drip = stain > 0.66 ? (stain - 0.66) * 0.12 : 0;
        // Exposed stones: light flecks of aggregate in the dark binder.
        const stone = fbm(grain, u * 420 + 3, v * 420 + 9, 420, 1);
        const flecks = stone > 0.74 ? (stone - 0.74) * 0.5 : stone < 0.2 ? -0.02 : 0;
        // Patches: rectangles of newer, darker asphalt where a trench was filled.
        const pu = Math.floor(u * 5), pv = Math.floor(v * 3);
        const patchy = cellHash(pu, pv, 0x91c) > 0.82 && (u * 5 - pu) > 0.15 && (u * 5 - pu) < 0.75 && (v * 3 - pv) > 0.2 && (v * 3 - pv) < 0.6;
        const tone =
          base +
          (chips - 0.5) * 0.055 +
          flecks +
          (wear - 0.5) * 0.04 +
          (repair > 0.74 ? 0.022 : 0) -
          (patchy ? 0.03 : 0) -
          drip;
        if (raisedPixels) {
          const raisedTone =
            RAISED_ASPHALT_BASE +
            (chips - 0.5) * 0.03 +
            (wear - 0.5) * 0.032 +
            (repair > 0.74 ? 0.018 : 0) -
            drip;
          const at = (y * size + x) * 4;
          raisedPixels[at] = Math.round(Math.min(1, Math.max(0, raisedTone)) * 255);
          raisedPixels[at + 1] = Math.round(Math.min(1, Math.max(0, raisedTone * 1.01)) * 255);
          raisedPixels[at + 2] = Math.round(Math.min(1, Math.max(0, raisedTone * 1.05)) * 255);
          raisedPixels[at + 3] = 255;
        }
        out.r = tone * 1.0;
        out.g = tone * 1.01;
        out.b = tone * 1.05;
        // Only the aggregate is relief. Letting the wide wear patches into the
        // height map turned a smooth carriageway into a field of shallow craters.
        out.h = chips;
        // Polished wheel tracks are smoother than the rest of the lane.
        out.rough = 0.9 - (wear > 0.62 ? 0.09 : 0) - chips * 0.05 - drip * 2;
      },
    },
    anisotropy,
  );
}

/** The two asphalt colours share one noise, normal and roughness bake. */
function asphaltBakes(anisotropy: number): { road: SurfaceBake; raised: SurfaceBake; raisedMap: Texture } {
  const size = ASPHALT_SIZE;
  const pixels = new Uint8ClampedArray(size * size * 4);
  const road = asphaltBake('asphalt', ASPHALT_BASE, anisotropy, pixels);
  let raisedMap = raisedAsphaltMaps.get(road.map) ?? bakedTexture('asphalt-raised:map');
  if (!raisedMap) {
    if (pixels[3] !== 255) {
      // A second scene can find the base bake already cached without having
      // run its shade callback. Its existing recipe remains the exact fallback.
      raisedMap = asphaltBake('asphalt-raised', RAISED_ASPHALT_BASE, anisotropy).map;
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const image = ctx.createImageData(size, size);
        image.data.set(pixels);
        ctx.putImageData(image, 0, 0);
      }
      raisedMap = new CanvasTexture(canvas);
      raisedMap.colorSpace = SRGBColorSpace;
      raisedMap.wrapS = RepeatWrapping;
      raisedMap.wrapT = RepeatWrapping;
      raisedMap.anisotropy = anisotropy;
    }
    raisedAsphaltMaps.set(road.map, raisedMap);
    rememberBakedTexture('asphalt-raised:map', raisedMap);
  }
  if (raisedMap.anisotropy < anisotropy) { raisedMap.anisotropy = anisotropy; raisedMap.needsUpdate = true; }
  return { road, raised: { map: raisedMap, normalMap: road.normalMap, roughnessMap: road.roughnessMap }, raisedMap };
}

/**
 * The footway: interlocking concrete pavers in basketweave (it was large
 * precast slabs; the player found them ugly). What follows was written for
 * the slabs and still holds for the blocks:
 *
 * The previous bake was one flat tone crossed by a hard 1.5-texel line every
 * slab, which read as a grid printed on paper - and, magnified at close zoom,
 * as a blurred grid on paper. What makes a real pavement read is that no two
 * slabs are the same: each was cast on a different day, so each has its own
 * tone and its own weathering; the arrises are chamfered, so a joint is a soft
 * groove with a shadow rather than a line; dirt collects in the joints; and
 * here and there a slab has cracked or been replaced with a newer, paler one.
 */
function footwayBake(anisotropy: number): SurfaceBake {
  const grain = makeNoise(0x77c1);
  const stain = makeNoise(0x1d3f);
  const blot = makeNoise(0x5e2d);
  const size = 1024;
  /**
   * Twelve courses per tile: 7.2 m / 12 = 0.6 m slabs. They were
   * 1.2 m, twice a real paving slab, and read as a floor of tiles.
   */
  /** A paver's short side in texels: 16, about 11 cm, dividing the tile exactly so it repeats seamlessly. */
  const PAVER = 16;
  /** Chamfer width in texels. */
  const bevel = 2;
  return bakeSurface(
    'footway',
    {
      size,
      worldSize: FOOTWAY_TILE,
      // Low relief: a joint is drawn by the grime settled in it, the same on
      // both sides. At 4.2 the normal map lit one lip and shaded the other,
      // and every joint looked like a step between slabs out of level.
      relief: 1.4,
      shade: (x, y, out) => {
        // Grey interlocking concrete pavers in running bond, as most new
        // Brazilian pavements are laid: 20 x 10 cm blocks, each its own
        // slightly different grey, worn paler down the middle, stained, the
        // joints filled with dark sand and a little moss.
        const u = x / size;
        const v = y / size;
        const w = PAVER;
        const row = Math.floor(y / w);
        const shift = row % 2 === 0 ? 0 : w;
        const sx = (x + shift) % size;
        const col = Math.floor(sx / (2 * w));
        const ex = Math.min(sx % (2 * w), 2 * w - (sx % (2 * w)));
        const ey = Math.min(y % w, w - (y % w));
        const edge = Math.min(ex, ey);
        const face = Math.min(1, Math.max(0, (edge - 0.6) / bevel));
        const chamfer = face * face * (3 - 2 * face);
        const id = cellHash(col, row, 0x5a1b);
        const blockTone = (id - 0.5) * 0.07;
        const speck = fbm(grain, u * 260, v * 260, 260, 3);
        const dirt = fbm(stain, u * 3, v * 3, 3, 4);
        const spot = fbm(blot, u * 30, v * 30, 30, 2);
        const mark = spot > 0.7 ? (spot - 0.7) * 1.2 : 0;
        const worn = Math.max(0, 1 - Math.abs(v - 0.5) * 2.6) * 0.04;
        const tone = 0.54 + blockTone + (speck - 0.5) * 0.08 - (dirt - 0.5) * 0.14 - mark * 0.22 + worn;
        const moss = Math.max(0, dirt - 0.55) * 0.5;
        const jr = 0.28 - moss * 0.05, jg = 0.28 + moss * 0.04, jb = 0.25 - moss * 0.05;
        const sand = 1 - chamfer;
        out.r = tone * 1.0 * chamfer + jr * sand;
        out.g = tone * 0.995 * chamfer + jg * sand;
        out.b = tone * 0.975 * chamfer + jb * sand;
        out.h = 0.15 + chamfer * (0.7 + speck * 0.12);
        out.rough = 0.92 - speck * 0.05 + sand * 0.05;
      },
    },
    anisotropy,
  );
}

/**
 * The kerb: precast concrete, smooth, a shade lighter and cooler than the
 * footway so the kerb line reads as its own edge, jointed every metre.
 *
 * It was speckled granite, nearly white, with a hard pale seam at every
 * third of a tile - which from the play zoom read as a tiling seam, not a
 * joint, and the whole kerb as a chalk line.
 */
function kerbBake(anisotropy: number): SurfaceBake {
  const grain = makeNoise(0x4aa9);
  const cloud = makeNoise(0x9131);
  const size = 256;
  const unit = size / 3;
  return bakeSurface(
    'kerb',
    {
      size,
      worldSize: KERB_TILE,
      relief: 0.9,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        const fine = fbm(grain, u * 60, v * 60, 60, 2);
        const mottle = fbm(cloud, u * 6, v * 6, 6, 3);
        // A joint between units: a soft narrow groove, darker, never paler.
        const j = Math.min(x % unit, unit - (x % unit));
        const joint = j < 1.6 ? 1 - j / 1.6 : 0;
        const unitTone = cellHash(Math.floor(x / unit), 0, 0x77aa);
        // Precast concrete kerb (a guia): paler than the pavers, smooth,
        // with a dark band of road grime where it meets the gutter (the face,
        // low in the band) and tyre scuffs along it.
        const across = y / size;
        const grime = Math.max(0, 1 - across * 2.2) * 0.22 * (0.7 + mottle * 0.6);
        const scuff = fbm(cloud, u * 2, v * 40, 2, 2) > 0.7 ? 0.06 : 0;
        const tone = 0.68 + (unitTone - 0.5) * 0.06 + (fine - 0.5) * 0.05 + (mottle - 0.5) * 0.08 - grime - scuff - joint * 0.25;
        out.r = tone * 1.0;
        out.g = tone * 0.99;
        out.b = tone * 0.97;
        out.h = 0.6 + fine * 0.1 - joint * 0.3;
        out.rough = 0.86 - fine * 0.04;
      },
    },
    anisotropy,
  );
}

function vergeBake(anisotropy: number): SurfaceBake {
  const blades = makeNoise(0x6b21);
  const clumps = makeNoise(0xa30d);
  const size = 512;
  return bakeSurface(
    'verge',
    {
      size,
      worldSize: VERGE_TILE,
      relief: 1.2,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        const fine = fbm(blades, u * 150, v * 150, 150, 2);
        const clump = fbm(clumps, u * 9, v * 9, 9, 4);
        const dry = clump > 0.62 ? (clump - 0.62) * 2.4 : 0;
        // The fine term is kept gentle for the same reason as the asphalt's:
        // the blades are the detail layer's.
        //
        // The tone is the terrain grass's (`render/terrain.ts`), a little
        // fresher because a verge is mown. It used to be half as bright again,
        // and every road ran between two stripes of lawn-green paint.
        // Now the SAME recipe as the terrain grass, so a verge and the lawn
        // beside it meet without a seam. Mown or not, it is one turf; a
        // lighter, greener verge drew a hard stripe along every footway.
        out.r = 0.13 + fine * 0.06 + dry * 0.28 + clump * 0.04;
        out.g = 0.205 + fine * 0.08 + clump * 0.09 + dry * 0.18;
        out.b = 0.078 + fine * 0.04 + dry * 0.08;
        out.h = fine * 0.5 + clump * 0.5;
        out.rough = 0.98;
      },
    },
    anisotropy,
  );
}

function deckBake(anisotropy: number): SurfaceBake {
  const grain = makeNoise(0xcc41);
  const streak = makeNoise(0x3e90);
  const size = 512;
  return bakeSurface(
    'deck',
    {
      size,
      worldSize: DECK_TILE,
      relief: 2.4,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        const speck = fbm(grain, u * 80, v * 80, 80, 3);
        // Vertical weathering runs, the signature of an exposed concrete face.
        const run = fbm(streak, u * 30, v * 2.5, 30, 3);
        const form = y % (size / 4) < 2 ? 1 : 0;
        const tone = 0.66 + (speck - 0.5) * 0.08 - Math.max(0, run - 0.58) * 0.28 - form * 0.09;
        out.r = tone;
        out.g = tone * 0.995;
        out.b = tone * 0.97;
        out.h = form ? 0.2 : 0.5 + speck * 0.5;
        out.rough = 0.9;
      },
    },
    anisotropy,
  );
}

export function createMaterials(anisotropy: number): SceneMaterials {
  const { road, raised } = asphaltBakes(anisotropy);
  const footway = footwayBake(anisotropy);
  const kerb = kerbBake(anisotropy);
  const verge = vergeBake(anisotropy);
  const deck = deckBake(anisotropy);

  const surface = (
    bake: SurfaceBake,
    tint: number,
    roughness: number,
    metalness: number,
    normalScale: number,
    /**
     * Whether the mesh's own `color` attribute multiplies this material.
     *
     * The carriageway needs it: a residential street and a boulevard share a
     * junction and therefore a polygon, so the class colour has to be written
     * per vertex (`asphaltTint` in `roadSurfaces.ts`). That code was already
     * writing the attribute and the mesh builder was already carrying it, but
     * nothing ever turned the flag on, so every class came out the same
     * near-black — which is exactly what a player reported when they asked for
     * residential streets to be greyer.
     */
    vertexColors = false,
  ): MeshStandardMaterial => {
    const material = new MeshStandardMaterial({
      color: new Color(tint),
      map: bake.map,
      normalMap: bake.normalMap,
      roughnessMap: bake.roughnessMap,
      roughness,
      metalness,
      side: FrontSide,
      // Both sides into the shadow map. Left null, three draws a front-sided
      // material's BACK faces there, and a deck is a sheet facing the sun: its
      // top was culled from the shadow pass and only the thin skirts at its
      // edges cast anything, so a raised road threw no shadow on the street
      // under it and read as a road painted on the ground. Surfaces at grade
      // do not cast at all, so this costs them nothing.
      shadowSide: DoubleSide,
      envMapIntensity: 0.55,
      vertexColors,
    });
    material.normalScale.set(normalScale, normalScale);
    return material;
  };

  const materials: MeshStandardMaterial[] = [];
  const keep = <T extends MeshStandardMaterial>(value: T): T => {
    materials.push(value);
    return value;
  };

  const asphalt = keep(surface(road, 0xffffff, 1, 0.02, 1, true));
  const asphaltRaised = keep(surface(raised, 0xffffff, 1, 0.02, 0.9, true));
  // Per-vertex tone: a footway's material (`roadSurfaces.ts` `footwayTint`, docs/VIAS.md V1).
  const footwayMaterial = keep(surface(footway, 0xffffff, 1, 0, 1, true));
  const kerbMaterial = keep(surface(kerb, 0xffffff, 1, 0, 0.85));
  const vergeMaterial = keep(surface(verge, 0xffffff, 1, 0, 0.9));
  const deckMaterial = keep(surface(deck, 0xffffff, 1, 0.02, 1));
  const parapetMaterial = keep(surface(deck, 0xffffff, 1, 0.02, 1));

  // The close-zoom layer. `macroBlur` is how many mip levels softer the macro
  // map is read once the detail is fully in - enough to melt the magnified
  // noise cells, not enough to lose the slab joints.
  applyDetail(asphalt, { kind: 'asphalt', macroTile: ASPHALT_TILE, albedo: 0.6, normal: 0.65, macroBlur: 1.6 }, anisotropy);
  applyDetail(asphaltRaised, { kind: 'asphalt', macroTile: ASPHALT_TILE, albedo: 0.6, normal: 0.65, macroBlur: 1.6 }, anisotropy);
  applyDetail(footwayMaterial, { kind: 'concrete', macroTile: FOOTWAY_TILE, albedo: 0.7, normal: 0.8, macroBlur: 0.6 }, anisotropy);
  // The marks of their use along their edges (`mesh/roadEdges.ts`).
  applyRoadEdges(asphalt, 'carriageway');
  applyRoadEdges(asphaltRaised, 'carriageway');
  applyRoadEdges(footwayMaterial, 'footway');
  applyDetail(kerbMaterial, { kind: 'concrete', macroTile: KERB_TILE, albedo: 0.55, normal: 0.7, macroBlur: 0.8 }, anisotropy);
  applyDetail(vergeMaterial, { kind: 'grass', macroTile: VERGE_TILE, albedo: 1, normal: 1.2, macroBlur: 2 }, anisotropy);
  applyDetail(deckMaterial, { kind: 'concrete', macroTile: DECK_TILE, albedo: 0.6, normal: 0.8, macroBlur: 1 }, anisotropy);
  applyDetail(parapetMaterial, { kind: 'concrete', macroTile: DECK_TILE, albedo: 0.6, normal: 0.8, macroBlur: 1 }, anisotropy);
  // The lots coloured into the street's own surfaces (`lotOverlay.ts`): a
  // lot's front line lies on the footway's edge, and a lot drawn point by
  // point can cross a carriageway. The terrain does the same (`terrain.ts`).
  applyLotOverlay(asphalt, 'asphalt');
  applyLotOverlay(asphaltRaised, 'asphalt-raised');
  applyLotOverlay(footwayMaterial, 'footway');
  applyLotOverlay(kerbMaterial, 'kerb');
  applyLotOverlay(vergeMaterial, 'verge');
  applyLotOverlay(deckMaterial, 'deck');

  return {
    asphalt,
    asphaltRaised,
    footway: footwayMaterial,
    kerb: kerbMaterial,
    verge: vergeMaterial,
    deck: deckMaterial,
    parapet: parapetMaterial,
    concrete: keep(
      new MeshStandardMaterial({
        color: 0x9fa4a2,
        map: deck.map,
        normalMap: deck.normalMap,
        roughnessMap: deck.roughnessMap,
        roughness: 1,
        metalness: 0.02,
        side: FrontSide,
      }),
    ),
    steel: keep(
      new MeshStandardMaterial({
        color: 0x8e979a,
        roughness: 0.42,
        metalness: 0.72,
        side: DoubleSide,
      }),
    ),
    scale: {
      asphalt: ASPHALT_TILE,
      footway: FOOTWAY_TILE,
      kerb: KERB_TILE,
      verge: VERGE_TILE,
      deck: DECK_TILE,
    },
    setDetail(enabled) {
      detailSwitch.value = enabled ? 1 : 0;
    },
    dispose() {
      for (const material of materials) material.dispose();
      // The baked textures are shared and cached by key, so they are the
      // material set's to release — disposing a material alone leaves every
      // canvas and every GPU texture behind.
      disposeBakedTextures();
      disposeDetailTextures();
    },
  };
}
