import { type GrowAsk, GrowthReplica } from '@editor/growthReplica';

/**
 * The growth's buildings made off the page (`growthPool.ts`): each lot asked
 * for answered by `GrowthReplica.handle` - the building made for it, null
 * when nothing fits, or a miss - with the ask's id. What it keeps of the town
 * lives in the replica, brought up to date by each ask.
 */
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
