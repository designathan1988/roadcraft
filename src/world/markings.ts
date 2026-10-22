import {
  LANE_LINE,
  Level,
  type RoadType,
  laneWidth,
  laneOffset,
  travelLanes,
  lanesPerDirection,
  markingColor,
  roadProfile,
  travelShift,
  travelWidth,
} from '@world/roadTypes';
import { frameFromNode, segmentStartsAt } from '@world/geometry';
import { laneTurnAllowed } from './roadSection';
import type { Network, SegmentRibbon } from '@world/network';
import { offsetPolyline } from '@core/offset';
import type { Vec2 } from '@core/vec2';
import type { Leg } from '@world/junction/legs';
import { TransitionAxis, taperEase } from '@world/junction/transition';
import type { NodeId } from '@world/ids';
import {
  CROSSWALK_DEPTH,
  STOP_BAR_WIDTH,
  crosswalkDistance,
  stopLineDistance,
} from '@world/approach';
import { kmh, m } from './units';
import { type MarkingStyleId, YIELD_SYMBOL, markingStyle, wordStrokes } from './roads/markingStyle';
import { approachSign, arrivesAt } from './roads/rules';
import type { Polyline } from '@core/polyline';

export interface StrokeSpec {
  readonly points: readonly Vec2[];
  readonly width: number;
  readonly color: string;
  /** Dash pattern in WORLD units, or null for a solid line. */
  readonly dash: readonly number[] | null;
  /** Dash phase in world units, so a split does not reflow the pattern. */
  readonly dashOffset: number;
  /** The points close a ring painted whole (`width` and `dash` unused): an area, not a line. */
  readonly fill?: true;
}

/** Dash pattern used for every broken line, in world units. */
const DASH: readonly number[] = [m(3.2), m(3.2)];
const DASH_PERIOD = m(6.4);

/** Lane markings for one segment. */
export function segmentMarkings(ribbon: SegmentRibbon, startS: number, cutA = 0, cutB = 0, styleId: MarkingStyleId = 'classic'): StrokeSpec[] {
  const rt = ribbon.road;
  // The map's regional standard: colours, dash and gap by the speed.
  const style = markingStyle(styleId);
  const speedKmh = rt.speedLimit / kmh(1);
  const dashPattern = style.id === 'classic' ? DASH : style.dash(speedKmh);
  const period = style.id === 'classic' ? DASH_PERIOD : dashPattern[0]! + dashPattern[1]!;
  const centreColour = style.centre ?? markingColor(rt);
  const full = ribbon.centre[Level.Asphalt];
  if (!full || full.n < 2) return [];
  // Lines along the road stop at the stop line
  const keep = full.length - cutA - cutB;
  if (keep < 1) return laneArrowMarkings(ribbon);
  const centre = cutA > 0 || cutB > 0 ? full.sub(cutA, full.length - cutB) : full;
  startS += cutA;

  const pts = centre.toPoints();
  const out: StrokeSpec[] = [];
  const phase = -((ribbon.dashOrigin + startS) % period);
  // The travel way's own centre: off the road centreline when only one side parks.
  const shift = travelShift(rt);
  const middle = Math.abs(shift) > 1e-6 ? offsetPolyline(pts, shift) : pts;

  // No painted edge lines.

  // The line between the two directions: dashed (LFO-2), solid (LFO-1) or double solid (LFO-3), as the road's section says
  const centreLine = (fallback: 'dashed' | 'solid'): void => {
    const kind = rt.centreLine ?? fallback;
    if (kind === 'double') {
      for (const side of [-1, 1]) out.push({ points: offsetPolyline(middle, side * m(0.18)), width: m(0.12), color: centreColour, dash: null, dashOffset: 0 });
    } else {
      out.push({ points: middle, width: m(0.16), color: centreColour, dash: kind === 'dashed' ? dashPattern : null, dashOffset: kind === 'dashed' ? phase : 0 });
    }
  };
  if (ribbon.direction === 'both' && rt.markings === 'center') centreLine('dashed');

  // The line between lane k and k + 1 of one direction: dashed where a lane change is allowed
  const divider = (forward: boolean, k: number): Pick<StrokeSpec, 'width' | 'dash' | 'dashOffset'> => {
    const uses = forward ? rt.useForward : rt.useBackward;
    const bus = (uses?.[k] ?? 'all') !== (uses?.[k + 1] ?? 'all');
    const solid = bus || ((forward ? rt.linesForward : rt.linesBackward)?.[k] ?? 'dashed') === 'solid';
    return { width: bus ? m(0.248) : m(0.128), dash: solid ? null : dashPattern, dashOffset: solid ? 0 : phase };
  };
  if (ribbon.direction !== 'both') {
    const lw = laneWidth(rt);
    const forward = ribbon.direction === 'aToB';
    for (let i = 1; i < rt.lanes; i++) {
      out.push({
        points: offsetPolyline(pts, -rt.width / 2 + rt.parkingRight + lw * i),
        color: LANE_LINE,
        ...divider(forward, forward ? rt.lanes - 1 - i : i - 1),
      });
    }
  } else if (rt.markings === 'lanes') {
    // A four-lane road without a median still needs a centreline separating the two directions.
    if (rt.median === 0) centreLine('solid');
    const lpd = lanesPerDirection(rt);
    const lw = laneWidth(rt);
    for (let i = 1; i < lpd; i++) {
      const off = rt.median / 2 + lw * i;
      // Left of a -> b: the backward lanes; right: the forward ones (lane 0 by the middle).
      out.push({ points: offsetPolyline(pts, shift + off), color: LANE_LINE, ...divider(false, i - 1) });
      out.push({ points: offsetPolyline(pts, shift - off), color: LANE_LINE, ...divider(true, i - 1) });
    }
  }

  out.push(...laneArrowMarkings(ribbon));
  out.push(...busLegends(ribbon, centre, style.busText, style.legendHeight(speedKmh)));
  return out;
}

