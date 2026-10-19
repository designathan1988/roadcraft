import { type JobTicket, canQueueJobs, submitJob } from '../jobs/jobPool';
import type { LandStrokeAnswer, LandStrokeJob } from './landStroke';

/** A DAB'S WORK ON A PLATE, ASKED OF THE JOB POOL (`landStroke.worker.ts`) */

/** Whether a dab's work can go off the page here (a browser with workers); the page does it itself otherwise. */
export const landStrokeOffPage = (): boolean => canQueueJobs();

/** `job` run by the pool's first free worker, its buffers handed over (the asker sends copies); `failed`: the asker does it on the page. */
export function askLandStroke<J extends LandStrokeJob>(job: J, transfer: Transferable[], done: (answer: LandStrokeAnswer<J>) => void,
  failed: (message: string) => void): JobTicket {
  return submitJob({
    service: 'landStroke',
    key: null,
    // Ahead of the jobs ranked by their distance to the eye: the brush is where the player looks, and the drawn ground waits on it.
    priority: 0,
    write: () => ({ data: job, transfer }),
    done: (reply) => {
      const { answer, error } = reply as { answer?: LandStrokeAnswer<J>; error?: string };
      if (answer === undefined) failed(error ?? 'no answer');
      else done(answer);
    },
    failed,
  });
}
