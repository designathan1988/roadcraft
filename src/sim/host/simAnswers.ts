import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import { laneletId } from '@world/lanelets';
import type { SignalSettings } from '@world/roads/rules';
import type { SimWorld } from '../world';
import { greenWave } from '../roads/greenWave';
import { laneEnds } from '@world/roads/connectors';
import type { SimAsk } from './protocol';

/** THE PANELS' QUESTIONS ANSWERED IN THE SIMULATION'S WORKER (`simHost.ts`): plain numbers, worded on the page */

/** The traffic on a road's lanes now, or on a junction's approaches. */
export interface TrafficCount {
  readonly vehicles: number;
  readonly queued: number;
  readonly speedSum: number;
  readonly speedCount: number;
  readonly capacity: number;
  readonly volume: number;
}

/** What the junction panel and the inspector show of a junction. */
export interface JunctionAnswer extends TrafficCount {
  readonly known: boolean;
  readonly signalised: boolean;
  readonly choice: string | null;
  readonly flows: readonly (readonly [SegmentId, number])[];
  readonly connectors: readonly { readonly inSegment: SegmentId; readonly outSegment: SegmentId; readonly turn: string | null }[];
  readonly plan: { readonly cycle: number; readonly stageIndex: number; readonly sub: string; readonly greens: readonly number[] } | null;
}

/** Below this speed a vehicle counts as queued (u/s), as the panels have always counted it. */
const QUEUED = 0.6;

function count(sim: SimWorld, lanes: Iterable<string>, volume: number): TrafficCount {
  let vehicles = 0, queued = 0, speedSum = 0, speedCount = 0, capacity = 0;
  for (const id of lanes) {
    const lane = sim.graph.lanelet(id as never);
    if (!lane) continue;
    capacity += Math.max(1, lane.length / 12);
    const order = sim.runtime.get(lane.id)?.order;
    if (!order) continue;
    vehicles += order.length;
    for (const vehicleId of order) {
      const vehicle = sim.veh(vehicleId);
      if (!vehicle) continue;
      speedSum += vehicle.v;
      speedCount++;
      if (vehicle.v < QUEUED) queued++;
    }
  }
  return { vehicles, queued, speedSum, speedCount, capacity, volume };
}

/** A road's lanes, each way, by their ids (DO NOT walk `sim.graph.lanelets`: every lane of the city). */
function* roadLanes(sim: SimWorld, doc: RoadDoc, id: SegmentId): Generator<string> {
  const seg = doc.segment(id);
  if (!seg) return;
  for (const [from, to] of [[seg.a, seg.b], [seg.b, seg.a]] as const) {
    for (let k = 0; ; k++) {
      const lid = laneletId(id, from, to, k);
      if (!sim.graph.lanelet(lid)) break;
      yield lid;
    }
  }
}

export function answer(sim: SimWorld, doc: RoadDoc, _net: Network, ask: SimAsk): unknown {
  switch (ask.kind) {
    case 'segment':
      return doc.segment(ask.id) ? count(sim, roadLanes(sim, doc, ask.id), sim.segmentVolume.get(ask.id) ?? 0) : null;
    case 'junction': return junctionAnswer(sim, doc, ask.node);
    case 'greenWave': return [...greenWave(sim, ask.node)] as [NodeId, SignalSettings][];
    case 'nodeLanes': return laneEnds(sim.graph, ask.node);
  }
}

function junctionAnswer(sim: SimWorld, doc: RoadDoc, id: NodeId): JunctionAnswer | null {
  const node = doc.node(id);
  if (!node) return null;
  const junction = sim.graph.junctions.get(id);
  const controller = sim.controller(id);
  const volume = node.incident.reduce((total, segment) => total + (sim.segmentVolume.get(segment) ?? 0), 0);
  const traffic = count(sim, (junction?.inbound ?? []) as Iterable<string>, volume);
  const connectors: { inSegment: SegmentId; outSegment: SegmentId; turn: string | null }[] = [];
  for (const cid of junction?.connectors ?? []) {
    const c = sim.connector(cid);
    if (c) connectors.push({ inSegment: c.inSegment, outSegment: c.outSegment, turn: c.turn ?? null });
  }
  return {
    ...traffic,
    known: junction !== undefined,
    signalised: junction?.signalised === true,
    choice: sim.advisor.choice(id) ?? null,
    flows: node.incident.map((segment) => [segment, sim.flow.rate(id, segment)] as const),
    connectors,
    plan: controller && junction?.signalised
      ? { cycle: controller.plan.cycle, stageIndex: controller.stageIndex, sub: controller.sub, greens: controller.plan.stages.map((s) => s.targetGreen) }
      : null,
  };
}
