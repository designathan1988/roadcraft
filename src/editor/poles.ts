import type { Polyline } from '@core/polyline';
import { type Vec2, dist } from '@core/vec2';
import type { PoleId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import type { CrossingAccess } from '@world/landscape';
import { CROSSWALK_DEPTH } from '@world/approach';
import { POLE_KERB_INSET, onFootway, poleLinesAt, poleLinesIn, type PoleLines } from '@world/poleLines';
import { CELL } from '@world/cells';
import type { ChangeRect } from '@world/changes';
import { CURB_BAND, Level } from '@world/roadTypes';
import { DEFAULT_POLE_SPACING, MAX_POLE_SPACING, MIN_POLE_SPACING, poleCarriesLamp, type PoleLampMode } from '@world/utilities';
import { m } from '@world/units';

/**
 * Where a pole line goes: on the footway, just behind the kerb, and nowhere
 * else (the player's order of 2026-10-05, second pass).
 *
 * A distribution line in a town runs ALONG the street, its poles in a uniform
 * alignment a little behind the face of the kerb (N.J.A.C. 16:25-10.3; AASHTO
 * asks at least 0.5 m from the kerb face), turning with the street. The first
 * version of this tool kept one straight line per street, cut at each
 * junction's mouth, and joined two streets by a chord between their line
 * ends. Both halves of that were wrong at a corner: the line end at the mouth
 * stood inside the kerb return - on the asphalt - and the two streets' ends
 * gave two or three poles a few metres apart where one corner pole belongs.
 *
 * Now the line IS the kerb line, offset into the footway: the outline of
 * everything a kerb bounds (carriageway and kerb stone of every street that
 * has footways, `surfaces().curb`), grown by `POLE_KERB_INSET` with round
 * joins (Clipper2, as the walking lines in `walkways.ts` are). Each closed
 * contour runs round one block at exactly that distance from the kerb - along
 * a street, round the kerb return of a corner, round a bend - so a pole on it
 * is on the pavement by construction, never in a junction.
 *
 * - Both ends of a run must be on that line (or on a pole already standing).
 * - Between them the run follows the contour the short way round the block.
 *   An end on another block's contour is reached by ONE span across the
 *   street, from the point of this block's contour nearest it.
 * - A pole stands at every corner the line turns (the corners are found by
 *   Ramer-Douglas-Peucker simplification of the route), and the rest are
 *   spaced evenly between corners, off any crossing's landing.
 * - A planned pole close to one already standing IS that pole: lines join
 *   instead of growing a second mast beside the first.
 *
 * Both the preview and the commit ask `planPoleRun`, so what is drawn under
 * the pointer is what is built on release.
 */

/** Pick radius for an existing pole, in screen pixels. */
export const POLE_PICK_PIXELS = 34;

/** A pointer this far from the line, or anywhere on a footway, takes the line. */
const LINE_CATCH = m(2.5);

/** An existing pole off the line (drawn by an older version) joins it within this. */
const POLE_TO_LINE = m(5);

/** Douglas-Peucker tolerance for a corner of the route: a turn that bows the line this far. */
const CORNER_TOLERANCE = m(1.5);

/** Two poles of one run never stand closer than this; corners closer merge into one. */
const MIN_POLE_GAP = m(10);

/** A planned pole this close to a pole already standing is that pole. */
const REUSE_RADIUS = m(6);

export { onFootway };

function lampFor(index: number, mode: PoleLampMode): boolean {
  return mode === 'all' ? true : mode === 'none' ? false : poleCarriesLamp(index);
}

/** A place on a contour. */
interface OnContour {
  readonly contour: number;
  readonly s: number;
  readonly at: Vec2;
  readonly distance: number;
}

function nearestOnContour(lines: PoleLines, at: Vec2, reach: number): OnContour | null {
  let best: OnContour | null = null;
  lines.contours.forEach((line: Polyline, contour: number) => {
    const box = line.bbox;
    if (at.x < box.minX - reach || at.x > box.maxX + reach || at.y < box.minY - reach || at.y > box.maxY + reach) return;
    const hit = line.closestPoint(at);
    if (hit.distance <= reach && (!best || hit.distance < best.distance)) {
      best = { contour, s: hit.s, at: hit.point, distance: hit.distance };
    }
  });
  return best;
}

type PoleSnapKind = 'pole' | 'footway' | 'free';

export interface PoleSnap {
  readonly at: Vec2;
  readonly kind: PoleSnapKind;
  /** The existing pole this snapped onto, when `kind` is `pole`. */
  readonly pole?: PoleId;
}

/**
 * Snaps one end of a pole run: onto a pole already standing (joining a line
 * is the commonest thing anyone does), else onto the pole line of the footway
 * under the pointer. Anything else is `free`, and a run with a free end is
 * refused.
 */
export function snapPole(doc: RoadDoc, net: Network, at: Vec2, reach: number): PoleSnap {
  const hit = doc.poleNear(at, reach);
  if (hit) return { at: hit, kind: 'pole', pole: hit.id };
  // Anywhere on the pavement takes its line; off it, only just beside the line.
  const footway = onFootway(net, at);
  const on = nearestOnContour(poleLinesAt(net, at), at, footway ? m(12) : LINE_CATCH);
  if (on && onFootway(net, on.at)) return { at: on.at, kind: 'footway' };
  return { at: { x: at.x, y: at.y }, kind: 'free' };
}

interface PlannedPole {
  readonly at: Vec2;
  /** The pole already standing here, which the run will reuse. */
  readonly existing: PoleId | null;
  readonly lamp: boolean;
}

type PoleRunRefusal = 'offFootway' | 'noPath';

export interface PoleRunPlan {
  readonly from: PoleSnap;
  readonly to: PoleSnap;
  readonly poles: readonly PlannedPole[];
  /** Set when nothing would be built, and why. */
  readonly refused?: PoleRunRefusal;
}

/** Where a snapped end lies on the contours, or null when no contour is near it. */
function placeOf(lines: PoleLines, snap: PoleSnap): OnContour | null {
  return nearestOnContour(lines, snap.at, snap.kind === 'pole' ? POLE_TO_LINE : m(0.5));
}

/**
 * THE ROUTE GRAPH of a network's pole lines: stations a few metres apart
 * along every kerb-line contour, joined in order round it, and the spans
 * that cross a street - from a station straight over the carriageway to the
 * station facing it. An overhead crossing is laid on a line perpendicular to
 * the street (Virginia 24VAC30-151-330 A: "Overhead utility crossings shall
 * be located on a line that is perpendicular to the highway alignment"), so
 * the spans are cast square off each street's centreline where it runs
 * between its junctions - never on a diagonal through a junction.
 *
 * The run is the shortest way through it (Dijkstra, as the traffic routes,
 * `sim/drive/tactical.ts`). The contour alone - the first version - followed
 * one kerb the short way round: in a network of open-ended streets the whole
 * kerb line is ONE contour, and a run to the footway across the road went down
 * the street, round its end or into the next street and back (the player's
 * report of 2026-10-09: 176 units of line for 21.6 straight across).
 */
interface RouteGraph {
  /**
   * Every vertex of every contour, and every point where an edge crosses a
   * line of the fixed grid of `STATION_STEP` (x or y a whole number of
   * steps): placed by the place alone, so the stations of a stretch of kerb
   * line are the same whichever lines it was read from (the region's,
   * `poleLinesIn`, cut at its border, or the whole map's). An even spacing
   * along each edge moved them whenever the edge was cut elsewhere.
   */
  readonly stations: readonly { readonly contour: number; readonly s: number; readonly at: Vec2 }[];
  /** Each contour's first station index and count; its stations run in order of `s`. */
  readonly runs: readonly { readonly first: number; readonly count: number }[];
  /** Spans over a street, by station: the station across and the length. */
  readonly spans: ReadonlyMap<number, readonly { readonly to: number; readonly length: number }[]>;
}

/** Station spacing along a contour. */
const STATION_STEP = m(2);
/** A span over the street costs this much more than its length: the line keeps to one side unless crossing saves it. */
const CROSSING_COST = m(8);
/** A cast across the street must land this close to a contour to make a span there. */
const SPAN_LANDING = m(1);

/** The graph of one set of lines (`poleLinesIn`): made again only with them. */
const graphs = new WeakMap<PoleLines, RouteGraph>();

/** The stations of a run either side of a place on its contour: [before, after]. */
function stationsAround(g: RouteGraph, hit: OnContour): [number, number] {
  const run = g.runs[hit.contour]!;
  // The last station at or before `s` (binary search on the run's arc lengths).
  let lo = 0, hi = run.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.stations[run.first + mid]!.s <= hit.s) lo = mid; else hi = mid - 1;
  }
  return [run.first + lo, run.first + ((lo + 1) % run.count)];
}

