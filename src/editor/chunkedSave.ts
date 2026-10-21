import type { Building, BuildingId } from '@world/buildings/types';
import { type Change, type ChangeKind, type ChangeRect, DOC_CHANGE_KINDS } from '@world/changes';
import { JournalCursor } from '@world/derived';
import { CELL } from '@world/cells';
import { m } from '@world/units';
import type { PoleId, SpanId } from '@world/ids';
import type { Lot } from '@world/lotRecord';
import type { UtilityPole, UtilitySpan } from '@world/utilities';
import type { LandscapeItem } from '@world/landscape';
import type { Barrier } from '@world/barriers';
import {
  GLOBAL_PARTS, type GlobalPart, type RoadDoc, type RoadNode, type RoadSegment, type SavedGlobals, type SerializedDoc,
  savedBarrier, savedLandscape, savedNode, savedPole, savedSegment, savedSpan,
} from '@world/doc';
import { type PartStore, type SaveEntry, type SaveWriter, gunzip, storeWriter } from './saveStore';
import { GLOBAL_MAGIC, MANIFEST_MAGIC, REGION_CODEC, readValueFrame, squareFrame, valueFrame, wearFrame } from './regionFrames';

/** How many saved squares are decompressed at once when a map is read (`readTiles`). */
const GUNZIP_BATCH = 32;

/** THE MAP SAVED BY TILES: each record in the square of the map it stands in, and a save writes only the squares the diary says changed */

/** THE SQUARES AS BINARY REGIONS (manifest 6, 2026-10-21): each square one frame (`saveBinary.ts`) - the buildings their record table (`encodeRecords`), the other layers their records' JSON, the order as doubles - compressed by the save worker; the saves by tiles in JSON (manifest 5) and before them (manifest 3) still open, and are written as regions by the next save */

/** DO NOT walk the map to find what changed, nor write what did not: an edit in one tile writes that tile, whatever the map's size */

/** The side of the squares the map is saved by: the world's tile (CLAUDE.md, "One grid"). */
export const SAVE_TILE = m(1_024);
/** Buildings and lots by the world's cell: a dense tile holds thousands of buildings of ~7 KB, one edit would write megabytes. */
const DENSE_SQUARE = CELL;

/** The keyed layers (records with ids, any order) and the ordered lists (the order is meaning: stamps and dabs are laid in turn). */
type KeyedName = 'nodes' | 'segments' | 'poles' | 'spans' | 'landscape' | 'barriers' | 'buildings' | 'lots';
type ListName = 'stamps' | 'paint' | 'fog' | 'gullies' | 'clouds' | 'trees' | 'clearings' | 'elements' | 'zones' | 'zoneMarks';
type LayerName = KeyedName | ListName;
const KEYED_NAMES: readonly KeyedName[] = ['nodes', 'segments', 'poles', 'spans', 'landscape', 'barriers', 'buildings', 'lots'];
const LIST_NAMES: readonly ListName[] = ['stamps', 'paint', 'fog', 'gullies', 'clouds', 'trees', 'clearings', 'elements', 'zones', 'zoneMarks'];
const LAYER_NAMES: readonly LayerName[] = [...KEYED_NAMES, ...LIST_NAMES];

interface Place { readonly x: number; readonly y: number }
interface Keyed { readonly id: number }

/** A keyed layer: its records by id, the point that files each one (one square per record, so it is stored once) and its form in the file. */
interface KeyedSpec<T extends Keyed = Keyed> {
  readonly side: number;
  readonly kinds: readonly ChangeKind[];
  get(doc: RoadDoc, id: number): T | undefined;
  all(doc: RoadDoc): Iterable<T>;
  at(doc: RoadDoc, record: T): Place | undefined;
  saved(record: T): unknown;
  /** The record's place in its store's order, where the order means something (the lots: the first one holds a point). */
  order?(doc: RoadDoc, id: number): number;
  /** Records of other layers whose square or file form follows this one's (a node's roads: their curves are fitted to it). */
  reaches?(doc: RoadDoc, record: T): Iterable<readonly [KeyedName, number]>;
}
const keyed = <T extends Keyed>(spec: KeyedSpec<T>): KeyedSpec => spec as unknown as KeyedSpec;
const nodeOf = (doc: RoadDoc, id: number): RoadNode | undefined => (doc.nodes as ReadonlyMap<number, RoadNode>).get(id);

