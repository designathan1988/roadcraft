import { type GrowAsk, GrowthReplica } from '@editor/growthReplica';
import type { JobScope } from './jobs/jobScope';

/** This service of the job system (`job.worker.ts`): the growth's buildings made off the page (`growthPool.ts`), one replica per port. */
export function serve(self: JobScope): void {
  const replica = new GrowthReplica();
  self.onmessage = (event: MessageEvent<GrowAsk>) => {
    const ask = event.data;
    try {
      self.postMessage(replica.handle(ask));
    } catch (error) {
      // Told and answered: the page sets the lot aside and the growth goes on (`growthFeed.ts`).
      console.error('[growth] a lot failed in the growth worker', error);
      self.postMessage({ id: ask.id, error: String(error) });
    }
  };
}
