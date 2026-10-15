import { Color, Group, type Material, type Mesh } from 'three';

import type { MultiPoly, Poly } from '@core/clipper';
import { Digest } from '@core/digest';
import { offsetPolyline } from '@core/offset';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { CASING_BAND, CURB_BAND, FOOTWAY_RISE, Level, ROAD_TYPES, type SurfaceLevel, laneWidth } from '@world/roadTypes';
import type { CarriagewayMaterial, FootwayMaterial } from '@world/roadSection';
import { footwayRiseAt, footwayRiseShare } from '@world/roads/footwayRise';
import { levelPolygons, levelRings } from '@world/surfaces';
import { curbRamps, rampOutline, walkingRise } from '@world/curbRamps';
import { EPS } from '@core/scalar';
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
import { type TilePolys, type TileSource, type TileSpec, tileShapes } from './roadTileShape';
import type { RoadTiler } from './roadTilePool';
import type { SurfaceShape } from './mesh/tileShape';
import {
  disposeMesh,
  meshTileShape,
  type HeightFn,
  type SurfaceMeshOptions,
  type Tile,
  type TileRect,
  type TintFn,
  type UvFn,
  type UvFrameFn,
} from './mesh/surfaceMesh';

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
 * Height of the kerb face above the carriageway.
 *
 * A hair ABOVE the footway rather than a hair below it. At 0.34 the kerb sat
 * 0.02 under the footway and read as part of it: nothing on screen said where
 * the kerb was. Standing 0.04 proud, its inner arris catches the light and
 * throws a line of shade, and the granite kerb reads as a separate edge.
 */
const KERB_RISE = FOOTWAY_RISE + m(0.01);
/** Depth of the verge below the carriageway, where the grass starts. */
const VERGE_DROP = m(0.04);
/**
 * Drop of the verge skirt into the ground.
 *
 * Small, because the ground is now shaped to meet the road (`shapeAt` in
 * `world/elevation.ts`): the embankment is real terrain with a forty-five unit
 * batter, not a vertical face hung off the edge of the surface. This is only
 * the seal that stops a hairline of sky showing under the rim.
 */
const VERGE_SKIRT = 0.5;
/**
 * The verge meets the drawn terrain this far BELOW it: the lawn closes over
 * the batter's outer edge, so no rim of the batter (and no dark line of its
 * skirt) shows where the two meet. Both wear the terrain's material.
 */
const VERGE_LIFT = -m(0.08);
/** World size of one UV unit on the ground verge when it wears the terrain's material (and a retaining wall's backfill, `structures.ts`). */
export const TERRAIN_UV = 64;

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
/**
 * A dropped kerb's triangles: its slope is 1.8 m long, its flares 1.5 m. The
 * slope is a plane (rise linear along it), which a few triangles carry
 * exactly: at 0.3 m the ramps of a large city were 2.4 million triangles,
 * more than every window frame in it (measured 2026-10-09).
 */
const RAMP_MAX_EDGE = m(0.75);
/** A raised deck follows nothing, so it needs vertices only for its shading. */
const RAISED_MAX_EDGE = TERRAIN_CELL;

/**
 * Height of the median island's kerb above the carriageway: the footway's
 * kerb (15 cm). Written as bare numbers of the old 0.4 m unit, it stood 40 cm
 * high, the grass 62 cm, and a band of stone 70 cm wide ran either side - a
 * promenade, not a kerb (the player, 2026-10-13: "meio fio ridículo").
 */
const MEDIAN_KERB = FOOTWAY_RISE;
/** Height of the planting inside it: the soil a hair over the kerb's top, so the two are never one plane. */
const MEDIAN_PLANTING = FOOTWAY_RISE + m(0.02);

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
  /** Each tile built afresh, to be kept for a later session. */
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

