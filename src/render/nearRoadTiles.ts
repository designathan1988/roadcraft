import { Digest } from '@core/digest';
import { RoadDoc, type TileRecords } from '@world/doc';
import { buildRoadElevation } from '@world/elevation';
import { migrateBuilding } from '@world/buildings/serialize';
import type { Building } from '@world/buildings/types';
import { tileBuildingsOf } from '@world/growth/grownRows';
import { Network } from '@world/network';
import { gatesNear, gatesOf } from '@world/parkingLayout';
import { isMarkingStyle } from '@world/roads/markingStyle';
import { roadStructure } from '@world/structures';
import { TILE as WORLD_TILE, tileOfKey } from '@world/tiles';
import { METERS_PER_UNIT, m } from '@world/units';
import { emptyRecords, readStored } from './buildings/farGrid';
import type { Tile } from './mesh/tileMesh';
import { SurfaceInputs, TILE, TILE_BIAS, TILE_ORIGIN } from './roadSurfaceInputs';
import { type PassLook, passDesc, passRaised, passReads, tileBundle } from './roadSurfacePass';
import { passSurfaces } from './roadSurfaceReads';
import type { TileSource } from './roadTileShape';
import { type SharedGroundData, sharedGroundReaders } from './sharedGround';

/** THE ROADS NEAR THE CAMERA, BAKED PER TILE IN A WORKER FROM THE TILE STORE (CLAUDE.md "Streaming world"): every surface the page's region draws (`roadSurfaces.ts`), made by the same code from the tile's roads and its neighbours' (`roadSurfacePass.ts`), kept by the versions of the tiles it read */
/** Drawn by the roads' tree in place of a tile's far level where the view wants its detail (`farTree.ts` near level) and the page's document does not draw the tile's near roads (not in the region, or not built yet). A surface's tile of 76.8 m belongs to the 1 km tile its centre lies in, as the region's own (`renderer.ts` `within`): side by side the two never draw a piece twice nor leave one out. */

/** How far round a tile its neighbours' roads are read: a junction on its edge whole, the heights solved past it (`elevation.ts`: 36 m of smoothing, 28 m of tie), the footways' edges the verge reads (`roadSurfaceReads.ts`), a street's parking along it. */
const FRINGE = m(200);
/** How far past the tile a neighbour's gates are read without their record: a street of the tile reads the gates within its half width and 8 m (`parkingLayout.ts` `frontagesOn`). */
const GATE_REACH = m(60);

