import { MeshoptSimplifier } from 'meshoptimizer';
import { jobLanes, jobPort } from '../jobs/jobPool';
import type { Tile } from './mesh/tileMesh';
import { type BlockArrays, blockBuffers, coarseArrays } from './mesh/roadLodPure';
import type { TileRect } from './mesh/tileShape';
import type { SurfaceData, TileMeshes } from './roadTileMesh';
import type { PassDesc } from './roadSurfaceReads';
import type { TilePolys } from './roadTileShape';

/** DO NOT take a silent worker for a dead one: it shares the job pool's workers and the CPU share (a failure comes as an error). */
interface Lane {
  readonly worker: Worker;
  readonly waiting: Map<number, { readonly job: TileJob; readonly first: number; resolve(tiles: TileMeshes[]): void; reject(error: Error): void }>;
  /** The blocks whose far level is being made here (`coarsen`). */
  readonly coarsening: Map<number, { resolve(arrays: BlockArrays | null): void; reject(error: Error): void }>;
  /** When the worker last spoke, or was handed a job (`performance.now()`). */
  heard: number;
  /** Whether this stretch of silence was already said. */
  told: boolean;
}

/** Silence past which a worker with tiles waiting is reported (it beats every 500 ms while it works, when it runs). */
const SILENCE_MS = 10_000;
/** Most workers the pool opens: on the desktop, workers of the job processes (`jobPool.ts` PROCESS_LANES). */
const MOST_LANES = 6;

/** Tiles of a road pass to make off the page, and what the page answers for them. */
export interface TileJob {
  readonly pass: PassDesc;
  readonly tiles: readonly { readonly rect: TileRect; readonly into: TilePolys }[];
  /** The roads a share of the tiles reads, its arrays made afresh to be handed over. */
  dataFor(rects: readonly TileRect[]): { data: SurfaceData; transfer: ArrayBuffer[] };
  /** The ground as drawn, read here at the points a worker asks. */
  terrainAt(x: number, y: number): number;
  /** Where the workers keep the tiles they make for a later session (`derivedCache.ts`): the store's prefix and each tile's key, in the tiles' order (null: not to keep). */
  readonly keep?: { readonly prefix: string; readonly keys: readonly (string | null)[] };
  /** A tile (by its place in `tiles`) kept by its worker before its arrays came here: the page keeps nothing of it. */
  onKept?(index: number): void;
}

/** What makes a road surface's tiles off the page (`roadSurfaceSteps`). */
export interface RoadTiler {
  /** Each tile's surfaces, finished, in the order asked; rejected when they cannot be made off the page. */
  tiles(job: TileJob): Promise<Map<string, Tile>[]>;
  /** Called while waiting: reports a worker with tiles waiting silent too long (queued behind other work or without CPU, still waited for). */
  check(now?: number): void;
  /** A block's far level (`mesh/roadLodPure.ts`) made off the page: `arrays` are handed over */
  coarsen?(arrays: BlockArrays, lock: readonly [number, number, number, number]): Promise<BlockArrays | null>;
}

export class RoadTilePool implements RoadTiler {
  private lanes: Lane[] | null = null;
  /** The far levels' lanes (`coarsen`), on the page's own workers. DO NOT make them on the tiles' (`jobPool.ts` PROCESS_LANES, the desktop's job processes): a block's arrays were copied on the page both ways (`processWorker.ts` send), 270 ms of the page's every 5 s in a large city's close view (2026-10-21); a worker of the page takes them moved. */
  private coarseLanes: Lane[] | null = null;
  /** No frame is seen (the opening's curtain, `renderer.ts`): the far levels go to the tiles' lanes, the page's copies paid behind it. DO NOT put them on the page's lane then: it is the worker the building cells of the view queue on (`jobPool.ts` hostFor), and the opening's buildings in view waited for it (7.9 s or 10.7 s, by where the lane fell, 2026-10-21). */
  unseen = true;
  private broken = false;
  private nextId = 1;
  private nextLane = 0;