/** DO NOT file a road in every tile it crosses: a road is filed by its end `a`, a span by its pole `a`, a barrier by its first point. */
const KEYED: Readonly<Record<KeyedName, KeyedSpec>> = {
  nodes: keyed<RoadNode>({
    side: SAVE_TILE, kinds: ['roads', 'traffic'], get: nodeOf, all: (doc) => doc.nodes.values(), at: (_doc, n) => n, saved: savedNode,
    reaches: (_doc, n) => n.incident.map((s) => ['segments', s] as const),
  }),
  segments: keyed<RoadSegment>({
    side: SAVE_TILE, kinds: ['roads', 'traffic'], get: (doc, id) => (doc.segments as ReadonlyMap<number, RoadSegment>).get(id),
    all: (doc) => doc.segments.values(), at: (doc, s) => nodeOf(doc, s.a), saved: savedSegment,
  }),
  poles: keyed<UtilityPole>({
    side: SAVE_TILE, kinds: ['utilities'], get: (doc, id) => doc.poles.get(id as PoleId), all: (doc) => doc.poles.values(), at: (_doc, p) => p,
    saved: savedPole, reaches: (doc, p) => doc.spansAt(p.id).map((s) => ['spans', s.id] as const),
  }),
  spans: keyed<UtilitySpan>({
    side: SAVE_TILE, kinds: ['utilities'], get: (doc, id) => doc.poleSpans.get(id as SpanId), all: (doc) => doc.poleSpans.values(),
    at: (doc, s) => doc.poles.get(s.a), saved: savedSpan,
  }),
  landscape: keyed<LandscapeItem>({
    side: SAVE_TILE, kinds: ['landscape'], get: (doc, id) => doc.landscape.get(id), all: (doc) => doc.landscape.values(), at: (_doc, item) => item,
    saved: savedLandscape,
  }),
  barriers: keyed<Barrier>({
    side: SAVE_TILE, kinds: ['barriers'], get: (doc, id) => doc.barriers.get(id), all: (doc) => doc.barriers.values(), at: (_doc, b) => b.points[0],
    saved: savedBarrier,
  }),
  // `JSON.stringify` of a record is the text of its copy (`cloneBuilding` is a JSON round trip): the record itself is handed on.
  buildings: keyed<Building>({
    side: DENSE_SQUARE, kinds: ['buildings'], get: (doc, id) => doc.buildings.get(id as BuildingId), all: (doc) => doc.buildings.all(),
    at: (_doc, b) => b, saved: (b) => b,
  }),
  lots: keyed<Lot>({
    side: DENSE_SQUARE, kinds: ['lots'], get: (doc, id) => doc.lotStore.get(id), all: (doc) => doc.lotStore.all(), at: (_doc, lot) => lot.corners[0],
    saved: (lot) => lot, order: (doc, id) => doc.lotStore.orderOf(id) ?? 0,
  }),
};

/** An ordered list: its items and the point that files each one. */
interface ListSpec<T extends object = object> {
  readonly side: number;
  readonly kinds: readonly ChangeKind[];
  list(doc: RoadDoc): readonly T[];
  at(item: T): Place;
}
const listed = <T extends object>(spec: ListSpec<T>): ListSpec => spec as unknown as ListSpec;
const itself = (item: Place): Place => item;
const LISTS: Readonly<Record<ListName, ListSpec>> = {
  stamps: listed<Place>({ side: SAVE_TILE, kinds: ['terrain'], list: (doc) => doc.terrainStamps, at: itself }),
  paint: listed<Place>({ side: SAVE_TILE, kinds: ['paint'], list: (doc) => doc.terrainPaint, at: itself }),
  fog: listed<Place>({ side: SAVE_TILE, kinds: ['fog'], list: (doc) => doc.fogDabs, at: itself }),
  gullies: listed<Place>({ side: SAVE_TILE, kinds: ['gullies'], list: (doc) => doc.gullyDabs, at: itself }),
  clouds: listed<Place>({ side: SAVE_TILE, kinds: ['clouds'], list: (doc) => doc.clouds, at: itself }),
  trees: listed<Place>({ side: SAVE_TILE, kinds: ['trees'], list: (doc) => doc.trees, at: itself }),
  clearings: listed<Place>({ side: SAVE_TILE, kinds: ['clearings'], list: (doc) => doc.treeClearings, at: itself }),
  elements: listed<Place>({ side: SAVE_TILE, kinds: ['elements'], list: (doc) => doc.elements, at: itself }),
  zones: listed<{ readonly x0: number; readonly y0: number }>({ side: SAVE_TILE, kinds: ['zones'], list: (doc) => doc.zones, at: (z) => ({ x: z.x0, y: z.y0 }) }),
  zoneMarks: listed<Place>({ side: SAVE_TILE, kinds: ['zones'], list: (doc) => doc.zoneMarks, at: itself }),
};

/** The kinds each part kept outside the tiles is written again for. */
const GLOBAL_KINDS: Readonly<Record<GlobalPart, readonly ChangeKind[]>> = {
  values: ['terrain', 'fog', 'gullies', 'nature', 'weather', 'economy', 'markingStyle'],
  lotKeys: ['lotKeys'],
  people: ['people'],
  transit: ['transit'],
};

/** A record with no place (a road whose end is gone) is filed in the square at the origin. */
const NOWHERE = '0,0';
const squareAt = (at: Place | undefined, side: number): string => (at ? `${Math.floor(at.x / side)},${Math.floor(at.y / side)}` : NOWHERE);
function squareRect(square: string, side: number): ChangeRect {
  const comma = square.indexOf(',');
  const cx = Number(square.slice(0, comma)), cy = Number(square.slice(comma + 1));
  return [cx * side, cy * side, (cx + 1) * side, (cy + 1) * side];
}
const meets = (a: ChangeRect, b: ChangeRect): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Where a keyed layer's records are filed and which squares are stored and which are not the map's any more. */
class KeyedState {
  /** Each record's square as the map stood at the last look. */
  readonly where = new Map<number, string>();
  readonly members = new Map<string, Set<number>>();
  /** The squares with a blob stored. */
  stored = new Set<string>();
  /** The squares whose blob is not the map's: written by the next save. */
  dirty = new Set<string>();
  /** The buildings' squares whose wears alone changed. */
  wear = new Set<string>();

