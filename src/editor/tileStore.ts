import { type SerializedDoc, type WorldPart, WORLD_PARTS } from '@world/doc';
import { type WorldMeta, metaKey, metaPartKey, readMeta } from './worldMeta';
export type { HeldLists } from './worldMeta';

export type { WorldMeta } from './worldMeta';
import { tileOfKey } from '@world/tiles';
import { type PreparedGrown, type TileRecords, preparedTiles } from '@world/doc';
import type { NetworkBake } from '@world/network';
import { tileNetworkBake } from '@world/tileNetwork';
import { internMembers } from '@world/buildings/intern';
import { encodeRecords, readRecords, refOf, tableRecords } from '@world/buildings/recordTable';
import { migrateBuilding } from '@world/buildings/serialize';
import type { Building } from '@world/buildings/types';
import { tileBuildingsOf, withGrownBuildings } from '@world/growth/grownRows';
import type { GrownRows } from '@world/growth/rows';
import { gatesOf } from '@world/buildingGates';
import { type PartStore, storeWriter } from './saveStore';
import { type HeadRead, type TilePartIn, gunzipBytes, gzipBytes, partOf, readHead, readTileMark, tileBlob, tileBlobKey, tileMark, tileMarkKey, tileMarkPrefix } from './tileBlob';
import { type ListField, type MigrationReport, finite, isObject, migrate } from './tileMigrate';

/** THE TILE STORE: the save of a world of tiles (CLAUDE.md, "Streaming world"), each tile read and written alone, off the page */

/** DO NOT read or write the map whole: a tile is one blob and its write one transaction; the page hands the save worker the call, nothing else */



/** A call of the tile store, as the page hands it to the save worker (`save.worker.ts` `serve`). */
export type TileOp =
  /** The stored tile prepared for the page (`prepareTile`): with `network`, its junctions and ribbons solved here too (a tile of the region). */
  | { readonly op: 'read'; readonly map: string; readonly key: number; readonly network?: boolean; readonly readOnly?: boolean }
  /** The stored tile's records as texts (`TileText`), or null: what the page parses once, the bytes handed over, never cloned. */
  | { readonly op: 'readText'; readonly map: string; readonly key: number; readonly readOnly?: boolean }
  /** The stored tile's version alone, or null: what the tiles made ahead are known by, their records never handed to the page. */
  /** `readOnly` (a tab that only reads the world, `TileStore.readOnly`): a tile stored in an older form is read as it is, never written again in parts. */
  | { readonly op: 'version'; readonly map: string; readonly key: number; readonly readOnly?: boolean }
  /** The tile written, its buildings as rows of tables (`tileWrite`): read back where it is stored (`writtenRecords`). */
  /** `unbaked`: stored with no sections, at once (the maker bakes them after, `bakeStoredTile`). */
  | { readonly op: 'write'; readonly map: string; readonly records: TileWrite; readonly unbaked?: boolean;
    /** Parts the page did not change since the store's `base` version: taken from the stored blob as they are when it is still at `base` (D4). */
    readonly same?: { readonly base: number; readonly parts: readonly RecordPart[] } }
  | { readonly op: 'meta'; readonly map: string }
  | { readonly op: 'setMeta'; readonly map: string; readonly meta: WorldMeta }
  /** Some of the world's parts (`RoadDoc.worldPart`), each under a key of its own: read back over the world's values (`readMeta`). */
  | { readonly op: 'setMetaParts'; readonly map: string; readonly parts: Readonly<Partial<Record<WorldPart, Partial<SerializedDoc>>>> }
  | { readonly op: 'migrate'; readonly map: string; readonly local: string | null }
  /** Every tile the store holds, by its mark (`PartStore.marks`): key, version, baked, three numbers a tile; null where the store keeps no marks. */
  | { readonly op: 'marks'; readonly map: string }
  /** Stored tiles taken away (a world file opened lacks them): made again when asked. */
  | { readonly op: 'removeTiles'; readonly map: string; readonly keys: readonly number[] }
  /** A stored tile's lists emptied (a "whole map" clear, `TileStore.clearLists`), its version past `after`: the version it stands at and whether it was written, null when none is stored or the write failed. */
  | { readonly op: 'clearLists'; readonly map: string; readonly key: number; readonly parts: readonly ClearablePart[]; readonly after: number; readonly unbaked?: boolean };

/** The lists of a tile a "whole map" clear empties in every stored tile (`main.ts` MAP_ACTIONS). */
export type ClearablePart = 'trees' | 'elements';

/** Who runs the tile store's calls: the save worker (`portTiles`), or the thread that asks (`storeTiles`). */
interface TileBackend { run(op: TileOp): Promise<unknown> }


type NextKind = keyof TileRecords['next'];
/** Every list of a tile and every kind it counts ids for (a `Record`: a field added to `TileRecords` and not here does not compile). */
const LIST_FIELDS = Object.keys({
  nodes: 0, borrowedNodes: 0, segments: 0, poles: 0, borrowedPoles: 0, poleSpans: 0, buildings: 0, lots: 0, lotKeys: 0,
  landscape: 0, barriers: 0, paint: 0, trees: 0, elements: 0,
} satisfies Record<ListField, 0>) as ListField[];
const NEXT_KINDS = Object.keys({
  node: 0, segment: 0, pole: 0, span: 0, building: 0, lot: 0, landscape: 0, barrier: 0,
} satisfies Record<NextKind, 0>) as NextKind[];


/** Whether a value is a tile's records as the store keeps them: its key and version, every list, every counter. */
export function isTileRecords(value: unknown): value is TileRecords {
  if (!isObject(value) || !Number.isInteger(value['key']) || !finite(value['version'])) return false;
  const next = value['next'];
  return LIST_FIELDS.every((field) => Array.isArray(value[field])) && isObject(next) && NEXT_KINDS.every((kind) => finite(next[kind]));
}

