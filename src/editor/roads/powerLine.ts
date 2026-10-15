import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { carriesPedestrians } from '@world/pedestrianAccess';
import { m } from '@world/units';
import type { NodeId, PoleId, SegmentId } from '@world/ids';
import type { Vec2 } from '@core/vec2';
import { type PoleRunPlan, commitPoleRunPoles, planPoleRun, poleRunPlanner } from '../poles';

/** THE POWER LINE OF A NEW STREET */
const END_SETBACK = m(4);
const MIN_RUN = m(24);
const SNAP_REACH = m(8);

export function layPowerLines(doc: RoadDoc, net: Network, segments: Iterable<SegmentId>, plan?: PlanRun): number {
  const steps = layPowerLinesSteps(doc, net, segments, plan);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** `layPowerLines` a few streets at a time: yields every `STREETS_A_STEP` segments and returns how many runs were built. */
export function* layPowerLinesSteps(doc: RoadDoc, net: Network, segments: Iterable<SegmentId>, plan?: PlanRun): Generator<void, number> {
  let built = 0;
  let seen = 0;
  const ids = [...segments].sort((a, b) => a - b);
  const planRun = plan ?? runPlanner(net, ids.length);
  /** The pole ending a run at a node, and whether the run left from it (its segment's a) or came to it (its b). */
  const ends = new Map<NodeId, { pole: PoleId; leaving: boolean }>();
  const join = (node: NodeId, pole: PoleId, leaving: boolean): void => {
    const other = ends.get(node);
    if (!other) { ends.set(node, { pole, leaving }); return; }
    ends.delete(node);
    // One coming in and one going out: the same side of the street.
    if (other.leaving !== leaving && other.pole !== pole && doc.node(node)?.incident.length === 2) doc.addPoleSpan(other.pole, pole);
  };
  for (const id of ids) {
    if (++seen % STREETS_A_STEP === 0) yield;
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
    // The line coming in to this segment's start carries on from its last pole: one pole at the joint, not two 8 m apart.
    const coming = ends.get(segment.a);
    const start = coming && !coming.leaving && doc.node(segment.a)?.incident.length === 2 ? doc.poles.get(coming.pole) : undefined;
    const from = start ?? at(s0);
    const poles = commitPoleRunPoles(doc, planRun(doc, from, at(s1)));
    if (!poles) continue;
    built++;
    join(segment.a, poles[0]!, true);
    join(segment.b, poles[poles.length - 1]!, false);
  }
  return built;
}

/** How one street's run is planned: its two ends, with the generator's reach, spacing and lamps. */
export type PlanRun = (doc: RoadDoc, from: Vec2, to: Vec2) => PoleRunPlan;

/** Streets in one call past which they are planned over shared tiles (`poleRunPlanner`). */
const BATCH = 24;

/** The planning of a call's runs. */
function runPlanner(net: Network, streets: number): PlanRun {
  if (streets > BATCH) {
    const planner = poleRunPlanner(net);
    return (doc, from, to) => planner.plan(doc, from, to, SNAP_REACH, undefined, 'all');
  }
  return (doc, from, to) => planPoleRun(doc, net, from, to, SNAP_REACH, undefined, 'all');
}

/** Segments strung between two yields of `layPowerLinesSteps`. */
const STREETS_A_STEP = 6;
