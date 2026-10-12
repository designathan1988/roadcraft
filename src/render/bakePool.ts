import { Matrix4, type Object3D } from 'three';

import { type ClipFrames, rigData } from './citizenBake';
import type { BakedClip } from './citizenBake.worker';
import type { WalkSex } from './citizenWalk';

/**
 * The bake workers: a body's core clips baked on other cores while the game
 * keeps drawing. Grow with concurrent visual requests, up to one fewer than
 * the cores and at most six; a single body needs only one worker. Where there
 * are no workers, or one fails, the caller bakes on the main thread instead.
 */
type Result = (ClipFrames | undefined)[] | null;

const SIZE = Math.max(1, Math.min(6, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4) - 1));

let usable = typeof Worker !== 'undefined';
let releaseRequested = false;
const idle: Worker[] = [];
interface Job {
  readonly nodes: ReturnType<typeof rigData>['nodes'];
  readonly transfer: ReturnType<typeof rigData>['transfer'];
  readonly sex: WalkSex;
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
  const worker = new Worker(new URL('./citizenBake.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; clips?: (BakedClip | null)[]; error?: string }>) => {
    if (!e.data.clips) {
      console.error('Citizen bake worker failed', e.data.error);
      finished(worker, null);
      return;
    }
    finished(worker, e.data.clips.map((c) => (c ? { ...c, ...(c.head ? { head: new Matrix4().fromArray(c.head) } : {}) } as ClipFrames : undefined)));
  };
  worker.onerror = (event) => {
    event.preventDefault();
    console.error('Citizen bake worker failed', event.message);
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
        if (busy.size === 0) {
          usable = false;
          for (const job of queue.splice(0)) job.resolve(null);
        }
        return;
      }
    }
    const job = queue.shift()!;
    busy.set(worker, job);
    try {
      worker.postMessage({ id: 0, nodes: job.nodes, sex: job.sex }, job.transfer);
    } catch (error) {
      console.error('Citizen bake worker could not receive a rig', error);
      busy.delete(worker);
      idle.push(worker);
      job.resolve(null);
    }
  }
}

/**
 * The core clips of the body whose rig is `scene`, baked in a worker; null
 * when no worker can (the caller bakes them itself). Deferred slots are
 * undefined.
 */
export function bakeInWorker(scene: Object3D, sex: WalkSex): Promise<Result> {
  releaseRequested = false;
  if (!usable) return Promise.resolve(null);
  const { nodes, transfer } = rigData(scene);
  return new Promise((resolve) => {
    queue.push({ nodes, transfer, sex, resolve });
    dispatch();
  });
}

/** Releases decoded motion libraries held by idle workers after all visual bodies leave. */
export function releaseIdleBakeWorkers(): void {
  releaseRequested = true;
  releaseIfIdle();
}
