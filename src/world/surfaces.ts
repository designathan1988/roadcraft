import { type MultiPoly, difference, union } from '@core/clipper';
import type { CurveShape } from '@core/bezier';
import type { Polyline } from '@core/polyline';
import type { Ring } from '@core/ring';
import { Level, halfWidth, type RoadType, type SurfaceLevel } from './roadTypes';
import type { NodeId, SegmentId } from './ids';
import { type RoadStructure, roadStructure } from './structures';

export type SurfaceSegmentFilter = (segment: SegmentId) => boolean;

/* DO NOT import `network.ts` or `junction/build.ts` here */
export interface SurfaceRibbon {
  readonly id: SegmentId;
  readonly road: RoadType;
  readonly rings: Record<number, Ring>;
  readonly full: Polyline;
}
export interface SurfaceJunction {
  readonly rings: readonly Ring[];
}
export interface SurfaceNet {
  readonly doc: {
    node(id: NodeId): { readonly incident: readonly SegmentId[] } | undefined;
    segment(id: SegmentId): { readonly a: NodeId; readonly b: NodeId; readonly curve: CurveShape | null; readonly structure: RoadStructure } | undefined;
    degree(id: NodeId): number;
  };
  readonly trims: ReadonlyMap<SegmentId, { readonly a: Record<number, number>; readonly b: Record<number, number> }>;
  readonly ribbons: ReadonlyMap<SegmentId, SurfaceRibbon>;
  readonly junctions: ReadonlyMap<NodeId, ReadonlyMap<SurfaceLevel, SurfaceJunction>>;
}

/** The network's surfaces as real polygons. */

/** Every surface of the network, one entry per level, outermost first. */
export interface Surfaces {
  readonly casing: MultiPoly;
  readonly sidewalk: MultiPoly;
  readonly curb: MultiPoly;
  readonly asphalt: MultiPoly;
}

/** Bands, each the part of one level not covered by the level inside it. */
export interface Bands {
  /** The verge between the footway and the terrain. */
  readonly casing: MultiPoly;
  /** The footway itself, from the kerb outward. */
  readonly footway: MultiPoly;
  /** The kerb face, between carriageway and footway. */
  readonly kerb: MultiPoly;
  /** The carriageway. */
  readonly carriageway: MultiPoly;
}

/** Whether this pass draws the junction at a node. */
function ownsJunction(net: SurfaceNet, nodeId: NodeId, include: SurfaceSegmentFilter): boolean {
  const node = net.doc.node(nodeId);
  if (!node) return false;
  let lowest = Infinity;
  let owns = false;
  for (const id of node.incident) {
    const structure = net.doc.segment(id)?.structure ?? 'ground';
    if (structure === 'tunnel') continue;
    const clearance = roadStructure(structure).clearance;
    if (clearance < lowest) {
      lowest = clearance;
      owns = include(id);
    }
  }
  return owns;
}

/** Every ring of one level, as clipper input, before they are merged (`levelPolygons`). */
function levelRings(net: SurfaceNet, level: SurfaceLevel, include?: SurfaceSegmentFilter): MultiPoly {
  return levelRingsOf(net, level, net.ribbons.values(), net.junctions, include);
}

/** `levelRings` of the given ribbons and junctions only: the rings round one place */
export function levelRingsOf(
  net: SurfaceNet, level: SurfaceLevel, ribbons: Iterable<SurfaceRibbon>,
  junctions: Iterable<readonly [NodeId, ReadonlyMap<SurfaceLevel, SurfaceJunction>]>, include?: SurfaceSegmentFilter,
): MultiPoly {
  const out: MultiPoly = [];

  for (const ribbon of ribbons) {
    if (include && !include(ribbon.id)) continue;
    const ring = ribbon.rings[level];
    if (ring && !ring.isEmpty) out.push([ring.flatten().map((p) => [p.x, p.y])]);
    const segment = net.doc.segment(ribbon.id);
    const trims = net.trims.get(ribbon.id);
    if (!segment?.curve || !trims) continue;
    // A curved leg's offset edge is not the straight mouth chord used by the junction plate.
    const width = halfWidth(ribbon.road, level);
    const length = ribbon.full.length;
    for (const [node, mouth, trim] of [
      [segment.a, trims.a[level] ?? 0, trims.a[level] ?? 0],
      [segment.b, length - (trims.b[level] ?? 0), trims.b[level] ?? 0],
    ] as const) {
      if (net.doc.degree(node) < 2 || trim <= 0) continue;
      const from = Math.max(0, mouth - 2);
      const to = Math.min(length, mouth + 2);
      if (to - from < 0.25) continue;
      const left: number[][] = [], right: number[][] = [];
      const count = Math.max(2, Math.ceil((to - from) / 0.5));
      for (let i = 0; i <= count; i++) {
        const frame = ribbon.full.sampleAt(from + (to - from) * i / count);
        left.push([frame.p.x + frame.n.x * width, frame.p.y + frame.n.y * width]);
        right.push([frame.p.x - frame.n.x * width, frame.p.y - frame.n.y * width]);
      }
      out.push([[...left, ...right.reverse()]]);
    }
  }

  for (const [nodeId, byLevel] of junctions) {
    if (include && !ownsJunction(net, nodeId, include)) continue;
    const junction = byLevel.get(level);
    if (!junction) continue;
    for (const ring of junction.rings) {
      if (!ring.isEmpty) out.push([ring.flatten().map((p) => [p.x, p.y])]);
    }
  }

  return out;
}

/** One merged polygon set per surface level. */
export function levelPolygons(net: SurfaceNet, level: SurfaceLevel, include?: SurfaceSegmentFilter): MultiPoly {
  return union(levelRings(net, level, include));
}

export function surfaces(net: SurfaceNet, include?: SurfaceSegmentFilter): Surfaces {
  return {
    casing: levelPolygons(net, Level.Casing, include),
    sidewalk: levelPolygons(net, Level.Sidewalk, include),
    curb: levelPolygons(net, Level.Curb, include),
    asphalt: levelPolygons(net, Level.Asphalt, include),
  };
}

export function bands(s: Surfaces): Bands {
  return {
    casing: difference(s.casing, s.sidewalk),
    footway: difference(s.sidewalk, s.curb),
    kerb: difference(s.curb, s.asphalt),
    carriageway: s.asphalt,
  };
}

