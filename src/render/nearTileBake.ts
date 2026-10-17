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
export type NearKind = 'poles' | 'furniture' | 'signs' | 'barriers' | 'planted' | 'structures' | 'gardens' | 'covers';

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
  extra?(tile: number): unknown;
  /** Whether it can be drawn now (its models loaded); none: always. Until then no tile of it is asked. */
  enabled?(): boolean;
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
  /** The tiles read: the tile first, then its neighbours (where its kind reads them). */
  readonly tiles: readonly TileRecords[];
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
  /** Parts read besides only where the tile has something of the kind (`has`, from `parts` alone): a kind that reads the buildings for a few tiles (the trees planted, what covers them) never reads them for the others. */
  readonly more?: readonly NearPart[];
  /** Whether the tiles read (the tile first, its neighbours after where its kind reads them; their `parts` alone) hold anything of the kind for the tile: none, its bake is null and nothing more is read. */
  has?(tiles: readonly TileRecords[]): boolean;
  /** Reads the 8 tiles round it (a wire to a neighbour's pole, a junction on the edge); false: the tile alone. */
  readonly around: boolean;
  /** How far past the tile the ground it stands on is read (`groundDigest`). */
  readonly groundReach: number;
  /** What the bake reads of the page's own values (the clearings reaching the tile), digested: kept by it as by the ground (none: nothing). */
  readKey?(extra: E): number;
  /** A first stage of its bake that reads no ground (a garden's plants, its buildings made again from their rows): kept by the tiles' version alone, so a change of the ground under the tile never makes it again; handed to `bake`. */
  staged?(area: NearArea, extra: E): unknown;
  bake(area: NearArea, extra: E, staged?: unknown): P | null;
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

/** A kind of a tile asked: the page's version of the ask (`sig`: an answer to another is dropped), the version of what it reads (`want`: the tiles' versions and the kind's own), the bake the page draws now (`shown`: the same bake comes back without its arrays), what else it reads from the page (`NearProduct.extra`). */
export interface NearAsk {
  readonly kind: NearKind;
  readonly sig: string;
  readonly want: string;
  readonly shown: string | null;
  readonly extra?: unknown;
}

/** A NEAR JOB: EVERY KIND OF A TILE ASKED AT ONCE (`nearTiles.ts`), the tiles read once and their document, network and heights made once for all of them; the page's records where it holds the tiles edited */
export interface NearTileJob {
  /** The tile's column and row, `i,j`. */
  readonly node: string;
  readonly asks: readonly NearAsk[];
  readonly prefix: string | null;
  readonly store?: string;
  /** The tile and (where a kind asked reads them) the neighbours stored, each at its version (the tile first). */
  readonly tiles: readonly { readonly key: number; readonly version: number }[];
  /** The tiles' records the page holds (edited, not written yet; all of them where no worker reads the store), in the order of `tiles`, null for one read here. */
  readonly records?: readonly (Partial<TileRecords> | null)[];
  /** The tile itself held edited by the page: what the player just did, baked before anything (`cellPool.ts` EDIT_TIER). */
  readonly edited?: boolean;
  readonly ground: NearGround;
}

/** A kind's answer: its bake (its version, its arrays; none when it is the one drawn, `same`), or why it failed. */
export type NearAnswer =
  | { readonly kind: NearKind; readonly sig: string; readonly bake: string; readonly payload: unknown; readonly same: boolean }
  | { readonly kind: NearKind; readonly sig: string; readonly error: string };

/** A near job's answer: each kind's, the tiles' records asked of the page (no worker reads the store), or why the job failed. */
export type NearTileReply =
  | { readonly kind: 'near'; readonly node: string; readonly answers: readonly NearAnswer[] }
  | { readonly kind: 'nearRecords'; readonly node: string }
  | { readonly kind: 'nearError'; readonly node: string; readonly message: string };

/** A bake as it is kept: what it read (the tiles' and the kind's versions, the content of the parts it read, the ground under it) and what it made; named by its content and ground (`bake`), not by the tiles' versions. */
interface KeptNear {
  readonly want: string;
  readonly content: string;
  readonly ground: number;
  readonly bake: string;
  readonly payload: unknown;
}

/** The fields of each part, in a fixed order (`editor/tileStore.ts` splitRecords; `next` left out: it moves with every record made). */
const PART_FIELDS: Readonly<Record<NearPart, readonly (keyof TileRecords)[]>> = {
  roads: ['nodes', 'borrowedNodes', 'segments', 'gates'],
  buildings: ['buildings', 'grown', 'lots'],
  rest: ['poles', 'borrowedPoles', 'poleSpans', 'lotKeys', 'landscape', 'barriers', 'paint', 'trees', 'elements'],
};