/** THE PARTS A TILE IS STORED IN (format 2, `tileBlob.ts`): its records in three - the far roads read the roads alone, the far buildings the buildings, the region's load all three - then the sections baked from them where the tile is written (`TileBaker`) */
type RecordPart = 'rest' | 'roads' | 'buildings';
const RECORD_PARTS: readonly RecordPart[] = ['rest', 'roads', 'buildings'];
/** The parts of the records the far bakes read alone. */
export type TilePartName = 'roads' | 'buildings';

function splitRecords(records: TileRecords): Record<RecordPart, object> {
  const { nodes, borrowedNodes, segments, gates, buildings, grown, lots, ...rest } = records;
  // The grown rows with the lots they are made again on (`world/growth/grownRows.ts`): the part the far bakes read alone holds both.
  // The buildings' gates with the roads: a bake of the roads reads them without the buildings (`render/nearRoadTiles.ts`).
  return { rest, roads: { nodes, borrowedNodes, segments, ...(gates ? { gates } : {}) }, buildings: { buildings, lots, ...(grown ? { grown } : {}) } };
}

/** A tile's records as UTF-8 JSON texts, each an object of some of its fields (format 1: one, the whole): merged, the tile. */
export type TileText = readonly Uint8Array<ArrayBuffer>[];

/** The records' texts merged and checked: the tile, or a throw (DO NOT generate over the player's tile). */
function parseTileText(text: TileText, key: number): TileRecords {
  const decoder = new TextDecoder();
  const value: Record<string, unknown> = {};
  try {
    for (const part of text) Object.assign(value, JSON.parse(decoder.decode(part)) as object);
  } catch {
    throw new Error(`tile ${key} is stored and cannot be read`);
  }
  if (!isTileRecords(value) || value.key !== key) throw new Error(`tile ${key} is stored and cannot be read`);
  return value;
}

/** A tile's derived product kept with it: a JSON value, or a typed-array pack (`core/arrayPack.ts`). */
export type TileSection = { readonly json: unknown } | { readonly bin: Uint8Array<ArrayBuffer> };
/** What bakes a tile's sections where it is written (`sim/tileSections.ts`, handed in by the thread that writes: the generator's worker, the save worker). */
export type TileBaker = (records: TileRecords) => Readonly<Record<string, TileSection>>;

/** A tile's blob, and its records' texts (handed to whoever asked for the tile): the records made text once, for both. */
/** DO NOT keep the records' texts past their gzip: no caller reads them, and they lived through the sections' bake (5-15 MB a part, the generator's memory, 2026-10-17 - as the simulacao's 3f34d8e9). */
async function encodeTile(records: TileRecords, bake: TileBaker | undefined, full?: TileRecords, reused?: ReadonlyMap<string, Blob>): Promise<{ readonly blob: Blob; readonly baked: boolean }> {
  const encoder = new TextEncoder();
  const split = splitRecords(records);
  const parts: TilePartIn[] = [];
  // Each part made text, compressed and let go, one at a time; one taken as stored is neither (D4).
  for (const name of RECORD_PARTS) parts.push({ name, kind: 'json', data: reused?.get(name) ?? await gzipBytes(encoder.encode(JSON.stringify(split[name])) as Uint8Array<ArrayBuffer>) });
  let sections: Readonly<Record<string, TileSection>> = {};
  try {
    // From every building: the grown rows made again where the caller has not the records whole (`full`).
    if (bake) sections = bake(full ?? withGrownBuildings(records));
  } catch (error) {
    // Stored without them: each reader derives its own from the records (`readTilePart`).
    console.error(`[save] tile ${records.key}'s sections could not be baked`, error);
  }
  for (const [name, section] of Object.entries(sections)) parts.push(await sectionPart(name, section));
  return { blob: tileBlob(records.key, records.version, bake !== undefined, parts), baked: bake !== undefined };
}

/** A tile's blob written with its mark in one transaction: DO NOT write one without the other (the world's tiles are known by their marks, `TileStore.manifest`). */
function putTile(store: PartStore, map: string, key: number, version: number, baked: boolean, blob: Blob): Promise<boolean> {
  return store.write([[tileBlobKey(map, key), blob]], [], [[tileMarkKey(map, key), tileMark(version, baked)]]);
}

/** A stored tile's mark written alone, where it has none (stored before marks were, or by a migration): the next opening knows it with the others. Run on the tile's chain, as its writes, and waited for: DO NOT let a later write of the tile commit before it (the mark would tell an older version). */
async function markStored(store: PartStore, map: string, key: number, version: number): Promise<void> {
  if (!store.marks) return;
  if (!(await store.write([], [], [[tileMarkKey(map, key), tileMark(version, true)]]))) console.warn(`[save] tile ${key}'s mark was not written`);
}

/** A section as a part of the tile's blob: a binary pack as it is, a JSON value gzipped. */
async function sectionPart(name: string, section: TileSection): Promise<TilePartIn> {
  if ('bin' in section) return { name, kind: 'bin', data: new Blob([section.bin]) };
  return { name, kind: 'json', data: await gzipBytes(new TextEncoder().encode(JSON.stringify(section.json)) as Uint8Array<ArrayBuffer>) };
}

/** A tile the page wrote with no sections (`TileStore.write`) baked and written again with them at the same version, where the maker runs (`cityTile.worker.ts`); false, nothing written, when the store holds it otherwise (another version, or baked already).
 *  Run on the tile's chain (`TileStore`): no write of it comes between the read and the write. */
export async function bakeStoredTile(store: PartStore, map: string, key: number, version: number, bake: TileBaker): Promise<boolean> {
  const stored = await storedBlob(store, map, key);
  if (!stored?.read || stored.read.head.baked || stored.read.head.version !== version) return false;
  const { blob } = await encodeTile(parseTileText(await textOf(stored, map, key), key), bake);
  return putTile(store, map, key, version, true, blob);
}

/** DO NOT write a tile's records again to add one section to it: its blob's parts kept as they are, the section put in (or in place of the one of that name). False, and nothing written, when the store holds no tile in parts at `version`.
 *  Run where no other write of the tile can come between the read and the write (the tile's chain, `TileStore`: the maker answering `load`). */
