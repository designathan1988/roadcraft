import { Color, Group, type Material, type Mesh } from 'three';

import { measureHitch } from '@core/hitch';
import { Digest } from '@core/digest';
import type { Network } from '@world/network';
import { ROAD_TYPES } from '@world/roadTypes';
import type { CarriagewayMaterial } from '@world/roadSection';
import { packFlush } from '@world/roads/footwayRise';
import { rampsMeeting } from '@world/curbRamps';
import type { CurbRamp } from '@world/rampRise';
import { roadStructure } from '@world/structures';
import { type RoadElevation, SURFACE_READ_REACH } from '@world/elevation';
import { LANE_LINE } from '@world/roadTypes';
import { type Reach, SurfaceInputs, TILE, TILE_BIAS, TILE_ORIGIN } from './roadSurfaceInputs';
import type { SceneMaterials } from './materials';
import { type PassLook, passDesc, passRaised, passReads, polysOf, tileBundle } from './roadSurfacePass';
import { attachFarLevel, blockArraysOf, cloneBlock, joinBlocks, mergeTiles, splitBlock, tilesOnGpu } from './mesh/surfaceTiles';
import { cancelWarm, warmLooseAhead } from './uploads';
import { type BlockArrays, levelsOf } from './mesh/roadLod';
import { ASPHALT_REFERENCE, CARRIAGEWAY_COLOUR } from './roadTones';
import type { TileSource } from './roadTileShape';
import type { RoadTiler, TileJob } from './roadTilePool';
import type { SurfaceData } from './roadTileMesh';
import {
  FOOTWAY_EDGE_CELL,
  passSurfaces,
  type PassDesc,
  type RoadLook,
  type SurfaceRead,
} from './roadSurfaceReads';
import type { SegmentId } from '@world/ids';
import {
  disposeMesh,
  type SurfaceMeshOptions,
  type Tile,
  type TileRect,
} from './mesh/surfaceMesh';

export { TERRAIN_UV } from './roadSurfaceReads';

/** The road network's surface bands */

/** What one build of the surfaces keeps for the next, so an edit rebuilds only the tiles it reaches. */
export interface SurfaceReuse {
  /** DO NOT keep a tile's arrays here */
  readonly tiles: Map<string, Map<number, KeptTile>>;
  /** What each tile's ground and heights digested to at the last build (`dependsOn`), by pass and tile key: a tile no changed block reaches keeps it (DO NOT digest every tile of the region at every build: ~6,600 digests, 700 ms on the page at each tile a streamed world put in, 2026-10-16). */
  readonly depends?: Map<string, Map<number, number>>;
  /** A digest of everything the height field and the texture frames read in a rectangle */
  readonly dependsOn: (minX: number, minY: number, maxX: number, maxY: number) => number;
  /** The paint materials, by colour: made once, not on every rebuild. */
  readonly paint: Map<string, Material>;
  /** The meshes of each block of tiles */
  readonly chunks: Map<string, { readonly parts: readonly number[]; readonly mesh: Mesh }>;
  /** Block meshes replaced but maybe still drawn: freed by the owner once the new roads are in. */
  readonly retired?: Mesh[];
  /** Whether a block at (x, y), world units, is near the camera: made at full detail, its far level hidden */
  readonly near?: (x: number, y: number) => boolean;
  /** Whether a tile of the roads is built here at all (the streamed world's active tiles, `renderer.ts` setActiveTiles): a tile left out is the far roads' to draw (`farRoads.ts`), its blocks let go. None: every tile. */
  within?: (rect: TileRect) => boolean;
  /** Where `within`'s answer changed since the last build finished (tiles that came into or left the active region); null: it cannot say (every tile visited). */
  withinMoved?: (readonly [number, number, number, number])[] | null;
  /** Each pass as the last build left it (`PassState`): a build visits only what changed. None: every tile at every build. */
  readonly passes?: Map<string, PassState>;
  /** Tiles kept from earlier builds and sessions (`derivedCache.ts`), by `storedKey`: what is kept is known, a tile read only when a build uses it */
  readonly stored?: StoredTiles;
  /** The passes' inputs, kept road by road and node by node between builds (`roadSurfaceInputs.ts`) */
  readonly inputs?: SurfaceInputs;
  /** Each tile built afresh, to be kept for a later session */
  readonly keep?: (key: string, bundle: TileBundle) => void;
  /** The store's prefix the road tile workers keep the tiles they make under (none: the page keeps them, `keep`); `kept` tells the page a key is kept. */
  readonly workersKeep?: string | null;
  readonly kept?: (key: string) => void;
}

/** The box round a block's tiles' rectangles, [minX, minY, maxX, maxY]. */
function blockBox(rects: readonly TileRect[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) { minX = Math.min(minX, r[0]); minY = Math.min(minY, r[1]); maxX = Math.max(maxX, r[2]); maxY = Math.max(maxY, r[3]); }
  return [minX, minY, maxX, maxY];
}

/** A block into the group with its far level, which waits hidden beside it (`mesh/roadLod.ts`). */
function addBlock(group: Group, mesh: Mesh): void {
  group.add(mesh);
  const coarse = levelsOf(mesh)?.coarse;
  if (coarse) group.add(coarse);
}

/** The name a tile is kept under between sessions: its pass, its place and its digest (a new digest at the same place replaces the old). */
export const storedKey = (pass: string, tile: number, digest: number): string => `${pass}|${tile}|${digest}`;

/** The tiles kept off the page (`derivedCache.ts`) */
export interface StoredTiles {
  /** Whether a tile is kept. */
  has(key: string): boolean;
  /** The kept tiles of these keys, read from the store: never the whole of it. */
  fetch(keys: readonly string[]): Promise<ReadonlyMap<string, TileBundle>>;
}

