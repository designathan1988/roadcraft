import type { Vec2 } from '@core/vec2';
import type { SegmentId } from './ids';
import { m } from './units';
import { onChartOf } from './planet/charts';

/**
 * Public transport, as the player lays it out (Cities: Skylines II's order:
 * "Depot -> Stops and stations -> Tracks and roads -> Lines"):
 *
 * - bus STOPS on the streets, beside a road, one of them or more a TERMINAL
 *   where a line's buses turn and wait their time;
 * - TRACKS for trains at grade and for the metro under the ground, drawn as
 *   runs of points; tracks meeting end to end (or end to point) are one
 *   network;
 * - STATIONS on the tracks, of a train line or of the metro;
 * - LINES: the stops or stations in order, a colour, how many vehicles run.
 *   A line runs out along its stops and back the same way.
 *
 * Plain data, saved with the map (`RoadDoc.transit`); the simulation is in
 * `sim/transit/`, the tools in `editor/transitTools.ts`.
 */

export type TransitMode = 'bus' | 'train' | 'metro';

export interface TransitStop {
  readonly id: number;
  readonly mode: TransitMode;
  /** Where it stands: a bus stop on the footway's edge, a station's platform on its track. */
  readonly x: number;
  readonly y: number;
  /** A bus stop: the road it is on. */
  readonly segment?: SegmentId;
  /** A station: the track it is on. */
  readonly track?: number;
  /** A bus terminal: lines turn here and their buses wait their time. */
  readonly terminal?: boolean;
  /** A metro station: its way down, on the footway nearest it (the station may lie under a street). */
  readonly entrance?: { readonly x: number; readonly y: number };
  readonly name?: string;
}

export interface RailTrack {
  readonly id: number;
  /** A train's track at grade, or the metro's under the ground. */
  readonly mode: 'train' | 'metro';
  readonly points: readonly Vec2[];
}

export interface TransitLine {
  readonly id: number;
  readonly mode: TransitMode;
  /** Its stops or stations, in order: out along them and back. */
  readonly stops: readonly number[];
  readonly colour: string;
  /** Vehicles running on it. */
  readonly vehicles: number;
  readonly name: string;
}

export interface TransitData {
  readonly stops: readonly TransitStop[];
  readonly tracks: readonly RailTrack[];
  readonly lines: readonly TransitLine[];
  readonly nextId: number;
}

export const emptyTransit = (): TransitData => ({ stops: [], tracks: [], lines: [], nextId: 1 });

export const LINE_COLOURS = ['#e8443a', '#2f7de1', '#2fb36b', '#f2a33a', '#9b59d0', '#14a5b8', '#e85d9b', '#7a8a2a'];

const isMode = (v: unknown): v is TransitMode => v === 'bus' || v === 'train' || v === 'metro';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads saved transport, dropping anything malformed; a line keeps only stops that exist and are of its mode. */
export function normalizeTransit(raw: unknown): TransitData {
  if (!raw || typeof raw !== 'object') return emptyTransit();
  const r = raw as Record<string, unknown>;
  const stops: TransitStop[] = [];
  for (const s of Array.isArray(r['stops']) ? r['stops'] : []) {
    const o = s as Record<string, unknown>;
    if (!finite(o['id']) || !isMode(o['mode']) || !finite(o['x']) || !finite(o['y'])) continue;
    stops.push({ id: o['id'], mode: o['mode'], x: o['x'], y: o['y'],
      ...(finite(o['segment']) ? { segment: o['segment'] as SegmentId } : {}),
      ...(finite(o['track']) ? { track: o['track'] } : {}),
      ...(o['terminal'] === true ? { terminal: true } : {}),
      ...(o['entrance'] && typeof o['entrance'] === 'object' && finite((o['entrance'] as Record<string, unknown>)['x']) && finite((o['entrance'] as Record<string, unknown>)['y'])
        ? { entrance: { x: (o['entrance'] as { x: number }).x, y: (o['entrance'] as { y: number }).y } } : {}),
      ...(typeof o['name'] === 'string' ? { name: o['name'] } : {}) });
  }
  const tracks: RailTrack[] = [];
  for (const t of Array.isArray(r['tracks']) ? r['tracks'] : []) {
    const o = t as Record<string, unknown>;
    if (!finite(o['id']) || (o['mode'] !== 'train' && o['mode'] !== 'metro') || !Array.isArray(o['points'])) continue;
    const points = (o['points'] as unknown[]).filter((p): p is Vec2 => !!p && finite((p as Vec2).x) && finite((p as Vec2).y))
      .map((p) => ({ x: p.x, y: p.y }));
    if (points.length >= 2) tracks.push({ id: o['id'], mode: o['mode'], points });
  }
  const byId = new Map(stops.map((s) => [s.id, s]));
  const lines: TransitLine[] = [];
  for (const l of Array.isArray(r['lines']) ? r['lines'] : []) {
    const o = l as Record<string, unknown>;
    if (!finite(o['id']) || !isMode(o['mode']) || !Array.isArray(o['stops'])) continue;
    const mode = o['mode'];
    const ids = (o['stops'] as unknown[]).filter((id): id is number => finite(id) && byId.get(id)?.mode === mode);
    if (ids.length < 2) continue;
    lines.push({ id: o['id'], mode, stops: ids, colour: typeof o['colour'] === 'string' ? o['colour'] : LINE_COLOURS[0]!,
      vehicles: finite(o['vehicles']) ? Math.max(1, Math.min(20, Math.round(o['vehicles']))) : 2,
      name: typeof o['name'] === 'string' ? o['name'] : `${o['id']}` });
  }
  let next = finite(r['nextId']) ? r['nextId'] : 1;
  for (const x of [...stops, ...tracks, ...lines]) next = Math.max(next, x.id + 1);
  return { stops, tracks, lines, nextId: next };
}