const offset = (base: HeightFn, amount: number): HeightFn => (x, y) => base(x, y) + amount;

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
/** A footway's tone over the baked pavers, by material, linear multipliers. */
const FOOTWAY_TINT: Readonly<Record<FootwayMaterial, readonly [number, number, number]>> = {
  pavers: [1, 1, 1],
  concrete: [1.08, 1.08, 1.1],
  stone: [1, 0.84, 0.66],
};
/** Slabs in a footway panel along a bend: a joint every this many tiles (`surfaceFrameAt`). */
const FOOTWAY_PANEL_TILES = 2;

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

    const only: ReadonlySet<RoadStructure> = new Set([structure.id]);
    const include = (id: SegmentId): boolean => pass.chain !== undefined
      ? pass.chain.includes(id)
      : !manual(id) && (net.doc.segment(id)?.structure ?? 'ground') === structure.id;
    const chainHit = { s: 0, distance: 0 };
    /** The segment of the pass a point belongs to: the one whose centreline is nearest. */
    const segmentAt = (x: number, y: number): SegmentId => {
      const chain = pass.chain!;
      if (chain.length === 1) return chain[0]!;
      let best = chain[0]!, bestD = Infinity;
      for (const id of chain) {
        const line = net.ribbons.get(id)?.full;
        if (line) line.closestInto(x, y, chainHit);
        const d = line ? chainHit.distance : Infinity;
        if (d < bestD) { bestD = d; best = id; }
      }
      return best;
    };
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

    /** The single deck height every band of this structure is measured from. */
    const deck: HeightFn = pass.segment !== undefined
      ? (x, y) => elevation.onSegment(segmentAt(x, y), x, y)
      : (x, y) => elevation.at(x, y, only, false);
    /** Underside of the whole structure — the soffit of a deck, or the ground. */
    const soffit: HeightFn = raised
      ? (x, y) => deck(x, y) - roadStructure(pass.segment === undefined ? structure.id : 'elevated').deck - FOOTWAY_RISE
      : (x, y) => Math.min(deck(x, y) - VERGE_SKIRT, terrainAt(x, y) - 0.2);

    const frameFor = (tile: number, panel?: number): UvFrameFn => (x, y, pickX, pickY, out) => {
      const frame = elevation.surfaceFrameAt(x, y, only, pickX, pickY,
        pass.segment !== undefined, pass.segment === undefined ? undefined : segmentAt(pickX, pickY), panel);
      out[0] = frame.across / tile;
      out[1] = frame.along / tile;
    };
    /** Road-framed UVs, with every triangle kept inside one road's frame. */
    const uvFor = (tile: number, panel?: number): { uv: UvFn; uvFrame: UvFrameFn; uvWorld: number } => {
      const uvFrame = frameFor(tile, panel);
      return { uv: (x, y, out) => uvFrame(x, y, x, y, out), uvFrame, uvWorld: tile };
    };

    /**
     * The carriageway's tint, taken from the class of the nearest road and
     * normalised against the colour the asphalt texture was baked at — so the
     * reference class comes out exactly as authored and the others shift from
     * it rather than being multiplied twice.
     */
    const asphaltTint: TintFn = (x, y, out) => {
      const sample = pass.segment === undefined ? elevation.roadAt(x, y, only, false) : null;
      const type = sample ? sample.type : net.doc.segment(pass.segment!)?.type ?? 0;
      // A carriageway paved with something else than the class's asphalt
      // (docs/VIAS.md V1) takes that material's tone.
      const segment = sample ? sample.segment : segmentAt(x, y);
      let material = segment === undefined ? undefined : net.ribbons.get(segment)?.road.materials?.carriageway;
      // Between its junction mouths only: the junction plate keeps the class's
      // asphalt, and the paving changes at the mouth line, as it is laid.
      if (material && sample && segment !== undefined) {
        const ribbon = net.ribbons.get(segment)!;
        const trims = net.trims.get(segment);
        const from = trims?.a[Level.Asphalt] ?? 0, to = ribbon.full.length - (trims?.b[Level.Asphalt] ?? 0);
        if (sample.along < from || sample.along > to) material = undefined;
      }
      const tint = material && material !== 'asphalt' ? CARRIAGEWAY_TINT[material] : CLASS_TINT[type] ?? TINT_REFERENCE;
      out[0] = tint.r / TINT_REFERENCE.r;
      out[1] = tint.g / TINT_REFERENCE.g;
      out[2] = tint.b / TINT_REFERENCE.b;
    };

    const suffix = pass.id === 'ground' ? '' : `-${pass.id}`;

    /**
     * A point's place in the carriageway's cross-section, for the marks of
     * its use (`mesh/roadEdges.ts`): signed offset across, half its width
     * kerb to kerb, a lane's width. None on a junction's plate, where no one
     * lane runs.
     */
    const asphaltSection: TintFn = (x, y, out) => {
      const sample = elevation.roadAt(x, y, only, pass.segment !== undefined);
      const ribbon = sample.segment === undefined ? undefined : net.ribbons.get(sample.segment);
      const trims = sample.segment === undefined ? undefined : net.trims.get(sample.segment);
      const from = trims?.a[Level.Asphalt] ?? 0, to = ribbon ? ribbon.full.length - (trims?.b[Level.Asphalt] ?? 0) : 0;
      if (!ribbon || sample.along < from || sample.along > to) { out[0] = 0; out[1] = -1; out[2] = 0; return; }
      out[0] = sample.across;
      out[1] = ribbon.road.width / 2;
      out[2] = laneWidth(ribbon.road);
    };
    /** A point's place across the footway: metres from the kerb's back, and the footway's width to the lot. */
    const footwaySection: TintFn = (x, y, out) => {
      const sample = elevation.roadAt(x, y, only, pass.segment !== undefined);
      const ribbon = sample.segment === undefined ? undefined : net.ribbons.get(sample.segment);
      if (!ribbon) { out[0] = 0; out[1] = -1; out[2] = 0; return; }
      const side = sample.across >= 0 ? sample.sidewalkLeft : sample.sidewalkRight;
      out[0] = Math.abs(sample.across) - ribbon.road.width / 2 - CURB_BAND;
      out[1] = Math.max(m(0.5), (side ?? sample.sidewalk ?? m(2)) - CURB_BAND);
      out[2] = 1;
    };

    /** The footway's tone: its side's material on the road nearest the point (docs/VIAS.md V1). */
    const footwayTint: TintFn = (x, y, out) => {
      const sample = elevation.roadAt(x, y, only, pass.segment !== undefined);
      const road = sample.segment === undefined ? undefined : net.ribbons.get(sample.segment)?.road;
      const materials = road?.materials;
      const material = materials ? (sample.across >= 0 ? materials.footwayLeft : materials.footwayRight) : undefined;
      const tint = FOOTWAY_TINT[material ?? 'pavers'];
      out[0] = tint[0]; out[1] = tint[1]; out[2] = tint[2];
    };
    /** Where the footway stands: a kerb's rise over the carriageway, or level with it where it is laid flush. */
    const footwayTop: HeightFn = (x, y) => deck(x, y) + footwayRiseAt(net, x, y);

    /**
     * The verge on the ground: from the footway's edge, at the footway's
     * height, down (or up) to the terrain as it is drawn at the verge's outer
     * edge - a batter, not a wall. Read off the nearest road's own section.
     */
    // The batter's fall is measured from the footway's OUTER EDGE as drawn
    // (the union of every footway of this pass), not across the nearest
    // road's centreline: round a junction's corner the nearest leg's
    // centreline is far off, and the batter started at the bottom - a grey
    // wall of footway skirt under the corner's paving.
    // Each straight piece of the outline filed by the cells of a grid its
    // padded box covers: a point measures only the pieces within reach of its
    // cell. DO NOT file whole rings: the union of a town's footways is one ring
    // round the whole town (and one per block), so every verge vertex measured
    // a ring as long as the town's outline - 6.5 s of a 2,560 m city's roads,
    // six times the 1,280 m one's for four times the roads (2026-10-15). Only a
    // distance under CASING_BAND changes the batter (`vergeTop` clamps it), and
    // a piece that near the point lies in its cell: the answer is the same.
    let footwayEdges: Map<number, number[]> | null = null;
    const pad = CASING_BAND * 2;
    const edgeCell = (x: number, y: number): number => (Math.floor(x / FOOTWAY_EDGE_CELL) + 32768) * 65536 + (Math.floor(y / FOOTWAY_EDGE_CELL) + 32768);
    const edges = (): Map<number, number[]> => {
      if (!footwayEdges) {
        footwayEdges = new Map();
        for (const poly of levelPolygons(net, Level.Sidewalk, include)) for (const ring of poly) {
          if (ring.length < 3) continue;
          for (let i = 0; i < ring.length; i++) {
            const ax = ring[i]![0]!, ay = ring[i]![1]!;
            const bx = ring[(i + 1) % ring.length]![0]!, by = ring[(i + 1) % ring.length]![1]!;
            for (let cx = Math.floor((Math.min(ax, bx) - pad) / FOOTWAY_EDGE_CELL); cx <= Math.floor((Math.max(ax, bx) + pad) / FOOTWAY_EDGE_CELL); cx++) {
              for (let cy = Math.floor((Math.min(ay, by) - pad) / FOOTWAY_EDGE_CELL); cy <= Math.floor((Math.max(ay, by) + pad) / FOOTWAY_EDGE_CELL); cy++) {
                const key = (cx + 32768) * 65536 + (cy + 32768);
                const list = footwayEdges.get(key);
                if (list) list.push(ax, ay, bx, by); else footwayEdges.set(key, [ax, ay, bx, by]);
              }
            }
          }
        }
      }
      return footwayEdges;
    };
    const fromFootway = (x: number, y: number): number => {
      const list = edges().get(edgeCell(x, y));
      if (!list) return Infinity;
      // `Polyline.nearestSegment`'s arithmetic, in its order: the same nearest distance, bit for bit.
      let bestSq = Infinity;
      for (let k = 0; k < list.length; k += 4) {
        const ax = list[k]!, ay = list[k + 1]!;
        const abx = list[k + 2]! - ax, aby = list[k + 3]! - ay;
        const l2 = abx * abx + aby * aby;
        let qx = ax, qy = ay;
        if (l2 >= EPS) {
          let t = ((x - ax) * abx + (y - ay) * aby) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          qx = ax + abx * t;
          qy = ay + aby * t;
        }
        const ex = x - qx, ey = y - qy;
        const distSq = ex * ex + ey * ey;
        if (distSq < bestSq) bestSq = distSq;
      }
      return Math.sqrt(bestSq);
    };
    const vergeTop: HeightFn = (x, y) => {
      const footway = deck(x, y) + FOOTWAY_RISE;
      const t = Math.min(1, Math.max(0, fromFootway(x, y) / CASING_BAND));
      const ease = t * t * (3 - 2 * t);
      return footway + (terrainAt(x, y) + VERGE_LIFT - footway) * ease;
    };

    // Outermost first, so a nearer band's skirt lands on the one outside it.
    //
    // The ground verge - the batter from the footway's edge down to the
    // terrain - is drawn with the TERRAIN's own material when the renderer
    // passes it (`groundMaterial`). The terrain shader textures by world
    // position, so the batter is the lawn itself rising to the pavement: no
    // strip of a second green along every footway (the player's order of
    // 2026-10-05, "nunca colocar essa manta verde"), and no wall either -
    // the terrain alone cannot reach the footway's height, being a 6.4 m grid
    // that would lift through the asphalt of a kerb return.
    const allSpecs: SurfaceSpec[] = [
      {
        source: { kind: 'band', band: 'verge' },
        options: {
          name: `verge${suffix}`,
          top: raised ? offset(deck, -VERGE_DROP) : vergeTop,
          bottom: soffit,
          material: raised ? materials.deck : groundMaterial ?? materials.verge,
          maxEdge,
          // On the terrain's material the batter takes the terrain plane's UV
          // frame (world x, y): its normal map is read off UV derivatives, and
          // a road-framed UV turned the lawn's relief and lit it as a second green.
          ...(raised || !groundMaterial ? uvFor(raised ? materials.scale.deck : materials.scale.verge) : {
            uv: (x: number, y: number, out: number[] | Float32Array) => { out[0] = x / TERRAIN_UV; out[1] = y / TERRAIN_UV; },
            uvFrame: (x: number, y: number, _px: number, _py: number, out: number[] | Float32Array) => { out[0] = x / TERRAIN_UV; out[1] = y / TERRAIN_UV; },
            uvWorld: TERRAIN_UV,
          }),
          castShadow: raised,
          receiveShadow: true,
          skirtUvScale: raised ? materials.scale.deck : materials.scale.verge,
        },
      },
      {
        source: { kind: 'band', band: 'footway' },
        options: {
          name: `footway${suffix}`,
          top: footwayTop,
          // On the ground the footway's own edge goes down into the terrain:
          // there is no verge band outside it (see `specs` below).
          bottom: raised ? offset(deck, -VERGE_DROP) : offset(deck, -VERGE_SKIRT),
          material: materials.footway,
          maxEdge,
          // Laid at its true length on each line along a bend, a joint every
          // few slabs (`surfaceFrameAt`, panels), so pavers keep their size.
          ...uvFor(materials.scale.footway, materials.scale.footway * FOOTWAY_PANEL_TILES),
          tint: footwayTint,
          section: footwaySection,
          castShadow: raised,
          receiveShadow: true,
          skirtUvScale: materials.scale.footway,
        },
      },
      {
        // The dropped kerbs at the zebras (`world/curbRamps.ts`): the footway
        // and its kerb sloping down to the carriageway, at the height the
        // walkers on it read (`walkingRise`). Fine triangles, as the slope is
        // a metre and a half long.
        source: { kind: 'band', band: 'curbRamp' },
        options: {
          name: `curb-ramp${suffix}`,
          top: (x, y) => deck(x, y) + footwayRiseAt(net, x, y) * walkingRise(net, x, y, true, structure.id),
          bottom: raised ? offset(deck, -VERGE_DROP) : offset(deck, -VERGE_SKIRT),
          material: materials.footway,
          maxEdge: RAMP_MAX_EDGE,
          ...uvFor(materials.scale.footway),
          castShadow: raised,
          receiveShadow: true,
          skirtUvScale: materials.scale.footway,
        },
      },
      {
        source: { kind: 'band', band: 'kerb' },
        options: {
          name: `kerb${suffix}`,
          top: offset(deck, KERB_RISE),
          bottom: deck,
          material: materials.kerb,
          maxEdge,
          ...uvFor(materials.scale.kerb),
          receiveShadow: true,
          skirtUvScale: materials.scale.kerb,
        },
      },
      {
        source: { kind: 'band', band: 'asphalt' },
        options: {
          name: `asphalt${suffix}`,
          top: deck,
          ...(raised ? { bottom: soffit } : {}),
          material: raised ? materials.asphaltRaised : materials.asphalt,
          maxEdge,
          ...uvFor(materials.scale.asphalt),
          tint: asphaltTint,
          section: asphaltSection,
          castShadow: raised,
          receiveShadow: true,
          skirtUvScale: materials.scale.deck,
        },
      },
      {
        source: { kind: 'median', part: 'kerb' },
        options: {
          name: `median-kerb${suffix}`,
          top: offset(deck, MEDIAN_KERB),
          bottom: deck,
          material: materials.kerb,
          maxEdge,
          ...uvFor(materials.scale.kerb),
          receiveShadow: true,
          skirtUvScale: materials.scale.kerb,
        },
      },
      {
        source: { kind: 'median', part: 'planting' },
        options: {
          name: `median-planting${suffix}`,
          top: offset(deck, MEDIAN_PLANTING),
          bottom: offset(deck, MEDIAN_KERB),
          material: materials.verge,
          maxEdge,
          ...uvFor(materials.scale.verge),
          receiveShadow: true,
          skirtUvScale: materials.scale.kerb,
        },
      },
      {
        // A median paved instead of planted (docs/VIAS.md V1): the footway's
        // paving at the planting's height.
        source: { kind: 'median', part: 'paved' },
        options: {
          name: `median-paved${suffix}`,
          top: offset(deck, MEDIAN_PLANTING),
          bottom: offset(deck, MEDIAN_KERB),
          material: materials.footway,
          maxEdge,
          ...uvFor(materials.scale.footway),
          receiveShadow: true,
          skirtUvScale: materials.scale.kerb,
        },
      },
    ];
    const specs = allSpecs;

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
    for (const [color, rings] of markingQuads(net, include, structure.id === 'ground')) {
      quads.set(color, inputsOf(rings.map((ring) => [ring])));
      specs.push({
        source: { kind: 'paint', color },
        options: {
          name: `markings-${color.slice(1)}${suffix}`,
          top: offset(deck, 0.02 + PAINT_RISE),
          material: paintFor(color),
          // Paint follows the road it is painted on, so it needs the same vertex
          // density the deck has or it floats over a crest and sinks into a dip.
          maxEdge: 5,
          uv: (x, y, out) => {
            out[0] = x / 12;
            out[1] = y / 12;
          },
          receiveShadow: true,
        },
        renderOrder: 3,
      });
    }

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
    const tileSpecs = specs.map(tileSpecOf);
    /**
     * Builds `list`'s tiles, each handed to `done`: shaped by the workers when there are some
     * (`roadTilePool.ts`), the same shapes the page makes, while this thread draws; each vertex read
     * here after. DO NOT cut and triangulate a city's tiles on the page: two thirds of its roads'
     * build (2026-10-15).
     */
    const buildAll = function* (list: readonly PassTile[], done: (tile: PassTile) => void): Generator<'wait' | void, void, void> {
      /** Asks the tiler for the shapes of `SHAPE_BATCH` tiles from `from` on; the answer lands in the record it returns. */
      const ask = (from: number): { readonly from: number; readonly answer: { shapes?: Map<string, SurfaceShape>[]; failed?: boolean } } => {
        const answer: { shapes?: Map<string, SurfaceShape>[]; failed?: boolean } = {};
        tiler!.shapes(list.slice(from, from + SHAPE_BATCH).map((t) => ({ rect: t.rect, into: polysOf(t.into) })), tileSpecs).then(
          (shapes) => { answer.shapes = shapes; },
          (error: unknown) => { console.warn('[roads] the road tile workers failed; the tiles are built on the page', error); answer.failed = true; },
        );
        return { from, answer };
      };
      // A batch at a time, the next asked before this one is read: the workers shape it while the page
      // reads the heights of this one. DO NOT ask for every tile at once: the shapes of a whole city held
      // together, before any was read, took the page past 7 GB (2026-10-15).
      let job = tiler && list.length ? ask(0) : null;
      let failed = false;
      for (let from = 0; from < list.length; from += SHAPE_BATCH) {
        let shaped: Map<string, SurfaceShape>[] | null = null;
        if (job && !failed) {
          while (!job.answer.shapes && !job.answer.failed) { tiler!.check(); yield 'wait'; }
          shaped = job.answer.shapes ?? null;
          if (!shaped) failed = true;
          job = !failed && from + SHAPE_BATCH < list.length ? ask(from + SHAPE_BATCH) : null;
        }
        for (let k = from; k < Math.min(list.length, from + SHAPE_BATCH); k++) {
          const tile = list[k]!;
          const tileAt = performance.now();
          // Every point of the tile remembered while its vertices are read (`RoadElevation.remembering`).
          const bundle = reading(() => shaped ? bundleOf(shaped[k - from]!, specs) : buildTile(tile.into, tile.rect, specs));
          tile.bundle = bundle;
          tile.surfaces = [...bundle.keys()];
          tilesMs += performance.now() - tileAt;
          done(tile);
          yield;
        }
      }
    };
    yield* buildAll(tiles.filter((t) => t.surfaces === null), (tile) => {
      built++;
      rebuilt.push(tile.rect);
      reuse?.keep?.(storedKey(pass.id, tile.value), tile.bundle!);
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
 * Every surface of one tile, from the rings that reach it: merged, banded and
 * clipped exactly as the whole network would be, then cut to the tile.
 */
/** The grid the footways' outer edges are filed by for the verge's fall (`fromFootway`). */
const FOOTWAY_EDGE_CELL = m(32);

function buildTile(into: Reach, rect: TileRect, specs: readonly SurfaceSpec[]): TileBundle {
  return bundleOf(tileShapes(polysOf(into), rect, specs.map(tileSpecOf)), specs);
}

/** A tile's surfaces from their shapes (made here, or by a worker): each vertex read here (`meshTileShape`). */
function bundleOf(shapes: ReadonlyMap<string, SurfaceShape>, specs: readonly SurfaceSpec[]): TileBundle {
  const bundle = new Map<string, Tile>();
  for (const spec of specs) {
    const shape = shapes.get(spec.options.name);
    if (shape) bundle.set(spec.options.name, meshTileShape(shape, spec.options));
  }
  return bundle;
}

/** What a surface's shape is made from (`roadTileShape.ts`). */
const tileSpecOf = (spec: SurfaceSpec): TileSpec =>
  ({ name: spec.options.name, source: spec.source, maxEdge: spec.options.maxEdge, skirts: spec.options.bottom !== undefined });

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