/** THE CONTENT OF SOME PARTS OF A TILE, digested: what a kind reads of it, whatever version the tile is at; a record object digested once where its reader keeps `memo` (a record is replaced, never edited). The page names an edited tile by it (`nearTiles.ts`), a worker its kept bakes. */
export function partsDigest(records: Partial<TileRecords>, parts: readonly NearPart[], memo: WeakMap<object, number> = new WeakMap()): string {
  const d = new Digest();
  for (const part of [...parts].sort()) {
    for (const field of PART_FIELDS[part]) {
      const value = records[field] as unknown;
      d.addText(field);
      if (!Array.isArray(value)) { d.addPlain(value ?? null); continue; }
      for (const item of value as unknown[]) {
        if (item === null || typeof item !== 'object') { d.addPlain(item ?? null); continue; }
        let known = memo.get(item);
        if (known === undefined) memo.set(item, known = new Digest().addPlain(item).value());
        d.add(known);
      }
      d.add(value.length);
    }
  }
  return d.value().toString(36);
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

/** A tile's records read for some parts, without the empty lists of the parts not read (merged over the parts read before). */
function withoutEmpty(records: TileRecords): Partial<TileRecords> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(records)) if (!(Array.isArray(value) && value.length === 0) && field !== 'next') out[field] = value;
  return out as Partial<TileRecords>;
}

