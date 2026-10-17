import { Digest } from '@core/digest';
import { storedTileReader } from '@core/storedTiles';
import { RoadDoc, type TileRecords } from '@world/doc';
import { type RoadElevation, buildRoadElevation } from '@world/elevation';
import { Network } from '@world/network';
import { TILE, tileOfKey } from '@world/tiles';
import { m } from '@world/units';
import { emptyRecords } from './buildings/farGrid';
import { derivedCacheOpen, keepDerivedDurably, readDerived } from './derivedCache';
import { type SharedGroundData, sharedGroundReaders } from './sharedGround';
import { TERRAIN_CELL } from './terrainGrid';

/** THE NEAR PRODUCTS OF A TILE, BAKED IN A WORKER FROM THE TILE STORE (CLAUDE.md "Streaming world", plan step 5): what the region's document made on the page (poles and wires, furniture, signs, barriers, planted trees, structures, gardens) made per tile by the same code from the tile's records and its neighbours', kept by the version of what it read */
/** Asked by the page's choice of tiles (`nearTiles.ts`), run by the job system (`nearTiles.worker.ts`); a tile the page holds edited is baked from the page's records, never from the store's older version. */

/** The kinds of near products baked per tile (`nearBakers.ts`). */
export type NearKind = 'poles' | 'furniture' | 'signs' | 'barriers';

/** The parts a tile is stored in (`editor/tileStore.ts`): its roads, its buildings, and the rest (poles, placed things, barriers, trees). */
export type NearPart = 'roads' | 'buildings' | 'rest';

/** A kind's bake as the page draws it. */
export interface NearLanded {
  /** Put in place, in the frame the one before it is taken away. */
  put(): void;
  /** Taken away and let go. */
  remove(): void;
  /** Settles once it can be drawn without a hitch (its buffers sent ahead); none: at once. */
  readonly ready?: Promise<void>;
}

/** A kind of near product as the page draws it (`nearTiles.ts`). */
export interface NearProduct<P = unknown> {
  readonly kind: NearKind;
  /** Its largest piece's two longest sides multiplied, m²: a tile is drawn where that spans a pixel at its nearest point, as a piece shows (`poleLayer.ts` PartStore.view): past it nothing of the kind would be seen. */
  readonly cover: number;
  /** Its highest piece over the ground, m: where the eye measures a tile from. */
  readonly top: number;
  /** What else it is baked from that the page may change: in its version. */
  version?(tile: number): string;
  /** What its bake reads from the page besides the tiles and the ground (`NearTileJob.extra`). */
  extra?(): unknown;
  /** A bake made drawable; `tile`, its tile's key. */
  land(payload: P, tile: number): NearLanded;
}

/** The ground a bake reads, as the page reads it: shared plates (null: flat at 0) and whether the natural ground is the drawn one. */
export interface NearGround {
  readonly ground: SharedGroundData | null;
  readonly naturalIsGround: boolean;
}

/** A tile as a bake reads it: its records (the parts its kind reads), and its neighbours' (the 3 x 3 round it, where its kind reads them). */
export interface NearArea {
  readonly key: number;
  /** The tile's own records: what it draws is what these hold. */
  readonly tile: TileRecords;
  /** The tile and its neighbours in one document, as the page's region files them (`RoadDoc.loadTile`), and their roads' network and heights (on the natural ground, as the page solves them). */
  doc(): RoadDoc;
  net(): Network;
  elevation(): RoadElevation;
  /** The ground as drawn, and before the roads cut it. */
  readonly groundAt: (x: number, y: number) => number;
  readonly naturalAt: (x: number, y: number) => number;
}

