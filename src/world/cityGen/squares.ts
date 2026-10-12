import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '../doc';
import { type Lot, insideLot, lotArea, lotCentre } from '../lots';
import { ROAD_TYPES } from '../roadTypes';
import type { PaintDab } from '../terrainPaint';
import type { PlantedTree } from '../trees';
import { treeSeed } from '../trees';
import { UNITS_PER_METER, m } from '../units';

/**
 * THE SQUARES OF A GENERATED CITY (docs/VIAS.md V7; the coordinator's order
 * of 2026-10-09: one square per neighbourhood, on a corner block or on an
 * avenue's axis, never loose grass in the middle of a block).
 *
 * A square is a WHOLE block - every lot of a block, the block being the lots
 * that touch one another between the streets - fronting a main road
 * (avenue or collector), chosen per neighbourhood (a cell of
 * `NEIGHBOURHOOD`) as the block of a fitting size nearest the cell's middle.
 * Brazilian practice (the "praça" of the grid town, Lei 6.766/79 art. 4º,
 * public open space in every subdivision): a paved cross of walks from the
 * middle of each side, lawns between, trees round the edge and in the lawns.
 * Its lots go; the walks are painted (concrete) on the ground's grass and the trees are
 * planted trees (`RoadDoc.trees`, drawn instanced), the benches and lamps
 * are the furniture of the streets round it.
 */

/** A neighbourhood's side: one square in each. */
export const NEIGHBOURHOOD = m(420);
/** The block sizes a square is made of, square metres. */
const AREA_RANGE = [1500, 14000] as const;

export interface SquarePlan {
  readonly lots: readonly number[];
  readonly centre: Vec2;
  readonly dabs: readonly PaintDab[];
  readonly trees: readonly PlantedTree[];
}

/** The blocks: lots that touch (a corner within a metre of another's side) belong together. */
function blocks(lots: readonly Lot[]): Lot[][] {
  const parent = lots.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const near = (p: Vec2, l: Lot): boolean => {
    const q = l.corners;
    for (let i = 0; i < q.length; i++) {
      const a = q[i]!, b = q[(i + 1) % q.length]!;
      const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2)) : 0;
      if (Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y) < m(1)) return true;
    }
    return false;
  };
  const cell = m(60);
  const grid = new Map<string, number[]>();
  lots.forEach((l, i) => {
    const c = lotCentre(l), key = `${Math.floor(c.x / cell)},${Math.floor(c.y / cell)}`;
    let list = grid.get(key);
    if (!list) grid.set(key, list = []);
    list.push(i);
  });
  lots.forEach((l, i) => {
    const c = lotCentre(l);
    const cx = Math.floor(c.x / cell), cy = Math.floor(c.y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (j <= i || find(i) === find(j)) continue;
        if (l.corners.some((p) => near(p, lots[j]!)) || lots[j]!.corners.some((p) => near(p, l))) parent[find(i)] = find(j);
      }
    }
  });
  const out = new Map<number, Lot[]>();
  lots.forEach((l, i) => { const r = find(i); let list = out.get(r); if (!list) out.set(r, list = []); list.push(l); });
  return [...out.values()];
}

/** Distance from a point to the nearest main road (avenue or collector) of the document. */
function mainRoadDistance(doc: RoadDoc, p: Vec2): number {
  const main = new Set(['avenue', 'urban', 'boulevard'].map((id) => ROAD_TYPES.findIndex((t) => t.id === id)));
  let best = Infinity;
  for (const s of doc.segments.values()) {
    if (!main.has(s.type)) continue;
    const a = doc.node(s.a), b = doc.node(s.b);
    if (!a || !b) continue;
    const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2)) : 0;
    best = Math.min(best, Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y));
  }
  return best;
}

