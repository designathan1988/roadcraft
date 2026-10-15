import { createLandLighter, type LightGrid, type LightRequest } from './terrainLightCompute';
import type { JobScope } from '../jobs/jobScope';

/** This service of the job system (`jobs/job.worker.ts`): its messages answered on the scope it is given. */
export function serve(self: JobScope): void {
  /** The land's light off the page's thread (`terrainLightCompute.ts`): the page sends a copy of the heights */
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
}
