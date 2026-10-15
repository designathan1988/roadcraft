import type { RoadDoc, SerializedDoc } from '@world/doc';
import { type SavedSession, type SavedSettings, withUnit } from './persistence';

/** A file as Save map writes it (`persistence.ts` `importFromFile` reads it back). */
interface SerializedSession extends SavedSession {
  readonly version: 2;
}

/** DO NOT go back to one `JSON.stringify` of the whole map, nor indent it (indentation more than doubled the text). */
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
      ? { version: 2, document: doc.toJSON(), settings: withUnit(settings) }
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
  // Revoked a moment later: revoking synchronously can cancel the download before Firefox or Safari has started it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** How deep the export splits the map into pieces: the session, the document, its lists */
const EXPORT_SPLIT_DEPTH = 3;

/** `JSON.stringify(value)` (no indentation) as a list of pieces whose concatenation is that text */
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
