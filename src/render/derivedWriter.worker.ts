import { keepDerivedMany } from './derivedCache';
import type { JobScope } from '../jobs/jobScope';

/** This service of the job system (`jobs/job.worker.ts`): its messages answered on the scope it is given. */
export function serve(self: JobScope): void {
  /** DO NOT write them from the page */
  self.onmessage = (event: MessageEvent<{ readonly prefix: string; readonly entries: readonly [string, unknown][] }>) => {
    void keepDerivedMany(event.data.prefix, new Map(event.data.entries));
  };
}
