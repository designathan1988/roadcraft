import type { Vec2 } from '@core/vec2';
import { identityMemo } from '@core/identityMemo';
import { Heap } from '@core/heap';
import type { SegmentId } from './ids';
import { m } from './units';

/** Public transport, as the player lays it out */

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

interface RailTrack {
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

const LINE_COLOURS = ['#e8443a', '#2f7de1', '#2fb36b', '#f2a33a', '#9b59d0', '#14a5b8', '#e85d9b', '#7a8a2a'];

const isMode = (v: unknown): v is TransitMode => v === 'bus' || v === 'train' || v === 'metro';
/** DO NOT accept any string. */
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
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
    lines.push({ id: o['id'], mode, stops: ids, colour: typeof o['colour'] === 'string' && HEX_COLOUR.test(o['colour']) ? o['colour'] : LINE_COLOURS[0]!,
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

/** The tracks of one mode as a graph: every point of every track a node, each run between two a stretch */
export function railGraph(t: TransitData, mode: 'train' | 'metro'): RailGraph {
  const points: Vec2[] = [];
  const edges: RailEdge[] = [];
  const at = new Map<number, number[]>();
  // DO NOT search every point for each point: a city's rails were points² for every line built.
  const cells = new Map<number, number[]>();
  const cellOf = (i: number, j: number): number => (i + 32768) * 65536 + (j + 32768);
  const node = (p: Vec2): number => {
    const ci = Math.floor(p.x / JOIN), cj = Math.floor(p.y / JOIN);
    // The first point (lowest index) within reach, as the search of every point found.
    let found = -1;
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      for (const k of cells.get(cellOf(i, j)) ?? []) {
        if ((found < 0 || k < found) && Math.hypot(points[k]!.x - p.x, points[k]!.y - p.y) < JOIN) found = k;
      }
    }
    if (found >= 0) return found;
    points.push({ x: p.x, y: p.y });
    const k = points.length - 1, key = cellOf(ci, cj);
    const list = cells.get(key);
    if (list) list.push(k); else cells.set(key, [k]);
    return k;
  };
  const link = (a: number, b: number): void => {
    if (a === b) return;
    const e = edges.length;
    const pa = points[a]!, pb = points[b]!;
    edges.push({ a, b, length: Math.hypot(pa.x - pb.x, pa.y - pb.y) });
    for (const end of [a, b]) { const list = at.get(end); if (list) list.push(e); else at.set(end, [e]); }
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

/** A stretch of a track as filed: its track's place and its own, for the order a walk of every track meets them. */
interface TrackStretch { readonly track: number; readonly order: number; readonly mode: TransitMode; readonly a: Vec2; readonly b: Vec2 }
/** Side of the cells the stretches of track are filed in, world units. */
const TRACK_CELL = m(32);
/** The stretches of a version of the transit data by cell, made once per version (the data is replaced whole by each edit). */
const trackCells = identityMemo((t: TransitData): Map<number, TrackStretch[]> => {
  const cells = new Map<number, TrackStretch[]>();
  let order = 0;
  for (const track of t.tracks) {
    for (let i = 1; i < track.points.length; i++) {
      const a = track.points[i - 1]!, b = track.points[i]!;
      const s: TrackStretch = { track: track.id, order: order++, mode: track.mode, a, b };
      for (let x = Math.floor(Math.min(a.x, b.x) / TRACK_CELL); x <= Math.floor(Math.max(a.x, b.x) / TRACK_CELL); x++) {
        for (let y = Math.floor(Math.min(a.y, b.y) / TRACK_CELL); y <= Math.floor(Math.max(a.y, b.y) / TRACK_CELL); y++) {
          const key = (x + 32768) * 65536 + (y + 32768);
          const list = cells.get(key);
          if (list) list.push(s); else cells.set(key, [s]);
        }
      }
    }
  }
  return cells;
});

/** DO NOT walk every point of every track for each move of the pointer. */
export function nearestTrack(t: TransitData, p: Vec2, reach: number, mode?: 'train' | 'metro'): { track: number; x: number; y: number; d: number } | null {
  let best: { track: number; x: number; y: number; d: number } | null = null;
  for (const s of stretchesNear(t, p, reach)) {
    if (mode && s.mode !== mode) continue;
    const { a, b } = s, q = p;
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2)) : 0;
    const x = a.x + dx * u, y = a.y + dy * u, d = Math.hypot(q.x - x, q.y - y);
    if (d < reach && (!best || d < best.d)) best = { track: s.track, x, y, d };
  }
  return best;
}

/** The stretches of track filed in the cells within `reach` of `p`, in the order a walk of every track meets them. */
function stretchesNear(t: TransitData, p: Vec2, reach: number): TrackStretch[] {
  const cells = trackCells(t);
  const found = new Set<TrackStretch>();
  for (let x = Math.floor((p.x - reach) / TRACK_CELL); x <= Math.floor((p.x + reach) / TRACK_CELL); x++) {
    for (let y = Math.floor((p.y - reach) / TRACK_CELL); y <= Math.floor((p.y + reach) / TRACK_CELL); y++) {
      for (const s of cells.get((x + 32768) * 65536 + (y + 32768)) ?? []) found.add(s);
    }
  }
  return [...found].sort((u, v) => u.order - v.order);
}

/** DO NOT walk every point of every track for each move of the pointer (the track tool's snap). */
export function trackPointNear(t: TransitData, p: Vec2, reach: number, mode: 'train' | 'metro'): Vec2 | null {
  for (const s of stretchesNear(t, p, reach)) {
    if (s.mode !== mode) continue;
    for (const q of [s.a, s.b]) if (Math.hypot(q.x - p.x, q.y - p.y) < reach) return q;
  }
  return null;
}

/** Side of the cells the stops are filed in, world units. */
const STOP_CELL = m(32);
/** The stops of a version of the transit data, by id and by cell with their place in its list (the data is replaced whole by each edit). */
const stopIndex = identityMemo((t: TransitData) => {
  const byId = new Map<number, TransitStop>();
  const cells = new Map<number, { stop: TransitStop; order: number }[]>();
  t.stops.forEach((stop, order) => {
    byId.set(stop.id, stop);
    const key = (Math.floor(stop.x / STOP_CELL) + 32768) * 65536 + (Math.floor(stop.y / STOP_CELL) + 32768);
    const list = cells.get(key);
    if (list) list.push({ stop, order }); else cells.set(key, [{ stop, order }]);
  });
  return { byId, cells };
});

/** A stop by its id, or undefined. DO NOT `stops.find` it: the lines' drawing asked every stop of the map for each stop of each line, every frame. */
export const stopById = (t: TransitData, id: number): TransitStop | undefined => stopIndex(t).byId.get(id);

/** The stop (or station) nearest `p` closer than `reach`, of a mode if given */
export function stopNear(t: TransitData, p: Vec2, reach: number, mode?: TransitMode): TransitStop | null {
  const { cells } = stopIndex(t);
  const found: { stop: TransitStop; order: number }[] = [];
  for (let x = Math.floor((p.x - reach) / STOP_CELL); x <= Math.floor((p.x + reach) / STOP_CELL); x++) {
    for (let y = Math.floor((p.y - reach) / STOP_CELL); y <= Math.floor((p.y + reach) / STOP_CELL); y++) {
      for (const e of cells.get((x + 32768) * 65536 + (y + 32768)) ?? []) found.push(e);
    }
  }
  let best: TransitStop | null = null, bestD = reach;
  for (const { stop } of found.sort((u, v) => u.order - v.order)) {
    if (mode && stop.mode !== mode) continue;
    const d = Math.hypot(stop.x - p.x, stop.y - p.y);
    if (d < bestD) { bestD = d; best = stop; }
  }
  return best;
}

/** The way along the tracks from one point on them to another: the points to pass, from `from` to `to` */
export function railPath(g: RailGraph, from: Vec2, to: Vec2): Vec2[] | null {
  const onEdge = (p: Vec2): { e: number; u: number; q: Vec2 } | null => {
    let best: { e: number; u: number; q: Vec2; d: number } | null = null;
    g.edges.forEach((e, i) => {
      const a = g.points[e.a]!, b = g.points[e.b]!, on = p;
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
  // DO NOT scan every point for the nearest at each step: points² per stretch of every line.
  const queue = new Heap();
  queue.push(se.a, dist[se.a]!);
  queue.push(se.b, dist[se.b]!);
  while (queue.size) {
    const key = queue.peekKey();
    const k = queue.pop();
    if (done[k] || key > dist[k]!) continue;
    done[k] = 1;
    for (const ei of g.at.get(k) ?? []) {
      const e = g.edges[ei]!;
      const o = e.a === k ? e.b : e.a;
      if (dist[k]! + e.length < dist[o]!) { dist[o] = dist[k]! + e.length; prev[o] = k; queue.push(o, dist[o]!); }
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

/** How far, at most, a run of track lies on a road without leaving it: a level crossing is a few metres */
export function longestOnRoad(points: readonly Vec2[], onRoad: (p: Vec2) => boolean): number {
  const STEP = m(1);
  let run = 0, worst = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    for (let d = 0; d < len; d += STEP) {
      const p = { x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len };
      run = onRoad(p) ? run + STEP : 0;
      worst = Math.max(worst, run);
    }
  }
  return worst;
}