/** Frees what a `SurfaceReuse` holds on the GPU. */
export function disposeSurfaceReuse(reuse: SurfaceReuse): void {
  dropSurfaceBlocks(reuse);
  for (const material of reuse.paint.values()) material.dispose();
}

/** The blocks a `SurfaceReuse` holds freed, its paint kept (what else draws the roads uses it: `farRoads.ts` near level). */
export function dropSurfaceBlocks(reuse: SurfaceReuse): void {
  for (const { mesh } of reuse.chunks?.values() ?? []) disposeMesh(mesh);
  reuse.chunks?.clear();
  // What the passes and tiles stood at goes with the blocks: a later build visits every tile again.
  reuse.passes?.clear();
  reuse.tiles.clear();
  reuse.depends?.clear();
  if (reuse.withinMoved !== undefined) reuse.withinMoved = null;
  for (const mesh of reuse.retired?.splice(0) ?? []) disposeMesh(mesh);
}

/** No road surfaces: what a build of the streamed world's region leaves, its roads drawn by the tiles' near levels (`farRoads.ts`). */
export function noRoadSurfaces(): RoadSurfaces {
  const group = new Group();
  group.name = 'road-network';
  group.matrixAutoUpdate = false;
  return { group, meshes: [], triangles: 0, built: 0, reused: 0, remade: 0, rebuilt: [], workMs: 0, adopt() {}, dispose() { group.clear(); } };
}

/** Every surface of one tile, by mesh name. */
export type TileBundle = ReadonlyMap<string, Tile>;
/** A tile kept between builds: the names of the surfaces it has. Its digest is its key. */
type KeptTile = readonly string[];

/** One tile of a pass in a build: its digest and block, its rings, its surfaces and arrays once known. */
interface PassTile {
  /** Its key among the pass's tiles (`roadSurfaceInputs.ts` tileKey). */
  readonly key: number;
  readonly value: number;
  /** Its name in the store (`storedKey`). */
  readonly stored: string;
  readonly chunk: string;
  readonly rect: TileRect;
  readonly into: Reach;
  surfaces: KeptTile | null;
  bundle: TileBundle | null;
}

/** A pass of the surfaces as the last build left it (`roadSurfaceSteps`): the constants it was built with, its inputs' birth, its tiles by key (no arrays), the tiles of each block and, for each surface, its blocks by the first tile holding it (the order a fresh build draws them in). */
export interface PassState {
  readonly salt: number;
  readonly born: number;
  readonly tiles: Map<number, PassTile>;
  readonly chunkTiles: Map<string, Set<number>>;
  readonly blocks: Map<string, Map<string, number>>;
  /** Blocks whose tiles changed and that a build replaced halfway did not merge yet: merged by the next. */
  readonly pending: Set<string>;
}

/** A block's tiles by digest, surface by surface of its group (a surface after the first marked by minus its place: digests are never negative). */
function tileSignature(lists: readonly (readonly PassTile[])[]): number[] {
  return lists.flatMap((list, i) => [...(i ? [-i] : []), ...list.map((tile) => tile.value)]);
}

/** Whether a block's tiles are the ones its mesh was merged from, by digest. */
function sameTiles(parts: readonly number[], lists: readonly (readonly PassTile[])[]): boolean {
  const now = tileSignature(lists);
  return parts.length === now.length && now.every((value, i) => value === parts[i]);
}

/** Surfaces drawn alike - one material, order and shadows - drawn as one mesh a block (`drawGroups`): its name, theirs joined by `+`. */
interface DrawGroup {
  readonly name: string;
  readonly specs: readonly SurfaceSpec[];
  readonly options: SurfaceSpec['options'];
  readonly renderOrder?: number;
}

/** DO NOT draw a mesh a surface where surfaces are drawn alike (the footway and its ramps, a kerb and a median's kerb: one material each): a
 *  draw call a surface a block. The pass's surfaces grouped by how they are drawn, in the order each group's first surface comes; each
 *  surface keeps its own tiles, and its own far level (`attachFarLevel`). */
function drawGroups(specs: readonly SurfaceSpec[]): DrawGroup[] {
  const byLook = new Map<string, SurfaceSpec[]>();
  for (const spec of specs) {
    const o = spec.options;
    const look = `${o.material.uuid}|${spec.renderOrder ?? ''}|${o.castShadow ?? false}|${o.receiveShadow ?? true}`;
    const list = byLook.get(look);
    if (list) list.push(spec); else byLook.set(look, [spec]);
  }
  return [...byLook.values()].map((members) => {
    const name = members.map((spec) => spec.options.name).join('+');
    const lead = members[0]!;
    return { name, specs: members, options: { ...lead.options, name }, ...(lead.renderOrder !== undefined ? { renderOrder: lead.renderOrder } : {}) };
  });
}

/** One surface's tiles in a block, built again from their rings (a lost WebGL context, `mesh/gpuOnly.ts`) */
function surfaceSource(spec: SurfaceSpec, tiles: readonly { readonly rect: TileRect; readonly into: Reach }[],
  reading: <T>(work: () => T) => T): () => Tile[] {
  return () => tiles.map(({ rect, into }) =>
    reading(() => tileBundle(into, rect, [spec]).get(spec.options.name)!));
}

