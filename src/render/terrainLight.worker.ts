import { landSlope, type LightGrid, type LightRequest } from './terrainLightCompute';
import type { JobScope } from '../jobs/jobScope';

/** This service of the job system (`job.worker.ts`): its messages answered on the scope it is given. */
export function serve(self: JobScope): void {
  /** The land's slope off the page's thread (`terrainLightCompute.ts`): each request carries the heights it reads, so nothing of a plate is kept here */
  let grid: LightGrid | null = null;

  self.onmessage = (event: MessageEvent<{ grid: LightGrid } | (LightRequest & { key?: number })>) => {
    const data = event.data;
    if ('grid' in data) {
      grid = data.grid;
      return;
    }
    if (!grid) return;
    const key = data.key ?? -1;
    try {
      const result = landSlope(grid, data);
      (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ ...result, key }, [result.slope.buffer]);
    } catch (error) {
      self.postMessage({ error: String(error), key });
    }
  };
}