  /** A record now in `now` (null: gone): where it was and where it is are both written again. */
  place(id: number, now: string | null): void {
    const was = this.where.get(id);
    if (was !== undefined) this.dirty.add(was);
    if (now !== null) this.dirty.add(now);
    if (was === now) return;
    if (was !== undefined) {
      const set = this.members.get(was);
      set?.delete(id);
      if (set?.size === 0) this.members.delete(was);
    }
    if (now === null) { this.where.delete(id); return; }
    this.where.set(id, now);
    let set = this.members.get(now);
    if (!set) this.members.set(now, set = new Set());
    set.add(id);
  }

  /** The squares a change reaches (null: all of them), among those that hold records or a blob. */
  dirtyOver(rects: readonly ChangeRect[] | null, side: number): void {
    const visit = (square: string): void => {
      if (rects === null || rects.some((r) => meets(r, squareRect(square, side)))) this.dirty.add(square);
    };
    for (const square of this.members.keys()) visit(square);
    for (const square of this.stored) visit(square);
  }
}

/** An ordered list's items by reference: each one's place in the order (a fraction between its neighbours') and its square. */
class ListState {
  ords = new WeakMap<object, number>();
  square = new WeakMap<object, string>();
  counts = new Map<string, number>();
  stored = new Set<string>();
  dirty = new Set<string>();
  /** The diary wrote the list's kind since the last look, and where (null: anywhere). */
  changed = false;
  rects: ChangeRect[] | null = [];
}

const freshKeyed = (): Record<KeyedName, KeyedState> =>
  Object.fromEntries(KEYED_NAMES.map((name) => [name, new KeyedState()])) as Record<KeyedName, KeyedState>;
const freshLists = (): Record<ListName, ListState> =>
  Object.fromEntries(LIST_NAMES.map((name) => [name, new ListState()])) as Record<ListName, ListState>;

/** DO NOT number the items by their index: one item taken from the front would renumber, and write, every tile of the list */
function placeInOrder(list: readonly object[], ords: WeakMap<object, number>): Set<object> | 'all' {
  const fresh = new Set<object>();
  let last = -Infinity;
  let i = 0;
  while (i < list.length) {
    const own = ords.get(list[i]!);
    if (own !== undefined && own > last) { last = own; i++; continue; }
    // A run of items with no place (new, or out of order) up to the next one whose place still holds.
    let j = i + 1;
    while (j < list.length) {
      const next = ords.get(list[j]!);
      if (next !== undefined && next > last) break;
      j++;
    }
    const count = j - i;
    const bound = j < list.length ? ords.get(list[j]!)! : undefined;
    const lo = last !== -Infinity ? last : bound !== undefined ? bound - count - 1 : 0;
    const hi = bound ?? lo + count + 1;
    const step = (hi - lo) / (count + 1);
    for (let k = 0; k < count; k++) {
      const value = lo + step * (k + 1);
      // No room left between two neighbours in a double: the whole list numbered again (every one of its tiles written).
      if (!(value > last) || !(value < hi)) { list.forEach((item, at) => ords.set(item, at + 1)); return 'all'; }
      ords.set(list[i + k]!, value);
      fresh.add(list[i + k]!);
      last = value;
    }
    i = j;
  }
  return fresh;
}

