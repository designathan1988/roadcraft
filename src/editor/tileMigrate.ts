import { type SerializedDoc, type TileRecords, WORLD_PARTS } from '@world/doc';
import { lotCentre } from '@world/lotRings';
import { rescaleSerializedDoc } from '@world/rescale';
import { METERS_PER_UNIT, m } from '@world/units';
import { OWNER, TILE_COUNTED, tileIdBase, tileKey } from '@world/tiles';
import { type PartStore, type SaveEntry, storeWriter } from './saveStore';
import { tileBlobKey } from './tileBlob';
import { type HeldLists, type WorldMeta, metaKey, metaPartKey } from './worldMeta';

/** A MAP SAVED BEFORE THE TILES MADE INTO TILES (`TileStore.migrate`): the newest copy found, distributed into its tiles and its values, written in one transaction */

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A tile's lists (every field but its key, version, counters, rows and gates). */
export type ListField = Exclude<keyof TileRecords, 'key' | 'version' | 'next' | 'grown' | 'gates'>;

/** Where the migrated map came from: the tiles' manifest (5), the parts' (3), the whole text in IndexedDB or in `localStorage`. */
type SaveSource = 'tiles' | 'parts' | 'large' | 'local';

/** What a migration did: nothing (a world already stored, or no map saved), the map distributed into its tiles, or a write refused. */
export interface MigrationReport {
  readonly outcome: 'present' | 'none' | 'migrated' | 'failed';
  readonly from: SaveSource | null;
  /** The tiles written. */
  readonly keys: readonly number[];
}

/** A map saved before the tiles, as found. */
interface Found {
  readonly document: SerializedDoc;
  readonly settings: unknown;
  readonly savedAt: number;
  readonly from: SaveSource;
}

const isDocShape = (value: unknown): value is SerializedDoc =>
  isObject(value) && value['version'] === 1 && Array.isArray(value['nodes']) && Array.isArray(value['segments']);

/** A whole-map text (`persistence.ts`): a session (version 2) or a bare document; `missingAt` when it says no time, as `loadSessionAsync` reads it. */
function wholeText(text: string, from: SaveSource, missingAt: number): Found | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { console.warn(`[migrate] the ${from} copy is not a map's text`, error); return null; }
  if (isDocShape(parsed)) return { document: parsed, settings: null, savedAt: missingAt, from };
  if (!isObject(parsed) || parsed['version'] !== 2) return null;
  const document = parsed['document'], savedAt = parsed['savedAt'];
  if (!isDocShape(document)) return null;
  return { document, settings: parsed['settings'] ?? null, savedAt: finite(savedAt) ? savedAt : missingAt, from };
}

/** The newest of the map's saved copies, as `Persistence.loadSessionAsync` chooses: the `localStorage` text, the parts (`chunkedSave.ts`), the IndexedDB text. */
async function newestSave(store: PartStore, map: string, local: string | null): Promise<Found | null> {
  const found: Found[] = [];
  const own = local !== null ? wholeText(local, 'local', -1) : null;
  if (own) found.push(own);
  // Loaded only to migrate: the parts' reader brings the document's module.
  const { TiledSaves } = await import('./chunkedSave');
  const parted = await new TiledSaves(store, map).read();
  if (parted && isDocShape(parted.document)) {
    found.push({ document: parted.document, settings: parted.settings, savedAt: parted.savedAt, from: parted.layout.old ? 'parts' : 'tiles' });
  }
  const [large] = await store.get([map]);
  const text = large ? wholeText(await large.text(), 'large', 0) : null;
  if (text) found.push(text);
  // A later copy wins only when strictly newer (the order above is `loadSessionAsync`'s).
  let best: Found | null = null;
  for (const f of found) if (!best || f.savedAt > best.savedAt) best = f;
  return best;
}

