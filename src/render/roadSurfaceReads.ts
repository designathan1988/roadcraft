import type { Polyline } from '@core/polyline';
import { EPS } from '@core/scalar';
import type { SegmentId } from '@world/ids';
import type { RoadReads } from '@world/roadField';
import { CASING_BAND, CURB_BAND, FOOTWAY_RISE } from '@world/roadTypes';
import type { FootwayMaterial } from '@world/roadSection';
import { roadStructure, type RoadStructure } from '@world/structures';
import { m } from '@world/units';
import type { HeightFn, TileMeshOptions, TintFn, UvFn, UvFrameFn } from './mesh/tileMesh';
import type { TileSource, TileSpec } from './roadTileShape';
import { FOOTWAY_TINT } from './roadTones';

/** WHAT EACH SURFACE OF A ROAD PASS READS PER VERTEX (`roadSurfaces.ts`) */

/** Height of the kerb face above the carriageway. */
const KERB_RISE = FOOTWAY_RISE + m(0.01);
/** Depth of the verge below the carriageway, where the grass starts. */
const VERGE_DROP = m(0.04);
/** Drop of the verge skirt into the ground. */
const VERGE_SKIRT = 0.5;
/** The verge meets the drawn terrain this far BELOW it */
const VERGE_LIFT = -m(0.08);
/** World size of one UV unit on the ground verge when it wears the terrain's material (and a retaining wall's backfill, `structures.ts`). */
export const TERRAIN_UV = 64;
/** A dropped kerb's triangles: its slope is 1.8 m long, its flares 1.5 m. */
const RAMP_MAX_EDGE = m(0.75);
/** Height of the median island's kerb above the carriageway: the footway's kerb (15 cm). */
const MEDIAN_KERB = FOOTWAY_RISE;
/** Height of the planting inside it: the soil a hair over the kerb's top, so the two are never one plane. */
const MEDIAN_PLANTING = FOOTWAY_RISE + m(0.02);
/** Slabs in a footway panel along a bend: a joint every this many tiles (`surfaceFrameAt`). */
const FOOTWAY_PANEL_TILES = 2;
/** The grid the footways' outer edges are filed by for the verge's fall (`fromFootway`). */
export const FOOTWAY_EDGE_CELL = m(32);
/** The key of a cell of that grid. */
const footwayEdgeCell = (x: number, y: number): number =>
  (Math.floor(x / FOOTWAY_EDGE_CELL) + 32768) * 65536 + (Math.floor(y / FOOTWAY_EDGE_CELL) + 32768);

/** A road pass as its surfaces are read (`roadSurfaceSteps`): plain data, handed to a worker as it is. */
export interface PassDesc {
  readonly id: string;
  readonly structure: RoadStructure;
  /** An alignment's root segment and its chain, for a pass of roads at authored heights. */
  readonly segment?: SegmentId;
  readonly chain?: readonly SegmentId[];
  /** The type of the root segment's road as the document has it (0 when it has none). */
  readonly rootType: number;
  readonly raised: boolean;
  readonly maxEdge: number;
  /** Whether the ground verge wears the terrain's own material (its UV in world x, y). */
  readonly groundMaterial: boolean;
  /** World size of one texture tile of each material. */
  readonly scale: { readonly asphalt: number; readonly footway: number; readonly kerb: number; readonly verge: number; readonly deck: number };
  /** The paint's colours, in the order the network paints them, and its height over the deck. */
  readonly paint: readonly string[];
  readonly paintLift: number;
  /** The carriageway's tints against the colour its texture was baked at, made on the page (three's colour management) */
  readonly classTint: readonly number[];
  readonly referenceTint: readonly [number, number, number];
  readonly pavingTint: Readonly<Record<string, readonly [number, number, number]>>;
}

/** What a surface reads of a road beside the field: its paving, widths and its carriageway's span between its mouths. */
export interface RoadLook {
  readonly width: number;
  /** One lane's width (`laneWidth`). */
  readonly lane: number;
  /** The carriageway between its junction mouths, arc length along the road. */
  readonly from: number;
  readonly to: number;
  readonly carriageway?: string | undefined;
  readonly footwayLeft?: FootwayMaterial | undefined;
  readonly footwayRight?: FootwayMaterial | undefined;
}

