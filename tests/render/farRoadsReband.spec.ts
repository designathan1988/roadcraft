import { describe, expect, it, vi } from 'vitest';

import type { FarTreeJob } from '@render/farTree';

/** A NEAR LEVEL OF THE ROADS ASKED BEHIND THE CURTAIN IS ASKED AGAIN IN ITS BAND ONCE THE TOWN SHOWS (`farRoads.ts` farRoadsRunner) */

/** The jobs the queue was handed, and whether each is still waiting. */
const asked: { priority: number; write: () => unknown; cancelled: boolean }[] = [];
vi.mock('@/jobs/jobPool', async (original) => ({
  ...(await original<typeof import('@/jobs/jobPool')>()),
  canQueueJobs: () => true,
  submitJob: (spec: { priority: number; write: () => unknown }) => {
    const job = { priority: spec.priority, write: spec.write, cancelled: false };
    asked.push(job);
    return { cancel: () => { job.cancelled = true; }, get pending() { return !job.cancelled; } };
  },
}));

const near = (node: string): FarTreeJob => ({
  node, k: 0, i: 0, j: 0, sig: '1', want: true, prefix: null,
  near: { tiles: [{ key: 0, version: 1 }], bake: 'b', variant: 'v', shown: null },
});

describe('the far roads runner', () => {
  it('asks a near level waiting behind the curtain again in the detail band once the town shows, never one a worker took', async () => {
    const { farRoadsRunner } = await import('@render/farRoads');
    let hidden = true;
    const kit = { coarseFirst: () => hidden } as unknown as Parameters<typeof farRoadsRunner>[1];
    const runner = farRoadsRunner(() => null, kit);
    runner.run(near('a'), () => {});
    runner.run(near('b'), () => {});
    const later = asked[0]!.priority;
    // A worker takes the second before the curtain lifts.
    try { asked[1]!.write(); } catch { /* the job's message reads the kit: only its taking matters here */ }
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
