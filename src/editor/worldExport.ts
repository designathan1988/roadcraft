import type { TileRecords } from '@world/doc';
import { tileOfKey } from '@world/tiles';
import { MAP_TILES, PLAN_VERSION, tileOnMap } from '@world/cityGen/wholeMap';
import { LOT_PLAN_VERSION } from '@world/growth/version';
import { type TileText, isTileRecords } from './tileStore';
import type { WorldMeta } from './worldMeta';

/** THE STREAMED WORLD AS ONE FILE (Save map, Ctrl+S): its values and every stored tile, each tile as the texts it is stored in, joined in Blob pieces (no tile parsed or written again as text on the page), read back by `readWorldFile` */

/** A world file's format: version 3 (a map file of before the tiles is version 2, `mapExport.ts`). */
export const WORLD_FILE_VERSION = 3;

/** The file as pieces whose concatenation is `{"version":3,"world":meta,"tiles":[[part, part...], ...]}`: each tile read in turn (`read`), its stored texts put in as they are, a Blob of its own at once. */
/** DO NOT hold every tile's texts until the file is made (the whole world on the page's heap, hundreds of MB at 10 km): each tile a Blob as it is read, its texts let go; the browser keeps blobs out of the page and pages them to disk (Chromium "Blob Storage System Design"), and the file is a Blob of them, none copied. */
export async function worldFilePieces(meta: WorldMeta, keys: Iterable<number>, read: (key: number) => Promise<TileText | null>): Promise<BlobPart[]> {
  // The plan its tiles were made by (`wholeMap.ts` PLAN_VERSION, the lots' generator, the map's size): opened only by a game of the same, or its tiles would be another city's.
  const plan = JSON.stringify({ plan: PLAN_VERSION, lots: LOT_PLAN_VERSION, tiles: MAP_TILES });
  const pieces: BlobPart[] = [`{"version":${WORLD_FILE_VERSION},"plan":${plan},"world":`, JSON.stringify(meta), ',"tiles":['];
  let first = true;
  for (const key of keys) {
    const text = await read(key);
    if (!text) continue;
    const tile: BlobPart[] = [first ? '[' : ',['];
    first = false;
    text.forEach((part, k) => { if (k) tile.push(','); tile.push(part); });
    tile.push(']');
    pieces.push(new Blob(tile));
  }
  pieces.push(']}');
  return pieces;
}

/** What saving a streamed world to a file needs: its streamer's writes and its store's tiles. */
export interface WorldToSave {
  readonly streamer: { flush(): Promise<boolean>; readonly readOnly: boolean };
  readonly store: { meta(): Promise<WorldMeta | null>; readText(key: number): Promise<TileText | null> };
}

/** DO NOT say "saved" when the file would not hold what the player sees: every change written first (a write failed: no file), and never from a tab that only reads the world (its changes are on its page alone). The hint to show. */
export async function saveWorldFile(world: WorldToSave, keys: Iterable<number>, offer: (blob: Blob) => boolean): Promise<'hint.saved' | 'hint.saveBehind' | 'hint.worldReadOnly' | 'hint.exportFailed'> {
  if (world.streamer.readOnly) return 'hint.worldReadOnly';
  try {
    if (!(await world.streamer.flush())) return 'hint.saveBehind';
    const meta = await world.store.meta();
    if (!meta) throw new Error('the world has no values stored');
    const pieces = await worldFilePieces(meta, keys, (key) => world.store.readText(key));
    if (!offer(new Blob(pieces, { type: 'application/json' }))) throw new Error('the file was not offered');
    return 'hint.saved';
  } catch (error) {
    console.error('[world] the city could not be saved to a file', error);
    return 'hint.exportFailed';
  }
}

/** A world file opened: its values, checked with every tile before anything is written; its tiles handed one at a time (`eachTile`, the file read again as it goes), never all at once. */
export interface WorldFile {
  readonly meta: WorldMeta;
  /** Each tile of the file in turn to `take`, the next once it has resolved; false when `take` refused one or the file could not be read again. */
  eachTile(take: (records: TileRecords) => Promise<boolean>): Promise<boolean>;
}

/** DO NOT parse a world file whole (`JSON.parse` of the file's text: the whole world as one string and every tile's objects at once, past V8's longest string at 40 km): read as a stream (MDN `Blob.stream`, `TextDecoderStream`), each tile's text parsed alone and let go. Null when it is not a world file of this game's plan, or a tile of it lacks a list or lies off the map: nothing of it is taken then. */
export async function openWorldFile(file: Blob): Promise<WorldFile | null> {
  let meta: WorldMeta | null = null;
  const checked = await scanWorldFile(file, (head) => (meta = worldHead(head)) !== null, () => Promise.resolve(true));
  if (!checked || !meta) return null;
  const found: WorldMeta = meta;
  return { meta: found, eachTile: (take) => scanWorldFile(file, () => true, take) };
}

