/** AN EDIT AS A COMMAND AND ITS INVERSE (`RoadDoc.beginEdit`/`endEdit`): the states before and after of what it changed. */
import type { ListPart, RecordPart, Restoration, SerializedDoc, ValuePart } from './doc';

/** Each saved key of the map and the part that keeps it: a key added to the format and not here does not compile. */
export const PARTS_OF_SAVED = {
  version: null, unit: null,
  nodes: 'nodes', segments: 'segments', terrain: 'terrainStamps', relief: 'terrainRelief',
  markingStyle: 'markingStyle', nature: 'nature', poles: 'poles', poleSpans: 'poleSpans', paint: 'terrainPaint',
  fog: ['fogDabs', 'fogSettings'], gullies: ['gullyDabs', 'gullyAuto'], clouds: 'clouds', elements: 'elements', trees: 'trees',
  weather: 'weather', treeClearings: 'treeClearings', landscape: 'landscape', transit: 'transit', barriers: 'barriers',
  buildings: 'buildings', zones: 'zones', zoneMarks: 'zoneMarks', lots: 'lots', lotKeys: 'lotKeys', people: 'people', economy: 'economy',
} as const satisfies Record<keyof SerializedDoc, RecordPart | ListPart | ValuePart | readonly (ListPart | ValuePart)[] | null>;

export interface DocPatch {
  readonly records: readonly { readonly part: RecordPart; readonly id: number; readonly before: unknown; readonly after: unknown }[];
  readonly lists: readonly { readonly part: ListPart; readonly start: number; readonly before: readonly unknown[]; readonly after: readonly unknown[] }[];
  readonly values: readonly { readonly part: ValuePart; readonly before: unknown; readonly after: unknown }[];
  /** The whole map before and after, when the edit replaced it whole (a map opened, a city generated). */
  readonly whole?: { readonly before: SerializedDoc; readonly after: SerializedDoc };
  /** Roughly what it holds, UTF-16 bytes of its text. */
  readonly bytes: number;
}

/** One side of a patch as `RoadDoc.restore` takes it: `before` undoes, `after` redoes. */
export function sideOf(patch: DocPatch, side: 'before' | 'after'): Restoration {
  const back = side === 'before';
  if (patch.whole) return { records: [], lists: [], values: [], whole: back ? patch.whole.before : patch.whole.after };
  return {
    records: patch.records.map((r) => ({ part: r.part, id: r.id, value: back ? r.before : r.after })),
    lists: patch.lists.map((l) => ({ part: l.part, start: l.start, remove: back ? l.after.length : l.before.length, items: back ? l.before : l.after })),
    values: patch.values.map((v) => ({ part: v.part, value: back ? v.before : v.after })),
  };
}

const textBytes = (value: unknown): number => (value === undefined ? 0 : 2 * JSON.stringify(value).length);

/** What a patch holds, UTF-16 bytes of its text (`editor/history.ts` keeps the steps under a budget). */
export function patchBytes(records: DocPatch['records'], lists: DocPatch['lists'], values: DocPatch['values'], whole?: DocPatch['whole']): number {
  let bytes = whole ? textBytes(whole.before) + textBytes(whole.after) : 0;
  for (const r of records) bytes += textBytes(r.before) + (r.part === 'buildings' || r.part === 'lots' ? 0 : textBytes(r.after));
  for (const l of lists) bytes += textBytes(l.before) + textBytes(l.after);
  for (const v of values) bytes += textBytes(v.before) + textBytes(v.after);
  return bytes;
}
