import { Polyline } from '@core/polyline';
import { pointInPolygon } from '@core/polygon';
import { addScaled, dist, perp, type Vec2 } from '@core/vec2';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { Level, footwayOn, roadProfile } from '@world/roadTypes';
import { carriesPedestrians } from '@world/pedestrianAccess';
import { orientedPolyline } from '@world/geometry';
import type { GraphChange, LaneletGraph, LaneletId } from '@world/lanelets';
import { makeCrossingId, type CrossingId } from '../signals/plan';
import { COARSE_EPS } from '@core/scalar';
import { m } from '@world/units';
import { rebuildWork } from '@world/rebuildWork';

export type SidewalkNodeId = string;
export type SidewalkEdgeId = string;
type Side = -1 | 1;

export interface SidewalkNode {
  readonly id: SidewalkNodeId;
  readonly at: Vec2;
  readonly node: NodeId;
  readonly segment: SegmentId;
  readonly side: Side;
}

type SidewalkEdgeKind = 'walk' | 'crossing';

export interface SidewalkEdge {
  readonly id: SidewalkEdgeId;
  readonly kind: SidewalkEdgeKind;
  readonly from: SidewalkNodeId;
  readonly to: SidewalkNodeId;
  readonly path: Polyline;
  readonly length: number;
  /** Crossings only: the junction being crossed at. */
  readonly node?: NodeId;
  /** The leg: the road a crossing goes over, or the road a footway line runs beside. */
  readonly segment?: SegmentId;
  readonly crossing?: CrossingId;
  /** Crossings only: the vehicle lanelets this edge passes over. */
  readonly lanes?: readonly LaneletId[];
}

/**
 * The kerbs, zebras and footway lines the vehicles and signals read, derived
 * from the SAME junction geometry that trims the vehicle lanelets.
 *
 * - A zebra (`crossings`, `crossingEdge`) runs between the two kerb nodes of
 *   a leg, where `Network.crosswalkDistanceAt` paints it: admission, the
 *   crossing spans, the signal plans and the walking engine's published
 *   crossing states all measure along it. As in SUMO, a vehicle learns about
 *   people only through the state of the crossing it is about to drive over.
 * - A footway line (`kind: 'walk'`) runs along each side of a road between
 *   its kerbs: a bus at a stop finds the pavement beside its doors on it
 *   (`vehicles/kerbStops.ts`).
 *
 * People walk on `world/walkways.ts` (`sim/agents/walk.ts`). This graph was
 * also the footway-graph pedestrian engine's network - corner paths, walking
 * corridors, a link to every door, destinations, an occupancy index - which
 * went with that engine on 2026-10-08; nothing read any of it, and every road
 * edit rebuilt it (the door links alone were P17 in docs/PROBLEMAS.md).
 */
export class SidewalkGraph {
  readonly nodes = new Map<SidewalkNodeId, SidewalkNode>();
  readonly edges = new Map<SidewalkEdgeId, SidewalkEdge>();
  readonly crossings = new Map<CrossingId, SidewalkEdgeId>();
  /**
   * The footway lines (`kind: 'walk'`) of each road, in the order they were
   * added to `edges`. A kerb stop asks for the footway beside one lane; it
   * walked every edge of the map for each car with an errand, every tick.
   */
  private readonly walksBySegment = new Map<SegmentId, SidewalkEdge[]>();

  /** The kerb nodes and zebras each road node made: what an edit there takes away. */
  private readonly ofNode = new Map<NodeId, { readonly kerbs: SidewalkNodeId[]; readonly crossings: CrossingId[] }>();

  /** @rebuild Every road and node: a world's first topology, or a lane graph built whole. */
  build(doc: RoadDoc, net: Network, graph: LaneletGraph): void {
    this.clear();
    for (const nodeId of doc.nodes.keys()) this.kerbsAt(doc, net, nodeId);
    for (const nodeId of doc.nodes.keys()) this.crossingsAt(doc, net, graph, nodeId);
    for (const segId of doc.segments.keys()) this.footwaysOf(doc, net, segId);
  }

