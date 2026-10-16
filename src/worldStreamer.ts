import { DOC_CHANGE_KINDS, isStreaming } from '@world/changes';
import { JournalCursor } from '@world/derived';
import type { ListPart, RoadDoc } from '@world/doc';
import { lotCentre } from '@world/lots';
import { OWNER, TILE, TILE_IDS, type TileRecords, tileIJ, tileKey, tileOfKey, tilesAround } from '@world/tiles';

/** THE ACTIVE REGION (CLAUDE.md, "Streaming world"): the tiles around the camera held in the page's document, loaded ahead and let go behind, each written to the store when it changed; the world beyond lives in the store and in what is baked from it */

/** Tiles each way from the camera's tile held in the document: 3 x 3 tiles, 3 km - the editing and the detail's reach; past it the buildings, roads and land are drawn from what is baked of the store (a dense downtown tile holds ~1,500 buildings: 9 of them stay a fraction of the page's heap). */
export const ACTIVE_RADIUS = 1;
/** A tile is let go only this many tiles past the radius: a camera on a tile's edge does not load and unload it in turn. */
const KEEP_MARGIN = 1;
/** Tiles asked of the store at once (each read, or made by the generator in a worker). */
const IN_FLIGHT = 4;
/** Tiles each way made ahead in the store (not put in the document): what the far levels draw from (`buildings/farLevels.ts`), ready when the camera comes. */
export const AHEAD_RADIUS = 5;
/** Tiles made ahead at once: behind the region's, one at a time. */
const AHEAD_IN_FLIGHT = 1;
/** A tile that could not be had is asked again only after this (a generator failing on it fails again at once). */
const RETRY_MS = 30_000;
/** Changed tiles are written this often (and always before they are let go). */
const WRITE_EVERY_MS = 5_000;

/** The tile a record of an undo step stands in (`editor/history.ts` letGoTile): by its place, or by its id's range for a road or a span. */
export function tileOfRecord(part: string, id: number, value: unknown): number | null {
  const v = value as { x?: number; y?: number; corners?: readonly { x: number; y: number }[]; points?: readonly { x: number; y: number }[] } | undefined;
  if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return OWNER.at(v as { x: number; y: number });
  if (v?.corners?.length) return OWNER.at(lotCentre(v as { corners: readonly { x: number; y: number }[] }));
  if (v?.points?.length) return OWNER.at(v.points[0]!);
  return id >= TILE_IDS && (part === 'segments' || part === 'poleSpans') ? Math.floor(id / TILE_IDS) - 1 : null;
}

/** What the streamer tells the game */
export interface StreamerEvents {
  /** A tile came from the store: a frame to put it in (the frames are drawn on demand, `frameLoop.ts`). */
  arrived?(): void;
  /** A tile put in the page's document. */
  loaded?(key: number): void;
  /** A tile let go, and the stretches of the lists it took (undo forgets what it named, `History.letGoTile`). */
  letGo?(key: number, removedAt: ReadonlyMap<ListPart, readonly number[]>): void;
  /** A tile written at a version (what is baked of it is stale). */
  written?(key: number, version: number): void;
  failed?(why: string): void;
}

/** Where tiles come from and go to: the store, which makes a tile it does not have (`editor/tileStore.ts`). */
export interface TileSource {
  load(key: number): Promise<TileRecords>;
  write(records: TileRecords): Promise<boolean>;
}

