import { Digest } from '@core/digest';
import { RoadDoc, type TileRecords } from '@world/doc';
import { SURFACE_READ_REACH, buildRoadElevation } from '@world/elevation';
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
import { coarseArrays } from './mesh/roadLodPure';
import type { Tile } from './mesh/tileMesh';
import { SurfaceInputs, TILE, TILE_BIAS, TILE_ORIGIN } from './roadSurfaceInputs';
import { type PassLook, passDesc, passRaised, passReads, tileBundle } from './roadSurfacePass';
import { passSurfaces } from './roadSurfaceReads';
import type { TileSource } from './roadTileShape';
import { type SharedGroundData, sharedGroundReaders } from './sharedGround';
import { TERRAIN_CELL } from './terrainGrid';

/** THE ROADS NEAR THE CAMERA, BAKED PER TILE IN A WORKER FROM THE TILE STORE (CLAUDE.md "Streaming world"): every surface the page's region draws (`roadSurfaces.ts`), made by the same code from the tile's roads and its neighbours' (`roadSurfacePass.ts`), kept by the versions of the tiles it read */
/** Drawn by the roads' tree in place of a tile's far level where the view wants its detail (`farTree.ts` near level). A surface's tile of 76.8 m belongs to the 1 km tile its centre lies in, as the region's own did (`renderer.ts` `within`): side by side two tiles never draw a piece twice nor leave one out. Made a block at a time: an edit makes and sends again the blocks it reached alone. */

/** How far round a tile its neighbours' roads are read: a junction on its edge whole, the heights solved past it (`elevation.ts`: 36 m of smoothing, 28 m of tie), the footways' edges the verge reads (`roadSurfaceReads.ts`), a street's parking along it. */
const FRINGE = m(200);
/** How far past the tile a neighbour's gates are read without their record: a street of the tile reads the gates within its half width and 8 m (`parkingLayout.ts` `frontagesOn`). */
const GATE_REACH = m(60);
/** Tiles a side of a block: the region's chunk (`roadSurfaces.ts` CHUNK). */
const CHUNK = 4;

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

/** A surface's arrays over a block, its 76.8 m tiles end to end in their order (`surfaceTiles.ts` tileArrays): its tint and its place in the road's section where one of its tiles had them (white, and none, where another had not). */
export interface NearArrays {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
  readonly color: Float32Array | null;
  readonly section: Float32Array | null;
  readonly index: Uint16Array | Uint32Array;
  /** Its box, [minX, minY, minZ, maxX, maxY, maxZ] in three's axes. */
  readonly box: Float32Array;
}

/** One surface of a pass over a block: what the page draws as one mesh, with the material its source and pass say (`roadSurfaces.ts` surfaceLook). */
export interface NearRoadSurface {
  readonly pass: string;
  readonly name: string;
  readonly source: TileSource;
  readonly raised: boolean;
  readonly arrays: NearArrays;
}

/** A tile's near roads at full detail, or simplified to the error of the region's far blocks (`roadLodPure.ts` COARSE_ERROR), its paint whole. */
export type NearVariant = 'full' | 'coarse';

/** ONE MESH OF A TILE'S NEAR ROADS: a surface over the whole tile, every block's of the same name and standing (raised or not: the same material, shadow and order, `roadSurfaces.ts` surfaceLook) end to end. DO NOT send a mesh a block and surface: ~200 meshes a dense tile, each walked by three's render and its three shadow cascades every frame, the move's long frames (2026-10-17); the plan's ~10 a tile (plan, step 2). */
export interface NearRoadDraw {
  /** Its name and standing (`drawKey`). */
  readonly key: string;
  /** What its blocks read (their digests, in order) and the level: a draw of the same digest is the same mesh. */
  readonly digest: number;
  readonly name: string;
  readonly source: TileSource;
  readonly raised: boolean;
  readonly arrays: NearArrays;
}

/** A tile's near roads at one level, as a job hands them: its draws (every one, or those changed since `base`, the version the page draws: the others it keeps), the draws it has now, its plan box and heights (x0, y0, x1, y1, lowest, highest), its triangles. */
export interface NearRoadMesh {
  readonly near: true;
  /** The version of what it read (`NearRoadWant.bake`). */
  readonly bake: string;
  readonly variant: NearVariant;
  readonly base: string | null;
  readonly draws: readonly NearRoadDraw[];
  readonly keys: readonly string[];
  readonly bounds: Float64Array;
  readonly triangles: number;
}

