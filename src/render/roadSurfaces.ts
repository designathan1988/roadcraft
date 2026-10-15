import { Color, Group, type Material, type Mesh } from 'three';

import type { MultiPoly, Poly } from '@core/clipper';
import { Digest } from '@core/digest';
import { offsetPolyline } from '@core/offset';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { CASING_BAND, CURB_BAND, Level, ROAD_TYPES, type SurfaceLevel, laneWidth } from '@world/roadTypes';
import type { CarriagewayMaterial } from '@world/roadSection';
import { footwayRiseShare, packFlush } from '@world/roads/footwayRise';
import { levelPolygons, levelRings } from '@world/surfaces';
import { curbRamps, rampOutline, rampsMeeting, walkingRise } from '@world/curbRamps';
import type { CurbRamp } from '@world/rampRise';
import {
  RAISED_LIFT,
  ROAD_STRUCTURES,
  isRaised,
  roadStructure,
  type RoadStructure,
} from '@world/structures';
import type { RoadElevation } from '@world/elevation';
import { m } from '@world/units';
import { medianNose } from '@world/landscape';
import { PAINT_RISE, markingQuads, paintMaterial } from './markings';
import type { SceneMaterials } from './materials';
import { TERRAIN_CELL } from './terrain';
import { mergeTiles, tilesOnGpu } from './mesh/surfaceTiles';
import { cancelWarm, warmLooseAhead } from './uploads';
import { type TilePolys, type TileSource, tileShapes } from './roadTileShape';
import type { RoadTiler, TileJob } from './roadTilePool';
import type { SurfaceData } from './roadTileMesh';
import {
  FOOTWAY_EDGE_CELL,
  passSurfaces,
  tileSpecOf,
  type PassDesc,
  type RoadLook,
  type SurfaceRead,
  type SurfaceReads,
} from './roadSurfaceReads';
import type { SurfaceShape } from './mesh/tileShape';
import {
  disposeMesh,
  meshTileShape,
  type SurfaceMeshOptions,
  type Tile,
  type TileRect,
} from './mesh/surfaceMesh';

export { TERRAIN_UV } from './roadSurfaceReads';

/**
 * The road network's surface bands, per structural level.
 *
 * ## Cross-section
 *
 * Every band sits at a fixed offset from ONE shared deck height, and each one
 * draws a skirt down to the band outside it. That is what turns four flat
 * ribbons into a built cross-section:
 *
 * ```
 *                 kerb +0.16 m   footway +0.15 m
 *   asphalt 0.00 ──┐┌──────────────────────────┐
 *   (gutter at the │┘ kerb face                 ╲  verge: a grass batter from
 *    kerb, painted)                               ╲ the footway down (or up) to
 *                                                  ╲ the ground as it is drawn
 * ```
 *
 * Small, real steps: a 15 cm precast kerb, the footway level with its top, the
 * gutter at the carriageway's own level. The verge used to be a flat band
 * 4 cm under the asphalt with a vertical skirt down to ground pulled 60 cm
 * below the road - a grass wall that made every road read as a thick slab laid
 * on the terrain. It now slopes from the footway's edge to the drawn terrain,
 * so nothing stands proud and no side of the mesh shows.
 *
 * Because every offset is measured from the same `RoadElevation`, two bands can
 * never disagree about where the road is — the defect that left steps and gaps
 * between the carriageway and its kerb.
 *
 * ## Per-class colour, in one mesh
 *
 * A residential street is grey and a boulevard is near-black, but they share a
 * junction and therefore a polygon. The class tint is written per VERTEX from
 * the nearest road, so one asphalt mesh carries every class and the colour
 * blends where two classes meet instead of stopping at an invented seam.
 */

/**
 * Longest triangle edge on a road at grade.
 *
 * This is NOT sized against the terrain's curvature. The deck reads a solved
 * profile whose every station has already been raised to clear the ground
 * within a window wider than this edge (`DILATE` in `world/elevation.ts`), so a
 * chord this long is guaranteed above the ground at both ends and everywhere
 * between them. The tessellation only has to be fine enough to SHADE well.
 */
const GROUND_MAX_EDGE = TERRAIN_CELL / 2;
/** A raised deck follows nothing, so it needs vertices only for its shading. */
const RAISED_MAX_EDGE = TERRAIN_CELL;

/**
 * What one build of the surfaces keeps for the next, so an edit rebuilds only
 * the tiles it reaches. Owned by the renderer; a build without it makes
 * everything afresh.
 */
export interface SurfaceReuse {
  /**
   * The tiles of the last build, per structural level, by digest: what
   * identifies each (`KeptTile`), not its arrays. DO NOT keep a tile's arrays
   * here: copied into its block's mesh and sent to the GPU, they were a second
   * copy of every road on the CPU (330 MB of a 1,280 m city's heap, 2026-10-15).
   */
  readonly tiles: Map<string, Map<number, KeptTile>>;
  /**
   * A digest of everything the height field and the texture frames read in a
   * rectangle: the solved roads near it and the ground under it, both as
   * shaped and as it naturally lies.
   */
  readonly dependsOn: (minX: number, minY: number, maxX: number, maxY: number) => number;
  /** The paint materials, by colour: made once, not on every rebuild. */
  readonly paint: Map<string, Material>;
  /**
   * The meshes of each block of tiles (`CHUNK` tiles a side), by pass,
   * surface and block, with the digests of the tiles they were merged from. A
   * block whose tiles are the same keeps its mesh and its buffers on the GPU;
   * one that changed is merged again, its tiles kept from before built again.
   * Owned by the cache: `disposeSurfaceReuse` frees them.
   */
  readonly chunks: Map<string, { readonly parts: readonly number[]; readonly mesh: Mesh }>;
  /** Block meshes replaced but maybe still drawn: freed by the owner once the new roads are in. */
  readonly retired?: Mesh[];
  /**
   * Tiles kept from an earlier session (`derivedCache.ts`), by `storedKey`:
   * a tile whose key comes round again is taken from here instead of built
   * (Unreal's Derived Data Cache: derived data made once, kept locally, and
   * made again whenever it is missing). Its key is everything the tile is
   * built from, so a kept tile is the tile a build would make.
   */
  readonly stored?: Map<string, TileBundle>;
  /**
   * Each tile built afresh, to be kept for a later session: called once its blocks are merged, when
   * nothing of the build reads its arrays any more - the keeper may take them (transfer them).
   */
  readonly keep?: (key: string, bundle: TileBundle) => void;
}