/** How far from each end of a stretch a bus lane's legend is first painted, and then every so far. */
const LEGEND_FIRST = m(12);
const LEGEND_EVERY = m(70);

/** The legend along a bus lane MBST vol. IV, 4.5.1 and 8.3: a legend may be painted along the */
function busLegends(ribbon: SegmentRibbon, centre: Polyline, text: string, height: number): StrokeSpec[] {
  const rt = ribbon.road;
  const out: StrokeSpec[] = [];
  const word = wordStrokes(text);
  if (!word.strokes.length || centre.length < LEGEND_FIRST * 2 + height) return out;
  const letter = Math.min((laneWidth(rt) * 0.78) / Math.max(1, word.width), height * 0.5);
  for (const forward of [true, false]) {
    if (ribbon.direction === (forward ? 'bToA' : 'aToB')) continue;
    const uses = forward ? rt.useForward : rt.useBackward;
    if (!uses) continue;
    for (let lane = 0; lane < travelLanes(rt, ribbon.direction); lane++) {
      if (uses[lane] !== 'bus') continue;
      for (let k = LEGEND_FIRST; k + height < centre.length - LEGEND_FIRST; k += LEGEND_EVERY) {
        paintInLane(out, ribbon, centre, forward, lane, k, word, letter, height, m(0.2));
      }
    }
  }
  return out;
}

