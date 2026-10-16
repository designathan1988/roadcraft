import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { TILE } from '../tiles';
import { m } from '../units';
import { type BasisField, TensorField } from './field';
import type { CityPlan } from './plan';
import { type ForcedSeed, type StreetEdge, type StreetGraph, type StreetLevel, planarize, traceStreets } from './streets';
import { type Gate, type TileCharacter, type WholeMapPlan, borderLine, gatesOf, mapLine, mix, tileOnMap } from './wholeMap';

/** ONE TILE OF THE WORLD (`wholeMap.ts`, any column and row): its border avenues, a street from each gate, and its own streets inside, laid as a generated city's plan (`CityPlan`) the city's own steps read (`editor/wholeMapTile.ts`). Everything here reads the seed and the tile's place only. */

/** A gate's street runs this far straight in from the avenue's middle before it turns or meets another: the neighbour's tile holds the same piece on its side (its first road), so the junction at the gate is the same seen from either tile. */
export const STUB = m(40);
/** How far in from the border a traced tile's streets start (`inside`): room for a row of lots facing the avenue. */
const INSET = m(72);
/** A traced street left ending this near the inset edge stopped short of the avenue: taken away, never left as a stub facing it. */
const BAND = m(26);
/** A grid tile's first street along each border, from the border: two rows of lots back to back between it and the avenue. */
const FRAME = m(100);
/** Two grid lines nearer than this: the gate's kept, the frame or fill left out. */
const MIN_GAP = m(60);
/** Under a millimetre: a point on a border line. */
const ON_LINE = 1e-6;

/** A grid tile's longest blocks, along x and along y, by what the tile is. */
const GRID_GAPS: Record<TileCharacter['kind'], readonly [number, number]> = {
  downtown: [m(130), m(80)], urban: [m(150), m(92)], suburb: [m(170), m(100)], industrial: [m(240), m(170)], rural: [Infinity, Infinity],
};

export interface TilePlan {
  readonly i: number;
  readonly j: number;
  readonly character: TileCharacter;
  /** The plan the city's steps read (`layCity` its graph, `zoneCity` its zones). */
  readonly city: CityPlan;
  /** The tile's own stream for what is drawn on it (squares, growth). */
  readonly seed: number;
  /** Whether a place is this tile's (`tiles.ts` `OWNER`: its square, low edges in): what stands there (lots, buildings, poles, furniture) is kept by it alone. */
  owns(p: Vec2): boolean;
  /** Whether a node is on the tile or its border (the pieces of the neighbours' gate streets it holds are not). */
  keepsNode(p: Vec2): boolean;
}

/** One side of the tile: its line, its gates, which way is in, and what kind of tile lies beyond. */
interface Side { readonly from: Vec2; readonly to: Vec2; readonly gates: readonly Gate[]; readonly inward: Vec2; readonly beyond: 'rural' | 'town' | 'edge'; readonly axis: 'x' | 'y' }

