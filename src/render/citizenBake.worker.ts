/** A bake worker: a body's core clips, each clip baked on first use, and a cooked person read, off the main thread (`citizenBake.ts`, `bakePool.ts`). */
import type { JobScope } from '../jobs/jobScope';
import { type ClipFrames, type RigNode, type ShuffleFacts, bake, bakeDeferred, rigFromData, setSliceMs } from './citizenBake';
import { loadRocketboxClips, type RocketboxClips, type WalkSex } from './citizenWalk';
import { cookPerson, decodeCookedPerson, type DecodedPerson } from './people/cookedPerson';
import { buildPersonScene } from './people/personBuild';
import { bodyPixels } from './people/bodyPixels';
import { rigDeltasAt, type RigDeltas } from './people/personRig';
import { loadPeopleAssets } from '@people/body/assets';
import { Morpher } from '@people/body/morph';
import type { MacroParams } from '@people/body/macro';
import type { CartoonStyle } from './people/cartoon';
import type { PersonSpec } from '@people/spec';

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
  /** A person not cooked for this build (`personBuild.ts`), built here and read back as a cooked one. */
  readonly build?: { readonly person: PersonSpec; readonly gender: 'f' | 'm'; readonly style: CartoonStyle; readonly faces: boolean };
  /** A procedural class's new body (`crowdBodies.ts`): its basis shared with the page, its coefficients. */
  readonly body?: { readonly basis: Float32Array; readonly vertexCount: number; readonly shapes: number; readonly c: Float32Array; readonly stride: number };
  /** A procedural person's heights and own face (`proceduralCrowd.ts` add): only on the people's worker (`bakePool.ts` Job.people). */
  readonly face?: PersonFaceJob;
}

/** A procedural person on their class's body: their sliders, the class's height, and the class body's posture and face vertices (shared once a class). */
export interface PersonFaceJob {
  readonly body: MacroParams;
  readonly features: Readonly<Record<string, number>>;
  readonly classHeight: number;
  readonly deltas: RigDeltas;
  readonly faceVerts: Int32Array;
  /** Floats of a face's rows (`proceduralCrowd.ts` setFace): four a face vertex. */
  readonly faceFloats: number;
}

export type BakedClip = Omit<ClipFrames, 'head'> & { head?: number[] };
/** What a job answers: its clips, the person read, or why it failed. */
export interface BakeReply {
  readonly id: number; readonly clips?: (BakedClip | null)[]; readonly person?: DecodedPerson; readonly pixels?: Float32Array;
  /** A person's height and the same body at their class's height (`Morpher.height`), and their face's rows (none: no sliders). */
  readonly heights?: readonly number[]; readonly face?: Float32Array | null;
  readonly error?: string;
}

/** The MakeHuman packs, on the people's worker only. */
let morpher: Morpher | null = null;

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
  const { id, nodes, sex, at, facts, uncook, build, body, face } = e.data;
  try {
    if (face) {
      const people = await loadPeopleAssets();
      morpher ??= new Morpher(people.packs);
      const heights = [morpher.height(face.body, people.bodyRange), morpher.height({ ...face.body, height: face.classHeight }, people.bodyRange)];
      let rows: Float32Array | null = null;
      if (Object.keys(face.features).length) {
        // Their sliders on the class body, posed as it is (`proceduralCrowd.ts` setFace).
        const offset = new Float32Array(morpher.vertexCount * 3);
        morpher.addRegional(offset, face.features);
        const moved = rigDeltasAt(face.deltas, people.mesh.weights, people.mesh.joints, offset, face.faceVerts);
        rows = new Float32Array(face.faceFloats);
        for (let i = 0; i < face.faceVerts.length; i++) {
          rows[i * 4] = moved[i * 3]!; rows[i * 4 + 1] = moved[i * 3 + 1]!; rows[i * 4 + 2] = moved[i * 3 + 2]!;
        }
      }
      scope.postMessage({ id, heights, face: rows } satisfies BakeReply, rows ? [rows.buffer] : []);
      return;
    }
    if (body) {
      const pixels = bodyPixels(body.basis, body.vertexCount, body.shapes, body.c, body.stride);
      scope.postMessage({ id, pixels } satisfies BakeReply, [pixels.buffer]);
      return;
    }
    if (build) {
      const scene = await buildPersonScene(build.person, build.gender, build.style, build.faces);
      const { person, transfer } = decodeCookedPerson(cookPerson(scene));
      scope.postMessage({ id, person } satisfies BakeReply, transfer);
      return;
    }
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
