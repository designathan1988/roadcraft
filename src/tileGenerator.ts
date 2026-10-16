import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import { tileOfKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { jobLanes, jobPort } from './jobs/jobPool';

/** THE TILES MADE ON DEMAND (CLAUDE.md, "Streaming world"): a tile the store does not have is generated in a worker of the job pool (`cityTile.worker.ts`, `editor/wholeMapTile.ts` buildStreamTile), a pure function of the seed and its place */

/** Workers making tiles at once: as many as the region asks at a time (`worldStreamer.ts` IN_FLIGHT), never more than the pool has. */
const MOST_LANES = 4;

/** A tile asked of the generator's worker (`cityTile.worker.ts`). */
interface StreamAsk {
  readonly stream: true;
  readonly options: WholeMapOptions;
  readonly i: number;
  readonly j: number;
  readonly store?: { readonly map: string; readonly after: number };
}

/** Its answer: the tile's records, the version it was stored at in the worker, or why it could not be made. */
type StreamAnswer = { readonly key: number; readonly records: TileRecords } | { readonly key: number; readonly stored: number | null }
  | { readonly i: number; readonly j: number; readonly error: string };

interface Waiting {
  readonly key: number;
  readonly store?: { readonly map: string; readonly after: number };
  readonly done: (answer: TileRecords | number | null) => void;
  readonly failed: (why: string) => void;
}

export class TileGenerator {
  private readonly lanes: { readonly port: Worker; busy: Waiting | null }[] = [];
  private readonly queue: Waiting[] = [];

  constructor(private readonly options: WholeMapOptions) {}

  /** Tile `key` made in a worker. */
  generate(key: number): Promise<TileRecords> {
    return new Promise((done, failed) => {
      this.queue.push({ key, done: (answer) => done(answer as TileRecords), failed: (why) => failed(new Error(why)) });
      this.pump();
    });
  }

  /** Tile `key` made and stored by the worker in the tile store's `map` at a version past `after`: the version, or null when it was not stored. */
  makeStored(key: number, map: string, after: number): Promise<number | null> {
    return new Promise((done, failed) => {
      this.queue.push({ key, store: { map, after }, done: (answer) => done(answer as number | null), failed: (why) => failed(new Error(why)) });
      this.pump();
    });
  }

  /** The workers let go (another world opened, the page going away). */
  dispose(): void {
    // A tile being made when let go is told so, as one waiting: whoever asked does not wait for ever.
    for (const lane of this.lanes) { lane.port.terminate(); lane.busy?.failed('the generator was let go'); lane.busy = null; }
    this.lanes.length = 0;
    for (const w of this.queue.splice(0)) w.failed('the generator was let go');
  }

  /** Each free lane given the next tile asked. */
  private pump(): void {
    const lanes = jobLanes(MOST_LANES);
    while (this.lanes.length < lanes && this.queue.length > this.lanes.filter((l) => !l.busy).length) this.lanes.push(this.lane());
    for (const lane of this.lanes) {
      if (lane.busy) continue;
      const next = this.queue.shift();
      if (!next) return;
      lane.busy = next;
      const { i, j } = tileOfKey(next.key);
      lane.port.postMessage({ stream: true, options: this.options, i, j, ...(next.store ? { store: next.store } : {}) } satisfies StreamAsk);
    }
  }

  private lane(): { readonly port: Worker; busy: Waiting | null } {
    const lane: { readonly port: Worker; busy: Waiting | null } = { port: jobPort('cityTiles'), busy: null };
    lane.port.onmessage = (event: MessageEvent<StreamAnswer>) => {
      const waiting = lane.busy;
      lane.busy = null;
      if (waiting) {
        const answer = event.data;
        if ('error' in answer) waiting.failed(answer.error); else waiting.done('stored' in answer ? answer.stored : answer.records);
      }
      this.pump();
    };
    lane.port.onerror = (event) => {
      const waiting = lane.busy;
      lane.busy = null;
      waiting?.failed(`a tile worker failed: ${event.message}`);
      this.pump();
    };
    return lane;
  }
}