/** Where near bakes are kept (`farRoadTiles.ts` FarRoadCache: the browser's store in the workers, a map in tests). */
export interface NearRoadCache {
  ready(): Promise<boolean>;
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

/** A tile's roads and its buildings' gates, as the store keeps them (its `roads` part). */
export type NearTileRoads = Pick<TileRecords, 'key' | 'nodes' | 'borrowedNodes' | 'segments' | 'gates'>;

/** The key of a tile's near roads in the tree: below its level 0 (`farKey`). */
export const nearKey = (i: number, j: number): string => `n0:${i},${j}`;

/** One surface of a pass across the tile, its 76.8 m tiles merged in their order: what the page draws as one mesh, with the material its source and pass say (`roadSurfaces.ts` `surfaceLook`). */
export interface NearRoadSurface {
  readonly pass: string;
  readonly name: string;
  readonly source: TileSource;
  readonly raised: boolean;
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
  /** Its tint and its place in the road's section where one of its tiles had them (white, and none, where another had not, `surfaceTiles.ts` tileArrays). */
  readonly color: Float32Array | null;
  readonly section: Float32Array | null;
  readonly index: Uint16Array | Uint32Array;
  /** Its box, [minX, minY, minZ, maxX, maxY, maxZ] in three's axes. */
  readonly box: Float32Array;
}

/** A tile's near roads: every surface, the plan box and heights of them all (x0, y0, x1, y1, lowest, highest), their triangles. */
export interface NearRoadMesh {
  readonly near: true;
  readonly surfaces: readonly NearRoadSurface[];
  readonly bounds: Float64Array;
  readonly triangles: number;
}

/** What a near bake reads besides the roads: the page's constants of the roads' look and paint, and the ground. */
export interface NearRoadAsk {
  readonly look: PassLook;
  readonly markingStyle: string;
  readonly ground: SharedGroundData | null;
  readonly naturalIsGround: boolean;
  /** The tile and its neighbours stored, each at its version (the tile first): what the bake reads and is kept by (`nearSig`). */
  readonly tiles: readonly { readonly key: number; readonly version: number }[];
  /** The tiles' roads the page read (no worker reads the store), in the order of `tiles`; none: read here. */
  readonly records?: readonly NearTileRoads[];
}

/** The version of what a near bake reads: its tile's and its neighbours'. */
export function nearSig(tiles: readonly { readonly key: number; readonly version: number }[]): string {
  const d = new Digest();
  for (const t of tiles) d.add(t.key).add(t.version);
  return d.value().toString(36);
}

/** The square of the tile of `key` in the plan. */
function squareOf(key: number): { x0: number; y0: number; x1: number; y1: number } {
  const { i, j } = tileOfKey(key);
  return { x0: i * WORLD_TILE, y0: j * WORLD_TILE, x1: (i + 1) * WORLD_TILE, y1: (j + 1) * WORLD_TILE };
}

type NodeRecord = TileRecords['nodes'][number];
type SegmentRecord = TileRecords['segments'][number];

/** A node of the last ring of roads read (`nearRoadDoc`): its place and height only, its rules for roads not read here left out (`wholeMapTile.ts` borrowed nodes). */
const bareNode = (n: NodeRecord): NodeRecord => ({
  id: n.id, x: n.x, y: n.y, ...(n.heightOffset !== undefined ? { heightOffset: n.heightOffset } : {}), ...(n.smooth !== undefined ? { smooth: n.smooth } : {}),
});

/** THE ROADS A TILE'S NEAR BAKE READS, AS ONE DOCUMENT: the tile's own, its neighbours' that reach within `FRINGE` of it, and every road meeting an end of those - each end then has the degree, the crossing and the rules it has in the region's document (a street's parking is centred between its two ends' clearances, `parkingLayout.ts`, so its far end moves its bays near the tile too); the ends of that last ring are bare */
export function nearRoadDoc(tile: NearTileRoads, around: readonly NearTileRoads[], markingStyle: string): RoadDoc {
  const { x0, y0, x1, y1 } = squareOf(tile.key);
  const rx0 = x0 - FRINGE, ry0 = y0 - FRINGE, rx1 = x1 + FRINGE, ry1 = y1 + FRINGE;
  const owned = new Map<number, NodeRecord>();
  const borrowed = new Map<number, NodeRecord>();
  for (const t of [tile, ...around]) for (const n of t.nodes) owned.set(n.id, n);
  for (const t of [tile, ...around]) for (const n of t.borrowedNodes) if (!owned.has(n.id) && !borrowed.has(n.id)) borrowed.set(n.id, n);
  const nodeOf = (id: number): NodeRecord | undefined => owned.get(id) ?? borrowed.get(id);
  const reaching: SegmentRecord[] = [...tile.segments];
  const others: SegmentRecord[] = [];
  for (const t of around) {
    for (const s of t.segments) {
      const a = nodeOf(s.a), b = nodeOf(s.b);
      if (!a || !b) continue;
      // Its ends' box grown by its bend: a curved road bows into the fringe between two ends outside it.
      const bow = Math.abs(s.curve?.h ?? 0);
      if (Math.max(a.x, b.x) + bow < rx0 || Math.min(a.x, b.x) - bow > rx1 || Math.max(a.y, b.y) + bow < ry0 || Math.min(a.y, b.y) - bow > ry1) others.push(s);
      else reaching.push(s);
    }
  }
  const ends = new Set<number>(tile.nodes.map((n) => n.id));
  for (const s of reaching) { ends.add(s.a); ends.add(s.b); }
  const meeting = others.filter((s) => ends.has(s.a) || ends.has(s.b));
  const nodes: NodeRecord[] = [];
  const seen = new Set<number>();
  const put = (id: number, whole: boolean): void => {
    if (seen.has(id)) return;
    const record = nodeOf(id);
    if (!record) return;
    seen.add(id);
    nodes.push(whole ? record : bareNode(record));
  };
  for (const id of ends) put(id, true);
  for (const s of meeting) { put(s.a, false); put(s.b, false); }
  const doc = RoadDoc.fromJSON({ version: 1, unit: METERS_PER_UNIT, nodes, segments: [...reaching, ...meeting] }, { repair: false });
  if (isMarkingStyle(markingStyle)) doc.markingStyle = markingStyle;
  return doc;
}

/** The gates a tile's streets may read: its own and its neighbours' within reach of it, four numbers each. */
function gatesFor(tile: NearTileRoads, around: readonly NearTileRoads[]): number[] {
  const { x0, y0, x1, y1 } = squareOf(tile.key);
  const out: number[] = [...(tile.gates ?? [])];
  for (const t of around) {
    const g = t.gates ?? [];
    for (let k = 0; k + 3 < g.length; k += 4) {
      if (Math.max(g[k]!, g[k + 2]!) < x0 - FRINGE - GATE_REACH || Math.min(g[k]!, g[k + 2]!) > x1 + FRINGE + GATE_REACH) continue;
      if (Math.max(g[k + 1]!, g[k + 3]!) < y0 - FRINGE - GATE_REACH || Math.min(g[k + 1]!, g[k + 3]!) > y1 + FRINGE + GATE_REACH) continue;
      out.push(g[k]!, g[k + 1]!, g[k + 2]!, g[k + 3]!);
    }
  }
  return out;
}

/** A surface's tiles end to end, the indices shifted, its tint and section where one tile had them (`surfaceTiles.ts` tileArrays, all of them). */
function mergeSurface(tiles: readonly Tile[]): Omit<NearRoadSurface, 'pass' | 'name' | 'source' | 'raised'> {
  let vertices = 0, count = 0;
  let tinted = false, sectioned = false;
  for (const t of tiles) {
    vertices += t.positions.length / 3;
    count += t.indices.length;
    if (t.colors.length) tinted = true;
    if (t.sections.length) sectioned = true;
  }
  const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3), uv = new Float32Array(vertices * 2);
  const color = tinted ? new Float32Array(vertices * 3) : null;
  const section = sectioned ? new Float32Array(vertices * 3) : null;
  const index = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
  const box = Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
  let v = 0, k = 0;
  for (const t of tiles) {
    const n = t.positions.length / 3;
    position.set(t.positions, v * 3);
    normal.set(t.normals, v * 3);
    uv.set(t.uvs, v * 2);
    if (color) { if (t.colors.length) color.set(t.colors, v * 3); else color.fill(1, v * 3, (v + n) * 3); }
    if (section) {
      if (t.sections.length) section.set(t.sections, v * 3);
      else for (let p = v; p < v + n; p++) { section[p * 3] = 0; section[p * 3 + 1] = -1; section[p * 3 + 2] = 0; }
    }
    for (let p = 0; p < t.indices.length; p++) index[k++] = t.indices[p]! + v;
    const b = t.box;
    if (b && b[0]! <= b[3]!) for (let c = 0; c < 3; c++) { box[c] = Math.min(box[c]!, b[c]!); box[c + 3] = Math.max(box[c + 3]!, b[c + 3]!); }
    v += n;
  }
  return { position, normal, uv, color, section, index, box };
}