/** The name a tile is kept under between sessions: its pass and its digest. */
export const storedKey = (pass: string, digest: number): string => `${pass}|${digest}`;

/** Frees what a `SurfaceReuse` holds on the GPU. */
export function disposeSurfaceReuse(reuse: SurfaceReuse): void {
  for (const { mesh } of reuse.chunks?.values() ?? []) disposeMesh(mesh);
  reuse.chunks?.clear();
  for (const mesh of reuse.retired?.splice(0) ?? []) disposeMesh(mesh);
  for (const material of reuse.paint.values()) material.dispose();
}

/** Every surface of one tile, by mesh name. */
export type TileBundle = ReadonlyMap<string, Tile>;
/** A tile kept between builds: the names of the surfaces it has. Its digest is its key. */
export type KeptTile = readonly string[];

/** One tile of a pass in a build: its digest and block, its rings, its surfaces and arrays once known. */
interface PassTile {
  readonly value: number;
  readonly chunk: string;
  readonly rect: TileRect;
  readonly into: Reach;
  surfaces: KeptTile | null;
  bundle: TileBundle | null;
}

/** Whether a block's tiles are the ones its mesh was merged from, by digest. */
function sameTiles(parts: readonly number[], list: readonly PassTile[]): boolean {
  return parts.length === list.length && list.every((tile, i) => tile.value === parts[i]);
}

/**
 * One surface's tiles in a block, built again from their rings (a lost WebGL
 * context, `mesh/gpuOnly.ts`): only that surface, each tile read as it was.
 */
function surfaceSource(spec: SurfaceSpec, tiles: readonly { readonly rect: TileRect; readonly into: Reach }[],
  reading: <T>(work: () => T) => T): () => Tile[] {
  return () => tiles.map(({ rect, into }) =>
    reading(() => bundleOf(tileShapes(polysOf(into), rect, [tileSpecOf(spec)]), [spec]).get(spec.options.name)!));
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
  /**
   * Puts the blocks kept from the build before into `group`, at the swap.
   * A mesh has one parent (three.js `Object3D.add` takes it from the one it
   * had): added while the steps ran, each kept block left the roads still
   * drawn, and the streets showed as grass until the new ones took their
   * place - for as long as the job took, or longer when an edit overtook it.
   */
  adopt(): void;
  dispose(): void;
}

/**
 * World size of one tile.
 *
 * A road edit used to merge, cut and triangulate every band of the whole
 * network: a quarter of a million triangles and every polygon boolean, most of
 * the time a new road took to appear, and more on a bigger map. Everything is
 * now done a tile at a time from the rings that reach the tile, and a tile
 * whose rings and surroundings (`SurfaceReuse.dependsOn`) have not changed is
 * copied from the last build, so an edit pays for the tiles it reaches. A
 * multiple of the ground and deck spans (8 x 6 and 16 x 6), so a tile holds
 * whole pieces.
 */
const TILE = m(76.8);
/**
 * Where the tile grid starts. Off any round number, so no road drawn on a
 * round coordinate has its edge lie along a tile line, where it would be taken
 * for a cut and lose its kerb (`meshTile`).
 */
const TILE_ORIGIN = m(0.1484);
/** How far round a tile a ring may reach and still be read by it. */
const TILE_REACH = m(0.2);
const TILE_BIAS = 1 << 15;
/**
 * Tiles a side of one mesh. Every tile of the network used to be merged into
 * one mesh per surface on every edit and sent to the GPU whole - 50 to 80 MB
 * and a 400-850 ms frame for one short street in the default town
 * (docs/performance.md #9). A block of tiles is merged on its own, and kept
 * while its tiles are.
 */
const CHUNK = 4;
/**
 * Tiles a batch asked of the workers at once (`roadTilePool.ts`): enough to keep every worker busy
 * for a while, few enough that the shapes waiting to be read stay small.
 */
const SHAPE_BATCH = 64;

/** One ring of input, with its box and its digest, measured once per build. */
interface Input {
  readonly poly: Poly;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly digest: number;
}

