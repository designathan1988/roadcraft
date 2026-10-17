/** A bake worker: a body's core clips, each clip baked on first use, and a cooked person read, off the main thread (`citizenBake.ts`, `bakePool.ts`). */
import type { JobScope } from '../jobs/jobScope';
import { type ClipFrames, type RigNode, type ShuffleFacts, bake, bakeDeferred, rigFromData, setSliceMs } from './citizenBake';
import { loadRocketboxClips, type RocketboxClips, type WalkSex } from './citizenWalk';
import { decodeCookedPerson, type DecodedPerson } from './people/cookedPerson';

/** Nothing to yield to here: a bake runs to its end. */
setSliceMs(Infinity);

/** The core clips of a body; one clip baked on first use (`at`), timed by the body's shuffle (`facts`); or a cooked person's file to read (`uncook`). */
interface Job {
  readonly id: number;
  readonly nodes?: RigNode[];
  readonly sex?: WalkSex;
  readonly at?: number;
  readonly facts?: ShuffleFacts;
  readonly uncook?: string;
}

export type BakedClip = Omit<ClipFrames, 'head'> & { head?: number[] };
/** What a job answers: its clips, the person read, or why it failed. */
export interface BakeReply { readonly id: number; readonly clips?: (BakedClip | null)[]; readonly person?: DecodedPerson; readonly error?: string }

// Reuse decoded clips across this worker's jobs.
const libraries: Partial<Record<WalkSex, RocketboxClips>> = {};

/** The bakes' service of the job system (`job.worker.ts`). */
export function serve(scope: JobScope): void {
  scope.onmessage = (e: MessageEvent<Job>) => { void bakeJob(scope, e); };
}

/** A clip as it goes to the page: its arrays moved, its head bone as numbers. */
function sent(clip: ClipFrames, transfer: Set<ArrayBuffer>): BakedClip {
  for (const array of [clip.data, clip.travel, clip.yaw, clip.hands]) if (array) transfer.add(array.buffer as ArrayBuffer);
  const { head, ...rest } = clip;
  return head ? { ...rest, head: [...head.elements] } : rest;
}

async function bakeJob(scope: JobScope, e: MessageEvent<Job>): Promise<void> {
  const { id, nodes, sex, at, facts, uncook } = e.data;
  try {
    if (uncook !== undefined) {
      const response = await fetch(uncook);
      if (!response.ok) throw new Error(`${uncook}: ${response.status}`);
      const { person, transfer } = decodeCookedPerson(await response.arrayBuffer());
      scope.postMessage({ id, person } satisfies BakeReply, transfer);
      return;
    }
    if (!nodes || !sex) throw new Error('a bake without a rig');
    const library = async (): Promise<RocketboxClips> => (libraries[sex] ??= await loadRocketboxClips(sex));
    const transfer = new Set<ArrayBuffer>();
    if (at !== undefined && facts) {
      const clip = await bakeDeferred(rigFromData(nodes), sex, library, at, facts);
      scope.postMessage({ id, clips: [clip ? sent(clip, transfer) : null] } satisfies BakeReply, [...transfer]);
      return;
    }
    const { clips, deferred } = await bake(rigFromData(nodes), sex, library);
    const out = clips.map((clip, k): BakedClip | null => (!clip || deferred.has(k) ? null : sent(clip, transfer)));
    scope.postMessage({ id, clips: out } satisfies BakeReply, [...transfer]);
  } catch (error) {
    scope.postMessage({ id, error: String(error) } satisfies BakeReply);
  }
}
