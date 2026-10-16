import { type TileRecords, TILE, tileIJ, tileKey, tileOfKey, tilesAround } from '@world/tiles';
import { m } from '@world/units';
import { type TileLinks, bakeTileLinks } from './tileLinks';

/** THE FAR TILES' LINK TABLES, READ BY THE SIMULATION'S WORKER STRAIGHT FROM THE TILE STORE: every stored tile within the meso's reach of the camera, baked here, the page out of the way */

/** How far round the camera the meso runs over the stored tiles. */
export const MESO_REACH = m(10_000);
/** Tiles read at once. */
const READS_IN_FLIGHT = 4;
/** A table is let go only this many tiles past the reach: a camera on a tile's edge does not read and drop it in turn. */
const REACH_MARGIN = 1;

/** Where a tile's records are read: the store's IndexedDB opened in the worker, or a port to whoever holds it (`simHost.ts`); null: none stored. */
export interface TileReader {
  read(key: number): Promise<TileRecords | null>;
}

/** A reader over a port that answers `{ id, key }` with `{ id, records }` (the desktop's store is the shell's, not IndexedDB). */
export function portReader(port: MessagePort): TileReader {
  let next = 1;
  const waiting = new Map<number, { readonly done: (r: TileRecords | null) => void; readonly fail: (e: Error) => void }>();
  port.onmessage = (event: MessageEvent<{ readonly id: number; readonly records?: TileRecords | null; readonly error?: string }>) => {
    const w = waiting.get(event.data.id);
    waiting.delete(event.data.id);
    if (event.data.error !== undefined) w?.fail(new Error(event.data.error));
    else w?.done(event.data.records ?? null);
  };
  return {
    read(key) {
      const id = next++;
      return new Promise((done, fail) => {
        waiting.set(id, { done, fail });
        port.postMessage({ id, key });
      });
    },
  };
}

/** The tiles in reach read once, again when the page says one was written, never while the page's document holds it (the live network covers it) */
export class TileLinkFeed {
  private readonly radius: number;
  private around = { i: Number.NaN, j: Number.NaN };
  /** The version each tile in reach was baked at (-1: none stored when read). */
  private readonly versions = new Map<number, number>();
  /** Tiles to read, the nearest first; being read; written again while being read. */
  private queue: number[] = [];
  private readonly queued = new Set<number>();
  private readonly reading = new Set<number>();
  private readonly again = new Set<number>();
  /** Tiles the page's document holds now. */
  private readonly live = new Set<number>();
  private ready: TileLinks[] = [];
  private leaving: number[] = [];
  private warned = false;

  constructor(private readonly reader: TileReader, reach = MESO_REACH) {
    this.radius = Math.max(1, Math.ceil(reach / TILE));
  }

  /** The camera's focus: the tiles come into reach asked, those gone past it let go (`gone`). */
  focus(x: number, y: number): void {
    const { i, j } = tileIJ(x, y);
    if (i !== this.around.i || j !== this.around.j) {
      this.around = { i, j };
      for (const t of tilesAround(i, j, this.radius)) {
        const key = tileKey(t.i, t.j);
        if (!this.versions.has(key)) this.want(key, false);
      }
      for (const key of [...this.versions.keys()]) {
        if (this.near(key, this.radius + REACH_MARGIN)) continue;
        this.versions.delete(key);
        this.leaving.push(key);
      }
      const kept: number[] = [];
      for (const key of this.queue) {
        if (this.near(key, this.radius + REACH_MARGIN)) kept.push(key); else this.queued.delete(key);
      }
      this.queue = kept;
    }
    this.pump();
  }

  /** The page's document took the tile in: the live network has it now. */
  loaded(key: number): void {
    this.live.add(key);
  }

  /** The page's document let the tile go: its table read now (and again when its write lands, `written`). */
  letGo(key: number): void {
    this.live.delete(key);
    this.versions.delete(key);
    this.want(key, true);
    this.pump();
  }

  /** The page wrote the tile (an edit, or made ahead): read again when it is in reach and newer than its table. */
  written(key: number, version: number): void {
    if (this.live.has(key) || !this.near(key, this.radius)) return;
    if ((this.versions.get(key) ?? -Infinity) >= version) return;
    if (this.reading.has(key)) { this.again.add(key); return; }
    this.versions.delete(key);
    this.want(key, false);
    this.pump();
  }

  /** The tables baked since the last call. */
  take(): TileLinks[] {
    const out = this.ready;
    this.ready = [];
    return out;
  }

  /** The tiles gone out of reach since the last call: their tables to drop. */
  gone(): number[] {
    const out = this.leaving;
    this.leaving = [];
    return out;
  }

  private near(key: number, radius: number): boolean {
    if (Number.isNaN(this.around.i)) return false;
    const { i, j } = tileOfKey(key);
    return Math.max(Math.abs(i - this.around.i), Math.abs(j - this.around.j)) <= radius;
  }

  private want(key: number, first: boolean): void {
    if (this.queued.has(key)) {
      if (!first) return;
      this.queue = this.queue.filter((k) => k !== key);
    }
    this.queued.add(key);
    if (first) this.queue.unshift(key); else this.queue.push(key);
  }

  private pump(): void {
    while (this.reading.size < READS_IN_FLIGHT && this.queue.length) {
      const key = this.queue.shift()!;
      this.queued.delete(key);
      if (this.live.has(key) || this.reading.has(key)) continue;
      this.reading.add(key);
      this.reader.read(key).then((records) => this.arrived(key, records), (error: unknown) => {
        this.reading.delete(key);
        this.again.delete(key);
        if (!this.warned) { this.warned = true; console.warn('[meso] a tile could not be read from the store', error); }
        this.pump();
      });
    }
  }

  /** A tile read: baked here (none stored: nothing until it is written), unless the page took it in or it left the reach meanwhile. */
  private arrived(key: number, records: TileRecords | null): void {
    this.reading.delete(key);
    const stale = this.again.delete(key);
    if (!this.live.has(key) && this.near(key, this.radius + REACH_MARGIN)) {
      this.versions.set(key, records ? records.version : -1);
      if (records) this.ready.push(bakeTileLinks(records));
      if (stale) { this.versions.delete(key); this.want(key, true); }
    }
    this.pump();
  }
}
