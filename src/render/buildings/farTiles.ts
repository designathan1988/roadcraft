import { migrateBuilding } from '@world/buildings/serialize';
import { tileBuildingsOf } from '@world/growth/grownRows';
import type { Finish } from '@world/buildings/materials';
import { type RecordRef, readRecords, refOf } from '@world/buildings/recordTable';
import type { Building } from '@world/buildings/types';
import type { TileRecords } from '@world/doc';
import { tileKey, tileOfKey } from '@world/tiles';
import { derivedCacheOpen, keepDerivedDurably, keepDerivedQueued, readDerived } from '../derivedCache';
import { type GroundReaders, type SharedGroundData, sharedGroundReaders } from '../sharedGround';
import { type CellMass, cellMass, cellMassBuffers, indexArray, shellBounds } from './cellArrays';
import { AGGREGATE, LEVEL_MASS_KEY as MASS_KEY, farKey, farNode, nodeSide, readStored } from './farGrid';
import { BOX_FLOATS, type MassDetail, type MassingChunk, PLATE_DETAIL, TILE_DETAIL, emitBoxes, emitMassing } from './massing';

export { AGGREGATE, TOP_LEVEL, emptyRecords, farKey, farNode, nodeSide } from './farGrid';

/** THE BUILDINGS FAR FROM THE CAMERA, BAKED PER TILE IN WORKERS FROM THE TILE STORE (CLAUDE.md "Streaming world"): nothing of their records on the page */
/** A quadtree over the tiles (`farLevels.ts` chooses it): level 0 a tile's masses (L2), level 1 its 2x2's (L3, the plate's masses), levels 2 and up 2^k tiles a side of footprint boxes, all from the stored tiles (every tile of the map is made before the city is shown, `worldStreamer.ts` rush) */





/** The most a level leaves out, m: a tile's and a plate's masses' (`massing.ts`); past them, a square's diagonal (its small boxes merged in one). */
export function levelDrop(k: number): number {
  if (k === 0) return TILE_DETAIL.drop;
  if (k === 1) return PLATE_DETAIL.drop;
  return (nodeSide(k) / AGGREGATE) * Math.SQRT2;
}

