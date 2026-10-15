import type { SurfaceShape, TileRect } from './mesh/tileShape';
import type { TilePolys, TileSpec } from './roadTileShape';

/**
 * THE ROADS' SURFACE TILES SHAPED ON THE OTHER CORES (`roadTile.worker.ts`).
 * A tile's bands - unions and differences of the rings that reach it, then
 * clipped, cut into compact pieces, ear-clipped and refined - are read off x
 * and y alone (`roadTileShape.ts`): two thirds of a road surface's build, 20 s
 * of a 2 560 m city's opening on the page (profiled 2026-10-15). They are
 * split across workers as `conflictPool.ts` splits the conflict pairs, sized by
 * the cores the browser reports (MDN, `navigator.hardwareConcurrency`), one
 * left to the page; the page reads each vertex's height and frame from the
 * shapes (`meshTileShape`). No workers (a test, an old browser): `shapes`
 * rejects, and the tiles are built on the page as before.
 *
 * Whoever waits on it calls `check` while it waits (`roadSurfaceSteps`, once a
 * frame): a worker silent for `SILENCE_MS` with tiles waiting fails the pool,
 * its jobs rejected and built on the page. DO NOT wait without a deadline.
 */
interface Lane {
  readonly worker: Worker;
  readonly waiting: Map<number, { resolve(shapes: Map<string, SurfaceShape>[]): void; reject(error: Error): void }>;
  /** When the worker last spoke, or was handed a job (`performance.now()`). */
  heard: number;
}

/** Longest a worker with tiles waiting may stay silent (it reports every 500 ms while it works). */
export const SILENCE_MS = 10_000;
/** Most workers the pool opens. */
const MOST_LANES = 4;

/** What shapes a road surface's tiles off the page (`roadSurfaceSteps`). */
export interface RoadTiler {
  /** Each tile's surfaces' shapes, in the order asked; rejected when they cannot be made off the page. */
  shapes(tiles: readonly { readonly rect: TileRect; readonly into: TilePolys }[], specs: readonly TileSpec[]): Promise<Map<string, SurfaceShape>[]>;
  /** Called while waiting: fails the pool if a worker with tiles waiting has been silent too long. */
  check(now?: number): void;
}

export class RoadTilePool implements RoadTiler {
  private lanes: Lane[] | null = null;
  private broken = false;
  private nextId = 1;

  shapes(tiles: readonly { readonly rect: TileRect; readonly into: TilePolys }[], specs: readonly TileSpec[]): Promise<Map<string, SurfaceShape>[]> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no workers in this browser'));
    // Contiguous shares, one a lane: neighbouring tiles read the same rings, copied once a share.
    const per = Math.ceil(tiles.length / lanes.length);
    const parts: Promise<Map<string, SurfaceShape>[]>[] = [];
    for (let k = 0; k < lanes.length && k * per < tiles.length; k++) {
      const lane = lanes[k]!;
      const id = this.nextId++;
      parts.push(new Promise((resolve, reject) => {
        lane.waiting.set(id, { resolve, reject });
        lane.heard = performance.now();
        lane.worker.postMessage({ id, specs, tiles: tiles.slice(k * per, (k + 1) * per) });
      }));
    }
    return Promise.all(parts).then((answers) => answers.flat());
  }

  check(now = performance.now()): void {
    for (const lane of this.lanes ?? []) {
      if (lane.waiting.size && now - lane.heard > SILENCE_MS) {
        this.fail(`a road tile worker was silent for ${SILENCE_MS} ms with tiles waiting`);
        return;
      }
    }
  }

  private start(): Lane[] | null {
    if (this.lanes || this.broken) return this.lanes;
    if (typeof Worker === 'undefined') { this.broken = true; return null; }
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const count = Math.max(1, Math.min(MOST_LANES, cores - 1));
    try {
      const lanes: Lane[] = [];
      for (let k = 0; k < count; k++) {
        const worker = new Worker(new URL('./roadTile.worker.ts', import.meta.url), { type: 'module' });
        const lane: Lane = { worker, waiting: new Map(), heard: performance.now() };
        worker.onmessage = (event: MessageEvent<{ id: number; beat?: true; shapes?: [string, SurfaceShape][][]; error?: string }>) => {
          if (this.lanes !== lanes) return;
          lane.heard = performance.now();
          if (event.data.beat) return;
          const job = lane.waiting.get(event.data.id);
          if (!job) return;
          lane.waiting.delete(event.data.id);
          if (event.data.shapes) job.resolve(event.data.shapes.map((made) => new Map(made)));
          else job.reject(new Error(event.data.error ?? 'road tile worker failed'));
        };
        worker.onerror = (event) => this.fail(`a road tile worker failed: ${event.message}`);
        worker.onmessageerror = () => this.fail('a road tile worker sent a message that cannot be read');
        lanes.push(lane);
      }
      this.lanes = lanes;
    } catch (error) {
      console.warn('[roads] the road tile workers are unavailable; the tiles are built on the page', error);
      this.broken = true;
      this.lanes = null;
    }
    return this.lanes;
  }

  /** The pool fails: every job waiting on any worker rejected (built on the page), every worker ended. */
  private fail(why: string): void {
    if (this.broken) return;
    console.warn(`[roads] ${why}; the tiles are built on the page`);
    this.broken = true;
    this.end(new Error(why));
  }

  /** Ends the workers, every job still waiting rejected. */
  dispose(): void {
    this.broken = true;
    this.end(new Error('the road tile pool was closed'));
  }

  private end(error: Error): void {
    for (const lane of this.lanes ?? []) {
      for (const job of lane.waiting.values()) job.reject(error);
      lane.waiting.clear();
      lane.worker.terminate();
    }
    this.lanes = null;
  }
}