/** A map saved before the tiles, distributed into its tiles and its values and written in one transaction; its own keys are never written or removed */
export async function migrate(store: PartStore, map: string, local: string | null): Promise<MigrationReport> {
  const [held] = await store.get([metaKey(map)]);
  if (held) return { outcome: 'present', from: null, keys: [] };
  const found = await newestSave(store, map, local);
  if (!found) return { outcome: 'none', from: null, keys: [] };
  // In this build's unit: a record's tile is told by its place.
  const data = rescaleSerializedDoc(found.document);
  const { tiles, kept } = distribute(data);
  const put: SaveEntry[] = tiles.map((t) => ({ key: tileBlobKey(map, t.key), value: t, packed: true }));
  // The world's values last in the batch: their key says the world is stored.
  put.push({ key: metaKey(map), value: metaOf(data, kept, found), packed: false });
  // The parts a world written before left (`setMetaParts`) go with it: read over these values they would be another world's balance, zones and people.
  const ok = await (store.writer ?? storeWriter(store)).write({ put, remove: WORLD_PARTS.map((part) => metaPartKey(map, part)) });
  return ok ? { outcome: 'migrated', from: found.from, keys: tiles.map((t) => t.key) } : { outcome: 'failed', from: found.from, keys: [] };
}

function metaOf(data: SerializedDoc, held: HeldLists, found: Found): WorldMeta {
  const fog = data.fog?.settings, gullyAuto = data.gullies?.auto;
  return {
    version: 1, generator: null, unit: METERS_PER_UNIT,
    ...(data.relief !== undefined ? { relief: data.relief } : {}),
    ...(data.markingStyle !== undefined ? { markingStyle: data.markingStyle } : {}),
    ...(data.nature !== undefined ? { nature: data.nature } : {}),
    ...(data.weather !== undefined ? { weather: data.weather } : {}),
    ...(fog !== undefined ? { fog } : {}),
    ...(gullyAuto !== undefined ? { gullyAuto } : {}),
    ...(data.economy !== undefined ? { economy: data.economy } : {}),
    ...(data.transit !== undefined ? { transit: data.transit } : {}),
    ...(data.people !== undefined ? { people: data.people } : {}),
    held, settings: found.settings, savedAt: found.savedAt,
  };
}

interface Place { readonly x: number; readonly y: number }
function placeOf(value: unknown): Place | null {
  if (!isObject(value)) return null;
  const x = value['x'], y = value['y'];
  return finite(x) && finite(y) ? { x, y } : null;
}
function idOf(record: unknown): number {
  const id = isObject(record) ? record['id'] : undefined;
  return finite(id) ? id : Number.NaN;
}

/** Where a record with no place, or a place past the world's reach, is filed: the tile at the origin (as `chunkedSave.ts` files it). */
const NOWHERE = tileKey(0, 0);
function filed(file: () => number): number {
  try {
    const key = file();
    return Number.isInteger(key) ? key : NOWHERE;
  } catch (error) {
    console.warn('[migrate] a record past the reach of the world, filed at the origin', error);
    return NOWHERE;
  }
}
function tileAt(p: Place | null): number {
  if (!p) return NOWHERE;
  const at: Place = p;
  return filed(() => OWNER.at(at));
}
/** A road or a span: by its two ends (`OWNER.segment`), by the one end with a place, or nowhere. */
function tileBetween(a: unknown, b: unknown): number {
  const pa = placeOf(a), pb = placeOf(b);
  if (!pa || !pb) return tileAt(pa ?? pb);
  const from: Place = pa, to: Place = pb;
  return filed(() => OWNER.segment(from, to));
}

/** Where a land key says its land lies (`lots.ts` keys: `b:` a block's middle, `s:` a strip's, in steps of 4 m). */
function lotKeyPlace(key: string): Place | null {
  if (!key.startsWith('b:') && !key.startsWith('s:')) return null;
  const [x, y] = key.slice(2).split(',').map(Number);
  return finite(x) && finite(y) ? { x: x * m(4), y: y * m(4) } : null;
}

type Draft = { -readonly [K in ListField]: TileRecords[K][number][] } & { readonly key: number };

/** The next id of a kind in a tile's counted range: past every id of the tile's records in it (a pre-tile map's ids lie under `TILE_IDS`, outside every range). */
function counted(base: number, records: readonly unknown[]): number {
  let next = base;
  for (const record of records) {
    const id = idOf(record);
    if (id >= base && id < base + TILE_COUNTED && id >= next) next = id + 1;
  }
  return next;
}

