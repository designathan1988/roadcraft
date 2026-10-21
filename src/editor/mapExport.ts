import type { RoadDoc } from '@world/doc';
import { type SavedSettings, withUnit } from './persistence';
import { FILE_MAGIC, FILE_DOC, FILE_SETTINGS, framePieces, jsonBytes } from './saveBinary';

/** The map file's name: a binary `.roadcraft` file (`persistence.ts` `importFromFile` reads it back, and the JSON files before it). */
export const MAP_FILE_NAME = 'roadcraft-map.roadcraft';

/** A map file (Save map) as the pieces of one Blob: the frame's header, the settings' JSON (with the unit its camera is in, as the autosave stamps it), the map's binary sections (`RoadDoc.toBinary`) - never one text of the map, nor one buffer of the file. */
export function mapFileBlob(doc: RoadDoc, settings?: SavedSettings): Blob {
  const sections = [
    ...(settings ? [{ kind: FILE_SETTINGS, bytes: jsonBytes(withUnit(settings)) }] : []),
    { kind: FILE_DOC, bytes: new Uint8Array(doc.toBinary()) },
  ];
  return new Blob(framePieces(FILE_MAGIC, sections) as Uint8Array<ArrayBuffer>[], { type: 'application/octet-stream' });
}

/** DO NOT go back to one `JSON.stringify` of the whole map: the file is the map's binary sections. */
export function exportToFile(
  doc: RoadDoc,
  settings?: SavedSettings,
  filename = MAP_FILE_NAME,
  onFailed?: (error: unknown) => void,
): boolean {
  let blob: Blob;
  try {
    blob = mapFileBlob(doc, settings);
  } catch (error) {
    if (!onFailed) throw error;
    console.error('[export] the map file could not be made', error);
    onFailed(error);
    return false;
  }
  return offerFile(blob, filename);
}

/** A file offered to the player to save (a link to it clicked): whether it was. */
export function offerFile(blob: Blob, filename: string): boolean {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked a moment later: revoking synchronously can cancel the download before Firefox or Safari has started it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
