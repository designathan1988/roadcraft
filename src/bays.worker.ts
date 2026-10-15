import { type BayShare, baysOfShare } from '@sim/agents/lotBays';

/**
 * The lots' bays off the page's thread (`bayPool.ts`): each lot of a share by
 * `bayRows` itself on what the page sent (`lotBays.ts` `baysOfShare`),
 * answered with the job's id. While it works it says so at least every
 * `BEAT_MS`, so the pool's watchdog hears it is alive.
 */
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
