import { type LandStrokeJob, runLandStroke } from './landStroke';
import type { JobScope } from '../jobs/jobScope';

/** This service of the job system (`job.worker.ts`): a dab's work on a plate (`landStroke.ts`), each job carrying what it reads, so nothing of a plate is kept here. */
export function serve(self: JobScope): void {
  self.onmessage = (event: MessageEvent<LandStrokeJob>) => {
    try {
      const { answer, transfer } = runLandStroke(event.data);
      self.postMessage({ answer }, transfer);
    } catch (error) {
      // Answered, never thrown: a throw here would take the pool's worker down with every job on it (`landStrokePool.ts` does it on the page).
      self.postMessage({ error: String(error) });
    }
  };
}