  /**
   * Brought up to the lane graph's changes since it was last (`LaneletGraph.update`,
   * in order; null: built whole): the kerbs and zebras of the junctions built again,
   * and the footway lines of every road at them. Every id is the place's own (node,
   * road, side), so what an edit left stands as it was.
   * DO NOT build the kerbs, zebras and footway lines of the whole map for an edit:
   * every road drawn made the town's again.
   */
  update(doc: RoadDoc, net: Network, graph: LaneletGraph, changes: readonly GraphChange[] | null): void {
    if (changes === null) { this.build(doc, net, graph); return; }
    const nodes = new Set<NodeId>(), roads = new Set<SegmentId>();
    for (const change of changes) {
      for (const node of change.junctions) nodes.add(node);
      for (const seg of change.segments) roads.add(seg);
    }
    for (const nodeId of nodes) {
      for (const seg of doc.node(nodeId)?.incident ?? []) roads.add(seg);
      const made = this.ofNode.get(nodeId);
      if (!made) continue;
      for (const id of made.kerbs) {
        const kerb = this.nodes.get(id);
        if (kerb) roads.add(kerb.segment);
        this.nodes.delete(id);
      }
      for (const crossing of made.crossings) {
        const eid = this.crossings.get(crossing);
        if (eid) this.edges.delete(eid);
        this.crossings.delete(crossing);
      }
      this.ofNode.delete(nodeId);
    }
    for (const segId of roads) {
      for (const side of [-1, 1] as const) this.edges.delete(`W:${segId}:${side}`);
      this.walksBySegment.delete(segId);
    }
    const ascending = (x: number, y: number): number => x - y;
    const order = [...nodes].sort(ascending);
    for (const nodeId of order) this.kerbsAt(doc, net, nodeId);
    for (const nodeId of order) this.crossingsAt(doc, net, graph, nodeId);
    for (const segId of [...roads].sort(ascending)) this.footwaysOf(doc, net, segId);
  }

  /** The kerb nodes of one road node: two per leg. */
  private kerbsAt(doc: RoadDoc, net: Network, nodeId: NodeId): void {
    rebuildWork.sidewalks++;
    const node = doc.node(nodeId);
    if (!node) return;
    const made = { kerbs: [] as SidewalkNodeId[], crossings: [] as CrossingId[] };
    this.ofNode.set(nodeId, made);
    for (const segId of node.incident) {
      const seg = doc.segment(segId);
      if (!seg) continue;
      const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking);
      if (!carriesPedestrians(rt)) continue;
      const pl = orientedPolyline(doc, seg, nodeId);
      if (pl.length < 1) continue;

      const lateral = rt.width / 2 + rt.sidewalk * 0.5;
      const want = kerbDistance(
        net.crosswalkDistanceAt(segId, nodeId),
        pl.length,
        net.mouthDistance(segId, nodeId),
      );
      const crossS = clearOfJunction(net, nodeId, pl, want, lateral, pl.length);
      const frame = pl.sampleAt(crossS);
      const nrm = perp(frame.t);

      for (const side of [-1, 1] as const) {
        const id = kerbId(nodeId, segId, side);
        // Each side's own footway (docs/VIAS.md V1): looking away from the
        // node, `+nrm` is the road's left from `a` and its right from `b`.
        const roadSide = (side > 0) === (seg.a === nodeId) ? 'left' : 'right';
        this.nodes.set(id, {
          id,
          at: addScaled(frame.p, nrm, (rt.width / 2 + footwayOn(rt, roadSide) * 0.5) * side),
          node: nodeId,
          segment: segId,
          side,
        });
        made.kerbs.push(id);
      }
    }
  }

  /** The zebras of one road node: one per leg, over its own road's link lanes. */
  private crossingsAt(doc: RoadDoc, net: Network, graph: LaneletGraph, nodeId: NodeId): void {
    const node = doc.node(nodeId);
    const made = this.ofNode.get(nodeId);
    if (!node || !made || node.incident.length < 2) return;
    for (const segId of node.incident) {
      const segment = doc.segment(segId);
      if (!segment || !carriesPedestrians(roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking))) continue;
      if (net.crosswalkDistanceAt(segId, nodeId) <= 0) continue;
      const right = this.nodes.get(kerbId(nodeId, segId, -1));
      const left = this.nodes.get(kerbId(nodeId, segId, 1));
      if (!right || !left) continue;

      const crossing = makeCrossingId(nodeId, segId);
      const path = Polyline.fromPoints([right.at, left.at]);
      // The link lanes of its own road (`LaneletGraph.linksOfSegment`), in its own array:
      // the edge owns them. DO NOT gather every lane of the map to find a road's: that
      // made this quadratic in the size of the network (`tests/scale/edit.spec.ts`).
      const lanes = graph.linksOfSegment(segId).slice();

      this.addEdge({
        id: `X:${crossing}`,
        kind: 'crossing',
        from: right.id,
        to: left.id,
        path,
        length: path.length,
        node: nodeId,
        segment: segId,
        crossing,
        lanes,
      });
      this.crossings.set(crossing, `X:${crossing}`);
      made.crossings.push(crossing);
    }
  }

  /** The footway lines along one road, kerb to kerb on each side. */
  private footwaysOf(doc: RoadDoc, net: Network, segId: SegmentId): void {
    rebuildWork.sidewalks++;
    const seg = doc.segment(segId);
    if (!seg) return;
    const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking);
    if (!carriesPedestrians(rt)) return;
    const pl = orientedPolyline(doc, seg, seg.a);
    if (pl.length < 1) return;

    const s0 = kerbDistance(
      net.crosswalkDistanceAt(segId, seg.a),
      pl.length,
      net.mouthDistance(segId, seg.a),
    );
    const s1 = Math.max(
      s0 + 0.5,
      pl.length - kerbDistance(
        net.crosswalkDistanceAt(segId, seg.b),
        pl.length,
        net.mouthDistance(segId, seg.b),
      ),
    );
    const middle = pl.sub(s0, Math.min(s1, pl.length)).toPoints();

    for (const side of [-1, 1] as const) {
      // A's `+nrm` side is B's `-nrm` side, because the leg direction flips.
      const from = this.nodes.get(kerbId(seg.a, segId, side));
      const to = this.nodes.get(kerbId(seg.b, segId, (-side) as Side));
      if (!from || !to) continue;

      const sideLateral = rt.width / 2 + footwayOn(rt, side > 0 ? 'left' : 'right') * 0.5;
      const offsetPts = middle.map((p, i) => {
        const t = pl.sampleAt(s0 + ((s1 - s0) * i) / Math.max(1, middle.length - 1)).t;
        return addScaled(p, perp(t), sideLateral * side);
      });
      const points: Vec2[] = [];
      for (const point of [from.at, ...offsetPts, to.at]) {
        if (!points.length || dist(points[points.length - 1]!, point) > 0.01) points.push(point);
      }
      const path = Polyline.fromPoints(points);
      this.addEdge({
        id: `W:${segId}:${side}`,
        kind: 'walk',
        from: from.id,
        to: to.id,
        path,
        length: path.length,
        segment: segId,
      });
    }
  }

  /** Nothing: the graph of a world not built yet (`SimWorld.reset`). */
  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.crossings.clear();
    this.walksBySegment.clear();
    this.ofNode.clear();
  }

  crossingEdge(id: CrossingId): SidewalkEdge | undefined {
    const eid = this.crossings.get(id);
    return eid ? this.edges.get(eid) : undefined;
  }

  /** The footway lines running beside road `segment`, in `edges` order. */
  walksBeside(segment: SegmentId): readonly SidewalkEdge[] {
    return this.walksBySegment.get(segment) ?? [];
  }

  private addEdge(edge: SidewalkEdge): void {
    if (edge.length < COARSE_EPS) return;
    this.edges.set(edge.id, edge);
    // A footway's id (`W:<segment>:<side>`) is set once per build, so each
    // list below holds exactly the walk edges of `edges`, in the same order.
    if (edge.kind === 'walk' && edge.segment !== undefined) {
      const list = this.walksBySegment.get(edge.segment);
      if (list) list.push(edge);
      else this.walksBySegment.set(edge.segment, [edge]);
    }
  }
}