/**
 * The route graph of the lines of `region` (`poleLinesIn`): their contours'
 * stations, and the spans over the streets that reach the region.
 */
function routeGraph(net: Network, lines: PoleLines, region: ChangeRect): RouteGraph {
  const known = graphs.get(lines);
  if (known) return known;
  const { contours } = lines;
  const stations: { contour: number; s: number; at: Vec2 }[] = [];
  const runs: { first: number; count: number }[] = [];
  contours.forEach((line, contour) => {
    const first = stations.length;
    const xy = line.xy, cum = line.cum;
    // A contour repeats its first point at the end: every edge, none of them twice.
    for (let i = 0; i + 1 < line.n; i++) {
      const x0 = xy[i * 2]!, y0 = xy[i * 2 + 1]!, x1 = xy[i * 2 + 2]!, y1 = xy[i * 2 + 3]!;
      const len = cum[i + 1]! - cum[i]!;
      if (len <= 0) continue;
      stations.push({ contour, s: cum[i]!, at: { x: x0, y: y0 } });
      const ts: number[] = [];
      for (const [a, b] of [[x0, x1], [y0, y1]] as const) {
        if (a === b) continue;
        const k0 = Math.floor(Math.min(a, b) / STATION_STEP) + 1, k1 = Math.ceil(Math.max(a, b) / STATION_STEP) - 1;
        for (let k = k0; k <= k1; k++) ts.push((k * STATION_STEP - a) / (b - a));
      }
      ts.sort((p, q) => p - q);
      for (const t of ts) {
        if (t <= 1e-9 || t >= 1 - 1e-9) continue;
        stations.push({ contour, s: cum[i]! + len * t, at: { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t } });
      }
    }
    runs.push({ first, count: stations.length - first });
  });
  const graphSoFar: RouteGraph = { stations, runs, spans: new Map() };
  const stationAt = (hit: OnContour): number => {
    const [before, after] = stationsAround(graphSoFar, hit);
    return dist(stations[before]!.at, hit.at) <= dist(stations[after]!.at, hit.at) ? before : after;
  };
  const spans = new Map<number, { to: number; length: number }[]>();
  const seen = new Set<string>();
  for (const id of net.segmentCells.idsMeeting(region)) {
    const ribbon = net.ribbons.get(id);
    if (!ribbon || ribbon.road.sidewalk <= 0) continue;
    const centre = ribbon.centre[Level.Asphalt];
    if (!centre || centre.length <= 0) continue;
    // The kerb line stands a kerb stone and the inset off the carriageway's edge.
    const reach = ribbon.road.width / 2 + CURB_BAND + POLE_KERB_INSET;
    for (let s = STATION_STEP / 2; s < centre.length; s += STATION_STEP) {
      const f = centre.sampleAt(s);
      const nx = -f.t.y, ny = f.t.x;
      const left = nearestOnContour(lines, { x: f.p.x + nx * reach, y: f.p.y + ny * reach }, SPAN_LANDING);
      const right = nearestOnContour(lines, { x: f.p.x - nx * reach, y: f.p.y - ny * reach }, SPAN_LANDING);
      if (!left || !right || !onFootway(net, left.at) || !onFootway(net, right.at)) continue;
      const a = stationAt(left), b = stationAt(right);
      if (a === b) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const length = dist(stations[a]!.at, stations[b]!.at);
      if (length > MAX_POLE_SPACING) continue;
      for (const [from, to] of [[a, b], [b, a]] as const) {
        const list = spans.get(from);
        if (list) list.push({ to, length }); else spans.set(from, [{ to, length }]);
      }
    }
  }
  const graph = { stations, runs, spans };
  graphs.set(lines, graph);
  return graph;
}

