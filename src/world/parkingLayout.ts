import type { Digest } from '@core/digest';
import { simplifyLine } from '@core/simplifyLine';
import type { Vec2 } from '@core/vec2';
import type { Polyline } from '@core/polyline';
import type { RoadDoc } from './doc';
import type { NodeId, SegmentId } from './ids';
import type { Network, SegmentRibbon } from './network';
import { CROSSWALK_DEPTH } from './approach';
import { entrancesOf } from './buildingGates';
// Where they were first: the far roads and the tests read them from here too.
export { entrancesOf, gatesOf } from './buildingGates';
import { CORNER_CLEAR, CROSSING_CLEAR, PARKING_PITCH, type ParkingKind } from './parking';
import { m, stepsIn } from './units';

/** Where the parking bays of every street lie, and the paint that marks them. */

interface ParkingBay {
  readonly segment: SegmentId;
  /** +1: left of the segment's a -> b direction; -1: right. */
  readonly side: 1 | -1;
  readonly kind: ParkingKind;
  /** The stall as drawn: kerb start, kerb end, inner end, inner start. */
  readonly corners: readonly [Vec2, Vec2, Vec2, Vec2];
  /** Middle of the stall. */
  readonly centre: Vec2;
  /** Unit direction a parked car faces (its nose). */
  readonly facing: Vec2;
}

export interface ParkingLine {
  readonly segment: SegmentId;
  readonly points: readonly Vec2[];
  readonly width: number;
  readonly color: string;
  /** Paint and gap along the line, world units; null for a continuous line. */
  readonly dash: readonly number[] | null;
}

export interface ParkingLayout {
  readonly bays: readonly ParkingBay[];
  readonly lines: readonly ParkingLine[];
}

const BAY_LINE = m(0.12);
const NO_PARKING_LINE = m(0.12);
const WHITE = '#efece0';
/** The MER's dashes along the parking lane: 1 m of paint, 1 m clear. */
const MER_DASH: readonly number[] = [m(1), m(1)];
const YELLOW = '#e1c45a';
/** The red of a ciclofaixa's paving. */
const CYCLE_RED = '#a8473e';
/** Every colour the parking's lines are painted in (`render/markings.ts` `PAINT_COLOURS`). */
export const PARKING_PAINT: readonly string[] = Object.freeze([WHITE, YELLOW, CYCLE_RED]);
/** Kept clear either side of a lot's frontage for its entrance. */
const ENTRANCE_MARGIN = m(1);
/** Step of the paint along a run, so a line follows a curve. */
const RUN_STEP = m(1);
/** A point of a run's line nearer than this to the line through its neighbours carries no shape: left out. */
const STRAIGHT = m(0.001);

/** DO NOT hand every entrance of the map to every street: each street with parking tested every gate of the city. */
export function parkingLayout(net: Network, entrances: readonly [Vec2, Vec2][] | null = null): ParkingLayout {
  const bays: ParkingBay[] = [];
  const lines: ParkingLine[] = [];
  for (const ribbon of net.ribbons.values()) parkingOf(net, ribbon, entrances, bays, lines);
  return { bays, lines };
}

/** The paint of one street's parking (`parkingLayout`); `entrances`: the gates within its reach (`gatesNear`), read from the document's buildings when none. */
export function parkingLinesOf(net: Network, ribbon: SegmentRibbon, entrances: readonly [Vec2, Vec2][] | null = null): ParkingLine[] {
  const lines: ParkingLine[] = [];
  parkingOf(net, ribbon, entrances, [], lines);
  return lines;
}

/** The entrances of `gates` (`gatesOf`) a street of half width `half` along `line` may read: those `entrancesNear` would hand it, for a road bake without the buildings (`render/nearRoadTiles.ts`). */
export function gatesNear(gates: ArrayLike<number>, line: Polyline, half: number): [Vec2, Vec2][] {
  const reach = half + m(8);
  const bb = line.bbox;
  const out: [Vec2, Vec2][] = [];
  for (let k = 0; k + 3 < gates.length; k += 4) {
    const x0 = gates[k]!, y0 = gates[k + 1]!, x1 = gates[k + 2]!, y1 = gates[k + 3]!;
    if (Math.max(x0, x1) < bb.minX - reach || Math.min(x0, x1) > bb.maxX + reach || Math.max(y0, y1) < bb.minY - reach || Math.min(y0, y1) > bb.maxY + reach) continue;
    out.push([{ x: x0, y: y0 }, { x: x1, y: y1 }]);
  }
  return out;
}

/** Whether a street has parking laid out at all (`parkingOf`): only then do the buildings near it move its paint. */
export function parksAlong(net: Network, ribbon: SegmentRibbon): boolean {
  const rt = ribbon.road;
  return (rt.parkingLeft > 0 || rt.parkingRight > 0) && net.doc.segment(ribbon.id)?.structure === 'ground';
}