/** A small deterministic generator for the trees' looks. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4_294_967_296; };
}

/** The squares of a city laid on `doc` with its lots cut. */
export function planSquares(doc: RoadDoc, seed: number): SquarePlan[] {
  const lots = doc.lots as readonly Lot[];
  const byCell = new Map<string, { block: Lot[]; centre: Vec2; score: number }>();
  for (const block of blocks(lots)) {
    const area = block.reduce((s, l) => s + Math.abs(lotArea(l)), 0) / (UNITS_PER_METER * UNITS_PER_METER);
    if (area < AREA_RANGE[0] || area > AREA_RANGE[1]) continue;
    let x = 0, y = 0, w = 0;
    for (const l of block) { const c = lotCentre(l), a = Math.abs(lotArea(l)); x += c.x * a; y += c.y * a; w += a; }
    const centre = { x: x / w, y: y / w };
    // On a main road: some lot of the block fronts one (its front within reach).
    const fronting = block.some((l) => mainRoadDistance(doc, { x: (l.corners[0]!.x + l.corners[1]!.x) / 2, y: (l.corners[0]!.y + l.corners[1]!.y) / 2 }) < m(20));
    if (!fronting) continue;
    const kx = Math.floor(centre.x / NEIGHBOURHOOD), ky = Math.floor(centre.y / NEIGHBOURHOOD);
    const mid = { x: (kx + 0.5) * NEIGHBOURHOOD, y: (ky + 0.5) * NEIGHBOURHOOD };
    const score = Math.hypot(centre.x - mid.x, centre.y - mid.y);
    const key = `${kx},${ky}`;
    const known = byCell.get(key);
    if (!known || score < known.score) byCell.set(key, { block, centre, score });
  }
  const out: SquarePlan[] = [];
  for (const { block, centre } of [...byCell.values()].sort((a, b) => a.centre.x - b.centre.x || a.centre.y - b.centre.y)) {
    const inside = (p: Vec2): boolean => block.some((l) => insideLot(p, l));
    // The block's own axes: the first lot's front.
    const f = block[0]!;
    const ux0 = f.corners[1]!.x - f.corners[0]!.x, uy0 = f.corners[1]!.y - f.corners[0]!.y, ul = Math.hypot(ux0, uy0) || 1;
    const u = { x: ux0 / ul, y: uy0 / ul }, v = { x: -u.y, y: u.x };
    const onWalk = (p: Vec2): boolean => {
      const dx = p.x - centre.x, dy = p.y - centre.y;
      return Math.abs(dx * u.x + dy * u.y) < m(2.2) || Math.abs(dx * v.x + dy * v.y) < m(2.2) || Math.hypot(dx, dy) < m(7);
    };
    const minX = Math.min(...block.flatMap((l) => l.corners.map((p) => p.x))), maxX = Math.max(...block.flatMap((l) => l.corners.map((p) => p.x)));
    const minY = Math.min(...block.flatMap((l) => l.corners.map((p) => p.y))), maxY = Math.max(...block.flatMap((l) => l.corners.map((p) => p.y)));
    const dabs: PaintDab[] = [];
    // The lawns are the ground's own grass; the walks are paved over it.
    for (let x = minX; x <= maxX; x += m(1.8)) for (let y = minY; y <= maxY; y += m(1.8)) {
      const p = { x, y };
      if (inside(p) && onWalk(p)) dabs.push({ kind: 'concrete', x, y, radius: m(1.4), strength: 1 });
    }
    // Trees: on a 9 m grid in the lawns, clear of the walks and of the block's edge.
    const random = rng(seed * 31 + out.length * 7919);
    const trees: PlantedTree[] = [];
    for (let a = -m(200); a <= m(200); a += m(9)) for (let b = -m(200); b <= m(200); b += m(9)) {
      const p = { x: centre.x + u.x * a + v.x * b, y: centre.y + u.y * a + v.y * b };
      if (!inside(p) || onWalk(p)) continue;
      const edgeClear = [[m(3), 0], [-m(3), 0], [0, m(3)], [0, -m(3)]].every(([da, db]) => inside({ x: p.x + u.x * da! + v.x * db!, y: p.y + u.y * da! + v.y * db! }));
      if (!edgeClear) continue;
      trees.push({ x: p.x, y: p.y, height: m(9 + random() * 5), yaw: random() * Math.PI * 2, seed: treeSeed('mixed', random) });
    }
    out.push({ lots: block.map((l) => l.id), centre, dabs, trees });
  }
  return out;
}