  coarsen(arrays: BlockArrays, lock: readonly [number, number, number, number]): Promise<BlockArrays | null> {
    const lanes = (this.unseen ? this.start() : null) ?? this.startCoarse();
    // Where no worker can be made (Node, the specs that open a city: `tests/census/sceneCensus.spec.ts`), made here as the worker makes it, once the simplifier's WebAssembly is in (`roadTile.worker.ts` serve).
    if (!lanes) return MeshoptSimplifier.ready.then(() => coarseArrays(arrays, lock));
    const lane = lanes[this.nextLane++ % lanes.length]!;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      lane.coarsening.set(id, { resolve, reject });
      lane.heard = performance.now();
      lane.worker.postMessage({ id, coarse: { arrays, lock } }, blockBuffers(arrays));
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
      const first = k * per;
      const keep = job.keep ? { prefix: job.keep.prefix, keys: job.keep.keys.slice(first, first + share.length) } : undefined;
      parts.push(new Promise((resolve, reject) => {
        lane.waiting.set(id, { job, first, resolve, reject });
        lane.heard = performance.now();
        // The roads' arrays made for this share alone and handed over, not copied (MDN, "Transferable objects").
        const { data, transfer } = job.dataFor(share.map((t) => t.rect));
        lane.worker.postMessage({ id, ask: { pass: job.pass, tiles: share, data, ...(keep ? { keep } : {}) } }, transfer);
      }));
    }
    return Promise.all(parts).then((answers) => answers.flat().map((made) => new Map(made)));
  }

  check(now = performance.now()): void {
    for (const lane of [...(this.lanes ?? []), ...(this.coarseLanes ?? [])]) {
      if (lane.told || !(lane.waiting.size || lane.coarsening.size) || now - lane.heard <= SILENCE_MS) continue;
      // Said once a stretch, and waited for: the page building the tiles itself would stall every frame after it.
      lane.told = true;
      console.warn(`[roads] a road tile worker has been silent for ${Math.round(now - lane.heard)} ms with tiles waiting (busy or without CPU); still waiting`);
    }
  }

  private start(): Lane[] | null {
    if (this.lanes || this.broken) return this.lanes;
    this.lanes = this.open('roadTiles', jobLanes(MOST_LANES, 'roadTiles'));
    return this.lanes;
  }

  private startCoarse(): Lane[] | null {
    if (this.coarseLanes || this.broken) return this.coarseLanes;
    this.coarseLanes = this.open('roadCoarse', jobLanes(MOST_LANES));
    return this.coarseLanes;
  }

  private open(service: 'roadTiles' | 'roadCoarse', count: number): Lane[] | null {
    if (typeof Worker === 'undefined') { this.broken = true; return null; }
    const lanes: Lane[] = [];
    const live = (): boolean => this.lanes === lanes || this.coarseLanes === lanes;
    try {
      for (let k = 0; k < count; k++) {
        const worker = jobPort(service);
        const lane: Lane = { worker, waiting: new Map(), coarsening: new Map(), heard: performance.now(), told: false };
        worker.onmessage = (event: MessageEvent<{ id: number; beat?: true; need?: Float64Array; tiles?: TileMeshes[]; kept?: number[]; error?: string; coarse?: BlockArrays | null }>) => {
          if (!live()) return;
          lane.heard = performance.now();
          lane.told = false;
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
          // Those its worker kept in the store: told by their place in the job.
          for (const k of event.data.kept ?? []) waiting.job.onKept?.(waiting.first + k);
          if (tiles) waiting.resolve(tiles);
          else waiting.reject(new Error(error ?? 'road tile worker failed'));
        };
        worker.onerror = (event) => this.fail(`a road tile worker failed: ${event.message}`);
        worker.onmessageerror = () => this.fail('a road tile worker sent a message that cannot be read');
        lanes.push(lane);
      }
    } catch (error) {
      console.warn('[roads] the road tile workers are unavailable; the tiles are built on the page', error);
      // The lanes made before the one that failed let go: none is left holding its place on a worker of the job pool.
      for (const lane of lanes) lane.worker.terminate();
      this.broken = true;
      return null;
    }
    return lanes;
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
    for (const lane of [...(this.lanes ?? []), ...(this.coarseLanes ?? [])]) {
      for (const job of lane.waiting.values()) job.reject(error);
      lane.waiting.clear();
      for (const block of lane.coarsening.values()) block.reject(error);
      lane.coarsening.clear();
      lane.worker.terminate();
    }
    this.lanes = null;
    this.coarseLanes = null;
  }
}
