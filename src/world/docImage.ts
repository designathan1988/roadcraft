/**
 * THE DOCUMENT AS LAST COMMITTED, and what changed since: the undo by
 * records (docs/ARCHITECTURE.md 5).
 *
 * Every edit serialized the whole map before and after (12.7 MB on a city of
 * 1 530 buildings) to compare the two texts and keep the "before" for undo.
 * Here the image keeps a copy of each record, list and value; `commit`
 * compares only the parts whose kind the diary says moved since the last
 * commit (Excalidraw's store finds its changes by comparing each element with
 * the last snapshot's), and hands back a patch: each changed record as it was
 * and as it is, each list's changed stretch, each changed value (tldraw's
 * `RecordsDiff`: added, updated [from, to], removed). Undo puts back the
 * "before" side, redo the "after" (`RoadDoc.restore`), through the diary like
 * any edit.
 *
 * The comparison is structural and generic (plain data), so a field added to a
 * record is compared without anyone listing it; the parts are checked complete
 * against the saved format (`PARTS_OF_SAVED`).
 * Pure: no three, no DOM.
 */
import type { DocChangeKind } from './changes';
import { DOC_CHANGE_KINDS } from './changes';
import { LIST_KINDS, type ListPart, type RecordPart, type Restoration, type RoadDoc, type SerializedDoc, type ValuePart } from './doc';

/** Each saved key of the map and the part that keeps it: a key added to the format and not here does not compile. */
export const PARTS_OF_SAVED = {
  version: null, unit: null,
  nodes: 'nodes', segments: 'segments', terrain: 'terrainStamps', relief: 'terrainRelief',
  markingStyle: 'markingStyle', nature: 'nature', poles: 'poles', poleSpans: 'poleSpans', paint: 'terrainPaint',
  fog: ['fogDabs', 'fogSettings'], gullies: ['gullyDabs', 'gullyAuto'], clouds: 'clouds', elements: 'elements', trees: 'trees',
  weather: 'weather', treeClearings: 'treeClearings', landscape: 'landscape', transit: 'transit', barriers: 'barriers',
  buildings: 'buildings', zones: 'zones', zoneMarks: 'zoneMarks', lots: 'lots', lotKeys: 'lotKeys', people: 'people', economy: 'economy',
} as const satisfies Record<keyof SerializedDoc, RecordPart | ListPart | ValuePart | readonly (ListPart | ValuePart)[] | null>;

/** The keyed collections: their records by id, and the kinds of change that move them. */
const RECORDS: readonly { readonly part: RecordPart; readonly kinds: readonly DocChangeKind[]; readonly entries: (d: RoadDoc) => Iterable<readonly [number, unknown]>; readonly get: (d: RoadDoc, id: number) => unknown; readonly immutable?: boolean }[] = [
  { part: 'nodes', kinds: ['roads', 'traffic'], entries: (d) => d.nodes, get: (d, id) => d.nodes.get(id as never) },
  { part: 'segments', kinds: ['roads', 'traffic'], entries: (d) => d.segments, get: (d, id) => d.segments.get(id as never) },
  { part: 'poles', kinds: ['utilities'], entries: (d) => d.poles, get: (d, id) => d.poles.get(id as never) },
  { part: 'poleSpans', kinds: ['utilities'], entries: (d) => d.poleSpans, get: (d, id) => d.poleSpans.get(id as never) },
  { part: 'landscape', kinds: ['landscape'], entries: (d) => d.landscape, get: (d, id) => d.landscape.get(id) },
  { part: 'barriers', kinds: ['barriers'], entries: (d) => d.barriers, get: (d, id) => d.barriers.get(id) },
  // A building's record is replaced, never changed in place (`BuildingStore.put`): kept by reference.
  { part: 'buildings', kinds: ['buildings', 'buildingWear'], entries: (d) => buildingEntries(d), get: (d, id) => d.buildings.get(id as never), immutable: true },
];
const LISTS = Object.keys(LIST_KINDS) as ListPart[];
/** The values and the kind that moves each; null: compared at every commit (they are small). */
const VALUES: Readonly<Record<ValuePart, DocChangeKind | null>> = {
  terrainRelief: 'terrain', markingStyle: null, nature: 'nature', fogSettings: 'fog', gullyAuto: 'gullies', weather: 'weather',
  economy: 'economy', transit: 'transit', nextZoneId: null, nextLotId: null, allocators: null,
};