/**
 * The route of a run, as a list of points: the shortest way through the route
 * graph from where the run starts on a contour to where it ends - round the
 * kerb line, and over a street by a square span where that is shorter. Null
 * when no way joins them.
 */
function route(g: RouteGraph, from: PoleSnap, a: OnContour, to: PoleSnap, b: OnContour): { readonly path: Vec2[]; readonly cost: number } | null {
  const n = g.stations.length;
  // Two extra nodes, the run's ends, each joined to the stations either side of it on its contour.
  const START = n, END = n + 1;
  const [a0, a1] = stationsAround(g, a);
  const [b0, b1] = stationsAround(g, b);
  const distTo = new Float64Array(n + 2).fill(Infinity);
  const prev = new Int32Array(n + 2).fill(-1);
  const done = new Uint8Array(n + 2);
  distTo[START] = 0;
  const at = (node: number): Vec2 => (node === START ? a.at : node === END ? b.at : g.stations[node]!.at);
  /**
   * Ties go by place, never by number: on a straight street, crossing it
   * here or a few metres on costs the same, and the stations are numbered
   * differently in a region's lines and in the whole map's - the route must
   * not hang on that (`tests/world/poleLinesCells.spec.ts`).
   */
  const placedBefore = (i: number, j: number): boolean => {
    if (i === START || j === END) return i !== j;
    if (j === START || i === END) return false;
    const p = at(i), q = at(j);
    return p.x < q.x || (p.x === q.x && p.y < q.y);
  };
  // A binary heap of (cost, node), the lower cost first, then the node placed first.
  const heap: number[] = [];
  const lower = (u: number, v: number): boolean =>
    heap[u * 2]! < heap[v * 2]! || (heap[u * 2] === heap[v * 2] && placedBefore(heap[u * 2 + 1]!, heap[v * 2 + 1]!));
  const push = (cost: number, node: number): void => {
    heap.push(cost, node);
    let i = heap.length / 2 - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!lower(i, p)) break;
      [heap[p * 2], heap[i * 2]] = [heap[i * 2]!, heap[p * 2]!];
      [heap[p * 2 + 1], heap[i * 2 + 1]] = [heap[i * 2 + 1]!, heap[p * 2 + 1]!];
      i = p;
    }
  };
  const pop = (): number => {
    const node = heap[1]!;
    const lastNode = heap.pop()!, lastCost = heap.pop()!;
    if (heap.length) {
      heap[0] = lastCost; heap[1] = lastNode;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m0 = i;
        if (l < heap.length / 2 && lower(l, m0)) m0 = l;
        if (r < heap.length / 2 && lower(r, m0)) m0 = r;
        if (m0 === i) break;
        [heap[m0 * 2], heap[i * 2]] = [heap[i * 2]!, heap[m0 * 2]!];
        [heap[m0 * 2 + 1], heap[i * 2 + 1]] = [heap[i * 2 + 1]!, heap[m0 * 2 + 1]!];
        i = m0;
      }
    }
    return node;
  };
  /**
   * Costs in whole micrometres: a sum of integers is exact whatever order it
   * is added in, so two ways of the same length cost the same (in metres, the
   * last digit hung on the order, and the tie fell differently in a region's
   * lines and in the whole map's).
   */
  const relax = (from: number, to: number, metres: number): void => {
    const next = distTo[from]! + Math.round(metres * 1e6);
    if (next < distTo[to]!) { distTo[to] = next; prev[to] = from; push(next, to); }
    // As cheap a way in: the one from the station placed first.
    else if (next === distTo[to] && !done[to] && placedBefore(from, prev[to]!)) prev[to] = from;
  };
  push(0, START);
  while (heap.length) {
    const node = pop();
    if (done[node]) continue;
    done[node] = 1;
    if (node === END) break;
    const here = at(node);
    if (node === START) {
      for (const s of [a0, a1]) relax(START, s, dist(here, at(s)));
      if (a.contour === b.contour && a0 === b0) relax(START, END, dist(here, b.at));
      continue;
    }
    const st = g.stations[node]!;
    const run = g.runs[st.contour]!;
    const i = node - run.first;
    for (const j of [run.first + ((i + 1) % run.count), run.first + ((i - 1 + run.count) % run.count)]) relax(node, j, dist(here, at(j)));
    for (const span of g.spans.get(node) ?? []) relax(node, span.to, span.length + CROSSING_COST);
    if (node === b0 || node === b1) relax(node, END, dist(here, b.at));
  }
  if (!done[END]) return null;
  const nodes: number[] = [];
  for (let k = END; k !== -1; k = prev[k]!) nodes.push(k);
  nodes.reverse();
  const head: Vec2[] = from.kind === 'pole' && a.distance > 1e-3 ? [from.at] : [];
  const tail: Vec2[] = to.kind === 'pole' && b.distance > 1e-3 ? [to.at] : [];
  return { path: [...head, ...nodes.map(at), ...tail], cost: distTo[END]! / 1e6 };
}

