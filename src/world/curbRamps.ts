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

interface RampSet {
  readonly revision: number;
  readonly ramps: readonly CurbRamp[];
  readonly grid: ReadonlyMap<number, readonly CurbRamp[]>;
}

const cache = new WeakMap<Network, RampSet>();

/** Every dropped kerb of the network, as built for its current revision. */
export function curbRamps(net: Network): readonly CurbRamp[] {
  return rampSet(net).ramps;
}

function rampSet(net: Network): RampSet {
  const known = cache.get(net);
  if (known && known.revision === net.revision) return known;
  const ramps: CurbRamp[] = [];
  /** A ramp each side of the street, `at` along it from the node, `half` its half width. */
  const pair = (nodeId: NodeId, segmentId: SegmentId, at: number, half: number): void => {
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
  for (const [nodeId, node] of net.doc.nodes) {
    // A street that leads nowhere is crossed at its end, with no zebra
    // (`walkways.ts`, the unmarked crossing): a dropped kerb there too.
    if (node.incident.length === 1) {
      // A turning circle is walked round, not across (`walkways.ts`).
      if (node.end !== 'bulb') pair(nodeId, node.incident[0]!, 0, UNMARKED_WIDTH / 2);
      continue;
    }
    for (const segmentId of node.incident) {
      const crossing = net.crosswalkDistanceAt(segmentId, nodeId);
      if (crossing > 0) pair(nodeId, segmentId, crossing, CROSSWALK_DEPTH / 2);
    }
  }
  const grid = new Map<number, CurbRamp[]>();
  for (const r of ramps) {
    const reach = r.half + r.flare + r.run;
    for (let cx = Math.floor((r.x - reach) / CELL); cx <= Math.floor((r.x + reach) / CELL); cx++) {
      for (let cy = Math.floor((r.y - reach) / CELL); cy <= Math.floor((r.y + reach) / CELL); cy++) {
        const key = cellKey(cx, cy);
        const list = grid.get(key);
        if (list) list.push(r); else grid.set(key, [r]);
      }
    }
  }
  const set = { revision: net.revision, ramps, grid };
  cache.set(net, set);
  return set;
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
  const { grid } = rampSet(net);
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
