import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import { tileOfKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import type { MadeTile } from '@editor/tileStore';
import type { StreamTileAnswer, StreamTileAsk } from './cityTile.worker';
import { jobLanes, jobPort } from './jobs/jobPool';

/** THE TILES MADE ON DEMAND (CLAUDE.md, "Streaming world"): a tile the store does not have is generated in a worker of the job pool (`cityTile.worker.ts`, `editor/wholeMapTile.ts` buildStreamTile), a pure function of the seed and its place */

/** Workers making tiles at once: as many as the region asks at a time (`worldStreamer.ts` IN_FLIGHT), never more than the pool has. */
const MOST_LANES = 4;

/** Where a tile made is stored by the worker, and whether its texts come back with its version. */
type StoreAsk = NonNullable<StreamTileAsk['store']>;

interface Waiting {
  readonly key: number;
  readonly store?: StoreAsk;
  readonly done: (answer: TileRecords | MadeTile) => void;
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

  /** Tile `key` made and stored by the worker in the tile store's `map` at a version past `after`: the version (null: not stored), and with `text` its records' texts, handed over (DO NOT post them to the store again from the page). */
  makeStored(key: number, map: string, after: number, text: boolean): Promise<MadeTile> {
    return new Promise((done, failed) => {
      this.queue.push({ key, store: { map, after, text }, done: (answer) => done(answer as MadeTile), failed: (why) => failed(new Error(why)) });
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
      lane.port.postMessage({ stream: true, options: this.options, i, j, ...(next.store ? { store: next.store } : {}) } satisfies StreamTileAsk);
    }
  }

  private lane(): { readonly port: Worker; busy: Waiting | null } {
    const lane: { readonly port: Worker; busy: Waiting | null } = { port: jobPort('cityTiles'), busy: null };
    lane.port.onmessage = (event: MessageEvent<StreamTileAnswer>) => {
      const waiting = lane.busy;
      lane.busy = null;
      if (waiting) {
        const answer = event.data;
        if ('error' in answer) waiting.failed(answer.error);
        else if ('stored' in answer) waiting.done({ version: answer.stored, ...(answer.text ? { text: answer.text } : {}) });
        else waiting.done(answer.records);
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
