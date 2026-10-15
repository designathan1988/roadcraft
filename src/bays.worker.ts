import { type BayShare, baysOfShare } from '@sim/agents/lotBays';
import type { JobScope } from './jobs/jobScope';

/** This service of the job system (`jobs/job.worker.ts`): its messages answered on the scope it is given. */
export function serve(self: JobScope): void {
  /** The lots' bays off the page's thread (`bayPool.ts`): each lot of a share by `bayRows` itself on what the page sent */
  const BEAT_MS = 500;

  self.onmessage = (event: MessageEvent<{ id: number; share: BayShare }>) => {
    const { id, share } = event.data;
    let spoke = performance.now();
    const beat = (): void => {
      const now = performance.now();
      if (now - spoke >= BEAT_MS) { spoke = now; self.postMessage({ id, beat: true }); }
    };
    try {
      self.postMessage({ id, bays: baysOfShare(share, beat) });
    } catch (error) {
      // Reported here and answered: the page works the lots out itself (`parking.ts` `baysNow`).
      console.error('[parking] a share of lots failed in its worker', error);
      self.postMessage({ id, error: String(error) });
    }
  };
}