/** DO NOT read anything in `parkingOf` without adding it here: what one street's bays are laid out from besides the entrances it is handed, into `digest` (a tile's baked kerb bays are taken where it is the same, `sim/tileBays.ts`). */
export function parkingDigest(net: Network, ribbon: SegmentRibbon, digest: Digest): Digest {
  const segment = net.doc.segment(ribbon.id);
  if (!segment || !parksAlong(net, ribbon)) return digest.add(0);
  const rt = ribbon.road;
  return digest.add(1).add(rt.width).add(rt.parkingLeft).add(rt.parkingRight).addText(rt.parkingLeftKind).addText(rt.parkingRightKind)
    .addText(segment.direction).addAll(ribbon.full.xy)
    .add(endClear(net, ribbon.id, segment.a)).add(endClear(net, ribbon.id, segment.b))
    .add(net.mouthDistance(ribbon.id, segment.a)).add(net.mouthDistance(ribbon.id, segment.b));
}

/** One street's bays and lines, onto `bays` and `lines`. */
function parkingOf(net: Network, ribbon: SegmentRibbon, entrances: readonly [Vec2, Vec2][] | null,
  bays: ParkingBay[], lines: ParkingLine[]): void {
  const doc = net.doc;
  const rt = ribbon.road;
  if (!parksAlong(net, ribbon)) return;
  const segment = doc.segment(ribbon.id);
  if (!segment) return;
  const line = ribbon.full;
  const length = line.length;
  const half = rt.width / 2;
  const s0 = endClear(net, ribbon.id, segment.a);
  const s1 = length - endClear(net, ribbon.id, segment.b);
  const mouthA = net.mouthDistance(ribbon.id, segment.a);
  const mouthB = length - net.mouthDistance(ribbon.id, segment.b);
  // The buildings' entrances near the street read once for both its sides, and only if a side parks.
  let near = entrances;
  for (const side of [1, -1] as const) {
    const kind = side === 1 ? rt.parkingLeftKind : rt.parkingRightKind;
    const depth = side === 1 ? rt.parkingLeft : rt.parkingRight;
    if (kind === 'none' || depth <= 0) continue;
    if (kind === 'cycle') {
      // A cycle lane: red from mouth to mouth, a solid white line on the side of the traffic.
      const run = [Math.max(0, mouthA), Math.min(length, mouthB)] as const;
      if (run[1] - run[0] < m(4)) continue;
      const along = (offset: number): Vec2[] => {
        const pts: Vec2[] = [];
        const n = Math.max(2, Math.ceil(stepsIn(run[1] - run[0], 2)) + 1);
        for (let i = 0; i < n; i++) {
          const f = line.sampleAt(run[0] + ((run[1] - run[0]) * i) / (n - 1));
          pts.push({ x: f.p.x + f.n.x * offset * side, y: f.p.y + f.n.y * offset * side });
        }
        return simplifyLine(pts, STRAIGHT);
      };
      lines.push({ segment: ribbon.id, points: along(half - depth / 2), width: depth - m(0.1), color: CYCLE_RED, dash: null });
      lines.push({ segment: ribbon.id, points: along(half - depth + m(0.06)), width: m(0.12), color: WHITE, dash: null });
      continue;
    }
    // Which way a car moving on this side travels, along a -> b.
    const travel = segment.direction === 'aToB' ? 1 : segment.direction === 'bToA' ? -1 : side === 1 ? -1 : 1;
    const blocked = frontagesOn(line, half, side, near ??= entrancesNear(doc, line, half));
    const runs = subtract([[s0, s1]], blocked);
    const pitch = PARKING_PITCH[kind];
    const at = (s: number, offset: number): Vec2 => {
      const f = line.sampleAt(Math.max(0, Math.min(length, s)));
      return { x: f.p.x + f.n.x * offset * side, y: f.p.y + f.n.y * offset * side };
    };
    const kerb = half, inner = half - depth;
    /** A line `offset` from the road's, from `lo` to `hi`: a point a metre where the street bends, none where it runs straight
     *  (DO NOT keep the metre's points on a straight kerb: each cut the line into another quad and each dash in two, `paintQuads.ts`). */
    const runLine = (lo: number, hi: number, offset: number): Vec2[] => simplifyLine(stations(lo, hi).map((s) => at(s, offset)), STRAIGHT);
    let parked: [number, number][] = [];
    for (const [lo, hi] of runs) {
      const count = Math.floor((hi - lo) / pitch + 1e-6);
      if (count < 1) continue;
      // Bays along the kerb, following the road's line
      const first = lo + (hi - lo - count * pitch) / 2;
      for (let k = 0; k < count; k++) {
        const a = first + k * pitch, b = a + pitch;
        const corners: [Vec2, Vec2, Vec2, Vec2] = [at(a, kerb), at(b, kerb), at(b, inner), at(a, inner)];
        const mid = line.sampleAt(Math.max(0, Math.min(length, (a + b) / 2)));
        const centre = { x: mid.p.x + mid.n.x * (kerb + inner) / 2 * side, y: mid.p.y + mid.n.y * (kerb + inner) / 2 * side };
        // A parked car faces the way the traffic beside it goes.
        bays.push({ segment: ribbon.id, side, kind, corners, centre, facing: { x: mid.t.x * travel, y: mid.t.y * travel } });
        // The division between this bay and the next, from the kerb across the lane.
        if (k > 0) lines.push({ segment: ribbon.id, points: [at(a, kerb), at(a, inner)], width: BAY_LINE, color: WHITE, dash: null });
      }
      const last = first + count * pitch;
      // The run closed across the parking lane at both ends.
      lines.push({ segment: ribbon.id, points: [at(first, kerb), at(first, inner)], width: BAY_LINE, color: WHITE, dash: null });
      lines.push({ segment: ribbon.id, points: [at(last, kerb), at(last, inner)], width: BAY_LINE, color: WHITE, dash: null });
      // The parking lane's edge, dashed along the whole run, following the road.
      lines.push({ segment: ribbon.id, points: runLine(first, last, inner), width: BAY_LINE, color: WHITE, dash: MER_DASH });
      parked.push([first, last]);
    }
    parked = parked.sort((p, q) => p[0] - q[0]);
    // No parking along the rest of this kerb: a yellow line beside it.
    const offset = kerb - m(0.25);
    for (const [lo, hi] of subtract([[mouthA, mouthB]], parked)) {
      if (hi - lo < m(0.5)) continue;
      lines.push({ segment: ribbon.id, points: runLine(lo, hi, offset), width: NO_PARKING_LINE, color: YELLOW, dash: null });
    }
  }
}

