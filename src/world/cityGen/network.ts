import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { valueNoise } from '../terrain';
import { TILE } from '../tiles';
import { m } from '../units';
import type { StreetEdge, StreetGraph } from './streets';
import { EDGE_INSET, MAP_HALF, MAP_TILES, mix } from './wholeMap';

/** THE CITY'S STREETS ROUND A TILE (the whole map's, `wholeMap.ts`): avenues on a warped, turned lattice of junctions over the map (never the tiles' grid), the avenue closing the map's edge, and in each piece of land between avenues a grid of streets turned to its longest avenue, its blocks sized by how built up it is. Every piece of land is made from the seed and its lattice corners alone, so a tile takes the pieces round it and comes out the same as its neighbours see them; every street is cut at the tiles' edges, a node exactly on the edge. */

/** Lattice spacing of the avenues. */
const SPACING = m(760);
/** How far a lattice junction strays from its place, at most, each way. */
const JITTER = m(170);
/** How far the lattice is bent over the map (a slow noise), at most. */
const WARP = m(260);
const WARP_SCALE = m(3_400);
/** An avenue between two junctions bends at this many points. */
const BENDS = 3;
/** How far a bend strays across its avenue, at most. */
const BEND = m(38);
/** A street end this near a corner of its land, or meeting its avenue this shallow, stops at its last crossing instead. */
const CORNER_CLEAR = m(28);
const MIN_SIN = Math.sin((35 * Math.PI) / 180);
/** Under this a street piece is not laid. */
const MIN_PIECE = m(24);
/** A junction this near a tiles' edge moved onto it along its street (no stub of road at an edge). */
const SNAP = m(14);
/** Points this near are one node. */
const SAME = m(0.05);
/** How far past the tile its streets are laid: every block reaching into the tile closed whole (`lots.ts` floods only closed land). */
export const MARGIN = m(320);

/** The map's frame: the edge avenue's line, `EDGE_INSET` inside the map. */
const FRAME = MAP_HALF - EDGE_INSET;
/** The tiles' inner edges (the map's own edge is past the frame). */
const CUTS: readonly number[] = Array.from({ length: MAP_TILES - 1 }, (_, k) => (k + 1 - MAP_TILES / 2) * TILE);

/** A street of the network: its two nodes, its bends between, its class (0 avenue, 1 collector, 2 local; `plan.ts` LEVEL_ROAD). */
interface Line { readonly pts: Vec2[]; readonly level: 0 | 1 | 2 }

/** The lattice's turn for a seed: never square to the tiles. */
const turnOf = (seed: number): number => (0.2 + 0.4 * (mix(seed, 0x7a11) % 1000) / 1000) * (mix(seed, 0x7a12) % 2 ? 1 : -1);

/** Lattice junction (a, b) on the map. */
function junction(seed: number, a: number, b: number): Vec2 {
  const t = turnOf(seed), c = Math.cos(t), s = Math.sin(t);
  const rng = new Rng(mix(seed, 0x1a77, a, b) || 1);
  const u = a * SPACING + rng.range(-JITTER, JITTER), v = b * SPACING + rng.range(-JITTER, JITTER);
  const x = u * c - v * s, y = u * s + v * c;
  const salt = (seed % 991) * 0.53;
  return { x: x + WARP * valueNoise(x / WARP_SCALE + salt, y / WARP_SCALE), y: y + WARP * valueNoise(x / WARP_SCALE - salt, y / WARP_SCALE + 3.1) };
}

/** The avenue between two lattice junctions, bends and all, from the first to the second; the same points either way it is asked. */
function avenue(seed: number, a0: number, b0: number, a1: number, b1: number): Vec2[] {
  const flip = a1 < a0 || b1 < b0;
  const [p, q] = flip ? [junction(seed, a1, b1), junction(seed, a0, b0)] : [junction(seed, a0, b0), junction(seed, a1, b1)];
  const rng = new Rng(mix(seed, 0xa7e, Math.min(a0, a1), Math.min(b0, b1), a1 !== a0 ? 1 : 0) || 1);
  const len = Math.hypot(q.x - p.x, q.y - p.y), nx = -(q.y - p.y) / len, ny = (q.x - p.x) / len;
  const pts: Vec2[] = [p];
  const sway = rng.range(-1, 1) * BEND;
  for (let k = 1; k <= BENDS; k++) {
    const f = k / (BENDS + 1), off = sway * Math.sin(Math.PI * f) + rng.range(-0.25, 0.25) * BEND;
    pts.push({ x: p.x + (q.x - p.x) * f + nx * off, y: p.y + (q.y - p.y) * f + ny * off });
  }
  pts.push(q);
  return flip ? pts.reverse() : pts;
}

