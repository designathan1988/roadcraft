import { reliefHeight, type ReliefVersion } from '@world/terrain';
import { buildPlateMesh } from './plateMesh';
import { cornerLand, woodsBase } from './woodsBase';
import type { JobScope } from '../jobs/jobScope';

/** This service of the job system (`job.worker.ts`): its messages answered on the scope it is given. */
export function serve(self: JobScope): void {
  /** A plate of the map's land off the page's thread (`flatGroundPool.ts`) */
  interface Ask { readonly id: number; readonly relief: ReliefVersion; readonly cx: number; readonly cy: number; readonly half: number; readonly cell: number; readonly side: number; readonly base: number }

  self.onmessage = (event: MessageEvent<Ask>) => {
    const { id, relief, cx, cy, half, cell, side, base } = event.data;
    try {
      const heights = new Float64Array(side * side);
      for (let j = 0; j < side; j++) {
        const y = cy + half - j * cell;
        for (let i = 0; i < side; i++) heights[j * side + i] = reliefHeight(relief, cx - half + i * cell, y);
      }
      const mesh = buildPlateMesh(heights, side, half, cell, base);
      // The woods' density but the ecosystem's share, on the same natural land (`woodsBase.ts`).
      const natural = cornerLand(mesh.heights, mesh.flip, side, half, cell, (x, y) => base + reliefHeight(relief, cx + x, cy + y));
      mesh.woods = woodsBase(natural, half, cx, cy);
      (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ id, mesh },
        [mesh.heights.buffer, mesh.flip.buffer, mesh.texels.buffer, mesh.levels.buffer, mesh.woods.buffer]);
    } catch (error) {
      self.postMessage({ id, error: String(error) });
    }
  };
}