export const hasTransit = (t: TransitData): boolean => t.stops.length + t.tracks.length + t.lines.length > 0;

// ------------------------------------------------------------------ edits (pure: each returns the new data)

export function addStop(t: TransitData, stop: Omit<TransitStop, 'id'>): { data: TransitData; id: number } {
  const id = t.nextId;
  return { data: { ...t, stops: [...t.stops, { ...stop, id }], nextId: id + 1 }, id };
}

/** A stop removed, and with it from every line (a line left with fewer than two goes). */
export function removeStop(t: TransitData, id: number): TransitData {
  const lines = t.lines.map((l) => ({ ...l, stops: l.stops.filter((s) => s !== id) })).filter((l) => l.stops.length >= 2);
  return { ...t, stops: t.stops.filter((s) => s.id !== id), lines };
}

export function setTerminal(t: TransitData, id: number, terminal: boolean): TransitData {
  return { ...t, stops: t.stops.map((s) => (s.id === id ? { ...s, terminal: terminal || undefined } as TransitStop : s)) };
}

export function addTrack(t: TransitData, mode: 'train' | 'metro', points: readonly Vec2[]): { data: TransitData; id: number } {
  const id = t.nextId;
  return { data: { ...t, tracks: [...t.tracks, { id, mode, points: points.map((p) => ({ x: p.x, y: p.y })) }], nextId: id + 1 }, id };
}

/** A track removed, and the stations on it. */
export function removeTrack(t: TransitData, id: number): TransitData {
  let out: TransitData = { ...t, tracks: t.tracks.filter((k) => k.id !== id) };
  for (const s of t.stops) if (s.track === id) out = removeStop(out, s.id);
  return out;
}

export function addLine(t: TransitData, mode: TransitMode, stops: readonly number[], name?: string): { data: TransitData; id: number } {
  const id = t.nextId;
  const colour = LINE_COLOURS[t.lines.length % LINE_COLOURS.length]!;
  const line: TransitLine = { id, mode, stops: [...stops], colour, vehicles: mode === 'bus' ? 3 : 2,
    name: name ?? `${mode === 'bus' ? '' : mode === 'metro' ? 'M' : 'T'}${t.lines.filter((l) => l.mode === mode).length + 1}` };
  return { data: { ...t, lines: [...t.lines, line], nextId: id + 1 }, id };
}

export function removeLine(t: TransitData, id: number): TransitData {
  return { ...t, lines: t.lines.filter((l) => l.id !== id) };
}

export function setLineVehicles(t: TransitData, id: number, vehicles: number): TransitData {
  return { ...t, lines: t.lines.map((l) => (l.id === id ? { ...l, vehicles: Math.max(1, Math.min(20, Math.round(vehicles))) } : l)) };
}

// ------------------------------------------------------------------ the rail network

/** Track ends this near one another, or an end this near a track, are joined. */
export const JOIN = m(3);

interface RailEdge { readonly a: number; readonly b: number; readonly length: number }
export interface RailGraph {
  readonly mode: 'train' | 'metro';
  readonly points: Vec2[];
  readonly edges: RailEdge[];
  readonly at: Map<number, number[]>;
}

/**
 * ON THE PLANET a track's points are each kept on the chart of the piece they
 * lie on (`editor/transitTools.ts` lays a run in pieces no longer than a road
 * piece), and the run between two of them is laid on the first's chart, the
 * second carried there (`onChartOf`): two charts' points are tens of km
 * apart in the atlas, and a stretch measured between them as they stand was
 * a phantom across the map - trains routed over it, the station tool picked
 * it far away. Anything compared with a stretch (a point, a station) is
 * carried onto that chart too. On the flat map every carry is the point.
 */

/**
 * The tracks of one mode as a graph: every point of every track a node, each
 * run between two a stretch; points of different tracks within `JOIN` are
 * one, so tracks drawn end to end, or a branch started on a track, connect.
 */
