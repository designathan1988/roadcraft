import { type NearTileJob, type NearTileReply, derivedNearCache } from './nearTileBake';
import { nearJobBuffers, runNearJob } from './nearBakers';
import type { JobScope } from '../jobs/jobScope';

/** THE NEAR PRODUCTS IN THE JOB SYSTEM'S QUEUE (`nearTiles.ts`): each job a kind of a tile, read from and kept in the player's browser store here, off the page; answered once kept */
export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<NearTileJob>) => void answer(scope, event.data);
}

async function answer(scope: JobScope, job: NearTileJob): Promise<void> {
  let reply: NearTileReply;
  try {
    reply = await runNearJob(job, derivedNearCache);
  } catch (error) {
    console.error('[near] tile worker', error);
    reply = { kind: 'nearError', node: job.node, sig: job.sig, message: String((error as Error)?.stack ?? error) };
  }
  scope.postMessage(reply, nearJobBuffers(job, reply));
}