/** A route searched first this far round its two ends, then twice as far, and so on. */
const ROUTE_MARGIN = m(96);
/** Past this margin a route is taken as found (a run is never planned across a whole city). */
const ROUTE_MARGIN_MOST = m(4096);
/** What the route search did: regions read. A count for the budgets (`core/perfBudget.ts`). */
const poleRouteWork = { regions: 0 };

/**
 * The run's route, read from the lines of a region round its ends only
 * (`poleLinesIn`), as exact as the whole map's: a way that leaves the region
 * goes out past the margin and comes back, so it is longer than twice the
 * margin; a route found inside shorter than that is the shortest of all.
 * Otherwise the region doubles. The region is laid on whole cells, so the
 * preview's pointer moves read the same lines again.
 */
function routeRun(net: Network, from: PoleSnap, to: PoleSnap, first = ROUTE_MARGIN):
  { readonly path: Vec2[]; readonly lines: PoleLines } | 'noPlace' | 'noPath' {
  const x0 = Math.min(from.at.x, to.at.x), y0 = Math.min(from.at.y, to.at.y);
  const x1 = Math.max(from.at.x, to.at.x), y1 = Math.max(from.at.y, to.at.y);
  for (let margin = Math.max(first, dist(from.at, to.at)); ; margin *= 2) {
    const region: ChangeRect = [
      Math.floor((x0 - margin) / CELL) * CELL, Math.floor((y0 - margin) / CELL) * CELL,
      Math.ceil((x1 + margin) / CELL) * CELL, Math.ceil((y1 + margin) / CELL) * CELL,
    ];
    poleRouteWork.regions++;
    const lines = poleLinesIn(net, region);
    const a = placeOf(lines, from);
    const b = placeOf(lines, to);
    if (!a || !b) return 'noPlace';
    const found = route(routeGraph(net, lines, region), from, a, to, b);
    // How far the region reaches past the ends, on its nearest side.
    const reach = Math.min(x0 - region[0], y0 - region[1], region[2] - x1, region[3] - y1);
    const last = margin >= ROUTE_MARGIN_MOST;
    if (found && (found.cost < 2 * reach || last)) return { path: found.path, lines };
    if (last) return 'noPath';
  }
}