export class WorldStreamer {
  /** Tiles asked and not come. */
  private readonly asked = new Set<number>();
  /** Tiles come and waiting for a moment with no edit open (`apply`). */
  private readonly ready = new Map<number, TileRecords>();
  /** Each loaded tile's version as last written or read. */
  private readonly versions = new Map<number, number>();
  /** Tiles changed by the player (or the game) since last written. */
  private readonly dirty = new Set<number>();
  private readonly edits = new JournalCursor(DOC_CHANGE_KINDS);
  /** The tiles wanted now, nearest first, and the camera's tile they were worked out for. */
  private wanted: number[] = [];
  private around = { i: Number.NaN, j: Number.NaN };
  private lastWrite = 0;
  /** When a tile last failed to come (`RETRY_MS`). */
  private readonly failedAt = new Map<number, number>();
  /** Tiles known to be in the store (read or made this session), and those being made ahead now. */
  private readonly known = new Set<number>();
  private readonly ahead = new Set<number>();
  /** The tiles to make ahead, nearest first, round the camera's tile. */
  private aheadOrder: number[] = [];
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly doc: RoadDoc, private readonly source: TileSource, private readonly tell: StreamerEvents = {}) {}

  /** The camera's focus on the map (x, y): the tiles around it wanted, the nearest asked first. */
  focus(x: number, y: number): void {
    const { i, j } = tileIJ(x, y);
    if (i === this.around.i && j === this.around.j) { this.ask(); return; }
    this.around = { i, j };
    this.wanted = tilesAround(i, j, ACTIVE_RADIUS).map((t) => tileKey(t.i, t.j));
    this.aheadOrder = tilesAround(i, j, AHEAD_RADIUS).map((t) => tileKey(t.i, t.j));
    this.ask();
  }

  /** Whether every tile the camera wants is in the document (the opening shows the town once it is). */
  get settled(): boolean {
    // A tile that failed does not hold the opening (told, and asked again later).
    return this.wanted.every((key) => this.doc.hasTile(key) || this.failedAt.has(key));
  }

  /** At a moment with no edit open (the frame's start): the tiles come put in, those far let go (written first when changed), the changed ones written now and then. */
  apply(now: number): void {
    if (this.doc.editing) return;
    this.noteEdits();
    // One tile put in a frame, the nearest first: a dense tile is ~1,500 buildings read and filed, the frame stays a frame (the work is the view's tiles, never the map's).
    let best: number | null = null, bestD = Infinity;
    for (const key of this.ready.keys()) {
      if (!this.wantedNear(key, ACTIVE_RADIUS + KEEP_MARGIN)) { this.ready.delete(key); continue; }
      const { i, j } = tileOfKey(key);
      const d = Math.max(Math.abs(i - this.around.i), Math.abs(j - this.around.j));
      if (d < bestD) { bestD = d; best = key; }
    }
    if (best !== null) {
      const records = this.ready.get(best)!;
      this.ready.delete(best);
      this.doc.loadTile(records);
      this.versions.set(best, records.version);
      this.tell.loaded?.(best);
      if (this.ready.size) this.tell.arrived?.();
    }
    for (const key of [...this.doc.loadedTiles]) {
      if (this.wantedNear(key, ACTIVE_RADIUS + KEEP_MARGIN)) continue;
      if (this.dirty.has(key)) this.write(key);
      this.tell.letGo?.(key, this.doc.unloadTile(key));
      this.versions.delete(key);
    }
    if (now - this.lastWrite >= WRITE_EVERY_MS) {
      this.lastWrite = now;
      for (const key of [...this.dirty]) this.write(key);
    }
  }

  /** Every changed tile written (the page going away, a map saved by hand). */
  flush(): Promise<unknown> {
    this.noteEdits();
    for (const key of [...this.dirty]) this.write(key);
    return this.writing;
  }

  /** Whether a tile lies within `radius` tiles of the camera's tile. */
  private wantedNear(key: number, radius: number): boolean {
    const { i, j } = tileOfKey(key);
    return Math.max(Math.abs(i - this.around.i), Math.abs(j - this.around.j)) <= radius;
  }

  /** The nearest wanted tiles not here nor asked: asked of the store, a few at a time; then the tiles ahead made in the store, one at a time. */
  private ask(): void {
    this.askAhead();
    for (const key of this.wanted) {
      if (this.asked.size >= IN_FLIGHT) return;
      if (this.doc.hasTile(key) || this.asked.has(key) || this.ready.has(key)) continue;
      if (performance.now() - (this.failedAt.get(key) ?? -Infinity) < RETRY_MS) continue;
      this.asked.add(key);
      this.source.load(key).then((records) => {
        this.asked.delete(key);
        this.noteKnown(key, records.version);
        this.ready.set(key, records);
        this.tell.arrived?.();
        this.ask();
      }, (error: unknown) => {
        this.asked.delete(key);
        this.failedAt.set(key, performance.now());
        this.tell.failed?.(`tile ${key}: ${String(error)}`);
      });
    }
  }

  /** The tiles round the region made in the store ahead of the camera, behind the region's own asks (the far levels draw them, `written`). */
  private askAhead(): void {
    if (this.asked.size > 0) return;
    for (const key of this.aheadOrder) {
      if (this.ahead.size >= AHEAD_IN_FLIGHT) return;
      if (this.known.has(key) || this.ahead.has(key) || this.doc.hasTile(key)) continue;
      this.ahead.add(key);
      this.source.load(key).then((records) => {
        this.ahead.delete(key);
        this.noteKnown(key, records.version);
        this.ask();
      }, (error: unknown) => {
        this.ahead.delete(key);
        this.known.add(key);
        this.tell.failed?.(`tile ${key} ahead: ${String(error)}`);
      });
    }
  }

  /** A tile seen in the store: told once (the far levels bake it). */
  private noteKnown(key: number, version: number): void {
    if (this.known.has(key)) return;
    this.known.add(key);
    this.tell.written?.(key, version);
  }

  /** The tiles the edits since the last look reached: to be written (the loads and unloads of tiles are not edits, `isStreaming`). */
  private noteEdits(): void {
    const entries = this.edits.read(this.doc.changes);
    if (entries === null) {
      for (const key of this.doc.loadedTiles) this.dirty.add(key);
      return;
    }
    for (const entry of entries) {
      if (isStreaming(entry)) continue;
      if (entry.rects === null) { for (const key of this.doc.loadedTiles) this.dirty.add(key); continue; }
      for (const [x0, y0, x1, y1] of entry.rects) {
        // A rectangle reaches every tile it overlaps (a road's box on two tiles marks both: either may own a piece of it).
        for (let i = Math.floor(x0 / TILE); i <= Math.floor(x1 / TILE); i++) {
          for (let j = Math.floor(y0 / TILE); j <= Math.floor(y1 / TILE); j++) {
            const key = tileKey(i, j);
            if (this.doc.hasTile(key)) this.dirty.add(key);
          }
        }
      }
    }
  }

  /** A tile written as the document holds it now, its version moved on; written in order, never two of one tile at once. */
  private write(key: number): void {
    this.dirty.delete(key);
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    const records = this.doc.tileRecords(key, version);
    this.writing = this.writing.then(() => this.source.write(records)).then((ok) => {
      if (ok) this.tell.written?.(key, version); else this.tell.failed?.(`tile ${key} was not written`);
    }, (error: unknown) => this.tell.failed?.(`tile ${key} was not written: ${String(error)}`));
  }
}