/** The current format: version 5, each layer's squares by key, the parts kept outside the tiles. */
interface TiledManifest {
  readonly version: 5 | 6;
  readonly savedAt: number;
  readonly settings: unknown;
  readonly squares: Partial<Record<LayerName, readonly string[]>>;
  readonly globals: readonly GlobalPart[];
}
/** The binary regions: the same index as the tiles', its blobs binary frames under keys of their own. */
interface RegionManifest {
  readonly version: 6;
  readonly savedAt: number;
  readonly settings: unknown;
  readonly squares: Partial<Record<LayerName, readonly string[]>>;
  readonly globals: readonly GlobalPart[];
}
/** The format before the tiles (2026-10): the head in one text and the buildings in parts of 512 ids. */
interface OldManifest {
  readonly version: 3;
  readonly savedAt: number;
  readonly parts: readonly number[];
  readonly settings: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function isTiledManifest(value: unknown, version: 5 | 6 = 5): value is TiledManifest {
  if (!isObject(value) || value['version'] !== version || typeof value['savedAt'] !== 'number') return false;
  const squares = value['squares'], globals = value['globals'];
  if (!isObject(squares) || !Array.isArray(globals)) return false;
  return Object.entries(squares).every(([name, list]) => (LAYER_NAMES as readonly string[]).includes(name)
    && Array.isArray(list) && list.every((s) => typeof s === 'string'))
    && globals.every((part) => (GLOBAL_PARTS as readonly unknown[]).includes(part));
}

function isOldManifest(value: unknown): value is OldManifest {
  return isObject(value) && value['version'] === 3 && typeof value['savedAt'] === 'number' && Array.isArray(value['parts'])
    && (value['parts'] as unknown[]).every((p) => Number.isInteger(p));
}

/** How the map just read was stored: what `adopt` needs so the next save writes only what changes. */
export interface SavedLayout {
  /** The keys of a map saved in a format before the binary regions (kept for an older build; the next save writes the map whole as regions); null: saved as regions. */
  readonly old: readonly string[] | null;
  readonly squares: Partial<Record<LayerName, readonly string[]>>;
  readonly globals: readonly GlobalPart[];
  /** Each keyed record's square, as stored. */
  readonly where: Partial<Record<KeyedName, ReadonlyMap<number, string>>>;
  /** Each list's places in the order and squares, in the order read. */
  readonly lists: Partial<Record<ListName, { readonly ords: readonly number[]; readonly squares: readonly string[] }>>;
}

/** What a tiled save reads back. */
interface TiledSession {
  readonly document: SerializedDoc;
  readonly settings: unknown;
  readonly savedAt: number;
  readonly layout: SavedLayout;
}

/** A stored blob of a layer's square: its records (`r`) and, for a list or the lots, their places in the order (`o`). */
interface SquareBlob { readonly r: readonly unknown[]; readonly o?: readonly number[] }
function isSquareBlob(value: unknown): value is SquareBlob {
  if (!isObject(value)) return false;
  const r = value['r'], o = value['o'];
  return Array.isArray(r) && (o === undefined || (Array.isArray(o) && o.length === r.length));
}
function idOf(record: unknown): number {
  const id = isObject(record) ? record['id'] : undefined;
  return typeof id === 'number' ? id : Number.NaN;
}

export class TiledSaves {
  /** The diary read up to the last save (every kind of the document). */
  private readonly cursor = new JournalCursor(DOC_CHANGE_KINDS);
  /** The document the stored squares are of; another one is compared whole. */
  private doc: RoadDoc | null = null;
  private keyed = freshKeyed();
  private lists = freshLists();
  /** The parts kept outside the tiles to write again, and those stored. */
  private globals = new Set<GlobalPart>(GLOBAL_PARTS);
  private storedGlobals = new Set<GlobalPart>();
  /** The keys of a map stored before the tiles: removed in the transaction that writes it by tiles. */
  private oldKeys: readonly string[] = [];
  /** Saves one after another: a save under way finishes before the next reads the map. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly writer: SaveWriter;

  constructor(private readonly store: PartStore, private readonly key: string) {
    this.writer = store.writer ?? storeWriter(store);
  }

  private blobKey(layer: LayerName, square: string): string { return `${this.key}:R:${layer}:${square}`; }
  private wearKey(square: string): string { return `${this.key}:RW:${square}`; }
  private globalKey(part: GlobalPart): string { return `${this.key}:RG:${part}`; }
  /** The regions' manifest. The manifests before it (`:tiles`, version 5 in JSON; `:manifest`, version 3) are never written or removed here: an older build still opens the map they hold. */
  private get manifestKey(): string { return `${this.key}:regions`; }
  private get tilesManifestKey(): string { return `${this.key}:tiles`; }
  private get oldManifestKey(): string { return `${this.key}:manifest`; }
  /** The keys of the tiles in JSON (manifest 5). */
  private readonly tileKeys: SquareKeys = {
    blob: (layer, square) => `${this.key}:L:${layer}:${square}`,
    wear: (square) => `${this.key}:W:${square}`,
    global: (part) => `${this.key}:G:${part}`,
  };
  private readonly regionKeys: SquareKeys = {
    blob: (layer, square) => this.blobKey(layer, square),
    wear: (square) => this.wearKey(square),
    global: (part) => this.globalKey(part),
  };

  save(doc: RoadDoc, settings: unknown, savedAt = Date.now()): Promise<boolean> {
    return this.queued(() => this.write(doc, settings, savedAt));
  }

  /** The document just opened from this store (`Persistence.adoptLoaded`): what it holds is what is stored. */
  adopt(doc: RoadDoc, layout: SavedLayout): void {
    this.doc = doc;
    this.cursor.read(doc.changes);
    this.keyed = freshKeyed();
    this.lists = freshLists();
    this.globals = new Set();
    this.storedGlobals = new Set(layout.globals);
    this.oldKeys = layout.old ?? [];
    // A map stored before the tiles: written whole, by tiles, at the next save.
    if (layout.old) { this.everything(doc); return; }
    for (const name of KEYED_NAMES) {
      const st = this.keyed[name];
      st.stored = new Set(layout.squares[name] ?? []);
      for (const [id, square] of layout.where[name] ?? []) st.place(id, square);
      st.dirty.clear();
      // @rebuild Once, at the opening: a record the loader moved or dropped (a repair) has its squares written again.
      this.reconcile(doc, name, []);
    }
    for (const name of LIST_NAMES) {
      const st = this.lists[name], spec = LISTS[name];
      st.stored = new Set(layout.squares[name] ?? []);
      const read = layout.lists[name] ?? { ords: [], squares: [] };
      const list = spec.list(doc);
      // The loader dropped or capped items: the list placed again and every square of it written.
      if (read.ords.length !== list.length) { st.changed = true; st.rects = null; continue; }
      list.forEach((item, i) => {
        const square = read.squares[i]!;
        st.ords.set(item, read.ords[i]!);
        st.square.set(item, square);
        st.counts.set(square, (st.counts.get(square) ?? 0) + 1);
        if (squareAt(spec.at(item), spec.side) !== square) st.changed = true;
      });
    }
  }

  /** Nothing is known to be stored the way the map stands: the next save compares and writes every square. */
  private everything(doc: RoadDoc): void {
    for (const name of KEYED_NAMES) this.reconcile(doc, name, null);
    for (const name of LIST_NAMES) { this.lists[name].changed = true; this.lists[name].rects = null; }
    for (const part of GLOBAL_PARTS) this.globals.add(part);
  }

  /** What the diary says changed since the last look, added to what waits to be written. */
  private take(doc: RoadDoc): void {
    const same = this.doc === doc;
    const entries = this.cursor.read(doc.changes);
    this.doc = doc;
    if (!same || entries === null) { this.everything(doc); return; }
    for (const entry of entries) this.note(doc, entry);
  }