/** The lattice cells (a, b) whose land may reach a box: by the inverse turn, with the jitter and warp as slack. */
function cellsOver(seed: number, x0: number, y0: number, x1: number, y1: number): { a: number; b: number }[] {
  const t = turnOf(seed), c = Math.cos(t), s = Math.sin(t);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const) {
    const u = x * c + y * s, v = -x * s + y * c;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const slack = JITTER + WARP + BEND + m(10);
  const out: { a: number; b: number }[] = [];
  for (let a = Math.floor((u0 - slack) / SPACING) - 1; a <= Math.ceil((u1 + slack) / SPACING); a++) {
    for (let b = Math.floor((v0 - slack) / SPACING) - 1; b <= Math.ceil((v1 + slack) / SPACING); b++) out.push({ a, b });
  }
  return out;
}

/** A ring cut to the map's frame (Sutherland-Hodgman, one side at a time), each corner marking whether the side after it is the frame's. */
function clipToFrame(ring: readonly Vec2[]): { pts: Vec2[]; frame: boolean[] } {
  let pts = ring.map((p) => ({ x: p.x, y: p.y })), frame = ring.map(() => false);
  const planes: [(p: Vec2) => number, (p: Vec2, q: Vec2) => Vec2][] = [
    [(p) => p.x + FRAME, (p, q) => ({ x: -FRAME, y: p.y + ((q.y - p.y) * (-FRAME - p.x)) / (q.x - p.x) })],
    [(p) => FRAME - p.x, (p, q) => ({ x: FRAME, y: p.y + ((q.y - p.y) * (FRAME - p.x)) / (q.x - p.x) })],
    [(p) => p.y + FRAME, (p, q) => ({ x: p.x + ((q.x - p.x) * (-FRAME - p.y)) / (q.y - p.y), y: -FRAME })],
    [(p) => FRAME - p.y, (p, q) => ({ x: p.x + ((q.x - p.x) * (FRAME - p.y)) / (q.y - p.y), y: FRAME })],
  ];
  for (const [side, cut] of planes) {
    const np: Vec2[] = [], nf: boolean[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!, q = pts[(i + 1) % pts.length]!, sp = side(p), sq = side(q);
      if (sp >= 0) { np.push(p); nf.push(frame[i]!); }
      if ((sp >= 0) !== (sq >= 0)) {
        const x = cut(p, q);
        np.push(x);
        // Entering the land again from the frame: the side from this point on is the old one; leaving it: the frame's.
        nf.push(sp >= 0 ? true : frame[i]!);
      }
    }
    pts = np; frame = nf;
    if (pts.length < 3) return { pts: [], frame: [] };
  }
  return { pts, frame };
}

