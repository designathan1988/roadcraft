import { FINISHES } from '@world/buildings/materials';
import { surfaceTexels, type SurfaceRecipe } from '../mesh/textureBaker';
import { detailTexels } from './detailRecipes';
import { LOOKS } from './finishRecipes';
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

/** One texture at a time, so the build holds one recipe's texels at once. */
export function* bakeCatalogue(): Generator<BakedTexture> {
  for (const { key, recipe, mapOnly } of roadRecipes()) yield* surface(key, recipe, mapOnly === true);
  for (const finish of FINISHES) {
    const look = LOOKS[finish];
    yield* surface(`building-${finish}`, {
      size: look.size, worldSize: look.worldSize, relief: look.relief, shade: look.shade(look.size), ...(look.metallic ? { metallic: true } : {}),
    });
  }
  // The land reads the grass's colour and relief, the dirt's colour, the rocks' colour and relief as arrays (`terrain.ts` `terrainBakes`)
  const land = terrainRecipes();
  const grass = surfaceTexels(land.grass);
  yield { name: 'terrain-grass:map', use: 'color', size: grass.size, layers: [grass.map] };
  yield { name: 'terrain-grass:normal', use: 'normal', size: grass.size, layers: [grass.normal] };
  const dirt = surfaceTexels(land.dirt);
  yield { name: 'terrain-dirt:map', use: 'color', size: dirt.size, layers: [dirt.map] };
  const rocks = land.rocks.map(surfaceTexels);
  yield { name: 'terrain-rock:map', use: 'color', size: rocks[0]!.size, layers: rocks.map((rock) => rock.map) };
  yield { name: 'terrain-rock:normal', use: 'normal', size: rocks[0]!.size, layers: rocks.map((rock) => rock.normal) };
  // The close-up layers: on the street surfaces (`mesh/detailLayer.ts`), and grass and soil as the land's two-layer arrays
  for (const kind of ['asphalt', 'concrete'] as const) {
    const detail = detailTexels(kind);
    yield { name: `${kind}:detail`, use: 'data', size: detail.size, layers: [detail.map] };
    yield { name: `${kind}:detail-normal`, use: 'normal', size: detail.size, layers: [detail.normal] };
  }
  const grassDetail = detailTexels('grass');
  const soilDetail = detailTexels('soil');
  yield { name: 'grass:detail', use: 'data', size: grassDetail.size, layers: [grassDetail.map] };
  yield { name: 'grass:detail-normal', use: 'normal', size: grassDetail.size, layers: [grassDetail.normal] };
  yield { name: 'terrain-detail:map', use: 'data', size: grassDetail.size, layers: [grassDetail.map, soilDetail.map] };
  yield { name: 'terrain-detail:normal', use: 'normal', size: grassDetail.size, layers: [grassDetail.normal, soilDetail.normal] };
}
