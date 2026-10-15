import type { NodeId, SegmentId } from './ids';
import type { Network } from './network';
import { CROSSWALK_DEPTH } from './approach';
import { orientedPolyline } from './geometry';
import { carriesPedestrians } from './pedestrianAccess';
import { FOOTWAY_RISE, roadProfile } from './roadTypes';
import { m } from './units';

/**
 * THE DROPPED KERBS: at each end of every zebra the footway ramps down to the
 * carriageway, so nobody steps off a 15 cm kerb onto a crossing - and nobody
 * drawn on one is lowered 15 cm in a single frame, which is what a walker
 * reaching the zebra did while the footway ran at full height to its edge.
 *
 * A curb ramp (curb cut, dropped kerb) slopes no steeper than 1:12, its flared
 * sides no steeper than 1:10, and is at least 1 m wide (US accessibility
 * guidance, as Wikipedia "Curb cut" gives it; the Brazilian NBR 9050 asks the
 * same 8.33 %). Here each is the zebra's own width, from the kerb face into the
 * footway, the flares either side along the street.
 *
 * One function says how high the walking surface stands at a point
 * (`walkingRise`): the footway's mesh, its kerb and the people standing on it
 * read the same, so the body meets the paving drawn under its feet.
 */
export interface CurbRamp {
  /** The middle of the ramp's foot, on the kerb face (the carriageway's edge). */
  readonly x: number;
  readonly y: number;
  /** Along the street. */
  readonly tx: number;
  readonly ty: number;
  /** Across the street, from the carriageway into the footway. */
  readonly nx: number;
  readonly ny: number;
  /** Half the ramp's width along the street (half the zebra's). */
  readonly half: number;
  /** How far into the footway the slope runs, to the footway's full height. */
  readonly run: number;
  /** Length of each flared side along the street. */
  readonly flare: number;
  /** The street whose zebra it serves. */
  readonly segment: SegmentId;
  readonly structure: string;
}

/** The steepest ramp: 1 in 12. */
const RAMP_RUN = FOOTWAY_RISE * 12;
/** The steepest flare: 1 in 10. */
const FLARE_RUN = FOOTWAY_RISE * 10;
/** The width of the unmarked crossing at a road's end (`walkways.ts`). */
const UNMARKED_WIDTH = m(2);
/** How far onto the carriageway a ramp still answers, so a walker's step off it is level. */
const ROAD_REACH = m(0.6);
/** Bucket size of the lookup grid. */
const CELL = m(20);
/**
 * A grid cell's key as a number: `walkingRise` is asked for every walker drawn
 * every frame, and a string key there was a string per person per frame.
 */
const cellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

/**
 * The dropped kerbs of a network, kept node by node across its rebuilds: a
 * node's ramps are worked out again only when the network's change since the
 * last ask (`Network.changesSince`) names the node, one of its roads, or a
 * place one of its roads reaches (a crossing is fitted to the footway there,
 * `Network.crosswalkDistanceAt`). Each ramp is filed in the cells it reaches.
 * DO NOT build every ramp of the map again on a revision: `walkingRise` is
 * asked for every walker every frame, and its first ask after each edit paid
 * for every zebra of the city.
 */
interface RampState {
  /** The network's state the ramps stand for (`Network.state`); null before the first ask. */
  state: object | null;
  readonly byNode: Map<NodeId, readonly CurbRamp[]>;
  readonly grid: Map<number, CurbRamp[]>;
  /** Every ramp, node by node; null until asked after a change. */
  list: readonly CurbRamp[] | null;
}

const cache = new WeakMap<Network, RampState>();

/** Every dropped kerb of the network, as it stands. */
export function curbRamps(net: Network): readonly CurbRamp[] {
  const state = rampState(net);
  if (!state.list) {
    const list: CurbRamp[] = [];
    // Node by node in the order they were placed (the document's order when
    // all were made at once; a node given ramps later comes last).
    for (const ramps of state.byNode.values()) for (const r of ramps) list.push(r);
    state.list = list;
  }
  return state.list;
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
  // A street that leads nowhere is crossed at its end, with no zebra
  // (`walkways.ts`, the unmarked crossing): a dropped kerb there too.
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

/** Calls `visit` with the key of every cell a ramp reaches. */
function rampCells(r: CurbRamp, visit: (key: number) => void): void {
  const reach = r.half + r.flare + r.run;
  for (let cx = Math.floor((r.x - reach) / CELL); cx <= Math.floor((r.x + reach) / CELL); cx++) {
    for (let cy = Math.floor((r.y - reach) / CELL); cy <= Math.floor((r.y + reach) / CELL); cy++) visit(cellKey(cx, cy));
  }
}

/** A node's ramps worked out again and filed, its old ones taken out of their cells. */
function place(net: Network, state: RampState, nodeId: NodeId): void {
  for (const r of state.byNode.get(nodeId) ?? []) {
    rampCells(r, (key) => {
      const list = state.grid.get(key);
      if (!list) return;
      const at = list.indexOf(r);
      if (at >= 0) list.splice(at, 1);
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
  if (!state) cache.set(net, state = { state: null, byNode: new Map(), grid: new Map(), list: null });
  if (state.state === net.state) return state;
  const delta = state.state === null ? null : net.changesSince(state.state);
  state.state = net.state;
  state.list = null;
  if (delta === null) { placeAll(net, state); return state; }
  const dirty = new Set<NodeId>(delta.nodes);
  const ends = (seg: SegmentId): void => {
    const s = net.doc.segment(seg);
    if (s) { dirty.add(s.a); dirty.add(s.b); }
  };
  for (const seg of delta.segments) ends(seg);
  // A crossing is fitted to the footway along its road: a change where the road reaches moves it.
  for (const rect of delta.rects) for (const seg of net.segmentCells.idsMeeting(rect)) ends(seg);
  for (const id of dirty) place(net, state, id);
  return state;
}

/**
 * How high the walking surface stands at (x, y), as a share of the footway's
 * rise: 1 on the footway, 0 on the carriageway, and in between on a dropped
 * kerb - 0 at its foot, 1 where its slope (or a flare) meets the footway.
 * `onFootway` says which side the point is taken to be on away from any ramp;
 * inside one, both sides read the same, so stepping from the footway onto the
 * zebra is level.
 */
export function walkingRise(net: Network, x: number, y: number, onFootway: boolean, structure = 'ground'): number {
  const { grid } = rampState(net);
  const list = grid.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
  let share = onFootway ? 1 : 0;
  if (!list) return share;
  let inside = false;
  let low = 1;
  for (const r of list) {
    if (r.structure !== structure) continue;
    const dx = x - r.x, dy = y - r.y;
    const u = Math.abs(dx * r.tx + dy * r.ty);
    const v = dx * r.nx + dy * r.ny;
    if (u > r.half + r.flare || v > r.run || v < -ROAD_REACH) continue;
    inside = true;
    let f = v <= 0 ? 0 : v / r.run;
    if (u > r.half) f = Math.max(f, (u - r.half) / r.flare);
    low = Math.min(low, Math.min(1, f));
  }
  if (inside) share = low;
  return share;
}

/** A ramp's outline, its flares included, for cutting the footway and the kerb (rings of [x, y]). */
export function rampOutline(r: CurbRamp): [number, number][] {
  const u = r.half + r.flare;
  const v0 = -m(0.02), v1 = r.run;
  const at = (a: number, b: number): [number, number] => [r.x + r.tx * a + r.nx * b, r.y + r.ty * a + r.ny * b];
  return [at(-u, v0), at(u, v0), at(u, v1), at(-u, v1)];
}