export function planTile(map: WholeMapPlan, i: number, j: number): TilePlan {
  const seed = map.options.seed;
  const character = map.tile(i, j);
  // The tile's square (what it owns), and the lines its border avenues run on: on the map's edge, inside it (`mapLine`), the avenue closing the map whole on the ground.
  const x0 = borderLine(i), x1 = borderLine(i + 1), y0 = borderLine(j), y1 = borderLine(j + 1);
  const ax0 = mapLine(i), ax1 = mapLine(i + 1), ay0 = mapLine(j), ay1 = mapLine(j + 1);
  const rows = gatesOf(seed, 0, j), cols = gatesOf(seed, 1, i);
  // What lies beyond each side: the countryside (its avenue gates' streets only), a town, or the map's edge (no street out of the map).
  const beyond = (ni: number, nj: number): Side['beyond'] => (!tileOnMap(ni, nj) ? 'edge' : map.tile(ni, nj).style === 'rural' ? 'rural' : 'town');
  const sides: Side[] = [
    { from: { x: ax0, y: ay0 }, to: { x: ax1, y: ay0 }, gates: cols, inward: { x: 0, y: 1 }, beyond: beyond(i, j - 1), axis: 'x' },
    { from: { x: ax0, y: ay1 }, to: { x: ax1, y: ay1 }, gates: cols, inward: { x: 0, y: -1 }, beyond: beyond(i, j + 1), axis: 'x' },
    { from: { x: ax0, y: ay0 }, to: { x: ax0, y: ay1 }, gates: rows, inward: { x: 1, y: 0 }, beyond: beyond(i - 1, j), axis: 'y' },
    { from: { x: ax1, y: ay0 }, to: { x: ax1, y: ay1 }, gates: rows, inward: { x: -1, y: 0 }, beyond: beyond(i + 1, j), axis: 'y' },
  ];
  const nodes: Vec2[] = [];
  const edges: StreetEdge[] = [];
  const corner = new Map<string, number>();
  const cornerAt = (p: Vec2): number => {
    const key = `${p.x},${p.y}`;
    let n = corner.get(key);
    if (n === undefined) corner.set(key, n = nodes.push(p) - 1);
    return n;
  };
  const style = character.style;
  const rural = style === 'rural';
  // ---- the border avenues, cut at every gate; a gate's street in, and the neighbour's first piece out
  const gateEnds: { gate: Gate; node: number; side: Side; at: Vec2 }[] = [];
  for (const side of sides) {
    let last = cornerAt(side.from);
    for (const gate of side.gates) {
      const at = side.axis === 'x' ? { x: gate.at, y: side.from.y } : { x: side.from.x, y: gate.at };
      const node = nodes.push(at) - 1;
      edges.push({ a: last, b: node, points: [], level: 0 });
      last = node;
      if (!rural || gate.level === 0) gateEnds.push({ gate, node, side, at });
      if (side.beyond === 'town' || (side.beyond === 'rural' && gate.level === 0)) {
        const out = nodes.push({ x: at.x - side.inward.x * STUB, y: at.y - side.inward.y * STUB }) - 1;
        edges.push({ a: node, b: out, points: [], level: gate.level });
      }
    }
    edges.push({ a: last, b: cornerAt(side.to), points: [], level: 0 });
  }
  const rng = new Rng(mix(seed, 0x7113, i, j));
  const field = style === 'blocks' || rural
    ? gridInterior(character, gateEnds, nodes, edges, { x0: ax0, y0: ay0, x1: ax1, y1: ay1 })
    : tracedInterior(character, gateEnds, nodes, edges, { x0: ax0, y0: ay0, x1: ax1, y1: ay1 }, seed, rng);
  const graph: StreetGraph = { nodes, edges };
  const city: CityPlan = {
    // The steps read the plan's graph and zones; its options stand for the whole map's (no size of its own).
    options: { ...map.options, size: 'large', radius: TILE / 2 },
    field, radius: TILE / 2, centres: map.centresNear({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }), graph, zoneAt: map.zoneAt,
  };
  return {
    i, j, character, city, seed: mix(seed, 0x711e, i, j),
    owns: (p) => p.x >= x0 && p.x < x1 && p.y >= y0 && p.y < y1,
    keepsNode: (p) => p.x >= x0 - ON_LINE && p.x <= x1 + ON_LINE && p.y >= y0 - ON_LINE && p.y <= y1 + ON_LINE,
  };
}

