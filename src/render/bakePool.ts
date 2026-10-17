import { jobPort } from '../jobs/jobPool';
import { Matrix4, type Object3D } from 'three';

import { type ClipFrames, type RigNode, type ShuffleFacts, rigData } from './citizenBake';
import type { BakeReply, BakedClip, PersonFaceJob } from './citizenBake.worker';
import type { WalkSex } from './citizenWalk';
import type { DecodedPerson } from './people/cookedPerson';
import type { CartoonStyle } from './people/cartoon';
import type { PersonSpec } from '@people/spec';

/** The bake workers: a body's clips baked, and a cooked person read, on other cores while the game keeps drawing. */

const SIZE = Math.max(1, Math.min(6, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4) - 1));

const usable = typeof Worker !== 'undefined';
let releaseRequested = false;
const idle: Worker[] = [];
/** A job: its message and what it moves, and its answer (null: failed, the asker does it another way). */
interface Job {
  readonly message: object;
  readonly transfer: Transferable[];
  readonly answer: (reply: BakeReply | null) => void;
  /** Run only on the one worker that holds the MakeHuman packs (`people`): DO NOT load them (~18 MB, and their tables) in every worker of the one V8 cage. */
  readonly people?: boolean;
}
const queue: Job[] = [];
/** The job each worker has in hand, to answer it should the worker fail. */
const busy = new Map<Worker, Job>();
/** The worker the people's jobs go to (`Job.people`), once one ran. */
let peopleWorker: Worker | null = null;

function releaseIfIdle(): void {
  if (!releaseRequested || busy.size > 0 || queue.length > 0) return;
  for (const worker of idle) worker.terminate();
  idle.length = 0;
  peopleWorker = null;
  releaseRequested = false;
}

function finished(worker: Worker, reply: BakeReply | null): void {
  const job = busy.get(worker);
  if (!job) return;
  busy.delete(worker);
  idle.push(worker);
  job.answer(reply);
  dispatch();
  releaseIfIdle();
}

function createWorker(): Worker {
  const worker = jobPort('citizenBake');
  worker.onmessage = (e: MessageEvent<BakeReply>) => {
    if (e.data.error !== undefined) {
      console.error('Citizen bake worker failed', e.data.error);
      finished(worker, null);
      return;
    }
    finished(worker, e.data);
  };
  // A reply that could not be read fails its job as an error does
  worker.onmessageerror = () => fail('a reply could not be read');
  worker.onerror = (event) => {
    event.preventDefault();
    fail(event.message);
  };
  const fail = (why: string): void => {
    console.error('Citizen bake worker failed', why);
    const job = busy.get(worker);
    busy.delete(worker);
    worker.terminate();
    if (peopleWorker === worker) peopleWorker = null;
    job?.answer(null);
    dispatch();
    releaseIfIdle();
  };
  return worker;
}

/** Grow only while every existing worker is busy; keep the six-job peak. */
function dispatch(): void {
  for (let i = 0; i < queue.length;) {
    const job = queue[i]!;
    let worker: Worker | undefined;
    if (job.people && peopleWorker) {
      // The people's worker busy: the job waits for it, the others go on.
      const at = idle.indexOf(peopleWorker);
      if (at < 0) { i++; continue; }
      worker = idle.splice(at, 1)[0];
    } else {
      // Any free worker but the people's, which keeps itself for them while others can be made.
      const at = idle.findIndex((w) => w !== peopleWorker);
      worker = at >= 0 ? idle.splice(at, 1)[0] : undefined;
      if (!worker && busy.size + idle.length < SIZE) {
        try {
          worker = createWorker();
        } catch (error) {
          console.error('Citizen bake worker could not start', error);
          // DO NOT give up on workers for the session on one failure.
          if (busy.size === 0) for (const waiting of queue.splice(0)) waiting.answer(null);
          return;
        }
      }
      if (!worker && peopleWorker && idle.includes(peopleWorker)) worker = idle.splice(idle.indexOf(peopleWorker), 1)[0];
      if (!worker) return;
      if (job.people) peopleWorker = worker;
    }
    if (!worker) return;
    queue.splice(i, 1);
    busy.set(worker, job);
    try {
      worker.postMessage({ id: 0, ...job.message }, job.transfer);
    } catch (error) {
      console.error('Citizen bake worker could not receive a job', error);
      busy.delete(worker);
      idle.push(worker);
      job.answer(null);
    }
  }
}

