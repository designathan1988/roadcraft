import type { LaneletId } from '@world/lanelets';
import type { BodyClass } from '@world/conflictPoints';
import { m } from '@world/units';
import type { SimWorld } from '../world';
import { goalEnd, laneLowerBound } from '../routing/lowerBound';
import { type SearchScratch, noteCapped, noteSearch, searchScratch } from '../routing/searchScratch';

/** Drive v2, tactical layer: which LANE a trip is driven in. */

/** Seconds a lane change costs the trip, per lane crossed. Also the hysteresis. */
const CHANGE_COST = 4;
/** Road a change needs, per lane crossed. */
const ROOM_PER_LANE = m(24);

export interface TripPlan {
  /** Drivable from the start lane: links joined by their connectors */
  readonly route: LaneletId[];
  /** The sibling lane to move into before leaving the start lane, or null. */
  readonly changeTo: LaneletId | null;
  /** With `changeTo`: the connector the trip leaves that lane by. */
  readonly intent: LaneletId | null;
  readonly cost: number;
}

/** Seconds to drive on through a connector and the link it leads to, with its congestion. */
function connectorCost(w: SimWorld, connectorId: LaneletId, body: BodyClass, shape: string): number {
  const connector = w.connector(connectorId);
  const out = connector && w.lanelet(connector.toLane);
  if (!connector || connector.maxBodyClass < body || !out || out.kind !== 'link' || w.rt(out.id).ghost) return Infinity;
  // A bus lane is buses only.
  if (!w.graph.laneUsable(out.id, shape)) return Infinity;
  const density = w.rt(out.id).order.length / Math.max(1, out.length / m(4.8));
  const travel = out.length / Math.max(m(0.2), out.speedLimit) * (1 + density * 2.6);
  const turn = connector.turn === 'uturn' ? 4 : connector.turn === 'through' ? 0 : 0.35;
  return connector.length / Math.max(m(0.2), out.speedLimit * 0.65) + travel + turn;
}

/** DO NOT go back to Dijkstra's order (cost alone) */
export function planTrip(
  w: SimWorld,
  start: LaneletId,
  startS: number,
  goal: LaneletId,
  body: BodyClass,
  startChange = true,
  /** The vehicle's shape (`VehicleShape`): who may drive a bus lane. */
  shape = 'car',
  /** Whether a plan that changes lanes first needs its route as driven without the change (a second search): DO NOT ask it when the route is let go (`router.ts` extend, a bus's check). */
  fallback = true,
): TripPlan | null {
  const startLane = w.lanelet(start);
  if (!startLane || startLane.kind !== 'link' || !w.lanelet(goal) || w.rt(goal).ghost) return null;
  if (start === goal) return { route: [start], changeTo: null, intent: null, cost: 0 };
  // DO NOT expand the whole graph to find out a goal cannot be reached: the lanes' components say so first (`laneReach.ts`).
  if (!w.laneReaches.mayReach(w, start, goal, body)) return null;

  const scratch = searchScratch(w);
  scratch.begin(w.graph.lanelets.size + w.graph.connectors.size);
  const cap = noteSearch(w);
  const end = goalEnd(w, goal)!;
  const toGo = (slot: number): number => {
    let h = scratch.boundOf(slot);
    if (h === undefined) scratch.setBound(slot, h = laneLowerBound(w, scratch.ids[slot]!, end));
    return h;
  };
  const startSlot = scratch.slot(start);
  const startState = startSlot * 2;
  if (!startChange) scratch.markPlainNoChange(startState);
  scratch.setBest(startState, 0, -1, -1);
  scratch.push(startState, 0, toGo(startSlot));

  let reached = -1, reachedCost = 0, expanded = 0;
  while (scratch.size) {
    const state = scratch.pop();
    const nodeCost = scratch.poppedCost;
    if (nodeCost > scratch.best(state) + 1e-9) continue;
    // DO NOT walk the whole map for one car: past the cap there is no plan (`SEARCH_EXPANSIONS`).
    if (++expanded > cap) { noteCapped(w); return null; }
    const nodeLane = scratch.ids[state >> 1]!;
    if (nodeLane === goal) {
      reached = state;
      reachedCost = nodeCost;
      break;
    }
    const lane = w.lanelet(nodeLane);
    if (!lane || lane.kind !== 'link') continue;

    for (const id of w.graph.exitsOf(nodeLane)) {
      const step = connectorCost(w, id, body, shape);
      if (!Number.isFinite(step)) continue;
      const out = w.connector(id)!.toLane;
      relax(scratch, scratch.slot(out) * 2, nodeCost + step, toGo, state, scratch.slot(id));
    }

    if (scratch.changed(state) || lane.laneIndex === undefined) continue;
    const room = nodeLane === start ? lane.length - startS : lane.length;
    // Only across dashed lines, into lanes this vehicle may drive.
    for (const sibling of w.graph.changeTargets(nodeLane, shape)) {
      const other = w.lanelet(sibling);
      if (!other || other.kind !== 'link' || other.laneIndex === undefined || w.rt(sibling).ghost) continue;
      const lanes = Math.abs(other.laneIndex - lane.laneIndex);
      if (lanes === 0 || room < lanes * ROOM_PER_LANE) continue;
      relax(scratch, scratch.slot(sibling) * 2 + 1, nodeCost + lanes * CHANGE_COST, toGo, state, -1);
    }
  }
  if (reached < 0) return null;

  // The steps, goal back to start.
  const lanes: LaneletId[] = [], connectors: (LaneletId | null)[] = [];
  for (let state = reached; state !== startState;) {
    if (scratch.best(state) === Infinity) return null;
    const via = scratch.via[state]!;
    lanes.push(scratch.ids[state >> 1]!);
    connectors.push(via < 0 ? null : scratch.ids[via]!);
    state = scratch.parent[state]!;
  }
  const last = lanes.length - 1;

  if (last >= 0 && connectors[last] === null) {
    // Change lanes here first. The route is the trip as driven without it.
    const changeTo = lanes[last]!;
    const intent = last >= 1 ? connectors[last - 1]! : null;
    const without = fallback ? planTrip(w, start, startS, goal, body, false, shape) : null;
    return {
      route: without?.route ?? [start],
      changeTo,
      intent,
      cost: reachedCost,
    };
  }

  const route: LaneletId[] = [start];
  for (let k = last; k >= 0; k--) {
    // The next change is made on the lane the route has reached: it ends there.
    const connector = connectors[k]!;
    if (connector === null) break;
    route.push(connector, lanes[k]!);
  }
  return { route, changeTo: null, intent: null, cost: reachedCost };
}

/** DO NOT make anything for a state before knowing it is kept: most are not (the allocation profile, 2026-10-17: `planTrip` 317 MB in the simulation's worker). */
function relax(scratch: SearchScratch, state: number, cost: number, toGo: (slot: number) => number, from: number, via: number): void {
  if (cost >= scratch.best(state) - 1e-9) return;
  scratch.setBest(state, cost, from, via);
  scratch.push(state, cost, cost + toGo(state >> 1));
}
