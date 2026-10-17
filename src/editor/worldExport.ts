import type { TileRecords } from '@world/doc';
import { tileOfKey } from '@world/tiles';
import { MAP_TILES, PLAN_VERSION, tileOnMap } from '@world/cityGen/wholeMap';
import { LOT_PLAN_VERSION } from '@world/growth/version';
import { type TileText, isTileRecords } from './tileStore';
import type { WorldMeta } from './worldMeta';

/** THE STREAMED WORLD AS ONE FILE (Save map, Ctrl+S): its values and every stored tile, each tile as the texts it is stored in, joined in Blob pieces (no tile parsed or written again as text on the page), read back by `readWorldFile` */

/** A world file's format: version 3 (a map file of before the tiles is version 2, `mapExport.ts`). */
export const WORLD_FILE_VERSION = 3;

/** The file as pieces whose concatenation is `{"version":3,"world":meta,"tiles":[[part, part...], ...]}`: each tile read in turn (`read`), its stored texts put in as they are. */
export async function worldFilePieces(meta: WorldMeta, keys: Iterable<number>, read: (key: number) => Promise<TileText | null>): Promise<BlobPart[]> {
  // The plan its tiles were made by (`wholeMap.ts` PLAN_VERSION, the lots' generator, the map's size): opened only by a game of the same, or its tiles would be another city's.
  const plan = JSON.stringify({ plan: PLAN_VERSION, lots: LOT_PLAN_VERSION, tiles: MAP_TILES });
  const pieces: BlobPart[] = [`{"version":${WORLD_FILE_VERSION},"plan":${plan},"world":`, JSON.stringify(meta), ',"tiles":['];
  let first = true;
  for (const key of keys) {
    const text = await read(key);
    if (!text) continue;
    pieces.push(first ? '[' : ',[');
    first = false;
    text.forEach((part, k) => { if (k) pieces.push(','); pieces.push(part); });
    pieces.push(']');
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

/** A world file read back: its values and its tiles (each its parts' fields merged), or null when it is not one. */
export function readWorldFile(value: unknown): { readonly meta: WorldMeta; readonly tiles: readonly TileRecords[] } | null {
  if (typeof value !== 'object' || value === null) return null;
  const file = value as { version?: unknown; plan?: { plan?: unknown; lots?: unknown; tiles?: unknown }; world?: unknown; tiles?: unknown };
  if (file.version !== WORLD_FILE_VERSION || typeof file.world !== 'object' || file.world === null || !Array.isArray(file.tiles)) return null;
  if (file.plan?.plan !== PLAN_VERSION || file.plan.lots !== LOT_PLAN_VERSION || file.plan.tiles !== MAP_TILES) return null;
  const meta = file.world as WorldMeta;
  if (meta.version !== 1 || !Number.isFinite(meta.unit) || typeof meta.generator !== 'object' || meta.generator === null) return null;
  const tiles: TileRecords[] = [];
  for (const parts of file.tiles as unknown[]) {
    if (!Array.isArray(parts)) return null;
    const records: unknown = Object.assign({}, ...parts.filter((p) => typeof p === 'object' && p !== null));
    // Every list and counter a stored tile has, and a tile of this map: a file is the player's to give, not trusted as it is.
    if (!isTileRecords(records)) return null;
    const { i, j } = tileOfKey(records.key);
    if (!tileOnMap(i, j)) return null;
    tiles.push(records);
  }
  return { meta, tiles };
}