/** What a kind tells the bake: the parts it reads, whether it reads the neighbours, how far past the tile its ground is read, and its bake. */
export interface NearBaker<P, E = unknown> {
  readonly parts: readonly NearPart[];
  /** Reads the 8 tiles round it (a wire to a neighbour's pole, a junction on the edge); false: the tile alone. */
  readonly around: boolean;
  /** How far past the tile the ground it stands on is read (`groundDigest`). */
  readonly groundReach: number;
  bake(area: NearArea, extra: E): P | null;
  /** Its buffers, handed over not copied. */
  buffers(payload: P): ArrayBuffer[];
}

/** Where near bakes are kept (the browser's store in the workers, a map in tests). */
export interface NearTileCache {
  ready(): Promise<boolean>;
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

/** The player's browser store, from the worker that bakes (IndexedDB is open to workers, MDN). */
export const derivedNearCache: NearTileCache = {
  ready: derivedCacheOpen,
  get: (key) => readDerived(key),
  put: async (key, value) => { await (await keepDerivedDurably(key, value)).committed; },
};

/** A near job: a kind of a tile, the version of what it reads (`want`: the tiles' versions and the kind's own), the bake the page draws now (`shown`: the same bake comes back without its arrays), the page's records where it holds the tiles edited. */
export interface NearTileJob {
  readonly kind: NearKind;
  /** `kind:i,j`. */
  readonly node: string;
  /** The page's version of the ask: an answer to another is dropped. */
  readonly sig: string;
  readonly want: string;
  readonly shown: string | null;
  readonly prefix: string | null;
  readonly store?: string;
  /** The tile and the neighbours stored, each at its version (the tile first). */
  readonly tiles: readonly { readonly key: number; readonly version: number }[];
  /** The tiles' records the page holds (edited, not written yet; all of them where no worker reads the store), in the order of `tiles`, null for one read here. */
  readonly records?: readonly (Partial<TileRecords> | null)[];
  /** The tile itself held edited by the page: what the player just did, baked before anything (`cellPool.ts` EDIT_TIER). */
  readonly edited?: boolean;
  readonly ground: NearGround;
  /** What else the kind's bake reads from the page (`NearProduct.extra`). */
  readonly extra?: unknown;
}

/** A near job's answer: the bake (its version, its arrays; none when it is the one drawn, `same`), the tiles' records asked of the page, or why it failed. */
export type NearTileReply =
  | { readonly kind: 'near'; readonly node: string; readonly sig: string; readonly bake: string; readonly payload: unknown; readonly same: boolean }
  | { readonly kind: 'nearRecords'; readonly node: string; readonly sig: string }
  | { readonly kind: 'nearError'; readonly node: string; readonly sig: string; readonly message: string };

/** A bake as it is kept: what it read (the tiles' and the kind's versions, the ground under it) and what it made. */
interface KeptNear {
  readonly want: string;
  readonly ground: number;
  readonly bake: string;
  readonly payload: unknown;
}

/** What a tile's bake reads of the ground: every corner of the terrain's cells over the tile and `reach` round it, as drawn and as natural (a stroke, the roads' cut). */
export function groundDigest(key: number, reach: number, groundAt: (x: number, y: number) => number, naturalAt: (x: number, y: number) => number): number {
  const { i, j } = tileOfKey(key);
  const d = new Digest();
  const cell = TERRAIN_CELL;
  const x0 = Math.floor((i * TILE - reach) / cell), x1 = Math.ceil(((i + 1) * TILE + reach) / cell);
  const y0 = Math.floor((j * TILE - reach) / cell), y1 = Math.ceil(((j + 1) * TILE + reach) / cell);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) d.add(groundAt(x * cell, y * cell)).add(naturalAt(x * cell, y * cell));
  return d.value();
}

/** The parts of a tile a kind reads, from the page's records or the store; undefined where neither can be read here (the page reads them), the tile empty where the store has none. */
async function partsOf(key: number, version: number, parts: readonly NearPart[], page: Partial<TileRecords> | null | undefined, store: string | undefined): Promise<TileRecords | undefined> {
  if (page) return { ...emptyRecords(key, version), ...page };
  const read = store === undefined ? null : storedTileReader();
  if (!read || store === undefined) return undefined;
  let out: TileRecords = emptyRecords(key, version);
  for (const part of parts) {
    const fields = await read(store, key, part) as Partial<TileRecords> | null;
    if (fields) out = { ...out, ...fields, key, version };
  }
  return out;
}