export async function addTileSection(store: PartStore, map: string, key: number, version: number, name: string, section: TileSection): Promise<boolean> {
  const stored = await storedBlob(store, map, key);
  const read = stored?.read;
  if (!stored || !read || !read.head.baked || read.head.version !== version) return false;
  const parts: TilePartIn[] = [];
  for (const [part] of read.head.parts) {
    if (part === name) continue;
    const got = partOf(stored.blob, read, part);
    if (got) parts.push({ name: part, kind: got.kind, data: got.data });
  }
  parts.push(await sectionPart(name, section));
  return putTile(store, map, key, version, true, tileBlob(key, version, true, parts));
}

/** DO NOT post a tile's buildings as objects to be written (each copied by a JSON round trip, then cloned by the message, every few seconds a changed tile): each is a row of a table in shared memory */
/** A tile's buildings as a write posts them: each a row of one of `tables` (its tile's, `tableRecords`, or one of its own, `refOf`), in the tile's order; each table listed once, a SharedArrayBuffer posted as a handle (MDN "SharedArrayBuffer"). */
interface BuildingRows {
  readonly tables: readonly ArrayBufferLike[];
  /** Each building's table: its index in `tables`. */
  readonly table: Uint32Array;
  /** Each building's row in its table. */
  readonly row: Uint32Array;
}

/** A tile as a write hands it to the store: its records, its buildings as rows (`BuildingRows`), never as objects. */
type TileWrite = Omit<TileRecords, 'buildings'> & { readonly buildings: BuildingRows };

/** A tile's records as a write posts them: each building's row (`refOf`: its tile's, or a table of its own made once per record and kept with it). */
export function tileWrite(records: TileRecords): TileWrite {
  const buildings = records.buildings as readonly Building[];
  const n = buildings.length;
  const table = new Uint32Array(n), row = new Uint32Array(n);
  const tables: ArrayBufferLike[] = [], index = new Map<ArrayBufferLike, number>();
  for (let k = 0; k < n; k++) {
    const ref = refOf(buildings[k]!);
    let t = index.get(ref.buffer);
    if (t === undefined) { index.set(ref.buffer, t = tables.length); tables.push(ref.buffer); }
    table[k] = t;
    row[k] = ref.row;
  }
  // The gates of the buildings as they stand now, read from the records here (`entrancesOf` keeps each record's); a tile with no building has none to keep. Those of a tile written with grown rows come with it (`RoadDoc.tileRecords`: every building's, the rows' too).
  const gates = records.gates ?? (n ? gatesOf(buildings) : undefined);
  return { ...records, ...(gates ? { gates } : {}), buildings: { tables, table, row } };
}

/** A write's records as the store keeps them: each building read from its row (`readRecords`, one reader a table), where the tile is written (the save worker; the page itself on the desktop, `storeTiles`). */
export function writtenRecords(write: TileWrite): TileRecords {
  const { tables, table, row } = write.buildings;
  return { ...write, buildings: readRecords(Array.from(row, (r, k) => ({ buffer: tables[table[k]!]!, row: r }))) };
}

/** A tile written in one transaction of its one key, its sections baked with it: whether it was stored, and its records' texts. */
export async function writeTile(store: PartStore, map: string, records: TileRecords, bake?: TileBaker, full?: TileRecords,
  /** Record parts taken as they are stored (`storedParts`). */
  reused?: ReadonlyMap<string, Blob>): Promise<{ readonly ok: boolean }> {
  const { blob, baked } = await encodeTile(records, bake, full, reused);
  return { ok: await putTile(store, map, records.key, records.version, baked, blob) };
}

/** The parts `same` names as the store holds them, when its tile is still at `same.base` in parts (null: written whole). */
async function storedParts(store: PartStore, map: string, key: number, same: { readonly base: number; readonly parts: readonly RecordPart[] }): Promise<Map<string, Blob> | null> {
  const stored = await storedBlob(store, map, key);
  if (!stored?.read || stored.read.head.version !== same.base) return null;
  const out = new Map<string, Blob>();
  for (const name of same.parts) {
    const part = partOf(stored.blob, stored.read, name);
    if (part?.kind !== 'json') return null;
    out.set(name, part.data);
  }
  return out;
}

/** A stored tile's blob and its head (null: format 1). */
interface Stored { readonly blob: Blob; readonly read: HeadRead | null }

async function storedBlob(store: PartStore, map: string, key: number): Promise<Stored | null> {
  const [blob] = await store.get([tileBlobKey(map, key)]);
  if (!blob) return null;
  // No magic: format 1's or garbage, its gunzip says which (`textOf`); a head with the magic and unreadable throws.
  return { blob, read: await readHead(blob) };
}

/** A stored blob's records as texts: its three parts, or the one gzip of format 1. */
async function textOf(stored: Stored, map: string, key: number): Promise<TileText> {
  try {
    if (!stored.read) return [await gunzipBytes(stored.blob)];
    const out: Uint8Array<ArrayBuffer>[] = [];
    for (const name of RECORD_PARTS) {
      const part = partOf(stored.blob, stored.read, name);
      if (!part) throw new Error(`no ${name}`);
      out.push(await gunzipBytes(part.data));
    }
    return out;
  } catch {
    throw new Error(`tile ${key} of ${map} is stored and cannot be read`);
  }
}

/** A stored tile, or null when the store has none; a tile stored and unreadable throws (DO NOT generate over the player's tile). */
export async function readTile(store: PartStore, map: string, key: number): Promise<TileRecords | null> {
  const stored = await storedBlob(store, map, key);
  return stored ? parseTileText(await textOf(stored, map, key), key) : null;
}

/** One part of a stored tile as its reader takes it: a JSON part's value, a binary part's bytes, or the whole records where the tile has no such part (format 1, or written with no baker: the reader derives it); null: no tile stored. */
export type StoredPart = { readonly value: unknown } | { readonly bytes: ArrayBuffer } | { readonly records: TileRecords } | null;