  private note(doc: RoadDoc, entry: Change): void {
    const kind = entry.kind;
    for (const part of GLOBAL_PARTS) if (GLOBAL_KINDS[part].includes(kind)) this.globals.add(part);
    if (kind === 'buildingWear') { this.worn(doc, entry); return; }
    for (const name of KEYED_NAMES) {
      if (!KEYED[name].kinds.includes(kind)) continue;
      // The ids of an entry may be of either layer of its kind (a road's: nodes and segments): each one looked up in both.
      if (entry.ids) for (const id of entry.ids) this.touch(doc, name, id);
      else this.reconcile(doc, name, entry.rects);
    }
    for (const name of LIST_NAMES) {
      if (!LISTS[name].kinds.includes(kind)) continue;
      const st = this.lists[name];
      st.changed = true;
      if (entry.rects === null) st.rects = null;
      else st.rects?.push(...entry.rects);
    }
  }

  /** Buildings whose wear alone changed: their squares' wears, never their records. */
  private worn(doc: RoadDoc, entry: Change): void {
    const st = this.keyed.buildings;
    if (!entry.ids) { for (const square of st.members.keys()) st.wear.add(square); return; }
    for (const id of entry.ids) {
      if (!st.where.has(id)) this.touch(doc, 'buildings', id);
      const square = st.where.get(id);
      if (square !== undefined) st.wear.add(square);
    }
  }

  /** One record of a layer looked up by id: where it was and where it is now written again. */
  private touch(doc: RoadDoc, name: KeyedName, id: number): void {
    const spec = KEYED[name];
    const record = spec.get(doc, id);
    this.keyed[name].place(id, record ? squareAt(spec.at(doc, record), spec.side) : null);
    if (record && spec.reaches) for (const [other, otherId] of spec.reaches(doc, record)) this.touch(doc, other, otherId);
  }

  /** @rebuild An entry that names no ids (a whole-map change): the layer's records walked once, each one's square checked */
  private reconcile(doc: RoadDoc, name: KeyedName, rects: readonly ChangeRect[] | null): void {
    const spec = KEYED[name], st = this.keyed[name];
    const seen = new Set<number>();
    for (const record of spec.all(doc)) {
      seen.add(record.id);
      const now = squareAt(spec.at(doc, record), spec.side);
      if (st.where.get(record.id) !== now) st.place(record.id, now);
    }
    for (const id of [...st.where.keys()]) if (!seen.has(id)) st.place(id, null);
    st.dirtyOver(rects, spec.side);
  }

  /** An ordered list whose kind changed: each item's place in the order kept (new ones between their neighbours) and its square checked. */
  private walk(doc: RoadDoc, name: ListName): void {
    const spec = LISTS[name], st = this.lists[name];
    const list = spec.list(doc);
    const rects = st.rects;
    const visit = (square: string): void => {
      if (rects === null || rects.some((r) => meets(r, squareRect(square, spec.side)))) st.dirty.add(square);
    };
    for (const square of st.counts.keys()) visit(square);
    for (const square of st.stored) visit(square);
    const placed = placeInOrder(list, st.ords);
    const counts = new Map<string, number>();
    for (const item of list) {
      const square = squareAt(spec.at(item), spec.side);
      counts.set(square, (counts.get(square) ?? 0) + 1);
      const was = st.square.get(item);
      if (was !== square) {
        if (was !== undefined) st.dirty.add(was);
        st.dirty.add(square);
        st.square.set(item, square);
      } else if (placed === 'all' || placed.has(item)) st.dirty.add(square);
    }
    // An item gone leaves its square one short.
    for (const [square, n] of st.counts) if (counts.get(square) !== n) st.dirty.add(square);
    for (const [square, n] of counts) if (st.counts.get(square) !== n) st.dirty.add(square);
    st.counts = counts;
    st.changed = false;
    st.rects = [];
  }

