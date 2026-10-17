import { describe, expect, it, vi } from 'vitest';

import type { NearTileJob } from '@render/nearTileBake';
import { tileKey } from '@world/tiles';

/** A TILE'S NEAR PRODUCTS ASKED BEHIND THE CURTAIN ARE ASKED AGAIN IN THE DETAIL'S BAND ONCE THE TOWN SHOWS (`nearTiles.ts` nearRunner) */

/** The jobs the queue was handed, and whether each is still waiting. */
const asked: { priority: number; write: () => unknown; cancelled: boolean }[] = [];
vi.mock('@/jobs/jobPool', async (original) => ({
  ...(await original<typeof import('@/jobs/jobPool')>()),
  canQueueJobs: () => true,
  shortWorkers: () => 8,
  submitJob: (spec: { priority: number; write: () => unknown }) => {
    const job = { priority: spec.priority, write: spec.write, cancelled: false };
    asked.push(job);
    return { cancel: () => { job.cancelled = true; }, get pending() { return !job.cancelled; } };
  },
}));

const job = (i: number): NearTileJob => ({ node: `${i},0`, asks: [], prefix: null, heavy: false, tiles: [{ key: tileKey(i, 0), version: 1 }], ground: { ground: null, naturalIsGround: true } });

describe('the near products runner', () => {
  it('asks a job waiting behind the curtain again in the detail band once the town shows, never one a worker took', async () => {
    const { nearRunner } = await import('@render/nearTiles');
    let hidden = true;
    const runner = nearRunner(() => hidden);
    runner.run(job(1), () => {});
    runner.run(job(2), () => {});
    expect(asked).toHaveLength(2);
    const later = asked[0]!.priority;
    // A worker takes the second before the curtain lifts.
    asked[1]!.write();
    hidden = false;
    runner.reband();
    expect(asked).toHaveLength(3);
    expect(asked[0]!.cancelled).toBe(true);
    expect(asked[1]!.cancelled).toBe(false);
    expect(asked[2]!.priority).toBeLessThan(later);
    // Nothing changed: nothing asked again.
    runner.reband();
    expect(asked).toHaveLength(3);
  });
});
