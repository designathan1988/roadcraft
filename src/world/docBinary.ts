import { type BuildingSections, sectionsBytes } from './buildings/sections';

/** THE MAP AS BINARY SECTIONS, NEVER ONE TEXT (report "Arquitetura para cidades grandes", "A conta de memória": V8 strings stop near 512 MiB; region files of offsets and lengths, each section read on its own): each part of the map's JSON one short UTF-8 section (a long list cut in runs), the buildings their table and what was written over it (`BuildingSections`). An undo of a whole map keeps the same image unpacked (`DocImage`), the buildings' table shared with the map it was, never copied. */

/** A part of the map as `RoadDoc.toJSON` writes it: one key's value, or a run of a long list's items; its JSON in UTF-8. */
export interface DocPart {
  readonly name: string;
  /** Of a list cut in runs: this run's items, appended to the runs before it of the same name. */
  readonly run: boolean;
  readonly bytes: Uint8Array;
}

/** The map unpacked: its parts in `toJSON`'s order, its buildings as buffers. */
export interface DocImage {
  readonly parts: readonly DocPart[];
  readonly buildings: BuildingSections;
}

/** The items of a list written in one section: a run's text stays far below the string ceiling whatever the map's size. */
const RUN = 20_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The map's JSON (no buildings) and its buildings as an image: each key's JSON on its own, a long list in runs. */
export function imageOf(data: object, buildings: BuildingSections): DocImage {
  const parts: DocPart[] = [];
  for (const [name, value] of Object.entries(data)) {
    if (value === undefined || name === 'buildings') continue;
    if (Array.isArray(value) && value.length > RUN) {
      for (let i = 0; i < value.length; i += RUN) parts.push({ name, run: true, bytes: encoder.encode(JSON.stringify(value.slice(i, i + RUN))) });
    } else {
      parts.push({ name, run: false, bytes: encoder.encode(JSON.stringify(value)) });
    }
  }
  return { parts, buildings };
}

/** The map's JSON (no buildings) read back from an image: the keys in their order, the runs of a list joined. */
export function dataOf(image: DocImage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of image.parts) {
    const value: unknown = JSON.parse(decoder.decode(part.bytes));
    if (part.run && Array.isArray(out[part.name])) { for (const item of value as unknown[]) (out[part.name] as unknown[]).push(item); continue; }
    out[part.name] = value;
  }
  return out;
}

/** What an image holds, bytes. */
export function imageBytes(image: DocImage): number {
  let bytes = sectionsBytes(image.buildings);
  for (const part of image.parts) bytes += part.bytes.byteLength;
  return bytes;
}

// ------------------------------------------------------------------ the file

const MAGIC = 0x42444352; // 'RCDB'
const FORMAT = 1;
/** Section kinds. */
const S_PART = 1, S_RUN = 2, S_BASE = 3, S_GONE = 4, S_REPLACED = 5, S_ADDED = 6;
/** Header words: magic, format, sections; then per section: kind, name length, offset, length. */
const HEAD = 3, ENTRY = 4;
const align8 = (n: number): number => Math.ceil(n / 8) * 8;

/** Whether bytes are a map in this binary form (the stores also keep texts: a save before it). */
export function isDocBinary(bytes: ArrayBufferLike): boolean {
  if (bytes.byteLength < HEAD * 4) return false;
  const head = new Uint32Array(bytes, 0, 2);
  return head[0] === MAGIC && head[1] === FORMAT;
}

/** An image packed in one buffer: a directory of sections (kind, name, offset, length), each section 8-byte aligned. Deterministic: the same image, the same bytes. */
export function packImage(image: DocImage): ArrayBuffer {
  const sections: { kind: number; name: Uint8Array; bytes: Uint8Array }[] = [];
  const none = new Uint8Array(0);
  for (const part of image.parts) sections.push({ kind: part.run ? S_RUN : S_PART, name: encoder.encode(part.name), bytes: part.bytes });
  const b = image.buildings;
  const add = (kind: number, buffer: ArrayBufferLike | null): void => { if (buffer) sections.push({ kind, name: none, bytes: new Uint8Array(buffer) }); };
  add(S_BASE, b.base);
  if (b.gone.length) sections.push({ kind: S_GONE, name: none, bytes: new Uint8Array(b.gone.buffer, b.gone.byteOffset, b.gone.byteLength) });
  add(S_REPLACED, b.replaced);
  add(S_ADDED, b.added);
  let at = align8((HEAD + sections.length * ENTRY) * 4);
  const places = sections.map((s) => {
    const name = at; at = align8(at + s.name.byteLength);
    const body = at; at = align8(at + s.bytes.byteLength);
    return { name, body };
  });
  const out = new ArrayBuffer(at);
  const words = new Uint32Array(out, 0, HEAD + sections.length * ENTRY);
  const bytes = new Uint8Array(out);
  words[0] = MAGIC; words[1] = FORMAT; words[2] = sections.length;
  sections.forEach((s, i) => {
    const w = HEAD + i * ENTRY;
    words[w] = s.kind; words[w + 1] = s.name.byteLength; words[w + 2] = places[i]!.name; words[w + 3] = s.bytes.byteLength;
    bytes.set(s.name, places[i]!.name);
    bytes.set(s.bytes, places[i]!.body);
  });
  return out;
}

/** An image read back from its buffer: each section its own copy (the buildings' tables in buffers of their own, as the store keeps them). */
export function unpackImage(buffer: ArrayBufferLike, own: (bytes: Uint8Array) => ArrayBufferLike = (bytes) => bytes.slice().buffer): DocImage {
  if (!isDocBinary(buffer)) throw new Error('[save] not a map in binary sections of this format');
  const words = new Uint32Array(buffer, 0, HEAD);
  const count = words[2]!;
  const dir = new Uint32Array(buffer, 0, HEAD + count * ENTRY);
  const parts: DocPart[] = [];
  let base: ArrayBufferLike | null = null, replaced: ArrayBufferLike | null = null, added: ArrayBufferLike | null = null;
  let gone = new Float64Array(0);
  for (let i = 0; i < count; i++) {
    const w = HEAD + i * ENTRY;
    const kind = dir[w]!, nameLength = dir[w + 1]!, nameAt = dir[w + 2]!, length = dir[w + 3]!;
    const bodyAt = align8(nameAt + nameLength);
    const body = new Uint8Array(buffer, bodyAt, length);
    switch (kind) {
      case S_PART: case S_RUN:
        parts.push({ name: decoder.decode(new Uint8Array(buffer, nameAt, nameLength).slice()), run: kind === S_RUN, bytes: body.slice() });
        break;
      case S_BASE: base = own(body); break;
      case S_GONE: gone = new Float64Array(body.slice().buffer); break;
      case S_REPLACED: replaced = own(body); break;
      case S_ADDED: added = own(body); break;
      default: throw new Error(`[save] a map in binary sections holds an unknown section ${kind}`);
    }
  }
  return { parts, buildings: { base, gone, replaced, added } };
}
