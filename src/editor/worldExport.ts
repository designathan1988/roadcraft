import type { TileRecords } from '@world/doc';
import type { TileText } from './tileStore';
import type { WorldMeta } from './worldMeta';

/** THE STREAMED WORLD AS ONE FILE (Save map, Ctrl+S): its values and every stored tile, each tile as the texts it is stored in, joined in Blob pieces (no tile parsed or written again as text on the page), read back by `readWorldFile` */

/** A world file's format: version 3 (a map file of before the tiles is version 2, `mapExport.ts`). */
export const WORLD_FILE_VERSION = 3;

/** The file as pieces whose concatenation is `{"version":3,"world":meta,"tiles":[[part, part...], ...]}`: each tile read in turn (`read`), its stored texts put in as they are. */
export async function worldFilePieces(meta: WorldMeta, keys: Iterable<number>, read: (key: number) => Promise<TileText | null>): Promise<BlobPart[]> {
  const pieces: BlobPart[] = [`{"version":${WORLD_FILE_VERSION},"world":`, JSON.stringify(meta), ',"tiles":['];
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

/** A world file read back: its values and its tiles (each its parts' fields merged), or null when it is not one. */
export function readWorldFile(value: unknown): { readonly meta: WorldMeta; readonly tiles: readonly TileRecords[] } | null {
  if (typeof value !== 'object' || value === null) return null;
  const file = value as { version?: unknown; world?: unknown; tiles?: unknown };
  if (file.version !== WORLD_FILE_VERSION || typeof file.world !== 'object' || file.world === null || !Array.isArray(file.tiles)) return null;
  const meta = file.world as WorldMeta;
  if (meta.version !== 1 || !Number.isFinite(meta.unit) || typeof meta.generator !== 'object' || meta.generator === null) return null;
  const tiles: TileRecords[] = [];
  for (const parts of file.tiles as unknown[]) {
    if (!Array.isArray(parts)) return null;
    const records = Object.assign({}, ...parts.filter((p) => typeof p === 'object' && p !== null)) as TileRecords;
    if (!Number.isInteger(records.key) || !Number.isFinite(records.version) || !Array.isArray(records.nodes) || !Array.isArray(records.buildings)) return null;
    tiles.push(records);
  }
  return { meta, tiles };
}