/** DO NOT parse a whole tile for one product of it: the part alone is read (the far bakes, the simulation's meso and traffic) */
export async function readTilePart(store: PartStore, map: string, key: number, name: string): Promise<StoredPart> {
  const stored = await storedBlob(store, map, key);
  if (!stored) return null;
  const part = stored.read ? partOf(stored.blob, stored.read, name) : null;
  if (!part) return { records: parseTileText(await textOf(stored, map, key), key) };
  return partValue(part);
}

/** WHAT THE STORE HOLDS OF A TILE, AS ITS MAKER ASKS BEFORE MAKING IT (`cityTile.worker.ts`): the version of a tile stored in parts with its sections, `'legacy'` for one stored otherwise (format 1, or written with no baker: the save worker writes it again in parts, `upgraded`), null for none */
export async function storedVersion(store: PartStore, map: string, key: number): Promise<number | 'legacy' | null> {
  const stored = await storedBlob(store, map, key);
  if (!stored) return null;
  return stored.read?.head.baked ? stored.read.head.version : 'legacy';
}

/** `storedVersion` where the maker looks (`cityTile.worker.ts`), a tile stored in parts with no sections baked here first (a page's write whose bake a reload cut short, `TileStore.write`): DO NOT leave it to the save's worker, its reads and writes wait behind a bake; `'legacy'` is format 1 alone. Run on the tile's chain. */
/** `mark`: asked for its version alone, so not known by a mark (`TileStore.manifest`): marked here. */
export async function storedVersionBaked(store: PartStore, map: string, key: number, bake: TileBaker, mark = false): Promise<number | 'legacy' | null> {
  const stored = await storedBlob(store, map, key);
  if (!stored) return null;
  if (!stored.read) return 'legacy';
  const { version, baked } = stored.read.head;
  if (!baked && !(await bakeStoredTile(store, map, key, version, bake))) console.warn(`[city tile] tile ${key}'s sections were not baked: its readers derive them`);
  // A tile baked here is marked by its bake's write.
  if (mark && baked) await markStored(store, map, key, version);
  return version;
}

/** A section a reader does not derive from the records where the tile has none (the simulation's bays, `sim/tileBays.ts`): that part alone, the records never parsed; null: no tile stored, or stored without it. */
export async function readTileSection(store: PartStore, map: string, key: number, name: string): Promise<{ readonly value: unknown } | { readonly bytes: ArrayBuffer } | null> {
  const stored = await storedBlob(store, map, key);
  const part = stored?.read ? partOf(stored.blob, stored.read, name) : null;
  return part ? partValue(part) : null;
}

/** A part as its reader takes it: a binary part's bytes, a JSON part's value. */
async function partValue(part: NonNullable<ReturnType<typeof partOf>>): Promise<{ readonly value: unknown } | { readonly bytes: ArrayBuffer }> {
  if (part.kind === 'bin') return { bytes: await part.data.arrayBuffer() };
  return { value: JSON.parse(new TextDecoder().decode(await gunzipBytes(part.data))) as unknown };
}

/** A tile of format 1, or written with no baker, written again in parts with its sections at its own version, once: the next reads take their part alone (run on the page's chain of the tile, `TileStore`: no write of it runs between). */
async function upgraded(store: PartStore, map: string, key: number, stored: Stored, bake: TileBaker | undefined): Promise<TileText> {
  const text = await textOf(stored, map, key);
  // A tile in parts with no sections is the maker's to bake (`storedVersionBaked`): DO NOT bake it on the save's worker, which the reads share.
  if (bake && !stored.read) {
    const parsed = parseTileText(text, key);
    const { blob } = await encodeTile(parsed, bake);
    if (!(await putTile(store, map, key, parsed.version, true, blob))) console.warn(`[save] tile ${key} of ${map} was not written again in parts`);
  }
  return text;
}

/** Runs one call of the tile store against `store`: in the save worker on IndexedDB, or in the thread that asks (tests); `bake`, the sections baked with a tile written (none: stored without them). */
export async function runTileOp(store: PartStore, op: TileOp, bake?: TileBaker): Promise<unknown> {
  const writer = store.writer ?? storeWriter(store);
  switch (op.op) {
    case 'read': {
      const records = await readTile(store, op.map, op.key);
      return records ? prepareTile(records, op.network ?? false) : null;
    }
    case 'readText': {
      const stored = await storedBlob(store, op.map, op.key);
      return stored ? upgraded(store, op.map, op.key, stored, op.readOnly ? undefined : bake) : null;
    }
    case 'version': {
      // The head alone: DO NOT parse a tile to know it is there (format 1 parsed once, and written again in parts).
      const stored = await storedBlob(store, op.map, op.key);
      if (!stored) return null;
      if (stored.read) {
        if (!op.readOnly && stored.read.head.baked) await markStored(store, op.map, op.key, stored.read.head.version);
        return stored.read.head.version;
      }
      return parseTileText(await upgraded(store, op.map, op.key, stored, op.readOnly ? undefined : bake), op.key).version;
    }
    case 'write': {
      // DO NOT encode again a part the page did not touch (the buildings: their rows decoded, their JSON, their gzip, each write): the stored one taken, when the store is still at the version it came from. With sections to bake, written whole (the bake reads every building).
      const reused = op.same && op.unbaked ? await storedParts(store, op.map, op.records.key, op.same) : null;
      const records = reused?.has('buildings') ? { ...op.records, buildings: [] } as unknown as TileRecords : writtenRecords(op.records);
      return (await writeTile(store, op.map, records, op.unbaked ? undefined : bake, undefined, reused ?? undefined)).ok;
    }
    case 'meta': return readMeta(store, op.map);
    case 'setMeta': return writer.write({ put: [{ key: metaKey(op.map), value: op.meta, packed: false }], remove: WORLD_PARTS.map((part) => metaPartKey(op.map, part)) }); // the parts written apart before it go (`readMeta`)
    case 'setMetaParts': return writer.write({
      put: (Object.entries(op.parts) as [WorldPart, Partial<SerializedDoc>][]).map(([part, value]) => ({ key: metaPartKey(op.map, part), value, packed: false })), remove: [] });
    case 'migrate': return migrate(store, op.map, op.local);
    case 'removeTiles': return writer.write({ put: [], remove: op.keys.flatMap((key) => [tileBlobKey(op.map, key), tileMarkKey(op.map, key)]) });
    case 'marks': {
      if (!store.marks) return null;
      const prefix = tileMarkPrefix(op.map);
      const out: number[] = [];
      for (const [key, value] of await store.marks(prefix)) {
        const mark = readTileMark(prefix, key, value);
        if (mark) out.push(mark.key, mark.version, mark.baked ? 1 : 0);
      }
      return out;
    }
    case 'clearLists': {
      // Read, emptied and written where the store is: DO NOT bring the tile's buildings to the page for it.
      const records = await readTile(store, op.map, op.key);
      if (!records) return null;
      if (!op.parts.some((part) => records[part].length > 0)) return { version: records.version, cleared: false };
      const version = Math.max(records.version, op.after) + 1;
      const cleared: TileRecords = { ...records, version, ...Object.fromEntries(op.parts.map((part) => [part, []])) };
      // Its sections baked by the maker after (`TileStore.clearLists`), never on the save's worker.
      return (await writeTile(store, op.map, cleared, op.unbaked ? undefined : bake)).ok ? { version, cleared: true } : null;
    }
  }
}

