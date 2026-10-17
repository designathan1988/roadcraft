import { Heap } from '@core/heap';
import { type Vec2, dist } from '@core/vec2';
import type { Network } from '@world/network';
import { POLE_KERB_INSET, nearestOnContour, onFootway, type OnContour, type PoleLines } from '@world/poleLines';
import type { ChangeRect } from '@world/changes';
import { CURB_BAND, Level } from '@world/roadTypes';
import { MAX_POLE_SPACING } from '@world/utilities';
import { m } from '@world/units';

/** THE ROUTE GRAPH of a set of pole lines and the shortest way through it (`editor/poles.ts` plans the runs on it) */

export interface RouteGraph {
  /** The stations: every vertex of every contour */
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Each station's arc length along its contour, and the contour. */
  readonly s: Float64Array;
  readonly contour: Int32Array;
  /** Each contour's first station and count; its stations run in order of `s`. */
  readonly runFirst: Int32Array;
  readonly runCount: Int32Array;
  /** Spans over a street, by station: those of station i are `spanTo`/`spanLength` from `spanStart[i]` to `spanStart[i + 1]`. */
  readonly spanStart: Int32Array;
  readonly spanTo: Int32Array;
  readonly spanLength: Float64Array;
  /** DO NOT allocate per run: the work of a run must be the stations it reaches. */
  readonly scratch: { readonly distTo: Float64Array; readonly prev: Int32Array; readonly done: Uint8Array; readonly touched: number[] };
}

/** Station spacing along a contour. */
const STATION_STEP = m(2);
/** A span over the street costs this much more than its length: the line keeps to one side unless crossing saves it. */
const CROSSING_COST = m(8);
/** A cast across the street must land this close to a contour to make a span there. */
const SPAN_LANDING = m(1);

/** The stations of a run either side of a place on its contour: [before, after]. */
function stationsAround(g: Pick<RouteGraph, 's' | 'runFirst' | 'runCount'>, hit: OnContour): [number, number] {
  const first = g.runFirst[hit.contour]!, count = g.runCount[hit.contour]!;
  // The last station at or before `s` (binary search on the run's arc lengths).
  let lo = 0, hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.s[first + mid]! <= hit.s) lo = mid; else hi = mid - 1;
  }
  return [first + lo, first + ((lo + 1) % count)];
}

/** The route graph of a set of lines: their contours' stations, and the spans over the streets that reach `region`. */
export function buildRouteGraph(net: Network, lines: PoleLines, region: ChangeRect): RouteGraph {
  const { contours } = lines;
  const xs: number[] = [], ys: number[] = [], ss: number[] = [], cs: number[] = [];
  const runFirst = new Int32Array(contours.length), runCount = new Int32Array(contours.length);
  const ts: number[] = [];
  contours.forEach((line, contour) => {
    const first = xs.length;
    const xy = line.xy, cum = line.cum;
    // A contour repeats its first point at the end: every edge, none of them twice.
    for (let i = 0; i + 1 < line.n; i++) {
      const x0 = xy[i * 2]!, y0 = xy[i * 2 + 1]!, x1 = xy[i * 2 + 2]!, y1 = xy[i * 2 + 3]!;
      const len = cum[i + 1]! - cum[i]!;
      if (len <= 0) continue;
      xs.push(x0); ys.push(y0); ss.push(cum[i]!); cs.push(contour);
      ts.length = 0;
      for (const [a, b] of [[x0, x1], [y0, y1]] as const) {
        if (a === b) continue;
        const k0 = Math.floor(Math.min(a, b) / STATION_STEP) + 1, k1 = Math.ceil(Math.max(a, b) / STATION_STEP) - 1;
        for (let k = k0; k <= k1; k++) ts.push((k * STATION_STEP - a) / (b - a));
      }
      ts.sort((p, q) => p - q);
      for (const t of ts) {
        if (t <= 1e-9 || t >= 1 - 1e-9) continue;
        xs.push(x0 + (x1 - x0) * t); ys.push(y0 + (y1 - y0) * t); ss.push(cum[i]! + len * t); cs.push(contour);
      }
    }
    runFirst[contour] = first;
    runCount[contour] = xs.length - first;
  });
  const n = xs.length;
  const x = Float64Array.from(xs), y = Float64Array.from(ys), s = Float64Array.from(ss);
  const stationAt = (hit: OnContour): number => {
    const [before, after] = stationsAround({ s, runFirst, runCount }, hit);
    return Math.hypot(x[before]! - hit.at.x, y[before]! - hit.at.y) <= Math.hypot(x[after]! - hit.at.x, y[after]! - hit.at.y) ? before : after;
  };
  // The spans in the order they are found, each both ways: the search reads them per station in that order.
  const spanFrom: number[] = [], spanToList: number[] = [], spanLen: number[] = [];
  const seen = new Set<number>();
  for (const id of net.segmentCells.idsMeeting(region)) {
    const ribbon = net.ribbons.get(id);
    if (!ribbon || ribbon.road.sidewalk <= 0) continue;
    const centre = ribbon.centre[Level.Asphalt];
    if (!centre || centre.length <= 0) continue;
    // The kerb line stands a kerb stone and the inset off the carriageway's edge.
    const reach = ribbon.road.width / 2 + CURB_BAND + POLE_KERB_INSET;
    for (let at = STATION_STEP / 2; at < centre.length; at += STATION_STEP) {
      const f = centre.sampleAt(at);
      const nx = -f.t.y, ny = f.t.x;
      const left = nearestOnContour(lines, { x: f.p.x + nx * reach, y: f.p.y + ny * reach }, SPAN_LANDING);
      const right = nearestOnContour(lines, { x: f.p.x - nx * reach, y: f.p.y - ny * reach }, SPAN_LANDING);
      if (!left || !right || !onFootway(net, left.at) || !onFootway(net, right.at)) continue;
      const a = stationAt(left), b = stationAt(right);
      if (a === b) continue;
      const key = a < b ? a * n + b : b * n + a;
      if (seen.has(key)) continue;
      seen.add(key);
      const length = Math.hypot(x[a]! - x[b]!, y[a]! - y[b]!);
      if (length > MAX_POLE_SPACING) continue;
      spanFrom.push(a, b); spanToList.push(b, a); spanLen.push(length, length);
    }
  }
  const spanStart = new Int32Array(n + 1);
  for (const from of spanFrom) spanStart[from + 1]!++;
  for (let i = 0; i < n; i++) spanStart[i + 1]! += spanStart[i]!;
  const fill = spanStart.slice(0, n);
  const spanTo = new Int32Array(spanFrom.length), spanLength = new Float64Array(spanFrom.length);
  spanFrom.forEach((from, k) => { const slot = fill[from]!++; spanTo[slot] = spanToList[k]!; spanLength[slot] = spanLen[k]!; });
  const distTo = new Float64Array(n + 2).fill(Infinity), prev = new Int32Array(n + 2).fill(-1);
  return {
    x, y, s, contour: Int32Array.from(cs), runFirst, runCount, spanStart, spanTo, spanLength,
    scratch: { distTo, prev, done: new Uint8Array(n + 2), touched: [] },
  };
}