function* buildingEntries(d: RoadDoc): Iterable<readonly [number, unknown]> {
  for (const b of d.buildings.all()) yield [b.id, b];
}

export interface DocPatch {
  readonly records: readonly { readonly part: RecordPart; readonly id: number; readonly before: unknown; readonly after: unknown }[];
  readonly lists: readonly { readonly part: ListPart; readonly start: number; readonly before: readonly unknown[]; readonly after: readonly unknown[] }[];
  readonly values: readonly { readonly part: ValuePart; readonly before: unknown; readonly after: unknown }[];
  /** Roughly what it holds, UTF-16 bytes of its text. */
  readonly bytes: number;
}

/** One side of a patch as `RoadDoc.restore` takes it: `before` undoes, `after` redoes. */
export function sideOf(patch: DocPatch, side: 'before' | 'after'): Restoration {
  const back = side === 'before';
  return {
    records: patch.records.map((r) => ({ part: r.part, id: r.id, value: back ? r.before : r.after })),
    lists: patch.lists.map((l) => ({ part: l.part, start: l.start, remove: back ? l.after.length : l.before.length, items: back ? l.before : l.after })),
    values: patch.values.map((v) => ({ part: v.part, value: back ? v.before : v.after })),
  };
}

/** Whether two plain values (numbers, strings, booleans, null, arrays, objects) are the same; a key holding `undefined` is no key. */
export function samePlain(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const arrayA = Array.isArray(a);
  if (arrayA !== Array.isArray(b)) return false;
  if (arrayA) {
    const x = a as unknown[], y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!samePlain(x[i], y[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  let count = 0;
  for (const k in x) {
    if (x[k] === undefined) continue;
    count++;
    if (!samePlain(x[k], y[k])) return false;
  }
  for (const k in y) if (y[k] !== undefined) count--;
  return count === 0;
}

const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

const IMMUTABLE: readonly RecordPart[] = RECORDS.filter((r) => r.immutable).map((r) => r.part);
const textBytes = (value: unknown): number => (value === undefined ? 0 : 2 * JSON.stringify(value).length);

/**
 * What a patch holds that the document does not, UTF-16 bytes of its text: the
 * copies, and of a record replaced whole (a building) only its old version -
 * its new one is the document's own. A town grown under one edit (1 348
 * buildings) was written out whole only to be counted: 75 ms on the click after.
 */
function bytesHeld(records: DocPatch['records'], lists: DocPatch['lists'], values: DocPatch['values']): number {
  let bytes = 0;
  for (const r of records) bytes += textBytes(r.before) + (IMMUTABLE.includes(r.part) ? 0 : textBytes(r.after));
  for (const l of lists) bytes += textBytes(l.before) + textBytes(l.after);
  for (const v of values) bytes += textBytes(v.before) + textBytes(v.after);
  return bytes;
}

export class DocImage {
  private readonly records = new Map<RecordPart, Map<number, unknown>>();
  private readonly lists = new Map<ListPart, unknown[]>();
  private readonly values = new Map<ValuePart, unknown>();
  /** The diary's serial of each kind at the last commit. */
  private readonly seen = new Map<DocChangeKind, number>();

  constructor(doc: RoadDoc) {
    this.take(doc);
  }

  /** Takes the whole document as it is (a copy of every record, list and value). */
  take(doc: RoadDoc): void {
    for (const r of RECORDS) {
      const kept = new Map<number, unknown>();
      for (const [id, value] of r.entries(doc)) kept.set(id, r.immutable ? value : copy(value));
      this.records.set(r.part, kept);
    }
    for (const part of LISTS) this.lists.set(part, doc.listOf(part).map((item) => copy(item)));
    for (const part of Object.keys(VALUES) as ValuePart[]) this.values.set(part, copy(doc.valueOf(part)));
    this.see(doc);
  }

  /**
   * What changed since the last commit, and the image brought up to the
   * document; null when nothing did. Compares only the parts whose kind moved
   * in the diary since (and the small values every time).
   */
  commit(doc: RoadDoc): DocPatch | null {
    return this.update(doc, true);
  }

  /**
   * The image brought up to the document, keeping nothing of what changed: a
   * change made with no edit open (a town growing on its own) is taken in
   * without a patch, which would copy every grown building into a step
   * nobody keeps.
   */
  absorb(doc: RoadDoc): void {
    this.update(doc, false);
  }

  private update(doc: RoadDoc, keep: boolean): DocPatch | null {
    const moved = (kinds: readonly DocChangeKind[]): boolean => kinds.some((k) => doc.changes.serialOf(k) > (this.seen.get(k) ?? 0));
    const records: DocPatch['records'][number][] = [];
    const lists: DocPatch['lists'][number][] = [];
    const values: DocPatch['values'][number][] = [];
    for (const r of RECORDS) {
      if (!moved(r.kinds)) continue;
      const at = performance.now();
      const kept = this.records.get(r.part)!;
      for (const [id, now] of r.entries(doc)) {
        const was = kept.get(id);
        if (was === now || (was !== undefined && samePlain(was, now))) continue;
        const after = r.immutable ? now : copy(now);
        if (keep) records.push({ part: r.part, id, before: was, after });
        kept.set(id, after);
      }
      for (const [id, was] of kept) {
        if (r.get(doc, id) !== undefined) continue;
        if (keep) records.push({ part: r.part, id, before: was, after: undefined });
        kept.delete(id);
      }
      if (performance.now() - at > 2) performance.measure(`hitch:image/${r.part} ${kept.size}`, { start: at, end: performance.now() });
    }
    for (const part of LISTS) {
      if (!moved([LIST_KINDS[part]])) continue;
      const at = performance.now();
      const kept = this.lists.get(part)!;
      const now = doc.listOf(part);
      let start = 0;
      while (start < kept.length && start < now.length && samePlain(kept[start], now[start])) start++;
      let end = 0;
      while (end < kept.length - start && end < now.length - start && samePlain(kept[kept.length - 1 - end], now[now.length - 1 - end])) end++;
      if (start === kept.length && start === now.length) continue;
      const before = kept.slice(start, kept.length - end);
      const after = now.slice(start, now.length - end).map((item) => copy(item));
      if (keep) lists.push({ part, start, before, after });
      kept.splice(start, before.length, ...(keep ? after.map((item) => copy(item)) : after));
      if (performance.now() - at > 2) performance.measure(`hitch:image/${part} ${now.length}`, { start: at, end: performance.now() });
    }
    for (const part of Object.keys(VALUES) as ValuePart[]) {
      const kind = VALUES[part];
      if (kind !== null && !moved([kind])) continue;
      const was = this.values.get(part);
      const now = doc.valueOf(part);
      if (samePlain(was, now)) continue;
      if (keep) values.push({ part, before: was, after: copy(now) });
      this.values.set(part, copy(now));
    }
    this.see(doc);
    if (!records.length && !lists.length && !values.length) return null;
    return { records, lists, values, bytes: bytesHeld(records, lists, values) };
  }

  private see(doc: RoadDoc): void {
    for (const kind of DOC_CHANGE_KINDS) this.seen.set(kind, doc.changes.serialOf(kind));
  }
}