/** A TILE'S NEAR ROADS FROM ITS ROADS AND ITS NEIGHBOURS' (`nearRoadDoc`): solved, put together and meshed as the page's region does it (`roadSurfaceSteps`), each surface of each pass merged across the tile; null with no road surface in it */
export function bakeNearRoads(tile: NearTileRoads, around: readonly NearTileRoads[], ask: Pick<NearRoadAsk, 'look' | 'markingStyle' | 'ground' | 'naturalIsGround'>): NearRoadMesh | null {
  const doc = nearRoadDoc(tile, around, ask.markingStyle);
  if (doc.segments.size === 0) return null;
  const shared = ask.ground ? sharedGroundReaders(ask.ground) : null;
  const groundAt = shared ? shared.groundAt : (): number => 0;
  const naturalAt = shared ? (ask.naturalIsGround ? shared.groundAt : shared.naturalAt) : groundAt;
  const net = new Network(doc);
  net.rebuild();
  // As the page solves it: on the ground before the roads cut it (`renderer.ts` `builtGroundAt`).
  const elevation = buildRoadElevation(net, naturalAt);
  const gates = gatesFor(tile, around);
  const inputs = new SurfaceInputs((line, half) => gatesNear(gates, line, half));
  inputs.refresh(net);
  const paint = inputs.paintColours();
  const { x0, y0, x1, y1 } = squareOf(tile.key);
  const reading = <T>(work: () => T): T => (elevation.remembering ? elevation.remembering(work) : work());
  const surfaces: NearRoadSurface[] = [];
  let triangles = 0;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, h0 = Infinity, h1 = -Infinity;
  for (const pass of inputs.passList()) {
    const structure = roadStructure(pass.structure);
    if (pass.chain === undefined && !inputs.present(structure.id)) continue;
    const raised = passRaised(net, pass, elevation, groundAt);
    const reads = passReads(net, elevation, groundAt, inputs, pass.id);
    net.crossingSurface();
    const specs = passSurfaces(passDesc(net, pass, raised, ask.look, paint), reads);
    const tiles = new Map<string, Tile[]>(specs.map((spec) => [spec.options.name, []]));
    for (const key of inputs.tileKeys(pass.id)) {
      const ix = Math.floor(key / 0x1_0000) - TILE_BIAS;
      const iy = (key % 0x1_0000) - TILE_BIAS;
      const rect = [ix * TILE + TILE_ORIGIN, iy * TILE + TILE_ORIGIN, (ix + 1) * TILE + TILE_ORIGIN, (iy + 1) * TILE + TILE_ORIGIN] as const;
      // A surface tile is this tile's when its centre lies in it (the region's `within`).
      const cx = (rect[0] + rect[2]) / 2, cy = (rect[1] + rect[3]) / 2;
      if (cx < x0 || cx >= x1 || cy < y0 || cy >= y1) continue;
      const { reach } = inputs.reachOf(pass.id, key);
      const bundle = reading(() => tileBundle(reach, rect, specs));
      for (const [name, made] of bundle) tiles.get(name)!.push(made);
    }
    for (const spec of specs) {
      const list = tiles.get(spec.options.name)!;
      if (!list.length) continue;
      const merged = mergeSurface(list);
      if (merged.index.length === 0) continue;
      triangles += merged.index.length / 3;
      const b = merged.box;
      bx0 = Math.min(bx0, b[0]!); bx1 = Math.max(bx1, b[3]!);
      by0 = Math.min(by0, -b[5]!); by1 = Math.max(by1, -b[2]!);
      h0 = Math.min(h0, b[1]!); h1 = Math.max(h1, b[4]!);
      surfaces.push({ pass: pass.id, name: spec.options.name, source: spec.source, raised, ...merged });
    }
  }
  if (!surfaces.length) return null;
  return { near: true, surfaces, bounds: Float64Array.of(bx0, by0, bx1, by1, h0, h1), triangles };
}