/** Indices of the points Ramer-Douglas-Peucker keeps at `tolerance`. */
function corners(points: readonly Vec2[], tolerance: number): number[] {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = points[i]!, b = points[j]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let far = -1, farD = tolerance;
    for (let k = i + 1; k < j; k++) {
      const p = points[k]!;
      const d = len > 1e-9 ? Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len : dist(p, a);
      if (d > farD) { farD = d; far = k; }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => { if (k) out.push(i); });
  return out;
}

/** Whether a point stands in a crossing's landing (any street's: a corner belongs to none). */
function inLanding(accesses: readonly CrossingAccess[], p: Vec2): boolean {
  const margin = m(0.3) + m(0.2);
  return accesses.some((access) => {
    if (access.structure !== 'ground') return false;
    const dx = p.x - access.x, dy = p.y - access.y;
    return Math.abs(dx * access.tx + dy * access.ty) < CROSSWALK_DEPTH / 2 + margin &&
      Math.abs(-dx * access.ty + dy * access.tx) < access.across + margin;
  });
}

/**
 * Everything the run WOULD build, from the two raw ends of the gesture.
 * Called by the preview on every pointer move and by the commit once.
 * Nothing here mutates the document.
 */
export function planPoleRun(
  doc: RoadDoc,
  net: Network,
  rawFrom: Vec2,
  rawTo: Vec2,
  reach: number,
  spacing = DEFAULT_POLE_SPACING,
  lamps: PoleLampMode = 'alternate',
): PoleRunPlan {
  // The preview asks for the plan every frame (`main.ts`), and the same plan
  // while the pointer stands still: kept until something it reads changes -
  // its ends, its settings, the network or the poles standing (1.3 ms a frame
  // on a 6 x 6 block town, redone for nothing).
  const poles = doc.changes.serialOf('utilities');
  const k = lastPlan;
  if (k && k.doc === doc && k.net === net && k.revision === net.revision && k.poles === poles &&
      k.fx === rawFrom.x && k.fy === rawFrom.y && k.tx === rawTo.x && k.ty === rawTo.y &&
      k.reach === reach && k.spacing === spacing && k.lamps === lamps) return k.plan;
  const plan = computePoleRun(doc, net, rawFrom, rawTo, reach, spacing, lamps, ROUTE_MARGIN);
  lastPlan = { doc, net, revision: net.revision, poles, fx: rawFrom.x, fy: rawFrom.y, tx: rawTo.x, ty: rawTo.y, reach, spacing, lamps, plan };
  return plan;
}