/** Stations from `lo` to `hi`, one a metre and both ends. */
function stations(lo: number, hi: number): number[] {
  const out: number[] = [];
  const n = Math.max(1, Math.ceil((hi - lo) / RUN_STEP));
  for (let i = 0; i <= n; i++) out.push(lo + ((hi - lo) * i) / n);
  return out;
}

/** How far from a node no bay may start: the corner clearance, or clear of the crossing. */
function endClear(net: Network, seg: SegmentId, node: NodeId): number {
  const doc = net.doc;
  const degree = doc.degree(node);
  const mouth = net.mouthDistance(seg, node);
  if (degree <= 1) return m(1);
  const crossing = net.crosswalkDistanceAt(seg, node);
  const pastCrossing = crossing > 0 ? crossing + CROSSWALK_DEPTH / 2 + CROSSING_CLEAR : 0;
  if (degree === 2 && !doc.node(node)?.crossing) return Math.max(mouth, pastCrossing);
  return Math.max(mouth + CORNER_CLEAR, pastCrossing, net.stopLineDistance(seg, node) + CROSSING_CLEAR);
}

/** The entrances of the buildings within reach of a street (`frontagesOn`'s reach). */
function entrancesNear(doc: RoadDoc, line: Polyline, half: number): [Vec2, Vec2][] {
  const reach = half + m(8);
  const bb = line.bbox;
  const out: [Vec2, Vec2][] = [];
  for (const b of doc.buildings.near(bb.minX - reach, bb.minY - reach, bb.maxX + reach, bb.maxY + reach)) out.push(...entrancesOf(b));
  return out;
}

/** Intervals along `line` in front of a lot entrance on one side. */
function frontagesOn(line: Polyline, half: number, side: 1 | -1, entrances: readonly [Vec2, Vec2][]): [number, number][] {
  const out: [number, number][] = [];
  const hit = { s: 0, distance: 0 };
  const reach = half + m(8);
  const bb = line.bbox;
  for (const [p, q] of entrances) {
    if (Math.max(p.x, q.x) < bb.minX - reach || Math.min(p.x, q.x) > bb.maxX + reach ||
      Math.max(p.y, q.y) < bb.minY - reach || Math.min(p.y, q.y) > bb.maxY + reach) continue;
    // An edge facing the road: both ends near it and on this side.
    let lo = Infinity, hi = -Infinity, ok = true;
    for (const point of [p, q]) {
      line.closestInto(point.x, point.y, hit);
      const f = line.sampleAt(hit.s);
      const across = (point.x - f.p.x) * f.n.x + (point.y - f.p.y) * f.n.y;
      if (across * side <= 0 || Math.abs(across) > reach) { ok = false; break; }
      lo = Math.min(lo, hit.s);
      hi = Math.max(hi, hit.s);
    }
    if (ok && hi > lo) out.push([lo - ENTRANCE_MARGIN, hi + ENTRANCE_MARGIN]);
  }
  return out;
}

/** `from` with every interval of `cut` removed. */
function subtract(from: readonly [number, number][], cut: readonly [number, number][]): [number, number][] {
  let out = from.filter(([lo, hi]) => hi > lo).map(([lo, hi]) => [lo, hi] as [number, number]);
  for (const [clo, chi] of cut) {
    const next: [number, number][] = [];
    for (const [lo, hi] of out) {
      if (chi <= lo || clo >= hi) { next.push([lo, hi]); continue; }
      if (clo > lo) next.push([lo, clo]);
      if (chi < hi) next.push([chi, hi]);
    }
    out = next;
  }
  return out;
}
