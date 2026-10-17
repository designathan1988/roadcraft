import { MAP_TILES, tileOnMap } from '@world/cityGen/wholeMap';
import { type ChangeRect, DOC_CHANGE_KINDS, isStreaming } from '@world/changes';
import { JournalCursor } from '@world/derived';
import type { ListPart, RoadDoc } from '@world/doc';
import { TILE, tileIJ, tileKey, tileOfKey, tileRect, tilesAround } from '@world/tiles';
import type { TileRecords } from '@world/doc';

/** THE ACTIVE REGION (CLAUDE.md, "Streaming world"): the tiles around the camera held in the page's document, loaded ahead and let go behind, each written to the store when it changed; the world beyond lives in the store and in what is baked from it */

/** The kinds of the map's parts no tile holds (`RoadDoc.worldValues`): their changes are written with the world, not with a tile. */
const WORLD_KINDS: ReadonlySet<string> = new Set(['terrain', 'fog', 'gullies', 'clouds', 'clearings', 'zones', 'people', 'transit', 'economy', 'weather', 'markingStyle', 'nature']);

/** Tiles each way from the camera's tile held in the document: 3 x 3 tiles, 3 km - the editing and the detail's reach; past it the buildings, roads and land are drawn from what is baked of the store (a dense downtown tile holds ~1,500 buildings: 9 of them stay a fraction of the page's heap). */
export const ACTIVE_RADIUS = 1;
/** A tile is let go only this many tiles past the radius: a camera on a tile's edge does not load and unload it in turn. */
const KEEP_MARGIN = 1;
/** Tiles asked of the store at once (each read, or made by the generator in a worker). */
const IN_FLIGHT = 4;
/** The ring the region loads next as the camera moves (the tiles it keeps past its radius): made ahead first, as many at once as the region asks. */
const RING_RADIUS = ACTIVE_RADIUS + KEEP_MARGIN;
/** A tile that could not be had is asked again only after this (a generator failing on it fails again at once). */
const RETRY_MS = 30_000;
/** Changed tiles are written this often (and always before they are let go). */
const WRITE_EVERY_MS = 5_000;

/** The tile a record of an undo step stands in (`editor/history.ts` letGoTile): by its place, or by its id's range for a road or a span. */
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
  /** The camera's tile changed: the loaded tiles that came into the active region (3 x 3) or left it for the kept ring, and the rectangles of them. The ring keeps its records only: its near products are let go and the far levels draw it (CLAUDE.md "Streaming world", the solution's 5.4). */
  activeChanged?(keys: readonly number[], rects: readonly ChangeRect[]): void;
  /** The map's parts no tile holds changed (zones, fog, transit, economy...): to be written (`RoadDoc.worldValues`). */
  writeWorld?(): Promise<unknown>;
  failed?(why: string): void;
}

/** Where tiles come from and go to: the store, which makes a tile it does not have (`editor/tileStore.ts`). */
export interface TileSource {
  load(key: number): Promise<TileRecords>;
  /** The tile in the store (made there when it is not) and its version, its records not handed over (`TileStore.ensure`); none: `load`. */
  ensure?(key: number): Promise<number>;
  /** The version written, or null when it was not. */
  write(records: TileRecords): Promise<number | null>;
}

export class WorldStreamer {
  /** Tiles asked and not come. */
  private readonly asked = new Set<number>();
  /** Tiles come and waiting for a moment with no edit open (`apply`). */
  private readonly ready = new Map<number, TileRecords>();
  /** Each loaded tile's version as last written or read. */
  private readonly versions = new Map<number, number>();
  /** Tiles changed by the player (or the game) since last written, and whether the map's parts no tile holds did. */
  private readonly dirty = new Set<number>();
  private worldDirty = false;
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
  /** The tiles to make ahead: every tile of the map, nearest the camera's tile first. */
  private aheadOrder: number[] = [];
  private writing: Promise<unknown> = Promise.resolve();

  /** `inFlight`: how many tiles are asked of the store at once (the generator's lanes, `tileGenerator.ts` `lanesWanted`: more while the map is made), read as they are asked. */
  constructor(private readonly doc: RoadDoc, private readonly source: TileSource, private readonly tell: StreamerEvents = {},
    private readonly lanes: number | (() => number) = IN_FLIGHT) {}

  private get inFlight(): number {
    return typeof this.lanes === 'number' ? this.lanes : this.lanes();
  }

  /** The camera's focus on the map (x, y): the tiles around it wanted, the nearest asked first. */
  focus(x: number, y: number): void {
    const { i, j } = tileIJ(x, y);
    if (i === this.around.i && j === this.around.j) { this.ask(); return; }
    const wasActive = new Set(this.wanted);
    this.around = { i, j };
    // DO NOT ask a tile past the map's edge (`tileOnMap`): there is nothing there, and the region ends with the map.
    this.wanted = tilesAround(i, j, ACTIVE_RADIUS).filter((t) => tileOnMap(t.i, t.j)).map((t) => tileKey(t.i, t.j));
    // The loaded tiles whose standing changed: active now and not before, or the other way round.
    const flipped: number[] = [];
    for (const key of this.doc.loadedTiles) if (wasActive.has(key) !== this.wanted.includes(key)) flipped.push(key);
    if (flipped.length) this.tell.activeChanged?.(flipped, flipped.map((key) => { const t = tileOfKey(key); return tileRect(t.i, t.j); }));
    this.aheadOrder = mapTilesFrom(i, j);
    this.ask();
  }

  /** Whether a tile is in the active region (3 x 3 round the camera's tile): the near products are made for it; a tile kept in the ring beyond has its records only. */
  isActive(key: number): boolean {
    return this.wanted.includes(key);
  }