export interface RoadSurfaces {
  readonly group: Group;
  readonly meshes: readonly Mesh[];
  readonly triangles: number;
  /** Tiles the build made afresh, and copied from the build before. */
  readonly built: number;
  readonly reused: number;
  /** Tiles kept from before built again to merge a block that changed (their arrays are not kept). */
  readonly remade: number;
  /** Where the tiles made afresh lie (`world/changes.ts`). */
  readonly rebuilt: readonly TileRect[];
  /** The time the tiles and their blocks took, ms, without the frames between slices. */
  readonly workMs: number;
  /** Puts the blocks kept from the build before into `group`, at the swap. */
  adopt(): void;
  dispose(): void;
}

/** Tiles a side of one mesh. */
const CHUNK = 4;
/** Tiles a batch asked of the workers at once (`roadTilePool.ts`) */
const SHAPE_BATCH = 64;

/** Linear-space tints per road class, so the asphalt mesh can vary by class. */
const CLASS_TINT: readonly Color[] = ROAD_TYPES.map((type) =>
  new Color(type.color),
);
/** The tint the asphalt material is authored against, so 1.0 means "as baked". */
const TINT_REFERENCE = new Color(ASPHALT_REFERENCE);
/** A carriageway's tone by what it is paved with; asphalt keeps its class's. */
const CARRIAGEWAY_TINT: Readonly<Record<Exclude<CarriagewayMaterial, 'asphalt'>, Color>> = {
  concrete: new Color(CARRIAGEWAY_COLOUR.concrete),
  cobble: new Color(CARRIAGEWAY_COLOUR.cobble),
};
/** A colour against the reference, channel by channel: the multiplier a vertex is tinted with. */
const againstReference = (tint: Color): [number, number, number] =>
  [tint.r / TINT_REFERENCE.r, tint.g / TINT_REFERENCE.g, tint.b / TINT_REFERENCE.b];
/** The carriageway's tints as a pass reads them (`PassDesc`): numbers, made once here with three's colour management. */
const CLASS_TINTS: readonly number[] = CLASS_TINT.flatMap(againstReference);
const REFERENCE_TINT = againstReference(TINT_REFERENCE);
const PAVING_TINTS: Readonly<Record<string, readonly [number, number, number]>> = Object.fromEntries(
  Object.entries(CARRIAGEWAY_TINT).map(([name, tint]) => [name, againstReference(tint)]));

/** The page's constants the roads are drawn with (`PassLook`): what a road bake in a worker is handed to draw them alike (`nearRoadTiles.ts`). */
export function passLook(materials: SceneMaterials, groundMaterial: Material | undefined): PassLook {
  return {
    groundMaterial: groundMaterial !== undefined,
    scale: { asphalt: materials.scale.asphalt, footway: materials.scale.footway, kerb: materials.scale.kerb, verge: materials.scale.verge, deck: materials.scale.deck },
    classTint: CLASS_TINTS,
    referenceTint: REFERENCE_TINT,
    pavingTint: PAVING_TINTS,
  };
}
/** What each surface of a tile is made from (`roadTileShape.ts`). */
type Source = TileSource;

/** One surface of a structural level: how it is meshed, and from what. */
interface SurfaceSpec {
  readonly source: Source;
  readonly options: Omit<SurfaceMeshOptions, 'polygons'>;
  readonly renderOrder?: number;
}

export function buildRoadSurfaces(
  net: Network,
  elevation: RoadElevation,
  materials: SceneMaterials,
  terrainAt: (x: number, y: number) => number,
  reuse?: SurfaceReuse,
  groundMaterial?: Material,
): RoadSurfaces {
  const steps = roadSurfaceSteps(net, elevation, materials, terrainAt, reuse, groundMaterial);
  let step = steps.next();
  while (!step.done) step = steps.next();
  step.value.adopt();
  return step.value;
}