/** A draw's key: a surface's name and whether its pass is raised. */
const drawKey = (s: NearRoadSurface): string => `${s.name}|${s.raised ? 1 : 0}`;

/** A block as it is kept: both its levels (the simplified one sharing the arrays of a surface not worth simplifying, and of the paint). */
interface KeptBlock {
  readonly chunk: string;
  readonly digest: number;
  readonly lock: Float64Array;
  readonly full: readonly NearRoadSurface[];
  readonly coarse: readonly NearRoadSurface[];
}

/** A tile's near roads as they are kept, at the version of what they read (`nearSig`). */
export interface KeptNear {
  readonly sig: string;
  readonly blocks: readonly KeptBlock[];
  readonly bounds: Float64Array;
}

/** What a near bake reads besides the roads: the page's constants of the roads' look and paint, and the ground. */
export interface NearRoadAsk {
  readonly look: PassLook;
  readonly markingStyle: string;
  readonly ground: SharedGroundData | null;
  readonly naturalIsGround: boolean;
  /** The tile and its neighbours stored, each at its version (the tile first): what the bake reads and is kept by (`nearSig`). */
  readonly tiles: readonly { readonly key: number; readonly version: number }[];
  /** The tiles' roads the page holds (edited, not written yet; all of them where no worker reads the store), in the order of `tiles`, null for one read here; none: all read here. */
  readonly records?: readonly (NearTileRoads | null)[];
}

