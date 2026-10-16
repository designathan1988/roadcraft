import type { NodeId, SegmentId } from '../ids';
import type { LaneletGraph } from '../lanelets';
import type { LaneEnds, LaneLink, NodeLanes } from './connectors';

/** A JUNCTION'S LANES READ FROM THE LANE GRAPH, for the connector editor: apart from `connectors.ts`, which the document reads and the graph does not */

/** What the node's lanes and built connections are, read from the lane graph. */
export function nodeLanes(graph: LaneletGraph, node: NodeId): NodeLanes | null {
  const junction = graph.junctions.get(node);
  if (!junction) return null;
  const lane = (id: string): { segment: SegmentId; lane: number } | null => {
    const l = graph.lanelet(id);
    return l && l.segment !== undefined ? { segment: l.segment, lane: l.laneIndex ?? 0 } : null;
  };
  const arriving = (graph.inbound.get(node) ?? []).map(lane).filter((x): x is { segment: SegmentId; lane: number } => x !== null);
  const leaving = (graph.outbound.get(node) ?? []).map(lane).filter((x): x is { segment: SegmentId; lane: number } => x !== null);
  const built: LaneLink[] = [];
  for (const id of junction.connectors) {
    const c = graph.connectors.get(id);
    const a = c && lane(c.fromLane), b = c && lane(c.toLane);
    if (a && b) built.push({ from: a.segment, fromLane: a.lane, to: b.segment, toLane: b.lane });
  }
  return { node, arriving, leaving, built };
}

/** `nodeLanes` with each lane's end at the junction (`LaneEnds`), for the connector editor. */
export function laneEnds(graph: LaneletGraph, node: NodeId): LaneEnds | null {
  const lanes = nodeLanes(graph, node);
  if (!lanes) return null;
  const ends: LaneEnds['ends'][number][] = [];
  for (const [ids, arriving] of [[graph.inbound.get(node) ?? [], true], [graph.outbound.get(node) ?? [], false]] as const) {
    for (const id of ids) {
      const l = graph.lanelet(id);
      if (!l || l.segment === undefined) continue;
      const pts = l.centre.toPoints();
      const at = arriving ? pts[pts.length - 1]! : pts[0]!, next = arriving ? pts[Math.max(0, pts.length - 2)]! : pts[Math.min(pts.length - 1, 1)]!;
      ends.push({ segment: l.segment, lane: l.laneIndex ?? 0, arriving, at: { x: at.x, y: at.y }, next: { x: next.x, y: next.y } });
    }
  }
  return { ...lanes, revision: graph.revision, ends };
}
