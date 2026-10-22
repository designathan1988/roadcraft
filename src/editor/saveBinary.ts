/** THE SAVE'S BINARY FRAMES: every blob the autosave stores and the map file are one frame - a magic word, a format, a directory of sections (kind, offset, length) and the sections 8-byte aligned - so a blob is known by its first bytes and one region's frame decodes alone (Minecraft's region files: a table of offsets, each chunk read on its own) */

/** 'RCSQ': one layer's records in one square of the map (`chunkedSave.ts`). */
export const SQUARE_MAGIC = 0x51534352;
/** 'RCWR': one square's building wears, id and decay in pairs. */
export const WEAR_MAGIC = 0x52574352;
/** 'RCGL': a part of the map kept outside the squares. */
export const GLOBAL_MAGIC = 0x4c474352;
/** 'RCRG': the manifest of a map saved by regions: its squares, its parts, its settings. */
export const MANIFEST_MAGIC = 0x47524352;
/** 'RCMF': a map file (Save map), the session's settings and the map's binary sections (`RoadDoc.toBinary`). */
export const FILE_MAGIC = 0x464d4352;
/** The map file's sections: the session's settings (JSON), the map (`RoadDoc.toBinary`). */
export const FILE_SETTINGS = 1, FILE_DOC = 2;
/** Bumped when the frame's layout changes. */
const FORMAT = 1;
/** Header words: magic, format, sections; then per section: kind, offset, length. */
const HEAD = 3, ENTRY = 3;

const align8 = (n: number): number => Math.ceil(n / 8) * 8;

export interface FrameSection { readonly kind: number; readonly bytes: Uint8Array }

/** A frame as pieces (its header and its sections, each padded): what a Blob is made of without one buffer of the whole (the map file). */
export function framePieces(magic: number, sections: readonly FrameSection[]): Uint8Array[] {
  const headBytes = align8((HEAD + sections.length * ENTRY) * 4);
  const head = new Uint8Array(headBytes);
  const view = new DataView(head.buffer);
  view.setUint32(0, magic, true); view.setUint32(4, FORMAT, true); view.setUint32(8, sections.length, true);
  const pieces: Uint8Array[] = [head];
  let at = headBytes;
  sections.forEach((s, i) => {
    const w = (HEAD + i * ENTRY) * 4;
    view.setUint32(w, s.kind, true); view.setUint32(w + 4, at, true); view.setUint32(w + 8, s.bytes.byteLength, true);
    pieces.push(s.bytes);
    const pad = align8(s.bytes.byteLength) - s.bytes.byteLength;
    if (pad) pieces.push(new Uint8Array(pad));
    at += align8(s.bytes.byteLength);
  });
  return pieces;
}

/** A frame in one plain buffer of its own (transferable to the save worker, MDN "Transferable objects"). Deterministic: the same sections, the same bytes. */
export function packFrame(magic: number, sections: readonly FrameSection[]): ArrayBuffer {
  const pieces = framePieces(magic, sections);
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of pieces) { out.set(p, at); at += p.byteLength; }
  return out.buffer;
}

/** The magic word a buffer starts with (0: too short to hold one). */
export function magicOf(bytes: ArrayBufferLike | Uint8Array): number {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength < HEAD * 4) return 0;
  return new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(0, true);
}

/** A frame's sections by kind (views on the buffer, never copied); null when the buffer is not a frame of `magic` in this format, or its directory points outside it. */
export function readFrame(bytes: ArrayBufferLike | Uint8Array, magic: number): Map<number, Uint8Array> | null {
  const all = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (all.byteLength < HEAD * 4) return null;
  const view = new DataView(all.buffer, all.byteOffset, all.byteLength);
  if (view.getUint32(0, true) !== magic || view.getUint32(4, true) !== FORMAT) return null;
  const count = view.getUint32(8, true);
  if ((HEAD + count * ENTRY) * 4 > all.byteLength) return null;
  const out = new Map<number, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const w = (HEAD + i * ENTRY) * 4;
    const kind = view.getUint32(w, true), offset = view.getUint32(w + 4, true), length = view.getUint32(w + 8, true);
    if (offset + length > all.byteLength) return null;
    out.set(kind, all.subarray(offset, offset + length));
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** A small value's JSON as UTF-8 bytes (one square's records, a manifest: never the map). */
export const jsonBytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
export const jsonOf = (bytes: Uint8Array): unknown => JSON.parse(decoder.decode(bytes));
/** Numbers as the bytes of a Float64Array (exact, as JSON was). */
export const f64Bytes = (values: readonly number[]): Uint8Array => new Uint8Array(Float64Array.from(values).buffer);
/** A Float64Array read from a section (copied when the section is not 8-byte aligned in its buffer). */
export function f64Of(bytes: Uint8Array): Float64Array | null {
  if (bytes.byteLength % 8 !== 0) return null;
  const own = bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
  return new Float64Array(own.buffer, own.byteOffset, own.byteLength / 8);
}

/** Whether bytes start as a gzip member does (RFC 1952: ID1 0x1f, ID2 0x8b). */
const isGzip = (bytes: Uint8Array): boolean => bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** Bytes compressed with gzip streams (MDN `CompressionStream`, in workers too); a browser without them keeps them plain - the reader knows which by the first bytes. */
export function gzipBytes(bytes: ArrayBuffer | Uint8Array): Promise<Blob> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
  if (typeof CompressionStream === 'undefined') return Promise.resolve(blob);
  return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

/** A stored blob's bytes: decompressed when gzip (MDN `DecompressionStream`), as they are when not. */
export async function gunzipBytes(blob: Blob): Promise<Uint8Array> {
  const raw = new Uint8Array(await blob.arrayBuffer());
  if (!isGzip(raw)) return raw;
  if (typeof DecompressionStream === 'undefined') throw new Error('[save] a compressed save and no DecompressionStream to read it');
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