/** The tiles as one area: the document made when first asked, the tile first (an owner's node over a neighbour's borrowed copy, `loadTile`). */
function areaOf(tiles: readonly TileRecords[], groundAt: (x: number, y: number) => number, naturalAt: (x: number, y: number) => number): NearArea {
  let doc: RoadDoc | null = null, net: Network | null = null, elevation: RoadElevation | null = null;
  const area: NearArea = {
    key: tiles[0]!.key, tile: tiles[0]!, groundAt, naturalAt,
    doc() {
      if (!doc) {
        doc = new RoadDoc();
        for (const t of tiles) doc.loadTile(t);
      }
      return doc;
    },
    net() {
      if (!net) { net = new Network(area.doc()); net.rebuild(); }
      return net;
    },
    // As the page solves them: on the ground before the roads cut it (`renderer.ts` `builtGroundAt`).
    elevation() { return elevation ??= buildRoadElevation(area.net(), naturalAt); },
  };
  return area;
}

/** The version of a bake: what it read. */
const bakeOf = (want: string, ground: number): string => `${want}/${ground.toString(36)}`;

/** DO NOT bake what is kept: a tile's kind is kept by the version of what it read (the tiles, the kind's own, the ground under it, `groundDigest`); the bake the page draws comes back as `same`, its arrays not sent again */
export async function runNearTileJob(job: NearTileJob, cache: NearTileCache, baker: NearBaker<unknown>): Promise<NearTileReply> {
  const { node, sig } = job;
  const shared = job.ground.ground ? sharedGroundReaders(job.ground.ground) : null;
  const groundAt = shared ? shared.groundAt : (): number => 0;
  const naturalAt = shared ? (job.ground.naturalIsGround ? shared.groundAt : shared.naturalAt) : groundAt;
  const ground = groundDigest(job.tiles[0]!.key, baker.groundReach, groundAt, naturalAt);
  const bake = bakeOf(job.want, ground);
  if (job.shown === bake) return { kind: 'near', node, sig, bake, payload: null, same: true };
  const keeps = job.prefix !== null && await cache.ready();
  const key = `${job.prefix}${node}`;
  const kept = keeps ? await cache.get(key) as KeptNear | undefined : undefined;
  if (kept && kept.want === job.want && kept.ground === ground) return { kind: 'near', node, sig, bake, payload: kept.payload, same: false };
  const tiles: TileRecords[] = [];
  const reading = baker.around ? job.tiles : job.tiles.slice(0, 1);
  for (let n = 0; n < reading.length; n++) {
    const { key: tile, version } = reading[n]!;
    const read = await partsOf(tile, version, baker.parts, job.records?.[n], job.store);
    if (!read) return { kind: 'nearRecords', node, sig };
    tiles.push(read);
  }
  const payload = baker.bake(areaOf(tiles, groundAt, naturalAt), job.extra);
  // Kept before it is handed over: its buffers are the page's once posted.
  if (keeps) await cache.put(key, { want: job.want, ground, bake, payload } satisfies KeptNear);
  return { kind: 'near', node, sig, bake, payload, same: false };
}

/** Every buffer of an answer: handed over, not copied (MDN, `postMessage` transfer). */
export function nearReplyBuffers(baker: NearBaker<unknown>, reply: NearTileReply): ArrayBuffer[] {
  if (reply.kind !== 'near' || reply.payload === null) return [];
  return [...new Set(baker.buffers(reply.payload))];
}

/** The ground a bake reads past a tile when its kind says nothing else. */
export const NEAR_GROUND_REACH = m(64);