  /** THE WHOLE MAP MADE BEFORE IT IS SHOWN (the city-game's opening: every tile generated, then the city): while set, the tiles ahead take every lane (nothing else waits on them); let go once the town is shown. */
  rush = false;

  /** The map's tiles there are, and those made (in the store, or failed and told): the opening waits for all (`main.ts` holdOpening). */
  get mapTotal(): number {
    return MAP_TILES * MAP_TILES;
  }
  get mapMade(): number {
    let failed = 0;
    for (const key of this.failedAt.keys()) if (!this.known.has(key)) failed++;
    return this.known.size + failed;
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
      // The region whole now: the tiles ahead asked.
      else this.ask();
    }
    for (const key of [...this.doc.loadedTiles]) {
      if (this.wantedNear(key, ACTIVE_RADIUS + KEEP_MARGIN)) continue;
      if (this.dirty.has(key)) this.write(key);
      this.tell.letGo?.(key, this.doc.unloadTile(key));
      this.versions.delete(key);
    }
    // A changed tile kept in the ring is written at once: the far levels draw it from the store (`activeChanged`), never from the page.
    for (const key of [...this.dirty]) if (!this.wanted.includes(key)) this.write(key);
    if (now - this.lastWrite >= WRITE_EVERY_MS) {
      this.lastWrite = now;
      for (const key of [...this.dirty]) this.write(key);
      this.writeWorld();
    }
  }

  /** Every changed tile written (the page going away, a map saved by hand). */
  flush(): Promise<unknown> {
    this.noteEdits();
    for (const key of [...this.dirty]) this.write(key);
    this.writeWorld();
    return this.writing;
  }

  /** Whether a tile lies within `radius` tiles of the camera's tile. */
  private wantedNear(key: number, radius: number): boolean {
    const { i, j } = tileOfKey(key);
    return Math.max(Math.abs(i - this.around.i), Math.abs(j - this.around.j)) <= radius;
  }

  /** The nearest wanted tiles not here nor asked: asked of the store, a few at a time; then the tiles ahead made in the store, one at a time. */
  private ask(): void {
    for (const key of this.wanted) {
      if (this.asked.size >= this.inFlight) break;
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
    this.askAhead();
  }

  /** DO NOT make tiles ahead while the region waits for its own: once every tile it wants is in, the ring it loads next (several at once), then every other tile of the map nearest first (the far levels draw them, `written`). */
  private askAhead(): void {
    // The map being made (`rush`): every lane the region's tiles leave free, at once; after, once the region is in.
    if (!this.rush && (this.asked.size > 0 || this.ready.size > 0 || !this.settled)) return;
    for (const key of this.aheadOrder) {
      // Nearest first: past the ring, one lane kept free for the tiles the camera moves onto.
      if (this.rush ? this.asked.size + this.ahead.size >= this.inFlight
        : this.ahead.size >= (this.wantedNear(key, RING_RADIUS) ? this.inFlight : Math.max(1, this.inFlight - 1))) return;
      if (this.known.has(key) || this.ahead.has(key) || this.doc.hasTile(key) || this.wantedNear(key, ACTIVE_RADIUS)) continue;
      this.ahead.add(key);
      // DO NOT bring a tile made ahead onto the page: only its version is wanted here (the far levels and the meso read it from the store).
      const made = this.source.ensure ? this.source.ensure(key) : this.source.load(key).then((records) => records.version);
      made.then((version) => {
        this.ahead.delete(key);
        this.noteKnown(key, version);
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
      if (WORLD_KINDS.has(entry.kind)) { this.worldDirty = true; continue; }
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

  /** The map's parts no tile holds written when they changed, after the tiles queued before. */
  private writeWorld(): void {
    if (!this.worldDirty || !this.tell.writeWorld) return;
    this.worldDirty = false;
    const write = this.tell.writeWorld;
    this.writing = this.writing.then(() => write()).catch((error: unknown) => this.tell.failed?.(`the world's values were not written: ${String(error)}`));
  }

  /** A tile written as the document holds it now, its version moved on; written in order, never two of one tile at once. */
  private write(key: number): void {
    this.dirty.delete(key);
    // The store says the version it wrote (one past what it knows): the far levels key their bakes by it.
    const records = this.doc.tileRecords(key, this.versions.get(key) ?? 0);
    this.writing = this.writing.then(() => this.source.write(records)).then((version) => {
      if (version === null) { this.tell.failed?.(`tile ${key} was not written`); return; }
      if (this.doc.hasTile(key)) this.versions.set(key, version);
      this.tell.written?.(key, version);
    }, (error: unknown) => this.tell.failed?.(`tile ${key} was not written: ${String(error)}`));
  }
}

/** DO NOT leave the far city to the plan's stand-ins (`farPlan.ts`: boxes on a lattice and the avenues alone, the "city only in the middle" of 2026-10-16): every tile of the map, nearest (i, j) first, made once and stored, so the far levels draw the tiles themselves (the map is bounded, `wholeMap.ts` MAP_TILES). */
export function mapTilesFrom(i: number, j: number): number[] {
  const half = MAP_TILES / 2, out: { key: number; ring: number; d: number }[] = [];
  for (let a = -half; a < half; a++) {
    for (let b = -half; b < half; b++) out.push({ key: tileKey(a, b), ring: Math.max(Math.abs(a - i), Math.abs(b - j)), d: Math.hypot(a - i, b - j) });
  }
  out.sort((p, q) => p.ring - q.ring || p.d - q.d);
  return out.map((t) => t.key);
}