function inputOf(poly: Poly): Input | null {
  const outer = poly[0];
  if (!outer || outer.length < 3) return null;
  const digest = new Digest();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of poly) {
    digest.add(ring.length);
    for (const point of ring) {
      const x = point[0] as number;
      const y = point[1] as number;
      digest.add(x).add(y);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { poly, minX, minY, maxX, maxY, digest: digest.value() };
}

/** Linear-space tints per road class, so the asphalt mesh can vary by class. */
const CLASS_TINT: readonly Color[] = ROAD_TYPES.map((type) =>
  new Color(type.color),
);
/** The tint the asphalt material is authored against, so 1.0 means "as baked". */
const TINT_REFERENCE = new Color(0x3a3d3f);
/** A carriageway's tone by what it is paved with (docs/VIAS.md V1); asphalt keeps its class's. */
const CARRIAGEWAY_TINT: Readonly<Record<Exclude<CarriagewayMaterial, 'asphalt'>, Color>> = {
  concrete: new Color(0x8f8d88),
  cobble: new Color(0x6a5f52),
};
/** A colour against the reference, channel by channel: the multiplier a vertex is tinted with. */
const againstReference = (tint: Color): [number, number, number] =>
  [tint.r / TINT_REFERENCE.r, tint.g / TINT_REFERENCE.g, tint.b / TINT_REFERENCE.b];
/** The carriageway's tints as a pass reads them (`PassDesc`): numbers, made once here with three's colour management. */
const CLASS_TINTS: readonly number[] = CLASS_TINT.flatMap(againstReference);
const REFERENCE_TINT = againstReference(TINT_REFERENCE);
const PAVING_TINTS: Readonly<Record<string, readonly [number, number, number]>> = Object.fromEntries(
  Object.entries(CARRIAGEWAY_TINT).map(([name, tint]) => [name, againstReference(tint)]));
/** What each surface of a tile is made from (`roadTileShape.ts`). */
type Source = TileSource;

/** Everything that reaches each tile, by kind, in input order. */
interface Reach {
  readonly levels: Record<'casing' | 'sidewalk' | 'curb' | 'asphalt', Input[]>;
  readonly medians: Record<'kerb' | 'planting' | 'paved', Input[]>;
  readonly ramps: Input[];
  readonly ribbons: Input[];
  readonly quads: Map<string, Input[]>;
}

/** One surface of a structural level: how it is meshed, and from what. */
interface SurfaceSpec {
  readonly source: Source;
  readonly options: Omit<SurfaceMeshOptions, 'polygons'>;
  readonly renderOrder?: number;
}

/** The road a surface reads beside the field, as a pass sees it (`RoadLook`): its paving, widths and mouths. */
function lookOf(net: Network, id: SegmentId): RoadLook | undefined {
  const ribbon = net.ribbons.get(id);
  if (!ribbon) return undefined;
  const trims = net.trims.get(id);
  const materials = ribbon.road.materials;
  return {
    width: ribbon.road.width,
    lane: laneWidth(ribbon.road),
    from: trims?.a[Level.Asphalt] ?? 0,
    to: ribbon.full.length - (trims?.b[Level.Asphalt] ?? 0),
    carriageway: materials?.carriageway,
    footwayLeft: materials?.footwayLeft,
    footwayRight: materials?.footwayRight,
  };
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

/**
 * `buildRoadSurfaces` in steps: it yields after each tile built and each block
 * merged, so the renderer can spread an edit's tiles over frames while the
 * roads as they were stay drawn (`renderer.ts`), as a city builder updates a
 * road's mesh behind the frame (docs/performance.md #10). With
 * `reuse.retired`, the meshes a block replaces are handed there, not freed:
 * the roads still drawn may hold them until the new ones take their place.
 */
export function* roadSurfaceSteps(
  net: Network,
  elevation: RoadElevation,
  materials: SceneMaterials,
  terrainAt: (x: number, y: number) => number,
  reuse?: SurfaceReuse,
  groundMaterial?: Material,
  /** Shapes the tiles off the page (`roadTilePool.ts`); then the steps yield 'wait' while it works. None: all here. */
  tiler?: RoadTiler | null,
): Generator<'wait' | void, RoadSurfaces, void> {
  const started = performance.now();
  let tilesMs = 0;
  let mergeMs = 0;
  let chunksMerged = 0;
  let chunksKept = 0;
  let remade = 0;
  const chunks = reuse?.chunks;
  const usedChunks = new Set<string>();
  // A block let go before its upload came is taken out of the queue first (`uploads.ts` `cancelWarm`):
  // drawn there anyway, its geometry went back to the GPU with no owner left to free it.
  const retire = (mesh: Mesh): void => { cancelWarm([mesh]); if (reuse?.retired) reuse.retired.push(mesh); else disposeMesh(mesh); };
  const group = new Group();
  group.name = 'road-network';
  const meshes: Mesh[] = [];
  let triangles = 0;
  let built = 0;
  let reused = 0;
  const rebuilt: TileRect[] = [];
  // Without a caller to own them, the paint materials belong to this build.
  const paint = reuse?.paint ?? new Map<string, Material>();
  const paintFor = (color: string): Material => {
    let material = paint.get(color);
    if (!material) {
      material = paintMaterial(color);
      paint.set(color, material);
    }
    return material;
  };

  const reading = <T>(work: () => T): T => elevation.remembering ? elevation.remembering(work) : work();
  const manual = (id: SegmentId): boolean => {
    const segment = net.doc.segment(id);
    return !!segment && (Math.abs(net.doc.node(segment.a)?.heightOffset ?? 0) > 1e-6 ||
      Math.abs(net.doc.node(segment.b)?.heightOffset ?? 0) > 1e-6);
  };
  // Roads at authored heights are drawn on their own, each from its own
  // deck, and those that run on from one another through a two-way node
  // as ONE surface: drawn a segment at a time, every piece of a road raised in
  // one stroke closed its ends, and the joins showed as lines and notched kerbs.
  const alignments = new Map<SegmentId, SegmentId[]>();
  {
    const owner = new Map<SegmentId, SegmentId>();
    const find = (id: SegmentId): SegmentId => {
      let r = id;
      while (owner.get(r) !== r) r = owner.get(r)!;
      return r;
    };
    const ids = [...net.doc.segments.keys()].filter(manual);
    for (const id of ids) owner.set(id, id);
    for (const node of net.doc.nodes.values()) {
      if (node.incident.length !== 2) continue;
      const [p, q] = node.incident as [SegmentId, SegmentId];
      // Bent or straight: a bend's junction plate belongs to the pass that
      // holds both its legs (`ownsJunction`), so it is drawn in the same surface.
      if (!owner.has(p) || !owner.has(q)) continue;
      const a = find(p), b = find(q);
      if (a !== b) owner.set(Math.max(a, b) as SegmentId, Math.min(a, b) as SegmentId);
    }
    for (const id of ids) {
      const root = find(id);
      const list = alignments.get(root);
      if (list) list.push(id); else alignments.set(root, [id]);
    }
  }
  const passes: { readonly id: string; readonly structure: RoadStructure; readonly segment?: SegmentId; readonly chain?: readonly SegmentId[] }[] = [
    ...ROAD_STRUCTURES.map((structure) => ({ id: structure.id, structure: structure.id })),
    ...[...alignments].map(([root, chain]) =>
      ({ id: `alignment-${root}`, structure: 'ground' as const, segment: root, chain })),
  ];
  if (reuse) {
    const current = new Set(passes.map((pass) => pass.id));
    for (const id of reuse.tiles.keys()) if (!current.has(id)) reuse.tiles.delete(id);
  }
  for (const pass of passes) {
    yield;
    const structure = roadStructure(pass.structure);
    const present = [...net.doc.segments.values()].some(
      (segment) => pass.chain !== undefined
        ? pass.chain.includes(segment.id)
        : segment.structure === structure.id && !manual(segment.id),
    );
    if (!present) {
      reuse?.tiles.delete(pass.id);
      continue;
    }

    const include = (id: SegmentId): boolean => pass.chain !== undefined
      ? pass.chain.includes(id)
      : !manual(id) && (net.doc.segment(id)?.structure ?? 'ground') === structure.id;
    const raised = pass.chain !== undefined
      ? pass.chain.some((id) => {
        const line = net.ribbons.get(id)?.full;
        if (!line) return false;
        for (let s = 0; s <= line.length; s += Math.max(4, line.length / 24)) {
          const p = line.sampleAt(s).p;
          if (elevation.onSegment(id, p.x, p.y) - terrainAt(p.x, p.y) > RAISED_LIFT) return true;
        }
        return false;
      })
      : isRaised(structure.id);
    const maxEdge = raised ? RAISED_MAX_EDGE : GROUND_MAX_EDGE;

    // The footways' outer edges (the union of every footway of this pass), each straight piece filed by
    // the cells of a grid its padded box covers, for the verge's fall (`roadSurfaceReads.ts` `fromFootway`).
    // DO NOT file whole rings: the union of a town's footways is one ring round the whole town (and one per
    // block), so every verge vertex measured a ring as long as the town's outline - 6.5 s of a 2,560 m city's
    // roads, six times the 1,280 m one's for four times the roads (2026-10-15). Only a distance under
    // CASING_BAND changes the batter (`vergeTop` clamps it), and a piece that near the point lies in its cell.
    let footwayEdges: Map<number, number[]> | null = null;
    const edges = (): Map<number, number[]> => {
      if (!footwayEdges) footwayEdges = footwayEdgeGrid(levelPolygons(net, Level.Sidewalk, include));
      return footwayEdges;
    };
    /** Each road's look, asked per vertex: made once a pass. */
    const looks = new Map<SegmentId, RoadLook | undefined>();
    const look = (id: SegmentId): RoadLook | undefined => {
      if (!looks.has(id)) looks.set(id, lookOf(net, id));
      return looks.get(id);
    };
    /** What this pass's surfaces read on the page: the network and the solved field (in a worker, `SurfaceData`). */
    const pageReads: SurfaceReads = {
      field: elevation,
      terrainAt,
      lineOf: (id) => net.ribbons.get(id)?.full,
      look,
      footwayShare: (x, y) => footwayRiseShare(net, x, y),
      walkingRise: (x, y, at) => walkingRise(net, x, y, true, at),
      footwayEdges: (key) => edges().get(key),
    };

    // ---------------------------------------------------------------- inputs
    const levels: Record<'casing' | 'sidewalk' | 'curb' | 'asphalt', Input[]> = {
      casing: inputsOf(levelRings(net, Level.Casing as SurfaceLevel, include)),
      sidewalk: inputsOf(levelRings(net, Level.Sidewalk as SurfaceLevel, include)),
      curb: inputsOf(levelRings(net, Level.Curb as SurfaceLevel, include)),
      asphalt: inputsOf(levelRings(net, Level.Asphalt as SurfaceLevel, include)),
    };
    const strips = medianStrips(net, include);
    const medians = { kerb: inputsOf(strips.kerb), planting: inputsOf(strips.planting), paved: inputsOf(strips.paved) };
    // No dropped kerb on a footway laid flush: there is no kerb to drop.
    const ramps = inputsOf(curbRamps(net).filter((r) => include(r.segment) && footwayRiseShare(net, r.x + r.nx * r.run, r.y + r.ny * r.run) > 0)
      .map((r) => [rampOutline(r)]));
    // The pass's inputs, the crossings' footway and the markings in steps of
    // their own: together they were one step of ~20 ms after a road edit in the
    // test city, past the slice (`renderer.ts` `pumpWorld`, P3).
    yield;
    // Paint belongs to the road legs, not to the shared intersection interior,
    // so it is clipped to the ribbons' carriageway alone.
    const ribbonAsphalt: Input[] = [];
    for (const ribbon of net.ribbons.values()) {
      if (!include(ribbon.id)) continue;
      const ring = ribbon.rings[Level.Asphalt];
      if (!ring || ring.isEmpty) continue;
      const input = inputOf([ring.flatten().map((point) => [point.x, point.y])]);
      if (input) ribbonAsphalt.push(input);
    }
    // ...and to the tapers where a road carries on at another width, whose lane
    // lines and edge lines run on through them (see transitionMarkings).
    for (const node of net.transitions) {
      const junction = net.junctions.get(node)?.get(Level.Asphalt as SurfaceLevel);
      const leg = junction?.legs[0];
      if (!junction || !leg || !include(leg.seg)) continue;
      const input = inputOf([junction.ring.flatten().map((point) => [point.x, point.y])]);
      if (input) ribbonAsphalt.push(input);
    }
    // ...and to a mini-roundabout's plate, where its island is painted (docs/VIAS.md V5).
    for (const node of net.doc.nodes.values()) {
      if (node.control !== 'mini' || node.incident.length < 3) continue;
      const junction = net.junctions.get(node.id)?.get(Level.Asphalt as SurfaceLevel);
      if (!junction || !node.incident.some((seg) => include(seg))) continue;
      const input = inputOf([junction.ring.flatten().map((point) => [point.x, point.y])]);
      if (input) ribbonAsphalt.push(input);
    }
    yield;
    net.crossingSurface();
    yield;
    const quads = new Map<string, Input[]>();
    for (const [color, rings] of markingQuads(net, include, structure.id === 'ground')) quads.set(color, inputsOf(rings.map((ring) => [ring])));
    /** The pass as its surfaces read it, plain data: the same on the page and in a worker (`roadSurfaceReads.ts`). */
    const desc: PassDesc = {
      id: pass.id,
      structure: structure.id,
      ...(pass.segment !== undefined ? { segment: pass.segment } : {}),
      ...(pass.chain !== undefined ? { chain: pass.chain } : {}),
      rootType: pass.segment === undefined ? 0 : net.doc.segment(pass.segment)?.type ?? 0,
      raised,
      maxEdge,
      groundMaterial: groundMaterial !== undefined,
      scale: { asphalt: materials.scale.asphalt, footway: materials.scale.footway, kerb: materials.scale.kerb, verge: materials.scale.verge, deck: materials.scale.deck },
      paint: [...quads.keys()],
      paintLift: 0.02 + PAINT_RISE,
      classTint: CLASS_TINTS,
      referenceTint: REFERENCE_TINT,
      pavingTint: PAVING_TINTS,
    };
    const specs = passSurfaces(desc, pageReads).map((read) => dress(read, raised, materials, groundMaterial, paintFor));

    // ----------------------------------------------------------------- tiles
    const reach = new Map<number, Reach>();
    const reachOf = (key: number): Reach => {
      let value = reach.get(key);
      if (!value) {
        value = {
          levels: { casing: [], sidewalk: [], curb: [], asphalt: [] },
          medians: { kerb: [], planting: [], paved: [] },
          ramps: [],
          ribbons: [],
          quads: new Map(),
        };
        reach.set(key, value);
      }
      return value;
    };
    const file = (input: Input, add: (into: Reach) => void): void => {
      const x0 = Math.floor((input.minX - TILE_REACH - TILE_ORIGIN) / TILE);
      const x1 = Math.floor((input.maxX + TILE_REACH - TILE_ORIGIN) / TILE);
      const y0 = Math.floor((input.minY - TILE_REACH - TILE_ORIGIN) / TILE);
      const y1 = Math.floor((input.maxY + TILE_REACH - TILE_ORIGIN) / TILE);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) add(reachOf((ix + TILE_BIAS) * 0x1_0000 + (iy + TILE_BIAS)));
      }
    };
    yield;
    for (const name of ['casing', 'sidewalk', 'curb', 'asphalt'] as const) {
      for (const input of levels[name]) file(input, (into) => into.levels[name].push(input));
    }
    for (const name of ['kerb', 'planting', 'paved'] as const) {
      for (const input of medians[name]) file(input, (into) => into.medians[name].push(input));
    }
    for (const input of ramps) file(input, (into) => into.ramps.push(input));
    for (const input of ribbonAsphalt) file(input, (into) => into.ribbons.push(input));
    for (const [color, list] of quads) {
      for (const input of list) {
        file(input, (into) => {
          const bucket = into.quads.get(color);
          if (bucket) bucket.push(input);
          else into.quads.set(color, [input]);
        });
      }
    }

    // Everything a tile's build reads besides its rings and its surroundings:
    // the constants of every surface, so a change to one is a change to all.
    // A paint colour's surface draws only in the tiles that hold lines of that
    // colour, so its constants are in those tiles' keys alone: in every key,
    // a road of a class with a colour new to the map (its centre line) made
    // every tile of the town build again, a second's stall for one street.
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

    const previous = reuse?.tiles.get(pass.id);
    const kept = new Map<number, KeptTile>();
    /** The tiles in tile order: kept from before (its surfaces known, its arrays not), read from the store, or to build. */
    const tiles: PassTile[] = [];
    // In tile order, so a mesh is laid out the same however it was reached.
    for (const key of [...reach.keys()].sort((a, b) => a - b)) {
      const into = reach.get(key)!;
      const ix = Math.floor(key / 0x1_0000) - TILE_BIAS;
      const iy = (key % 0x1_0000) - TILE_BIAS;
      const rect: TileRect = [
        ix * TILE + TILE_ORIGIN, iy * TILE + TILE_ORIGIN, (ix + 1) * TILE + TILE_ORIGIN, (iy + 1) * TILE + TILE_ORIGIN,
      ];
      const digest = new Digest().add(saltValue).add(key);
      const addAll = (list: readonly Input[]): void => {
        digest.add(list.length);
        for (const input of list) digest.add(input.digest);
      };
      addAll(into.levels.casing);
      addAll(into.levels.sidewalk);
      addAll(into.levels.curb);
      addAll(into.levels.asphalt);
      addAll(into.medians.kerb);
      addAll(into.medians.planting);
      // Only when there is any, so the keys of maps without a paved median are as before.
      if (into.medians.paved.length) addAll(into.medians.paved);
      addAll(into.ramps);
      addAll(into.ribbons);
      // In a fixed order: the colours come in the order the network first
      // paints them, which a street drawn elsewhere can change, and what a
      // tile builds does not depend on it (its surfaces are kept by name).
      for (const color of [...into.quads.keys()].sort()) {
        digest.addText(color).add(paintSalt.get(color) ?? 0);
        addAll(into.quads.get(color)!);
      }
      if (reuse) digest.add(reuse.dependsOn(rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1));
      const value = digest.value();
      const surfaces = previous?.get(value);
      const stored = surfaces ? undefined : reuse?.stored?.get(storedKey(pass.id, value));
      const chunk = `${Math.floor(ix / CHUNK)},${Math.floor(iy / CHUNK)}`;
      tiles.push({ value, chunk, rect, into, surfaces: surfaces ?? (stored ? [...stored.keys()] : null), bundle: stored ?? null });
      if (surfaces || stored) {
        reused++;
        // A step too: the digests of every tile kept, back to back, were a
        // slice of 20-30 ms after a road edit (docs/performance.md #34).
        yield;
      }
    }
    /**
     * The roads a share of the tiles reads, for a worker (`roadTileMesh.ts`): the solved profiles near
     * them and the alignment's chain, their looks, the flush footways and dropped kerbs filed there and
     * the footways' edges in their cells - only what a vertex of those tiles can read, never the map's.
     */
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
            if (edges().has(key)) edgeKeys.add(key);
          }
        }
      }
      const flush = packFlush(net, around);
      transfer.push(...flush.transfer);
      const edgeLists = [...edgeKeys].map((key) => Float64Array.from(edges().get(key)!));
      const joined = concat(edgeLists);
      const edgeData = { keys: Float64Array.from(edgeKeys), ends: joined.lineEnds, xy: joined.lines };
      for (const array of [edgeData.keys, edgeData.ends, edgeData.xy]) transfer.push(array.buffer as ArrayBuffer);
      return { data: { field, looks: lookList, flush: flush.data, ramps: [...ramps], edges: edgeData }, transfer };
    };
    /**
     * Builds `list`'s tiles, each handed to `done`: made whole by the workers when there are some
     * (`roadTilePool.ts`) - shaped and each vertex read there, over the roads near them handed over -
     * while this thread draws; the page only takes the arrays. DO NOT cut, triangulate or read the
     * vertices of a city's tiles on the page: the whole of its roads' build (2026-10-15).
     */
    const offPage = tiler && elevation.fieldFor ? tiler : null;
    const buildAll = function* (list: readonly PassTile[], done: (tile: PassTile) => void): Generator<'wait' | void, void, void> {
      /** Asks the tiler for `SHAPE_BATCH` tiles from `from` on; the answer lands in the record it returns. */
      const ask = (from: number): { readonly from: number; readonly answer: { tiles?: Map<string, Tile>[]; failed?: boolean } } => {
        const answer: { tiles?: Map<string, Tile>[]; failed?: boolean } = {};
        const request: TileJob = {
          pass: desc,
          tiles: list.slice(from, from + SHAPE_BATCH).map((t) => ({ rect: t.rect, into: polysOf(t.into) })),
          dataFor,
          terrainAt,
        };
        offPage!.tiles(request).then(
          (tiles) => { answer.tiles = tiles; },
          (error: unknown) => { console.warn('[roads] the road tile workers failed; the tiles are built on the page', error); answer.failed = true; },
        );
        return { from, answer };
      };
      // A batch at a time, the next asked before this one is taken: the workers make it while the page
      // merges this one. DO NOT ask for every tile at once: a whole city's tiles held together, before
      // any was merged, took the page past 7 GB (2026-10-15).
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
          // Made off the page: taken as it is. Else built here, every point of the tile remembered while
          // its vertices are read (`RoadElevation.remembering`).
          const bundle = made ? made[k - from]! : reading(() => buildTile(tile.into, tile.rect, specs));
          tile.bundle = bundle;
          tile.surfaces = [...bundle.keys()];
          tilesMs += performance.now() - tileAt;
          done(tile);
          yield;
        }
      }
    };
    /** The tiles built afresh this pass: kept for a later session once merged (below). */
    const fresh: PassTile[] = [];
    yield* buildAll(tiles.filter((t) => t.surfaces === null), (tile) => {
      built++;
      rebuilt.push(tile.rect);
      fresh.push(tile);
    });
    for (const tile of tiles) kept.set(tile.value, tile.surfaces!);
    reuse?.tiles.set(pass.id, kept);

    /** Each surface's tiles, by block of tiles, in tile order. */
    const parts = new Map<string, Map<string, PassTile[]>>();
    for (const spec of specs) parts.set(spec.options.name, new Map());
    for (const tile of tiles) {
      for (const name of tile.surfaces!) {
        const blocks = parts.get(name);
        if (!blocks) continue;
        const list = blocks.get(tile.chunk);
        if (list) list.push(tile);
        else blocks.set(tile.chunk, [tile]);
      }
    }
    // A block keeps its mesh while its tiles are the same (by digest). One that changed is merged
    // again from the arrays of all its tiles: those kept from before hold none (`KeptTile`), and are
    // built again from their rings - the tiles that made the mesh on the GPU, made the same way.
    const keyOf = (spec: SurfaceSpec, chunk: string): string =>
      `${pass.id}|${spec.options.name}|${chunk}|${spec.options.material.uuid}|${spec.renderOrder ?? ''}`;
    const again = new Set<PassTile>();
    for (const spec of specs) {
      for (const [chunk, list] of parts.get(spec.options.name) ?? []) {
        const known = chunks?.get(keyOf(spec, chunk));
        if (known && sameTiles(known.parts, list)) continue;
        for (const tile of list) if (!tile.bundle) again.add(tile);
      }
    }
    yield* buildAll([...again], () => { remade++; });

    const mergeAt = performance.now();
    for (const spec of specs) {
      for (const [chunk, list] of parts.get(spec.options.name) ?? []) {
        const key = keyOf(spec, chunk);
        const known = chunks?.get(key);
        let mesh: Mesh | null;
        // A lost WebGL context puts the arrays back from this build's rings (`gpuOnly`), the block's
        // tiles built again for this surface alone. DO NOT let the mesh hold its tiles for it: a
        // second copy of every road on the GPU, kept on the CPU (81 MB of a 1,280 m city).
        const source = surfaceSource(spec, list.map((tile) => ({ rect: tile.rect, into: tile.into })), reading);
        if (known && sameTiles(known.parts, list)) {
          mesh = known.mesh;
          // Bound to this build's rings: the build that made it lets go of its own.
          tilesOnGpu(mesh, source);
          chunksKept++;
        } else {
          if (known) retire(known.mesh);
          mesh = mergeTiles(list.map((tile) => tile.bundle!.get(spec.options.name)!), spec.options, source);
          if (mesh && spec.renderOrder !== undefined) mesh.renderOrder = spec.renderOrder;
          // Sent to the GPU ahead, a few a frame (`warmLooseAhead`), so its arrays let go at once
          // (`mesh/gpuOnly.ts`). DO NOT wait for the camera to frame it: a block out of view was never
          // uploaded and kept its copy on the CPU - 476 MB of a 2 560 m city's heap (asphalt, footway,
          // kerb, verge, kerb ramps; 2026-10-15), and the whole map's would not fit a tab.
          if (mesh) void warmLooseAhead([mesh]);
          if (mesh) chunks?.set(key, { parts: list.map((tile) => tile.value), mesh });
          else chunks?.delete(key);
          chunksMerged++;
          yield;
        }
        if (!mesh) continue;
        usedChunks.add(key);
        // A kept block stays where it is drawn until the swap (`adopt`).
        if (mesh.parent === null) group.add(mesh);
        meshes.push(mesh);
        triangles += (mesh.geometry.index?.count ?? 0) / 3;
      }
    }
    // The tiles' arrays go with `tiles` here: copied into the blocks, which send them to the GPU.
    mergeMs += performance.now() - mergeAt;
    // Kept for a later session only now, every block merged: nothing here reads a tile's arrays after
    // this, so the keeper may hand them to another thread instead of copying them (`renderer.ts` keep).
    for (const tile of fresh) reuse?.keep?.(storedKey(pass.id, tile.value), tile.bundle!);
  }
  // Blocks no surface has any more.
  if (chunks) for (const [key, { mesh }] of chunks) if (!usedChunks.has(key)) { retire(mesh); chunks.delete(key); }
  // Where an edit's time went (`hitch:` entries, scripts/probe-hitches.mjs; docs/performance.md).
  const end = performance.now();
  performance.measure(`hitch:road-edit/surfaces ${built} tiles built ${reused} kept ${remade} remade, ${chunksMerged} blocks merged ${chunksKept} kept: tiles ${tilesMs.toFixed(0)} ms, merge ${mergeMs.toFixed(0)} ms`, { start: started, end });
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
      for (const mesh of meshes) group.add(mesh);
    },
    dispose() {
      // Meshes the cache keeps are freed by `disposeSurfaceReuse`.
      if (!chunks) for (const mesh of meshes) disposeMesh(mesh);
      group.clear();
      if (!reuse) for (const material of paint.values()) material.dispose();
    },
  };
}