/** A word or symbol painted in one lane (`strokes` in a box `width` wide and one long), read by the driver coming along it */
function paintInLane(
  out: StrokeSpec[], ribbon: SegmentRibbon, centre: Polyline, forward: boolean, lane: number, along: number,
  word: { readonly strokes: readonly (readonly (readonly [number, number])[])[]; readonly width: number },
  letter: number, height: number, width: number,
): void {
  const sign = forward ? 1 : -1;
  const offset = laneOffset(ribbon.road, lane, ribbon.direction, forward) * sign;
  const across = word.width * letter;
  const at = (x: number, y: number): Vec2 => {
    const s = along + y * height;
    const f = centre.sampleAt(forward ? s : centre.length - s);
    // The driver's right is -n going a to b, +n going back.
    const d = offset + (x * letter - across / 2) * -sign;
    return { x: f.p.x + f.n.x * d, y: f.p.y + f.n.y * d };
  };
  for (const line of word.strokes) out.push({ points: line.map(([x, y]) => at(x, y)), width, color: LANE_LINE, dash: null, dashOffset: 0 });
}

/** Clear floor between a stop line and the legend before it. */
const LEGEND_GAP = m(1.5);

/** What a junction's rule paints on each leg before its stop line (MBST vol. IV): "PARE" */
export function approachLegends(net: Network, styleId: MarkingStyleId): StrokeSpec[] {
  const out: StrokeSpec[] = [];
  for (const node of net.doc.nodes.keys()) approachLegendsAt(net, node, styleId, out);
  return out;
}

/** `approachLegends` of one node, onto `out`: what the surfaces paint of it again when an edit reaches it. */
export function approachLegendsAt(net: Network, nodeId: NodeId, styleId: MarkingStyleId, out: StrokeSpec[]): void {
  const node = net.doc.node(nodeId);
  if (!node || node.incident.length < 3) return;
  const style = markingStyle(styleId);
  for (const segId of node.incident) {
    const kind = approachSign(net.doc, node, segId);
    if (!kind || !arrivesAt(net.doc, node.id, segId)) continue;
    const segment = net.doc.segment(segId), ribbon = net.ribbons.get(segId);
    const centre = ribbon?.centre[Level.Asphalt];
    if (!segment || !ribbon || !centre) continue;
    const rt = ribbon.road;
    if (rt.id === 'highway' || rt.id === 'ramp') continue;
    // Traffic arriving at b runs a to b (forward).
    const forward = segment.b === node.id;
    const trims = net.trims.get(segId);
    const trim = (forward ? trims?.b[Level.Asphalt] : trims?.a[Level.Asphalt]) ?? 0;
    // The stop line, as the distance from where the lane starts in its direction.
    const stopAt = centre.length - Math.max(0, net.stopLineDistance(segId, node.id) - trim);
    const speedKmh = rt.speedLimit / kmh(1);
    const height = kind === 'stop' ? style.legendHeight(speedKmh) : m(3);
    const foot = stopAt - LEGEND_GAP - height;
    if (foot < m(2)) continue;
    const lw = laneWidth(rt);
    const word = kind === 'stop' ? wordStrokes(style.stopText) : YIELD_SYMBOL;
    const letter = kind === 'stop' ? Math.min((lw * 0.78) / Math.max(1, word.width), height * 0.5) : Math.min(lw * 0.55, m(1.5));
    for (let lane = 0; lane < travelLanes(rt, ribbon.direction); lane++) {
      paintInLane(out, ribbon, centre, forward, lane, foot, word, letter, height, m(kind === 'stop' ? 0.2 : 0.16));
    }
  }
}