/** The last plan made, and what it was made from (`planPoleRun`). */
let lastPlan: {
  readonly doc: RoadDoc; readonly net: Network; readonly revision: number; readonly poles: number;
  readonly fx: number; readonly fy: number; readonly tx: number; readonly ty: number;
  readonly reach: number; readonly spacing: number; readonly lamps: PoleLampMode; readonly plan: PoleRunPlan;
} | null = null;

/**
 * `planPoleRun` routed over the lines of a region covering the whole map
 * (every street within `ROUTE_MARGIN_MOST`): the oracle the regional route is
 * held to (`tests/world/poleLinesCells.spec.ts`). Not cached.
 */
export function planPoleRunWhole(
  doc: RoadDoc, net: Network, rawFrom: Vec2, rawTo: Vec2, reach: number,
  spacing = DEFAULT_POLE_SPACING, lamps: PoleLampMode = 'alternate',
): PoleRunPlan {
  return computePoleRun(doc, net, rawFrom, rawTo, reach, spacing, lamps, ROUTE_MARGIN_MOST);
}

function computePoleRun(
  doc: RoadDoc,
  net: Network,
  rawFrom: Vec2,
  rawTo: Vec2,
  reach: number,
  spacing: number,
  lamps: PoleLampMode,
  margin: number,
): PoleRunPlan {
  const from = snapPole(doc, net, rawFrom, reach);
  const to = snapPole(doc, net, rawTo, reach);
  const refuse = (refused: PoleRunRefusal): PoleRunPlan => ({ from, to, poles: [], refused });
  if (from.kind === 'free' || to.kind === 'free') return refuse('offFootway');
  if (from.pole !== undefined && from.pole === to.pole) return { from, to, poles: [] };
  if (dist(from.at, to.at) < 1e-3) return { from, to, poles: [] };
  const routed = routeRun(net, from, to, margin);
  if (routed === 'noPlace' || routed === 'noPath') return refuse('noPath');
  const { path, lines } = routed;
  if (path.length < 2) return refuse('noPath');

  // Arc length along the route.
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1]! + dist(path[i - 1]!, path[i]!));
  const total = cum[cum.length - 1]!;
  const at = (s: number): Vec2 => {
    let i = 1;
    while (i < cum.length - 1 && cum[i]! < s) i++;
    const s0 = cum[i - 1]!, s1 = cum[i]!;
    const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    const p = path[i - 1]!, q = path[i]!;
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  };

  // Corner stations; corners closer than a pole gap merge into one, and none
  // stands within a gap of either end.
  const keys: number[] = [0];
  for (const index of corners(path, CORNER_TOLERANCE).slice(1, -1)) {
    const s = cum[index]!;
    if (s < MIN_POLE_GAP || total - s < MIN_POLE_GAP) continue;
    const last = keys[keys.length - 1]!;
    if (keys.length > 1 && s - last < MIN_POLE_GAP) keys[keys.length - 1] = (last + s) / 2;
    else keys.push(s);
  }
  keys.push(total);

  // Evenly between corners, nudged off crossing landings along the route.
  const { accesses } = lines;
  const step = Math.max(MIN_POLE_SPACING, Math.min(MAX_POLE_SPACING, spacing));
  const stations: number[] = [0];
  for (let k = 1; k < keys.length; k++) {
    const s0 = keys[k - 1]!, s1 = keys[k]!;
    const spans = Math.max(1, Math.round((s1 - s0) / step));
    for (let i = 1; i <= spans; i++) stations.push(s0 + ((s1 - s0) * i) / spans);
  }
  const clear = (s: number, lo: number, hi: number): number | null => {
    const ok = (t: number): boolean => { const p = at(t); return !inLanding(accesses, p) && onFootway(net, p); };
    if (ok(s)) return s;
    for (let d = m(1); d <= m(12); d += m(1)) {
      if (s + d < hi && ok(s + d)) return s + d;
      if (s - d > lo && ok(s - d)) return s - d;
    }
    return null;
  };
  const kept: number[] = [0];
  for (let i = 1; i < stations.length - 1; i++) {
    const s = clear(stations[i]!, kept[kept.length - 1]! + MIN_POLE_GAP / 2, total - MIN_POLE_GAP / 2);
    if (s !== null) kept.push(s);
  }
  kept.push(total);

  // Poles: the ends exactly where they snapped, existing poles reused.
  const points = kept.map((s, i) => (i === 0 ? from.at : i === kept.length - 1 ? to.at : at(s)));
  const poles: PlannedPole[] = [];
  points.forEach((p, index) => {
    const existing = index === 0 && from.pole !== undefined ? doc.pole(from.pole)
      : index === points.length - 1 && to.pole !== undefined ? doc.pole(to.pole)
        : doc.poleNear(p, REUSE_RADIUS);
    const planned: PlannedPole = {
      at: existing ? { x: existing.x, y: existing.y } : p,
      existing: existing?.id ?? null,
      // A pole that already exists keeps the lamp it has.
      lamp: existing ? existing.lamp : lampFor(index, lamps),
    };
    const prev = poles[poles.length - 1];
    // The same standing pole twice in a row is one pole.
    if (prev && planned.existing !== null && prev.existing === planned.existing) return;
    poles.push(planned);
  });
  if (poles.length < 2) return { from, to, poles: [] };
  return { from, to, poles };
}

