import { createMaterials } from './materials';
import { terrainBakes } from './terrain';
import { createFinishMaterials } from './buildings/finishes';
import { detailTextures, takeDetailPixels, type DetailBakePixels } from './mesh/detailLayer';
import { takeBakedSurfacePixels, type BakedPixels } from './mesh/textureBaker';
import { forgetOtherDerived, keepDerivedDurably, readDerived } from './derivedCache';

// The recipes use only the two-dimensional canvas API. Give them OffscreenCanvas
// here so the same source computes every texel without touching the DOM thread.
Object.defineProperty(globalThis, 'document', {
  value: { createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`Unexpected element in surface baker: ${tag}`);
    return new OffscreenCanvas(1, 1);
  } },
});

interface SurfaceBakeResult {
  readonly surfaces: readonly BakedPixels[];
  readonly details: readonly DetailBakePixels[];
}

const post = (result: SurfaceBakeResult): void => {
  const buffers = [...result.surfaces.map(item => item.rgba), ...result.details.flatMap(item => [item.map.rgba, item.normal.rgba])];
  (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(result, buffers);
};

/**
 * The page sends the fingerprint of the recipes' code (`cook-plugin.ts`,
 * `__SURFACE_BAKE_HASH__`; null when there is none). The same texels as the
 * last time that code baked them are read back from the derived data kept in
 * the browser (`derivedCache.ts`) - here, off the page's thread - and baked
 * only when they are not there: every opening of the game baked them all
 * again, and the page waited for it before it could draw anything.
 */
self.onmessage = (event: MessageEvent<{ hash: string | null }>) => {
  const key = event.data.hash ? `surface:${event.data.hash}:texels` : null;
  // An older build's texels (some 70 MB each) are not kept beside these.
  if (event.data.hash) forgetOtherDerived('surface', event.data.hash);
  void (async () => {
    const kept = key ? await readDerived<SurfaceBakeResult>(key) : undefined;
    if (kept && Array.isArray(kept.surfaces) && Array.isArray(kept.details)) {
      post(kept);
      self.close();
      return;
    }
    let result: SurfaceBakeResult;
    try {
      createMaterials(1);
      terrainBakes(1);
      createFinishMaterials(1);
      detailTextures('soil', 1);
      result = { surfaces: takeBakedSurfacePixels(), details: takeDetailPixels() };
    } catch (error) {
      self.postMessage({ error: String(error) });
      return;
    }
    // Copied into the store before its buffers are handed over (`put` copies
    // them, here); the page has them at once. This worker closes itself only
    // once the write has committed: stopped from the page as soon as it
    // posted (`terminate()` stops it at once), the write was lost and every
    // opening baked them all again, three seconds before the first frame.
    const write = key ? await keepDerivedDurably(key, result) : null;
    post(result);
    await write?.committed;
    self.close();
  })();
};