/** Painted turn arrows follow the same authored rule as the connector graph. */
function laneArrowMarkings(ribbon: SegmentRibbon): StrokeSpec[] {
  const centre = ribbon.centre[Level.Asphalt];
  // Keep arrows behind the crossing/stop bar and suppress them on a short approach.
  if (!centre || centre.length < m(19.2)) return [];
  const road = ribbon.road;
  const out: StrokeSpec[] = [];
  const width = laneWidth(road);
  const lateral = Math.min(m(1), width * 0.32);
  for (const forward of [true, false]) {
    if (ribbon.direction === (forward ? 'bToA' : 'aToB')) continue;
    const rules = forward ? road.turnsForward : road.turnsBackward;
    if (!rules) continue;
    const sign = forward ? 1 : -1;
    const station = forward ? centre.length - m(8.8) : m(8.8);
    for (let lane = 0; lane < travelLanes(road, ribbon.direction); lane++) {
      const rule = rules[lane];
      if (!rule || rule === 'all') continue;
      const offset = laneOffset(road, lane, ribbon.direction, forward);
      // Each vertex follows the actual curved road, rather than a tangent chord.
      const point = (along: number, across: number): Vec2 => {
        const frame = centre.sampleAt(station + along * sign);
        const d = (offset + across) * sign;
        return { x: frame.p.x + frame.n.x * d, y: frame.p.y + frame.n.y * d };
      };
      // `along` in metres, `across` in world units.
      const line = (...vertices: [number, number][]): void => {
        out.push({ points: vertices.map(([along, across]) => point(m(along), across)),
          width: m(0.12), color: LANE_LINE, dash: null, dashOffset: 0 });
      };
      line([-2, 0], [0, 0]);
      if (laneTurnAllowed(rule, 'through')) {
        line([0, 0], [2, 0]);
        line([1.2, -lateral * 0.6], [2, 0], [1.2, lateral * 0.6]);
      }
      for (const side of [1, -1]) {
        if (!laneTurnAllowed(rule, side === 1 ? 'left' : 'right')) continue;
        line([0, 0], [0.6, 0], [0.6, lateral * side]);
        line([0, lateral * side * 0.5], [0.6, lateral * side], [1.2, lateral * side * 0.5]);
      }
    }
  }
  return out;
}

export interface Bar {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly width: number;
}

/** Zebra bar width and gap (0.5 m each), and the clear margin kept at each kerb. */
const ZEBRA_BAR = m(0.5);
const ZEBRA_GAP = m(0.5);
const ZEBRA_EDGE = m(0.3);

/** Stop bar for one approach, spanning only the lanes entering the junction. */
function stopBar(
  origin: Vec2,
  dir: Vec2,
  nrm: Vec2,
  rt: RoadType,
  trim: number,
  /** The travel way's offset from the centreline in this frame (`travelShift`, sign by end). */
  shift = 0,
): Bar | null {
  // Beyond the junction mouth, past the crossing
  const s = stopLineDistance(trim);
  if (s <= 0) return null;
  const cx = origin.x + dir.x * s;
  const cy = origin.y + dir.y * s;
  // Right-hand traffic: the approaching side is the `+nrm` half.
  const inner = shift + rt.median / 2;
  const outer = shift + travelWidth(rt) / 2;
  return {
    a: { x: cx + nrm.x * inner, y: cy + nrm.y * inner },
    b: { x: cx + nrm.x * outer, y: cy + nrm.y * outer },
    width: STOP_BAR_WIDTH,
  };
}

/** Zebra bars for one approach. */
function crosswalkBars(
  origin: Vec2,
  dir: Vec2,
  nrm: Vec2,
  rt: RoadType,
  trim: number,
): Bar[] {
  const mid = crosswalkDistance(trim);
  if (mid - CROSSWALK_DEPTH / 2 <= 0) return [];
  return zebraBars((along) => ({ p: { x: origin.x + dir.x * along, y: origin.y + dir.y * along }, nrm }), rt, mid);
}