/** One piece of land between avenues: its avenue lines and its streets inside. */
function cellStreets(seed: number, a: number, b: number, heatAt: (x: number, y: number) => number): { sides: Line[]; streets: Line[] } {
  // The ring: south side, east, north back, west back (each avenue the same points as its neighbour cell asks for).
  const south = avenue(seed, a, b, a + 1, b), east = avenue(seed, a + 1, b, a + 1, b + 1);
  const north = avenue(seed, a, b + 1, a + 1, b + 1), west = avenue(seed, a, b, a, b + 1);
  const raw = [...south.slice(0, -1), ...east.slice(0, -1), ...north.slice().reverse().slice(0, -1), ...west.slice().reverse().slice(0, -1)];
  // The avenues: the cell's south and west sides are its own to lay (a neighbour lays the others), even when the cell's land is past the frame.
  const sides: Line[] = [{ pts: south, level: 0 }, { pts: west, level: 0 }];
  const { pts: ring, frame } = clipToFrame(raw);
  if (ring.length < 3) return { sides, streets: [] };
  // The frame where the cell's land meets it.
  for (let i = 0; i < ring.length; i++) if (frame[i]) sides.push({ pts: [ring[i]!, ring[(i + 1) % ring.length]!], level: 0 });
  // The grid's turn: the longest straight run of the ring.
  let best = 0, theta = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!, l = Math.hypot(q.x - p.x, q.y - p.y);
    if (l > best) { best = l; theta = Math.atan2(q.y - p.y, q.x - p.x); }
  }
  let cx = 0, cy = 0;
  for (const p of ring) { cx += p.x; cy += p.y; }
  cx /= ring.length; cy /= ring.length;
  const heat = Math.max(0, Math.min(1, (heatAt(cx, cy) - 0.25) / 0.7));
  // Blocks: long and shallow in the suburbs (houses along them), smaller downtown (metres, as planners count them).
  const long = m(185) - heat * m(75), short = m(100) - heat * m(28);
  const rng = new Rng(mix(seed, 0xb10c, a, b) || 1);
  const dA = { x: Math.cos(theta), y: Math.sin(theta) }, dB = { x: -dA.y, y: dA.x };
  const streets: Line[] = [];
  // Streets along the long side (spaced a block's depth) and across it (spaced a block's length); a collector every few.
  const pieces: { d: Vec2; o: Vec2; t0: number; t1: number; fam: 0 | 1; level: 1 | 2; cross: number[]; end0: boolean; end1: boolean }[] = [];
  const family = (fam: 0 | 1, d: Vec2, n: Vec2, gap: number, every: number): void => {
    let lo = Infinity, hi = -Infinity;
    for (const p of ring) { const s = p.x * n.x + p.y * n.y; lo = Math.min(lo, s); hi = Math.max(hi, s); }
    // Lines spaced evenly between the ring's extremes, none nearer than half a block to them.
    const count = Math.max(0, Math.round((hi - lo) / gap) - 1);
    const step = (hi - lo) / (count + 1), collector = rng.int(0, every - 1);
    for (let k = 1; k <= count; k++) {
      const off = lo + step * k;
      const o = { x: n.x * off, y: n.y * off };
      const level: 1 | 2 = k % every === collector ? 1 : 2;
      for (const run of clipLine(ring, o, d)) pieces.push({ d, o, ...run, fam, level, cross: [], end0: true, end1: true });
    }
  };
  family(0, dA, dB, short, 4);
  family(1, dB, dA, long, 3);
  // An end stops short of its avenue where it meets it shallow or near a corner of the land.
  for (const p of pieces) {
    for (const end of [0, 1] as const) {
      const t = end === 0 ? p.t0 : p.t1, at = { x: p.o.x + p.d.x * t, y: p.o.y + p.d.y * t };
      const side = nearestSide(ring, at);
      const s = ring[side]!, e = ring[(side + 1) % ring.length]!, len = Math.hypot(e.x - s.x, e.y - s.y);
      const sin = Math.abs(((e.x - s.x) * p.d.y - (e.y - s.y) * p.d.x) / len);
      const nearCorner = ring.some((c) => Math.hypot(c.x - at.x, c.y - at.y) < CORNER_CLEAR && !onStraight(ring, c));
      if (sin < MIN_SIN || nearCorner) { if (end === 0) p.end0 = false; else p.end1 = false; }
    }
  }
  // The crossings of the two families, at right angles.
  const a0 = pieces.filter((p) => p.fam === 0), b1 = pieces.filter((p) => p.fam === 1);
  for (const p of a0) for (const q of b1) {
    const tp = (q.o.x - p.o.x) * p.d.x + (q.o.y - p.o.y) * p.d.y, tq = (p.o.x - q.o.x) * q.d.x + (p.o.y - q.o.y) * q.d.y;
    if (tp > p.t0 + m(1) && tp < p.t1 - m(1) && tq > q.t0 + m(1) && tq < q.t1 - m(1)) { p.cross.push(tp); q.cross.push(tq); }
  }
  for (const p of pieces) {
    p.cross.sort((x, y) => x - y);
    const stops = [...(p.end0 ? [p.t0] : []), ...p.cross, ...(p.end1 ? [p.t1] : [])];
    if (stops.length < 2 || stops[stops.length - 1]! - stops[0]! < MIN_PIECE) continue;
    // A piece that stops at its last crossing on both ends and meets nothing: the other family meets it, so it stays.
    streets.push({ pts: stops.map((t) => ({ x: p.o.x + p.d.x * t, y: p.o.y + p.d.y * t })), level: p.level });
  }
  return { sides, streets };
}

