import { FINISHES } from '@world/buildings/materials';
import { surfaceTexels, type SurfaceRecipe } from '../mesh/textureBaker';
import { detailTexels } from './detailRecipes';
import { FINISH_LAYER_SIZE, LOOKS, finishTiles } from './finishRecipes';
import { roadRecipes } from './roadRecipes';
import { terrainRecipes } from './terrainRecipes';

/** Every texture the game bakes, run at build time by `scripts/vite/surface-bake-plugin.ts` (never during play) and loaded by `surfaceBakeClient.ts` */

/** How the texels are read (`scripts/vite/ktx2.ts` `TextureUse`). */
type TextureUse = 'color' | 'normal' | 'data';

interface BakedTexture {
  /** Its name in the game (`surfaceTextures.ts`): `<surface>:map`, `:normal`, `:rough`, `<kind>:detail`, `:detail-normal`. */
  readonly name: string;
  readonly use: TextureUse;
  readonly size: number;
  /** RGBA texels, rows top first as a canvas holds them: one per layer, more than one for a texture array. */
  readonly layers: readonly Uint8Array[];
  /** Alpha-tested (0..1): its mipmaps keep the share of texels that pass (`ktx2.ts` `mipChain`). */
  readonly alphaRef?: number;
}

/** A surface's three maps, or its colour alone. */
function* surface(key: string, recipe: SurfaceRecipe, mapOnly = false): Generator<BakedTexture> {
  const texels = surfaceTexels(recipe);
  yield { name: `${key}:map`, use: 'color', size: texels.size, layers: [texels.map] };
  if (mapOnly) return;
  yield { name: `${key}:normal`, use: 'normal', size: texels.size, layers: [texels.normal] };
  yield { name: `${key}:rough`, use: 'data', size: texels.size, layers: [texels.rough] };
}

/** A square of texels repeated `tiles` times each way: its mip chain is its own chain repeated, level by level (a 2 x 2 box never straddles two copies). */
export function tiledTexels(texels: Uint8Array, size: number, tiles: number): Uint8Array {
  if (tiles === 1) return texels;
  const row = size * 4;
  const out = new Uint8Array(texels.length * tiles * tiles);
  for (let y = 0; y < size * tiles; y++) {
    const source = texels.subarray((y % size) * row, ((y % size) + 1) * row);
    for (let t = 0; t < tiles; t++) out.set(source, (y * tiles + t) * row);
  }
  return out;
}

/** The finishes as one texture array per map, a layer per finish in `FINISHES` order (`buildings/finishes.ts`): a cell's shells in one draw. */
function* finishArrays(): Generator<BakedTexture> {
  const layers = FINISHES.map((finish) => {
    const look = LOOKS[finish];
    const texels = surfaceTexels({
      size: look.size, worldSize: look.worldSize, relief: look.relief, shade: look.shade(look.size), ...(look.metallic ? { metallic: true } : {}),
    });
    // A smaller finish repeated in its layer: the same texels a metre, its uv scaled by as much (`finishes.ts` `finishLookTable`).
    const tiles = finishTiles(finish);
    return { map: tiledTexels(texels.map, look.size, tiles), normal: tiledTexels(texels.normal, look.size, tiles), rough: tiledTexels(texels.rough, look.size, tiles) };
  });
  yield { name: 'building-finishes:map', use: 'color', size: FINISH_LAYER_SIZE, layers: layers.map((l) => l.map) };
  yield { name: 'building-finishes:normal', use: 'normal', size: FINISH_LAYER_SIZE, layers: layers.map((l) => l.normal) };
  yield { name: 'building-finishes:rough', use: 'data', size: FINISH_LAYER_SIZE, layers: layers.map((l) => l.rough) };
}

/** One texture at a time, so the build holds one recipe's texels at once (the finishes' arrays: their layers). */
export function* bakeCatalogue(): Generator<BakedTexture> {
  for (const { key, recipe, mapOnly } of roadRecipes()) yield* surface(key, recipe, mapOnly === true);
  yield* finishArrays();
  // The land reads the grass's colour and relief (`terrain.ts` `terrainBakes`)
  const land = terrainRecipes();
  const grass = surfaceTexels(land.grass);
  yield { name: 'terrain-grass:map', use: 'color', size: grass.size, layers: [grass.map] };
  yield { name: 'terrain-grass:normal', use: 'normal', size: grass.size, layers: [grass.normal] };
  // The close-up layers on the street surfaces (`mesh/detailLayer.ts`)
  for (const kind of ['asphalt', 'concrete'] as const) {
    const detail = detailTexels(kind);
    yield { name: `${kind}:detail`, use: 'data', size: detail.size, layers: [detail.map] };
    yield { name: `${kind}:detail-normal`, use: 'normal', size: detail.size, layers: [detail.normal] };
  }
  const grassDetail = detailTexels('grass');
  const soilDetail = detailTexels('soil');
  yield { name: 'grass:detail', use: 'data', size: grassDetail.size, layers: [grassDetail.map] };
  yield { name: 'grass:detail-normal', use: 'normal', size: grassDetail.size, layers: [grassDetail.normal] };
  // DO NOT give the land a texture unit per family: its program ran out of the 16 a fragment shader has
  const rocks = land.rocks.map(surfaceTexels);
  const dirt = surfaceTexels(land.dirt);
  const size = grassDetail.size;
  yield {
    name: 'terrain-land:map', use: 'color', size,
    layers: [srgbEncoded(grassDetail.map), srgbEncoded(soilDetail.map), ...rocks.map((rock) => resized(rock.map, rock.size, size)), resized(dirt.map, dirt.size, size)],
  };
  yield {
    name: 'terrain-land:normal', use: 'normal', size,
    layers: [grassDetail.normal, soilDetail.normal, ...rocks.map((rock) => resized(rock.normal, rock.size, size))],
  };
}

/** Linear bytes (data) as sRGB-encoded ones: kept in a colour array, they read back as themselves (IEC 61966-2-1). */
function srgbEncoded(texels: Uint8Array): Uint8Array {
  const table = Uint8Array.from({ length: 256 }, (_, i) => {
    const c = i / 255;
    return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
  });
  // Alpha is never decoded.
  return texels.map((v, k) => ((k & 3) === 3 ? v : table[v]!));
}

/** Texels of a `from`-sided square at `to` texels a side, bilinear between texel centres, wrapping as the texture repeats (unchanged when equal). */
function resized(texels: Uint8Array, from: number, to: number): Uint8Array {
  if (from === to) return texels;
  const out = new Uint8Array(to * to * 4);
  for (let y = 0; y < to; y++) {
    const sy = ((y + 0.5) * from) / to - 0.5;
    const y0 = Math.floor(sy), fy = sy - y0;
    const ya = ((y0 % from) + from) % from, yb = (ya + 1) % from;
    for (let x = 0; x < to; x++) {
      const sx = ((x + 0.5) * from) / to - 0.5;
      const x0 = Math.floor(sx), fx = sx - x0;
      const xa = ((x0 % from) + from) % from, xb = (xa + 1) % from;
      for (let c = 0; c < 4; c++) {
        const top = texels[(ya * from + xa) * 4 + c]! * (1 - fx) + texels[(ya * from + xb) * 4 + c]! * fx;
        const bottom = texels[(yb * from + xa) * 4 + c]! * (1 - fx) + texels[(yb * from + xb) * 4 + c]! * fx;
        out[(y * to + x) * 4 + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}