/** DO NOT renumber a record: every record goes to the one tile `OWNER` names, ids as they are; a road's or a span's end of another tile goes with it as a borrowed copy */
function distribute(data: SerializedDoc): { readonly tiles: TileRecords[]; readonly kept: HeldLists } {
  const drafts = new Map<number, Draft>();
  const lentNodes = new Map<number, Set<number>>(), lentPoles = new Map<number, Set<number>>();
  const tile = (key: number): Draft => {
    let d = drafts.get(key);
    if (!d) {
      d = {
        key, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [], lotKeys: [],
        landscape: [], barriers: [], paint: [], trees: [], elements: [],
      };
      drafts.set(key, d);
    }
    return d;
  };
  const lend = (lent: Map<number, Set<number>>, key: number, id: number): boolean => {
    let ids = lent.get(key);
    if (!ids) lent.set(key, ids = new Set());
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  };

  const nodes = new Map<number, SerializedDoc['nodes'][number]>(), nodeTile = new Map<number, number>();
  for (const n of data.nodes) {
    const key = tileAt(placeOf(n));
    nodes.set(n.id, n);
    nodeTile.set(n.id, key);
    tile(key).nodes.push(n);
  }
  for (const s of data.segments) {
    const a = nodes.get(s.a), b = nodes.get(s.b);
    const key = tileBetween(a, b);
    const d = tile(key);
    d.segments.push(s);
    for (const end of [a, b]) if (end && nodeTile.get(end.id) !== key && lend(lentNodes, key, end.id)) d.borrowedNodes.push(end);
  }

  const poles = new Map<number, NonNullable<SerializedDoc['poles']>[number]>(), poleTile = new Map<number, number>();
  for (const p of data.poles ?? []) {
    const key = tileAt(placeOf(p));
    poles.set(p.id, p);
    poleTile.set(p.id, key);
    tile(key).poles.push(p);
  }
  for (const s of data.poleSpans ?? []) {
    const a = poles.get(s.a), b = poles.get(s.b);
    const key = tileBetween(a, b);
    const d = tile(key);
    d.poleSpans.push(s);
    for (const end of [a, b]) if (end && poleTile.get(end.id) !== key && lend(lentPoles, key, end.id)) d.borrowedPoles.push(end);
  }

  for (const b of data.buildings ?? []) tile(tileAt(placeOf(b))).buildings.push(b);
  // In the store's order (the first lot holds a point): each tile keeps the map's order of its own.
  for (const lot of data.lots ?? []) tile(tileAt(lot.corners.length ? placeOf(lotCentre(lot)) : null)).lots.push(lot);
  const homeless: string[] = [];
  for (const key of data.lotKeys ?? []) {
    const p = lotKeyPlace(key);
    if (p) tile(tileAt(p)).lotKeys.push(key);
    else homeless.push(key);
  }
  for (const item of data.landscape ?? []) tile(tileAt(placeOf(item))).landscape.push(item);
  for (const barrier of data.barriers ?? []) tile(tileAt(placeOf(barrier.points[0]))).barriers.push(barrier);
  for (const dab of data.paint ?? []) tile(tileAt(placeOf(dab))).paint.push(dab);
  for (const tree of data.trees ?? []) tile(tileAt(placeOf(tree))).trees.push(tree);
  for (const element of data.elements ?? []) tile(tileAt(placeOf(element))).elements.push(element);

  const tiles: TileRecords[] = [];
  for (const d of [...drafts.values()].sort((a, b) => a.key - b.key)) {
    const base = tileIdBase(d.key);
    tiles.push({
      ...d,
      version: 1,
      next: {
        node: counted(base, d.nodes), segment: counted(base, d.segments), pole: counted(base, d.poles), span: counted(base, d.poleSpans),
        building: counted(base, d.buildings), lot: counted(base, d.lots), landscape: counted(base, d.landscape), barrier: counted(base, d.barriers),
      },
    });
  }
  const kept: HeldLists = {
    terrain: data.terrain ?? [], fog: data.fog?.dabs ?? [], gullies: data.gullies?.dabs ?? [], clouds: data.clouds ?? [],
    treeClearings: data.treeClearings ?? [], zones: data.zones ?? [], zoneMarks: data.zoneMarks ?? [], lotKeys: homeless,
  };
  return { tiles, kept };
}