/** The stripes of one crosswalk centred `mid` along a frame given per distance. */
function zebraBars(frameAt: (along: number) => { p: Vec2; nrm: Vec2 }, rt: RoadType, mid: number): Bar[] {
  const outer = rt.width / 2 - ZEBRA_EDGE;
  const inner = rt.median > 0 ? rt.median / 2 + ZEBRA_EDGE : 0;
  const { nrm } = frameAt(mid);
  const a = frameAt(mid - CROSSWALK_DEPTH / 2).p;
  const b = frameAt(mid + CROSSWALK_DEPTH / 2).p;
  const bars: Bar[] = [];
  /** Bars across one stretch of the carriageway, from `from` to `to` (offsets from the centre). */
  const across = (from: number, to: number): void => {
    const span = to - from;
    if (span < ZEBRA_BAR) return;
    const pitch = ZEBRA_BAR + ZEBRA_GAP;
    const count = Math.max(1, Math.floor((span + ZEBRA_GAP) / pitch));
    const used = count * ZEBRA_BAR + (count - 1) * ZEBRA_GAP;
    const first = from + (span - used) / 2 + ZEBRA_BAR / 2;
    for (let i = 0; i < count; i++) {
      const o = first + i * pitch;
      bars.push({
        a: { x: a.x + nrm.x * o, y: a.y + nrm.y * o },
        b: { x: b.x + nrm.x * o, y: b.y + nrm.y * o },
        width: ZEBRA_BAR,
      });
    }
  };
  if (inner > 0) {
    across(-outer, -inner);
    across(inner, outer);
  } else {
    across(-outer, outer);
  }
  return bars;
}

/** Collects stop bars and crosswalks for every junction approach */
export function junctionDetail(net: Network): { stops: Bar[]; zebras: Bar[] } {
  const stops: Bar[] = [];
  const zebras: Bar[] = [];
  // In id order: the network's junctions are in the order its rebuilds filed them.
  for (const node of [...net.junctions.keys()].sort((p, q) => p - q)) junctionDetailAt(net, node, stops, zebras);
  for (const node of net.doc.nodes.keys()) midBlockDetailAt(net, node, stops, zebras);
  return { stops, zebras };
}

/** The stop bars and crosswalks of one junction's approaches, onto `stops` and `zebras` (`junctionDetail`). */
export function junctionDetailAt(net: Network, node: NodeId, stops: Bar[], zebras: Bar[]): void {
  const junction = net.junctions.get(node)?.get(Level.Asphalt);
  if (!junction) return;
  if (junction.legs.some((leg) => leg.road.id === 'highway' || leg.road.id === 'ramp')) return;

  // A stop line exists because movements conflict, which needs three legs.
  const movementsConflict = junction.legs.length >= 3;

  junction.legs.forEach((leg, i) => {
    const rt = leg.road;
    const trim = junction.trims[i] as number;
    // A stop line only means something where traffic arrives.
    const crossing = net.crosswalkDistanceAt(leg.seg, node);
    if (movementsConflict && leg.approaching) {
      const bar = stopBar(leg.origin, leg.dir, leg.nrm, rt, trim, leg.shift);
      if (bar) stops.push(bar);
    }
    if (crossing > 0) {
      zebras.push(...crosswalkBars(leg.origin, leg.dir, leg.nrm, rt, trim));
    }
  });
}

/** Paint for the mid-block crossings (`RoadNode.crossing`). */
export function midBlockDetailAt(net: Network, nodeId: NodeId, stops: Bar[], zebras: Bar[]): void {
  const doc = net.doc;
  const node = doc.node(nodeId);
  if (!node || !node.crossing || node.incident.length !== 2) return;
  for (const segId of node.incident) {
    const seg = doc.segment(segId);
    if (!seg) continue;
    const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking);
    const pl = net.polylines.get(doc, segId);
    const startsHere = segmentStartsAt(seg, node.id);
    const frameAt = (along: number) => frameFromNode(pl, startsHere, Math.max(0, Math.min(pl.length, along)));
    const crossing = net.crosswalkDistanceAt(segId, node.id);
    if (crossing > 0) zebras.push(...zebraBars(frameAt, rt, crossing));
    const approaching = seg.direction === 'both' ||
      (startsHere ? seg.direction === 'bToA' : seg.direction === 'aToB');
    const s = net.stopLineDistance(segId, node.id);
    if (!approaching || s <= 0) continue;
    const f = frameAt(s);
    // Right-hand traffic: the approaching side is the `+nrm` half, across the travel lanes only.
    const shift = travelShift(rt) * (startsHere ? 1 : -1);
    const inner = shift + rt.median / 2;
    const outer = shift + travelWidth(rt) / 2;
    stops.push({
      a: { x: f.p.x + f.nrm.x * inner, y: f.p.y + f.nrm.y * inner },
      b: { x: f.p.x + f.nrm.x * outer, y: f.p.y + f.nrm.y * outer },
      width: STOP_BAR_WIDTH,
    });
  }
}