/** Everything a pass's surfaces read besides the point: on the page the network's, in a worker the roads handed to it. */
export interface SurfaceReads {
  readonly field: RoadReads;
  /** The ground as it is drawn. */
  terrainAt(x: number, y: number): number;
  /** A road's centreline (an alignment's chain, `segmentAt`). */
  lineOf(id: SegmentId): Polyline | undefined;
  /** A road's look; undefined for one without a ribbon. */
  look(id: SegmentId): RoadLook | undefined;
  /** The share of `FOOTWAY_RISE` the footway stands at (`footwayRiseShare`). */
  footwayShare(x: number, y: number): number;
  /** The walking surface's share of it over a dropped kerb (`walkingRise`, on a footway). */
  walkingRise(x: number, y: number, structure: string): number;
  /** The footways' outer edges of the pass, by cell (`footwayEdgeCell`): four numbers an edge. */
  footwayEdges(key: number): ArrayLike<number> | undefined;
}

/** One surface of a pass: what its shape is cut from and what each vertex reads. */
export interface SurfaceRead {
  readonly source: TileSource;
  readonly options: TileMeshOptions & { readonly name: string; readonly maxEdge: number };
  /** Its top or bottom reads the ground at its every vertex (`SurfaceReads.terrainAt`). */
  readonly ground?: boolean;
}

/** What a surface's shape is made from (`roadTileShape.ts`). */
export const tileSpecOf = (spec: SurfaceRead): TileSpec =>
  ({ name: spec.options.name, source: spec.source, maxEdge: spec.options.maxEdge, skirts: spec.options.bottom !== undefined });

const offset = (base: HeightFn, amount: number): HeightFn => (x, y) => base(x, y) + amount;

