import { type CellJob, ShellWriter, type WorkReply, replyBuffers, runCellJob, workerReads } from './cellWork';
import { type FarJob, type FarReply, derivedFarCache, farReplyBuffers, runFarJob } from './farTiles';
import type { JobScope } from '../../jobs/jobScope';

/** THE BUILDINGS' CELLS IN THE JOB SYSTEM'S QUEUE (`cellPool.ts`): each job carries all it reads, the ground read off shared memory; one answer a job */
/** The far levels' jobs too (`farTiles.ts`): read from and kept in the player's browser store here, off the page; answered once kept. */
export function serve(scope: JobScope): void {
  // The thread's shell and rows, written again for every job it runs (`ShellWriter`): one job at a time here.
  const writer = new ShellWriter();
  scope.onmessage = (event: MessageEvent<CellJob | FarJob>) => {
    const job = event.data;
    if ('far' in job) { void answerFar(scope, job); return; }
    let reply: WorkReply;
    try {
      reply = runCellJob(job, workerReads(job, writer));
    } catch (error) {
      // Reported to the page, which puts this cell together itself (`cellPool.ts`).
      console.error('[buildings] cell worker', error);
      reply = { kind: 'error', job: job.id, message: String((error as Error)?.stack ?? error) };
    }
    scope.postMessage(reply, replyBuffers(reply));
  };
}

async function answerFar(scope: JobScope, job: FarJob): Promise<void> {
  let reply: FarReply;
  try {
    reply = await runFarJob(job, derivedFarCache);
  } catch (error) {
    console.error('[buildings] far worker', error);
    reply = { kind: 'farError', node: job.node, sig: job.sig, message: String((error as Error)?.stack ?? error) };
  }
  scope.postMessage(reply, farReplyBuffers(reply));
}
