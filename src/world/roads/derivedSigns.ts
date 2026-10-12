import type { Vec2 } from '@core/vec2';
import type { NodeId, SegmentId } from '../ids';
import type { Network } from '../network';
import { nodeChart } from '../geometry';
import { roadProfile } from '../roadTypes';
import { SIGNAL_POST_KERB } from '../signalPosts';
import { kmh, m } from '../units';
import { approachSign, arrivesAt } from './rules';

/**
 * THE SIGNS THE RULES PUT UP (docs/VIAS.md V6): the rule is the source and the
 * sign derived from it, so a sign never says what the traffic does not do.
 *
 * - At a junction with signs, a stop (R-1) or give-way (R-2) plate on the
 *   right of every leg the rule makes stop or give way (`rules.ts`
 *   `approachSign`), beside the stop line, facing the driver who arrives.
 * - A speed limit plate (R-19) a little past each junction on every stretch
 *   long enough to need one, on the driver's right, saying the road's limit
 *   (MBST vol. I: the limit is signed after the junctions where it may
 *   change). Only where the map paints to a regional standard: a map from
 *   before the standards keeps its look.
 */
export interface DerivedSign {
  readonly type: 'stop' | 'yield' | 'speed';
  readonly text: string;
  readonly segment: SegmentId;
  readonly node: NodeId;
  readonly x: number;
  readonly y: number;
  /** The way the plate's face looks: at the driver it is for. */
  readonly facing: Vec2;
}

/** Past the junction mouth, where a speed plate stands. */
const SPEED_PAST_MOUTH = m(14);
/** A stretch shorter than this gets no speed plate of its own. */
const SPEED_MIN_LENGTH = m(60);

export function derivedSigns(net: Network): DerivedSign[] {
  const doc = net.doc;
  const out: DerivedSign[] = [];
  const regional = doc.markingStyle !== 'classic';
  const nodes = [...doc.nodes.values()].sort((a, b) => a.id - b.id);
  for (const node of nodes) {
    for (const segId of [...node.incident].sort((a, b) => a - b)) {
      const segment = doc.segment(segId);
      if (!segment || segment.a === segment.b) continue;
      const road = roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking);
      if (road.id === 'highway' || road.id === 'ramp') continue;
      const line = net.polylines.at(doc, segId, nodeChart(doc, node.id));
      // Outward from the node along the segment.
      const outward = segment.a === node.id ? line : line.reversed();
      const mouth = net.mouthDistance(segId, node.id);
      const kerb = road.width / 2 + SIGNAL_POST_KERB;
      // The rule's plate, for the traffic arriving here.
      const kind = approachSign(doc, node, segId);
      if (kind && arrivesAt(doc, node.id, segId)) {
        const at = Math.min(net.stopLineDistance(segId, node.id) + m(1), outward.length * 0.45);
        const f = outward.sampleAt(at);
        // Travelling toward the node (-t), the driver's right is +n of the outward frame.
        out.push({ type: kind, text: '', segment: segId, node: node.id,
          x: f.p.x + f.n.x * kerb, y: f.p.y + f.n.y * kerb, facing: { x: f.t.x, y: f.t.y } });
      }
      // The speed plate, for the traffic leaving here.
      if (!regional || node.incident.length === 2 || !arrivesAt(doc, segment.a === node.id ? segment.b : segment.a, segId)) continue;
      if (outward.length < SPEED_MIN_LENGTH) continue;
      const f = outward.sampleAt(mouth + SPEED_PAST_MOUTH);
      const limit = Math.round(road.speedLimit / kmh(1) / 10) * 10;
      out.push({ type: 'speed', text: String(limit), segment: segId, node: node.id,
        x: f.p.x - f.n.x * kerb, y: f.p.y - f.n.y * kerb, facing: { x: -f.t.x, y: -f.t.y } });
    }
  }
  return out;
}

/** How far back from the junction mouth a placed plate still belongs to that approach. */
const APPROACH_REACH = m(25);

/**
 * The junction approach a stop or give-way plate put at `at` would govern
 * (docs/VIAS.md V7, "placa = regra"): the leg under it, arriving at a
 * junction of three legs or more within reach of its mouth, the nearer end
 * when both qualify. Null where a plate is only a plate.
 */
export function signApproach(net: Network, at: Vec2, segment: SegmentId): { node: NodeId; segment: SegmentId } | null {
  const doc = net.doc;
  const seg = doc.segment(segment);
  if (!seg || seg.a === seg.b) return null;
  const line = net.polylines.get(doc, segment);
  const s = line.closestPoint(at).s;
  let best: { node: NodeId; segment: SegmentId } | null = null;
  let bestD = Infinity;
  for (const [node, d] of [[seg.a, s], [seg.b, line.length - s]] as const) {
    const n = doc.node(node);
    if (!n || n.incident.length < 3 || !arrivesAt(doc, node, segment)) continue;
    if (d > net.mouthDistance(segment, node) + APPROACH_REACH || d >= bestD) continue;
    best = { node, segment };
    bestD = d;
  }
  return best;
}