/** The surfaces of a pass, outermost first, then its paint in the network's order. */
export function passSurfaces(pass: PassDesc, reads: SurfaceReads): SurfaceRead[] {
  const { field } = reads;
  const only: ReadonlySet<RoadStructure> = new Set([pass.structure]);
  const raised = pass.raised;
  const maxEdge = pass.maxEdge;
  const chainHit = { s: 0, distance: 0 };
  /** The segment of the pass a point belongs to: the one whose centreline is nearest. */
  const segmentAt = (x: number, y: number): SegmentId => {
    const chain = pass.chain!;
    if (chain.length === 1) return chain[0]!;
    let best = chain[0]!, bestD = Infinity;
    for (const id of chain) {
      const line = reads.lineOf(id);
      if (line) line.closestInto(x, y, chainHit);
      const d = line ? chainHit.distance : Infinity;
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  };

  /** The single deck height every band of this structure is measured from. */
  const deck: HeightFn = pass.segment !== undefined
    ? (x, y) => field.onSegment(segmentAt(x, y), x, y)
    : (x, y) => field.at(x, y, only, false);
  /** Underside of the whole structure — the soffit of a deck, or the ground. */
  const depth = roadStructure(pass.segment === undefined ? pass.structure : 'elevated').deck;
  const soffit: HeightFn = raised
    ? (x, y) => deck(x, y) - depth - FOOTWAY_RISE
    : (x, y) => Math.min(deck(x, y) - VERGE_SKIRT, reads.terrainAt(x, y) - 0.2);

  /** A vertex's frame read into one object (`surfaceFrameInto`): DO NOT make one a vertex. */
  const at = { along: 0, across: 0 };
  const frameFor = (tile: number, panel?: number): UvFrameFn => (x, y, pickX, pickY, out) => {
    const segment = pass.segment === undefined ? undefined : segmentAt(pickX, pickY);
    const frame = field.surfaceFrameInto
      ? field.surfaceFrameInto(x, y, only, pickX, pickY, pass.segment !== undefined, segment, panel, at)
      : field.surfaceFrameAt(x, y, only, pickX, pickY, pass.segment !== undefined, segment, panel);
    out[0] = frame.across / tile;
    out[1] = frame.along / tile;
  };
  /** Road-framed UVs, with every triangle kept inside one road's frame. */
  const uvFor = (tile: number, panel?: number): { uv: UvFn; uvFrame: UvFrameFn; uvWorld: number } => {
    const uvFrame = frameFor(tile, panel);
    return { uv: (x, y, out) => uvFrame(x, y, x, y, out), uvFrame, uvWorld: tile };
  };

  /** The carriageway's tint, taken from the class of the nearest road and normalised against the colour the asphalt texture */
  const asphaltTint: TintFn = (x, y, out) => {
    const sample = pass.segment === undefined ? field.roadAt(x, y, only, false) : null;
    const type = sample ? sample.type : pass.rootType;
    // A carriageway paved with something else than the class's asphalt takes that material's tone.
    const segment = sample ? sample.segment : segmentAt(x, y);
    const look = segment === undefined ? undefined : reads.look(segment);
    let material = look?.carriageway;
    // Between its junction mouths only
    if (material && sample && look) {
      if (sample.along < look.from || sample.along > look.to) material = undefined;
    }
    const paving = material && material !== 'asphalt' ? pass.pavingTint[material] : undefined;
    if (paving) { out[0] = paving[0]; out[1] = paving[1]; out[2] = paving[2]; return; }
    const classes = pass.classTint;
    if (type >= 0 && type * 3 < classes.length) { out[0] = classes[type * 3]!; out[1] = classes[type * 3 + 1]!; out[2] = classes[type * 3 + 2]!; return; }
    out[0] = pass.referenceTint[0]; out[1] = pass.referenceTint[1]; out[2] = pass.referenceTint[2];
  };

  const suffix = pass.id === 'ground' ? '' : `-${pass.id}`;

  /** A point's place in the carriageway's cross-section, for the marks of its use (`mesh/roadEdges.ts`) */
  const asphaltSection: TintFn = (x, y, out) => {
    const sample = field.roadAt(x, y, only, pass.segment !== undefined);
    const look = sample.segment === undefined ? undefined : reads.look(sample.segment);
    if (!look || sample.along < look.from || sample.along > look.to) { out[0] = 0; out[1] = -1; out[2] = 0; return; }
    out[0] = sample.across;
    out[1] = look.width / 2;
    out[2] = look.lane;
  };
  /** A point's place across the footway: metres from the kerb's back, and the footway's width to the lot. */
  const footwaySection: TintFn = (x, y, out) => {
    const sample = field.roadAt(x, y, only, pass.segment !== undefined);
    const look = sample.segment === undefined ? undefined : reads.look(sample.segment);
    if (!look) { out[0] = 0; out[1] = -1; out[2] = 0; return; }
    const side = sample.across >= 0 ? sample.sidewalkLeft : sample.sidewalkRight;
    out[0] = Math.abs(sample.across) - look.width / 2 - CURB_BAND;
    out[1] = Math.max(m(0.5), (side ?? sample.sidewalk ?? m(2)) - CURB_BAND);
    out[2] = 1;
  };

  /** The footway's tone: its side's material on the road nearest the point. */
  const footwayTint: TintFn = (x, y, out) => {
    const sample = field.roadAt(x, y, only, pass.segment !== undefined);
    const look = sample.segment === undefined ? undefined : reads.look(sample.segment);
    const material = look ? (sample.across >= 0 ? look.footwayLeft : look.footwayRight) : undefined;
    const tint = FOOTWAY_TINT[material ?? 'pavers'];
    out[0] = tint[0]; out[1] = tint[1]; out[2] = tint[2];
  };
  /** Where the footway stands: a kerb's rise over the carriageway, or level with it where it is laid flush. */
  const footwayTop: HeightFn = (x, y) => deck(x, y) + FOOTWAY_RISE * reads.footwayShare(x, y);

  /** The verge on the ground: from the footway's edge, at the footway's height, down */
  // The batter's fall is measured from the footway's OUTER EDGE as drawn
  const fromFootway = (x: number, y: number): number => {
    const list = reads.footwayEdges(footwayEdgeCell(x, y));
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
    return footway + (reads.terrainAt(x, y) + VERGE_LIFT - footway) * ease;
  };

  const terrainUv = (x: number, y: number, out: number[] | Float32Array): void => { out[0] = x / TERRAIN_UV; out[1] = y / TERRAIN_UV; };
  // Outermost first, so a nearer band's skirt lands on the one outside it.
  const specs: SurfaceRead[] = [
    {
      source: { kind: 'band', band: 'verge' },
      ground: !raised,
      options: {
        name: `verge${suffix}`,
        top: raised ? offset(deck, -VERGE_DROP) : vergeTop,
        bottom: soffit,
        maxEdge,
        // On the terrain's material the batter takes the terrain plane's UV frame (world x, y)
        ...(raised || !pass.groundMaterial ? uvFor(raised ? pass.scale.deck : pass.scale.verge) : {
          uv: terrainUv,
          uvFrame: (x: number, y: number, _px: number, _py: number, out: number[] | Float32Array) => terrainUv(x, y, out),
          uvWorld: TERRAIN_UV,
        }),
        skirtUvScale: raised ? pass.scale.deck : pass.scale.verge,
      },
    },
    {
      source: { kind: 'band', band: 'footway' },
      options: {
        name: `footway${suffix}`,
        top: footwayTop,
        // On the ground the footway's own edge goes down into the terrain: there is no verge band outside it.
        bottom: raised ? offset(deck, -VERGE_DROP) : offset(deck, -VERGE_SKIRT),
        maxEdge,
        // Laid at its true length on each line along a bend, a joint every few slabs
        ...uvFor(pass.scale.footway, pass.scale.footway * FOOTWAY_PANEL_TILES),
        tint: footwayTint,
        section: footwaySection,
        skirtUvScale: pass.scale.footway,
      },
    },
    {
      // The dropped kerbs at the zebras (`world/curbRamps.ts`)
      source: { kind: 'band', band: 'curbRamp' },
      options: {
        name: `curb-ramp${suffix}`,
        top: (x, y) => deck(x, y) + FOOTWAY_RISE * reads.footwayShare(x, y) * reads.walkingRise(x, y, pass.structure),
        bottom: raised ? offset(deck, -VERGE_DROP) : offset(deck, -VERGE_SKIRT),
        maxEdge: RAMP_MAX_EDGE,
        ...uvFor(pass.scale.footway),
        skirtUvScale: pass.scale.footway,
      },
    },
    {
      source: { kind: 'band', band: 'kerb' },
      options: {
        name: `kerb${suffix}`,
        top: offset(deck, KERB_RISE),
        bottom: deck,
        maxEdge,
        ...uvFor(pass.scale.kerb),
        skirtUvScale: pass.scale.kerb,
      },
    },
    {
      source: { kind: 'band', band: 'asphalt' },
      options: {
        name: `asphalt${suffix}`,
        top: deck,
        ...(raised ? { bottom: soffit } : {}),
        maxEdge,
        ...uvFor(pass.scale.asphalt),
        tint: asphaltTint,
        section: asphaltSection,
        skirtUvScale: pass.scale.deck,
      },
    },
    {
      source: { kind: 'median', part: 'kerb' },
      options: {
        name: `median-kerb${suffix}`,
        top: offset(deck, MEDIAN_KERB),
        bottom: deck,
        maxEdge,
        ...uvFor(pass.scale.kerb),
        skirtUvScale: pass.scale.kerb,
      },
    },
    {
      source: { kind: 'median', part: 'planting' },
      options: {
        name: `median-planting${suffix}`,
        top: offset(deck, MEDIAN_PLANTING),
        bottom: offset(deck, MEDIAN_KERB),
        maxEdge,
        ...uvFor(pass.scale.verge),
        skirtUvScale: pass.scale.kerb,
      },
    },
    {
      // A median paved instead of planted: the footway's paving at the planting's height.
      source: { kind: 'median', part: 'paved' },
      options: {
        name: `median-paved${suffix}`,
        top: offset(deck, MEDIAN_PLANTING),
        bottom: offset(deck, MEDIAN_KERB),
        maxEdge,
        ...uvFor(pass.scale.footway),
        skirtUvScale: pass.scale.kerb,
      },
    },
  ];
  for (const color of pass.paint) {
    specs.push({
      source: { kind: 'paint', color },
      options: {
        name: `markings-${color.slice(1)}${suffix}`,
        top: offset(deck, pass.paintLift),
        // Paint follows the road it is painted on
        maxEdge: 5,
        uv: (x, y, out) => {
          out[0] = x / 12;
          out[1] = y / 12;
        },
      },
    });
  }
  return specs;
}
