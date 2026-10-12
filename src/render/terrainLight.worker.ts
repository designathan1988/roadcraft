import { createLandLighter, type LightGrid, type LightRequest } from './terrainLightCompute';

/**
 * The land's light off the page's thread (`terrainLightCompute.ts`): the page
 * sends a copy of the heights (transferred, not copied again) with the sun and
 * what moved; the light of the corners that can have changed comes back,
 * transferred. The land's shape is kept here between requests - one per
 * `key` when the worker serves many lands (the planet's plates share a few
 * workers, `terrainLightPool.ts`), and the key goes back with the answer.
 */
let grid: LightGrid | null = null;
const lights = new Map<number, ReturnType<typeof createLandLighter>>();

self.onmessage = (event: MessageEvent<{ grid: LightGrid } | (LightRequest & { key?: number })>) => {
  const data = event.data;
  if ('grid' in data) {
    grid = data.grid;
    lights.clear();
    return;
  }
  if (!grid) return;
  const key = data.key ?? -1;
  let light = lights.get(key);
  if (!light) lights.set(key, light = createLandLighter(grid));
  try {
    const result = light(data);
    (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ ...result, key }, [result.rgba.buffer]);
  } catch (error) {
    self.postMessage({ error: String(error), key });
  }
};
