/** A bake worker: a body's core clips baked off the main thread (`citizenBake.ts`, `bakePool.ts`). */
import type { JobScope } from '../jobs/jobScope';
import { type ClipFrames, type RigNode, type ShuffleFacts, bake, bakeDeferred, rigFromData, setSliceMs } from './citizenBake';
import { loadRocketboxClips, type RocketboxClips, type WalkSex } from './citizenWalk';

/** Nothing to yield to here: a bake runs to its end. */
setSliceMs(Infinity);

/** A body's core clips; with `deferred`, only that clip baked on first use (`bakeDeferred`), over the shuffle's facts. */
interface Job { readonly id: number; readonly nodes: RigNode[]; readonly sex: WalkSex; readonly deferred?: number; readonly shuffle?: ShuffleFacts }

export type BakedClip = Omit<ClipFrames, 'head'> & { head?: number[] };

// Reuse decoded clips across this worker's jobs.
const libraries: Partial<Record<WalkSex, RocketboxClips>> = {};

/** The bakes' service of the job system (`job.worker.ts`). */
export function serve(scope: JobScope): void {
  scope.onmessage = (e: MessageEvent<Job>) => { void bakeJob(scope, e); };
}

async function bakeJob(scope: JobScope, e: MessageEvent<Job>): Promise<void> {
  const { id, nodes, sex } = e.data;
  try {
    const library = libraries[sex] ??= await loadRocketboxClips(sex);
    const at = e.data.deferred, shuffle = e.data.shuffle;
    const { clips, deferred } = at !== undefined && shuffle
      ? { clips: [await bakeDeferred(rigFromData(nodes), sex, library, at, shuffle) ?? undefined], deferred: new Map() }
      : await bake(rigFromData(nodes), sex, library);
    const transfer = new Set<ArrayBuffer>();
    const out = clips.map((clip, at): BakedClip | null => {
      if (!clip || deferred.has(at)) return null;
      for (const array of [clip.data, clip.travel, clip.yaw, clip.hands]) if (array) transfer.add(array.buffer as ArrayBuffer);
      const { head, ...rest } = clip;
      return head ? { ...rest, head: [...head.elements] } : rest;
    });
    scope.postMessage({ id, clips: out }, [...transfer]);
  } catch (error) {
    scope.postMessage({ id, error: String(error) });
  }
}
