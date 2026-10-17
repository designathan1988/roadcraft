import { migrateBuilding } from '@world/buildings/serialize';
import { tileBuildingsOf } from '@world/growth/grownRows';
import type { Finish } from '@world/buildings/materials';
import { type RecordRef, readRecords, refOf } from '@world/buildings/recordTable';
import type { Building } from '@world/buildings/types';
import type { TileRecords } from '@world/doc';
import { tileKey, tileOfKey } from '@world/tiles';
import { derivedCacheOpen, keepDerivedDurably, keepDerivedQueued, readDerived } from '../derivedCache';
import { type GroundReaders, type SharedGroundData, sharedGroundReaders } from '../sharedGround';
import { BOX_INSTANCE, type BoxMass, type CellMass, type FarMass, MASS_FACADE, MASS_GRID, cellMass, farMassBuffers, indexArray, shellBounds } from './cellArrays';
import { AGGREGATE, LEVEL_MASS_KEY as MASS_KEY, NODE_BOX_KEY as BOX_KEY, TILE_PLATE_KEY as PLATE_KEY, farKey, farNode, nodeSide, readStored } from './farGrid';
import { BOX_FLOATS, type MassDetail, type MassingChunk, PLATE_DETAIL, TILE_DETAIL, emitBoxes, emitMassing, massFloor } from './massing';

export { AGGREGATE, TOP_LEVEL, emptyRecords, farKey, farNode, nodeSide } from './farGrid';

/** THE BUILDINGS FAR FROM THE CAMERA, BAKED PER TILE IN WORKERS FROM THE TILE STORE (CLAUDE.md "Streaming world"): nothing of their records on the page */
/** A quadtree over the tiles (`farLevels.ts` chooses it): level 0 a tile's masses (L2), level 1 its 2x2's (L3, the plate's masses), levels 2 and up 2^k tiles a side of footprint boxes, all from the stored tiles (every tile of the map is made before the city is shown, `worldStreamer.ts` rush) */





/** The most a level leaves out, m: a tile's and a plate's masses' (`massing.ts`); past them, a square's diagonal (its small boxes merged in one). */
export function levelDrop(k: number): number {
  if (k === 0) return TILE_DETAIL.drop;
  if (k === 1) return PLATE_DETAIL.drop;
  return (nodeSide(k) / AGGREGATE) * Math.SQRT2;
}

/** What a tile's bake makes: the version, its masses at the tile's level and at the plate's, its blocks as boxes. */
interface TileBake {
  readonly sig: string;
  readonly tile: CellMass | null;
  readonly plate: CellMass | null;
  readonly boxes: Float32Array;
}
/** DO NOT keep a node's mesh and its parent's reads in one entry: each reader takes its part alone - a node drawn its masses, a plate's node its tiles' plate masses (`PLATE_KEY`), every parent its children's boxes (`BOX_KEY`); each kept by node and version (a newer version takes the older's place). */
interface MassEntry {
  readonly sig: string;
  readonly mass: FarMass | null;
}
interface BoxEntry {
  readonly sig: string;
  readonly boxes: Float32Array;
}

/** A tile's bake kept, each reader's part under its own key, the boxes last (a parent asks for them first). */
async function keepTile(cache: FarCache, at: string, bake: TileBake): Promise<void> {
  await Promise.all([cache.put(at, { sig: bake.sig, mass: bake.tile }), cache.put(`${at}${PLATE_KEY}`, { sig: bake.sig, mass: bake.plate })]);
  await cache.put(`${at}${BOX_KEY}`, { sig: bake.sig, boxes: bake.boxes });
}

/** Where bakes are kept by node and version (`derivedCache.ts` in the job workers; a map in tests). */
export interface FarCache {
  ready(): Promise<boolean>;
  get(key: string): Promise<unknown>;
  /** Resolved once kept for good: a parent's job, maybe on another worker, reads it after. */
  put(key: string, value: unknown): Promise<void>;
}

/** The player's browser store, from the worker that bakes (IndexedDB is open to workers, MDN). */
export const derivedFarCache: FarCache = {
  ready: derivedCacheOpen,
  get: (key) => readDerived(key),
  put: async (key, value) => { await (await keepDerivedDurably(key, value)).committed; },
};

/** A child of a node as its job reads it: its key and the version of the tiles under it. */
interface FarChild {
  readonly key: string;
  readonly sig: string;
}

/** The same store, a write resolved once queued (`keepDerivedQueued`): for a tile's maker, whose later readers' transactions come after its write's. */
export const queuedFarCache: FarCache = { ready: derivedCacheOpen, get: (key) => readDerived(key), put: (key, value) => keepDerivedQueued(key, value) };