/**
 * Clamps the crossing distance to something the segment can actually hold.
 *
 * The distance itself comes from `Network.crosswalkDistanceAt`, which derives
 * it from the SAME asphalt trim the junction mouth and the stop line use — so
 * the crossing always sits between the two, and vehicles halt behind waiting
 * pedestrians by construction.
 */
function kerbDistance(
  crossingDistance: number,
  segmentLength: number,
  mouthDistance = 0,
): number {
  // A zero crossing distance is the network's sentinel for "no crossing fits on
  // this approach", NOT a crossing standing at the node. Reading it as a
  // distance put the kerb at the 2-unit floor below — inside the junction
  // surface. With no crossing to stand beside, the kerb belongs at the
  // junction mouth.
  const from = crossingDistance > 0 ? crossingDistance : mouthDistance;

  // No second cap on the crossing itself. `Network.crosswalkDistanceAt` has
  // already clamped it against the junction mouth; re-clamping against a bare
  // fraction of the segment would undo that and push the kerb back into the
  // carriageway.
  const floor = Math.max(mouthDistance, Math.min(m(0.8), segmentLength * 0.2));
  return Math.max(floor, Math.min(from, segmentLength * 0.5));
}

/**
 * Pushes a kerb outward until it is genuinely clear of the junction surface.
 *
 * Distance alone is not enough. Where a junction's legs have very unequal
 * trims — a narrow street meeting a boulevard on a short block — the corner
 * boundary sweeps between one leg's distant mouth and another's near one, and
 * can cover ground that is well past the SHORT leg's own mouth. A kerb placed
 * by distance would then still land on the carriageway, so the containment is
 * tested rather than assumed, and the crossing steps outward until it clears.
 */
function clearOfJunction(
  net: Network,
  node: NodeId,
  centre: Polyline,
  want: number,
  lateral: number,
  segmentLength: number,
): number {
  const junction = net.junctionAt(node, Level.Asphalt);
  if (!junction) return want;

  const surface = junction.rings.map((r) => r.flatten());
  const cap = Math.max(want, segmentLength * 0.6);
  let s = want;

  for (let attempt = 0; attempt < 14 && s < cap; attempt++) {
    const frame = centre.sampleAt(s);
    const nrm = perp(frame.t);
    const inside = ([-1, 1] as const).some((side) =>
      surface.some((poly) => pointInPolygon(addScaled(frame.p, nrm, lateral * side), poly)),
    );
    if (!inside) return s;
    s += 2;
  }
  return Math.min(s, cap);
}

const kerbId = (node: NodeId, segment: SegmentId, side: Side): SidewalkNodeId =>
  `${node}:${segment}:${side}`;
