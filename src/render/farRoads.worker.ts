import { type FarRoadJob, type FarRoadReply, derivedRoadCache, farRoadReplyBuffers, runFarRoadJob } from './farRoadTiles';
import type { JobScope } from '../jobs/jobScope';

/** THE FAR ROADS IN THE JOB SYSTEM'S QUEUE (`farRoads.ts`): each job a node of the tree, read from and kept in the player's browser store here, off the page; answered once kept */
export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<FarRoadJob>) => void answer(scope, event.data);
}

async function answer(scope: JobScope, job: FarRoadJob): Promise<void> {
  let reply: FarRoadReply;
  try {
    reply = await runFarRoadJob(job, derivedRoadCache);
  } catch (error) {
    console.error('[roads] far worker', error);
    reply = { kind: 'farError', node: job.node, sig: job.sig, message: String((error as Error)?.stack ?? error) };
  }
  scope.postMessage(reply, farRoadReplyBuffers(reply));
}