/** Whether ring corner `c` lies on a straight run (an avenue's bend, not a corner of the land). */
function onStraight(ring: readonly Vec2[], c: Vec2): boolean {
  const i = ring.indexOf(c), p = ring[(i - 1 + ring.length) % ring.length]!, q = ring[(i + 1) % ring.length]!;
  const ax = c.x - p.x, ay = c.y - p.y, bx = q.x - c.x, by = q.y - c.y;
  return (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)) > Math.cos((25 * Math.PI) / 180);
}

/** Where a line runs inside a ring: its runs, by their ends along it. */
function clipLine(ring: readonly Vec2[], o: Vec2, d: Vec2): { t0: number; t1: number }[] {
  const hits: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
    const sp = d.x * (p.y - o.y) - d.y * (p.x - o.x), sq = d.x * (q.y - o.y) - d.y * (q.x - o.x);
    if ((sp > 0) === (sq > 0)) continue;
    const k = sp / (sp - sq);
    hits.push((p.x + (q.x - p.x) * k - o.x) * d.x + (p.y + (q.y - p.y) * k - o.y) * d.y);
  }
  hits.sort((x, y) => x - y);
  const out: { t0: number; t1: number }[] = [];
  for (let k = 0; k + 1 < hits.length; k += 2) if (hits[k + 1]! - hits[k]! > MIN_PIECE) out.push({ t0: hits[k]!, t1: hits[k + 1]! });
  return out;
}

function nearestSide(ring: readonly Vec2[], p: Vec2): number {
  let best = Infinity, side = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2)) : 0;
    const dd = Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y);
    if (dd < best) { best = dd; side = i; }
  }
  return side;
}

/** The streets round tile (i, j) as one planar graph: every line within `MARGIN` of the tile, cut where lines cross, where a street meets an avenue, and at every tiles' edge. */
export function tileStreets(seed: number, i: number, j: number, heatAt: (x: number, y: number) => number): StreetGraph {
  const bx0 = i * TILE - MARGIN, by0 = j * TILE - MARGIN, bx1 = (i + 1) * TILE + MARGIN, by1 = (j + 1) * TILE + MARGIN;
  const lines: Line[] = [];
  for (const { a, b } of cellsOver(seed, bx0, by0, bx1, by1)) {
    const { sides, streets } = cellStreets(seed, a, b, heatAt);
    for (const l of sides) lines.push(...clipAvenue(l));
    lines.push(...streets);
  }
  return planar(lines.filter((l) => l.pts.length >= 2), [bx0, by0, bx1, by1]);
}

/** An avenue's runs inside the map's frame: each piece cut where it crosses the frame (Liang-Barsky), what is past it let go. */
function clipAvenue(l: Line): Line[] {
  const runs: Line[] = [];
  let run: Vec2[] = [];
  for (let k = 0; k + 1 < l.pts.length; k++) {
    const p = l.pts[k]!, q = l.pts[k + 1]!, dx = q.x - p.x, dy = q.y - p.y;
    let t0 = 0, t1 = 1;
    for (const [pv, dv] of [[p.x, dx], [p.y, dy]] as const) {
      for (const bound of [-FRAME, FRAME]) {
        // Inside is pv + t dv on the frame's side of the bound.
        const sign = bound < 0 ? 1 : -1, num = sign * (pv - bound), den = sign * dv;
        if (den === 0) { if (num < 0) t0 = 2; continue; }
        const t = -num / den;
        if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
      }
    }
    if (t0 >= t1) { if (run.length >= 2) runs.push({ pts: dropRepeats(run), level: l.level }); run = []; continue; }
    const a = t0 > 0 ? { x: p.x + dx * t0, y: p.y + dy * t0 } : p, b = t1 < 1 ? { x: p.x + dx * t1, y: p.y + dy * t1 } : q;
    if (!run.length || t0 > 0) { if (run.length >= 2) runs.push({ pts: dropRepeats(run), level: l.level }); run = [a]; }
    run.push(b);
    if (t1 < 1) { runs.push({ pts: dropRepeats(run), level: l.level }); run = []; }
  }
  if (run.length >= 2) runs.push({ pts: dropRepeats(run), level: l.level });
  return runs.filter((r) => r.pts.length >= 2);
}

