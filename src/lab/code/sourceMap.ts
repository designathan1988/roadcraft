/** SOURCE MAPS (ECMA-426): a module Vite serves carries its map inline (`//# sourceMappingURL=data:...`); decoded here to find the TypeScript line a profiled function was written on. */

/** A place in an original source: the file's path on the server (`/src/...ts`), 1-based line and column. */
export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** The name the map gives the place, if any. */
  readonly name: string | null;
}

/** A module's map decoded: per generated line, its segments as [column, source, line, column, name] (-1: none). */
export interface DecodedMap {
  /** The sources resolved against the module's URL, as server paths. */
  readonly sources: readonly string[];
  readonly contents: readonly (string | null)[];
  readonly names: readonly string[];
  readonly lines: readonly Int32Array[];
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE64.length; i++) table[BASE64.charCodeAt(i)] = i;
  return table;
})();

/** The `mappings` string decoded (Base64 VLQ: 5 bits a digit, 32 the continuation, the first digit's lowest bit the sign; the generated column relative within a line, the rest across the whole string). */
export function decodeMappings(mappings: string): Int32Array[] {
  const lines: Int32Array[] = [];
  let source = 0, line = 0, column = 0, name = 0;
  let row: number[] = [];
  let genColumn = 0;
  const fields: number[] = [];
  let i = 0;
  const end = mappings.length;
  const flushSegment = (): void => {
    if (!fields.length) return;
    genColumn += fields[0]!;
    if (fields.length >= 4) {
      source += fields[1]!;
      line += fields[2]!;
      column += fields[3]!;
      if (fields.length >= 5) name += fields[4]!;
      row.push(genColumn, source, line, column, fields.length >= 5 ? name : -1);
    } else row.push(genColumn, -1, -1, -1, -1);
    fields.length = 0;
  };
  while (i <= end) {
    const c = i < end ? mappings.charCodeAt(i) : 59;
    if (c === 59 /* ; */) {
      flushSegment();
      lines.push(Int32Array.from(row));
      row = [];
      genColumn = 0;
      i++;
      continue;
    }
    if (c === 44 /* , */) {
      flushSegment();
      i++;
      continue;
    }
    // One VLQ value.
    let value = 0, shift = 0, digit: number;
    do {
      digit = DIGIT[mappings.charCodeAt(i++)] ?? -1;
      if (digit < 0) throw new Error(`invalid base64 in source map at ${i - 1}`);
      value += (digit & 31) << shift;
      shift += 5;
    } while (digit & 32);
    fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
  }
  return lines;
}

interface RawMap {
  readonly sources?: readonly (string | null)[];
  readonly sourceRoot?: string;
  readonly sourcesContent?: readonly (string | null)[];
  readonly names?: readonly string[];
  readonly mappings?: string;
}

/** A map's JSON decoded; its sources resolved against `baseUrl` (the module's URL) as server paths. */
export function decodeMap(raw: RawMap, baseUrl: string): DecodedMap {
  const root = raw.sourceRoot ? (raw.sourceRoot.endsWith('/') ? raw.sourceRoot : `${raw.sourceRoot}/`) : '';
  const sources = (raw.sources ?? []).map((s) => {
    if (s === null) return '(sem nome)';
    try {
      return decodeURI(new URL(root + s, baseUrl).pathname);
    } catch (error) {
      console.warn('lab code: unresolvable map source', s, error);
      return s;
    }
  });
  return { sources, contents: raw.sourcesContent ?? [], names: raw.names ?? [], lines: decodeMappings(raw.mappings ?? '') };
}

/** The original place of a generated position (0-based line and column): the segment at or before it on its line, else the line's first. */
export function lookup(map: DecodedMap, line: number, column: number): SourceLocation | null {
  const row = map.lines[line];
  if (!row || row.length === 0) return null;
  // Binary search over segments of 5 numbers for the last whose column <= column.
  let lo = 0, hi = row.length / 5 - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (row[mid * 5]! <= column) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // Before the line's first segment, or on an unmapped one: the nearest mapped segment on the line.
  let k = Math.max(found, 0);
  while (k < row.length / 5 && row[k * 5 + 1]! < 0) k++;
  if (k >= row.length / 5) return null;
  const at = k * 5;
  const name = row[at + 4]!;
  return { file: map.sources[row[at + 1]!] ?? '?', line: row[at + 2]! + 1, column: row[at + 3]! + 1, name: name >= 0 ? (map.names[name] ?? null) : null };
}

/** The map a module's text points to (inline `data:` or a file next to it), or null. */
export async function mapOfModule(text: string, url: string): Promise<DecodedMap | null> {
  const match = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(text.slice(-Math.min(text.length, 4_000_000)));
  if (!match) return null;
  const ref = match[1]!;
  let json: string;
  if (ref.startsWith('data:')) {
    const comma = ref.indexOf(',');
    const payload = ref.slice(comma + 1);
    if (/;base64/.test(ref.slice(0, comma))) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      json = new TextDecoder().decode(bytes);
    } else json = decodeURIComponent(payload);
  } else {
    const response = await fetch(new URL(ref, url));
    if (!response.ok) return null;
    json = await response.text();
  }
  return decodeMap(JSON.parse(json) as RawMap, url);
}
