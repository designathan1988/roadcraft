import { jobPort } from '../jobs/jobPool';
import { Matrix4, type Object3D } from 'three';

import { type ClipFrames, type RigNode, type ShuffleFacts, rigData } from './citizenBake';
import type { BakedClip } from './citizenBake.worker';
import type { WalkSex } from './citizenWalk';

/** The bake workers: a body's core clips baked on other cores while the game keeps drawing. */
type Result = (ClipFrames | undefined)[] | null;

const SIZE = Math.max(1, Math.min(6, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4) - 1));

const usable = typeof Worker !== 'undefined';
let releaseRequested = false;
const idle: Worker[] = [];
interface Job {
  readonly nodes: readonly RigNode[];
  readonly transfer: ReturnType<typeof rigData>['transfer'];
  readonly sex: WalkSex;
  /** One clip baked on first use (`citizenBake.ts` bakeDeferred), and the shuffle it is timed by; none: the core clips. */
  readonly at?: number;
  readonly facts?: ShuffleFacts;
  readonly resolve: (result: Result) => void;
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

function finished(worker: Worker, result: Result): void {
  const job = busy.get(worker);
  if (!job) return;
  busy.delete(worker);
  idle.push(worker);
  job.resolve(result);
  dispatch();
  releaseIfIdle();
}

function createWorker(): Worker {
  const worker = jobPort('citizenBake');
  worker.onmessage = (e: MessageEvent<{ id: number; clips?: (BakedClip | null)[]; error?: string }>) => {
    if (!e.data.clips) {
      console.error('Citizen bake worker failed', e.data.error);
      finished(worker, null);
      return;
    }
    finished(worker, e.data.clips.map((c) => (c ? { ...c, ...(c.head ? { head: new Matrix4().fromArray(c.head) } : {}) } as ClipFrames : undefined)));
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
    job?.resolve(null);
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
        if (busy.size === 0) for (const job of queue.splice(0)) job.resolve(null);
        return;
      }
    }
    const job = queue.shift()!;
    busy.set(worker, job);
    try {
      worker.postMessage({ id: 0, nodes: job.nodes, sex: job.sex, ...(job.at !== undefined ? { at: job.at, facts: job.facts } : {}) }, job.transfer);
    } catch (error) {
      console.error('Citizen bake worker could not receive a rig', error);
      busy.delete(worker);
      idle.push(worker);
      job.resolve(null);
    }
  }
}

/** The core clips of the body whose rig is `scene`, baked in a worker; null when no worker can */
export function bakeInWorker(scene: Object3D, sex: WalkSex): Promise<Result> {
  releaseRequested = false;
  if (!usable) return Promise.resolve(null);
  const { nodes, transfer } = rigData(scene);
  return new Promise((resolve) => {
    queue.push({ nodes, transfer, sex, resolve });
    dispatch();
  });
}

/** A body's rig as a worker bakes on it (`rigData`), kept by the page for its clips baked on first use. */
export function bakeRig(scene: Object3D): readonly RigNode[] {
  return rigData(scene).nodes;
}

/** One clip of a body baked on first use, in a worker (`bakeDeferred`); null when no worker can (it is baked here then). */
export async function bakeDeferredInWorker(nodes: readonly RigNode[], sex: WalkSex, at: number, facts: ShuffleFacts): Promise<ClipFrames | null> {
  releaseRequested = false;
  if (!usable) return null;
  // The rig copied, not moved: the body's next clip is baked on it too.
  const result = await new Promise<Result>((resolve) => {
    queue.push({ nodes, transfer: [], sex, at, facts: { duration: facts.duration, stride: facts.stride }, resolve });
    dispatch();
  });
  return result?.[0] ?? null;
}

/** Releases decoded motion libraries held by idle workers after all visual bodies leave. */
export function releaseIdleBakeWorkers(): void {
  releaseRequested = true;
  releaseIfIdle();
}
