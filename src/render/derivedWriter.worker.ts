import { keepDerivedManyCommitted } from './derivedCache';
import type { JobScope } from '../jobs/jobScope';

/** This service of the job system (`job.worker.ts`): its messages answered on the scope it is given. */
export function serve(self: JobScope): void {
  /** DO NOT write them from the page */
  self.onmessage = (event: MessageEvent<{ readonly id: number; readonly prefix: string; readonly entries: readonly [string, unknown][] }>) => {
    // Answered on the commit, not on the queueing: the page holds its bytes in flight under a ceiling (`DerivedWriterLane`).
    const { id } = event.data;
    // Answered whatever came of it: a write not kept is made again next time, its bytes free again on the page.
    void keepDerivedManyCommitted(event.data.prefix, new Map(event.data.entries))
      .catch((error: unknown) => console.error('[derived] the road tiles were not kept', error))
      .finally(() => self.postMessage({ done: id }));
  };
}
