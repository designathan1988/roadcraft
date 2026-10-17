import type { NodeId, SegmentId } from './ids';
import type { Network } from './network';
import { CROSSWALK_DEPTH } from './approach';
import { orientedPolyline } from './geometry';
import { carriesPedestrians } from './pedestrianAccess';
import { FOOTWAY_RISE, roadProfile } from './roadTypes';
import { m } from './units';
import { RAMP_CELL, rampCellKey, rampCells, rampRiseIn, type CurbRamp } from './rampRise';

export type { CurbRamp } from './rampRise';

/** THE DROPPED KERBS: at each end of every zebra the footway ramps down to the carriageway */

/** The steepest ramp: 1 in 12. */
const RAMP_RUN = FOOTWAY_RISE * 12;
/** The steepest flare: 1 in 10. */
const FLARE_RUN = FOOTWAY_RISE * 10;
/** The width of the unmarked crossing at a road's end (`walkways.ts`). */
const UNMARKED_WIDTH = m(2);
/** DO NOT build every ramp of the map again on a revision */
interface RampState {
  /** The network's state the ramps stand for (`Network.state`); null before the first ask. */
  state: object | null;
  readonly byNode: Map<NodeId, readonly CurbRamp[]>;
  readonly grid: Map<number, CurbRamp[]>;
}

const cache = new WeakMap<Network, RampState>();

/** The dropped kerbs of one node, as it stands (`rampState` brought up to the network first) */
export function rampsOfNode(net: Network, node: NodeId): readonly CurbRamp[] {
  return rampState(net).byNode.get(node) ?? [];
}

/** The ramps a node's zebras (and a road's end there) have. */
function rampsAt(net: Network, nodeId: NodeId): CurbRamp[] {
  const ramps: CurbRamp[] = [];
  const node = net.doc.node(nodeId);
  if (!node) return ramps;
  /** A ramp each side of the street, `at` along it from the node, `half` its half width. */
  const pair = (segmentId: SegmentId, at: number, half: number): void => {
    const segment = net.doc.requireSegment(segmentId);
    const road = roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking);
    if (!carriesPedestrians(road) || road.sidewalk <= 0) return;
    const frame = orientedPolyline(net.doc, segment, nodeId).sampleAt(at);
    const tx = frame.t.x, ty = frame.t.y;
    for (const side of [-1, 1] as const) {
      const nx = -ty * side, ny = tx * side;
      ramps.push({
        x: frame.p.x + nx * (road.width / 2), y: frame.p.y + ny * (road.width / 2),
        tx, ty, nx, ny, half,
        run: Math.min(RAMP_RUN, road.sidewalk),
        flare: FLARE_RUN,
        segment: segmentId,
        structure: segment.structure,
      });
    }
  };
  // A street that leads nowhere is crossed at its end, with no zebra (`walkways.ts`, the unmarked crossing)
  if (node.incident.length === 1) {
    // A turning circle is walked round, not across (`walkways.ts`).
    if (node.end !== 'bulb') pair(node.incident[0]!, 0, UNMARKED_WIDTH / 2);
    return ramps;
  }
  for (const segmentId of node.incident) {
    const crossing = net.crosswalkDistanceAt(segmentId, nodeId);
    if (crossing > 0) pair(segmentId, crossing, CROSSWALK_DEPTH / 2);
  }
  return ramps;
}

/** A node's ramps worked out again and filed, its old ones taken out of their cells. */
function place(net: Network, state: RampState, nodeId: NodeId): void {
  for (const r of state.byNode.get(nodeId) ?? []) {
    rampCells(r, (key) => {
      const list = state.grid.get(key);
      if (!list) return;
      const at = list.indexOf(r);
      // Taken out by the last one put in its place (the order of a cell's ramps is read by none: `rampRiseIn` takes the lowest).
      if (at >= 0) { list[at] = list[list.length - 1]!; list.pop(); }
      if (list.length === 0) state.grid.delete(key);
    });
  }
  const ramps = rampsAt(net, nodeId);
  if (ramps.length) state.byNode.set(nodeId, ramps); else state.byNode.delete(nodeId);
  for (const r of ramps) rampCells(r, (key) => { const list = state.grid.get(key); if (list) list.push(r); else state.grid.set(key, [r]); });
}

/** @rebuild Every node's ramps, only when the network cannot say what changed (the first ask, a load). */
function placeAll(net: Network, state: RampState): void {
  state.byNode.clear();
  state.grid.clear();
  for (const id of net.doc.nodes.keys()) place(net, state, id);
}

function rampState(net: Network): RampState {
  let state = cache.get(net);
  if (!state) cache.set(net, state = { state: null, byNode: new Map(), grid: new Map() });
  bring(net, state);
  return state;
}

/** The network rebuilt or taken back (`Network.rebuild`, `takeBack`): its ramps, where they are kept, brought up to it in that step, never while a walker reads them (`walkingRise`). */
export function followRamps(net: Network): void {
  const state = cache.get(net);
  if (state) bring(net, state);
}

/** The ramps of `state` brought up to the network: the nodes its changes reach placed again, or every node when it cannot say. */
function bring(net: Network, state: RampState): void {
  if (state.state === net.state) return;
  const delta = state.state === null ? null : net.changesSince(state.state);
  state.state = net.state;
  if (delta === null) { placeAll(net, state); return; }
  const dirty = new Set<NodeId>(delta.nodes);
  const ends = (seg: SegmentId): void => {
    const s = net.doc.segment(seg);
    if (s) { dirty.add(s.a); dirty.add(s.b); }
  };
  for (const seg of delta.segments) ends(seg);
  // A crossing is fitted to the footway along its road: a change where the road reaches moves it.
  for (const rect of delta.rects) for (const seg of net.segmentCells.idsMeeting(rect)) ends(seg);
  for (const id of dirty) place(net, state, id);
}

/** How high the walking surface stands at (x, y), as a share of the footway's rise: a read of the ramps as kept (asked by every walker drawn every frame), brought up to the network by its own rebuild (`followRamps`); made here only the first time a network's are asked */
export function walkingRise(net: Network, x: number, y: number, onFootway: boolean, structure = 'ground'): number {
  return rampRiseIn((cache.get(net) ?? rampState(net)).grid, x, y, onFootway, structure);
}

/** The ramps filed in the cells `rect` reaches (each once): every ramp `walkingRise` reads at a point of it. */
export function rampsMeeting(net: Network, rect: readonly [number, number, number, number]): Set<CurbRamp> {
  const { grid } = rampState(net);
  const out = new Set<CurbRamp>();
  for (let cx = Math.floor(rect[0] / RAMP_CELL); cx <= Math.floor(rect[2] / RAMP_CELL); cx++) {
    for (let cy = Math.floor(rect[1] / RAMP_CELL); cy <= Math.floor(rect[3] / RAMP_CELL); cy++) {
      for (const r of grid.get(rampCellKey(cx, cy)) ?? []) out.add(r);
    }
  }
  return out;
}

/** A ramp's outline, its flares included, for cutting the footway and the kerb (rings of [x, y]). */
export function rampOutline(r: CurbRamp): [number, number][] {
  const u = r.half + r.flare;
  const v0 = -m(0.02), v1 = r.run;
  const at = (a: number, b: number): [number, number] => [r.x + r.tx * a + r.nx * b, r.y + r.ty * a + r.ny * b];
  return [at(-u, v0), at(u, v0), at(u, v1), at(-u, v1)];
}
