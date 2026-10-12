import { primeDetailPixels, type DetailBakePixels } from './mesh/detailLayer';
import { primeBakedSurfacePixels, type BakedPixels } from './mesh/textureBaker';

interface SurfaceBakeResult {
  readonly surfaces: readonly BakedPixels[];
  readonly details: readonly DetailBakePixels[];
}

declare const __SURFACE_BAKE_HASH__: string | undefined;
/**
 * The fingerprint of the recipes' code (`cook-plugin.ts`), read here and sent
 * to the worker: its texels are kept in the browser under it
 * (`derivedCache.ts`) and read back instead of baked again.
 */
const BAKE_HASH = typeof __SURFACE_BAKE_HASH__ !== 'undefined' ? __SURFACE_BAKE_HASH__ : null;

/** Start the exact procedural recipes (or read back the texels they made) while the main thread builds the town. */
export function startSurfaceBake(): Promise<SurfaceBakeResult | null> {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./surfaceBake.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      console.warn('Surface bake worker unavailable; using the canvas recipes on the main thread.', error);
      resolve(null);
      return;
    }
    worker.onmessage = (event: MessageEvent<SurfaceBakeResult | { error: string }>) => {
      if ('error' in event.data) {
        worker.terminate();
        console.warn('Surface bake worker failed; using the canvas recipes on the main thread.', event.data.error);
        resolve(null);
      } else {
        // Not stopped here: it is still keeping the texels it just sent
        // (`derivedCache.ts`), and closes itself once they are kept.
        resolve(event.data);
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      console.warn('Surface bake worker failed; using the canvas recipes on the main thread.', event.message);
      resolve(null);
    };
    worker.onmessageerror = () => {
      worker.terminate();
      console.warn('Surface bake pixels could not be transferred; using the canvas recipes on the main thread.');
      resolve(null);
    };
    worker.postMessage({ hash: BAKE_HASH });
  });
}

/** Install ready texels before the first material is constructed or drawn. */
export function primeSurfaceBake(result: SurfaceBakeResult | null): void {
  if (!result) return;
  primeBakedSurfacePixels(result.surfaces);
  primeDetailPixels(result.details);
}