const dropRepeats = (pts: Vec2[]): Vec2[] => pts.filter((p, k) => k === 0 || Math.hypot(p.x - pts[k - 1]!.x, p.y - pts[k - 1]!.y) > SAME);

/** Lines made one planar graph: every crossing and every meeting a node, junctions near a tiles' edge moved onto it, every piece cut at the edges, the pieces past the box let go. */
function planar(lines: Line[], box: readonly [number, number, number, number]): StreetGraph {
  // Pieces, and the points along each where it is cut.
  type Piece = { a: Vec2; b: Vec2; level: 0 | 1 | 2; cuts: number[] };
  const pieces: Piece[] = [];
  for (const l of lines) for (let k = 0; k + 1 < l.pts.length; k++) pieces.push({ a: l.pts[k]!, b: l.pts[k + 1]!, level: l.level, cuts: [0, 1] });
  const CELL = m(128);
  const grid = new Map<number, number[]>();
  const key = (cx: number, cy: number): number => (cx + 4096) * 8192 + (cy + 4096);
  pieces.forEach((p, n) => {
    for (let cx = Math.floor(Math.min(p.a.x, p.b.x) / CELL); cx <= Math.floor(Math.max(p.a.x, p.b.x) / CELL); cx++) {
      for (let cy = Math.floor(Math.min(p.a.y, p.b.y) / CELL); cy <= Math.floor(Math.max(p.a.y, p.b.y) / CELL); cy++) {
        const k = key(cx, cy);
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(n);
      }
    }
  });
  // Crossings and touches (an end on another piece): both cut there.
  const done = new Set<number>();
  for (const list of grid.values()) {
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const p = list[x]!, q = list[y]!, pair = p * 1_000_003 + q;
      if (done.has(pair)) continue;
      done.add(pair);
      const P = pieces[p]!, Q = pieces[q]!;
      const hit = meet(P.a, P.b, Q.a, Q.b);
      if (hit) { P.cuts.push(hit.t); Q.cuts.push(hit.u); }
    }
  }
  // The tiles' edges.
  for (const P of pieces) {
    for (const c of CUTS) {
      if ((P.a.x - c) * (P.b.x - c) < 0) P.cuts.push((c - P.a.x) / (P.b.x - P.a.x));
      if ((P.a.y - c) * (P.b.y - c) < 0) P.cuts.push((c - P.a.y) / (P.b.y - P.a.y));
    }
  }
  // Nodes: points merged within SAME; then edges.
  const nodes: Vec2[] = [];
  const at = new Map<number, number[]>();
  const nodeOf = (p: Vec2): number => {
    const cx = Math.floor(p.x / m(1)), cy = Math.floor(p.y / m(1));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const n of at.get(key(cx + dx, cy + dy)) ?? []) if (Math.abs(nodes[n]!.x - p.x) < SAME && Math.abs(nodes[n]!.y - p.y) < SAME) return n;
    }
    const n = nodes.push({ x: p.x, y: p.y }) - 1;
    const k = key(cx, cy);
    (at.get(k) ?? at.set(k, []).get(k)!).push(n);
    return n;
  };
  const raw: { a: number; b: number; level: 0 | 1 | 2 }[] = [];
  for (const P of pieces) {
    const ts = [...new Set(P.cuts)].sort((x, y) => x - y);
    let last = nodeOf(P.a);
    for (let k = 1; k < ts.length; k++) {
      const t = ts[k]!, next = nodeOf({ x: P.a.x + (P.b.x - P.a.x) * t, y: P.a.y + (P.b.y - P.a.y) * t });
      if (next !== last) raw.push({ a: last, b: next, level: P.level });
      last = next;
    }
  }
  // Junctions near an edge moved onto it along their most crossing road; a node within a millimetre of an edge put on it.
  const incident = new Map<number, number[]>();
  raw.forEach((e, k) => { for (const n of [e.a, e.b]) (incident.get(n) ?? incident.set(n, []).get(n)!).push(k); });
  const pos = nodes.map((p) => ({ x: p.x, y: p.y }));
  for (let n = 0; n < pos.length; n++) {
    const degree = incident.get(n)?.length ?? 0;
    for (const axis of ['x', 'y'] as const) {
      const p = pos[n]!;
      for (const c of CUTS) {
        const off = c - p[axis];
        if (off === 0) continue;
        if (Math.abs(off) < m(0.01)) { p[axis] = c; continue; }
        if (degree < 3 || Math.abs(off) >= SNAP) continue;
        let dir: Vec2 | null = null, across = 0.4;
        for (const k of incident.get(n)!) {
          const e = raw[k]!, o = nodes[e.a === n ? e.b : e.a]!, len = Math.hypot(o.x - nodes[n]!.x, o.y - nodes[n]!.y);
          const v = { x: (o.x - nodes[n]!.x) / len, y: (o.y - nodes[n]!.y) / len }, s = Math.abs(axis === 'x' ? v.x : v.y);
          if (len > Math.abs(off) * 2 && s > across && Math.sign(axis === 'x' ? v.x : v.y) === Math.sign(off)) { across = s; dir = v; }
        }
        if (!dir) continue;
        const k = off / (axis === 'x' ? dir.x : dir.y);
        p.x += dir.x * k; p.y += dir.y * k;
        p[axis] = c;
      }
    }
  }
  // A road moved onto an edge no longer crosses it; a road whose node moved now may: cut again.
  const merged = new Map<string, number>();
  const final: Vec2[] = [];
  const idOf = (p: Vec2): number => {
    const k = `${Math.round(p.x / SAME)},${Math.round(p.y / SAME)}`;
    let n = merged.get(k);
    if (n === undefined) merged.set(k, n = final.push(p) - 1);
    return n;
  };
  const [x0, y0, x1, y1] = box;
  const inBox = (p: Vec2): boolean => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const edges: StreetEdge[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    const a = pos[e.a]!, b = pos[e.b]!;
    if (!inBox(a) && !inBox(b)) continue;
    const ts: number[] = [];
    for (const c of CUTS) {
      if ((a.x - c) * (b.x - c) < 0) ts.push((c - a.x) / (b.x - a.x));
      if ((a.y - c) * (b.y - c) < 0) ts.push((c - a.y) / (b.y - a.y));
    }
    ts.sort((p, q) => p - q);
    let last = idOf(a);
    for (const t of [...ts, 1]) {
      const p = t === 1 ? b : { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      for (const c of CUTS) { if (Math.abs(p.x - c) < m(0.01)) p.x = c; if (Math.abs(p.y - c) < m(0.01)) p.y = c; }
      const next = idOf(p);
      const k = last < next ? `${last},${next}` : `${next},${last}`;
      if (next !== last && !seen.has(k)) { seen.add(k); edges.push({ a: last, b: next, points: [], level: e.level }); }
      last = next;
    }
  }
  return collapseShort(final, edges);
}