interface Box { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
interface GridLine { readonly at: number; readonly level: number; readonly gate: boolean }

/** A grid tile ('blocks', and the countryside's avenues alone): a straight street through every gate from border to border, frames along the borders and streets between them every block. */
function gridInterior(character: TileCharacter, gateEnds: readonly { gate: Gate; node: number; side: Side; at: Vec2 }[], nodes: Vec2[], edges: StreetEdge[], box: Box): TensorField {
  const rural = character.style === 'rural';
  const [gapX, gapY] = GRID_GAPS[character.kind];
  const lines = (axis: 'x' | 'y', lo: number, hi: number, gap: number): GridLine[] => {
    const gates = new Map<number, GridLine>();
    // Each gate once (the same gates on both sides of the tile).
    for (const g of gateEnds) if (g.side.axis === axis) gates.set(g.gate.at, { at: g.gate.at, level: g.gate.level, gate: true });
    const out: GridLine[] = [...gates.values()];
    if (!rural) {
      for (const at of [lo + FRAME, hi - FRAME]) if (out.every((l) => Math.abs(l.at - at) >= MIN_GAP)) out.push({ at, level: 2, gate: false });
    }
    out.sort((a, b) => a.at - b.at);
    if (rural) return out;
    const filled: GridLine[] = [];
    for (let k = 0; k < out.length; k++) {
      filled.push(out[k]!);
      const next = out[k + 1];
      if (!next) break;
      const parts = Math.ceil((next.at - out[k]!.at) / gap);
      for (let q = 1; q < parts; q++) filled.push({ at: out[k]!.at + ((next.at - out[k]!.at) * q) / parts, level: 2, gate: false });
    }
    return filled;
  };
  // x-lines run north-south at these x (their gates on the south and north borders), y-lines east-west.
  const xs = lines('x', box.x0, box.x1, gapX), ys = lines('y', box.y0, box.y1, gapY);
  const at = new Map<string, number>();
  const node = (x: number, y: number): number => {
    const key = `${x},${y}`;
    let n = at.get(key);
    if (n === undefined) at.set(key, n = nodes.push({ x, y }) - 1);
    return n;
  };
  const gateNode = new Map<string, number>();
  for (const g of gateEnds) gateNode.set(`${g.at.x},${g.at.y}`, g.node);
  // A line's run: its gate stubs at either end when it is a gate's, else from the first line across it to the last.
  const run = (line: GridLine, across: readonly GridLine[], lo: number, hi: number, point: (s: number) => Vec2): void => {
    const stops = across.map((l) => l.at);
    if (line.gate) { stops.unshift(lo + STUB); stops.push(hi - STUB); }
    const ids = stops.map((s) => { const p = point(s); return node(p.x, p.y); });
    for (let k = 1; k < ids.length; k++) edges.push({ a: ids[k - 1]!, b: ids[k]!, points: [], level: line.level });
    if (!line.gate) return;
    // The gate's own piece, avenue to stub, at both ends.
    for (const [s, end] of [[lo, ids[0]!], [hi, ids[ids.length - 1]!]] as const) {
      const g = gateNode.get((() => { const p = point(s); return `${p.x},${p.y}`; })());
      if (g !== undefined) edges.push({ a: g, b: end, points: [], level: line.level });
    }
  };
  for (const l of xs) run(l, ys, box.y0, box.y1, (s) => ({ x: l.at, y: s }));
  for (const l of ys) run(l, xs, box.x0, box.x1, (s) => ({ x: s, y: l.at }));
  return new TensorField([], { amount: 0, scale: m(500), seed: 0 });
}

/** A traced tile: the tensor field's streets (`streets.ts`) inside the inset, a street started at every gate, the field turned square to the borders near them. */
function tracedInterior(character: TileCharacter, gateEnds: readonly { gate: Gate; node: number; side: Side; at: Vec2 }[], nodes: Vec2[], edges: StreetEdge[], box: Box, seed: number, rng: Rng): TensorField {
  const fields: BasisField[] = [];
  const mid = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
  const grid = (x: number, y: number, radius: number, angle: number, weight: number): void => { fields.push({ kind: 'grid', x, y, radius, angle, weight }); };
  // Square to the border avenues along them.
  for (let s = 0; s <= 1.0001; s += 0.2) {
    const x = box.x0 + (box.x1 - box.x0) * s, y = box.y0 + (box.y1 - box.y0) * s;
    for (const p of [{ x, y: box.y0 + INSET }, { x, y: box.y1 - INSET }, { x: box.x0 + INSET, y }, { x: box.x1 - INSET, y }]) grid(p.x, p.y, m(140), 0, 1.5);
  }
  const half = (box.x1 - box.x0) / 2;
  let noise = { amount: 0.08, scale: m(450), seed };
  if (character.style === 'grid') {
    grid(mid.x, mid.y, half * 2, (rng.bool() ? 1 : -1) * rng.range(0.25, 0.6), 1);
  } else if (character.style === 'organic') {
    grid(mid.x, mid.y, half * 2, 0, 0.25);
    for (let k = 0; k < 6; k++) grid(mid.x + rng.range(-0.7, 0.7) * half, mid.y + rng.range(-0.7, 0.7) * half, rng.range(m(180), m(320)), rng.range(0, Math.PI), 1);
    noise = { amount: 0.32, scale: m(260), seed };
  } else if (character.style === 'radial') {
    grid(mid.x, mid.y, half * 2, 0, 0.3);
    fields.push({ kind: 'radial', x: character.hub.x, y: character.hub.y, radius: m(420), weight: 1.2 });
    noise = { amount: 0.1, scale: m(400), seed };
  } else {
    // 'mixed' inside one tile: a turned grid and a radial at its middle.
    grid(mid.x, mid.y, half * 2, rng.range(-0.5, 0.5), 0.45);
    fields.push({ kind: 'radial', x: mid.x, y: mid.y, radius: half * 0.6, weight: 1.1 });
    noise = { amount: 0.14, scale: m(380), seed };
  }
  const field = new TensorField(fields, noise);
  const ix0 = box.x0 + INSET, iy0 = box.y0 + INSET, ix1 = box.x1 - INSET, iy1 = box.y1 - INSET;
  const inside = (p: Vec2): boolean => p.x > ix0 && p.x < ix1 && p.y > iy0 && p.y < iy1;
  // Each gate's street starts at the inset, square to its border.
  const anchors = gateEnds.map((g) => ({ x: g.at.x + g.side.inward.x * INSET, y: g.at.y + g.side.inward.y * INSET }));
  const seedsOf = (level: 0 | 1): ForcedSeed[] => gateEnds.flatMap((g, k) => g.gate.level !== level ? [] : [{
    p: { x: anchors[k]!.x + g.side.inward.x * m(0.5), y: anchors[k]!.y + g.side.inward.y * m(0.5) }, along: g.side.inward, reach: TILE,
  }]);
  const levels: StreetLevel[] = [
    { dsepMajor: m(330), dsepMinor: m(330), testFraction: 0.5, dstep: m(8), dlookahead: m(220), minLength: m(120), maxLength: TILE * 1.6, seedTries: 0, seeds: seedsOf(0) },
    { dsepMajor: m(160), dsepMinor: m(200), testFraction: 0.5, dstep: m(7), dlookahead: m(120), minLength: m(110), maxLength: TILE * 1.2, seedTries: 60, seeds: seedsOf(1) },
    { dsepMajor: m(68), dsepMinor: m(112), testFraction: 0.55, dstep: m(6), dlookahead: m(70), minLength: m(60), maxLength: m(520), seedTries: 140 },
  ];
  const nearEdge = (p: Vec2): boolean => Math.min(p.x - ix0, ix1 - p.x, p.y - iy0, iy1 - p.y) < BAND;
  const inner = planarize(traceStreets(field, inside, { x0: ix0, y0: iy0, x1: ix1, y1: iy1 }, levels, rng),
    { merge: m(14), prune: m(45), minAngle: 0.5, simplify: m(1.2), spacing: m(16), anchors, pruneEnd: nearEdge });
  const base = nodes.length;
  nodes.push(...inner.nodes);
  for (const e of inner.edges) edges.push({ a: e.a + base, b: e.b + base, points: e.points, level: e.level });
  // The gate's street from the avenue to its anchor, through the stub's end (the neighbour's first node); none where no street reached the anchor.
  gateEnds.forEach((g, k) => {
    const anchor = inner.anchors[k]!;
    if (anchor < 0) return;
    edges.push({ a: g.node, b: anchor + base, points: [{ x: g.at.x + g.side.inward.x * STUB, y: g.at.y + g.side.inward.y * STUB }], level: g.gate.level });
  });
  return field;
}