/** Rows of one shared table of buildings (`recordTable.ts`): the table posted as a handle, never copied, each row a building migrated where the table was written. */
export interface RecordRows {
  readonly buffer: ArrayBufferLike;
  readonly rows: Uint32Array;
}

/** DO NOT post a tile's buildings as objects (cloned by the message, migrated again by the worker): each building's row in its table (`refOf`; a tile the page read from the store is one table, `preparedRecords`), grouped by table */
export function tileRows(buildings: readonly unknown[]): RecordRows[] {
  const byTable = new Map<ArrayBufferLike, number[]>();
  for (const b of buildings) {
    const ref = refOf(b as Building);
    let rows = byTable.get(ref.buffer);
    if (!rows) byTable.set(ref.buffer, rows = []);
    rows.push(ref.row);
  }
  return [...byTable].map(([buffer, rows]) => ({ buffer, rows: Uint32Array.from(rows) }));
}

/** A tile's buildings read from their tables' rows, one reader a table (`readRecords`): never migrated again. */
function rowsBuildings(groups: readonly RecordRows[]): Building[] {
  const refs: RecordRef[] = [];
  for (const { buffer, rows } of groups) for (const row of rows) refs.push({ buffer, row });
  return readRecords(refs);
}

/** A far job (`cell.worker.ts`): a node's masses, from the cache, its tile's buildings (level 0) or its children's bakes (above) */
export interface FarJob {
  readonly far: true;
  readonly node: string;
  /** The version of the tiles under it (`farLevels.ts`): what it is kept under. */
  readonly sig: string;
  /** Its mesh wanted back (to be drawn), or only baked and kept (for a parent). */
  readonly want: boolean;
  /** The cache's prefix (this build's fingerprint of the masses' code); null: nothing kept, the levels past the tiles not made. */
  readonly prefix: string | null;
  /** Its four quarters (level 1 and up), null where no tile is (past the map's edge). */
  readonly children?: readonly (FarChild | null)[];
  /** Level 0, once the cache said it did not have it and no worker reads the store (the desktop's, the main process's): the tile's buildings the page read, as rows of their shared tables (`tileRows`). */
  readonly buildings?: readonly RecordRows[];
  /** Level 0: the store's map this worker reads the tile from itself (`core/storedTiles.ts`), in place of `buildings`. */
  readonly store?: string;
  /** The ground shared with the workers (`sharedGround.ts`); none: flat at 0. */
  readonly ground?: SharedGroundData | null;
  readonly naturalIsGround?: boolean;
  readonly tone?: Readonly<Record<Finish, readonly [number, number, number]>>;
}

export type FarReply =
  /** Baked and kept: its mesh when wanted (null: none of its buildings has a mass). */
  | { readonly kind: 'far'; readonly node: string; readonly sig: string; readonly mass: FarMass | null }
  /** A tile not kept at that version and no store this worker reads: its buildings wanted from the page. */
  | { readonly kind: 'farRecords'; readonly node: string; readonly sig: string }
  /** Children not kept at their versions: baked first. */
  | { readonly kind: 'farChildren'; readonly node: string; readonly sig: string; readonly missing: readonly string[] }
  /** Nothing can be kept here: no level past the tiles. */
  | { readonly kind: 'farNoCache'; readonly node: string; readonly sig: string }
  | { readonly kind: 'farError'; readonly node: string; readonly sig: string; readonly message: string };

/** Every buffer of a reply: handed over, not copied (MDN, `postMessage` transfer). */
export const farReplyBuffers = (reply: FarReply): ArrayBuffer[] => (reply.kind === 'far' && reply.mass ? farMassBuffers(reply.mass) : []);

const FLAT: GroundReaders = { groundAt: () => 0, naturalAt: () => 0 };

/** What a far bake reads besides the buildings: the ground shared with the workers (none: flat at 0) and the finishes' tones. */
export interface FarGroundEnv {
  readonly ground: SharedGroundData | null;
  readonly naturalIsGround: boolean;
  readonly tone?: Readonly<Record<Finish, readonly [number, number, number]>>;
}

/** The ground a far job reads: the shared plates and the relief where a plate is not made (`sharedGround.ts`), or flat at 0. */
function readsOf(job: Pick<FarJob, 'ground' | 'naturalIsGround'>): GroundReaders {
  if (!job.ground) return FLAT;
  const shared = sharedGroundReaders(job.ground);
  return job.naturalIsGround ? { groundAt: shared.groundAt, naturalAt: shared.groundAt } : shared;
}