/** `buildRoadSurfaces` in steps: it yields after each tile built and each block merged */
export function* roadSurfaceSteps(
  net: Network,
  elevation: RoadElevation,
  materials: SceneMaterials,
  terrainAt: (x: number, y: number) => number,
  reuse?: SurfaceReuse,
  groundMaterial?: Material,
  /** Shapes the tiles off the page (`roadTilePool.ts`); then the steps yield 'wait' while it works. None: all here. */
  tiler?: RoadTiler | null,
  /** The blocks whose ground or heights changed since the last build (`renderer.ts` `compareSolves`), world units: only the tiles within the elevation's read reach of one are digested again; null, every tile (the land moved, or nothing is known). */
  changed: readonly (readonly [number, number, number, number])[] | null = null,
): Generator<'wait' | void, RoadSurfaces, void> {
  const started = performance.now();
  let tilesMs = 0;
  let mergeMs = 0;
  let chunksMerged = 0;
  let chunksKept = 0;
  let remade = 0;
  const chunks = reuse?.chunks;
  const usedChunks = new Set<string>();
  /** The blocks whose far level is being made by the workers (`mergeTiles`): the build waits for them before it ends. */
  let coarsening = 0;
  // A block let go before its upload came is taken out of the queue first (`uploads.ts` `cancelWarm`)
  const retire = (mesh: Mesh): void => { cancelWarm(levelsOf(mesh)?.coarse ? [mesh, levelsOf(mesh)!.coarse!] : [mesh]); if (reuse?.retired) reuse.retired.push(mesh); else disposeMesh(mesh); };
  const group = new Group();
  group.matrixAutoUpdate = false;
  group.name = 'road-network';
  const meshes: Mesh[] = [];
  let triangles = 0;
  let built = 0;
  let reused = 0;
  const rebuilt: TileRect[] = [];
  // The paint of every colour, made at load (`paintCatalogue`): read here, never made.
  const paint = reuse?.paint;
  const paintFor = (color: string): Material => paint?.get(color) ?? paint?.get(LANE_LINE) ?? materials.asphalt;

  const reading = <T>(work: () => T): T => elevation.remembering ? elevation.remembering(work) : work();
  // The inputs of every pass, kept road by road and node by node and brought up to the network by its change
  const inputs = reuse?.inputs ?? new SurfaceInputs();
  inputs.refresh(net);
  // Roads at authored heights are drawn on their own, each from its own deck
  const passes = inputs.passList();
  if (reuse) {
    const current = new Set(passes.map((pass) => pass.id));
    for (const id of reuse.tiles.keys()) if (!current.has(id)) reuse.tiles.delete(id);
  }
  // Every pass may paint in every colour of the catalogue: a colour with no line in a tile draws nothing there
  const paintColours = inputs.paintColours();
  /** The tiles of the active region's edge that moved, as read now: taken off `withinMoved` only once this build is over (a build replaced halfway leaves them for the next). */
  const moved = reuse?.withinMoved === undefined ? [] : reuse.withinMoved === null ? null : reuse.withinMoved.slice();
  /** The dirty tiles each pass was visited with: settled once this build is over, for the same reason. */
  const settleLater: { pass: string; born: number; keys: number[] }[] = [];
  for (const pass of passes) {
    yield;
    const structure = roadStructure(pass.structure);
    const present = pass.chain !== undefined || inputs.present(structure.id);
    if (!present) {
      reuse?.tiles.delete(pass.id);
      reuse?.passes?.delete(pass.id);
      continue;
    }

    const raised = passRaised(net, pass, elevation, terrainAt);

    /** What this pass's surfaces read on the page: the network and the solved field (in a worker, `SurfaceData`). */
    const pageReads = passReads(net, elevation, terrainAt, inputs, pass.id);
    const look = (id: SegmentId): RoadLook | undefined => pageReads.look(id);
    const edgesAt = (key: number): ArrayLike<number> | undefined => pageReads.footwayEdges(key);
    net.crossingSurface();
    yield;
    /** The pass as its surfaces read it, plain data: the same on the page and in a worker (`roadSurfaceReads.ts`). */
    const desc: PassDesc = passDesc(net, pass, raised, passLook(materials, groundMaterial), paintColours);
    const specs = passSurfaces(desc, pageReads).map((read) => dress(read, raised, materials, groundMaterial, paintFor));
    const groups = drawGroups(specs);

    // Everything a tile's build reads besides its rings and its surroundings
    const specSalt = (spec: SurfaceSpec): number => new Digest().addText(spec.options.name).add(spec.options.maxEdge)
      .add(spec.options.uvWorld ?? 0).add(spec.options.skirtUvScale ?? 0).add(spec.options.bottom ? 1 : 0)
      .add(spec.options.tint ? 1 : 0).value();
    const salt = new Digest().addText(pass.id);
    const paintSalt = new Map<string, number>();
    for (const spec of specs) {
      if (spec.source.kind === 'paint') paintSalt.set(spec.source.color, specSalt(spec));
      else salt.add(specSalt(spec));
    }
    const saltValue = salt.value();
    // What the pass's blocks are kept under besides their tiles: each surface's name, material and order (`keyOf`). DO NOT keep a pass's state across a change of them: its standing blocks would be looked for under keys no longer made.
    const passSalt = new Digest().add(saltValue);
    for (const spec of specs) passSalt.addText(spec.options.name).addText(spec.options.material.uuid).add(spec.renderOrder ?? -1);
    const passSaltValue = passSalt.value();

    const previous = reuse?.tiles.get(pass.id);
    // THE PASS AS IT STOOD (`PassState`): DO NOT walk every road tile of the region at each build (a tile put in made every pass digest, sort and regroup every tile, a slice a frame). Only the tiles whose inputs changed (`SurfaceInputs.dirtyOf`), those a changed block reaches and those that came into or left the active region (`withinMoved`) are visited, and only their blocks merged again; the first build, a pass made again, new constants or a change that cannot say where visits them all.
    const dirtyNow = inputs.dirtyOf(pass.id);
    const before = reuse?.passes?.get(pass.id);
    const incremental = before !== undefined && dirtyNow !== null && before.salt === passSaltValue && before.born === dirtyNow.born
      && changed !== null && moved !== null;
    const state: PassState = incremental ? before : { salt: passSaltValue, born: dirtyNow?.born ?? -1, tiles: new Map(), chunkTiles: new Map(), blocks: new Map(), pending: new Set() };
    if (dirtyNow) settleLater.push({ pass: pass.id, born: dirtyNow.born, keys: [...dirtyNow.keys] });
    const kept = incremental && previous ? previous : new Map<number, KeptTile>();
    const knownDepends = reuse?.depends?.get(pass.id);
    const depends = incremental && knownDepends ? knownDepends : new Map<number, number>();
    const reach = SURFACE_READ_REACH + 1;
    const reached = (rect: TileRect): boolean => changed === null
      || changed.some((b) => b[0] <= rect[2] + reach && b[2] >= rect[0] - reach && b[1] <= rect[3] + reach && b[3] >= rect[1] - reach);
    /** The tiles to look at, in tile order (a mesh is laid out the same however it was reached). */
    let visit: number[];
    if (incremental) {
      const keys = new Set<number>(dirtyNow!.keys);
      const over = (r: readonly number[], grow: number): void => {
        for (let ix = Math.floor((r[0]! - grow - TILE_ORIGIN) / TILE); ix <= Math.floor((r[2]! + grow - TILE_ORIGIN) / TILE); ix++) {
          for (let iy = Math.floor((r[1]! - grow - TILE_ORIGIN) / TILE); iy <= Math.floor((r[3]! + grow - TILE_ORIGIN) / TILE); iy++) {
            const key = (ix + TILE_BIAS) * 0x1_0000 + (iy + TILE_BIAS);
            if (state.tiles.has(key) || inputs.hasTile(pass.id, key)) keys.add(key);
          }
        }
      };
      for (const b of changed!) over(b, reach);
      for (const r of moved!) over(r, 0);
      visit = [...keys].sort((p, q) => p - q);
    } else visit = inputs.tileKeys(pass.id);
    /** The blocks a visited tile came into, changed in or left: merged again; every other block stands as it is. */
    const affected = new Set<string>();
    /** The visited tiles that are new, changed (the tile) or gone (null): put in the pass's state only once built (DO NOT write them in as they are visited: a build replaced before building them left them as kept, never built). */
    const changes = new Map<number, PassTile | null>();
    /** The tiles visited and new or changed: kept from before (its surfaces known, its arrays not), read from the store, or to build. */
    const tiles: PassTile[] = [];
    /** The tiles to read from the store, by their place in `tiles`. */
    const fromStore: number[] = [];
    for (const key of visit) {
      const ix = Math.floor(key / 0x1_0000) - TILE_BIAS;
      const iy = (key % 0x1_0000) - TILE_BIAS;
      const rect: TileRect = [
        ix * TILE + TILE_ORIGIN, iy * TILE + TILE_ORIGIN, (ix + 1) * TILE + TILE_ORIGIN, (iy + 1) * TILE + TILE_ORIGIN,
      ];
      const old = state.tiles.get(key);
      // A tile gone, or of the kept ring: not built, not digested; the far roads draw it (its block loses it, or goes).
      if (!inputs.hasTile(pass.id, key) || (reuse?.within && !reuse.within(rect))) {
        if (old) { changes.set(key, null); affected.add(old.chunk); }
        depends.delete(key);
        continue;
      }
      const { reach: into, digest: read, colours } = inputs.reachOf(pass.id, key);
      // A paint colour's constants in the keys of the tiles that hold lines of that colour alone.
      const digest = new Digest().add(saltValue).add(key).add(read);
      for (const color of colours) digest.add(paintSalt.get(color) ?? 0);
      if (reuse) {
        const known = knownDepends?.get(key);
        const depend = known !== undefined && !reached(rect) ? known : reuse.dependsOn(rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1);
        depends.set(key, depend);
        digest.add(depend);
      }
      const value = digest.value();
      if (old && old.value === value) continue;
      const surfaces = previous?.get(value);
      const stored = storedKey(pass.id, key, value);
      const chunk = `${Math.floor(ix / CHUNK)},${Math.floor(iy / CHUNK)}`;
      if (!surfaces && reuse?.stored?.has(stored)) fromStore.push(tiles.length);
      const tile: PassTile = { key, value, stored, chunk, rect, into, surfaces: surfaces ?? null, bundle: null };
      tiles.push(tile);
      changes.set(key, tile);
      affected.add(chunk);
      if (surfaces) yield;
    }
    // The kept tiles this build uses, read off the store now (one transaction), never the whole store at the opening.
    if (fromStore.length && reuse?.stored) {
      let got: ReadonlyMap<string, TileBundle> | null = null;
      reuse.stored.fetch(fromStore.map((k) => tiles[k]!.stored)).then((map) => { got = map; }, () => { got = new Map(); });
      while (got === null) yield 'wait';
      const read: ReadonlyMap<string, TileBundle> = got;
      for (const k of fromStore) {
        const tile = tiles[k]!;
        const bundle = read.get(tile.stored);
        if (!bundle) continue;
        tile.bundle = bundle;
        tile.surfaces = [...bundle.keys()];
      }
    }
    /** The roads a share of the tiles reads, for a worker (`roadTileMesh.ts`) */
    const dataFor = (rects: readonly TileRect[]): { data: SurfaceData; transfer: ArrayBuffer[] } => {
      // A unit round each tile: its vertices lie on its edges, and the cut puts some a rounding past them.
      const around = rects.map((r): [number, number, number, number] => [r[0] - 1, r[1] - 1, r[2] + 1, r[3] + 1]);
      const packed = elevation.fieldFor!(around, pass.chain ?? []);
      const field = packed.data;
      const transfer = [...packed.transfer];
      const lookList: [SegmentId, RoadLook][] = [];
      const seen = new Set<SegmentId>();
      for (const id of [...field.ids as unknown as SegmentId[], ...(pass.chain ?? [])]) {
        if (seen.has(id)) continue;
        seen.add(id);
        const found = look(id);
        if (found) lookList.push([id, found]);
      }
      const ramps = new Set<CurbRamp>();
      const edgeKeys = new Set<number>();
      for (const rect of around) {
        for (const r of rampsMeeting(net, rect)) if (r.structure === structure.id) ramps.add(r);
        if (raised) continue;
        for (let cx = Math.floor(rect[0] / FOOTWAY_EDGE_CELL); cx <= Math.floor(rect[2] / FOOTWAY_EDGE_CELL); cx++) {
          for (let cy = Math.floor(rect[1] / FOOTWAY_EDGE_CELL); cy <= Math.floor(rect[3] / FOOTWAY_EDGE_CELL); cy++) {
            const key = (cx + 32768) * 65536 + (cy + 32768);
            if (edgesAt(key)) edgeKeys.add(key);
          }
        }
      }
      const flush = packFlush(net, around);
      transfer.push(...flush.transfer);
      const edgeLists = [...edgeKeys].map((key) => Float64Array.from(edgesAt(key)!));
      const joined = concat(edgeLists);
      const edgeData = { keys: Float64Array.from(edgeKeys), ends: joined.lineEnds, xy: joined.lines };
      for (const array of [edgeData.keys, edgeData.ends, edgeData.xy]) transfer.push(array.buffer as ArrayBuffer);
      return { data: { field, looks: lookList, flush: flush.data, ramps: [...ramps], edges: edgeData }, transfer };
    };
    /** DO NOT cut, triangulate or read the vertices of a city's tiles on the page: the whole of its roads' build (2026-10-15). */
    const offPage = tiler && elevation.fieldFor ? tiler : null;
    /** The tiles their worker kept in the store (`TileJob.keep`). */
    const keptByWorker = new Set<PassTile>();
    const buildAll = function* (list: readonly PassTile[], done: (tile: PassTile) => void): Generator<'wait' | void, void, void> {
      /** Asks the tiler for `SHAPE_BATCH` tiles from `from` on; the answer lands in the record it returns. */
      const ask = (from: number): { readonly from: number; readonly answer: { tiles?: Map<string, Tile>[]; failed?: boolean } } => {
        const answer: { tiles?: Map<string, Tile>[]; failed?: boolean } = {};
        const batch = list.slice(from, from + SHAPE_BATCH);
        const prefix = reuse?.workersKeep;
        const request: TileJob = {
          pass: desc,
          tiles: batch.map((t) => ({ rect: t.rect, into: polysOf(t.into) })),
          dataFor,
          terrainAt,
          // Kept by the workers that make them, with a ceiling of their own on what is not committed: DO NOT post them back to be kept (past the page's ceiling a tile was dropped).
          ...(prefix ? { keep: { prefix, keys: batch.map((t) => (reuse?.stored?.has(t.stored) ? null : t.stored)) }, onKept: (k: number) => { keptByWorker.add(batch[k]!); } } : {}),
        };
        offPage!.tiles(request).then(
          (tiles) => { answer.tiles = tiles; },
          (error: unknown) => { console.warn('[roads] the road tile workers failed; the tiles are built on the page', error); answer.failed = true; },
        );
        return { from, answer };
      };
      // DO NOT ask for every tile at once: a whole city's tiles held together, before any was merged, took the page past 7 GB
      let job = offPage && list.length ? ask(0) : null;
      let failed = false;
      for (let from = 0; from < list.length; from += SHAPE_BATCH) {
        let made: Map<string, Tile>[] | null = null;
        if (job && !failed) {
          while (!job.answer.tiles && !job.answer.failed) { offPage!.check(); yield 'wait'; }
          made = job.answer.tiles ?? null;
          if (!made) failed = true;
          job = !failed && from + SHAPE_BATCH < list.length ? ask(from + SHAPE_BATCH) : null;
        }
        for (let k = from; k < Math.min(list.length, from + SHAPE_BATCH); k++) {
          const tile = list[k]!;
          const tileAt = performance.now();
          // Made off the page: taken as it is.
          const bundle = made ? made[k - from]! : reading(() => buildTile(tile.into, tile.rect, specs));
          tile.bundle = bundle;
          tile.surfaces = [...bundle.keys()];
          tilesMs += performance.now() - tileAt;
          done(tile);
          // A tile made here is a step of its own; the tiles a worker made are taken a batch a step (taking one is filing its arrays: ~170 steps a 1 km tile, a step a frame once the town is shown, 2026-10-16).
          if (!made) yield;
        }
        if (made) yield;
      }
    };
    /** The tiles built afresh this pass: kept for a later session once merged (below), unless their worker kept them. */
    const fresh: PassTile[] = [];
    let builtHere = 0;
    yield* buildAll(tiles.filter((t) => t.surfaces === null), (tile) => {
      built++;
      builtHere++;
      rebuilt.push(tile.rect);
      fresh.push(tile);
    });
    // Built: the changes into the pass's state, their blocks to merge (with those a build replaced halfway left unmerged) until merged.
    for (const chunk of state.pending) affected.add(chunk);
    for (const [key, tile] of changes) {
      const old = state.tiles.get(key);
      if (old) { state.chunkTiles.get(old.chunk)?.delete(key); if (incremental) kept.delete(old.value); }
      if (!tile) { state.tiles.delete(key); continue; }
      state.tiles.set(key, tile);
      let inChunk = state.chunkTiles.get(tile.chunk);
      if (!inChunk) state.chunkTiles.set(tile.chunk, inChunk = new Set());
      inChunk.add(key);
      kept.set(tile.value, tile.surfaces!);
    }
    for (const chunk of affected) state.pending.add(chunk);
    if (reuse?.passes) reuse.passes.set(pass.id, state);
    reuse?.tiles.set(pass.id, kept);
    reuse?.depends?.set(pass.id, depends);
    reused += state.tiles.size - builtHere;

    // A block keeps its mesh while its tiles are the same (by digest).
    const keyOf = (group: DrawGroup, chunk: string): string =>
      `${pass.id}|${group.name}|${chunk}|${group.options.material.uuid}|${group.renderOrder ?? ''}`;
    /** Each group's tiles in each block a visited tile touched, surface by surface of the group, in tile order. */
    const parts = new Map<string, Map<string, PassTile[][]>>();
    for (const group of groups) parts.set(group.name, new Map());
    for (const chunk of affected) {
      const inChunk = [...(state.chunkTiles.get(chunk) ?? [])].sort((p, q) => p - q).map((key) => state.tiles.get(key)!);
      if (inChunk.length === 0) state.chunkTiles.delete(chunk);
      for (const group of groups) {
        const lists = group.specs.map((spec) => inChunk.filter((tile) => tile.surfaces!.includes(spec.options.name)));
        if (lists.some((list) => list.length)) { parts.get(group.name)!.set(chunk, lists); continue; }
        // No tile of the block has a surface of the group any more: its mesh goes.
        state.blocks.get(group.name)?.delete(chunk);
        const gone = chunks?.get(keyOf(group, chunk));
        if (gone) { retire(gone.mesh); chunks!.delete(keyOf(group, chunk)); }
      }
    }
    const again = new Set<PassTile>();
    for (const group of groups) {
      for (const [chunk, lists] of parts.get(group.name) ?? []) {
        const known = chunks?.get(keyOf(group, chunk));
        if (known && sameTiles(known.parts, lists)) continue;
        for (const tile of lists.flat()) if (!tile.bundle) again.add(tile);
      }
    }
    yield* buildAll([...again], () => { remade++; });

    /** The blocks merged here without a cache to keep them (`buildRoadSurfaces` with no reuse). */
    const own = new Map<string, Mesh>();
    const mergeAt = performance.now();
    for (const group of groups) {
      for (const [chunk, lists] of parts.get(group.name) ?? []) {
        const key = keyOf(group, chunk);
        const known = chunks?.get(key);
        // The group's surfaces that have tiles in the block, each with its tiles: drawn one after the other in one mesh.
        const members = group.specs.flatMap((spec, i) => (lists[i]!.length ? [{ spec, list: lists[i]! }] : []));
        let mesh: Mesh | null;
        // DO NOT let the mesh hold its tiles for it: a second copy of every road on the GPU, kept on the CPU
        const sources = members.map(({ spec, list: tiles }) => surfaceSource(spec, tiles.map((tile) => ({ rect: tile.rect, into: tile.into })), reading));
        const source = sources.length === 1 ? sources[0]! : (): Tile[] => sources.flatMap((s) => s());
        if (known && sameTiles(known.parts, lists)) {
          mesh = known.mesh;
          // Bound to this build's rings: the build that made it lets go of its own.
          tilesOnGpu(mesh, source);
          chunksKept++;
        } else {
          if (known) retire(known.mesh);
          // The block's box and centre, to lock its edge in the far level and to tell near from far (`roadLod.ts`).
          // Each surface's own: its block was its tiles' box, a surface of a group keeps it (its far level locked to it, near by it).
          const coarsen = reuse?.near && tiler?.coarsen ? tiler.coarsen.bind(tiler) : null;
          const locks = coarsen ? members.map(({ list: tiles }) => blockBox(tiles.map((tile) => tile.rect))) : null;
          const lock = locks?.[0] ?? null;
          const near = locks ? locks.some((b) => reuse!.near!((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)) : true;
          const memberTiles = members.map(({ spec, list: tiles }) => tiles.map((tile) => tile.bundle!.get(spec.options.name)!));
          mesh = mergeTiles(memberTiles.flat(), group.options, source,
            lock ? {
              lock, near, also: locks!.slice(1),
              start: (block, arrays) => {
                coarsening++;
                // Each surface simplified on its own, as when it was a block of its own; one too small to gain is drawn whole in the far level.
                const pieces = memberTiles.length === 1 ? [cloneBlock(arrays)] : splitBlock(arrays, memberTiles);
                const whole = memberTiles.length === 1 ? [] : splitBlock(arrays, memberTiles);
                Promise.all(pieces.map((piece, i) => coarsen!(piece, locks![i]!))).then((made) => {
                  // The block may have been built again meanwhile: its far level is of the one it was made for.
                  if (chunks?.get(key)?.mesh !== block) return;
                  if (made.some((m) => m !== null)) {
                    const coarse = made.length === 1 ? made[0]! : joinBlocks(made.map((m, i) => m ?? whole[i]!));
                    const level = attachFarLevel(block, coarse, group.options, sources.map((s, i) => ({ source: s, lock: locks![i]! })), near);
                    if (!near) void warmLooseAhead([level]);
                  } else if (!near) void warmLooseAhead([block]);
                }).catch((error: unknown) => {
                  // No far level for this block: it stays at full detail, sent to the GPU.
                  console.warn('[roads] the far level of a block could not be made', error);
                  if (chunks?.get(key)?.mesh === block) void warmLooseAhead([block]);
                }).finally(() => { coarsening--; });
              },
            } : undefined);
          // Its full level, when it comes back near, copied from the kept tiles (`reuse.stored`): DO NOT cut and triangulate the block's tiles on the page again (`roadResidency.ts` makeNear).
          const levels = mesh && lock ? levelsOf(mesh) : undefined;
          if (mesh && levels && reuse?.stored) {
            const stored = reuse.stored, material = group.options.material;
            const wanted = members.map(({ spec, list: tiles }) => ({ name: spec.options.name, keys: tiles.map((tile) => tile.stored) }));
            levels.bring = async (): Promise<BlockArrays | null> => {
              const got = await stored.fetch(wanted.flatMap((w) => w.keys));
              const read: Tile[] = [];
              for (const { name, keys } of wanted) {
                for (const k of keys) {
                  const tile = got.get(k)?.get(name);
                  if (!tile) return null;
                  read.push(tile);
                }
              }
              return blockArraysOf(read, material);
            };
          }
          if (mesh && group.renderOrder !== undefined) mesh.renderOrder = group.renderOrder;
          // DO NOT wait for the camera to frame it: a block out of view was never uploaded and kept its copy on the CPU
          if (mesh && !(lock && !near)) void warmLooseAhead([mesh]);
          if (mesh) chunks?.set(key, { parts: tileSignature(lists), mesh });
          else chunks?.delete(key);
          chunksMerged++;
          yield;
        }
        let order = state.blocks.get(group.name);
        if (!order) state.blocks.set(group.name, order = new Map());
        if (!mesh) { order.delete(chunk); continue; }
        // Where a fresh build draws it: by its first tile holding a surface of the group.
        order.set(chunk, Math.min(...members.map((member) => member.list[0]!.key)));
        if (!chunks) own.set(key, mesh);
      }
    }
    // Every block of the pass, the ones merged now and the ones standing, in the order a fresh build draws them.
    for (const drawn of groups) {
      const order = state.blocks.get(drawn.name);
      if (!order) continue;
      for (const [chunk] of [...order].sort((p, q) => p[1] - q[1])) {
        const key = keyOf(drawn, chunk);
        const mesh = chunks?.get(key)?.mesh ?? own.get(key);
        if (!mesh) continue;
        usedChunks.add(key);
        // A kept block stays where it is drawn until the swap (`adopt`).
        if (mesh.parent === null) addBlock(group, mesh);
        meshes.push(mesh);
        triangles += (mesh.geometry.index?.count ?? 0) / 3;
      }
    }
    // Every block it touched merged: none left for the next build.
    for (const chunk of affected) state.pending.delete(chunk);
    // The tiles' arrays go with this build: copied into the blocks, which send them to the GPU (the pass's state keeps none).
    mergeMs += performance.now() - mergeAt;
    // Kept for a later session only now, every block merged
    for (const tile of fresh) {
      if (keptByWorker.has(tile)) reuse?.kept?.(tile.stored);
      else reuse?.keep?.(tile.stored, tile.bundle!);
    }
    for (const tile of tiles) tile.bundle = null;
  }
  // Blocks no surface has any more.
  if (chunks) for (const [key, { mesh }] of chunks) if (!usedChunks.has(key)) { retire(mesh); chunks.delete(key); }
  // Over: what it was asked to visit is visited.
  for (const { pass, born, keys } of settleLater) inputs.settle(pass, born, keys);
  if (reuse && reuse.withinMoved !== undefined) {
    if (moved === null) { if (reuse.withinMoved === null) reuse.withinMoved = []; }
    else reuse.withinMoved?.splice(0, moved.length);
  }
  // DO NOT wait without a deadline: `check` fails the pool when a worker is silent.
  while (coarsening > 0) { tiler?.check(); yield 'wait'; }
  // Where an edit's time went (`hitch:` entries).
  const end = performance.now();
  measureHitch(`hitch:road-edit/surfaces ${built} tiles built ${reused} kept ${remade} remade, ${chunksMerged} blocks merged ${chunksKept} kept: tiles ${tilesMs.toFixed(0)} ms, merge ${mergeMs.toFixed(0)} ms`, started, end);
  return {
    group,
    meshes,
    triangles,
    built,
    reused,
    remade,
    rebuilt,
    workMs: tilesMs + mergeMs,
    adopt() {
      // Every block, in the order it was built: the order a fresh build draws them in.
      for (const mesh of meshes) addBlock(group, mesh);
    },
    dispose() {
      // Meshes the cache keeps are freed by `disposeSurfaceReuse`.
      if (!chunks) for (const mesh of meshes) disposeMesh(mesh);
      group.clear();
    },
  };
}

/** Arrays end to end, with where each ends: one buffer to hand over instead of one an array. */
function concat(parts: readonly ArrayLike<number>[]): { lineEnds: Uint32Array; lines: Float64Array } {
  let length = 0;
  for (const part of parts) length += part.length;
  const lines = new Float64Array(length);
  const lineEnds = new Uint32Array(parts.length);
  let at = 0;
  parts.forEach((part, i) => { lines.set(part, at); at += part.length; lineEnds[i] = at; });
  return { lineEnds, lines };
}

/** How a surface is drawn: its material, whether it casts a shadow, its order among the roads' meshes (the paint over the deck) - the region's (`dress`) and a tile's near roads baked off the page (`farRoads.ts` near level) alike. */
export function surfaceLook(source: TileSource, raised: boolean, materials: SceneMaterials, groundMaterial: Material | undefined,
  paintFor: (color: string) => Material): { readonly material: Material; readonly castShadow?: boolean; readonly renderOrder?: number } {
  if (source.kind === 'paint') return { material: paintFor(source.color), renderOrder: 3 };
  if (source.kind === 'median') return { material: source.part === 'kerb' ? materials.kerb : source.part === 'planting' ? materials.verge : materials.footway };
  switch (source.band) {
    case 'verge':
      return { material: raised ? materials.deck : groundMaterial ?? materials.verge, castShadow: raised };
    case 'footway':
    case 'curbRamp':
      return { material: materials.footway, castShadow: raised };
    case 'kerb':
      return { material: materials.kerb };
    case 'asphalt':
      return { material: raised ? materials.asphaltRaised : materials.asphalt, castShadow: raised };
  }
}

/** A surface as the page draws it: what it reads (`passSurfaces`) with its material and shadows (`surfaceLook`). */
function dress(read: SurfaceRead, raised: boolean, materials: SceneMaterials, groundMaterial: Material | undefined,
  paintFor: (color: string) => Material): SurfaceSpec {
  const look = surfaceLook(read.source, raised, materials, groundMaterial, paintFor);
  return {
    source: read.source,
    options: { ...read.options, material: look.material, ...(look.castShadow !== undefined ? { castShadow: look.castShadow } : {}), receiveShadow: true },
    ...(look.renderOrder !== undefined ? { renderOrder: look.renderOrder } : {}),
  };
}

/** Every surface of one tile, from the rings that reach it (`roadSurfacePass.ts` tileBundle): a tile the page builds itself (a worker makes its own, `roadTileMesh.ts`). */
function buildTile(into: Reach, rect: TileRect, specs: readonly SurfaceSpec[]): TileBundle {
  return tileBundle(into, rect, specs);
}