/** The tiles as one area: the document made when first asked, the tile first (an owner's node over a neighbour's borrowed copy, `loadTile`). */
function areaOf(tiles: readonly TileRecords[], groundAt: (x: number, y: number) => number, naturalAt: (x: number, y: number) => number): NearArea {
  let doc: RoadDoc | null = null, net: Network | null = null, elevation: RoadElevation | null = null;
  const area: NearArea = {
    key: tiles[0]!.key, tile: tiles[0]!, tiles, groundAt, naturalAt,
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

/** A tile's kind a job bakes: its ask, its bake, the ground it read, the key it is kept under; its first stage kept where it has one (`NearBaker.staged`). */
interface Baking {
  readonly ask: NearAsk;
  readonly baker: NearBaker<unknown>;
  readonly ground: number;
  readonly bake: string;
  readonly key: string;
  /** What was kept under its key (another version of the tiles, maybe the same content). */
  readonly kept: KeptNear | undefined;
  staged?: { readonly value: unknown };
  /** Its first stage kept at another version: taken where the content read is the same. */
  stage?: { readonly want: string; readonly content: string; readonly value: unknown };
}

/** A kept bake as an answer: the same as the page draws (no arrays), or its arrays. */
const keptAnswer = (ask: NearAsk, kept: KeptNear): NearAnswer => (ask.shown === kept.bake
  ? { kind: ask.kind, sig: ask.sig, bake: kept.bake, payload: null, same: true }
  : { kind: ask.kind, sig: ask.sig, bake: kept.bake, payload: kept.payload, same: false });

/** What a kind's bake read of the tiles: each tile's key and the content of its parts (and its `more` where it had something of the kind). */
function contentOf(b: Baking, tiles: readonly TileRecords[], has: boolean): string {
  const parts = has && b.baker.more ? [...b.baker.parts, ...b.baker.more] : b.baker.parts;
  const d = new Digest();
  for (const t of tiles) d.add(t.key).addText(partsDigest(t, parts));
  return d.value().toString(36);
}

/** DO NOT bake what is kept, nor read and solve the tiles once a kind: every kind of a tile asked is answered by one job; one kept by the version of what it read (the tiles, the kind's own, the ground under it, `groundDigest`) is taken from the store, one the page draws comes back as `same`, its arrays not sent again; the others read the tiles once (every part any of them reads), share one area (its document, network and heights), and are each baked and kept */
export async function runNearTileJob(job: NearTileJob, cache: NearTileCache, bakerOf: (kind: NearKind) => NearBaker<unknown>): Promise<NearTileReply> {
  const { node } = job;
  const shared = job.ground.ground ? sharedGroundReaders(job.ground.ground) : null;
  const groundAt = shared ? shared.groundAt : (): number => 0;
  const naturalAt = shared ? (job.ground.naturalIsGround ? shared.groundAt : shared.naturalAt) : groundAt;
  const keeps = job.prefix !== null && await cache.ready();
  const digests = new Map<number, number>();
  const answers: NearAnswer[] = [];
  const baking: Baking[] = [];
  for (const ask of job.asks) {
    const baker = bakerOf(ask.kind);
    let under = digests.get(baker.groundReach);
    if (under === undefined) digests.set(baker.groundReach, under = groundDigest(job.tiles[0]!.key, baker.groundReach, groundAt, naturalAt));
    const ground = baker.readKey ? new Digest().add(under).add(baker.readKey(ask.extra)).value() : under;
    // A staged kind's bake is named by the tiles' version (its stage read no tile); the others' by the content they read, once read.
    const bake = bakeOf(ask.want, ground);
    const key = `${job.prefix}${ask.kind}:${node}`;
    const kept = keeps ? await cache.get(key) as KeptNear | undefined : undefined;
    if (kept && kept.want === ask.want && kept.ground === ground) { answers.push(keptAnswer(ask, kept)); continue; }
    const item: Baking = { ask, baker, ground, bake, key, kept };
    // A first stage that reads no ground, kept by the tiles' version (or, read, their content): taken back without reading a tile.
    if (baker.staged && keeps) {
      const stage = await cache.get(`${key}#staged`) as { readonly want: string; readonly content: string; readonly value: unknown } | undefined;
      if (stage && stage.want === ask.want) item.staged = { value: stage.value };
      else if (stage) item.stage = stage;
    }
    baking.push(item);
  }
  if (baking.length) {
    const reading = baking.some((b) => !b.staged && b.baker.around) ? job.tiles : job.tiles.slice(0, 1);
    /** The tiles read for some parts. */
    const read = async (parts: readonly NearPart[]): Promise<TileRecords[] | null> => {
      const out: TileRecords[] = [];
      for (let n = 0; n < reading.length; n++) {
        if (!parts.length) { out.push(emptyRecords(reading[n]!.key, reading[n]!.version)); continue; }
        const tile = await partsOf(reading[n]!.key, reading[n]!.version, parts, job.records?.[n], job.store);
        if (!tile) return null;
        out.push(tile);
      }
      return out;
    };
    const union = (lists: readonly (readonly NearPart[])[]): NearPart[] => [...new Set(lists.flat())];
    const needs = baking.filter((b) => !b.staged);
    let tiles = await read(union(needs.map((b) => b.baker.parts)));
    if (!tiles) return { kind: 'nearRecords', node };
    const ownOf = (b: Baking): readonly TileRecords[] => (b.baker.around ? tiles! : tiles!.slice(0, 1));
    const having = new Set(needs.filter((b) => b.baker.has?.(ownOf(b)) ?? true));
    const more = union([...having].map((b) => b.baker.more ?? []));
    if (more.length) {
      const extra = await read(more);
      if (!extra) return { kind: 'nearRecords', node };
      tiles = tiles.map((t, n) => ({ ...t, ...withoutEmpty(extra[n]!) }));
    }
    const area = areaOf(tiles, groundAt, naturalAt);
    for (const b of baking) {
      try {
        // What it read, whatever version the tiles are at: the same content in another version (a write of the page's edit, a neighbour written) is what was baked.
        const read = b.staged ? '' : contentOf(b, ownOf(b), having.has(b));
        const bake = b.staged ? b.bake : bakeOf(read, b.ground);
        if (!b.staged && b.ask.shown === bake) { answers.push({ kind: b.ask.kind, sig: b.ask.sig, bake, payload: null, same: true }); continue; }
        if (!b.staged && b.kept && b.kept.content === read && b.kept.ground === b.ground) { answers.push(keptAnswer(b.ask, b.kept)); continue; }
        if (!b.staged && !having.has(b)) {
          answers.push({ kind: b.ask.kind, sig: b.ask.sig, bake, payload: null, same: b.ask.shown === bake });
          if (keeps) await cache.put(b.key, { want: b.ask.want, content: read, ground: b.ground, bake, payload: null } satisfies KeptNear);
          continue;
        }
        if (b.baker.staged && !b.staged) {
          b.staged = { value: b.stage && b.stage.content === read ? b.stage.value : b.baker.staged(area, b.ask.extra) };
          if (keeps) await cache.put(`${b.key}#staged`, { want: b.ask.want, content: read, value: b.staged.value });
        }
        const payload = b.baker.bake(area, b.ask.extra, b.staged?.value);
        // Kept before it is handed over: its buffers are the page's once posted.
        if (keeps) await cache.put(b.key, { want: b.ask.want, content: read, ground: b.ground, bake, payload } satisfies KeptNear);
        answers.push({ kind: b.ask.kind, sig: b.ask.sig, bake, payload, same: false });
      } catch (error) {
        console.error(`[near] a tile's ${b.ask.kind} could not be baked`, error);
        answers.push({ kind: b.ask.kind, sig: b.ask.sig, error: String((error as Error)?.stack ?? error) });
      }
    }
  }
  return { kind: 'near', node, answers };
}

/** Every buffer of an answer: handed over, not copied (MDN, `postMessage` transfer); one shared by two bakes once. */
export function nearReplyBuffers(bakerOf: (kind: NearKind) => NearBaker<unknown>, reply: NearTileReply): ArrayBuffer[] {
  if (reply.kind !== 'near') return [];
  const out = new Set<ArrayBuffer>();
  for (const answer of reply.answers) {
    if ('error' in answer || answer.payload === null) continue;
    for (const buffer of bakerOf(answer.kind).buffers(answer.payload)) out.add(buffer);
  }
  return [...out];
}

/** The ground a bake reads past a tile when its kind says nothing else. */
export const NEAR_GROUND_REACH = m(64);