/** A stored tile's buildings as the document loads them (`BuildingStore.load`), its grown rows made again on their lots (`world/growth/grownRows.ts`): each record read by the document's own reader, those it cannot read left out. */
function tileBuildings(records: TileRecords): Building[] {
  const out: Building[] = [];
  for (const raw of tileBuildingsOf(records)) {
    const b = migrateBuilding(raw);
    if (b) out.push(b);
  }
  return out;
}

/** The masses of buildings at a level, merged, as the cells' job emits them (`cellWork.ts`); a signature building by its blocks (no body of its own is drawn far off). `floors`: each one's floor worked out already (`bakeTile`). */
function massesOf(buildings: readonly Building[], detail: MassDetail, reads: GroundReaders, tone?: FarJob['tone'], floors?: readonly { readonly floor: number | undefined }[]): CellMass | null {
  const chunks: MassingChunk[] = [];
  for (let n = 0; n < buildings.length; n++) {
    const mass = emitMassing(buildings[n]!, reads.groundAt, undefined, reads.naturalAt, false, tone, detail, floors?.[n]);
    if (mass) chunks.push(mass);
  }
  return cellMass(chunks);
}

/** A TILE'S MASSES FROM ITS RECORDS ALONE: no page, no document, no paving (the floor on the natural ground) */
export function bakeTileMasses(records: TileRecords, detail: MassDetail, reads: GroundReaders = FLAT, tone?: FarJob['tone']): CellMass | null {
  return massesOf(tileBuildings(records), detail, reads, tone);
}

/** A tile's bake from its buildings: its masses at its level and its plate's, its blocks as boxes. */
function bakeTile(buildings: readonly Building[], sig: string, reads: GroundReaders, tone?: FarJob['tone']): TileBake {
  // DO NOT sample each building's ground three times: its floor once, for its boxes and its masses at both levels.
  const floors = buildings.map((b) => ({ floor: massFloor(b, reads.naturalAt) }));
  const boxes: number[] = [];
  buildings.forEach((b, n) => emitBoxes(b, undefined, reads.naturalAt, tone, boxes, floors[n]));
  return { sig, tile: massesOf(buildings, TILE_DETAIL, reads, tone, floors), plate: massesOf(buildings, PLATE_DETAIL, reads, tone, floors), boxes: new Float32Array(boxes) };
}

/** Several box lists as one. */
function joined(lists: readonly Float32Array[]): Float32Array {
  let n = 0;
  for (const l of lists) n += l.length;
  const out = new Float32Array(n);
  n = 0;
  for (const l of lists) { out.set(l, n); n += l.length; }
  return out;
}

