import { type CellJob, type WorkReply, replyBuffers, runCellJob, workerReads } from './cellWork';
import type { JobScope } from '../../jobs/jobScope';

/** THE BUILDINGS' CELLS IN THE JOB SYSTEM'S QUEUE (`cellPool.ts`): each job carries all it reads, the ground read off shared memory; one answer a job */
export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<CellJob>) => {
    const job = event.data;
    let reply: WorkReply;
    try {
      reply = runCellJob(job, workerReads(job));
    } catch (error) {
      // Reported to the page, which puts this cell together itself (`cellPool.ts`).
      console.error('[buildings] cell worker', error);
      reply = { kind: 'error', job: job.id, message: String((error as Error)?.stack ?? error) };
    }
    scope.postMessage(reply, replyBuffers(reply));
  };
}
