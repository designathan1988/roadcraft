import type { Poly } from '@core/clipper';
import type { SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import type { RoadReads } from '@world/roadField';
import { Level, laneWidth } from '@world/roadTypes';
import { footwayRiseShare } from '@world/roads/footwayRise';
import { walkingRise } from '@world/curbRamps';
import { RAISED_LIFT, isRaised, roadStructure } from '@world/structures';
import { RELIEF_FLAT } from '@world/terrain';
import type { Input } from './roadSurfaceRings';
import type { Reach, SurfaceInputs, SurfacePass } from './roadSurfaceInputs';
import type { PassDesc, RoadLook, SurfaceReads } from './roadSurfaceReads';
import { tileSpecOf } from './roadSurfaceReads';
import { type TilePolys, type TileSource, tileShapes } from './roadTileShape';
import { type Tile, type TileMeshOptions, meshTileShape } from './mesh/tileMesh';
import type { TileRect } from './mesh/tileShape';
import { PAINT_RISE } from './paintQuads';
import { TERRAIN_CELL } from './terrainGrid';

/** ONE PASS OF THE ROADS' SURFACES AS PLAIN DATA (`roadSurfaces.ts` on the page, `nearRoadTiles.ts` in a worker): what it reads, how it is described and each of its tiles' surfaces, the same code on both sides */

/** Longest triangle edge on a road at grade. */
export const GROUND_MAX_EDGE = TERRAIN_CELL / 2;
/** A raised deck follows nothing, so it needs vertices only for its shading. */
export const RAISED_MAX_EDGE = TERRAIN_CELL;
/** Whether a road at grade has ground to follow: on a new map's level ground (`RELIEF_FLAT`, no stamp) it follows nothing either, and is laid as a deck is (`RAISED_MAX_EDGE`). DO NOT refine it to half a terrain cell there: a large city's streets drew 6 M triangles of a flat plane, a quarter of the frame's (2026-10-20). */
const followsGround = (net: Network): boolean => net.doc.terrainRelief !== RELIEF_FLAT || net.doc.terrainStamps.length > 0;

/** The page's constants a pass is drawn with: its materials' texture scales, whether the ground verge wears the terrain's material, the carriageway's tints (made on the page with three's colour management); numbers, handed to a worker as they are. */
export interface PassLook {
  readonly groundMaterial: boolean;
  readonly scale: PassDesc['scale'];
  readonly classTint: readonly number[];
  readonly referenceTint: readonly [number, number, number];
  readonly pavingTint: Readonly<Record<string, readonly [number, number, number]>>;
}

/** The road a surface reads beside the field, as a pass sees it (`RoadLook`): its paving, widths and mouths. */
export function lookOf(net: Network, id: SegmentId): RoadLook | undefined {
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

/** Whether a pass is drawn as a raised deck: an alignment lifted by hand where some point of its roads stands a structure's lift over the ground; a structural level by its kind. */
export function passRaised(net: Network, pass: SurfacePass, elevation: Pick<RoadReads, 'onSegment'>, terrainAt: (x: number, y: number) => number): boolean {
  if (pass.chain === undefined) return isRaised(roadStructure(pass.structure).id);
  return pass.chain.some((id) => {
    const line = net.ribbons.get(id)?.full;
    if (!line) return false;
    for (let s = 0; s <= line.length; s += Math.max(4, line.length / 24)) {
      const p = line.sampleAt(s).p;
      if (elevation.onSegment(id, p.x, p.y) - terrainAt(p.x, p.y) > RAISED_LIFT) return true;
    }
    return false;
  });
}

/** What a pass's surfaces read where the network is at hand (the page's, or a worker's own): the solved field, the ground as drawn, each road's look and line, the footways' rise and edges (made once a pass). */
export function passReads(net: Network, elevation: RoadReads, terrainAt: (x: number, y: number) => number, inputs: SurfaceInputs, passId: string): SurfaceReads {
  // DO NOT merge every footway of the pass: the union of a town's footways is one ring round the whole town
  const footwayEdges = new Map<number, number[] | undefined>();
  const edgesAt = (key: number): number[] | undefined => {
    if (!footwayEdges.has(key)) footwayEdges.set(key, inputs.footwayEdges(passId, key));
    return footwayEdges.get(key);
  };
  /** Each road's look, asked per vertex: made once a pass. */
  const looks = new Map<SegmentId, RoadLook | undefined>();
  const look = (id: SegmentId): RoadLook | undefined => {
    if (!looks.has(id)) looks.set(id, lookOf(net, id));
    return looks.get(id);
  };
  return {
    field: elevation,
    terrainAt,
    lineOf: (id) => net.ribbons.get(id)?.full,
    look,
    footwayShare: (x, y) => footwayRiseShare(net, x, y),
    walkingRise: (x, y, at) => walkingRise(net, x, y, true, at),
    footwayEdges: edgesAt,
  };
}

/** The pass as its surfaces read it, plain data: the same on the page and in a worker (`roadSurfaceReads.ts`). */
export function passDesc(net: Network, pass: SurfacePass, raised: boolean, look: PassLook, paint: readonly string[]): PassDesc {
  const structure = roadStructure(pass.structure);
  return {
    id: pass.id,
    structure: structure.id,
    ...(pass.segment !== undefined ? { segment: pass.segment } : {}),
    ...(pass.chain !== undefined ? { chain: pass.chain } : {}),
    rootType: pass.segment === undefined ? 0 : net.doc.segment(pass.segment)?.type ?? 0,
    raised,
    maxEdge: raised || !followsGround(net) ? RAISED_MAX_EDGE : GROUND_MAX_EDGE,
    groundMaterial: look.groundMaterial,
    scale: { asphalt: look.scale.asphalt, footway: look.scale.footway, kerb: look.scale.kerb, verge: look.scale.verge, deck: look.scale.deck },
    paint,
    paintLift: 0.02 + PAINT_RISE,
    classTint: look.classTint,
    referenceTint: look.referenceTint,
    pavingTint: look.pavingTint,
  };
}

/** A tile's rings without their digests: what its shapes are cut from. */
export function polysOf(into: Reach): TilePolys {
  const polys = (list: readonly Input[]): Poly[] => list.map((input) => input.poly);
  return {
    levels: { casing: polys(into.levels.casing), sidewalk: polys(into.levels.sidewalk), curb: polys(into.levels.curb), asphalt: polys(into.levels.asphalt) },
    medians: { kerb: polys(into.medians.kerb), planting: polys(into.medians.planting), paved: polys(into.medians.paved) },
    ramps: polys(into.ramps),
    ribbons: polys(into.ribbons),
    quads: new Map([...into.quads].map(([color, list]) => [color, polys(list)])),
  };
}

/** A surface of a pass as a tile is made of it: what it is cut from and how it is meshed. */
interface MeshedSurface {
  readonly source: TileSource;
  readonly options: TileMeshOptions & { readonly name: string; readonly maxEdge: number };
}

/** Every surface of one tile, from the rings that reach it, each vertex read here (`meshTileShape`): by surface name, in the order of `specs`. */
export function tileBundle(into: Reach, rect: TileRect, specs: readonly MeshedSurface[]): Map<string, Tile> {
  const shapes = tileShapes(polysOf(into), rect, specs.map(tileSpecOf));
  const bundle = new Map<string, Tile>();
  for (const spec of specs) {
    const shape = shapes.get(spec.options.name);
    if (shape) bundle.set(spec.options.name, meshTileShape(shape, spec.options));
  }
  return bundle;
}