  private async write(doc: RoadDoc, settings: unknown, savedAt: number): Promise<boolean> {
    this.take(doc);
    for (const name of LIST_NAMES) if (this.lists[name].changed) this.walk(doc, name);
    const put: SaveEntry[] = [];
    // DO NOT remove the map saved before the tiles: it is the player's, and an older build reads only it.
    const remove: string[] = [];
    // Taken now; put back if the write fails (with whatever came meanwhile).
    const takenKeyed = new Map<KeyedName, { readonly dirty: Set<string>; readonly wear: Set<string> }>();
    const takenLists = new Map<ListName, Set<string>>();
    const nextStored = new Map<LayerName, Set<string>>();
    for (const name of KEYED_NAMES) {
      const spec = KEYED[name], st = this.keyed[name];
      const { dirty, wear } = st;
      st.dirty = new Set();
      st.wear = new Set();
      takenKeyed.set(name, { dirty, wear });
      const stored = new Set(st.stored);
      for (const square of dirty) {
        const records = this.recordsIn(doc, name, square);
        if (records.length === 0) {
          if (st.stored.has(square)) { remove.push(this.blobKey(name, square)); if (name === 'buildings') remove.push(this.wearKey(square)); }
          stored.delete(square);
          continue;
        }
        const orders = spec.order ? records.map((r) => spec.order!(doc, r.id)) : null;
        put.push({ key: this.blobKey(name, square), bytes: squareFrame(name === 'buildings', records.map((r) => spec.saved(r)), orders), packed: true });
        if (name === 'buildings') put.push({ key: this.wearKey(square), bytes: wearFrame(records as Building[]), packed: false });
        stored.add(square);
      }
      // The stored squares whose wears alone are written: their records stand as stored.
      for (const square of wear) {
        if (dirty.has(square) || !st.stored.has(square)) continue;
        const records = this.recordsIn(doc, name, square);
        if (records.length) put.push({ key: this.wearKey(square), bytes: wearFrame(records as Building[]), packed: false });
      }
      nextStored.set(name, stored);
    }
    for (const name of LIST_NAMES) {
      const st = this.lists[name];
      const dirty = st.dirty;
      st.dirty = new Set();
      takenLists.set(name, dirty);
      const stored = new Set(st.stored);
      if (dirty.size) {
        // The items of the squares to write, in the list's order (one pass of references; only these are handed on).
        const out = new Map<string, { r: object[]; o: number[] }>();
        for (const square of dirty) out.set(square, { r: [], o: [] });
        for (const item of LISTS[name].list(doc)) {
          const blob = out.get(st.square.get(item) ?? '');
          if (blob) { blob.r.push(item); blob.o.push(st.ords.get(item) ?? 0); }
        }
        for (const [square, blob] of out) {
          if (blob.r.length === 0) {
            if (st.stored.has(square)) remove.push(this.blobKey(name, square));
            stored.delete(square);
            continue;
          }
          put.push({ key: this.blobKey(name, square), bytes: squareFrame(false, blob.r, blob.o), packed: true });
          stored.add(square);
        }
      }
      nextStored.set(name, stored);
    }
    const globals = this.globals;
    this.globals = new Set();
    for (const part of globals) put.push({ key: this.globalKey(part), bytes: valueFrame(GLOBAL_MAGIC, doc.savedGlobals(part)), packed: true });
    const storedGlobals = new Set([...this.storedGlobals, ...globals]);
    const squares: Partial<Record<LayerName, string[]>> = {};
    for (const [name, set] of nextStored) if (set.size) squares[name] = [...set].sort();
    const manifest: RegionManifest = { version: 6, savedAt, settings, squares, globals: GLOBAL_PARTS.filter((p) => storedGlobals.has(p)) };
    put.push({ key: this.manifestKey, bytes: valueFrame(MANIFEST_MAGIC, manifest), packed: false });
    const oldKeys = this.oldKeys;
    this.oldKeys = [];
    if (!(await this.writer.write({ put, remove }))) {
      for (const [name, taken] of takenKeyed) {
        const st = this.keyed[name];
        for (const square of taken.dirty) st.dirty.add(square);
        for (const square of taken.wear) st.wear.add(square);
      }
      for (const [name, taken] of takenLists) for (const square of taken) this.lists[name].dirty.add(square);
      for (const part of globals) this.globals.add(part);
      this.oldKeys = oldKeys;
      return false;
    }
    for (const name of KEYED_NAMES) this.keyed[name].stored = nextStored.get(name)!;
    for (const name of LIST_NAMES) this.lists[name].stored = nextStored.get(name)!;
    this.storedGlobals = storedGlobals;
    return true;
  }

  /** The records filed in one square, by id: the square's ids looked up, never the layer walked. */
  private recordsIn(doc: RoadDoc, name: KeyedName, square: string): Keyed[] {
    const spec = KEYED[name];
    const ids = [...(this.keyed[name].members.get(square) ?? [])].sort((a, b) => a - b);
    const out: Keyed[] = [];
    for (const id of ids) { const record = spec.get(doc, id); if (record) out.push(record); }
    return out;
  }

  /** The map saved here (as regions, by tiles in JSON, or in the format before them), or null when there is none or it cannot be read. Each format is known by its manifest, the regions' by its magic word. */
  async read(): Promise<TiledSession | null> {
    const [regionBlob, tilesBlob, oldBlob] = await this.store.get([this.manifestKey, this.tilesManifestKey, this.oldManifestKey]);
    const regions = regionBlob ? readValueFrame(await regionBlob.arrayBuffer(), MANIFEST_MAGIC) : null;
    if (isTiledManifest(regions, 6)) return this.readSquares(regions, this.regionKeys, REGION_CODEC, null);
    const tiles: unknown = tilesBlob ? JSON.parse(await tilesBlob.text()) : null;
    if (isTiledManifest(tiles)) return this.readSquares(tiles, this.tileKeys, JSON_CODEC, [...this.keysOf(tiles, this.tileKeys), this.tilesManifestKey]);
    const old: unknown = oldBlob ? JSON.parse(await oldBlob.text()) : null;
    if (isOldManifest(old)) return this.readOld(old);
    return null;
  }

  /** The keys a manifest's squares, wears and parts are held under. */
  private keysOf(manifest: TiledManifest, keys: SquareKeys): string[] {
    const out: string[] = [];
    for (const name of LAYER_NAMES) for (const square of manifest.squares[name] ?? []) out.push(keys.blob(name, square));
    for (const square of manifest.squares.buildings ?? []) out.push(keys.wear(square));
    for (const part of manifest.globals) out.push(keys.global(part));
    return out;
  }

