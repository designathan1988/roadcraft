import { type GroundJob, ShapeScratch, runGroundJob } from './groundShape';
import type { JobScope } from '../jobs/jobScope';

/** This service of the job system (`jobs/job.worker.ts`): its messages answered on the scope it is given. */
export function serve(self: JobScope): void {
  /** The ground's worker (`groundShapePool.ts`): a shaping pass's corners, or two solves' blocks digested */
  /** This worker's scratch, sized to a plate by its first pass. */
  const scratch = new ShapeScratch();

  self.onmessage = (event: MessageEvent<{ readonly id: number; readonly job: GroundJob }>) => {
    const { id, job } = event.data;
    try {
      const { answer, transfer } = runGroundJob(job, scratch);
      (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ id, answer }, transfer);
    } catch (error) {
      // Reported here and answered: the page does this job itself (`groundShapePool.ts`).
      console.error('[ground] a job failed in its worker', error);
      self.postMessage({ id, error: String(error) });
    }
  };
}
