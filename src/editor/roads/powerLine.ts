import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { carriesPedestrians } from '@world/pedestrianAccess';
import { m } from '@world/units';
import type { NodeId, PoleId, SegmentId } from '@world/ids';
import { onChartOf } from '@world/planet/charts';
import { commitPoleRunPoles, planPoleRun } from '../poles';

/**
 * THE POWER LINE OF A NEW STREET (docs/VIAS.md V7): the distribution line
 * down one side of each street laid with the complete set, a pole every span
 * (`ROAD_TUNING.poles.spacing`) carrying a street light, as Brazilian streets
 * are lit from the utility poles. Laid by the pole tool's own planner
 * (`planPoleRun`: poles on the footway by the kerb, clear of crossings,
 * corners and the furniture, carried round corners), so it is the line the
 * player would have drawn, and each end snaps to a pole already standing:
 * the lines of the streets laid one after another join into one network.
 *
 * On the left of a -> b; the right keeps the lamp columns of the set.
 */
const END_SETBACK = m(4);
const MIN_RUN = m(24);
const SNAP_REACH = m(8);

export function layPowerLines(doc: RoadDoc, net: Network, segments: Iterable<SegmentId>): number {
  let built = 0;
  /**
   * The pole ending a run at a node, and whether the run left from it (its
   * segment's a) or came to it (its b). A street of several segments - every
   * one on the planet, cut every 200 m (editor/commit.ts cutLongRoads) - was
   * strung a line per segment, each held back 4 m from the node: the line
   * broke at every one of them, a gap of wire between two poles 8 m apart.
   * Where a run comes to a plain node (two roads) and the next leaves it on
   * the same side of the street, the two are joined by a span.
   */
  const ends = new Map<NodeId, { pole: PoleId; leaving: boolean }>();
  const join = (node: NodeId, pole: PoleId, leaving: boolean): void => {
    const other = ends.get(node);
    if (!other) { ends.set(node, { pole, leaving }); return; }
    ends.delete(node);
    // One coming in and one going out: the same side of the street.
    if (other.leaving !== leaving && other.pole !== pole && doc.node(node)?.incident.length === 2) doc.addPoleSpan(other.pole, pole);
  };
  for (const id of [...segments].sort((a, b) => a - b)) {
    const segment = doc.segment(id), ribbon = net.ribbons.get(id);
    if (!segment || !ribbon || !carriesPedestrians(ribbon.road) || ribbon.road.sidewalk <= 0) continue;
    const line = ribbon.full;
    const s0 = net.mouthDistance(id, segment.a) + END_SETBACK;
    const s1 = line.length - net.mouthDistance(id, segment.b) - END_SETBACK;
    if (s1 - s0 < MIN_RUN) continue;
    // On the left footway, by the kerb: the planner pulls each end onto its line.
    const out = ribbon.road.width / 2 + m(0.4);
    const at = (s: number): { x: number; y: number } => {
      const f = line.sampleAt(s);
      return { x: f.p.x + f.n.x * out, y: f.p.y + f.n.y * out };
    };
    // The line coming in to this segment's start carries on from its last
    // pole: one pole at the joint, not two 8 m apart.
    const coming = ends.get(segment.a);
    const start = coming && !coming.leaving && doc.node(segment.a)?.incident.length === 2 ? doc.poles.get(coming.pole) : undefined;
    const from = start ? onChartOf(start, at(s0)) : at(s0);
    const plan = planPoleRun(doc, net, from, at(s1), SNAP_REACH, undefined, 'all');
    const poles = commitPoleRunPoles(doc, plan);
    if (!poles) continue;
    built++;
    join(segment.a, poles[0]!, true);
    join(segment.b, poles[poles.length - 1]!, false);
  }
  return built;
}