  /** A map by squares read back, its blobs decoded by `codec`; `old`: the keys of a format before the regions (the next save writes the map whole). */
  private async readSquares(manifest: TiledManifest, keys: SquareKeys, codec: SquareCodec, old: readonly string[] | null): Promise<TiledSession | null> {
    const blobs: { layer: LayerName; square: string }[] = [];
    for (const name of LAYER_NAMES) for (const square of manifest.squares[name] ?? []) blobs.push({ layer: name, square });
    const wearSquares = manifest.squares.buildings ?? [];
    const got = await this.store.get([
      ...blobs.map((b) => keys.blob(b.layer, b.square)), ...wearSquares.map((s) => keys.wear(s)), ...manifest.globals.map((p) => keys.global(p)),
    ]);
    performance.mark('save:files-read');
    const globals: Record<string, unknown> = {};
    for (let i = 0; i < manifest.globals.length; i++) {
      const blob = got[blobs.length + wearSquares.length + i];
      if (!blob) return null;
      const part = await codec.global(blob);
      if (!isObject(part)) return null;
      Object.assign(globals, part);
    }
    if (globals['version'] !== 1) return null;
    // Each square's wears, where kept: laid over the records stored before them.
    const wears = new Map<number, number>();
    for (let i = 0; i < wearSquares.length; i++) {
      const blob = got[blobs.length + i];
      const read = blob ? await codec.wears(blob) : null;
      if (read) for (const [id, decay] of read) wears.set(id, decay);
    }
    const keyedRead = new Map<KeyedName, { record: unknown; id: number; order: number; square: string }[]>();
    const listRead = new Map<ListName, { item: unknown; ord: number; square: string }[]>();
    // DO NOT wait for each square's decompression before starting the next (EDT-03: hundreds, one after the other, at the opening): a batch at a time in flight, read in the same order.
    for (let i = 0; i < blobs.length; i += GUNZIP_BATCH) {
      const batch: Promise<SquareBlob | null>[] = [];
      for (let k = i; k < Math.min(blobs.length, i + GUNZIP_BATCH); k++) {
        const blob = got[k];
        if (!blob) return null;
        batch.push(codec.square(blob));
      }
      const values = await Promise.all(batch);
      for (let k = 0; k < values.length; k++) {
        const value = values[k];
        if (!value) return null;
        const { layer, square } = blobs[i + k]!;
        if ((KEYED_NAMES as readonly LayerName[]).includes(layer)) {
          const name = layer as KeyedName;
          const out = keyedRead.get(name) ?? [];
          keyedRead.set(name, out);
          value.r.forEach((record, j) => out.push({
            record: name === 'buildings' ? withWear(record, wears) : record, id: idOf(record), order: value.o?.[j] ?? 0, square,
          }));
        } else {
          const name = layer as ListName;
          if (!value.o) return null;
          const out = listRead.get(name) ?? [];
          listRead.set(name, out);
          value.r.forEach((item, j) => out.push({ item, ord: value.o![j]!, square }));
        }
      }
    }
    performance.mark('save:parsed');
    for (const [name, out] of keyedRead) out.sort(name === 'lots' ? (a, b) => a.order - b.order || a.id - b.id : (a, b) => a.id - b.id);
    for (const out of listRead.values()) out.sort((a, b) => a.ord - b.ord);
    const records = (name: KeyedName): unknown[] => (keyedRead.get(name) ?? []).map((e) => e.record);
    const items = (name: ListName): unknown[] => (listRead.get(name) ?? []).map((e) => e.item);
    const { fogSettings, gullyAuto, ...rest } = globals as SavedGlobals & Record<string, unknown>;
    const document = {
      ...rest,
      nodes: records('nodes'), segments: records('segments'), terrain: items('stamps'), paint: items('paint'),
      fog: { dabs: items('fog'), ...(fogSettings !== undefined ? { settings: fogSettings } : {}) },
      gullies: { dabs: items('gullies'), ...(gullyAuto !== undefined ? { auto: gullyAuto } : {}) },
      clouds: items('clouds'), elements: items('elements'), trees: items('trees'), treeClearings: items('clearings'),
      poles: records('poles'), poleSpans: records('spans'), landscape: records('landscape'), barriers: records('barriers'),
      buildings: records('buildings'), zones: items('zones'), zoneMarks: items('zoneMarks'), lots: records('lots'), lotKeys: rest.lotKeys ?? [],
    } as unknown as SerializedDoc;
    // A format before the regions: nothing of it is the regions' layout, the next save writes every square.
    if (old) return { document, settings: manifest.settings, savedAt: manifest.savedAt, layout: { old, squares: {}, globals: [], where: {}, lists: {} } };
    const where: Partial<Record<KeyedName, Map<number, string>>> = {};
    for (const [name, out] of keyedRead) where[name] = new Map(out.map((e) => [e.id, e.square] as const));
    const lists: Partial<Record<ListName, { ords: number[]; squares: string[] }>> = {};
    for (const [name, out] of listRead) lists[name] = { ords: out.map((e) => e.ord), squares: out.map((e) => e.square) };
    return {
      document, settings: manifest.settings, savedAt: manifest.savedAt,
      layout: { old: null, squares: manifest.squares, globals: manifest.globals, where, lists },
    };
  }

  /** The keys of a map stored in the format before the tiles. */
  private oldKeysOf(manifest: OldManifest): string[] {
    return [`${this.key}:head`, ...manifest.parts.flatMap((part) => [`${this.key}:part:${part}`, `${this.key}:wear:${part}`])];
  }