/** The file's values, or null when it is not a world file of this game's plan. */
function worldHead(value: unknown): WorldMeta | null {
  if (typeof value !== 'object' || value === null) return null;
  const file = value as { version?: unknown; plan?: { plan?: unknown; lots?: unknown; tiles?: unknown }; world?: unknown };
  if (file.version !== WORLD_FILE_VERSION || typeof file.world !== 'object' || file.world === null) return null;
  if (file.plan?.plan !== PLAN_VERSION || file.plan.lots !== LOT_PLAN_VERSION || file.plan.tiles !== MAP_TILES) return null;
  const meta = file.world as WorldMeta;
  if (meta.version !== 1 || !Number.isFinite(meta.unit) || typeof meta.generator !== 'object' || meta.generator === null) return null;
  return meta;
}

/** A tile of the file (its parts' fields merged), or null when it lacks a list or a counter, or lies off the map: a file is the player's to give, not trusted as it is. */
function worldTile(parts: unknown): TileRecords | null {
  if (!Array.isArray(parts)) return null;
  const records: unknown = Object.assign({}, ...parts.filter((p) => typeof p === 'object' && p !== null));
  if (!isTileRecords(records)) return null;
  const { i, j } = tileOfKey(records.key);
  return tileOnMap(i, j) ? records : null;
}

/** A text parsed, or `undefined` when it is not JSON (a file is the player's to give). */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    console.warn('[world] a piece of the file is not JSON', error);
    return undefined;
  }
}

/** The file read as a stream: its values (everything before "tiles", parsed once the tiles begin) to `head`, then each tile checked to `take`, in order. False when either refused, or the file is not one whole world file. */
async function scanWorldFile(file: Blob, head: (value: unknown) => boolean, take: (records: TileRecords) => Promise<boolean>): Promise<boolean> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  const scanner = new WorldFileScanner();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const tiles: string[] = [];
      if (!scanner.push(value, tiles)) return false;
      if (scanner.head !== null) {
        const values = parsed(scanner.head);
        scanner.head = null;
        if (!head(values)) return false;
      }
      for (const text of tiles) {
        const records = worldTile(parsed(text));
        if (!records || !(await take(records))) return false;
      }
    }
    return scanner.whole;
  } finally {
    void reader.cancel().catch((error: unknown) => console.warn('[world] the file was not let go', error));
  }
}

const IN_STRING = /["\\]/g;
const OUTSIDE = /["[\]{}]/g;
const TILES_KEY = /"tiles"\s*:\s*$/;

/** A world file's text taken chunk by chunk: its values' text until the tiles begin (`head`, once), then each tile's text whole (`push`'s `tiles`), by the depth of its brackets outside strings - never the file's text kept. */
export class WorldFileScanner {
  /** The values' text, set once the tiles begin (the tiles' array taken as empty); the caller takes it and sets it back to null. */
  head: string | null = null;
  private mode: 'head' | 'tiles' | 'after' = 'head';
  private depth = 0;
  private inString = false;
  /** Characters to pass at the start of the next chunk (an escape cut between two). */
  private skip = 0;
  /** The values' text so far, or the tile's being read. */
  private text = '';
  private inTile = false;

  /** Whether the file ended where one whole world file ends. */
  get whole(): boolean {
    return this.mode === 'after' && this.depth === 0 && !this.inString;
  }

  /** A chunk of the file's text; each tile it ends pushed to `tiles`. False when the file cannot be a world file (brackets that do not match). */
  push(chunk: string, tiles: string[]): boolean {
    const n = chunk.length;
    let i = this.skip, from = 0;
    this.skip = 0;
    while (i < n) {
      if (this.inString) {
        IN_STRING.lastIndex = i;
        const found = IN_STRING.exec(chunk);
        if (!found) break;
        i = found.index;
        if (chunk[i] === '\\') { i += 2; continue; }
        this.inString = false;
        i++;
        continue;
      }
      OUTSIDE.lastIndex = i;
      const found = OUTSIDE.exec(chunk);
      if (!found) break;
      i = found.index;
      const c = chunk[i];
      if (c === '"') { this.inString = true; i++; continue; }
      if (c === '[' || c === '{') {
        if (this.mode === 'after') return false;
        if (this.mode === 'head' && c === '[' && this.depth === 1 && TILES_KEY.test(this.text + chunk.slice(from, i))) {
          // The tiles begin: the values' text whole, the array taken as empty.
          this.head = `${this.text}${chunk.slice(from, i)}[]}`;
          this.text = '';
          this.mode = 'tiles';
          from = i + 1;
        } else if (this.mode === 'tiles' && this.depth === 2) {
          this.inTile = true;
          from = i;
        }
        this.depth++;
        i++;
        continue;
      }
      this.depth--;
      if (this.depth < 0 || (this.mode === 'head' && this.depth === 0)) return false;
      if (this.mode === 'tiles' && this.inTile && this.depth === 2) {
        tiles.push(this.text + chunk.slice(from, i + 1));
        this.text = '';
        this.inTile = false;
        from = i + 1;
      } else if (this.mode === 'tiles' && this.depth === 1) {
        this.mode = 'after';
        from = i + 1;
      }
      i++;
    }
    if (i > n) this.skip = i - n;
    if (this.mode === 'head' || this.inTile) this.text += chunk.slice(from);
    return true;
  }
}
