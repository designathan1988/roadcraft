import type { Tile } from './mesh/tileMesh';
import type { BlockArrays } from './mesh/roadLodPure';
import type { TileRect } from './mesh/tileShape';
import type { SurfaceData, TileMeshes } from './roadTileMesh';
import type { PassDesc } from './roadSurfaceReads';
import type { TilePolys } from './roadTileShape';

/**
 * THE ROADS' SURFACE TILES MADE ON THE OTHER CORES (`roadTile.worker.ts`).
 * A tile's bands - unions and differences of the rings that reach it, then
 * clipped, cut into compact pieces, ear-clipped and refined - and then each
 * vertex's height, texture frame, tint and section, read off the roads near
 * the tile (`roadTileMesh.ts`): the whole of a road surface's build, 20 s of
 * a 2 560 m city's opening for the shapes and 15 s more for the reads on the
 * page (profiled 2026-10-15). They are split across workers as
 * `conflictPool.ts` splits the conflict pairs, sized by the cores the browser
 * reports (MDN, `navigator.hardwareConcurrency`), one left to the page; each
 * share is handed the roads near its tiles (`TileJob.dataFor`), and the page
 * answers the ground's height at the points a worker asks (`need`), then only
 * uploads the arrays. No workers (a test, an old browser): `tiles` rejects,
 * and the tiles are built on the page as before.
 *
 * Whoever waits on it calls `check` while it waits (`roadSurfaceSteps`, once a
 * frame): a worker silent for `SILENCE_MS` with tiles waiting fails the pool,
 * its jobs rejected and built on the page. DO NOT wait without a deadline.
 */
interface Lane {
  readonly worker: Worker;
  readonly waiting: Map<number, { readonly job: TileJob; resolve(tiles: TileMeshes[]): void; reject(error: Error): void }>;
  /** The blocks whose far level is being made here (`coarsen`). */
  readonly coarsening: Map<number, { resolve(arrays: BlockArrays | null): void; reject(error: Error): void }>;
  /** When the worker last spoke, or was handed a job (`performance.now()`). */
  heard: number;
}

/** Longest a worker with tiles waiting may stay silent (it reports every 500 ms while it works). */
export const SILENCE_MS = 10_000;
/** Most workers the pool opens. */
const MOST_LANES = 4;

/** Tiles of a road pass to make off the page, and what the page answers for them. */
export interface TileJob {
  readonly pass: PassDesc;
  readonly tiles: readonly { readonly rect: TileRect; readonly into: TilePolys }[];
  /** The roads a share of the tiles reads, its arrays made afresh to be handed over. */
  dataFor(rects: readonly TileRect[]): { data: SurfaceData; transfer: ArrayBuffer[] };
  /** The ground as drawn, read here at the points a worker asks. */
  terrainAt(x: number, y: number): number;
}

/** What makes a road surface's tiles off the page (`roadSurfaceSteps`). */
export interface RoadTiler {
  /** Each tile's surfaces, finished, in the order asked; rejected when they cannot be made off the page. */
  tiles(job: TileJob): Promise<Map<string, Tile>[]>;
  /** Called while waiting: fails the pool if a worker with tiles waiting has been silent too long. */
  check(now?: number): void;
  /**
   * A block's far level (`mesh/roadLodPure.ts`) made off the page: `arrays` are handed over (copy them first to keep
   * them), `lock` the block's outer box. Null: too small to have one. Rejected when it cannot be made off the page.
   */
  coarsen?(arrays: BlockArrays, lock: readonly [number, number, number, number]): Promise<BlockArrays | null>;
}

export class RoadTilePool implements RoadTiler {
  private lanes: Lane[] | null = null;
  private broken = false;
  private nextId = 1;
  private nextLane = 0;

  coarsen(arrays: BlockArrays, lock: readonly [number, number, number, number]): Promise<BlockArrays | null> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no workers in this browser'));
    const lane = lanes[this.nextLane++ % lanes.length]!;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      lane.coarsening.set(id, { resolve, reject });
      lane.heard = performance.now();
      lane.worker.postMessage({ id, coarse: { arrays, lock } },
        [arrays.position.buffer, arrays.normal.buffer, arrays.uv.buffer, arrays.color.buffer, arrays.roadSection.buffer, arrays.index.buffer] as ArrayBuffer[]);
    });
  }

  tiles(job: TileJob): Promise<Map<string, Tile>[]> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no workers in this browser'));
    const { tiles } = job;
    // Contiguous shares, one a lane: neighbouring tiles read the same rings and roads, copied once a share.
    const per = Math.ceil(tiles.length / lanes.length);
    const parts: Promise<TileMeshes[]>[] = [];
    for (let k = 0; k < lanes.length && k * per < tiles.length; k++) {
      const lane = lanes[k]!;
      const id = this.nextId++;
      const share = tiles.slice(k * per, (k + 1) * per);
      parts.push(new Promise((resolve, reject) => {
        lane.waiting.set(id, { job, resolve, reject });
        lane.heard = performance.now();
        // The roads' arrays made for this share alone and handed over, not copied (MDN, "Transferable objects").
        const { data, transfer } = job.dataFor(share.map((t) => t.rect));
        lane.worker.postMessage({ id, ask: { pass: job.pass, tiles: share, data } }, transfer);
      }));
    }
    return Promise.all(parts).then((answers) => answers.flat().map((made) => new Map(made)));
  }

  check(now = performance.now()): void {
    for (const lane of this.lanes ?? []) {
      if ((lane.waiting.size || lane.coarsening.size) && now - lane.heard > SILENCE_MS) {
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
        const lane: Lane = { worker, waiting: new Map(), coarsening: new Map(), heard: performance.now() };
        worker.onmessage = (event: MessageEvent<{ id: number; beat?: true; need?: Float64Array; tiles?: TileMeshes[]; error?: string; coarse?: BlockArrays | null }>) => {
          if (this.lanes !== lanes) return;
          lane.heard = performance.now();
          const { id, beat, need, tiles, error } = event.data;
          if (beat) return;
          const block = lane.coarsening.get(id);
          if (block) {
            lane.coarsening.delete(id);
            if ('coarse' in event.data) block.resolve(event.data.coarse ?? null);
            else block.reject(new Error(error ?? 'road tile worker failed'));
            return;
          }
          const waiting = lane.waiting.get(id);
          if (!waiting) return;
          if (need) {
            // The ground's heights where the worker reads it: the page holds the drawn ground (`terrain.ts`).
            const heights = new Float64Array(need.length / 2);
            for (let i = 0; i < heights.length; i++) heights[i] = waiting.job.terrainAt(need[i * 2]!, need[i * 2 + 1]!);
            worker.postMessage({ id, heights }, [heights.buffer]);
            return;
          }
          lane.waiting.delete(id);
          if (tiles) waiting.resolve(tiles);
          else waiting.reject(new Error(error ?? 'road tile worker failed'));
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
      for (const block of lane.coarsening.values()) block.reject(error);
      lane.coarsening.clear();
      lane.worker.terminate();
    }
    this.lanes = null;
  }
}