/** The calls run where they are asked (the tests; a store whose own writer is off the page). */
export const storeTiles = (store: PartStore, bake?: TileBaker): TileBackend => ({ run: (op) => runTileOp(store, op, bake) });

/** What an answer of `runTileOp` hands over rather than copies: a tile's texts' buffers (MDN, `postMessage` transfer). */
export function tileOpTransfer(op: TileOp, value: unknown): ArrayBuffer[] {
  return op.op === 'readText' && Array.isArray(value) ? (value as TileText).map((t) => t.buffer) : [];
}

/** Whether a call only writes what the page hands it (records with no sections, the world's values, keys taken away): run on the save's worker, which does nothing else. */
export const writesOnly = (op: TileOp): boolean =>
  (op.op === 'write' && op.unbaked === true) || op.op === 'setMeta' || op.op === 'setMetaParts' || op.op === 'removeTiles' || op.op === 'migrate';

/** The calls run in the job system's lanes: the page posts the call and is handed the answer. DO NOT read or bake on the save's worker (`port`): a tile prepared with its network, or its sections baked, held that worker's event loop for seconds, and every write's commit and the world's values' with it - a reload meanwhile lost the edit and the balance (conf28). The writes alone go there; every other call goes to `readPort`'s lanes, `readLanes` of them (the region's nine tiles read at the opening, not one after the other). */
export function portTiles(port: () => Worker, readLanes = 1, readPort: () => Worker = port): TileBackend {
  const workers: Worker[] = [];
  let next = 1;
  let reads = 0;
  const waiting = new Map<number, { readonly done: (value: unknown) => void; readonly fail: (error: Error) => void }>();
  const failAll = (): void => { for (const w of waiting.values()) w.fail(new Error('the save worker stopped')); waiting.clear(); };
  const lane = (k: number): Worker => {
    while (workers.length <= k) {
      // Lane 0 the save's; the rest the reads'.
      const worker = workers.length === 0 ? port() : readPort();
      worker.onmessage = (event: MessageEvent<{ readonly id: number; readonly ok: boolean; readonly value?: unknown }>) => {
        const w = waiting.get(event.data.id);
        waiting.delete(event.data.id);
        if (event.data.ok) w?.done(event.data.value ?? null);
        else w?.fail(new Error('the save worker could not run a call of the tile store'));
      };
      worker.onerror = failAll;
      worker.onmessageerror = failAll;
      workers.push(worker);
    }
    return workers[k]!;
  };
  return {
    run(op) {
      const worker = lane(writesOnly(op) ? 0 : 1 + (reads++ % Math.max(1, readLanes)));
      const id = next++;
      return new Promise<unknown>((done, fail) => {
        waiting.set(id, { done, fail });
        try { worker.postMessage({ id, tiles: op }); } catch (error) { waiting.delete(id); fail(error instanceof Error ? error : new Error(String(error))); }
      });
    },
  };
}

/** A tile made and stored by the generator's own worker: the version stored (null: not stored), and the tile prepared when it was asked for. */
export interface MadeTile {
  readonly version: number | null;
  /** The tile prepared (`prepareTile`), when the page asked for it (a tile of the region). */
  readonly prepared?: PreparedTile;
  /** Asked only if missing (`makeStored`'s `ifMissing`): the store had it and it was not made again; `legacy`, stored in an older form the save worker must read (`storedVersion`). */
  readonly existed?: boolean;
  readonly legacy?: boolean;
}

/** A tile as the page takes it in: its records with no buildings, its buildings as one shared table (`recordTable.ts`: posted as a handle, the page reads its records from it and its jobs read its rows), and its network's bake (null when not asked for: a far tile's read). */
export interface PreparedTile {
  readonly records: TileRecords;
  readonly buildings: ArrayBufferLike;
  readonly network: NetworkBake | null;
  /** The rows its grown buildings were made from (`TileRecords.grown`): kept for the page, which writes back as rows those no edit touched (`RoadDoc.tileRecords`). */
  readonly grown?: GrownRows;
}

/** A TILE MADE READY FOR THE PAGE where it is read or made (the save worker, the generator's): each building migrated and its members interned (`intern.ts`: a tile's records share their shapes, kept through the message's clone), so the page only files them (`BuildingStore.loadPrepared`); with `network`, the tile's junctions and ribbons solved here from its roads (`bakeTileNetwork`), so the page's build takes them instead of solving a thousand junctions in the frame the tile is put in. */
/** `grown`: the rows its grown buildings came from when `records` holds them whole (a tile just generated, `cityTile.worker.ts`): kept beside them, never made again. */
export function prepareTile(records: TileRecords, network = true, grown?: TileRecords['grown']): PreparedTile {
  const buildings: Building[] = [];
  for (const raw of tileBuildingsOf(records)) {
    const b = migrateBuilding(raw);
    if (!b) continue;
    internMembers(b as unknown as Record<string, unknown>);
    buildings.push(b);
  }
  // DO NOT post the buildings as objects (cloned by every message, hash-consed again by every thread): one table, its shared members written once.
  const { grown: own, ...rest } = records;
  const rows = grown ?? own;
  return { records: { ...rest, buildings: [] }, buildings: encodeRecords(buildings).buffer, network: network ? bakeTileNetwork(records) : null,
    ...(rows?.id.length ? { grown: rows } : {}) };
}