/** The paint across a taper where one road carries on at another width. */
export function transitionMarkings(net: Network, node: NodeId): StrokeSpec[] {
  const junction = net.junctions.get(node)?.get(Level.Asphalt);
  if (!junction || !junction.transition || junction.legs.length !== 2) return [];
  const a = junction.legs[0] as Leg;
  const b = junction.legs[1] as Leg;
  const ra = a.road;
  const rb = b.road;
  const axis = new TransitionAxis(a, junction.trims[0] as number, b, junction.trims[1] as number);
  const mix = (p: number, q: number) => (u: number): number => p + (q - p) * taperEase(u);
  const out: StrokeSpec[] = [];
  const solid = (offset: (u: number) => number, width: number, color: string): void => {
    out.push({ points: axis.offset(offset), width, color, dash: null, dashOffset: 0 });
  };

  // Travel from `a` to `b` keeps to the right, the negative side of the axis.

  if (a.direction !== 'both' || b.direction !== 'both') return out;
  if (ra.markings === 'none' && rb.markings === 'none') return out;

  const median = mix(ra.median / 2, rb.median / 2);
  if (ra.median > 0 || rb.median > 0) {
    // The two directions part to either side of the reservation's nose.
    const colour = markingColor(rb.median > 0 ? rb : ra);
    solid((u) => median(u), m(0.28), colour);
    solid((u) => -median(u), m(0.28), colour);
  } else {
    // One solid line, in each road's own colour on its own half of the taper.
    const line = axis.offset(() => 0);
    const mid = Math.floor(line.length / 2);
    const first = ra.markings === 'none' ? rb : ra;
    const second = rb.markings === 'none' ? ra : rb;
    out.push({ points: line.slice(0, mid + 1), width: m(0.16), color: markingColor(first), dash: null, dashOffset: 0 });
    out.push({ points: line.slice(mid), width: m(0.16), color: markingColor(second), dash: null, dashOffset: 0 });
  }

  // The lanes both roads have run straight through.
  const shared = Math.min(lanesPerDirection(ra), lanesPerDirection(rb));
  const lane = mix(laneWidth(ra), laneWidth(rb));
  for (let k = 1; k < shared; k++) {
    for (const side of [-1, 1]) {
      out.push({
        points: axis.offset((u) => side * (median(u) + lane(u) * k)),
        width: m(0.128),
        color: LANE_LINE,
        dash: DASH,
        dashOffset: 0,
      });
    }
  }
  return out;
}

/** A mini-roundabout's painted island */
export function miniRoundaboutAt(net: Network, nodeId: NodeId, out: StrokeSpec[]): void {
  const node = net.doc.node(nodeId);
  if (!node || node.control !== 'mini' || node.incident.length < 3) return;
  const mouth = Math.min(...node.incident.map((seg) => net.mouthDistance(seg, node.id)));
  const r = Math.max(m(2), Math.min(m(4), mouth * 0.4));
  // One painted disc, its 40 sides where a 0.2 m line round a 40-gon of radius r had its outer edges.
  // DO NOT paint it as rings of strokes: 18 rings of 40 quads each, 720 shapes for the paint's union to merge, and a hole left at the middle.
  const half = Math.PI / 40;
  const outer = (r * Math.cos(half) + m(0.1)) / Math.cos(half);
  const points = Array.from({ length: 40 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2;
    return { x: node.x + Math.cos(a) * outer, y: node.y + Math.sin(a) * outer };
  });
  out.push({ points, width: 0, color: LANE_LINE, dash: null, dashOffset: 0, fill: true });
}
