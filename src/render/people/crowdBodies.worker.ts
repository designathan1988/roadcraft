import type { JobScope } from '../../jobs/jobScope';
import { type BodyBakeJob, bakeBodyPixels } from './bodyBake';

/** This service of the job system (`job.worker.ts`): a procedural class's new body baked off the page, from the basis it shares (`crowdBodies.ts`). */
export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<BodyBakeJob>) => {
    const pixels = bakeBodyPixels(event.data);
    scope.postMessage(pixels, [pixels.buffer]);
  };
}
