import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import { tileOfKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import type { MadeTile } from '@editor/tileStore';
import type { FarTileBake, StreamTileAnswer, StreamTileAsk } from './cityTile.worker';
import { jobPort, jobsQuiet, longWorkers, onJobsQuiet, setTilesWaiting, shortWorkers } from './jobs/jobPool';

/** THE TILES MADE ON DEMAND (CLAUDE.md, "Streaming world"): a tile the store does not have is generated in a worker of the job pool (`cityTile.worker.ts`, `editor/wholeMapTile.ts` buildStreamTile), a pure function of the seed and its place */

/** Workers making tiles at once, and how many the region asks at a time (`worldStreamer.ts` inFlight): the long-running side of the pool (`longWorkers`), the growth beside them (it grows the player's zones, once the map is made); never on the workers of the traffic's lanes, the cells or the far levels (`jobPool.ts` place). */
export const tileLanes = (): number => longWorkers();

/** Lanes set aside on the other kinds' workers while the map is made (`setAside`): never on the save's (`jobPool.ts` KEPT_CLEAR); the queue's worker makes a tile only while no queued job waits or runs (`jobsQuiet`), and is given back at the end of its tile when one comes (conf39: cells, near roads and a building's detail waited behind tiles of 2-25 s; wprof4: the queue's worker idle 61 s of the opening). */
export const asideLanes = (): number => Math.max(0, shortWorkers() - 2) + (jobsQuiet() ? 1 : 0);

/** Where a tile made is stored by the worker, and whether its texts come back with its version. */
type StoreAsk = NonNullable<StreamTileAsk['store']>;

interface Waiting {
  readonly key: number;
  readonly store?: StoreAsk;
  readonly done: (answer: TileRecords | MadeTile) => void;
  readonly failed: (why: string) => void;
}

/** A worker's lane of the generator: on a worker of the long-running side, or set aside on another kind's while the map is made (`setAside`). */
interface Lane { readonly port: Worker; busy: Waiting | null; readonly aside: boolean }

export class TileGenerator {
  private readonly lanes: Lane[] = [];
  private readonly queue: Waiting[] = [];
  /** Work that waits for the lanes to have nothing else (`makeStored` with `low`): a tile asked meanwhile goes first. */
  private readonly lowQueue: Waiting[] = [];
  /** Lanes on the other kinds' workers too (`setAside`). */
  private aside = false;
  /** Stops the pump being told the queue went quiet (`onJobsQuiet`), while lanes are set aside. */
  private quiet: (() => void) | null = null;

  /** `far`: what each tile stored is baked into its far levels with, read as the tile is asked (the ground as it stands then); none: no far level kept by the maker. */
  constructor(private readonly options: WholeMapOptions, private readonly far: () => FarTileBake | null = () => null) {}

  /** Tile `key` made in a worker. */
  generate(key: number): Promise<TileRecords> {
    return new Promise((done, failed) => {
      this.queue.push({ key, done: (answer) => done(answer as TileRecords), failed: (why) => failed(new Error(why)) });
      this.pump();
    });
  }

  /** Tile `key` made and stored by the worker in the tile store's `map` at a version past `after`: the version (null: not stored), and with `records` its records prepared for the page (DO NOT post them to the store again from the page). */
  makeStored(key: number, map: string, after: number, records: boolean, ifMissing = false, baysOnly = false, sectionsOnly = false): Promise<MadeTile> {
    return new Promise((done, failed) => {
      const waiting: Waiting = { key, store: { map, after, records, ...(ifMissing ? { ifMissing } : {}), ...(baysOnly ? { baysOnly } : {}), ...(sectionsOnly ? { sectionsOnly } : {}) },
        done: (answer) => done(answer as MadeTile), failed: (why) => failed(new Error(why)) };
      // A stored tile's bays (`baysOnly`): only on the lanes the tiles leave idle; a tile the player edited (`sectionsOnly`) first, its chain waits on it.
      if (baysOnly) this.lowQueue.push(waiting);
      else if (sectionsOnly) this.queue.unshift(waiting);
      else this.queue.push(waiting);
      this.pump();
    });
  }

  /** DO NOT leave the other kinds' workers idle while the whole map is made (the workers' profile, 2026-10-16: the two of them 14 s and 6 s busy of 90, the seven tile workers 96%): while `on`, a lane of tiles on each of them too; off, those lanes are let go as their tile ends, the workers theirs again. */
  setAside(on: boolean): void {
    if (this.aside === on) return;
    this.aside = on;
    this.quiet?.();
    this.quiet = on ? onJobsQuiet(() => this.pump()) : null;
    this.pump();
  }

  /** The tiles this generator makes at once now: what the asker keeps in flight (`worldStreamer.ts` `inFlight`). */
  get lanesWanted(): number {
    return tileLanes() + (this.aside ? asideLanes() : 0);
  }

  /** The workers let go (another world opened, the page going away). */
  dispose(): void {
    // A tile being made when let go is told so, as one waiting: whoever asked does not wait for ever.
    this.quiet?.();
    this.quiet = null;
    for (const lane of this.lanes) { lane.port.terminate(); lane.busy?.failed('the generator was let go'); lane.busy = null; }
    this.lanes.length = 0;
    for (const w of [...this.queue.splice(0), ...this.lowQueue.splice(0)]) w.failed('the generator was let go');
    setTilesWaiting(false);
  }

  /** The lanes set aside with no tile let go past `keep` (their workers' other work comes back to them). */
  private dropAside(keep: number): void {
    let kept = this.lanes.filter((l) => l.aside && l.busy).length;
    for (let k = this.lanes.length - 1; k >= 0; k--) {
      const lane = this.lanes[k]!;
      if (!lane.aside || lane.busy) continue;
      if (kept < keep) { kept++; continue; }
      lane.port.terminate();
      this.lanes.splice(k, 1);
    }
  }

  /** Each free lane given the next tile asked. */
  private pump(): void {
    // DO NOT keep a lane set aside with no tile waiting (the rush's end, `setAside(false)`, waits for every tile made, and a tile that failed never counts), nor past what the queue leaves (`asideLanes`).
    this.dropAside(!this.aside || this.queue.length === 0 ? 0 : asideLanes());
    const own = this.lanes.filter((l) => !l.aside).length, aside = this.lanes.length - own;
    const idle = (): number => this.lanes.filter((l) => !l.busy).length;
    // The low work on the generator's own lanes alone, never on those set aside.
    for (let made = own; made < tileLanes() && this.queue.length + this.lowQueue.length > idle(); made++) this.lanes.push(this.lane(false));
    if (this.aside) for (let made = aside; made < asideLanes() && this.queue.length > idle(); made++) this.lanes.push(this.lane(true));
    for (const lane of this.lanes) {
      if (lane.busy) continue;
      const next = this.queue.shift() ?? (lane.aside ? undefined : this.lowQueue.shift());
      if (!next) continue;
      lane.busy = next;
      const { i, j } = tileOfKey(next.key);
      lane.port.postMessage({ stream: true, options: this.options, i, j, ...(next.store ? { store: { ...next.store, far: this.far() } } : {}) } satisfies StreamTileAsk);
    }
    // The map's tiles waiting: the long side's workers kept for them, no queued job between two tiles (`jobPool.ts` setTilesWaiting).
    setTilesWaiting(this.aside && this.queue.length > 0);
  }

  private lane(aside: boolean): Lane {
    const lane: Lane = { port: jobPort(aside ? 'cityTilesAside' : 'cityTiles'), busy: null, aside };
    lane.port.onmessage = (event: MessageEvent<StreamTileAnswer>) => {
      const waiting = lane.busy;
      lane.busy = null;
      if (waiting) {
        const answer = event.data;
        if ('error' in answer) waiting.failed(answer.error);
        else if ('stored' in answer) {
          waiting.done({ version: answer.stored, ...(answer.prepared ? { prepared: answer.prepared } : {}),
            ...(answer.existed ? { existed: true } : {}), ...(answer.legacy ? { legacy: true } : {}) });
        }
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