/** A job queued for the next free worker; null at once where no worker can run it. */
function run(message: object, transfer: Transferable[] = [], people = false): Promise<BakeReply | null> {
  releaseRequested = false;
  if (!usable) return Promise.resolve(null);
  return new Promise((answer) => {
    queue.push({ message, transfer, answer, people });
    dispatch();
  });
}

/** The clips as baked in a worker, their head bones as matrices again. */
const clipsOf = (clips: readonly (BakedClip | null)[]): (ClipFrames | undefined)[] =>
  clips.map((c) => (c ? { ...c, ...(c.head ? { head: new Matrix4().fromArray(c.head) } : {}) } as ClipFrames : undefined));

/** The core clips of the body whose rig is `scene`, baked in a worker; null when no worker can */
export async function bakeInWorker(scene: Object3D, sex: WalkSex): Promise<(ClipFrames | undefined)[] | null> {
  if (!usable) return null;
  const { nodes, transfer } = rigData(scene);
  const reply = await run({ nodes, sex }, transfer);
  return reply?.clips ? clipsOf(reply.clips) : null;
}

/** A body's rig as a worker bakes on it (`rigData`), kept by the page for its clips baked on first use. */
export function bakeRig(scene: Object3D): readonly RigNode[] {
  return rigData(scene).nodes;
}

/** One clip of a body baked on first use, in a worker (`bakeDeferred`); null when no worker can (it is baked here then). */
export async function bakeDeferredInWorker(nodes: readonly RigNode[], sex: WalkSex, at: number, facts: ShuffleFacts): Promise<ClipFrames | null> {
  // The rig copied, not moved: the body's next clip is baked on it too.
  const reply = await run({ nodes, sex, at, facts: { duration: facts.duration, stride: facts.stride } });
  return reply?.clips ? clipsOf(reply.clips)[0] ?? null : null;
}

/** A cooked person read and decoded in a worker (`cookedPerson.ts` decodeCookedPerson): its arrays moved to the page; null when no worker can, or it could not be read. */
export async function uncookInWorker(url: string): Promise<DecodedPerson | null> {
  const reply = await run({ uncook: url });
  return reply?.person ?? null;
}

/** A person not cooked for this build, built in a worker (`personBuild.ts`) and read back as a cooked one; null when no worker can. */
export async function buildPersonInWorker(person: PersonSpec, gender: 'f' | 'm', style: CartoonStyle, faces: boolean): Promise<DecodedPerson | null> {
  const reply = await run({ build: { person, gender, style, faces } });
  return reply?.person ?? null;
}

/** A procedural class's new body baked in a worker from its shared basis (`bodyPixels`); null when no worker can (baked here then). */
export async function bakeBodyInWorker(basis: Float32Array, vertexCount: number, shapes: number, c: Float32Array, stride: number): Promise<Float32Array | null> {
  const reply = await run({ body: { basis, vertexCount, shapes, c, stride } });
  return reply?.pixels ?? null;
}

/** A procedural person's heights and own face, worked out on the people's worker (`citizenBake.worker.ts` face); null when no worker can (worked out here then). */
export async function personFaceInWorker(job: PersonFaceJob): Promise<{ readonly tall: number; readonly level0: number; readonly face: Float32Array | null } | null> {
  const reply = await run({ face: job }, [], true);
  return reply?.heights ? { tall: reply.heights[0]!, level0: reply.heights[1]!, face: reply.face ?? null } : null;
}

/** Releases decoded motion libraries held by idle workers after all visual bodies leave. */
export function releaseIdleBakeWorkers(): void {
  releaseRequested = true;
  releaseIfIdle();
}
