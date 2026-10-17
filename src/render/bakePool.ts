import { jobPort } from '../jobs/jobPool';
import { Matrix4, type Object3D } from 'three';

import { type ClipFrames, type RigNode, type ShuffleFacts, rigData } from './citizenBake';
import type { BakeReply, BakedClip } from './citizenBake.worker';
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
}
const queue: Job[] = [];
/** The job each worker has in hand, to answer it should the worker fail. */
const busy = new Map<Worker, Job>();

function releaseIfIdle(): void {
  if (!releaseRequested || busy.size > 0 || queue.length > 0) return;
  for (const worker of idle) worker.terminate();
  idle.length = 0;
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
    job?.answer(null);
    dispatch();
    releaseIfIdle();
  };
  return worker;
}

/** Grow only while every existing worker is busy; keep the six-job peak. */
function dispatch(): void {
  while (queue.length > 0) {
    let worker = idle.pop();
    if (!worker) {
      if (busy.size >= SIZE) return;
      try {
        worker = createWorker();
      } catch (error) {
        console.error('Citizen bake worker could not start', error);
        // DO NOT give up on workers for the session on one failure.
        if (busy.size === 0) for (const job of queue.splice(0)) job.answer(null);
        return;
      }
    }
    const job = queue.shift()!;
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
function run(message: object, transfer: Transferable[] = []): Promise<BakeReply | null> {
  releaseRequested = false;
  if (!usable) return Promise.resolve(null);
  return new Promise((answer) => {
    queue.push({ message, transfer, answer });
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

/** Releases decoded motion libraries held by idle workers after all visual bodies leave. */
export function releaseIdleBakeWorkers(): void {
  releaseRequested = true;
  releaseIfIdle();
}