/**
 * Applies a plan to the document. Returns whether anything was built.
 * A refused plan builds nothing.
 */
export function commitPoleRun(doc: RoadDoc, plan: PoleRunPlan): boolean {
  return commitPoleRunPoles(doc, plan) !== null;
}

/** `commitPoleRun`, giving the run's poles in order (null when nothing was built). */
export function commitPoleRunPoles(doc: RoadDoc, plan: PoleRunPlan): PoleId[] | null {
  if (plan.refused || plan.poles.length < 2) return null;

  const ids: PoleId[] = plan.poles.map(
    (pole) => pole.existing ?? doc.addPole({ x: pole.at.x, y: pole.at.y }, pole.lamp).id,
  );

  let built = false;
  for (let i = 1; i < ids.length; i++) {
    const a = ids[i - 1];
    const b = ids[i];
    if (a === undefined || b === undefined || a === b) continue;
    if (doc.addPoleSpan(a, b)) built = true;
  }
  return built ? ids : null;
}

/** What the pole tool reads of the game and does to it. */
export interface PoleToolHost {
  readonly doc: RoadDoc;
  readonly net: Network;
  zoom(): number;
  /** The tool's verb ('build' or 'remove', `ui/toolChoices.ts`) and its lamps. */
  mode(): string;
  lamps(): PoleLampMode;
  /** Whether the pole tool is the tool in hand. */
  inHand(): boolean;
  /** An edit of the document, one undo step; whether it changed it. */
  mutate(fn: () => boolean): boolean;
  hint(key: string): void;
  redraw(): void;
}

/**
 * THE POLE TOOL: a distribution line traced as straight stretches, each a
 * drag (or a click, click, click: a press that builds nothing starts the
 * chain), from the last pole while the tool stays on it; Shift-click, or the
 * Remove verb, takes a pole and its wires away. The stretch being dragged,
 * the chain's last pole and the pointer live here (Nystrom, "State").
 */
export class PoleTool {
  /** The stretch being dragged. */
  private draft: { readonly from: Vec2; to: Vec2; readonly chained: boolean } | null = null;
  /**
   * The end of the last committed run, while the tool is still on it: a
   * line is drawn as a sequence of stretches, and finishing one is almost
   * never finishing the line. Escape, a different tool or an undo drops it.
   */
  private chain: Vec2 | null = null;
  /** The pointer over the map while the tool is in hand, unsnapped. */
  private hover: Vec2 | null = null;
  private lastMode = '';

