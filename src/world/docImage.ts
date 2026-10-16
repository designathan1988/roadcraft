/** AN EDIT AS A COMMAND AND ITS INVERSE (`RoadDoc.beginEdit`/`endEdit`): the states before and after of what it changed. */
import type { DocPatch, ListPart, RecordPart, Restoration, SerializedDoc, ValuePart } from './doc';

export type { DocPatch } from './doc';

/** Each saved key of the map and the part that keeps it: a key added to the format and not here does not compile. */
export const PARTS_OF_SAVED = {
  version: null, unit: null,
  nodes: 'nodes', segments: 'segments', terrain: 'terrainStamps', relief: 'terrainRelief',
  markingStyle: 'markingStyle', nature: 'nature', poles: 'poles', poleSpans: 'poleSpans', paint: 'terrainPaint',
  fog: ['fogDabs', 'fogSettings'], gullies: ['gullyDabs', 'gullyAuto'], clouds: 'clouds', elements: 'elements', trees: 'trees',
  weather: 'weather', treeClearings: 'treeClearings', landscape: 'landscape', transit: 'transit', barriers: 'barriers',
  buildings: 'buildings', zones: 'zones', zoneMarks: 'zoneMarks', lots: 'lots', lotKeys: 'lotKeys', people: 'people', economy: 'economy',
} as const satisfies Record<keyof SerializedDoc, RecordPart | ListPart | ValuePart | readonly (ListPart | ValuePart)[] | null>;

/** One side of a patch as `RoadDoc.restore` takes it: `before` undoes, `after` redoes. */
export function sideOf(patch: DocPatch, side: 'before' | 'after'): Restoration {
  const back = side === 'before';
  if (patch.whole) return { records: [], lists: [], values: [], whole: back ? patch.whole.before : patch.whole.after! };
  return {
    records: patch.records.map((r) => ({ part: r.part, id: r.id, value: back ? r.before : r.after })),
    lists: patch.lists.map((l) => ({ part: l.part, start: l.start, remove: back ? l.after.length : l.before.length, items: back ? l.before : l.after })),
    values: patch.values.map((v) => ({ part: v.part, value: back ? v.before : v.after })),
  };
}
