import type { JobScope } from '../jobs/jobScope';
import { buildFarRoadCells, type FarRoadInput } from './networkFarRoadsBuild';

/** This service of the job system (`job.worker.ts`): the whole network's far roads filled off the page (`networkFarRoads.ts`). */
export function serve(self: JobScope): void {
  self.onmessage = (event: MessageEvent<{ readonly id: number; readonly input: FarRoadInput }>) => {
    const { id, input } = event.data;
    try {
      const cells = buildFarRoadCells(input);
      const transfer: ArrayBuffer[] = [];
      for (const c of cells) transfer.push(c.positions.buffer as ArrayBuffer, c.colors.buffer as ArrayBuffer, c.indices.buffer as ArrayBuffer);
      self.postMessage({ id, cells }, transfer);
    } catch (error) {
      console.error('[roads] the far roads could not be made', error);
      self.postMessage({ id, error: String((error as Error)?.stack ?? error) });
    }
  };
}