/** Roads shorter than `SHORT` taken away, their two ends one node: the end on a tiles' edge kept, else the lower by place (the same choice from every tile). */
const SHORT = m(3);
function collapseShort(nodes: Vec2[], edges: StreetEdge[]): StreetGraph {
  const onCut = (p: Vec2): boolean => CUTS.includes(p.x) || CUTS.includes(p.y);
  const before = (p: Vec2, q: Vec2): boolean => (onCut(p) !== onCut(q) ? onCut(p) : p.x !== q.x ? p.x < q.x : p.y < q.y);
  const parent = nodes.map((_, n) => n);
  const root = (n: number): number => { while (parent[n] !== n) n = parent[n] = parent[parent[n]!]!; return n; };
  for (const e of edges) {
    const a = nodes[e.a]!, b = nodes[e.b]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) >= SHORT) continue;
    const ra = root(e.a), rb = root(e.b);
    if (ra === rb) continue;
    if (before(nodes[ra]!, nodes[rb]!)) parent[rb] = ra; else parent[ra] = rb;
  }
  const seen = new Set<string>();
  const out: StreetEdge[] = [];
  for (const e of edges) {
    const a = root(e.a), b = root(e.b), k = a < b ? `${a},${b}` : `${b},${a}`;
    if (a === b || seen.has(k)) continue;
    seen.add(k);
    out.push({ ...e, a, b });
  }
  return { nodes, edges: out };
}

/** Where two pieces meet (cross or touch), t along the first and u along the second, or null; parallel pieces never. */
function meet(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number } | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den, u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  const e = 1e-7;
  return t >= -e && t <= 1 + e && u >= -e && u <= 1 + e ? { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)) } : null;
}