/** What a tile's bake keeps (`FarCache`, one entry a node: a newer version takes the older's place): the version, its masses at the tile's level and at the plate's, its blocks as boxes. */
interface TileEntry {
  readonly sig: string;
  readonly tile: CellMass | null;
  readonly plate: CellMass | null;
  readonly boxes: Float32Array;
}
/** What a node above the tiles keeps: the version, its mesh (none at level 1: its tiles' plate masses are kept merged apart, `MASS_KEY`), its boxes for its parent. */
interface NodeEntry {
  readonly sig: string;
  readonly mass: CellMass | null;
  readonly boxes: Float32Array;
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
  | { readonly kind: 'far'; readonly node: string; readonly sig: string; readonly mass: CellMass | null }
  /** A tile not kept at that version and no store this worker reads: its buildings wanted from the page. */
  | { readonly kind: 'farRecords'; readonly node: string; readonly sig: string }
  /** Children not kept at their versions: baked first. */
  | { readonly kind: 'farChildren'; readonly node: string; readonly sig: string; readonly missing: readonly string[] }
  /** Nothing can be kept here: no level past the tiles. */
  | { readonly kind: 'farNoCache'; readonly node: string; readonly sig: string }
  | { readonly kind: 'farError'; readonly node: string; readonly sig: string; readonly message: string };

/** Every buffer of a reply: handed over, not copied (MDN, `postMessage` transfer). */
export const farReplyBuffers = (reply: FarReply): ArrayBuffer[] => (reply.kind === 'far' && reply.mass ? cellMassBuffers(reply.mass) : []);

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

/** The masses of buildings at a level, merged, as the cells' job emits them (`cellWork.ts`); a signature building by its blocks (no body of its own is drawn far off). */
function massesOf(buildings: readonly Building[], detail: MassDetail, reads: GroundReaders, tone?: FarJob['tone']): CellMass | null {
  const chunks: MassingChunk[] = [];
  for (const b of buildings) {
    const mass = emitMassing(b, reads.groundAt, undefined, reads.naturalAt, false, tone, detail);
    if (mass) chunks.push(mass);
  }
  return cellMass(chunks);
}

/** A TILE'S MASSES FROM ITS RECORDS ALONE: no page, no document, no paving (the floor on the natural ground) */
export function bakeTileMasses(records: TileRecords, detail: MassDetail, reads: GroundReaders = FLAT, tone?: FarJob['tone']): CellMass | null {
  return massesOf(tileBuildings(records), detail, reads, tone);
}

/** A tile's bake from its buildings: its masses at its level and its plate's, its blocks as boxes. */
function bakeTile(buildings: readonly Building[], sig: string, reads: GroundReaders, tone?: FarJob['tone']): TileEntry {
  const boxes: number[] = [];
  for (const b of buildings) emitBoxes(b, undefined, reads.naturalAt, tone, boxes);
  return { sig, tile: massesOf(buildings, TILE_DETAIL, reads, tone), plate: massesOf(buildings, PLATE_DETAIL, reads, tone), boxes: new Float32Array(boxes) };
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

/** Vertices and indices a box is drawn with: four walls and a top. */
const BOX_VERTICES = 20;
const BOX_INDICES = 30;

/** BOXES AS ONE MESH OF MASSES: walls with the window pattern the masses' shader draws (`massingMaterial.ts`), a roof on top; `error`, what its level left out */
function boxMass(boxes: Float32Array, error: number): CellMass | null {
  const n = boxes.length / BOX_FLOATS;
  if (n === 0) return null;
  const position = new Float32Array(n * BOX_VERTICES * 3), normal = new Float32Array(n * BOX_VERTICES * 3), colour = new Float32Array(n * BOX_VERTICES * 3);
  const facade = new Float32Array(n * BOX_VERTICES * 4), glazing = new Float32Array(n * BOX_VERTICES * 2), index = new Uint32Array(n * BOX_INDICES);
  let v = 0, t = 0;
  /** A vertex: its plan point and height, its normal (plan x, y, up), its colour at `rgb` in the box, its facade (along, bay, storey, first storey's foot) and glass. */
  const vertex = (o: number, rgb: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, along: number, bay: number, storey: number, z0: number, share: number): void => {
    // Three's axes: the plan's y is -z (`massing.ts` `P`).
    position[v * 3] = x; position[v * 3 + 1] = z; position[v * 3 + 2] = -y;
    normal[v * 3] = nx; normal[v * 3 + 1] = nz; normal[v * 3 + 2] = -ny;
    for (let c = 0; c < 3; c++) colour[v * 3 + c] = boxes[o + rgb + c]!;
    facade[v * 4] = along; facade[v * 4 + 1] = bay; facade[v * 4 + 2] = storey; facade[v * 4 + 3] = z0;
    glazing[v * 2] = share; glazing[v * 2 + 1] = boxes[o + 17]!;
    v++;
  };
  /** A quad of the last four vertices: counter-clockwise seen from outside (three's front faces), as each is laid. */
  const quad = (): void => {
    const first = v - 4;
    index[t] = first; index[t + 1] = first + 1; index[t + 2] = first + 2;
    index[t + 3] = first; index[t + 4] = first + 2; index[t + 5] = first + 3;
    t += 6;
  };
  const xs = [0, 0, 0, 0], ys = [0, 0, 0, 0];
  for (let o = 0; o < boxes.length; o += BOX_FLOATS) {
    const cx = boxes[o]!, cy = boxes[o + 1]!, hu = boxes[o + 2]!, hv = boxes[o + 3]!, turn = boxes[o + 4]!;
    const foot = boxes[o + 5]!, top = boxes[o + 6]!, floor = boxes[o + 7]!;
    const bay = boxes[o + 14]!, storey = boxes[o + 15]!, share = boxes[o + 16]!;
    const ux = Math.cos(turn), uy = Math.sin(turn);
    // The plan's corners, counter-clockwise (x right, y up).
    [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]].forEach(([a, d], corner) => { xs[corner] = cx + ux * a! - uy * d!; ys[corner] = cy + uy * a! + ux * d!; });
    for (let side = 0; side < 4; side++) {
      const px = xs[side]!, py = ys[side]!, qx = xs[(side + 1) % 4]!, qy = ys[(side + 1) % 4]!;
      const len = Math.hypot(qx - px, qy - py) || 1;
      // Outward of a counter-clockwise ring: the edge turned right. Seen from outside in three's axes, foot p, foot q, top q, top p is counter-clockwise.
      const nx = (qy - py) / len, ny = -(qx - px) / len;
      vertex(o, 8, px, py, foot, nx, ny, 0, 0, bay, storey, floor, share);
      vertex(o, 8, qx, qy, foot, nx, ny, 0, len, bay, storey, floor, share);
      vertex(o, 8, qx, qy, top, nx, ny, 0, len, bay, storey, floor, share);
      vertex(o, 8, px, py, top, nx, ny, 0, 0, bay, storey, floor, share);
      quad();
    }
    // The roof: no windows (bay 0, as `massing.ts` `NO_FACADE`).
    for (let n = 0; n < 4; n++) vertex(o, 11, xs[n]!, ys[n]!, top, 0, 0, 1, 0, 0, 1, 0, 0);
    quad();
  }
  return cellMass([{ position, normal, colour, facade, glazing, index, error }]);
}

/** Several masses as one (a level-1 node's tiles' plate masses). */
function joinMasses(list: readonly (CellMass | null)[]): CellMass | null {
  let vertices = 0, indices = 0, error = 0, top = -Infinity;
  const some = list.filter((c): c is CellMass => c !== null);
  for (const c of some) { vertices += c.position.length / 3; indices += c.index.length; error = Math.max(error, c.error); top = Math.max(top, c.top); }
  if (indices === 0) return null;
  const position = new Float32Array(vertices * 3), normal = new Int8Array(vertices * 4), color = new Float32Array(vertices * 3);
  const facade = new Float32Array(vertices * 4), glazing = new Float32Array(vertices * 2), index = indexArray(vertices, indices);
  let v = 0, n = 0;
  for (const c of some) {
    position.set(c.position, v * 3);
    normal.set(c.normal, v * 4);
    color.set(c.color, v * 3);
    facade.set(c.facade, v * 4);
    glazing.set(c.glazing, v * 2);
    for (let i = 0; i < c.index.length; i++) index[n + i] = c.index[i]! + v;
    v += c.position.length / 3;
    n += c.index.length;
  }
  return { position, normal, color, facade, glazing, index, bounds: shellBounds(position), top, error };
}


/** A TILE'S FAR LEVEL KEPT WHERE THE TILE WAS JUST MADE (`cityTile.worker.ts`): its buildings as grown, baked and kept under the key and version the page's job for it asks (`runFarJob` level 0), so no worker reads the tile back and grows its buildings again to bake it */
export async function keepTileFar(records: TileRecords, version: number, env: FarGroundEnv, prefix: string | null, cache: FarCache = derivedFarCache): Promise<boolean> {
  if (prefix === null || !(await cache.ready())) return false;
  const { i, j } = tileOfKey(records.key);
  await cache.put(`${prefix}${farKey(0, i, j)}`, bakeTile(tileBuildings(records), String(version), readsOf(env), env.tone));
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
    let entry = keeps ? await kept<TileEntry>(node, sig) : undefined;
    if (!entry) {
      // The rows the page posted (migrated where their table was written), or the stored part read here and migrated.
      const stored = job.buildings ? undefined : await readStored(job.store, tileKey(i, j), 'buildings');
      const buildings = job.buildings ? rowsBuildings(job.buildings) : stored ? tileBuildings(stored) : null;
      if (!buildings) return { kind: 'farRecords', node, sig };
      entry = bakeTile(buildings, sig, readsOf(job), job.tone);
      if (keeps) await cache.put(`${prefix}${node}`, entry);
    }
    return { kind: 'far', node, sig, mass: job.want ? entry.tile : null };
  }
  if (!keeps) return { kind: 'farNoCache', node, sig };
  let entry = await kept<NodeEntry>(node, sig);
  // DO NOT read its four tiles' entries whole whenever a level-1 node is drawn (their tile masses read with the plates, merged again each time): its tiles' plate masses are kept merged under a key of their own (`MASS_KEY`), apart from the boxes its parent reads.
  if (k === 1 && job.want) {
    const merged = await kept<{ readonly sig: string; readonly mass: CellMass | null }>(`${node}${MASS_KEY}`, sig);
    if (merged) return { kind: 'far', node, sig, mass: merged.mass };
  } else if (entry) return { kind: 'far', node, sig, mass: job.want ? entry.mass : null };
  const children = job.children ?? [];
  const got = await Promise.all(children.map((c) => (c ? kept<TileEntry | NodeEntry>(c.key, c.sig) : Promise.resolve(null))));
  const missing: string[] = [];
  children.forEach((c, n) => { if (c && !got[n]) missing.push(c.key); });
  if (missing.length) return { kind: 'farChildren', node, sig, missing };
  const lists = children.flatMap((_, n) => { const b = got[n]?.boxes; return b ? [b] : []; });
  if (k === 1) {
    const tiles = got.filter((e): e is TileEntry => !!e);
    if (!entry) {
      entry = { sig, mass: null, boxes: joined(lists) };
      await cache.put(`${prefix}${node}`, entry);
    }
    if (!job.want) return { kind: 'far', node, sig, mass: null };
    const mass = joinMasses(tiles.map((e) => e.plate));
    await cache.put(`${prefix}${node}${MASS_KEY}`, { sig, mass });
    return { kind: 'far', node, sig, mass };
  }
  const boxes = aggregateBoxes(joined(lists), k, i, j);
  entry = { sig, mass: boxMass(boxes, levelDrop(k)), boxes };
  await cache.put(`${prefix}${node}`, entry);
  return { kind: 'far', node, sig, mass: job.want ? entry.mass : null };
}