/** A box's numbers merged by area (`aggregateBoxes`): x, y, top, floor, wall rgb, roof rgb, bay, storey, share. */
const WEIGHED = [0, 1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;

/** A LEVEL'S BOXES, simplified to its error (generalisation into block models, as LOD1 city models are made): a box as wide as a square or wider stands alone; the smaller ones in a square, of a height band, become one box of their plan area, area-weighted */
export function aggregateBoxes(boxes: Float32Array, k: number, i: number, j: number): Float32Array {
  const side = nodeSide(k) / AGGREGATE, ox = i * nodeSide(k), oy = j * nodeSide(k);
  const out: number[] = [];
  /** Per square and band: area; x, y, top, floor, wall rgb, roof rgb, bay, storey, share, each times the area (`WEIGHED`); the lowest foot; the first seed. */
  const sums = new Map<string, Float64Array>();
  for (let o = 0; o < boxes.length; o += BOX_FLOATS) {
    const hu = boxes[o + 2]!, hv = boxes[o + 3]!;
    if (2 * Math.hypot(hu, hv) >= side * Math.SQRT2) {
      for (let f = 0; f < BOX_FLOATS; f++) out.push(boxes[o + f]!);
      continue;
    }
    const x = boxes[o]!, y = boxes[o + 1]!, top = boxes[o + 6]!;
    const key = `${Math.floor((x - ox) / side)},${Math.floor((y - oy) / side)},${Math.floor(top / side)}`;
    let s = sums.get(key);
    if (!s) { s = new Float64Array(16); s[14] = Infinity; s[15] = boxes[o + 17]!; sums.set(key, s); }
    const a = Math.max(boxes[o + 18]!, 1e-6);
    s[0] = s[0]! + a;
    for (let w = 0; w < WEIGHED.length; w++) s[1 + w] = s[1 + w]! + boxes[o + WEIGHED[w]!]! * a;
    s[14] = Math.min(s[14]!, boxes[o + 5]!);
  }
  for (const s of sums.values()) {
    const a = s[0]!, half = Math.sqrt(a) / 2;
    out.push(s[1]! / a, s[2]! / a, half, half, 0, s[14]!, s[3]! / a, s[4]! / a);
    for (let c = 0; c < 6; c++) out.push(s[5 + c]! / a);
    out.push(s[11]! / a, s[12]! / a, s[13]! / a, s[15]!, a);
  }
  return new Float32Array(out);
}

/** BOXES AS INSTANCES OF ONE BOX (`massBoxes.ts`): each its plan, heights, colours and glazing, `BOX_INSTANCE` numbers, its walls and roof laid by the masses' shader as `massing.ts` would lay them; `error`, what its level left out */
function boxMass(boxes: Float32Array, error: number): BoxMass | null {
  const n = boxes.length / BOX_FLOATS;
  if (n === 0) return null;
  const out = new Float32Array(n * BOX_INSTANCE);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, top = -Infinity;
  for (let b = 0; b < n; b++) {
    const o = b * BOX_FLOATS, t = b * BOX_INSTANCE;
    const cx = boxes[o]!, cy = boxes[o + 1]!, hu = boxes[o + 2]!, hv = boxes[o + 3]!, turn = boxes[o + 4]!;
    out[t] = cx; out[t + 1] = cy; out[t + 2] = hu; out[t + 3] = hv;
    out[t + 4] = turn; out[t + 5] = boxes[o + 5]!; out[t + 6] = boxes[o + 6]!; out[t + 7] = boxes[o + 7]!;
    out[t + 8] = boxes[o + 8]!; out[t + 9] = boxes[o + 9]!; out[t + 10] = boxes[o + 10]!; out[t + 11] = boxes[o + 14]!;
    out[t + 12] = boxes[o + 11]!; out[t + 13] = boxes[o + 12]!; out[t + 14] = boxes[o + 13]!; out[t + 15] = boxes[o + 15]!;
    out[t + 16] = boxes[o + 16]!; out[t + 17] = boxes[o + 17]!;
    // Its corners on the plan, as the shader lays them (three's axes: the plan's y is -z).
    const ux = Math.cos(turn), uy = Math.sin(turn);
    for (const [a, d] of [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]] as const) {
      const x = cx + ux * a - uy * d, y = cy + uy * a + ux * d;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, -y); maxZ = Math.max(maxZ, -y);
    }
    minY = Math.min(minY, boxes[o + 5]!); maxY = Math.max(maxY, boxes[o + 6]!);
    top = Math.max(top, boxes[o + 6]!);
  }
  const ex = (maxX - minX) / 2, ey = (maxY - minY) / 2, ez = (maxZ - minZ) / 2;
  const bounds = Float64Array.of(minX, minY, minZ, maxX, maxY, maxZ, minX + ex, minY + ey, minZ + ez, Math.hypot(ex, ey, ez));
  return { boxes: out, bounds, top, error };
}

/** Several masses as one (a level-1 node's tiles' plate masses). */
function joinMasses(list: readonly (CellMass | null)[]): CellMass | null {
  let vertices = 0, indices = 0, error = 0, top = -Infinity;
  const some = list.filter((c): c is CellMass => c !== null);
  for (const c of some) { vertices += c.position.length / 3; indices += c.index.length; error = Math.max(error, c.error); top = Math.max(top, c.top); }
  if (indices === 0) return null;
  const position = new Float32Array(vertices * 3), normal = new Int8Array(vertices * 4), color = new Uint16Array(vertices * 4);
  const facade = new Float32Array(vertices * MASS_FACADE), grid = new Uint16Array(vertices * MASS_GRID), seed = new Float32Array(vertices), index = indexArray(vertices, indices);
  let v = 0, n = 0;
  for (const c of some) {
    position.set(c.position, v * 3);
    normal.set(c.normal, v * 4);
    color.set(c.color, v * 4);
    facade.set(c.facade, v * MASS_FACADE);
    grid.set(c.grid, v * MASS_GRID);
    seed.set(c.seed, v);
    for (let i = 0; i < c.index.length; i++) index[n + i] = c.index[i]! + v;
    v += c.position.length / 3;
    n += c.index.length;
  }
  return { position, normal, color, facade, grid, seed, index, bounds: shellBounds(position), top, error };
}