export function railGraph(t: TransitData, mode: 'train' | 'metro'): RailGraph {
  const points: Vec2[] = [];
  const edges: RailEdge[] = [];
  const at = new Map<number, number[]>();
  const node = (p: Vec2): number => {
    for (let i = 0; i < points.length; i++) {
      const q = onChartOf(p, points[i]!);
      if (Math.hypot(points[i]!.x - q.x, points[i]!.y - q.y) < JOIN) return i;
    }
    points.push({ x: p.x, y: p.y });
    return points.length - 1;
  };
  const link = (a: number, b: number): void => {
    if (a === b) return;
    const e = edges.length;
    const pa = points[a]!, pb = onChartOf(points[b]!, pa);
    edges.push({ a, b, length: Math.hypot(pa.x - pb.x, pa.y - pb.y) });
    at.set(a, [...(at.get(a) ?? []), e]);
    at.set(b, [...(at.get(b) ?? []), e]);
  };
  for (const track of t.tracks) {
    if (track.mode !== mode) continue;
    let prev = node(track.points[0]!);
    for (let i = 1; i < track.points.length; i++) {
      const cur = node(track.points[i]!);
      link(prev, cur);
      prev = cur;
    }
  }
  return { mode, points, edges, at };
}

/** The point of a track nearest `p` within `reach`, and its track; null when none is. */
export function nearestTrack(t: TransitData, p: Vec2, reach: number, mode?: 'train' | 'metro'): { track: number; x: number; y: number; d: number } | null {
  let best: { track: number; x: number; y: number; d: number } | null = null;
  for (const track of t.tracks) {
    if (mode && track.mode !== mode) continue;
    for (let i = 1; i < track.points.length; i++) {
      // On the stretch's chart, its first point's.
      const a = track.points[i - 1]!, b = onChartOf(track.points[i]!, a), q = onChartOf(p, a);
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const u = len2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2)) : 0;
      const x = a.x + dx * u, y = a.y + dy * u, d = Math.hypot(q.x - x, q.y - y);
      if (d < reach && (!best || d < best.d)) best = { track: track.id, x, y, d };
    }
  }
  return best;
}

/**
 * The way along the tracks from one point on them to another: the points to
 * pass, from `from` to `to`; null when the two are on tracks that do not
 * meet. Both points are first put on their nearest stretch.
 */
export function railPath(g: RailGraph, from: Vec2, to: Vec2): Vec2[] | null {
  const onEdge = (p: Vec2): { e: number; u: number; q: Vec2 } | null => {
    let best: { e: number; u: number; q: Vec2; d: number } | null = null;
    g.edges.forEach((e, i) => {
      const a = g.points[e.a]!, b = onChartOf(g.points[e.b]!, a), on = onChartOf(p, a);
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const u = len2 > 0 ? Math.max(0, Math.min(1, ((on.x - a.x) * dx + (on.y - a.y) * dy) / len2)) : 0;
      const q = { x: a.x + dx * u, y: a.y + dy * u };
      const d = Math.hypot(on.x - q.x, on.y - q.y);
      if (!best || d < best.d) best = { e: i, u, q, d };
    });
    return best;
  };
  const s = onEdge(from), t = onEdge(to);
  if (!s || !t) return null;
  if (s.e === t.e) return [s.q, t.q];
  // Dijkstra from the two ends of the start's stretch.
  const n = g.points.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const se = g.edges[s.e]!;
  dist[se.a] = se.length * s.u;
  dist[se.b] = se.length * (1 - s.u);
  for (;;) {
    let k = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i]! < Infinity && (k < 0 || dist[i]! < dist[k]!)) k = i;
    if (k < 0) break;
    done[k] = 1;
    for (const ei of g.at.get(k) ?? []) {
      const e = g.edges[ei]!;
      const o = e.a === k ? e.b : e.a;
      if (dist[k]! + e.length < dist[o]!) { dist[o] = dist[k]! + e.length; prev[o] = k; }
    }
  }
  const te = g.edges[t.e]!;
  const viaA = dist[te.a]! + te.length * t.u, viaB = dist[te.b]! + te.length * (1 - t.u);
  if (!Number.isFinite(Math.min(viaA, viaB))) return null;
  let k = viaA <= viaB ? te.a : te.b;
  const chain: Vec2[] = [];
  while (k >= 0) { chain.push(g.points[k]!); const back = prev[k]!; if (back < 0) break; k = back; }
  chain.reverse();
  return [s.q, ...chain, t.q];
}

/** The longest stretch a track may run on a road's carriageway: it crosses streets, it does not run down them. */
export const ALONG_ROAD = m(12);

/**
 * How far, at most, a run of track lies on a road without leaving it: a
 * level crossing is a few metres; a track laid down a street is the length of
 * the street. `onRoad` says whether a point is on a carriageway.
 */
export function longestOnRoad(points: readonly Vec2[], onRoad: (p: Vec2) => boolean): number {
  const STEP = m(1);
  let run = 0, worst = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = onChartOf(points[i]!, a);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    for (let d = 0; d < len; d += STEP) {
      const p = { x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len };
      run = onRoad(p) ? run + STEP : 0;
      worst = Math.max(worst, run);
    }
  }
  return worst;
}