/** Every buffer of a near mesh: handed over, not copied (MDN, `postMessage` transfer). */
export function nearRoadBuffers(mesh: NearRoadMesh): ArrayBuffer[] {
  const out: ArrayBuffer[] = [mesh.bounds.buffer as ArrayBuffer];
  for (const s of mesh.surfaces) {
    for (const a of [s.position, s.normal, s.uv, s.color, s.section, s.index, s.box]) if (a) out.push(a.buffer as ArrayBuffer);
  }
  return out;
}

/** A stored tile's gates where it was written without them (before they were kept): its buildings made again here and read (`gatesOf`), kept by its version. */
async function storedGates(store: string, key: number, version: number, prefix: string | null, cache: NearRoadCache, keeps: boolean): Promise<number[]> {
  const kept = keeps ? await cache.get(`${prefix}g:${key}`) as { sig: number; gates: number[] } | undefined : undefined;
  if (kept && kept.sig === version) return kept.gates;
  const records = await readStored(store, key, 'buildings');
  const buildings: Building[] = [];
  for (const raw of records ? tileBuildingsOf(records) : []) {
    const b = migrateBuilding(raw);
    if (b) buildings.push(b);
  }
  const gates = gatesOf(buildings);
  if (keeps) await cache.put(`${prefix}g:${key}`, { sig: version, gates });
  return gates;
}