/** A prepared tile's records as the page files them: its buildings read from its table, each knowing its row (`tableRecords`). */
export function preparedRecords(prepared: PreparedTile): TileRecords {
  const buildings = tableRecords(prepared.buildings);
  const records = { ...prepared.records, buildings: buildings as unknown as TileRecords['buildings'] };
  // The buildings made from rows, as they were made: the page writes them back as their rows while no edit replaces them (`PreparedGrown`).
  let grown: PreparedGrown | null = null;
  if (prepared.grown) {
    const ids = new Set(prepared.grown.id), made = new WeakSet<object>();
    for (const b of buildings) if (ids.has(b.id)) made.add(b);
    grown = { rows: prepared.grown, made };
  }
  preparedTiles.set(records, grown);
  return records;
}

/** The tile's roads built as a network of their own (the tile's nodes, its roads' foreign ends as borrowed nodes), its junctions and ribbons exported (`Network.exportBake`): the page takes a node's where its roads are the same there (a node with a neighbour's road is solved on the page). */
export function bakeTileNetwork(records: TileRecords): NetworkBake {
  // Built once for the tile's bakes (`world/tileNetwork.ts`): its parking bays read the same network.
  return tileNetworkBake(records);
}

/** THE WORLD'S TILES AS THE PAGE ASKS FOR THEM: one tile read, written, or made and stored; a write bumps the tile's version */
export class TileStore {
  /** The version each tile was last read or written at: one number a tile touched, never its records. */
  private readonly versions = new Map<number, number>();
  /** The network bakes of the tiles read for the page (`load`), by key, until taken (`takeBake`). */
  private readonly bakes = new Map<number, NetworkBake>();
  /** The calls under way on each tile (and on the world's values): a tile's calls run one after another, other tiles' alongside. */
  private readonly chains = new Map<number | 'world', Promise<unknown>>();
  /** Writes of each tile posted and not begun: a bake or the bays of the tile whose turn comes before them gives up (`writeWaits`). */
  private readonly writesWaiting = new Map<number, number>();
  /** A migration under way: every call waits for it. */
  private gate: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly map: string,
    private readonly backend: TileBackend,
    /** Builds a tile the store does not have (the whole-map generator's worker): a pure function of the seed and its place. */
    private readonly generate: (i: number, j: number) => Promise<TileRecords>,
    /** Builds a tile and stores it in the generator's own worker (`cityTile.worker.ts`, the browser's IndexedDB) at a version past `after`, its records handed back prepared with `records`; with `ifMissing`, only when the store has none (else the stored one's version, or its records prepared); none where the store is not the worker's to write (the desktop's). */
    private readonly makeStored?: (i: number, j: number, after: number, records: boolean, ifMissing: boolean, baysOnly?: boolean, sectionsOnly?: boolean) => Promise<MadeTile>,
    /** A tile's bake and bays asked of the maker and not begun, dropped (`TileGenerator.dropQueued`): a write of it does not wait for them on its chain. */
    private readonly dropQueued?: (key: number) => void,
  ) {}

  /** Another tab holds this world (`main.ts` holdWorld): this one reads it and writes nothing to the store (no tile made is stored, no old tile written again in parts), its tiles made here only to be drawn. */
  readOnly = false;

  /** The tile in the store, made and stored when it is not, and its version: DO NOT hand its records to the page for a tile it only needs to know is there (the tiles made ahead, `worldStreamer.ts`). */
  /** DO NOT ask the save worker first where the maker can look itself: its lanes stand on the queue's busy workers, and the tile makers waited on them for every tile of the map (2026-10-16, the opening's 148 s rush). */
  ensure(key: number): Promise<number> {
    return this.chained(key, async () => {
      // The maker stores what it makes: not for a tab that only reads the world.
      if (this.makeStored && !this.readOnly) {
        const { i, j } = tileOfKey(key);
        const made = await this.makeStored(i, j, this.versions.get(key) ?? 0, false, true);
        if (!made.legacy) {
          if (made.version === null) throw new Error(`tile ${key} was made and not stored`);
          this.versions.set(key, Math.max(this.versions.get(key) ?? 0, made.version));
          return made.version;
        }
      }
      const known = (await this.backend.run({ op: 'version', map: this.map, key, readOnly: this.readOnly })) as number | null;
      if (known !== null) {
        this.versions.set(key, Math.max(this.versions.get(key) ?? 0, known));
        return known;
      }
      return (await this.made(key)).version;
    });
  }

  /** EVERY TILE THE STORE HOLDS BAKED AND ITS VERSION, IN ONE READ (their marks, `PartStore.marks`): DO NOT ask the store for each tile of the map at the opening (`ensure`: a worker's and IndexedDB's round trip a tile, 100 at 10 km, 1,600 at 40). Null where the store keeps no marks; a tile missing from it, or not baked, is ensured as before. */
  async manifest(): Promise<ReadonlyMap<number, number> | null> {
    const marks = await this.storedMarks();
    if (!marks) return null;
    const out = new Map<number, number>();
    for (const [key, { version, baked }] of marks) if (baked) out.set(key, version);
    return out;
  }

  /** Every mark the store holds, baked or not, each version kept as the least the next write of its tile goes past; null where the store keeps none. */
  private async storedMarks(): Promise<ReadonlyMap<number, { readonly version: number; readonly baked: boolean }> | null> {
    const flat = (await this.backend.run({ op: 'marks', map: this.map })) as number[] | null;
    if (!flat) return null;
    const out = new Map<number, { version: number; baked: boolean }>();
    for (let k = 0; k + 2 < flat.length; k += 3) {
      const key = flat[k]!, version = flat[k + 1]!;
      this.versions.set(key, Math.max(this.versions.get(key) ?? 0, version));
      out.set(key, { version, baked: flat[k + 2] === 1 });
    }
    return out;
  }

  /** A stored tile's parking bays baked and added, that section alone, where it has none (`cityTile.worker.ts` addBays), on the tile's chain: no write of it comes between; nothing where tiles are not the generator's to write. */
  addBays(key: number): Promise<void> {
    if (!this.makeStored) return Promise.resolve();
    return this.chained(key, async () => {
      if (this.writeWaits(key)) return;
      const { i, j } = tileOfKey(key);
      await this.makeStored!(i, j, this.versions.get(key) ?? 0, false, false, true);
    });
  }

  /** Whether a write of the tile waits behind the call whose turn it is: the bake and the bays give up then (the write asks its own bake). */
  private writeWaits(key: number): boolean {
    return (this.writesWaiting.get(key) ?? 0) > 0;
  }

  /** The stored tile, or null when the store has none (a stored tile unreadable rejects). */
  read(key: number): Promise<TileRecords | null> {
    return this.chained(key, () => this.readNow(key, false));
  }

  /** Stores a tile, its version one past the last the store knows: the version written, or null when it was not (what is baked of it is keyed by that version). */
  /** DO NOT bake a tile's sections in the save worker before its records are stored: the bake (the network's junctions, the grown buildings made again) held the worker's event loop for seconds, every write's commit and the world's values' with it, and a reload meanwhile lost the edit and the balance (conf28). The records stored first, alone; the maker bakes the sections after, on the tile's chain (`bakeStoredTile`). */
  /** `keep.buildings`: its buildings and lots untouched since the version the store holds (`WorldStreamer` D4): that part kept as stored. */
  write(records: TileRecords, keep?: { readonly buildings: boolean }): Promise<number | null> {
    const maker = this.readOnly ? undefined : this.makeStored;
    // DO NOT queue an edit behind the tile's bake or bays not begun: dropped, its own bake asked after it.
    this.dropQueued?.(records.key);
    // Those not asked of the maker yet, their turn still to come on the chain, give up when it does (`writeWaits`).
    this.writesWaiting.set(records.key, (this.writesWaiting.get(records.key) ?? 0) + 1);
    const written = this.chained(records.key, async () => {
      const left = (this.writesWaiting.get(records.key) ?? 1) - 1;
      if (left > 0) this.writesWaiting.set(records.key, left); else this.writesWaiting.delete(records.key);
      // The version the store holds now (the last read or written): its parts are those the page kept.
      const base = this.versions.get(records.key);
      const stamped = this.stamped(records);
      const same = keep?.buildings && base !== undefined ? { base, parts: ['buildings'] as const } : undefined;
      return (await this.put(tileWrite(stamped), maker !== undefined, same)) ? stamped.version : null;
    });
    if (maker) {
      const { i, j } = tileOfKey(records.key);
      // A failed bake leaves the tile stored without its sections: its readers derive them, the next look at its version bakes them (`upgraded`).
      void this.chained(records.key, async () => {
        const version = await written;
        if (version !== null && !this.writeWaits(records.key)) await maker(i, j, version, false, false, false, true);
      }).catch((error: unknown) => console.warn(`[save] tile ${records.key}'s sections were not baked`, error));
    }
    return written;
  }

  /** A world file opened (`main.ts` openStreamedWorld): its tiles in place of the stored ones, each written above the version stored (what was baked of the old tile not taken for it); every tile of the map the file lacks taken away after, to be made again above it too; the values last (their key says the world is stored). False when any of it was not written. */
  /** DO NOT hold the file's tiles together, nor ask the store for each tile of the map: `eachTile` hands them one at a time (`worldExport.ts` WorldFile), the versions stored come from the marks in one read (`manifest`), and the tiles it lacks go in one removal. */
  async importWorld(meta: WorldMeta, eachTile: (take: (records: TileRecords) => Promise<boolean>) => Promise<boolean>, mapKeys: Iterable<number>): Promise<boolean> {
    const marked = await this.storedMarks();
    const given = new Set<number>();
    const whole = await eachTile(async (tile) => {
      given.add(tile.key);
      // A tile stored before marks were: its version asked alone.
      if (!marked?.has(tile.key)) await this.knownVersion(tile.key);
      return (await this.write(tile)) !== null;
    });
    if (!whole) return false;
    // Taken away whether stored or not (a removal of a key not there does nothing): DO NOT ask for each first.
    const gone = [...mapKeys].filter((key) => !given.has(key));
    if (gone.length && (await this.backend.run({ op: 'removeTiles', map: this.map, keys: gone })) !== true) return false;
    return this.setMeta(meta);
  }

  /** The version the store holds a tile at (null: none), kept as the least the next write of it goes past. */
  private knownVersion(key: number): Promise<number | null> {
    return this.chained(key, async () => {
      const known = (await this.backend.run({ op: 'version', map: this.map, key, readOnly: this.readOnly })) as number | null;
      if (known !== null) this.versions.set(key, Math.max(this.versions.get(key) ?? 0, known));
      return known;
    });
  }

  /** The stored tile, or the tile generated and stored: generated only when the store has none (stored by the generator's worker where it can, as a tile made ahead is). */
  load(key: number): Promise<TileRecords> {
    return this.chained(key, async () => {
      // The maker reads it where it is stored (the browser's), and makes it only if it is not.
      if (this.makeStored && !this.readOnly) {
        const records = await this.madeThere(key);
        if (records) return records;
      }
      return (await this.readNow(key, true)) ?? this.made(key);
    });
  }

  meta(): Promise<WorldMeta | null> {
    return this.chained('world', () => this.backend.run({ op: 'meta', map: this.map }) as Promise<WorldMeta | null>);
  }

  /** A stored tile's records as their texts, each an object of some of its fields (`TileText`), never parsed here: null when none is stored (a map saved to a file, `worldExport.ts`). */
  readText(key: number): Promise<TileText | null> {
    return this.chained(key, () => this.backend.run({ op: 'readText', map: this.map, key, readOnly: this.readOnly }) as Promise<TileText | null>);
  }

  /** A stored tile's lists emptied (a "whole map" clear), in its order with the tile's other calls: the version written, null when there was nothing to clear or no tile is stored. */
  clearLists(key: number, parts: readonly ClearablePart[]): Promise<number | null> {
    this.dropQueued?.(key);
    return this.chained(key, async () => {
      const maker = this.readOnly ? undefined : this.makeStored;
      const got = (await this.backend.run({ op: 'clearLists', map: this.map, key, parts, after: this.versions.get(key) ?? 0, ...(maker ? { unbaked: true } : {}) })) as { version: number; cleared: boolean } | null;
      if (!got) return null;
      this.versions.set(key, Math.max(this.versions.get(key) ?? 0, got.version));
      // Its sections baked by the maker, as a write's (`write`).
      if (maker && got.cleared) {
        const { i, j } = tileOfKey(key);
        void this.chained(key, () => maker(i, j, got.version, false, false, false, true)).catch((error: unknown) => console.warn(`[save] tile ${key}'s sections were not baked`, error));
      }
      return got.cleared ? got.version : null;
    });
  }

  /** Some of the world's parts written, each apart (`RoadDoc.worldPart`): DO NOT write the whole world's values for one part that changed. */
  setMetaParts(parts: Partial<Record<WorldPart, Partial<SerializedDoc>>>): Promise<boolean> {
    return this.chained('world', () => this.backend.run({ op: 'setMetaParts', map: this.map, parts }).then((ok) => ok === true, (error: unknown) => {
      console.error('[save] the world could not be written', error);
      return false;
    }));
  }

  setMeta(meta: WorldMeta): Promise<boolean> {
    return this.chained('world', () => this.backend.run({ op: 'setMeta', map: this.map, meta }).then((ok) => ok === true, (error: unknown) => {
      console.error('[save] the world could not be written', error);
      return false;
    }));
  }

  /** A map saved before the tiles distributed into its tiles and the world's values, in the save worker, its keys left as they are
   *  - `local`: the map's `localStorage` text (a worker cannot read it); nothing is done when the world is already stored. */
  migrate(local: string | null = null): Promise<MigrationReport> {
    const before = Promise.all([this.gate, ...this.chains.values()]);
    const run = before.then(() => this.backend.run({ op: 'migrate', map: this.map, local }) as Promise<MigrationReport>);
    this.gate = run.then(() => undefined, () => undefined);
    return run;
  }

  /** DO NOT have the save worker parse a tile and clone it to the page: its texts are handed over and parsed here, once. */
  /** The stored tile read and prepared where the store is (`runTileOp` 'read', the save worker): the page files its records as they come. */
  private async readNow(key: number, network: boolean): Promise<TileRecords | null> {
    const prepared = (await this.backend.run({ op: 'read', map: this.map, key, network, readOnly: this.readOnly })) as PreparedTile | null;
    if (!prepared) return null;
    const records = preparedRecords(prepared);
    if (prepared.network) this.bakes.set(key, prepared.network);
    this.versions.set(key, Math.max(this.versions.get(key) ?? 0, records.version));
    return records;
  }

  /** The network bake read with the tile (`load`), once: offered to the page's network as the tile is put in (`main.ts`). */
  takeBake(key: number): NetworkBake | undefined {
    const bake = this.bakes.get(key);
    this.bakes.delete(key);
    return bake;
  }

  /** DO NOT post a tile the generator made back to the store from the page: its worker stores it and hands the page its records prepared; kept for the page even when the write fails. */
  /** Null: stored in an older form, read by the save worker (`storedVersion`). */
  private async madeThere(key: number): Promise<TileRecords | null> {
    const { i, j } = tileOfKey(key);
    const made = await this.makeStored!(i, j, this.versions.get(key) ?? 0, true, true);
    if (made.legacy) return null;
    if (!made.prepared) throw new Error(`tile ${key} was made and not handed back`);
    if (made.version === null) console.warn(`[save] tile ${key} was made and not stored`);
    const records = preparedRecords(made.prepared);
    if (records.key !== key) throw new Error(`the generator made tile ${records.key} for tile ${key}`);
    if (made.prepared.network) this.bakes.set(key, made.prepared.network);
    this.versions.set(key, Math.max(this.versions.get(key) ?? 0, records.version));
    return records;
  }

  /** A tile generated and stored; kept for the page even when the write fails (the same tile comes out again next time). */
  private async made(key: number): Promise<TileRecords> {
    const { i, j } = tileOfKey(key);
    const fresh = await this.generate(i, j);
    if (fresh.key !== key) throw new Error(`the generator made tile ${fresh.key} for tile ${key}`);
    // Prepared here as a worker prepares one (`prepareTile`): its buildings one table, which the page reads them from, the write posts and the cell jobs read.
    const records = preparedRecords(prepareTile(this.stamped(fresh), false));
    if (this.readOnly) return records;
    if (!(await this.put(tileWrite(records)))) console.warn(`[save] tile ${key} was made and not stored`);
    return records;
  }

  private stamped(records: TileRecords): TileRecords {
    const version = Math.max(records.version, this.versions.get(records.key) ?? 0) + 1;
    this.versions.set(records.key, version);
    return { ...records, version };
  }

  private async put(write: TileWrite, unbaked = false, same?: { readonly base: number; readonly parts: readonly RecordPart[] }): Promise<boolean> {
    if (this.readOnly) return false;
    try {
      return (await this.backend.run({ op: 'write', map: this.map, records: write, ...(unbaked ? { unbaked } : {}), ...(same ? { same } : {}) })) === true;
    } catch (error) {
      console.error(`[save] tile ${write.key} could not be written`, error);
      return false;
    }
  }

  private chained<T>(key: number | 'world', run: () => Promise<T>): Promise<T> {
    const before = this.chains.get(key);
    const gate = this.gate;
    const done = (before ? before.then(() => gate) : gate).then(run);
    const tail = done.then(() => undefined, () => undefined);
    this.chains.set(key, tail);
    void tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
    return done;
  }
}