function inputsOf(polys: readonly Poly[]): Input[] {
  const out: Input[] = [];
  for (const poly of polys) {
    const input = inputOf(poly);
    if (input) out.push(input);
  }
  return out;
}

/**
 * The footways' outline as straight pieces filed by the cells of `FOOTWAY_EDGE_CELL` their box,
 * padded by twice `CASING_BAND`, covers: four numbers a piece (`roadSurfaceReads.ts` `fromFootway`).
 */
function footwayEdgeGrid(polys: Iterable<Poly>): Map<number, number[]> {
  const grid = new Map<number, number[]>();
  const pad = CASING_BAND * 2;
  for (const poly of polys) for (const ring of poly) {
    if (ring.length < 3) continue;
    for (let i = 0; i < ring.length; i++) {
      const ax = ring[i]![0]!, ay = ring[i]![1]!;
      const bx = ring[(i + 1) % ring.length]![0]!, by = ring[(i + 1) % ring.length]![1]!;
      for (let cx = Math.floor((Math.min(ax, bx) - pad) / FOOTWAY_EDGE_CELL); cx <= Math.floor((Math.max(ax, bx) + pad) / FOOTWAY_EDGE_CELL); cx++) {
        for (let cy = Math.floor((Math.min(ay, by) - pad) / FOOTWAY_EDGE_CELL); cy <= Math.floor((Math.max(ay, by) + pad) / FOOTWAY_EDGE_CELL); cy++) {
          const key = (cx + 32768) * 65536 + (cy + 32768);
          const list = grid.get(key);
          if (list) list.push(ax, ay, bx, by); else grid.set(key, [ax, ay, bx, by]);
        }
      }
    }
  }
  return grid;
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

/** A surface as the page draws it: what it reads (`passSurfaces`) with its material and shadows. */
function dress(read: SurfaceRead, raised: boolean, materials: SceneMaterials, groundMaterial: Material | undefined,
  paintFor: (color: string) => Material): SurfaceSpec {
  const source = read.source;
  if (source.kind === 'paint') {
    return { source, options: { ...read.options, material: paintFor(source.color), receiveShadow: true }, renderOrder: 3 };
  }
  if (source.kind === 'median') {
    const material = source.part === 'kerb' ? materials.kerb : source.part === 'planting' ? materials.verge : materials.footway;
    return { source, options: { ...read.options, material, receiveShadow: true } };
  }
  switch (source.band) {
    case 'verge':
      return { source, options: { ...read.options, material: raised ? materials.deck : groundMaterial ?? materials.verge, castShadow: raised, receiveShadow: true } };
    case 'footway':
    case 'curbRamp':
      return { source, options: { ...read.options, material: materials.footway, castShadow: raised, receiveShadow: true } };
    case 'kerb':
      return { source, options: { ...read.options, material: materials.kerb, receiveShadow: true } };
    case 'asphalt':
      return { source, options: { ...read.options, material: raised ? materials.asphaltRaised : materials.asphalt, castShadow: raised, receiveShadow: true } };
  }
}

/**
 * Every surface of one tile, from the rings that reach it: merged, banded and
 * clipped exactly as the whole network would be, then cut to the tile.
 */
function buildTile(into: Reach, rect: TileRect, specs: readonly SurfaceSpec[]): TileBundle {
  return bundleOf(tileShapes(polysOf(into), rect, specs.map(tileSpecOf)), specs);
}

/** A tile's surfaces from their shapes, each vertex read here (`meshTileShape`): a tile the page builds itself (a worker makes its own, `roadTileMesh.ts`). */
function bundleOf(shapes: ReadonlyMap<string, SurfaceShape>, specs: readonly SurfaceSpec[]): TileBundle {
  const bundle = new Map<string, Tile>();
  for (const spec of specs) {
    const shape = shapes.get(spec.options.name);
    if (shape) bundle.set(spec.options.name, meshTileShape(shape, spec.options));
  }
  return bundle;
}


/** A tile's rings without their digests: what its shapes are cut from. */
function polysOf(into: Reach): TilePolys {
  const polys = (list: readonly Input[]): Poly[] => list.map((input) => input.poly);
  return {
    levels: { casing: polys(into.levels.casing), sidewalk: polys(into.levels.sidewalk), curb: polys(into.levels.curb), asphalt: polys(into.levels.asphalt) },
    medians: { kerb: polys(into.medians.kerb), planting: polys(into.medians.planting), paved: polys(into.medians.paved) },
    ramps: polys(into.ramps),
    ribbons: polys(into.ribbons),
    quads: new Map([...into.quads].map(([color, list]) => [color, polys(list)])),
  };
}

/**
 * The central reservation's outlines, as two real polygons rather than as paint.
 *
 * It used to be drawn as two overlapping marking strokes at the same height —
 * a wide kerb colour with a narrower green inside it — which put two coplanar
 * surfaces in the depth buffer and produced the torn green scribble a player
 * photographed down the middle of every boulevard. A median is not paint: it is
 * a kerbed island with something growing in it, so it is built like one, with
 * its own height and its own skirt.
 *
 * Clipped against the carriageway so it can never leak past the kerb line, and
 * unioned so two medians meeting at a junction are one shape rather than two
 * overlapping ones - both a tile at a time, in `buildRoadSurfaces`.
 */
function medianStrips(
  net: Network,
  include: (segment: SegmentId) => boolean,
): { kerb: Poly[]; planting: Poly[]; paved: Poly[] } {
  const kerb: Poly[] = [];
  const planting: Poly[] = [];
  const paved: Poly[] = [];
  for (const ribbon of net.ribbons.values()) {
    if (!include(ribbon.id)) continue;
    const median = ribbon.road.median;
    // A median painted on the carriageway has no kerb and no island (docs/VIAS.md V1).
    if (median <= 0 || ribbon.road.medianFlush) continue;
    const centre = ribbon.centre[Level.Asphalt];
    if (!centre || centre.n < 2) continue;
    // The island's nose stands back of each crossing (`world/landscape.ts`
    // medianNose): measured from the node, the centre line starting at the mouth.
    const seg = net.doc.segment(ribbon.id);
    const back = (node: NodeId | undefined, from: { x: number; y: number }): number => {
      const at = node === undefined ? null : net.doc.node(node);
      const nose = node === undefined || !at ? 0 : medianNose(net, ribbon.id, node);
      return nose > 0 && at ? Math.max(0, nose - Math.hypot(from.x - at.x, from.y - at.y)) : 0;
    };
    const s0 = back(seg?.a, centre.point(0)), s1 = centre.length - back(seg?.b, centre.point(centre.n - 1));
    if (s1 - s0 < m(1)) continue;
    const points = s0 > 0 || s1 < centre.length ? centre.sub(s0, s1).toPoints() : centre.toPoints();
    // The kerb stone round the island, as wide as the footway's (`CURB_BAND`).
    kerb.push(strip(points, median / 2 + CURB_BAND));
    // Grass by default; paved in concrete or pavers when the profile says so.
    const material = ribbon.road.materials?.median;
    (material && material !== 'grass' ? paved : planting).push(strip(points, median / 2));
  }
  return { kerb, planting, paved };
}

/** A closed ribbon `half` wide either side of a centreline. */
function strip(points: readonly { x: number; y: number }[], half: number): MultiPoly[number] {
  const left = offsetPolyline(points, half);
  const right = offsetPolyline(points, -half).reverse();
  return [[...left, ...right].map((p) => [p.x, p.y])];
}
