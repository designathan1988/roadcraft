import { MAP_TILES, tileOnMap } from '@world/cityGen/wholeMap';
import { type ChangeRect, DOC_CHANGE_KINDS, isStreaming } from '@world/changes';
import { JournalCursor } from '@world/derived';
import { type ListPart, type RecordPart, type RoadDoc, type WorldPart, preparedTiles } from '@world/doc';
import { TILE, tileIJ, tileKey, tileOfKey, tileRect, tilesAround } from '@world/tiles';
import { m } from '@world/units';
import type { TileRecords } from '@world/doc';

/** THE ACTIVE REGION (CLAUDE.md, "Streaming world"): the tiles around the camera held in the page's document, loaded ahead and let go behind, each written to the store when it changed; the world beyond lives in the store and in what is baked from it */

/** The kinds of the map's parts no tile holds (`RoadDoc.worldValues`): their changes are written with the world, not with a tile. */
const WORLD_KINDS: readonly string[] = ['terrain', 'fog', 'gullies', 'clouds', 'clearings', 'zones', 'people', 'transit', 'economy', 'weather', 'markingStyle', 'nature'] satisfies readonly WorldPart[];

/** Tiles each way from the camera's tile held in the document: 3 x 3 tiles, 3 km - the editing and the detail's reach; past it the buildings, roads and land are drawn from what is baked of the store (a dense downtown tile holds ~1,500 buildings: 9 of them stay a fraction of the page's heap). */
export const ACTIVE_RADIUS = 1;
/** A tile is let go only this many tiles past the radius: a camera on a tile's edge does not load and unload it in turn. */
const KEEP_MARGIN = 1;
/** Tiles asked of the store at once (each read, or made by the generator in a worker). */
const IN_FLIGHT = 4;
/** The ring the region loads next as the camera moves (the tiles it keeps past its radius): made ahead first, as many at once as the region asks. */
const RING_RADIUS = ACTIVE_RADIUS + KEEP_MARGIN;
/** How far round the camera's tile the bays are baked ahead (`askBays`): the ring and the tiles it reaches next; past it, a tile's bays come with it into the region (`cityTile.worker.ts` addBays). */
const BAYS_RADIUS = RING_RADIUS + 1;
/** A tile that could not be had is asked again only after this (a generator failing on it fails again at once). */
const RETRY_MS = 30_000;
/** How far past the edge of its tile the camera goes before the region is centred on the next one (two sub-cells): walking along an edge does not turn three tiles back and forth. */
const RECENTRE_PAST = m(128);
/** Tiles past the document an edit may bring in at once (`hold`): each a dense tile's ~1,500 buildings on the page, in the V8 cage the page and its workers share - DO NOT bring a long road's every tile in. */
export const HOLD_MOST = 4;
/** A write that failed is posted again after this (a store failing on it fails again at once). */
const RETRY_WRITE_MS = 5_000;

/** The tile a record of an undo step stands in (`editor/history.ts` letGoTile): by its place, or by its id's range for a road or a span. */
/** What the streamer tells the game */
export interface StreamerEvents {
  /** A tile came from the store: a frame to put it in (the frames are drawn on demand, `frameLoop.ts`). */
  arrived?(): void;
  /** A tile put in the page's document, at the version it was read at: what reads its stored sections knows which it needs (C7). */
  loaded?(key: number, version: number): void;
  /** A tile let go, and the stretches of the lists it took (undo forgets what it named, `History.letGoTile`). */
  letGo?(key: number, removedAt: ReadonlyMap<ListPart, readonly number[]>, gone: ReadonlyMap<RecordPart, ReadonlySet<number>>): void;
  /** A tile written at a version (what is baked of it is stale). */
  written?(key: number, version: number): void;
  /** The camera's tile changed: the loaded tiles that came into the active region (3 x 3) or left it for the kept ring, and the rectangles of them. The ring keeps its records only: its near products are let go and the far levels draw it (CLAUDE.md "Streaming world", the solution's 5.4). */
  activeChanged?(keys: readonly number[], rects: readonly ChangeRect[]): void;
  /** The map's parts no tile holds changed (zones, fog, transit, economy...): to be written (`RoadDoc.worldValues`). */
  writeWorld?(parts: readonly WorldPart[]): Promise<unknown>;
  failed?(why: string): void;
}