/** The version of what a near bake reads: its tile's and its neighbours'. */
export function nearSig(tiles: readonly { readonly key: number; readonly version: number | string }[]): string {
  const d = new Digest();
  for (const t of tiles) d.add(t.key).addText(String(t.version));
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
function mergeSurface(tiles: readonly Tile[]): NearArrays {
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

/** A surface simplified as the region's far blocks are (`roadLodPure.ts` coarseArrays: its block's edge kept, to the same error, its tint in the error); null where it is too small to gain. */
function coarseOf(arrays: NearArrays, lock: Float64Array): NearArrays | null {
  const made = coarseArrays({
    position: arrays.position, normal: arrays.normal, uv: arrays.uv, index: arrays.index,
    ...(arrays.color ? { color: arrays.color } : {}), ...(arrays.section ? { roadSection: arrays.section } : {}),
  }, [lock[0]!, lock[1]!, lock[2]!, lock[3]!]);
  if (!made) return null;
  const count = made.position.length / 3;
  const box = Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
  for (let v = 0; v < count; v++) for (let c = 0; c < 3; c++) { const x = made.position[v * 3 + c]!; box[c] = Math.min(box[c]!, x); box[c + 3] = Math.max(box[c + 3]!, x); }
  return { position: made.position, normal: made.normal, uv: made.uv, color: made.color ?? null, section: made.roadSection ?? null, index: made.index, box };
}

/** What a surface tile's ground is read at: every corner of the terrain's cells over it and a cell round it. */
function groundDigest(digest: Digest, groundAt: (x: number, y: number) => number, rect: readonly [number, number, number, number]): void {
  const cell = TERRAIN_CELL;
  for (let x = Math.floor(rect[0] / cell) - 1; x <= Math.ceil(rect[2] / cell) + 1; x++) {
    for (let y = Math.floor(rect[1] / cell) - 1; y <= Math.ceil(rect[3] / cell) + 1; y++) digest.add(groundAt(x * cell, y * cell));
  }
}

/** A TILE'S NEAR ROADS FROM ITS ROADS AND ITS NEIGHBOURS' (`nearRoadDoc`): solved, put together and meshed as the page's region does it (`roadSurfaceSteps`), a block at a time, each surface of each pass merged over the block, at full detail and simplified; a block whose surface tiles read what they read in `previous` (its digest) taken from it, not made again; null with no road surface in the tile */
export function bakeNearRoads(tile: NearTileRoads, around: readonly NearTileRoads[], ask: Pick<NearRoadAsk, 'look' | 'markingStyle' | 'ground' | 'naturalIsGround'>,
  sig = '', previous: Pick<KeptNear, 'blocks'> | null = null): KeptNear | null {
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
  /** Each pass as its surfaces are made, and each block's surface tiles, in pass and tile order. */
  type PassMake = { readonly id: string; readonly raised: boolean; readonly specs: ReturnType<typeof passSurfaces> };
  type BlockMake = { readonly digest: Digest; readonly tiles: { pass: PassMake; key: number; rect: readonly [number, number, number, number] }[]; readonly lock: number[] };
  const passes: PassMake[] = [];
  const blocks = new Map<string, BlockMake>();
  for (const pass of inputs.passList()) {
    const structure = roadStructure(pass.structure);
    if (pass.chain === undefined && !inputs.present(structure.id)) continue;
    const raised = passRaised(net, pass, elevation, groundAt);
    const reads = passReads(net, elevation, groundAt, inputs, pass.id);
    net.crossingSurface();
    const made: PassMake = { id: pass.id, raised, specs: passSurfaces(passDesc(net, pass, raised, ask.look, paint), reads) };
    passes.push(made);
    for (const key of inputs.tileKeys(pass.id)) {
      const ix = Math.floor(key / 0x1_0000) - TILE_BIAS;
      const iy = (key % 0x1_0000) - TILE_BIAS;
      const rect = [ix * TILE + TILE_ORIGIN, iy * TILE + TILE_ORIGIN, (ix + 1) * TILE + TILE_ORIGIN, (iy + 1) * TILE + TILE_ORIGIN] as const;
      // A surface tile is this tile's when its centre lies in it (the region's `within`).
      const cx = (rect[0] + rect[2]) / 2, cy = (rect[1] + rect[3]) / 2;
      if (cx < x0 || cx >= x1 || cy < y0 || cy >= y1) continue;
      const chunk = `${Math.floor(ix / CHUNK)},${Math.floor(iy / CHUNK)}`;
      let block = blocks.get(chunk);
      if (!block) blocks.set(chunk, block = { digest: new Digest(), tiles: [], lock: [Infinity, Infinity, -Infinity, -Infinity] });
      block.tiles.push({ pass: made, key, rect });
      block.lock[0] = Math.min(block.lock[0]!, rect[0]); block.lock[1] = Math.min(block.lock[1]!, rect[1]);
      block.lock[2] = Math.max(block.lock[2]!, rect[2]); block.lock[3] = Math.max(block.lock[3]!, rect[3]);
      // What the tile's surfaces read (the region's tile digest, `roadSurfaces.ts`): its rings and paint, the heights solved round it, the ground under it.
      const { digest: read, colours } = inputs.reachOf(pass.id, key);
      block.digest.addText(pass.id).add(raised ? 1 : 0).add(key).add(read).add(elevation.digest(rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1, SURFACE_READ_REACH));
      for (const colour of colours) block.digest.addText(colour);
      groundDigest(block.digest, groundAt, rect);
    }
  }
  const before = new Map((previous?.blocks ?? []).map((b) => [b.chunk, b]));
  const out: KeptBlock[] = [];
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, h0 = Infinity, h1 = -Infinity;
  for (const chunk of [...blocks.keys()].sort()) {
    const block = blocks.get(chunk)!;
    const digest = block.digest.value();
    const kept = before.get(chunk);
    const made = kept && kept.digest === digest ? kept : makeBlock(chunk, digest, block, passes, inputs, reading);
    if (!made) continue;
    out.push(made);
    for (const surface of made.full) {
      const b = surface.arrays.box;
      bx0 = Math.min(bx0, b[0]!); bx1 = Math.max(bx1, b[3]!);
      by0 = Math.min(by0, -b[5]!); by1 = Math.max(by1, -b[2]!);
      h0 = Math.min(h0, b[1]!); h1 = Math.max(h1, b[4]!);
    }
  }
  if (!out.length) return null;
  return { sig, blocks: out, bounds: Float64Array.of(bx0, by0, bx1, by1, h0, h1) };
}

/** One block's surfaces made: each pass's surface tiles of it meshed (`tileBundle`), merged by surface, and each simplified (the paint whole: its dashes are islands the simplifier would prune). */
function makeBlock(chunk: string, digest: number,
  block: { readonly tiles: readonly { pass: { readonly id: string; readonly raised: boolean; readonly specs: ReturnType<typeof passSurfaces> }; key: number; rect: readonly [number, number, number, number] }[]; readonly lock: readonly number[] },
  passes: readonly { readonly id: string; readonly raised: boolean; readonly specs: ReturnType<typeof passSurfaces> }[],
  inputs: SurfaceInputs, reading: <T>(work: () => T) => T): KeptBlock | null {
  const lock = Float64Array.from(block.lock);
  const full: NearRoadSurface[] = [], coarse: NearRoadSurface[] = [];
  for (const pass of passes) {
    const mine = block.tiles.filter((t) => t.pass === pass).sort((p, q) => p.key - q.key);
    if (!mine.length) continue;
    const lists = new Map<string, Tile[]>(pass.specs.map((spec) => [spec.options.name, []]));
    for (const t of mine) {
      const { reach } = inputs.reachOf(pass.id, t.key);
      for (const [name, made] of reading(() => tileBundle(reach, t.rect, pass.specs))) lists.get(name)!.push(made);
    }
    for (const spec of pass.specs) {
      const list = lists.get(spec.options.name)!;
      if (!list.length) continue;
      const arrays = mergeSurface(list);
      if (arrays.index.length === 0) continue;
      const surface: NearRoadSurface = { pass: pass.id, name: spec.options.name, source: spec.source, raised: pass.raised, arrays };
      full.push(surface);
      const simpler = spec.source.kind === 'paint' ? null : coarseOf(arrays, lock);
      coarse.push(simpler ? { ...surface, arrays: simpler } : surface);
    }
  }
  return full.length ? { chunk, digest, lock, full, coarse } : null;
}

/** Each draw of a kept bake at a level: its digest, and its surfaces block by block. */
function drawsOf(kept: Pick<KeptNear, 'blocks'>, variant: NearVariant): Map<string, { readonly digest: Digest; readonly surfaces: NearRoadSurface[] }> {
  const out = new Map<string, { readonly digest: Digest; readonly surfaces: NearRoadSurface[] }>();
  for (const b of kept.blocks) {
    for (const s of variant === 'full' ? b.full : b.coarse) {
      const key = drawKey(s);
      let draw = out.get(key);
      if (!draw) out.set(key, draw = { digest: new Digest().addText(variant), surfaces: [] });
      draw.digest.addText(b.chunk).add(b.digest);
      draw.surfaces.push(s);
    }
  }
  return out;
}

/** A kept bake as a job hands it: one level of its draws (those changed since `base`'s alone, where the page draws `base` at that level). */
export function nearMeshOf(kept: KeptNear, variant: NearVariant, base: KeptNear | null): NearRoadMesh {
  const was = new Map<string, number>();
  if (base) for (const [key, d] of drawsOf(base, variant)) was.set(key, d.digest.value());
  const draws: NearRoadDraw[] = [];
  let triangles = 0;
  const all = drawsOf(kept, variant);
  for (const [key, { digest, surfaces }] of all) {
    for (const s of surfaces) triangles += s.arrays.index.length / 3;
    const value = digest.value();
    if (base && was.get(key) === value) continue;
    const first = surfaces[0]!;
    draws.push({ key, digest: value, name: first.name, source: first.source, raised: first.raised, arrays: surfaces.length === 1 ? first.arrays : joinArrays(surfaces.map((s) => s.arrays)) });
  }
  return { near: true, bake: kept.sig, variant, base: base ? base.sig : null, draws, keys: [...all.keys()], bounds: kept.bounds, triangles };
}

/** Arrays end to end, the indices shifted, a tint and a section where one had them (white, and none, where another had not). */
function joinArrays(list: readonly NearArrays[]): NearArrays {
  let vertices = 0, count = 0, tinted = false, sectioned = false;
  for (const a of list) {
    vertices += a.position.length / 3;
    count += a.index.length;
    if (a.color) tinted = true;
    if (a.section) sectioned = true;
  }
  const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3), uv = new Float32Array(vertices * 2);
  const color = tinted ? new Float32Array(vertices * 3) : null;
  const section = sectioned ? new Float32Array(vertices * 3) : null;
  const index = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
  const box = Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
  let v = 0, k = 0;
  for (const a of list) {
    const n = a.position.length / 3;
    position.set(a.position, v * 3);
    normal.set(a.normal, v * 3);
    uv.set(a.uv, v * 2);
    if (color) { if (a.color) color.set(a.color, v * 3); else color.fill(1, v * 3, (v + n) * 3); }
    if (section) {
      if (a.section) section.set(a.section, v * 3);
      else for (let p = v; p < v + n; p++) { section[p * 3] = 0; section[p * 3 + 1] = -1; section[p * 3 + 2] = 0; }
    }
    for (let p = 0; p < a.index.length; p++) index[k++] = a.index[p]! + v;
    for (let c = 0; c < 3; c++) { box[c] = Math.min(box[c]!, a.box[c]!); box[c + 3] = Math.max(box[c + 3]!, a.box[c + 3]!); }
    v += n;
  }
  return { position, normal, uv, color, section, index, box };
}

/** Every buffer of a near mesh: handed over, not copied (MDN, `postMessage` transfer); one shared by two draws once. */
export function nearRoadBuffers(mesh: NearRoadMesh): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>([mesh.bounds.buffer as ArrayBuffer]);
  for (const d of mesh.draws) {
    const a = d.arrays;
    for (const array of [a.position, a.normal, a.uv, a.color, a.section, a.index, a.box]) if (array) out.add(array.buffer as ArrayBuffer);
  }
  return [...out];
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
  const out: NearTileRoads[] = [];
  for (let n = 0; n < ask.tiles.length; n++) {
    const { key, version } = ask.tiles[n]!;
    const page = ask.records?.[n];
    if (page) { out.push(page); continue; }
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

/** What a near job asks: what it reads, the version of that (`bake`: what it is kept by), the level wanted, and the version of it the page draws at that level (`shown`: the blocks changed since are sent alone). */
export type NearRoadWant = NearRoadAsk & { readonly bake: string; readonly variant: NearVariant; readonly shown: string | null };

/** A near job: the tile's node and the tree's version of the answer (`sig`: the bake's and the level), and what it asks. */
export interface NearRoadJob {
  readonly node: string;
  readonly sig: string;
  readonly want: boolean;
  readonly prefix: string | null;
  readonly store?: string;
  readonly near: NearRoadWant;
}

/** DO NOT bake what is kept, nor a block that reads what it read: a tile's near roads are kept by the version of the tiles they read (`nearSig`), and baked again a block at a time, the blocks whose surface tiles read the same taken from the last bake (an edit, a neighbour written, the tile's own write of what the page had) */
export async function runNearRoadJob(job: NearRoadJob, cache: NearRoadCache): Promise<NearRoadReply> {
  const { node, sig, prefix, near } = job;
  const bake = near.bake;
  const keeps = prefix !== null && await cache.ready();
  const last = keeps ? await cache.get(`${prefix}${node}`) as KeptNear | undefined : undefined;
  let kept: KeptNear | null;
  if (last && last.sig === bake) kept = last.blocks.length ? last : null;
  else {
    const tiles = await nearTilesOf(near, job.store, prefix, cache, keeps);
    if (!tiles || tiles.length === 0) return { kind: 'farRecords', node, sig };
    const [tile, ...around] = tiles as [NearTileRoads, ...NearTileRoads[]];
    kept = bakeNearRoads(tile, around, near, bake, last ?? null);
    if (keeps) await cache.put(`${prefix}${node}`, kept ?? { sig: bake, blocks: [], bounds: new Float64Array(6) });
  }
  if (!job.want || !kept) return { kind: 'far', node, sig, payload: null };
  // The page draws the last bake at this level: the blocks changed since alone.
  const base = last && last.sig !== bake && near.shown === last.sig ? last : null;
  return { kind: 'far', node, sig, payload: nearMeshOf(kept, near.variant, base) };
}

/** A tile with nothing stored under it, as a near bake reads one (a neighbour the store has none of). */
export const noRoads = (key: number): NearTileRoads => {
  const { nodes, borrowedNodes, segments } = emptyRecords(key, 0);
  return { key, nodes, borrowedNodes, segments, gates: [] };
};
