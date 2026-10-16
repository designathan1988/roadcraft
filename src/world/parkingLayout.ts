import type { Vec2 } from '@core/vec2';
import type { Polyline } from '@core/polyline';
import type { RoadDoc } from './doc';
import type { NodeId, SegmentId } from './ids';
import type { Network, SegmentRibbon } from './network';
import { CROSSWALK_DEPTH } from './approach';
import { localToWorld } from './buildings/geometry';
import type { Building } from './buildings/types';
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
/** The narrowest gate a car goes through (a person's is 1.2 m); `sim/agents/parking.ts` `CAR_GATE`. */
const CAR_GATE_WIDTH = m(2.2);
/** Kept clear either side of a lot's frontage for its entrance. */
const ENTRANCE_MARGIN = m(1);
/** Step of the paint along a run, so a line follows a curve. */
const RUN_STEP = m(1);

/** One building's entrances: its car gates and the edges of its parking, worked out when its traffic record is sent (the worker keeps them, the page does not). */
export const entrancesOf = (b: Building): readonly [Vec2, Vec2][] => workOutEntrances(b);

/** Each record's entrances, worked out once (`entrancesOf`: records are never changed, only replaced). */
function workOutEntrances(b: Building): readonly [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  // Every car gate is a lowered kerb (CTB art. 181 IX: no parking where the kerb is lowered for vehicles to go in or out)
  for (const el of b.elements ?? []) {
    if (el.kind !== 'gate' || el.w < CAR_GATE_WIDTH) continue;
    const alongY = el.facing === 1 || el.facing === 3;
    const c = Math.cos(el.angle ?? 0), s = Math.sin(el.angle ?? 0);
    const ux = alongY ? -s : c, uy = alongY ? c : s;
    out.push([localToWorld(b, el.x - ux * el.w / 2, el.y - uy * el.w / 2), localToWorld(b, el.x + ux * el.w / 2, el.y + uy * el.w / 2)]);
  }
  for (const el of b.elements ?? []) {
    if (el.kind !== 'parking') continue;
    const lot = b.volumes.find((v) => v.open && el.x >= v.x && el.x <= v.x + v.w && el.y >= v.y && el.y <= v.y + v.d);
    const box = lot ?? { x: el.x - el.w / 2, y: el.y - el.d / 2, w: el.w, d: el.d };
    const corners = [
      localToWorld(b, box.x, box.y), localToWorld(b, box.x + box.w, box.y),
      localToWorld(b, box.x + box.w, box.y + box.d), localToWorld(b, box.x, box.y + box.d),
    ];
    for (let i = 0; i < 4; i++) out.push([corners[i]!, corners[(i + 1) % 4]!]);
  }
  return out;
}

/** DO NOT hand every entrance of the map to every street: each street with parking tested every gate of the city. */
export function parkingLayout(net: Network, entrances: readonly [Vec2, Vec2][] | null = null): ParkingLayout {
  const bays: ParkingBay[] = [];
  const lines: ParkingLine[] = [];
  for (const ribbon of net.ribbons.values()) parkingOf(net, ribbon, entrances, bays, lines);
  return { bays, lines };
}

/** The paint of one street's parking (`parkingLayout`) */
export function parkingLinesOf(net: Network, ribbon: SegmentRibbon): ParkingLine[] {
  const lines: ParkingLine[] = [];
  parkingOf(net, ribbon, null, [], lines);
  return lines;
}

/** Whether a street has parking laid out at all (`parkingOf`): only then do the buildings near it move its paint. */
export function parksAlong(net: Network, ribbon: SegmentRibbon): boolean {
  const rt = ribbon.road;
  return (rt.parkingLeft > 0 || rt.parkingRight > 0) && net.doc.segment(ribbon.id)?.structure === 'ground';
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
        return pts;
      };
      lines.push({ segment: ribbon.id, points: along(half - depth / 2), width: depth - m(0.1), color: CYCLE_RED, dash: null });
      lines.push({ segment: ribbon.id, points: along(half - depth + m(0.06)), width: m(0.12), color: WHITE, dash: null });
      continue;
    }
    // Which way a car moving on this side travels, along a -> b.
    const travel = segment.direction === 'aToB' ? 1 : segment.direction === 'bToA' ? -1 : side === 1 ? -1 : 1;
    const blocked = frontagesOn(line, half, side, entrances ?? entrancesNear(doc, line, half));
    const runs = subtract([[s0, s1]], blocked);
    const pitch = PARKING_PITCH[kind];
    const at = (s: number, offset: number): Vec2 => {
      const f = line.sampleAt(Math.max(0, Math.min(length, s)));
      return { x: f.p.x + f.n.x * offset * side, y: f.p.y + f.n.y * offset * side };
    };
    const kerb = half, inner = half - depth;
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
      lines.push({ segment: ribbon.id, points: stations(first, last).map((s) => at(s, inner)), width: BAY_LINE, color: WHITE, dash: MER_DASH });
      parked.push([first, last]);
    }
    parked = parked.sort((p, q) => p[0] - q[0]);
    // No parking along the rest of this kerb: a yellow line beside it.
    const offset = kerb - m(0.25);
    for (const [lo, hi] of subtract([[mouthA, mouthB]], parked)) {
      if (hi - lo < m(0.5)) continue;
      lines.push({ segment: ribbon.id, points: stations(lo, hi).map((s) => at(s, offset)), width: NO_PARKING_LINE, color: YELLOW, dash: null });
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