  constructor(private readonly host: PoleToolHost) {}

  /**
   * Pick radius for a pole, in WORLD units at the current zoom: one
   * definition for the snap, the preview, removal and bulldoze (when they
   * were separate numbers the preview highlighted a pole the commit then
   * missed, and the run was built disconnected).
   */
  reach(): number {
    return POLE_PICK_PIXELS / this.host.zoom();
  }

  gesture(): string | null {
    return this.draft || this.chain ? 'poste: traçando a linha' : null;
  }

  inProgress(): boolean {
    return this.draft !== null || this.chain !== null;
  }

  cancel(): void {
    this.draft = null;
    this.chain = null;
  }

  /** What the current gesture would build, snapped: drawn and committed alike. */
  plan(): PoleRunPlan | null {
    const { host } = this;
    // A change of the tool's verb ends the line being traced.
    if (host.mode() !== this.lastMode) {
      this.lastMode = host.mode();
      this.cancel();
    }
    if (this.draft) return planPoleRun(host.doc, host.net, this.draft.from, this.draft.to, this.reach(), undefined, host.lamps());
    if (host.inHand() && host.mode() === 'build' && this.chain && this.hover) {
      return planPoleRun(host.doc, host.net, this.chain, this.hover, this.reach(), undefined, host.lamps());
    }
    return null;
  }

  down(world: Vec2, shift: boolean): void {
    const { host } = this;
    const hit = host.doc.poleNear(world, this.reach());
    const remove = (): void => {
      if (!hit) return;
      host.mutate(() => { host.doc.removePole(hit.id); return true; });
      host.hint('hint.pole.removed');
    };
    if (host.mode() === 'remove') {
      // The Remove verb: a click takes the pole under it, and its wires.
      remove();
      this.chain = null;
    } else if (hit && shift) {
      // Shift-click removes. A plain click on a pole starts a run AT it: the
      // commonest gesture of the tool.
      remove();
      this.chain = null;
    } else {
      this.draft = { from: this.chain ?? world, to: world, chained: this.chain !== null };
    }
  }

  /** The pointer moved; true when a stretch being dragged took it. */
  move(world: Vec2): boolean {
    if (this.draft) {
      this.draft.to = world;
      this.host.redraw();
      return true;
    }
    if (this.host.inHand()) {
      // The bare pointer, not a road anchor: the tool snaps to its own line,
      // and a chained run has no button held, so the preview follows it.
      this.hover = world;
      this.host.redraw();
    }
    return false;
  }

  /** The pointer let go: the stretch is built (`commit`), or dropped. */
  up(commit: boolean): void {
    const { host } = this;
    const run = this.draft;
    if (!run) return;
    const plan = planPoleRun(host.doc, host.net, run.from, run.to, this.reach(), undefined, host.lamps());
    this.draft = null;
    if (!commit) { this.chain = null; return; }
    const last = plan.poles[plan.poles.length - 1];
    // A run with an end off the footways builds nothing, and says why.
    if (plan.refused) host.hint(`hint.pole.${plan.refused}`);
    const built = host.mutate(() => commitPoleRun(host.doc, plan));
    // The line goes on from where it ended. A press that built nothing - a
    // click in place - starts the chain instead, so tracing a line is
    // click, click, click rather than a drag per stretch.
    if (built && last) this.chain = { x: last.at.x, y: last.at.y };
    else if (!run.chained) this.chain = { x: plan.from.at.x, y: plan.from.at.y };
    else this.chain = null;
  }

  /**
   * What the overlay marks besides the run drawn in 3D: with the Remove
   * verb, the pole under the pointer; before a run, where its first pole
   * would go.
   */
  marks(): { removing: Vec2 | null; first: PoleSnap | null } {
    const { host } = this;
    if (!host.inHand() || !this.hover) return { removing: null, first: null };
    if (host.mode() === 'remove') {
      const hit = host.doc.poleNear(this.hover, this.reach());
      return { removing: hit ? { x: hit.x, y: hit.y } : null, first: null };
    }
    return { removing: null, first: this.draft ? null : snapPole(host.doc, host.net, this.hover, this.reach()) };
  }
}