  /** A map saved before the tiles (manifest 3: the head in one text, the buildings in parts of ids): read as it was, written by tiles next. */
  private async readOld(manifest: OldManifest): Promise<TiledSession | null> {
    const blobs = await this.store.get([`${this.key}:head`, ...manifest.parts.map((part) => `${this.key}:part:${part}`)]);
    const [headBlob, ...partBlobs] = blobs;
    if (!headBlob || partBlobs.some((blob) => !blob)) return null;
    // Each part's wears, where kept (a map saved before them has none: its records carry their wear).
    const wearBlobs = await this.store.get(manifest.parts.map((part) => `${this.key}:wear:${part}`));
    const head: unknown = JSON.parse(await gunzip(headBlob));
    if (!isObject(head)) return null;
    const buildings: unknown[] = [];
    for (let i = 0; i < partBlobs.length; i++) {
      const records: unknown = JSON.parse(await gunzip(partBlobs[i]!));
      if (!Array.isArray(records)) return null;
      const wearBlob = wearBlobs[i];
      const wears = wearBlob ? readWears(await wearBlob.text()) : null;
      for (const record of records) buildings.push(wears ? withWear(record, wears) : record);
    }
    return {
      document: { ...(head as unknown as SerializedDoc), buildings } as SerializedDoc, settings: manifest.settings, savedAt: manifest.savedAt,
      layout: { old: this.oldKeysOf(manifest), squares: {}, globals: [], where: {}, lists: {} },
    };
  }

  /** Runs after the saves under way: never a removal in the middle of a write. */
  private queued(run: () => Promise<boolean>): Promise<boolean> {
    const done = this.queue.then(run);
    this.queue = done.catch((error: unknown) => { console.error('[save] the tiles of the map were not reached', error); return false; });
    return done;
  }

  /** The keys the saved map is held under, as regions and by tiles in JSON, each manifest after its blobs. */
  private async savedKeys(): Promise<string[]> {
    const [regionBlob, tilesBlob] = await this.store.get([this.manifestKey, this.tilesManifestKey]);
    const regions = regionBlob ? readValueFrame(await regionBlob.arrayBuffer(), MANIFEST_MAGIC) : null;
    const tiles: unknown = tilesBlob ? JSON.parse(await tilesBlob.text()) : null;
    return [
      ...(isTiledManifest(regions, 6) ? this.keysOf(regions, this.regionKeys) : []), this.manifestKey,
      ...(isTiledManifest(tiles) ? [...this.keysOf(tiles, this.tileKeys), this.tilesManifestKey] : []),
    ];
  }

  /** Nothing is known to be stored: the next save writes every square. */
  private forget(): void {
    this.doc = null;
    this.keyed = freshKeyed();
    this.lists = freshLists();
    this.globals = new Set(GLOBAL_PARTS);
    this.storedGlobals = new Set();
    this.oldKeys = [];
  }

  /** The map's tiles removed: the map is saved whole again (`Persistence.saveSession`). */
  clear(): Promise<boolean> {
    return this.queued(async () => {
      this.forget();
      return this.store.write([], await this.savedKeys());
    });
  }

  /** The map's tiles set aside under a key of their own, never deleted: it passed validation and the loader threw */
  setAside(at: number): Promise<boolean> {
    return this.queued(async () => {
      const keys = await this.savedKeys();
      const blobs = await this.store.get(keys);
      const aside = `${this.key}.unreadable.${at}`;
      const put = keys.flatMap((key, i) => {
        const blob = blobs[i];
        return blob ? [[`${aside}${key.slice(this.key.length)}`, blob] as const] : [];
      });
      if (put.length === 0) return false;
      this.forget();
      return this.store.write(put, keys);
    });
  }
}

/** Where a format keeps a map by squares. */
interface SquareKeys {
  blob(layer: LayerName, square: string): string;
  wear(square: string): string;
  global(part: GlobalPart): string;
}
/** How a format's blobs are read back. */
interface SquareCodec {
  square(blob: Blob): Promise<SquareBlob | null>;
  wears(blob: Blob): Promise<Map<number, number> | null>;
  global(blob: Blob): Promise<unknown>;
}

/** The tiles in JSON (manifest 5): gzip texts, the wears plain. */
const JSON_CODEC: SquareCodec = {
  async square(blob) {
    const value: unknown = JSON.parse(await gunzip(blob));
    return isSquareBlob(value) ? value : null;
  },
  async wears(blob) { return readWears(await blob.text()); },
  async global(blob) { return JSON.parse(await gunzip(blob)) as unknown; },
};

/** Wears read back, by id; null when they cannot be read (the records' own wear stands). */
function readWears(text: string): Map<number, number> | null {
  const pairs: unknown = JSON.parse(text);
  if (!Array.isArray(pairs) || pairs.length % 2 !== 0 || !pairs.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const out = new Map<number, number>();
  for (let i = 0; i < pairs.length; i += 2) out.set(pairs[i] as number, pairs[i + 1] as number);
  return out;
}

/** A stored record with the wear kept for it laid over (no `decay` when it has none, as a record never worn). */
function withWear(record: unknown, wears: ReadonlyMap<number, number>): unknown {
  if (typeof record !== 'object' || record === null) return record;
  const r = record as { id?: unknown; decay?: number };
  const decay = typeof r.id === 'number' ? wears.get(r.id) : undefined;
  if (decay === undefined || decay === (r.decay ?? 0)) return record;
  const { decay: _was, ...rest } = r;
  return decay === 0 ? rest : { ...rest, decay };
}
