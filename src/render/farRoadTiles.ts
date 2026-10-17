import { MeshoptSimplifier } from 'meshoptimizer';
import { type MultiPoly, difference, union } from '@core/clipper';
import { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { Network, type SegmentRibbon } from '@world/network';
import { FOOTWAY_RISE, Level, ROAD_TYPES } from '@world/roadTypes';
import { levelRingsOf } from '@world/surfaces';
import { TILE, tileKey, tileOfKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { METERS_PER_UNIT, m } from '@world/units';
import { derivedCacheOpen, keepDerivedDurably, readDerived } from './derivedCache';
import { surfaceShape } from './mesh/tileShape';
import { farKey, readStored } from './buildings/farGrid';
import { medianOf } from './roadSurfaceRings';
import { ASPHALT_REFERENCE, CARRIAGEWAY_COLOUR, FOOTWAY_TINT } from './roadTones';
import { type SharedGroundData, sharedGroundReaders } from './sharedGround';
import { type NearRoadMesh, type NearRoadWant, nearRoadBuffers, runNearRoadJob } from './nearRoadTiles';

/** THE ROADS FAR FROM THE CAMERA, BAKED PER TILE IN WORKERS FROM THE TILE STORE (CLAUDE.md "Streaming world"): nothing of their records on the page */
/** A tile's roads built alone (its segments and borrowed ends, as `editor/wholeMapTile.ts` builds a tile), drawn flat on the ground as one mesh: carriageways, kerbs, footways and medians, each the colour its near material reads from afar */
/** Above the tiles, a quadtree (`farTree.ts`): each node its quarters' meshes merged and simplified to its level's error (meshoptimizer, as `mesh/roadLodPure.ts`) */

/** A far road mesh: compact vertices (CLAUDE.md "Cidade": int16 position per tile, RGBA8 colour) */
export interface FarRoadMesh {
  /** Plan x and y from the origin, times `q` (int16; three's z is -y). */
  readonly xz: Int16Array;
  /** Height of each vertex, m. */
  readonly height: Float32Array;
  /** Its normal in three's axes (x, up, -y), signed bytes; the fourth unused. */
  readonly normal: Int8Array;
  /** Its colour, sRGB bytes (the shader makes it linear), opaque. */
  readonly color: Uint8Array;
  readonly index: Uint16Array | Uint32Array;
  /** The origin on the plan, and the steps a metre the plan is told in. */
  readonly ox: number;
  readonly oy: number;
  readonly q: number;
  /** Plan box and heights: x0, y0, x1, y1, lowest, highest. */
  readonly bounds: Float64Array;
  /** What it leaves out of the roads, m. */
  readonly error: number;
}

/** The finest steps a metre a mesh is told in: 1.6 cm (a mesh wider than int16 at that step takes coarser ones). */
const Q_MOST = 64;
/** Edges of the ground's triangles before simplification, m: the roads follow the ground's corners at this spacing. */
const MAX_EDGE = m(24);
/** Lift over the ground: the carriageway a hair over the land, footways, kerbs and islands their kerb's rise. */
const CARRIAGEWAY_LIFT = m(0.05);
const RAISED_LIFT = FOOTWAY_RISE;
/** What a tile's mesh leaves out of its roads, m; a level above leaves out twice its children's (`farLevelError`). */
const TILE_ERROR = m(0.25);
const LEVEL_ERROR = m(0.5);

/** What a node of level `k` leaves out of the roads, m. */
export const farLevelError = (k: number): number => (k === 0 ? TILE_ERROR : LEVEL_ERROR * 2 ** k);

// ---- the colours from afar: each near material's texture's mean, times the tint it is drawn with

/** sRGB to linear and back (IEC 61966-2-1, as three's `SRGBToLinear`). */
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hexLinear = (hex: number): [number, number, number] => [toLinear(((hex >> 16) & 255) / 255), toLinear(((hex >> 8) & 255) / 255), toLinear((hex & 255) / 255)];

/** THE MEAN LINEAR ALBEDO OF EACH BAKED STREET TEXTURE (`bake/roadRecipes.ts`), every texel as stored (sRGB bytes) and read (linear). DO NOT work them out in every worker from the recipes (four textures shaded a texel in seven, again per worker of the far roads, plan R12): constants, held to the recipes by `tests/render/farRoads.spec.ts` (a recipe changed fails it, with the new values). */
export const STREET_MEANS: Readonly<Record<'asphalt' | 'footway' | 'kerb' | 'verge', readonly [number, number, number]>> = {
  asphalt: [0.040666, 0.041456, 0.044698],
  footway: [0.210044, 0.208119, 0.195658],
  kerb: [0.338651, 0.331236, 0.316671],
  verge: [0.029413, 0.070144, 0.010057],
};

/** Each surface's colour from afar, linear. */
interface FarRoadTones {
  /** The carriageway by road class (`ROAD_TYPES`), and by what it is paved with. */
  readonly classes: readonly (readonly [number, number, number])[];
  readonly paving: Readonly<Record<string, readonly [number, number, number]>>;
  readonly kerb: readonly [number, number, number];
  readonly footway: Readonly<Record<string, readonly [number, number, number]>>;
  /** A median's planting (the verge's grass) and its paving. */
  readonly planting: readonly [number, number, number];
}

let tonesMade: FarRoadTones | null = null;

/** The near materials' means (`materials.ts`: the texture times the vertex tint, the close-up layer gone from afar, `detailLayer.ts`), made once a thread. */
export function farRoadTones(): FarRoadTones {
  if (tonesMade) return tonesMade;
  const { asphalt, footway, kerb, verge } = STREET_MEANS;
  const reference = hexLinear(ASPHALT_REFERENCE);
  // As `roadSurfaces.ts` `againstReference`: the class's colour over the reference, channel by channel, times the texture.
  const over = (hex: number): [number, number, number] => {
    const c = hexLinear(hex);
    return [asphalt[0] * c[0] / reference[0], asphalt[1] * c[1] / reference[1], asphalt[2] * c[2] / reference[2]];
  };
  const tinted = (t: readonly [number, number, number]): [number, number, number] => [footway[0] * t[0], footway[1] * t[1], footway[2] * t[2]];
  tonesMade = {
    classes: ROAD_TYPES.map((type) => over(Number.parseInt(type.color.slice(1), 16))),
    paving: Object.fromEntries(Object.entries(CARRIAGEWAY_COLOUR).map(([name, hex]) => [name, over(hex)])),
    kerb: [...kerb],
    footway: Object.fromEntries(Object.entries(FOOTWAY_TINT).map(([name, tint]) => [name, tinted(tint)])),
    planting: [...verge],
  };
  return tonesMade;
}

/** A linear colour as the mesh's sRGB bytes. */
const srgbBytes = (c: readonly [number, number, number]): [number, number, number] =>
  [Math.round(toSrgb(Math.min(1, c[0])) * 255), Math.round(toSrgb(Math.min(1, c[1])) * 255), Math.round(toSrgb(Math.min(1, c[2])) * 255)];

// ---- a tile's roads as one mesh

/** One surface of the tile, its rings before they are merged: drawn in `order` (a lower order covers a higher one where they overlap). */
interface Band {
  readonly order: number;
  readonly tone: readonly [number, number, number];
  readonly lift: number;
  readonly rings: MultiPoly;
}

/** A mesh being built: plan x, y, height, normal, sRGB colour per vertex; triangles counter-clockwise from above. */
class Builder {
  readonly x: number[] = [];
  readonly y: number[] = [];
  readonly h: number[] = [];
  readonly n: number[] = [];
  readonly c: number[] = [];
  readonly tris: number[] = [];

  get vertices(): number {
    return this.x.length;
  }
}

/** The ground's height and normal (three's axes) at a point: by its slope across 2 m either way. */
function groundNormal(groundAt: (x: number, y: number) => number, x: number, y: number, out: number[]): void {
  const d = m(2);
  const hx = (groundAt(x + d, y) - groundAt(x - d, y)) / (2 * d);
  const hy = (groundAt(x, y + d) - groundAt(x, y - d)) / (2 * d);
  // The surface (x, h, -y): its normal is (-dh/dx, 1, dh/dy).
  const len = Math.hypot(hx, 1, hy);
  out.push(-hx / len, 1 / len, hy / len);
}

/** A band's polygons triangulated (`mesh/tileShape.ts`, refined to `maxEdge`), its vertices shared within it. */
function emitBand(out: Builder, shape: MultiPoly, band: Band, groundAt: (x: number, y: number) => number, maxEdge = MAX_EDGE): void {
  if (!shape.length) return;
  const [r, g, b] = srgbBytes(band.tone);
  const welded = new Map<string, number>();
  for (const piece of surfaceShape(shape, maxEdge, false).pieces) {
    const at: number[] = [];
    for (let v = 0; v < piece.xy.length; v += 2) {
      const x = piece.xy[v]!, y = piece.xy[v + 1]!;
      const key = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
      let index = welded.get(key);
      if (index === undefined) {
        index = out.vertices;
        welded.set(key, index);
        out.x.push(x); out.y.push(y); out.h.push(groundAt(x, y) + band.lift);
        groundNormal(groundAt, x, y, out.n);
        out.c.push(r, g, b);
      }
      at.push(index);
    }
    for (let t = 0; t < piece.tris.length; t += 3) {
      const a = at[piece.tris[t]!]!, p = at[piece.tris[t + 1]!]!, q = at[piece.tris[t + 2]!]!;
      if (a === p || p === q || q === a) continue;
      // Counter-clockwise on the plan is facing up in three's axes (plan y is -z).
      const area = (out.x[p]! - out.x[a]!) * (out.y[q]! - out.y[a]!) - (out.y[p]! - out.y[a]!) * (out.x[q]! - out.x[a]!);
      if (area === 0) continue;
      if (area > 0) out.tris.push(a, p, q); else out.tris.push(a, q, p);
    }
  }
}

/** THE BANDS OF A TILE'S ROADS: each road's carriageway (its class's or its paving's tone), kerb, footway (its material's) and median; each junction the tile owns, its plate in its widest road's tone */
function tileBands(net: Network, owned: ReadonlySet<number>): Band[] {
  const tones = farRoadTones();
  const bands = new Map<string, { order: number; tone: readonly [number, number, number]; lift: number; rings: MultiPoly }>();
  const add = (key: string, order: number, tone: readonly [number, number, number], lift: number, rings: MultiPoly): void => {
    if (!rings.length) return;
    let band = bands.get(key);
    if (!band) bands.set(key, band = { order, tone, lift, rings: [] });
    for (const ring of rings) band.rings.push(ring);
  };
  const structureOf = (id: SegmentId): string => net.doc.segment(id)?.structure ?? 'ground';
  // A tunnel is under the ground: never seen from afar.
  const seen = (id: SegmentId): boolean => structureOf(id) !== 'tunnel';
  const carriageway = (ribbon: SegmentRibbon): { key: string; tone: readonly [number, number, number] } => {
    const paving = ribbon.road.materials?.carriageway;
    if (paving && paving !== 'asphalt') return { key: `c:${paving}`, tone: tones.paving[paving]! };
    const type = Math.min(Math.max(ribbon.typeIndex, 0), tones.classes.length - 1);
    return { key: `c:${type}`, tone: tones.classes[type]! };
  };
  for (const ribbon of net.ribbons.values()) {
    if (!seen(ribbon.id)) continue;
    const road = carriageway(ribbon);
    add(road.key, 2, road.tone, CARRIAGEWAY_LIFT, levelRingsOf(net, Level.Asphalt, [ribbon], []));
    add('k', 3, tones.kerb, RAISED_LIFT, levelRingsOf(net, Level.Curb, [ribbon], []));
    const left = ribbon.road.materials?.footwayLeft ?? 'pavers', right = ribbon.road.materials?.footwayRight ?? 'pavers';
    // One tone a road: its sides' material when they agree, the pavers when not.
    const footway = left === right ? left : 'pavers';
    add(`f:${footway}`, 4, tones.footway[footway]!, RAISED_LIFT, levelRingsOf(net, Level.Sidewalk, [ribbon], []));
    const median = medianOf(net, ribbon);
    if (median) {
      add(median.paved ? 'm:paved' : 'm:planting', 0, median.paved ? tones.footway['concrete']! : tones.planting, RAISED_LIFT, [median.inner]);
      add('mk', 1, tones.kerb, RAISED_LIFT, [median.kerb]);
    }
  }
  for (const [node, byLevel] of net.junctions) {
    // A junction on a borrowed end is its own tile's to draw.
    if (!owned.has(node)) continue;
    let widest: SegmentRibbon | null = null;
    for (const id of net.doc.node(node)?.incident ?? []) {
      const ribbon = net.ribbons.get(id);
      if (ribbon && seen(id) && (!widest || ribbon.road.width > widest.road.width)) widest = ribbon;
    }
    if (!widest) continue;
    const road = carriageway(widest);
    const entry: [NodeId, typeof byLevel][] = [[node, byLevel]];
    add(road.key, 2, road.tone, CARRIAGEWAY_LIFT, levelRingsOf(net, Level.Asphalt, [], entry, seen));
    // A taper where a road carries on at another width (`roadSurfaceInputs.ts` `placeNode`).
    const plate = byLevel.get(Level.Asphalt);
    if (net.transitions.has(node) && plate && !plate.ring.isEmpty) add(road.key, 2, road.tone, CARRIAGEWAY_LIFT, [[plate.ring.flatten().map((p) => [p.x, p.y])]]);
    add('k', 3, tones.kerb, RAISED_LIFT, levelRingsOf(net, Level.Curb, [], entry, seen));
    add('f:pavers', 4, tones.footway['pavers']!, RAISED_LIFT, levelRingsOf(net, Level.Sidewalk, [], entry, seen));
  }
  return [...bands.values()].sort((a, b) => a.order - b.order);
}

/** What a far road bake reads of a tile: its key, its nodes, the ends it borrows and its roads (the store's `roads` part, `tileReader.ts`). */
export type TileRoads = Pick<TileRecords, 'key' | 'nodes' | 'borrowedNodes' | 'segments'>;

/** DO NOT post a tile's records whole to a road bake (its buildings above all, which no road reads): its roads alone. */
export const tileRoads = (records: TileRoads): TileRoads =>
  ({ key: records.key, nodes: records.nodes, borrowedNodes: records.borrowedNodes, segments: records.segments });

/** The tile's roads built alone: its segments and the ends it borrows, as the page's document would load it (`RoadDoc.loadTile`), with no neighbour. */
export function tileNetwork(records: TileRoads): Network {
  const owned = new Set(records.nodes.map((n) => n.id));
  const doc = RoadDoc.fromJSON({
    version: 1, unit: METERS_PER_UNIT,
    nodes: [...records.nodes, ...records.borrowedNodes.filter((n) => !owned.has(n.id))],
    segments: records.segments,
  }, { repair: false });
  const net = new Network(doc);
  net.rebuild();
  return net;
}

const FLAT = (): number => 0;

/** A TILE'S ROADS FROM ITS RECORDS ALONE, as one mesh simplified to a tile's error; null with no road seen */
export function bakeTileRoads(records: TileRoads, groundAt: (x: number, y: number) => number = FLAT): FarRoadMesh | null {
  if (records.segments.length === 0) return null;
  const net = tileNetwork(records);
  const out = new Builder();
  // Each band where none before it lies (the carriageway over the kerb over the footway, as `world/surfaces.ts` `bands` cuts them).
  let covered: MultiPoly = [];
  for (const band of tileBands(net, new Set(records.nodes.map((n) => n.id)))) {
    const own = union(band.rings);
    emitBand(out, covered.length ? difference(own, covered) : own, band, groundAt);
    covered = union(covered, own);
  }
  const { i, j } = tileOfKey(records.key);
  return finish(out, (i + 0.5) * TILE, (j + 0.5) * TILE, TILE_ERROR);
}

/** Several meshes as one, simplified to `error`, about the origin (`ox`, `oy`); null when nothing is left. */
function mergeRoads(parts: readonly (FarRoadMesh | null)[], ox: number, oy: number, error: number): FarRoadMesh | null {
  const out = new Builder();
  for (const part of parts) {
    if (!part) continue;
    const base = out.vertices;
    const count = part.height.length;
    for (let v = 0; v < count; v++) {
      out.x.push(part.ox + part.xz[v * 2]! / part.q);
      out.y.push(part.oy + part.xz[v * 2 + 1]! / part.q);
      out.h.push(part.height[v]!);
      out.n.push(part.normal[v * 4]! / 127, part.normal[v * 4 + 1]! / 127, part.normal[v * 4 + 2]! / 127);
      out.c.push(part.color[v * 4]!, part.color[v * 4 + 1]!, part.color[v * 4 + 2]!);
    }
    for (let t = 0; t < part.index.length; t++) out.tris.push(base + part.index[t]!);
  }
  return finish(out, ox, oy, error);
}

/** DO NOT draw a level whole: simplified to its error (meshoptimizer `simplify`, absolute error, tiny islands pruned, as `mesh/roadLodPure.ts`), its vertices compacted. */
function finish(out: Builder, ox: number, oy: number, error: number): FarRoadMesh | null {
  const count = out.vertices;
  if (out.tris.length === 0) return null;
  const position = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    position[v * 3] = out.x[v]! - ox; position[v * 3 + 1] = out.h[v]!; position[v * 3 + 2] = -(out.y[v]! - oy);
  }
  let kept: Uint32Array = Uint32Array.from(out.tris);
  if (MeshoptSimplifier.supported) {
    // A colour's edge is the border of its band (its own vertices): kept as a border, never collapsed across.
    [kept] = MeshoptSimplifier.simplify(kept, position, 3, 0, error, ['ErrorAbsolute', 'Prune']);
  }
  if (kept.length === 0) return null;
  const remap = new Int32Array(count).fill(-1);
  let used = 0;
  for (let t = 0; t < kept.length; t++) if (remap[kept[t]!]! < 0) remap[kept[t]!] = used++;
  let reach = 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, h0 = Infinity, h1 = -Infinity;
  for (let v = 0; v < count; v++) {
    if (remap[v]! < 0) continue;
    const x = out.x[v]!, y = out.y[v]!, h = out.h[v]!;
    reach = Math.max(reach, Math.abs(x - ox), Math.abs(y - oy));
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    h0 = Math.min(h0, h); h1 = Math.max(h1, h);
  }
  // As fine as int16 holds the farthest vertex.
  const q = Math.min(Q_MOST, 32_767 / reach);
  const xz = new Int16Array(used * 2), height = new Float32Array(used), normal = new Int8Array(used * 4), color = new Uint8Array(used * 4);
  for (let v = 0; v < count; v++) {
    const at = remap[v]!;
    if (at < 0) continue;
    xz[at * 2] = Math.round((out.x[v]! - ox) * q);
    xz[at * 2 + 1] = Math.round((out.y[v]! - oy) * q);
    height[at] = out.h[v]!;
    for (let k = 0; k < 3; k++) normal[at * 4 + k] = Math.round(Math.max(-1, Math.min(1, out.n[v * 3 + k]!)) * 127);
    for (let k = 0; k < 3; k++) color[at * 4 + k] = out.c[v * 3 + k]!;
    color[at * 4 + 3] = 255;
  }
  const index = used > 0xffff ? new Uint32Array(kept.length) : new Uint16Array(kept.length);
  for (let t = 0; t < kept.length; t++) index[t] = remap[kept[t]!]!;
  return { xz, height, normal, color, index, ox, oy, q, bounds: Float64Array.of(x0, y0, x1, y1, h0, h1), error };
}

/** Every buffer of a mesh: handed over, not copied (MDN, `postMessage` transfer). */
const farRoadBuffers = (mesh: FarRoadMesh): ArrayBuffer[] =>
  [mesh.xz, mesh.height, mesh.normal, mesh.color, mesh.index, mesh.bounds].map((a) => a.buffer as ArrayBuffer);

// ---- the jobs: a node's mesh from the cache, its tile's records or its children's bakes

/** Where bakes are kept by node (`derivedCache.ts` in the job workers; a map in tests). */
export interface FarRoadCache {
  ready(): Promise<boolean>;
  get(key: string): Promise<unknown>;
  /** Resolved once kept for good: a parent's job, maybe on another worker, reads it after. */
  put(key: string, value: unknown): Promise<void>;
}

/** The player's browser store, from the worker that bakes (IndexedDB is open to workers, MDN). */
export const derivedRoadCache: FarRoadCache = {
  ready: derivedCacheOpen,
  get: (key) => readDerived(key),
  put: async (key, value) => { await (await keepDerivedDurably(key, value)).committed; },
};


/** A far job (`farTree.ts` asks it, `farRoads.worker.ts` runs it) */
export interface FarRoadJob {
  /** The node's key, level, column and row (`buildings/farTiles.ts` `farKey`). */
  readonly node: string;
  readonly k: number;
  readonly i: number;
  readonly j: number;
  /** The version of the tiles under it: what it is kept under. */
  readonly sig: string;
  /** Its mesh wanted back (to be drawn), or only baked and kept (for a parent). */
  readonly want: boolean;
  /** The cache's prefix (this build's fingerprint of this code); null: nothing kept, no level past the tiles. */
  readonly prefix: string | null;
  /** Its four quarters (level 1 and up), null where no tile is. */
  readonly children?: readonly ({ readonly key: string; readonly sig: string } | null)[];
  /** Level 0, once the cache said it did not have it and no worker reads the store (the desktop's): the tile's roads the page read (`tileRoads`). */
  readonly records?: TileRoads;
  /** Level 0: the store's map this worker reads the tile from itself (`core/storedTiles.ts`), in place of `records`. */
  readonly store?: string;
  /** The ground shared with the workers (`sharedGround.ts`); none: flat at 0. */
  readonly ground?: SharedGroundData | null;
  /** A tile's near level (`nearRoadTiles.ts`): what it reads besides the roads; its node is the tile's under level 0. */
  readonly near?: NearRoadWant;
}

export type FarRoadReply =
  /** Baked and kept: its mesh when wanted (null: no road seen under it); a tile's near level's (`nearRoadTiles.ts`) for a near job. */
  | { readonly kind: 'far'; readonly node: string; readonly sig: string; readonly payload: FarRoadMesh | NearRoadMesh | null }
  /** A tile not kept at that version and no store this worker reads: its roads wanted from the page. */
  | { readonly kind: 'farRecords'; readonly node: string; readonly sig: string }
  /** Children not kept at their versions: baked first. */
  | { readonly kind: 'farChildren'; readonly node: string; readonly sig: string; readonly missing: readonly string[] }
  /** Nothing can be kept here: no level past the tiles. */
  | { readonly kind: 'farNoCache'; readonly node: string; readonly sig: string }
  | { readonly kind: 'farError'; readonly node: string; readonly sig: string; readonly message: string };

/** Every buffer of a reply. */
export const farRoadReplyBuffers = (reply: FarRoadReply): ArrayBuffer[] =>
  (reply.kind === 'far' && reply.payload ? ('near' in reply.payload ? nearRoadBuffers(reply.payload) : farRoadBuffers(reply.payload)) : []);

/** What a node keeps: the version of its tiles and its mesh. */
interface RoadEntry {
  readonly sig: string;
  readonly mesh: FarRoadMesh | null;
}

/** A TILE'S FAR ROADS KEPT WHERE THE TILE WAS JUST MADE (`cityTile.worker.ts`): baked from its stored roads and kept under the key and version the page's job for it asks (`runFarRoadJob` level 0), so no worker reads the tile back to bake them */
export async function keepTileFarRoads(records: TileRoads, version: number, ground: SharedGroundData | null, prefix: string | null, cache: FarRoadCache = derivedRoadCache): Promise<boolean> {
  if (prefix === null) return false;
  // DO NOT simplify before the simplifier's WebAssembly is made (meshoptimizer README, `MeshoptSimplifier.ready`).
  await MeshoptSimplifier.ready;
  if (!(await cache.ready())) return false;
  const { i, j } = tileOfKey(records.key);
  const entry: RoadEntry = { sig: String(version), mesh: bakeTileRoads(records, ground ? sharedGroundReaders(ground).groundAt : FLAT) };
  await cache.put(`${prefix}${farKey(0, i, j)}`, entry);
  return true;
}

/** DO NOT bake what is kept: a node is baked once per version of its tiles (kept under its key with that version), from its tile's records or its children's bakes, never from the page's document */
export async function runFarRoadJob(job: FarRoadJob, cache: FarRoadCache): Promise<FarRoadReply> {
  // A tile's near level: its own job, in the same service (the roads' code warm in the same workers).
  if (job.near) return runNearRoadJob({ ...job, near: job.near }, cache);
  const { node, sig, prefix, k, i, j } = job;
  // DO NOT simplify before the simplifier's WebAssembly is made (meshoptimizer README, `MeshoptSimplifier.ready`).
  await MeshoptSimplifier.ready;
  const keeps = prefix !== null && await cache.ready();
  const kept = async (key: string, version: string): Promise<RoadEntry | undefined> => {
    const entry = await cache.get(`${prefix}${key}`) as RoadEntry | undefined;
    return entry?.sig === version ? entry : undefined;
  };
  let entry = keeps ? await kept(node, sig) : undefined;
  const ground = job.ground ? sharedGroundReaders(job.ground).groundAt : FLAT;
  if (k === 0) {
    if (!entry) {
      const records = job.records ?? await readStored(job.store, tileKey(i, j), 'roads');
      if (!records) return { kind: 'farRecords', node, sig };
      entry = { sig, mesh: bakeTileRoads(records, ground) };
      if (keeps) await cache.put(`${prefix}${node}`, entry);
    }
    return { kind: 'far', node, sig, payload: job.want ? entry.mesh : null };
  }
  if (!keeps) return { kind: 'farNoCache', node, sig };
  if (!entry) {
    const children = job.children ?? [];
    const got = await Promise.all(children.map((c) => (!c ? Promise.resolve(null) : kept(c.key, c.sig))));
    const missing: string[] = [];
    children.forEach((c, n) => { if (c && !got[n]) missing.push(c.key); });
    if (missing.length) return { kind: 'farChildren', node, sig, missing };
    const side = TILE * 2 ** k;
    entry = { sig, mesh: mergeRoads(got.map((e) => e?.mesh ?? null), (i + 0.5) * side, (j + 0.5) * side, farLevelError(k)) };
    await cache.put(`${prefix}${node}`, entry);
  }
  return { kind: 'far', node, sig, payload: job.want ? entry.mesh : null };
}
