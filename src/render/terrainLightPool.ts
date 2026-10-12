import { TILES } from '@core/planetTiles';
import type { LightGrid, LightRequest, LightResult } from './terrainLightCompute';

/**
 * THE PLANET'S LAND LIGHT, WORKED OUT BY A FEW SHARED WORKERS. Each of the
 * planet's 864 terrain plates (`planet/terrainAtlas.ts`) is the flat map's
 * own surface, and each started a worker of its own for its light
 * (`terrainLight.worker.ts`): 864 threads, each with its own heap, all baking
 * at once at the opening - the whole machine taken, and gigabytes of memory.
 *
 * A worker pool instead, the pattern of the Web Workers API (MDN, "Using Web
 * Workers": a fixed set of workers fed from a queue): `POOL_SIZE` workers,
 * each plate always sent to the same one (its land's shape is kept there
 * between requests, by the plate's key), one request in flight per worker,
 * and among those waiting the plate nearest the place looked at first.
 */

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
/** The plate looked at (`setLightFocus`): those nearest it are lit first. */
let focus = -1;

function start(grid: LightGrid): Lane[] | null {
  if (lanes || broken) return lanes;
  if (typeof Worker === 'undefined') { broken = true; return null; }
  try {
    lanes = Array.from({ length: POOL_SIZE }, () => {
      const worker = new Worker(new URL('./terrainLight.worker.ts', import.meta.url), { type: 'module' });
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

/** How far a plate is from the one looked at: 0 there, 2 opposite. */
function rank(key: number): number {
  if (focus < 0) return 0;
  const a = TILES[key]?.centre, b = TILES[focus]?.centre;
  return a && b ? 1 - (a.x * b.x + a.y * b.y + a.z * b.z) : 0;
}

function next(lane: Lane): void {
  if (lane.busy || !lane.queue.length) return;
  let best = 0;
  for (let i = 1; i < lane.queue.length; i++) if (rank(lane.queue[i]!.key) < rank(lane.queue[best]!.key)) best = i;
  const [job] = lane.queue.splice(best, 1);
  lane.busy = job!;
  lane.worker.postMessage({ ...job!.request, key: job!.key }, [job!.request.heights.buffer]);
}

/**
 * Sends a plate's light request to its worker (queued behind the others);
 * false when there are no workers (the caller lights on the page).
 */
export function submitLight(grid: LightGrid, key: number, request: LightRequest, done: Job['done'], failed: Job['failed']): boolean {
  const pool = start(grid);
  if (!pool) return false;
  const lane = pool[key % pool.length]!;
  lane.queue.push({ key, request, done, failed });
  next(lane);
  return true;
}

/** The plate the view looks at: the light of those nearest it is worked out first. */
export function setLightFocus(tile: number): void {
  focus = tile;
}
