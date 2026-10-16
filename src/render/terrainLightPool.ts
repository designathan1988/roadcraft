import { jobPort } from '../jobs/jobPool';
import type { LightGrid, LightRequest, LightResult } from './terrainLightCompute';

/** THE LAND LIGHT, WORKED OUT BY A FEW SHARED WORKERS. */

/** Workers for every plate's light: a sliver of the machine, never all of it. */
const POOL_SIZE = 2;

interface Job {
  readonly key: number;
  readonly request: LightRequest;
  readonly done: (result: LightResult) => void;
  readonly failed: () => void;
}

interface Lane {
  readonly worker: Worker;
  readonly queue: Job[];
  busy: Job | null;
}

let lanes: Lane[] | null = null;
let broken = false;

function start(grid: LightGrid): Lane[] | null {
  if (lanes || broken) return lanes;
  if (typeof Worker === 'undefined') { broken = true; return null; }
  try {
    lanes = Array.from({ length: POOL_SIZE }, () => {
      const worker = jobPort('terrainLight');
      worker.postMessage({ grid });
      const lane: Lane = { worker, queue: [], busy: null };
      worker.onmessage = (event: MessageEvent<(LightResult & { key: number }) | { error: string; key: number }>) => {
        const job = lane.busy;
        lane.busy = null;
        if (job) {
          if ('error' in event.data) {
            console.warn('[terrain] the land\'s light failed in its worker', event.data.error);
            job.failed();
          } else job.done(event.data);
        }
        next(lane);
      };
      worker.onerror = (event) => {
        console.warn('[terrain] a land light worker failed', event.message);
        const job = lane.busy;
        lane.busy = null;
        job?.failed();
        next(lane);
      };
      return lane;
    });
  } catch (error) {
    console.warn('[terrain] the land\'s light workers are unavailable; the light is worked out on the page', error);
    broken = true;
    lanes = null;
  }
  return lanes;
}

function next(lane: Lane): void {
  if (lane.busy || !lane.queue.length) return;
  const job = lane.queue.shift();
  lane.busy = job!;
  lane.worker.postMessage({ ...job!.request, key: job!.key }, [job!.request.heights.buffer]);
}

/** Sends a plate's light request to its worker (queued behind the others); false when there are no workers */
export function submitLight(grid: LightGrid, key: number, request: LightRequest, done: Job['done'], failed: Job['failed']): boolean {
  const pool = start(grid);
  if (!pool) return false;
  // A plate's key is negative west and south of the origin (the world has no edge): the remainder taken positive.
  const lane = pool[((key % pool.length) + pool.length) % pool.length]!;
  lane.queue.push({ key, request, done, failed });
  next(lane);
  return true;
}