/** Where tiles come from and go to: the store, which makes a tile it does not have (`editor/tileStore.ts`). */
export interface TileSource {
  load(key: number): Promise<TileRecords>;
  /** The tile in the store (made there when it is not) and its version, its records not handed over (`TileStore.ensure`); none: `load`. */
  ensure?(key: number): Promise<number>;
  /** Every tile the store holds baked and its version, read at once (`TileStore.manifest`); null, or none: each tile ensured. */
  manifest?(): Promise<ReadonlyMap<number, number> | null>;
  /** The version written, or null when it was not. */
  write(records: TileRecords, keep?: { readonly buildings: boolean }): Promise<number | null>;
  /** A tile come and not put in (the camera went on, `apply`): what the source kept for its putting in let go (`TileStore.forget`, its network bake). */
  forget?(key: number): void;
  /** A stored tile's parking bays baked and added where it has none (`TileStore.addBays`); none: nothing to do. */
  addBays?(key: number): Promise<void>;
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
  /** Tiles whose buildings or lots changed since their last write (or could have: an entry with no place): the others' buildings part is kept as the store holds it (`TileSource.write` keep, D4). */
  private readonly buildingsTouched = new Set<number>();
  /** The world's parts changed since written (`RoadDoc.worldPart`): DO NOT write them all for one. */
  private readonly worldDirty = new Set<WorldPart>();
  /** The map's own allocators as last written with the world's values (`RoadDoc.allocatorMarks`): a record made where no tile is loaded moves them. */
  private allocatorsSeen = '';
  private readonly edits = new JournalCursor(DOC_CHANGE_KINDS);
  /** The tiles wanted now, nearest first, and the camera's tile they were worked out for. */
  private wanted: number[] = [];
  /** Tiles asked for past the region by an edit waiting on them (`hold`): put in the document and kept until let go. */
  private held = new Set<number>();
  private around = { i: Number.NaN, j: Number.NaN };
  private lastRetry = 0;
  /** When a tile last failed to come (`RETRY_MS`). */
  private readonly failedAt = new Map<number, number>();
  /** Tiles known to be in the store (read or made this session), and those being made ahead now. */
  private readonly known = new Set<number>();
  private readonly ahead = new Set<number>();
  /** The tiles to make ahead: every tile of the map, nearest the camera's tile first. */
  private aheadOrder: number[] = [];
  /** How far along `aheadOrder` every tile is known (`askAhead`): DO NOT walk the whole map each frame for the few tiles left (a frame's walk of 100 tiles at 10 km, 1,600 at 40). Back to 0 when the order is made again. */
  private aheadAt = 0;
  /** The tiles whose bays are baked ahead, nearest the camera's tile first (`BAYS_RADIUS`), made again when the region recentres; and how far along it every tile's bays are asked or on the page. */
  private baysOrder: number[] = [];
  private baysAt = 0;
  /** The store's manifest: not read yet, being read, or read (its tiles known): no tile is made ahead before it is, DO NOT ensure a tile it names. */
  private manifestRead: 'no' | 'reading' | 'read' = 'no';
  /** The diary's version the edits were last noted at (`noteEdits`), and a serial moved whenever a tile's edit not yet in the store comes or goes (`pageEdits`). */
  private notedAt = -1;
  private pageEditSerial = 0;
  /** ONE RECORD OF WHERE THE STORE STANDS BEHIND THE PAGE, by tile: its last edit the store does not hold yet (`pageEdit`), and its last write posted and not confirmed (its records served to a tile asked again after the write failed, `load`; a failed one written again, `retryFailed`). Gone once a write holding the last edit is confirmed. */
  private readonly unsaved = new Map<number, Behind>();
  private editSerial = 0;
  /** The world's values written, one after another, and whether one is under way (the next waits for it). */
  private worldWriting: Promise<unknown> = Promise.resolve();
  private worldPosting = false;

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
    // Still within reach of the tile the region is centred on: it stays where it is.
    if (Number.isFinite(this.around.i)) {
      const [x0, y0, x1, y1] = tileRect(this.around.i, this.around.j);
      if (x >= x0 - RECENTRE_PAST && x <= x1 + RECENTRE_PAST && y >= y0 - RECENTRE_PAST && y <= y1 + RECENTRE_PAST) { this.ask(); return; }
    }
    const wasActive = new Set(this.wanted);
    this.around = { i, j };
    // DO NOT ask a tile past the map's edge (`tileOnMap`): there is nothing there, and the region ends with the map.
    this.wanted = tilesAround(i, j, ACTIVE_RADIUS).filter((t) => tileOnMap(t.i, t.j)).map((t) => tileKey(t.i, t.j));
    // The loaded tiles whose standing changed: active now and not before, or the other way round.
    const flipped: number[] = [];
    for (const key of this.doc.loadedTiles) if (wasActive.has(key) !== this.wanted.includes(key)) flipped.push(key);
    if (flipped.length) this.tell.activeChanged?.(flipped, flipped.map((key) => { const t = tileOfKey(key); return tileRect(t.i, t.j); }));
    // DO NOT order the whole map again once nothing of it is left to ask (the map made).
    if (this.aheadAt < this.aheadOrder.length || this.aheadOrder.length === 0) {
      this.aheadOrder = mapTilesFrom(i, j);
      this.aheadAt = 0;
    }
    this.baysOrder = tilesAround(i, j, BAYS_RADIUS).filter((t) => tileOnMap(t.i, t.j)).map((t) => tileKey(t.i, t.j));
    this.baysAt = 0;
    this.ask();
  }

  /** Tiles an edit waits on, wherever the camera is (a road drawn across the map, `RoadTool.layHeld`): asked as the region's are, put in the document with their records only and kept until let go; `[]` lets them go (the farthest first, as the camera's ring). Replaces the tiles held before. */
  /** Whether no more than `HOLD_MOST` of these tiles of the map are not in the document: nothing asked. */
  fits(keys: readonly number[]): boolean {
    return keys.filter((key) => { const { i, j } = tileOfKey(key); return tileOnMap(i, j) && !this.doc.hasTile(key); }).length <= HOLD_MOST;
  }

  /** False, and nothing held, when more than `HOLD_MOST` of them are not in the document. */
  hold(keys: readonly number[]): boolean {
    const onMap = keys.filter((key) => { const { i, j } = tileOfKey(key); return tileOnMap(i, j); });
    if (onMap.filter((key) => !this.doc.hasTile(key)).length > HOLD_MOST) { this.held = new Set(); return false; }
    this.held = new Set(onMap);
    this.ask();
    return true;
  }

  /** Whether a tile is in the active region (3 x 3 round the camera's tile): the near products are made for it; a tile kept in the ring beyond has its records only. */
  isActive(key: number): boolean {
    return this.wanted.includes(key);
  }

  /** The "whole map" clears under way, by list (`main.ts` clearStoredTiles): a tile that comes meanwhile (read before its clear) comes without the lists, and is written so; two clears of a list running at once each count. */
  private readonly clears = new Map<'trees' | 'elements', number>();

  /** The tiles read (or asked) while a clear ran, and its lists: emptied as they are put in, even after the clear is done (their read may have come before it). */
  private readonly readDuringClear = new Map<number, Set<'trees' | 'elements'>>();

  /** The lists some clear is emptying now. */
  private get stripping(): ReadonlySet<'trees' | 'elements'> {
    return new Set([...this.clears].filter(([, n]) => n > 0).map(([part]) => part));
  }

  private markRead(key: number, parts: Iterable<'trees' | 'elements'>): void {
    let set = this.readDuringClear.get(key);
    if (!set) this.readDuringClear.set(key, set = new Set());
    for (const part of parts) set.add(part);
  }

  /** A "whole map" clear of these lists under way: until `done` is called, a tile put in has them emptied (and is to be written). */
  clearing(parts: readonly ('trees' | 'elements')[]): () => void {
    for (const part of parts) this.clears.set(part, (this.clears.get(part) ?? 0) + 1);
    // What is being read or waits to be put in now was read before the store's clear, perhaps.
    for (const key of [...this.asked, ...this.ready.keys()]) this.markRead(key, parts);
    // A write that failed is posted again from its records (`retryFailed`): without the lists, or it puts back what the clear took.
    for (const behind of this.unsaved.values()) {
      const write = behind.write;
      if (!write?.failed) continue;
      behind.write = { ...write, records: { ...write.records, ...Object.fromEntries(parts.map((part) => [part, []])) } };
    }
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      for (const part of parts) this.clears.set(part, (this.clears.get(part) ?? 1) - 1);
    };
  }

  /** Another tab holds this world (`main.ts` holdWorld, a Web Lock): this one reads it and writes nothing, its edits kept on the page only. */
  readOnly = false;

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

  /** Whether a tile is made (in the store, or failed and told): what the opening's view waits for (`main.ts` holdOpening, `world/reachTiles.ts`). */
  isMade(key: number): boolean {
    return this.known.has(key) || this.failedAt.has(key);
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
      // DO NOT leave what came with it behind: a tile come after the camera went on is let go whole (its bake kept by the store for its putting in, every tile driven past, 2026-10-17).
      if (!this.wantedNear(key, ACTIVE_RADIUS + KEEP_MARGIN) && !this.held.has(key)) { this.ready.delete(key); this.readDuringClear.delete(key); this.source.forget?.(key); continue; }
      const { i, j } = tileOfKey(key);
      const d = Math.max(Math.abs(i - this.around.i), Math.abs(j - this.around.j));
      if (d < bestD) { bestD = d; best = key; }
    }
    if (best !== null) {
      let records = this.ready.get(best)!;
      this.ready.delete(best);
      const marked = this.readDuringClear.get(best);
      this.readDuringClear.delete(best);
      const strip = [...new Set([...this.stripping, ...(marked ?? [])])].filter((part) => records[part].length > 0);
      if (strip.length) {
        const was = records;
        records = { ...records, ...Object.fromEntries(strip.map((part) => [part, []])) };
        // Still the tile its worker prepared (its buildings filed as they are, its grown rows kept).
        if (preparedTiles.has(was)) preparedTiles.set(records, preparedTiles.get(was) ?? null);
      }
      this.doc.loadTile(records);
      // As read: its buildings the store's until an edit reaches them.
      this.buildingsTouched.delete(best);
      if (strip.length) this.dirty.add(best);
      this.versions.set(best, records.version);
      // Put in from a write that failed (`load`): the page holds what the store does not, written again from here.
      const behind = this.unsaved.get(best);
      if (behind?.write?.failed) { behind.write = null; this.dirty.add(best); }
      this.tell.loaded?.(best, records.version);
      if (this.ready.size) this.tell.arrived?.();
      // The region whole now: the tiles ahead asked.
      else this.ask();
    }
    // One tile let go a frame, the farthest first: a camera that jumped far leaves a ring of tiles, each its records out and its products dropped (a frame stays a frame).
    let far: number | null = null, farD = -1;
    for (const key of this.doc.loadedTiles) {
      if (this.wantedNear(key, ACTIVE_RADIUS + KEEP_MARGIN) || this.held.has(key)) continue;
      const { i, j } = tileOfKey(key);
      const d = Math.max(Math.abs(i - this.around.i), Math.abs(j - this.around.j));
      if (d > farD) { farD = d; far = key; }
    }
    if (far !== null) {
      const key = far;
      if (this.dirty.has(key) || this.unsaved.get(key)?.write?.failed) this.write(key);
      // Let go first: an optional call (`?.`) does not evaluate its arguments when nobody listens.
      const gone = new Map<RecordPart, Set<number>>();
      const removedAt = this.doc.unloadTile(key, gone);
      this.tell.letGo?.(key, removedAt, gone);
      this.versions.delete(key);
    }
    this.save(now);
  }

  /** The changed tiles and the world's values written: every frame, a world build running or not (a write reads the document, never changes it). */
  save(now: number): void {
    if (this.doc.editing) return;
    this.noteEdits();
    // DO NOT hold a changed tile for a timer: a page closed or reloaded meanwhile (a browser waits for nothing) lost the edits. Written as soon as its last write is in, so the store is one write behind the page at most.
    for (const key of [...this.dirty]) if (!this.posting(key)) this.write(key);
    if (now - this.lastRetry >= RETRY_WRITE_MS) {
      this.lastRetry = now;
      this.retryFailed();
    }
    this.writeWorld();
  }

  /** Whether a write of the tile is under way (not failed): the next waits for it, then takes every edit made meanwhile. */
  private posting(key: number): boolean {
    const write = this.unsaved.get(key)?.write;
    return !!write && !write.failed;
  }

  /** Every changed tile written, and those that failed written again (the page going away, a map changed): true once the store confirmed every write, false when one failed. */
  flush(): Promise<boolean> {
    this.noteEdits();
    this.retryFailed();
    for (const key of [...this.dirty]) this.write(key);
    this.writeWorld(true);
    const tiles = this.posted();
    return Promise.all([...tiles, this.worldWriting.then(() => this.worldDirty.size === 0)]).then((ok) => ok.every(Boolean));
  }

  /** The writes that failed posted again: a loaded tile from the page's records, one let go from the records it was written with. */
  private retryFailed(): void {
    for (const [key, behind] of [...this.unsaved]) {
      const write = behind.write;
      if (!write?.failed) continue;
      if (this.doc.hasTile(key)) this.dirty.add(key);
      else this.post(key, write.records);
    }
  }

  /** The outcomes of the writes under way. */
  private posted(): Promise<boolean>[] {
    const out: Promise<boolean>[] = [];
    for (const behind of this.unsaved.values()) if (behind.write) out.push(behind.write.done);
    return out;
  }

  /** The page's last edit of a tile the store does not hold yet: a serial, 0 when the store holds the tile as the page has it. What is drawn of an edited tile is made from the page's records until its write is confirmed (`farTree.ts` near level), never from the store's older version. */
  pageEdit(key: number): number {
    this.noteEdits();
    return this.unsaved.get(key)?.edit ?? 0;
  }

  /** A serial that moves whenever any tile's `pageEdit` may have: what a far level's choice is keyed by, DO NOT ask every tile of the map each frame (`farTree.ts` outsideKey). */
  pageEdits(): number {
    this.noteEdits();
    return this.pageEditSerial;
  }

  /** Whether the store is behind the page for a tile: an edit of it not written, or a write of it not confirmed (`unsaved`). */
  storeBehind(key: number): boolean {
    this.noteEdits();
    return this.unsaved.has(key);
  }

  /** A loaded tile's records as the page holds them now (`RoadDoc.tileRecords`); null for a tile not loaded. */
  pageRecords(key: number): TileRecords | null {
    return this.doc.hasTile(key) ? this.doc.tileRecords(key, this.versions.get(key) ?? 0) : null;
  }

  /** A tile reached by an edit: to be written, and the store behind the page until it is. */
  /** `kind`: what changed (null: not known) - its buildings or lots, or anything the write cannot place, and its buildings part is written again. */
  private touched(key: number, serial: number, kind: string | null): void {
    this.dirty.add(key);
    if (kind === null || kind === 'buildings' || kind === 'lots') this.buildingsTouched.add(key);
    const behind = this.unsaved.get(key);
    if (behind) behind.edit = serial;
    else this.unsaved.set(key, { edit: serial, write: null });
    this.pageEditSerial++;
  }

  /** Whether a tile lies within `radius` tiles of the camera's tile. */
  private wantedNear(key: number, radius: number): boolean {
    const { i, j } = tileOfKey(key);
    return Math.max(Math.abs(i - this.around.i), Math.abs(j - this.around.j)) <= radius;
  }

  /** The nearest wanted tiles not here nor asked: asked of the store, a few at a time; then the tiles ahead made in the store, one at a time. */
  private ask(): void {
    for (const key of [...this.wanted, ...this.held]) {
      if (this.asked.size >= this.inFlight) break;
      if (this.doc.hasTile(key) || this.asked.has(key) || this.ready.has(key)) continue;
      if (performance.now() - (this.failedAt.get(key) ?? -Infinity) < RETRY_MS) continue;
      this.asked.add(key);
      // Asked while a clear runs: its read may come before the store's clear.
      if (this.stripping.size) this.markRead(key, this.stripping);
      this.load(key).then((records) => {
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
    this.askBays();
  }

  /** The tiles whose bays were asked for (`askBays`), and how many are under way. */
  private readonly baysAsked = new Set<number>();
  private baysUnderWay = 0;

  /** DO NOT leave every tile's bays to its first coming into the region (1-2 s a dense tile as the camera moves): once the map is made (`mapMade`), the generator's lanes left idle bake them, from the camera's tile outwards, one lane short of all (a tile the camera moves onto goes first). */
  /** DO NOT bake every tile of the map's bays (65-161 ms a tile, 100 tiles at 10 km, 2,500 at 50): only those within `BAYS_RADIUS` of the camera's tile, the same count on any map. */
  private askBays(): void {
    const add = this.source.addBays;
    if (!add || this.rush || this.mapMade < this.mapTotal || this.asked.size > 0 || this.ready.size > 0) return;
    // Past the tiles whose bays are asked or that are on the page (theirs come with them, `cityTile.worker.ts` addBays): never walked again.
    while (this.baysAt < this.baysOrder.length && (this.baysAsked.has(this.baysOrder[this.baysAt]!) || this.doc.hasTile(this.baysOrder[this.baysAt]!))) this.baysAt++;
    for (let at = this.baysAt; at < this.baysOrder.length; at++) {
      const key = this.baysOrder[at]!;
      if (this.baysUnderWay >= Math.max(1, this.inFlight - 1)) return;
      if (this.baysAsked.has(key) || this.doc.hasTile(key)) continue;
      this.baysAsked.add(key);
      this.baysUnderWay++;
      add.call(this.source, key).catch((error: unknown) => console.warn(`[stream] tile ${key}'s bays were not added`, error)).finally(() => {
        this.baysUnderWay--;
        this.askBays();
      });
    }
  }

  /** DO NOT make tiles ahead while the region waits for its own: once every tile it wants is in, the ring it loads next (several at once), then every other tile of the map nearest first (the far levels draw them, `written`). */
  private askAhead(): void {
    // The map being made (`rush`): every lane the region's tiles leave free, at once; after, once the region is in.
    if (!this.rush && (this.asked.size > 0 || this.ready.size > 0 || !this.settled)) return;
    if (!this.knowStored()) return;
    // Past the tiles known (in the store): never walked again.
    while (this.aheadAt < this.aheadOrder.length && this.known.has(this.aheadOrder[this.aheadAt]!)) this.aheadAt++;
    for (let at = this.aheadAt; at < this.aheadOrder.length; at++) {
      const key = this.aheadOrder[at]!;
      // Nearest first: past the ring, one lane kept free for the tiles the camera moves onto. The map being made: twice the lanes asked, so a lane that ends a tile finds the next waiting in the generator's queue - DO NOT let it wait for the page to hear of the last and ask again (the opening's lanes at half load, 30-50 s, 2026-10-17).
      if (this.rush ? this.asked.size + this.ahead.size >= 2 * this.inFlight
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

  /** Whether the store's manifest is read (none to read: at once); the first call reads it, and its tiles are known when it comes. */
  private knowStored(): boolean {
    if (this.manifestRead === 'read') return true;
    if (this.manifestRead === 'reading') return false;
    const manifest = this.source.manifest?.();
    if (!manifest) { this.manifestRead = 'read'; return true; }
    this.manifestRead = 'reading';
    manifest.then((tiles) => {
      if (tiles) for (const [key, version] of tiles) { const { i, j } = tileOfKey(key); if (tileOnMap(i, j)) this.noteKnown(key, version); }
    }, (error: unknown) => console.warn('[stream] the store\'s manifest was not read: each tile is asked', error)).finally(() => {
      this.manifestRead = 'read';
      this.ask();
    });
    return false;
  }

  /** A tile seen in the store: told once (the far levels bake it). */
  private noteKnown(key: number, version: number): void {
    if (this.known.has(key)) return;
    this.known.add(key);
    this.tell.written?.(key, version);
  }

  /** The tiles the edits since the last look reached: to be written (the loads and unloads of tiles are not edits, `isStreaming`). */
  private noteEdits(): void {
    // Nothing written in the diary since the last look: nothing to note (an allocator moves only with a record made, which the diary tells). DO NOT look again for each tile asked (`pageEdit`, every leaf of the far levels every frame).
    const version = this.doc.changes.version;
    if (version === this.notedAt) return;
    this.notedAt = version;
    const marks = this.doc.allocatorMarks().join(',');
    if (marks !== this.allocatorsSeen) {
      if (this.allocatorsSeen) this.worldDirty.add('allocators');
      this.allocatorsSeen = marks;
    }
    const entries = this.edits.read(this.doc.changes);
    if (entries !== null && entries.length === 0) return;
    const serial = ++this.editSerial;
    if (entries === null) {
      for (const key of this.doc.loadedTiles) this.touched(key, serial, null);
      return;
    }
    for (const entry of entries) {
      if (isStreaming(entry)) continue;
      if (WORLD_KINDS.includes(entry.kind)) { this.worldDirty.add(entry.kind as WorldPart); continue; }
      if (entry.rects === null) { for (const key of this.doc.loadedTiles) this.touched(key, serial, null); continue; }
      for (const [x0, y0, x1, y1] of entry.rects) {
        // A rectangle reaches every tile it overlaps (a road's box on two tiles marks both: either may own a piece of it).
        for (let i = Math.floor(x0 / TILE); i <= Math.floor(x1 / TILE); i++) {
          for (let j = Math.floor(y0 / TILE); j <= Math.floor(y1 / TILE); j++) {
            const key = tileKey(i, j);
            if (this.doc.hasTile(key)) this.touched(key, serial, entry.kind);
          }
        }
      }
    }
  }

  /** The map's parts no tile holds written when they changed, one write after another (the store chains them), changed again if the write failed. DO NOT hold them for the tiles posted before: the balance left a round trip after the road's tile, and a reload in between kept the road and lost the balance (conf66); an allocator written after a tile that took its ids is the unsafe order anyway. */
  private writeWorld(force = false): void {
    if (this.readOnly) { this.worldDirty.clear(); return; }
    if (this.worldDirty.size === 0 || !this.tell.writeWorld || (this.worldPosting && !force)) return;
    const parts = [...this.worldDirty];
    this.worldDirty.clear();
    this.worldPosting = true;
    const write = this.tell.writeWorld;
    const failed = (why: string): void => { for (const part of parts) this.worldDirty.add(part); this.tell.failed?.(why); };
    // Posted now, beside the tiles of the same frame: the store writes them as they come (`storeTurns.ts`).
    this.worldWriting = this.worldWriting.then(() => write(parts)).then(
      (ok) => { if (ok === false) failed('the world\'s values were not written'); },
      (error: unknown) => failed(`the world's values were not written: ${String(error)}`)).then(() => { this.worldPosting = false; });
  }

  /** A tile from the store; DO NOT read the store's older version of one whose last write failed: the records written are served (`apply` writes them again). */
  private load(key: number): Promise<TileRecords> {
    // The store runs a tile's calls in order (`TileStore` chains): a write posted before is in it by the time the read runs.
    return this.source.load(key).then((records) => {
      const write = this.unsaved.get(key)?.write;
      return write?.failed ? { ...write.records, version: Math.max(write.records.version, records.version) } : records;
    });
  }

  /** A tile written as the document holds it now, its version moved on. */
  private write(key: number): void {
    this.dirty.delete(key);
    if (this.readOnly) return;
    // The store says the version it wrote (one past what it knows): the far levels key their bakes by it.
    // Its buildings untouched since the last write: their part kept as stored, not encoded again (D4).
    const buildings = !this.buildingsTouched.has(key);
    this.buildingsTouched.delete(key);
    this.post(key, this.doc.tileRecords(key, this.versions.get(key) ?? 0), buildings);
  }

  /** DO NOT queue a write behind every other tile's (one chain for all): a tile let go and asked again was read at its old version before its write went in. The store chains each tile's calls itself. */
  private post(key: number, records: TileRecords, keepBuildings = false): void {
    // The edit this write holds: the store is behind the page until it is confirmed, and still behind if another came meanwhile.
    let behind = this.unsaved.get(key);
    if (!behind) this.unsaved.set(key, behind = { edit: 0, write: null });
    const pending: PendingWrite = { records, edit: behind.edit, failed: false, done: Promise.resolve(false) };
    behind.write = pending;
    const failed = (why: string): boolean => {
      // Only the tile's last write stands for it: an older one failing is covered by the newer.
      if (this.unsaved.get(key)?.write === pending) pending.failed = true;
      this.tell.failed?.(why);
      return false;
    };
    pending.done = this.source.write(records, keepBuildings ? { buildings: true } : undefined).then((version) => {
      if (version === null) return failed(`tile ${key} was not written`);
      const now = this.unsaved.get(key);
      if (now?.write === pending) {
        now.write = null;
        if (now.edit === pending.edit) { this.unsaved.delete(key); this.pageEditSerial++; }
      }
      if (this.doc.hasTile(key)) this.versions.set(key, version);
      this.tell.written?.(key, version);
      return true;
    }, (error: unknown) => failed(`tile ${key} was not written: ${String(error)}`));
  }
}

/** A tile's write posted to the store: its records, the last edit they hold, whether it failed, and its outcome (true: confirmed). */
interface PendingWrite {
  readonly records: TileRecords;
  readonly edit: number;
  failed: boolean;
  done: Promise<boolean>;
}

/** Where the store stands behind the page for one tile (`WorldStreamer.unsaved`). */
interface Behind {
  /** The page's last edit of the tile (a serial; 0: none the store lacks, only a write to confirm). */
  edit: number;
  /** Its last write posted, until confirmed. */
  write: PendingWrite | null;
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
