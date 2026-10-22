/** A STORED TILE AS ONE BLOB OF PARTS (the tile store's format 2): a magic, a JSON head naming each part's place, then the parts; a reader slices only the part it reads (`Blob.slice`, MDN: a slice reads no bytes until they are asked for) */

/** "RCT2", little-endian: a tile of parts; a blob that does not start with it is a tile of format 1 (one gzip of the whole records, RFC 1952 magic 1f 8b). */
const MAGIC = 0x32544352;
/** The magic and the head's byte length. */
const PREFIX = 8;

/** A part's kind: gzip of a JSON text, or raw bytes (a typed-array pack, `core/arrayPack.ts`). */
type PartKind = 'json' | 'bin';

/** A part to write: its name, its kind, its bytes as stored. */
export interface TilePartIn {
  readonly name: string;
  readonly kind: PartKind;
  readonly data: Blob;
}

/** What the head says: the tile, its version, each part's name, kind, offset past the head and size; `baked`, whether its derived sections were baked when written. */
interface TileHead {
  readonly key: number;
  readonly version: number;
  readonly baked: boolean;
  readonly parts: readonly (readonly [string, PartKind, number, number])[];
}

/** A tile's blob read: its head and where its parts start. */
export interface HeadRead {
  readonly head: TileHead;
  readonly body: number;
}

/** gzip of some bytes (MDN, `CompressionStream`): written straight to its writer, its chunks read and made one Blob at the end. DO NOT copy the input into a Blob to have a stream, nor let a Response gather it into more: a Blob is native memory the V8 does not count, and a worker whose heap is quiet never collects them - they piled up tile after tile, ~2.9 GB outside the JS heap while the map was made (2026-10-17). */
export async function gzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Blob> {
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  // Written while it is read: the stream's queue would hold the write otherwise.
  const writing = writer.write(bytes).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array<ArrayBuffer>);
  }
  await writing;
  return new Blob(chunks);
}

/** The bytes a gzip blob holds. */
export async function gunzipBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/** The parts laid one after the other behind the head. */
export function tileBlob(key: number, version: number, baked: boolean, parts: readonly TilePartIn[]): Blob {
  let at = 0;
  const placed: [string, PartKind, number, number][] = [];
  for (const p of parts) {
    placed.push([p.name, p.kind, at, p.data.size]);
    at += p.data.size;
  }
  const head = new TextEncoder().encode(JSON.stringify({ key, version, baked, parts: placed } satisfies TileHead)) as Uint8Array<ArrayBuffer>;
  const prefix = new Uint8Array(PREFIX);
  const view = new DataView(prefix.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, head.byteLength, true);
  return new Blob([prefix, head, ...parts.map((p) => p.data)]);
}

/** The head of a tile of parts; null: a tile of format 1 (or no tile of this store's at all, its reader decides). */
export async function readHead(blob: Blob): Promise<HeadRead | null> {
  if (blob.size < PREFIX) return null;
  const prefix = new DataView(await blob.slice(0, PREFIX).arrayBuffer());
  if (prefix.getUint32(0, true) !== MAGIC) return null;
  const length = prefix.getUint32(4, true);
  const head = JSON.parse(await blob.slice(PREFIX, PREFIX + length).text()) as TileHead;
  return { head, body: PREFIX + length };
}

/** One part of a tile of parts, its bytes not read yet; null when it has none of that name. */
export function partOf(blob: Blob, read: HeadRead, name: string): { readonly kind: PartKind; readonly data: Blob } | null {
  const found = read.head.parts.find((p) => p[0] === name);
  if (!found) return null;
  const [, kind, offset, size] = found;
  return { kind, data: blob.slice(read.body + offset, read.body + offset + size) };
}

/** A tile's blob's key in the store. */
export const tileBlobKey = (map: string, key: number): string => `${map}:T:${key}`;

/** A tile's mark in the store: its version and whether its sections are baked, written with its blob in one transaction (`PartStore.write` marks), so the world's every tile is known by one read (`PartStore.marks`), never a read of each tile's head. */
export const tileMarkKey = (map: string, key: number): string => `${map}:V:${key}`;
/** What every tile mark of a map starts with. */
export const tileMarkPrefix = (map: string): string => `${map}:V:`;
export const tileMark = (version: number, baked: boolean): string => `${version}${baked ? '' : 'u'}`;
/** A mark read back: the tile and its version, baked or not; null for a key or value not a mark's. */
export function readTileMark(prefix: string, key: string, value: string): { readonly key: number; readonly version: number; readonly baked: boolean } | null {
  if (!key.startsWith(prefix)) return null;
  const tile = Number(key.slice(prefix.length));
  const baked = !value.endsWith('u');
  const version = Number(baked ? value : value.slice(0, -1));
  return Number.isInteger(tile) && Number.isInteger(version) && version >= 0 ? { key: tile, version, baked } : null;
}