/** The roads (and gates) of the tiles a near bake reads, from the page's records or the store; null where neither can be read here (the page reads them). */
async function nearTilesOf(ask: NearRoadAsk, store: string | undefined, prefix: string | null, cache: NearRoadCache, keeps: boolean): Promise<NearTileRoads[] | null> {
  if (ask.records) return [...ask.records];
  const out: NearTileRoads[] = [];
  for (const { key, version } of ask.tiles) {
    const read = await readStored(store, key, 'roads');
    if (!read) return null;
    // A tile with roads and no gates kept was written before they were: its buildings read for them, once a version.
    const gates = read.gates ?? (read.segments.length && store !== undefined ? await storedGates(store, key, version, prefix, cache, keeps) : []);
    out.push({ key, nodes: read.nodes, borrowedNodes: read.borrowedNodes, segments: read.segments, gates });
  }
  return out;
}

/** What a near job answers: its mesh (when wanted), the tiles' records asked of the page, or why it could not be baked. */
export type NearRoadReply =
  | { readonly kind: 'far'; readonly node: string; readonly sig: string; readonly payload: NearRoadMesh | null }
  | { readonly kind: 'farRecords'; readonly node: string; readonly sig: string }
  | { readonly kind: 'farError'; readonly node: string; readonly sig: string; readonly message: string };

/** DO NOT bake what is kept: a tile's near roads are baked once per version of the tiles they read (`nearSig`), from the store's roads or the page's records */
export async function runNearRoadJob(job: { readonly node: string; readonly sig: string; readonly want: boolean; readonly prefix: string | null; readonly store?: string; readonly near: NearRoadAsk }, cache: NearRoadCache): Promise<NearRoadReply> {
  const { node, sig, prefix, near } = job;
  const keeps = prefix !== null && await cache.ready();
  type Entry = { readonly sig: string; readonly mesh: NearRoadMesh | null };
  let entry = keeps ? await cache.get(`${prefix}${node}`) as Entry | undefined : undefined;
  if (entry?.sig !== sig) entry = undefined;
  if (!entry) {
    const tiles = await nearTilesOf(near, job.store, prefix, cache, keeps);
    if (!tiles || tiles.length === 0) return { kind: 'farRecords', node, sig };
    const [tile, ...around] = tiles as [NearTileRoads, ...NearTileRoads[]];
    entry = { sig, mesh: bakeNearRoads(tile, around, near) };
    if (keeps) await cache.put(`${prefix}${node}`, entry);
  }
  return { kind: 'far', node, sig, payload: job.want ? entry.mesh : null };
}

/** A tile with nothing stored under it, as a near bake reads one (a neighbour the store has none of). */
export const noRoads = (key: number): NearTileRoads => {
  const { nodes, borrowedNodes, segments } = emptyRecords(key, 0);
  return { key, nodes, borrowedNodes, segments, gates: [] };
};