/** A TILE'S FAR LEVEL KEPT WHERE THE TILE WAS JUST MADE (`cityTile.worker.ts`): its buildings as grown, baked and kept under the key and version the page's job for it asks (`runFarJob` level 0), so no worker reads the tile back and grows its buildings again to bake it */
export async function keepTileFar(records: TileRecords, version: number, env: FarGroundEnv, prefix: string | null, cache: FarCache = derivedFarCache): Promise<boolean> {
  if (prefix === null || !(await cache.ready())) return false;
  const { i, j } = tileOfKey(records.key);
  await keepTile(cache, `${prefix}${farKey(0, i, j)}`, bakeTile(tileBuildings(records), String(version), readsOf(env), env.tone));
  return true;
}

/** DO NOT bake what is kept: a node is baked once per version of its tiles (kept under its key with that version), from its tile's buildings or its children's bakes, never from the page's document */
export async function runFarJob(job: FarJob, cache: FarCache): Promise<FarReply> {
  const { node, sig, prefix } = job;
  const { k, i, j } = farNode(node);
  const keeps = prefix !== null && await cache.ready();
  /** A node's entry if kept at that version (an older one is not its tiles' any more). */
  const kept = async <T extends { readonly sig: string }>(key: string, version: string): Promise<T | undefined> => {
    const entry = await cache.get(`${prefix}${key}`) as T | undefined;
    return entry?.sig === version ? entry : undefined;
  };
  if (k === 0) {
    // Its masses alone when drawn; its boxes when baked for its parent (`BOX_KEY`).
    const known = keeps ? await kept<MassEntry | BoxEntry>(job.want ? node : `${node}${BOX_KEY}`, sig) : undefined;
    if (known) return { kind: 'far', node, sig, mass: job.want ? (known as MassEntry).mass : null };
    // The rows the page posted (migrated where their table was written), or the stored part read here and migrated.
    const stored = job.buildings ? undefined : await readStored(job.store, tileKey(i, j), 'buildings');
    const buildings = job.buildings ? rowsBuildings(job.buildings) : stored ? tileBuildings(stored) : null;
    if (!buildings) return { kind: 'farRecords', node, sig };
    const bake = bakeTile(buildings, sig, readsOf(job), job.tone);
    if (keeps) await keepTile(cache, `${prefix}${node}`, bake);
    return { kind: 'far', node, sig, mass: job.want ? bake.tile : null };
  }
  if (!keeps) return { kind: 'farNoCache', node, sig };
  // DO NOT read its four tiles' entries whole whenever a level-1 node is drawn: its tiles' plate masses are kept merged under a key of their own (`MASS_KEY`), apart from the boxes its parent reads.
  const drawn = job.want ? await kept<MassEntry>(k === 1 ? `${node}${MASS_KEY}` : node, sig) : undefined;
  if (drawn) return { kind: 'far', node, sig, mass: drawn.mass };
  const boxed = await kept<BoxEntry>(`${node}${BOX_KEY}`, sig);
  if (boxed && !job.want) return { kind: 'far', node, sig, mass: null };
  const children = job.children ?? [];
  // Its children's boxes unless its own are kept; a plate's node drawn, its tiles' plate masses.
  const got = boxed ? children.map(() => null) : await Promise.all(children.map((c) => (c ? kept<BoxEntry>(`${c.key}${BOX_KEY}`, c.sig) : Promise.resolve(null))));
  const plates = k === 1 && job.want ? await Promise.all(children.map((c) => (c ? kept<MassEntry>(`${c.key}${PLATE_KEY}`, c.sig) : Promise.resolve(null)))) : null;
  const missing: string[] = [];
  children.forEach((c, n) => { if (c && ((!boxed && !got[n]) || (plates && !plates[n]))) missing.push(c.key); });
  if (missing.length) return { kind: 'farChildren', node, sig, missing };
  const lists = got.flatMap((e) => (e ? [e.boxes] : []));
  if (k === 1) {
    if (!boxed) await cache.put(`${prefix}${node}${BOX_KEY}`, { sig, boxes: joined(lists) });
    if (!plates) return { kind: 'far', node, sig, mass: null };
    const mass = joinMasses(plates.map((e) => (e?.mass ?? null) as CellMass | null));
    await cache.put(`${prefix}${node}${MASS_KEY}`, { sig, mass });
    return { kind: 'far', node, sig, mass };
  }
  const boxes = boxed ? boxed.boxes : aggregateBoxes(joined(lists), k, i, j);
  const mass = boxMass(boxes, levelDrop(k));
  await cache.put(`${prefix}${node}`, { sig, mass });
  if (!boxed) await cache.put(`${prefix}${node}${BOX_KEY}`, { sig, boxes });
  return { kind: 'far', node, sig, mass: job.want ? mass : null };
}
