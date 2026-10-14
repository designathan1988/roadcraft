import type { RoadDoc, SerializedDoc } from '@world/doc';
import { METERS_PER_UNIT } from '@world/units';
import type { SavedSession, SavedSettings } from './persistence';

/** A file as Save map writes it (`persistence.ts` `importFromFile` reads it back). */
interface SerializedSession extends SavedSession {
  readonly version: 2;
}

/**
 * Offers the current map as a downloadable JSON file: true when it was
 * offered. A failure goes to `onFailed`, for the player to be told; with no
 * `onFailed` it is thrown, as before, so a caller that does not handle it
 * never reports a file that was not made.
 *
 * The text is written in pieces, never as one string: V8 refuses a string
 * past 2^29 - 24 characters (MDN, "String: length": `RangeError: Invalid
 * string length`), and the whole map as one indented text (`JSON.stringify(saved,
 * null, 2)`) reached it on a large city - the error escaped the click and the
 * player was told nothing. A `Blob` is the concatenation of its parts (MDN,
 * `Blob()`), so the file holds the same text. DO NOT go back to one
 * `JSON.stringify` of the whole map, nor indent it (indentation more than
 * doubled the text).
 */
export function exportToFile(
  doc: RoadDoc,
  settings?: SavedSettings,
  filename = 'roadcraft-map.json',
  onFailed?: (error: unknown) => void,
): boolean {
  let url: string;
  try {
    const saved: SerializedSession | SerializedDoc = settings
      // With the unit its camera is in, as the autosave stamps it (`persistence.ts` withUnit).
      ? { version: 2, document: doc.toJSON(), settings: { ...settings, unit: METERS_PER_UNIT } }
      : doc.toJSON();
    const blob = new Blob(jsonPieces(saved, EXPORT_SPLIT_DEPTH), { type: 'application/json' });
    url = URL.createObjectURL(blob);
  } catch (error) {
    if (!onFailed) throw error;
    console.error('[export] the map file could not be made', error);
    onFailed(error);
    return false;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked a moment later: revoking synchronously can cancel the download
  // before Firefox or Safari has started it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/**
 * How deep the export splits the map into pieces: the session, the document,
 * its lists (nodes, segments, buildings...) and each record of them. A record
 * (one building) is far below the string limit; a list of them is not.
 */
const EXPORT_SPLIT_DEPTH = 3;

/**
 * `JSON.stringify(value)` (no indentation) as a list of pieces whose
 * concatenation is that text, split down to `depth` levels of arrays and plain
 * objects; below it each value is one `JSON.stringify`. Follows its rules
 * (MDN, `JSON.stringify`): a value with `toJSON` is what that returns; in an
 * object, `undefined`, functions and symbols are left out; in an array they
 * are `null`.
 */
function jsonPieces(value: unknown, depth: number, out: string[] = []): string[] {
  const own = value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function'
    ? (value as { toJSON(): unknown }).toJSON() : value;
  if (depth <= 0 || own === null || typeof own !== 'object') {
    out.push(JSON.stringify(own) ?? 'null');
    return out;
  }
  if (Array.isArray(own)) {
    out.push('[');
    own.forEach((item: unknown, i) => {
      if (i > 0) out.push(',');
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') out.push('null');
      else jsonPieces(item, depth - 1, out);
    });
    out.push(']');
    return out;
  }
  out.push('{');
  let first = true;
  for (const [key, item] of Object.entries(own)) {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
    out.push(`${first ? '' : ','}${JSON.stringify(key)}:`);
    first = false;
    jsonPieces(item, depth - 1, out);
  }
  out.push('}');
  return out;
}
