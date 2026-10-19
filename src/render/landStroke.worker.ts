import { type LandStrokeJob, type LandStrokeScratch, runLandStroke } from './landStroke';
import type { JobScope } from '../jobs/jobScope';

/** This service of the job system (`job.worker.ts`): a dab's work on a plate (`landStroke.ts`), each job carrying what it reads, so nothing of a plate is kept here. */
export function serve(self: JobScope): void {
  const scratch: LandStrokeScratch = { woods: null };
  self.onmessage = (event: MessageEvent<LandStrokeJob>) => {
    try {
      const { answer, transfer } = runLandStroke(event.data, scratch);
      self.postMessage({ answer }, transfer);
    } catch (error) {
      console.error(`[terrain] a dab's ${event.data.kind} failed in its worker`, error);
      // Answered, never thrown: a throw here would take the pool's worker down with every job on it (`landStrokePool.ts` does it on the page).
      self.postMessage({ error: String(error) });
    }
  };
}