/** The route of a run, as a list of points */
export function route(g: RouteGraph, a: OnContour, b: OnContour, head: Vec2 | null, tail: Vec2 | null,
  /** Filled with the box of every station reached when no route is found (`poles.ts` routeRun: a part of the lines closed in itself needs no larger region). */
  reached?: { x0: number; y0: number; x1: number; y1: number }): { readonly path: Vec2[]; readonly cost: number } | null {
  const n = g.x.length;
  // Two extra nodes, the run's ends, each joined to the stations either side of it on its contour.
  const START = n, END = n + 1;
  const [a0, a1] = stationsAround(g, a);
  const [b0, b1] = stationsAround(g, b);
  const { distTo, prev, done, touched } = g.scratch;
  const reachOf = (node: number, cost: number): void => {
    if (distTo[node] === Infinity) touched.push(node);
    distTo[node] = cost;
  };
  const at = (node: number): Vec2 => (node === START ? a.at : node === END ? b.at : { x: g.x[node]!, y: g.y[node]! });
  /** Ties go by place, never by number */
  const placedBefore = (i: number, j: number): boolean => {
    if (i === START || j === END) return i !== j;
    if (j === START || i === END) return false;
    const pi = at(i), pj = at(j);
    return pi.x < pj.x || (pi.x === pj.x && pi.y < pj.y);
  };
  // The lower cost first, then the node placed first (`@core/heap` with `before`).
  const heap = new Heap(placedBefore);
  /** Costs in whole micrometres: a sum of integers is exact whatever order it is added in */
  const relax = (from: number, to: number, metres: number): void => {
    const next = distTo[from]! + Math.round(metres * 1e6);
    if (next < distTo[to]!) { reachOf(to, next); prev[to] = from; heap.push(to, next); }
    // As cheap a way in: the one from the station placed first.
    else if (next === distTo[to] && !done[to] && placedBefore(from, prev[to]!)) prev[to] = from;
  };
  try {
    reachOf(START, 0);
    heap.push(START, 0);
    while (heap.size) {
      const node = heap.pop();
      if (done[node]) continue;
      done[node] = 1;
      if (node === END) break;
      const here = at(node);
      if (node === START) {
        for (const s of [a0, a1]) relax(START, s, dist(here, at(s)));
        if (a.contour === b.contour && a0 === b0) relax(START, END, dist(here, b.at));
        continue;
      }
      const contour = g.contour[node]!;
      const first = g.runFirst[contour]!, count = g.runCount[contour]!;
      const i = node - first;
      for (const j of [first + ((i + 1) % count), first + ((i - 1 + count) % count)]) relax(node, j, dist(here, at(j)));
      for (let k = g.spanStart[node]!; k < g.spanStart[node + 1]!; k++) relax(node, g.spanTo[k]!, g.spanLength[k]! + CROSSING_COST);
      if (node === b0 || node === b1) relax(node, END, dist(here, b.at));
    }
    if (!done[END]) {
      if (reached) {
        reached.x0 = reached.y0 = Infinity; reached.x1 = reached.y1 = -Infinity;
        for (const node of touched) {
          if (node >= n) continue;
          const x = g.x[node]!, y = g.y[node]!;
          if (x < reached.x0) reached.x0 = x; if (x > reached.x1) reached.x1 = x;
          if (y < reached.y0) reached.y0 = y; if (y > reached.y1) reached.y1 = y;
        }
      }
      return null;
    }
    const nodes: number[] = [];
    for (let k = END; k !== -1; k = prev[k]!) nodes.push(k);
    nodes.reverse();
    return { path: [...(head ? [head] : []), ...nodes.map(at), ...(tail ? [tail] : [])], cost: distTo[END]! / 1e6 };
  } finally {
    // Only what this run reached is wiped: the arrays are clean for the next.
    for (const node of touched) { distTo[node] = Infinity; prev[node] = -1; done[node] = 0; }
    touched.length = 0;
  }
}

