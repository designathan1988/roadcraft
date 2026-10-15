import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { Level, type SurfaceLevel, halfWidth } from './roadTypes';
import type { NodeId } from './ids';
import type { Junction } from './junction/build';
import { type MultiPoly, difference, union } from '@core/clipper';
import { levelRingsOf } from './surfaces';
import { hull, lotCentre, orientedBox, simplifyRing } from './lotRings';
import { offsetRing } from './buildings/footprints';
import { touchesRoad } from './buildings/validate';
import { m, stepsIn } from './units';
import { markPaved, pavedTester, quadsOverlap } from './zoneGrid';
import type { ZoneDensity, ZoneUse } from './zones';
import { rectAround, type ChangeRect } from './changes';
import { grow } from './cells';
import { LAND, NEAR } from './rasterGrid';
import type { BuildingId } from './buildings/types';
import { insideLot, type Lot } from './lotRecord';

/** Lots: the land cut into plots the player zones and buildings grow on, as a town's cadastre is. - A closed block */

/** Depth of a lot along an open street. */
const LOT_DEPTH = m(32);
/** The frontage a lot aims at: a block's rows and a street's strip are cut into equal lots of about this width */
const LOT_FRONTAGE = m(22);
/** A block deeper than this is cut in two rows, back to back. */
const TWO_ROWS = m(44);
const MIN_LOT = m(10);
const RASTER = m(2);

export { lotCentre } from './lotRings';
export { insideLot, type Lot } from './lotRecord';

export function lotArea(l: Pick<Lot, 'corners'>): number {
  let a = 0;
  const q = l.corners;
  for (let i = 0; i < q.length; i++) { const p = q[i]!, r = q[(i + 1) % q.length]!; a += p.x * r.y - r.x * p.y; }
  return a / 2;
}

/** The lot's frame for a building: front middle, facing angle (along the front), width and depth. */
export function lotFrame(l: Pick<Lot, 'corners'>): { anchor: Vec2; rotation: number; width: number; depth: number } {
  const a = l.corners[0]!, b = l.corners[1]!;
  const width = Math.hypot(b.x - a.x, b.y - a.y);
  const u = { x: (b.x - a.x) / (width || 1), y: (b.y - a.y) / (width || 1) }, n = { x: -u.y, y: u.x };
  // Depth: how far the lot goes back from its front, at the quarter points of the front and its middle
  let depth = Infinity;
  for (const t of [0.25, 0.5, 0.75]) {
    const o = { x: a.x + (b.x - a.x) * t + n.x * 1e-3, y: a.y + (b.y - a.y) * t + n.y * 1e-3 };
    depth = Math.min(depth, rayExit(l.corners, o, n));
  }
  return { anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, rotation: Math.atan2(u.y, u.x), width, depth: Number.isFinite(depth) ? depth : 0 };
}

/** Where a building can stand on a lot */
export function lotBuildFrame(l: Pick<Lot, 'corners'>): { anchor: Vec2; rotation: number; width: number; depth: number } {
  const q = l.corners;
  const a = q[0]!, b = q[1]!;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, n = { x: -u.y, y: u.x };
  const local = q.map((p) => ({ s: (p.x - a.x) * u.x + (p.y - a.y) * u.y, t: (p.x - a.x) * n.x + (p.y - a.y) * n.y }));
  const tMin = Math.min(...local.map((p) => p.t)), tMax = Math.max(...local.map((p) => p.t));
  const N = Math.max(1, Math.min(160, Math.ceil(stepsIn(tMax - tMin, 0.5))));
  const h = (tMax - tMin) / N;
  const L: number[] = [], R: number[] = [];
  for (let k = 0; k < N; k++) {
    const t = tMin + (k + 0.5) * h;
    const xs: number[] = [];
    for (let i = 0; i < local.length; i++) {
      const p = local[i]!, r = local[(i + 1) % local.length]!;
      if ((p.t > t) === (r.t > t)) continue;
      xs.push(p.s + ((t - p.t) / (r.t - p.t)) * (r.s - p.s));
    }
    xs.sort((x, y) => x - y);
    // The widest chord at this depth (a lot of any shape: the main body of it).
    let lo = 0, hi = -1;
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1]! - xs[i]! > hi - lo) { lo = xs[i]!; hi = xs[i + 1]!; }
    L.push(lo); R.push(hi);
  }
  let best = { score: -Infinity, s0: 0, s1: len, t0: 0, t1: 0 };
  for (let i = 0; i < N; i++) {
    let lo = -Infinity, hi = Infinity;
    for (let j = i; j < N; j++) {
      lo = Math.max(lo, L[j]!); hi = Math.min(hi, R[j]!);
      if (hi - lo <= 0) break;
      const t0 = tMin + i * h, t1 = tMin + (j + 1) * h;
      const score = (hi - lo) * (t1 - t0) - (hi - lo) * Math.max(0, t0);
      if (score > best.score) best = { score, s0: lo, s1: hi, t0, t1 };
    }
  }
  const sm = (best.s0 + best.s1) / 2;
  return {
    anchor: { x: a.x + u.x * sm + n.x * best.t0, y: a.y + u.y * sm + n.y * best.t0 },
    rotation: Math.atan2(u.y, u.x),
    width: Math.max(0, best.s1 - best.s0),
    depth: Math.max(0, best.t1 - best.t0),
  };
}

/** How far a ray from inside a polygon runs before it leaves it. */
function rayExit(q: readonly Vec2[], o: Vec2, d: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!, r = q[(i + 1) % q.length]!;
    const ex = r.x - p.x, ey = r.y - p.y;
    const den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p.x - o.x) * ey - (p.y - o.y) * ex) / den;
    const s = ((p.x - o.x) * d.y - (p.y - o.y) * d.x) / den;
    if (t > 1e-6 && s >= 0 && s <= 1) best = Math.min(best, t);
  }
  return best;
}

interface Candidate { key: string; corners: Vec2[] }

/** The corners in the order a building reads its lot: front-start to front-end with the back on the LEFT of that direction */
function facingCorners<T extends readonly Vec2[]>(c: T): Vec2[] {
  // Counter-clockwise keeps the inside on the left of every side; reversed, the front side keeps its two corners, swapped.
  if (lotArea({ corners: c }) >= 0) return [...c];
  return [c[1]!, c[0]!, ...[...c.slice(2)].reverse()];
}

/** New lots for land with none yet, and the lots the paving now covers. */
export interface LotPlan {
  add: Candidate[];
  keys: string[];
  drop: number[];
  /** Where the land of each key lies (`keys[i]`'s at `keyRects[i]`): a key new to the document is written in the diary there */
  keyRects?: ChangeRect[];
}

export function planLots(doc: RoadDoc, net: Network): LotPlan {
  const steps = planLotsSteps(doc, net);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** `planLots` a little at a time: it yields between rows of the raster, blocks and streets, and returns the plan. */
export function* planLotsSteps(doc: RoadDoc, net: Network): Generator<void, LotPlan> {
  const { onRoad, onPlate } = pavedTester(doc, net);
  yield;
  const paved = (p: Vec2): boolean => onRoad(p) || onPlate(p);
  const ribbons = [...net.ribbons.values()].filter((r) => doc.segment(r.id)?.structure === 'ground' && carriesPedestrians(r.road));
  const drop: number[] = [];
  for (const [i, l] of doc.lots.entries()) {
    if (paved(lotCentre(l)) ||
      l.corners.some((q) => paved({ x: q.x + (lotCentre(l).x - q.x) * 0.15, y: q.y + (lotCentre(l).y - q.y) * 0.15 }))) drop.push(l.id);
    if (i % 64 === 63) yield;
  }
  if (!ribbons.length) return { add: [], keys: [], drop, keyRects: [] };
  const known = new Set(doc.lotKeys);
  const dropping = new Set(drop);
  const kept = doc.lots.filter((l) => !dropping.has(l.id));
  const add: Candidate[] = [];
  const keys: string[] = [];
  const keyRects: ChangeRect[] = [];
  /** A new lot made to fit round the lots already there: what of it lies on one is cut away */
  // The lots there (kept, then added) filed by the cells their boxes cover: each new lot read every lot of the town
  const rings: Vec2[][] = [], ringBoxes: ChangeRect[] = [];
  const ringCells = new Map<number, number[]>();
  const cellsOf = (b: ChangeRect, visit: (k: number) => void): void => {
    for (let i = Math.floor(b[0] / FIT_CELL); i <= Math.floor(b[2] / FIT_CELL); i++) {
      for (let j = Math.floor(b[1] / FIT_CELL); j <= Math.floor(b[3] / FIT_CELL); j++) visit((i + 32768) * 65536 + j + 32768);
    }
  };
  const file = (ring: Vec2[]): void => {
    const b = rectAround(ring);
    if (!b) return;
    const at = rings.length;
    rings.push(ring); ringBoxes.push(b);
    cellsOf(b, (k) => { const list = ringCells.get(k); if (list) list.push(at); else ringCells.set(k, [at]); });
  };
  for (const l of kept) file(l.corners as Vec2[]);
  /** DO NOT walk every lot of the town for each block row and each street strip: it was rows x lots, strips x lots. */
  const keptCount = rings.length;
  const filedIn = (box: ChangeRect, keptOnly = false): number[] => {
    const found = new Set<number>();
    cellsOf(box, (k) => { for (const at of ringCells.get(k) ?? []) if (!keptOnly || at < keptCount) found.add(at); });
    return [...found].sort((a, b) => a - b).filter((at) => {
      const b = ringBoxes[at]!;
      return b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1];
    });
  };
  const fitFree = (corners: Vec2[]): Vec2[] | null => {
    const box = rectAround(corners);
    if (!box) return null;
    const found = new Set<number>();
    cellsOf(box, (k) => { for (const at of ringCells.get(k) ?? []) found.add(at); });
    // In the order they were filed, as when every lot was read.
    const touching = [...found].sort((a, b) => a - b).filter((at) => {
      const b = ringBoxes[at]!;
      return b[0] < box[2] && b[2] > box[0] && b[1] < box[3] && b[3] > box[1];
    }).map((at) => rings[at]!);
    if (!touching.length) return corners;
    const whole = Math.abs(lotArea({ corners }));
    let best: Vec2[] | null = null, bestArea = 0;
    for (const poly of difference([[corners.map((p) => [p.x, p.y])]], touching.map((q) => [q.map((p) => [p.x, p.y])]))) {
      const ring = (poly[0] ?? []).map(([x, y]) => ({ x: x!, y: y! }));
      const a = Math.abs(lotArea({ corners: ring }));
      if (ring.length >= 3 && a > bestArea) { bestArea = a; best = ring; }
    }
    if (!best || bestArea < whole * 0.6) return bestArea > whole - m(0.5) * m(0.5) ? corners : null;
    if (bestArea > whole - m(0.3) * m(0.3)) return corners;
    return facingCorners(withFront(simplifyRing(best, m(0.01)), [corners[0]!, corners[1]!]));
  };

  // The land as rasters over the streets' reach: paved or not, then labelled into connected pieces
  const pad = LOT_DEPTH + m(20);
  /** Each piece kept as its count of cells, whether it reaches the raster's edge, and its bounds in cells */
  interface Piece { count: number; open: boolean; i0: number; i1: number; j0: number; j1: number }
  interface Land {
    readonly minX: number; readonly minY: number; readonly W: number; readonly H: number;
    readonly label: Int32Array;
    readonly pieces: Piece[];
  }
  const boxes = ribbons.map((r) => {
    const bb = r.full.bbox;
    return [bb.minX - pad, bb.minY - pad, bb.maxX + pad, bb.maxY + pad] as [number, number, number, number];
  });
  // Groups: boxes overlapping, joined (a union-find over the pairs).
  const parent = ribbons.map((_, i) => i);
  const root = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const boxCells = new Map<number, number[]>();
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]!;
    for (let cx = Math.floor(a[0] / GROUP_CELL); cx <= Math.floor(a[2] / GROUP_CELL); cx++) {
      for (let cy = Math.floor(a[1] / GROUP_CELL); cy <= Math.floor(a[3] / GROUP_CELL); cy++) {
        const k = (cx + 32768) * 65536 + (cy + 32768);
        const list = boxCells.get(k);
        if (!list) { boxCells.set(k, [i]); continue; }
        for (const j of list) {
          const b = boxes[j]!;
          if (root(i) !== root(j) && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]) parent[root(i)] = root(j);
        }
        list.push(i);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < ribbons.length; i++) {
    const r = root(i);
    const list = groups.get(r);
    if (list) list.push(i); else groups.set(r, [i]);
  }
  const landOf = new Map<number, Land>();
  const pieceIn = (land: Land, p: Vec2): number => {
    const i = Math.floor((p.x - land.minX) / RASTER), j = Math.floor((p.y - land.minY) / RASTER);
    return i < 0 || j < 0 || i >= land.W || j >= land.H ? -2 : land.label[j * land.W + i]!;
  };
  for (const members of groups.values()) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of members) {
      const b = boxes[i]!;
      minX = Math.min(minX, b[0]); minY = Math.min(minY, b[1]); maxX = Math.max(maxX, b[2]); maxY = Math.max(maxY, b[3]);
    }
    const W = Math.ceil((maxX - minX) / RASTER), H = Math.ceil((maxY - minY) / RASTER);
    // One array for the paving and the pieces (`Land.label`): LAND, NEAR, PAVED, then each land cell's piece.
    const label = new Int32Array(W * H).fill(LAND);
    // Only the cells within a street's box (grown by a lot's depth) can be paved: those are asked (NEAR), the rest is land.
    for (const k of members) {
      const b = boxes[k]!;
      const i0 = Math.max(0, Math.floor((b[0] - minX) / RASTER)), i1 = Math.min(W - 1, Math.floor((b[2] - minX) / RASTER));
      const j0 = Math.max(0, Math.floor((b[1] - minY) / RASTER)), j1 = Math.min(H - 1, Math.floor((b[3] - minY) / RASTER));
      for (let j = j0; j <= j1; j++) label.fill(NEAR, j * W + i0, j * W + i1 + 1);
    }
    // DO NOT go back to asking it for every cell: 7.7 s of a 2,560 m city's plan, growing with the town's area
    yield* markPaved(doc, net, { minX, minY, W, H, step: RASTER }, label);
    // The land labelled into 4-connected pieces, in the order of each piece's first cell (row by row), by spans
    const pieces: Piece[] = [];
    const seeds: number[] = [];
    for (let start = 0; start < W * H; start++) {
      if (label[start] !== LAND) continue;
      const id = pieces.length;
      const piece: Piece = { count: 0, open: false, i0: W, i1: -1, j0: H, j1: -1 };
      pieces.push(piece);
      seeds.push(start);
      while (seeds.length) {
        const c = seeds.pop()!;
        if (label[c] !== LAND) continue;
        const j = (c - (c % W)) / W, row = j * W;
        let l = c - row, r = l;
        while (l > 0 && label[row + l - 1] === LAND) l--;
        while (r < W - 1 && label[row + r + 1] === LAND) r++;
        label.fill(id, row + l, row + r + 1);
        piece.count += r - l + 1;
        if (l < piece.i0) piece.i0 = l;
        if (r > piece.i1) piece.i1 = r;
        if (j < piece.j0) piece.j0 = j;
        if (j > piece.j1) piece.j1 = j;
        for (const nj of [j - 1, j + 1]) {
          if (nj < 0 || nj >= H) continue;
          const nrow = nj * W;
          for (let i = l; i <= r; i++) {
            if (label[nrow + i] === LAND && (i === l || label[nrow + i - 1] !== LAND)) seeds.push(nrow + i);
          }
        }
      }
      piece.open = piece.i0 === 0 || piece.j0 === 0 || piece.i1 === W - 1 || piece.j1 === H - 1;
      if (id % 256 === 255) yield;
    }
    const land: Land = { minX, minY, W, H, label, pieces };
    for (const i of members) landOf.set(ribbons[i]!.id, land);
    const pieceAt = (p: Vec2): number => pieceIn(land, p);

    // --- closed blocks
    for (const [id, piece] of pieces.entries()) {
      if (piece.open || piece.count * RASTER * RASTER < MIN_LOT * MIN_LOT * 2) continue;
      yield;
      // The hull of the piece's cell centres is the hull of each row's first and last
      const pts: Vec2[] = [];
      for (let j = piece.j0; j <= piece.j1; j++) {
        const row = j * W;
        let first = -1, last = -1;
        for (let i = piece.i0; i <= piece.i1; i++) if (label[row + i] === id) { if (first < 0) first = i; last = i; }
        if (first < 0) continue;
        const y = minY + (j + 0.5) * RASTER;
        pts.push({ x: minX + (first + 0.5) * RASTER, y });
        if (last !== first) pts.push({ x: minX + (last + 0.5) * RASTER, y });
      }
      const box = orientedBox(hull(pts));
      const key = `b:${Math.round(stepsIn(box.c.x, 4))},${Math.round(stepsIn(box.c.y, 4))},${Math.round(stepsIn(box.L, 4))},${Math.round(stepsIn(box.D, 4))}`;
      // Grow the raster box by half a raster cell: its points are cell centres.
      const L = box.L + RASTER, D = box.D + RASTER;
      const at = (s: number, t: number): Vec2 => ({ x: box.c.x + box.u.x * s + box.v.x * t, y: box.c.y + box.u.y * s + box.v.y * t });
      keys.push(key);
      keyRects.push(rectAround([at(-L / 2, -D / 2), at(L / 2, -D / 2), at(L / 2, D / 2), at(-L / 2, D / 2)])!);
      if (known.has(key)) continue;
      const rows = D >= TWO_ROWS ? 2 : 1;
      const depth = D / rows;
      const columns = Math.max(1, Math.round(L / Math.max(MIN_LOT, Math.min(depth, LOT_FRONTAGE))));
      const width = L / columns;
      // The block's frame for a point: along its length (s) and across it (t).
      const frame = (q: Vec2): { s: number; t: number } => {
        const dx = q.x - box.c.x, dy = q.y - box.c.y;
        return { s: dx * box.u.x + dy * box.u.y, t: dx * box.v.x + dy * box.v.y };
      };
      /** A row's lots, as spans along the block: the row cut in equal columns, except where stored lots already stand in it */
      const rowSpans = (r: number): [number, number][] => {
        const t0 = -D / 2 + r * depth, t1 = t0 + depth;
        const taken: [number, number][] = [];
        // The kept lots over the block's box (a lot off it takes no span of it).
        const blockBox = grow(rectAround([at(-L / 2, -D / 2), at(L / 2, -D / 2), at(L / 2, D / 2), at(-L / 2, D / 2)])!, m(4));
        for (const at of filedIn(blockBox, true)) {
          const l = { corners: rings[at]! };
          const q = l.corners.map((p) => frame(p));
          const lt0 = Math.min(...q.map((p) => p.t)), lt1 = Math.max(...q.map((p) => p.t));
          if (Math.min(lt1, t1) - Math.max(lt0, t0) < depth * 0.25) continue;
          const ls0 = Math.min(...q.map((p) => p.s)), ls1 = Math.max(...q.map((p) => p.s));
          if (ls1 > -L / 2 && ls0 < L / 2) taken.push([ls0, ls1]);
        }
        return cutSpans(freeSpans(-L / 2, L / 2, taken, MIN_LOT), width);
      };
      for (let r = 0; r < rows; r++) for (const [s0, s1] of rowSpans(r)) {
        const t0 = -D / 2 + r * depth, t1 = t0 + depth;
        // The front faces the street: the row's outer long edge (one row: the side nearer a street).
        const towardMinus = rows === 2 ? r === 0 : nearerStreet(at, s0, s1, -D / 2, D / 2, paved);
        // Reaching past the street sides (the front, a single row's back, the block's two ends) by a little
        const reach = m(2.5), edge = 1e-6;
        const a0 = s0 <= -L / 2 + edge ? s0 - reach : s0, a1 = s1 >= L / 2 - edge ? s1 + reach : s1;
        const b0 = towardMinus || rows === 1 ? t0 - reach : t0, b1 = !towardMinus || rows === 1 ? t1 + reach : t1;
        const corners: [Vec2, Vec2, Vec2, Vec2] = towardMinus
          ? [at(a1, b0), at(a0, b0), at(a0, b1), at(a1, b1)]
          : [at(a0, b1), at(a1, b1), at(a1, b0), at(a0, b0)];
        // Most of it on this block's land, and cut back to it: a block that is no rectangle
        let inside = 0, total = 0;
        for (let a = 0.1; a < 1; a += 0.2) for (let b = 0.1; b < 1; b += 0.2) {
          total++;
          if (pieceAt(at(s0 + (s1 - s0) * a, t0 + (t1 - t0) * b)) === id) inside++;
        }
        if (inside / total < 0.5) continue;
        const land = landLot(net, corners);
        const fit = land && fitFree(land);
        if (fit) { add.push({ key, corners: fit }); file(fit); }
      }
    }
  }

  // --- open land along streets: a continuous strip each side, cut in equal lots
  const ids = [...doc.segments.keys()].sort((a, b) => a - b);
  // By a set: `ribbons.includes` for each street was streets².
  const planned = new Set(ribbons);
  for (const segId of ids) {
    const ribbon = net.ribbons.get(segId);
    if (!ribbon || !planned.has(ribbon)) continue;
    yield;
    const line = ribbon.full;
    const face = halfWidth(ribbon.road, Level.Sidewalk) + m(0.3);
    const length = line.length;
    for (const side of [1, -1] as const) {
      const point = (s: number, d: number): Vec2 => {
        const f = line.sampleAt(Math.max(0, Math.min(length, s)));
        return { x: f.p.x - f.t.y * side * d, y: f.p.y + f.t.x * side * d };
      };
      // Runs of street where the land just behind the footway is open land.
      const step = m(1);
      const runs: [number, number][] = [];
      let from = -1;
      const land = landOf.get(segId)!;
      for (let s = 0; s <= length; s += step) {
        const p = point(s, face + m(1.5)), q = point(s, face + LOT_DEPTH - m(1));
        // The raster's piece first: most of a town's streets are between closed blocks, and the paving is then not asked
        const ok = land.pieces[pieceIn(land, p)]?.open === true && !paved(p) && !paved(q);
        if (ok && from < 0) from = s;
        if ((!ok || s + step > length) && from >= 0) { runs.push([from, ok ? s : s - step]); from = -1; }
      }
      for (const [s0, s1] of runs) {
        const len = s1 - s0;
        if (len < MIN_LOT) continue;
        const mid = point((s0 + s1) / 2, face);
        const key = `s:${Math.round(stepsIn(mid.x, 4))},${Math.round(stepsIn(mid.y, 4))},${Math.round(stepsIn(len, 4))}`;
        keys.push(key);
        // The strip's land: its two edges sampled along it (a bent street bulges).
        const edge: Vec2[] = [];
        for (let k = 0, n = Math.max(1, Math.ceil(len / LOT_FRONTAGE)); k <= n; k++) {
          const s = s0 + (len * k) / n;
          edge.push(point(s, face - m(1)), point(s, face + LOT_DEPTH));
        }
        keyRects.push(rectAround(edge)!);
        if (known.has(key)) continue;
        // Cut in equal lots, round the lots already there: a corner lot of a cross street's strip, or a stored lot.
        const taken: [number, number][] = [];
        // The lots there (kept and added), by the strip's box: its two edges along the run, a lot's reach round them.
        const stripBox = grow(rectAround(edge)!, m(4));
        for (const at of filedIn(stripBox)) {
          const l = { corners: rings[at]! };
          let near = false, ls0 = Infinity, ls1 = -Infinity;
          for (const corner of l.corners) {
            const q = corner;
            const c = line.closestPoint(q);
            const f = line.sampleAt(c.s);
            // Across the street, on this side: positive on the side's left.
            const across = ((q.x - f.p.x) * -f.t.y + (q.y - f.p.y) * f.t.x) * side;
            if (across > face - m(1) && across < face + LOT_DEPTH + m(1)) near = true;
            ls0 = Math.min(ls0, c.s); ls1 = Math.max(ls1, c.s);
          }
          // Inside the strip: a corner in its band, and not a lot merely touching its far end.
          if (near && ls1 > s0 + m(0.5) && ls0 < s1 - m(0.5)) taken.push([ls0, ls1]);
        }
        for (const [a, b] of cutSpans(freeSpans(s0, s1, taken, MIN_LOT), LOT_FRONTAGE)) {
          // Facing the street: front-start, front-end along the street's direction on its left, against it on its right.
          const corners: [Vec2, Vec2, Vec2, Vec2] = side === 1
            ? [point(a, face - m(1)), point(b, face - m(1)), point(b, face + LOT_DEPTH), point(a, face + LOT_DEPTH)]
            : [point(b, face - m(1)), point(a, face - m(1)), point(a, face + LOT_DEPTH), point(b, face + LOT_DEPTH)];
          const c = lotCentre({ corners });
          if (paved(c)) continue;
          const land = landLot(net, corners);
          const fit = land && fitFree(land);
      if (fit) { add.push({ key, corners: fit }); file(fit); }
        }
      }
    }
  }
  // No snap afterwards: every lot is cut to the land, flush with its footways (a hair back, `LAND_CLEARANCE`)
  return { add, keys, drop, keyRects };
}

/** How far a planned lot stands back from the paving: a hair, so what grows on it is never on the footway */
const LAND_CLEARANCE = m(0.08);
/** Side of the grid the lots are filed in while a plan is made (`planLotsSteps`). */
const FIT_CELL = m(64);
/** Side of the grid the streets' boxes are grouped in (`planLotsSteps`). */
const GROUP_CELL = m(128);

/** A proposed lot (four corners, the front first) cut back to the land: the paving taken off */
function landLot(net: Network, corners: readonly Vec2[]): Vec2[] | null {
  const land = onLand(net, corners, false, LAND_CLEARANCE);
  if (!land) return null;
  if (Math.abs(lotArea({ corners: land })) < Math.abs(lotArea({ corners })) * 0.5) return null;
  // Land within a road's reach though off its paving
  if (touchesRoad(net, offsetRing(land, -m(0.016)))) return null;
  return facingCorners(withFront(simplifyRing(land, m(0.01)), [corners[0]!, corners[1]!]));
}

/** The parts of `from..to` not under any of `taken`, each at least `min` long. */
function freeSpans(from: number, to: number, taken: readonly (readonly [number, number])[], min: number): [number, number][] {
  const out: [number, number][] = [];
  let at = from;
  for (const [a, b] of [...taken].sort((p, q) => p[0] - q[0])) {
    if (a - at >= min) out.push([at, Math.min(a, to)]);
    at = Math.max(at, b);
    if (at >= to) break;
  }
  if (to - at >= min) out.push([at, to]);
  return out;
}

/** Each span cut into equal parts as near `target` long as a whole number of them allows. */
function cutSpans(spans: readonly (readonly [number, number])[], target: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of spans) {
    const n = Math.max(1, Math.round((b - a) / target));
    const w = (b - a) / n;
    for (let k = 0; k < n; k++) out.push([a + k * w, a + (k + 1) * w]);
  }
  return out;
}

/** Stores a plan: the covered lots removed, the new ones added, the land's keys kept. */
export function applyLots(doc: RoadDoc, plan: LotPlan): boolean {
  const store = doc.lotStore;
  if (!plan.add.length && !plan.drop.length && plan.keys.every((k) => store.hasKey(k))) return false;
  // DO NOT go back to filtering the list of every lot for the few dropped: it was the whole town per plan applied.
  store.apply({ remove: plan.drop, add: plan.add.map((c) => ({ corners: c.corners })) }, 'lots planned');
  // The land of each key new to the document, as `lotKeys`: DO NOT write it as a change of the lots
  store.addKeys(plan.keys, plan.keyRects, 'land cut into lots');
  return true;
}

// ------------------------------------------------------------------ editing

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const near = (p: Vec2, q: Vec2, d = m(1.2)): boolean => Math.hypot(p.x - q.x, p.y - q.y) < d;

/** The part of a polygon on the left of the line a -> b (Sutherland-Hodgman against one half-plane). */
function clipLeft(q: readonly Vec2[], a: Vec2, b: Vec2): Vec2[] {
  const side = (p: Vec2): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const out: Vec2[] = [];
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!, r = q[(i + 1) % q.length]!;
    const sp = side(p), sr = side(r);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sr >= 0)) { const t = sp / (sp - sr); out.push(lerp(p, r, t)); }
  }
  // Points the cut put on top of each other merged.
  return out.filter((p, i) => !near(p, out[(i + 1) % out.length]!, 1e-6));
}

/** A piece of a cut lot with its front set: the side lying along the old front, or else the side nearest it */
function withFront(piece: readonly Vec2[], front: readonly [Vec2, Vec2]): Vec2[] {
  const [fa, fb] = front;
  const len = Math.hypot(fb.x - fa.x, fb.y - fa.y) || 1;
  const off = (p: Vec2): number => Math.abs((fb.x - fa.x) * (p.y - fa.y) - (fb.y - fa.y) * (p.x - fa.x)) / len;
  let best = 0, bestScore = Infinity;
  for (let i = 0; i < piece.length; i++) {
    const p = piece[i]!, r = piece[(i + 1) % piece.length]!;
    const l = Math.hypot(r.x - p.x, r.y - p.y);
    if (l < m(1)) continue;
    // Along the front direction (parallel) and near the front line.
    const parallel = Math.abs(((r.x - p.x) * (fb.x - fa.x) + (r.y - p.y) * (fb.y - fa.y)) / (l * len));
    const score = off(lerp(p, r, 0.5)) + (1 - parallel) * m(40);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return [...piece.slice(best), ...piece.slice(0, best)];
}

export type LotCut =
  /** Across the front, into `parts` lots side by side, each on the street. */
  | { readonly kind: 'vertical'; readonly parts: number }
  /** Parallel to the front, into `parts` lots one behind the other. */
  | { readonly kind: 'horizontal'; readonly parts: number }
  /** Along a line the player drew, from `a` to `b`, into two. */
  | { readonly kind: 'line'; readonly a: Vec2; readonly b: Vec2 };

/** The cut lines of a cut on a lot, each as two points: the preview the tool draws. */
export function cutLines(l: Pick<Lot, 'corners'>, cut: LotCut): [Vec2, Vec2][] {
  if (cut.kind === 'line') return [[cut.a, cut.b]];
  const a = l.corners[0]!, b = l.corners[1]!;
  const w = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const u = { x: (b.x - a.x) / w, y: (b.y - a.y) / w }, n = { x: -u.y, y: u.x };
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (const q of l.corners) {
    const s = (q.x - a.x) * u.x + (q.y - a.y) * u.y, t = (q.x - a.x) * n.x + (q.y - a.y) * n.y;
    s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
  }
  const P = (s: number, t: number): Vec2 => ({ x: a.x + u.x * s + n.x * t, y: a.y + u.y * s + n.y * t });
  const lines: [Vec2, Vec2][] = [];
  for (let k = 1; k < cut.parts; k++) {
    if (cut.kind === 'vertical') {
      // Equal widths along the front itself (the front may be shorter than the lot).
      const s = k / cut.parts * w;
      lines.push([P(s, t1 + m(1)), P(s, t0 - m(1))]);
    } else {
      const t = t0 + (t1 - t0) * k / cut.parts;
      lines.push([P(s0 - m(1), t), P(s1 + m(1), t)]);
    }
  }
  return lines;
}

/** Cuts a lot by `cut`; false when nothing worth a lot is left on both sides. */
export function splitLot(doc: RoadDoc, id: number, cut: LotCut): boolean {
  const lot = doc.lot(id);
  if (!lot) return false;
  const front: [Vec2, Vec2] = [lot.corners[0]!, lot.corners[1]!];
  let pieces: Vec2[][] = [[...lot.corners]];
  for (const [a, b] of cutLines(lot, cut)) {
    const next: Vec2[][] = [];
    for (const piece of pieces) {
      const left = clipLeft(piece, a, b), right = clipLeft(piece, b, a);
      for (const half of [left, right]) if (half.length >= 3 && Math.abs(lotArea({ corners: half })) > MIN_LOT * MIN_LOT / 4) next.push(half);
    }
    pieces = next;
  }
  if (pieces.length < 2) return false;
  // The pieces are new lots, last in the order (`LotStore` ORDER).
  const made = pieces.map((piece) => ({ corners: facingCorners(withFront(piece, front)), ...(lot.use ? { use: lot.use, density: lot.density ?? 'low' as const } : {}) }));
  doc.lotStore.apply({ remove: [id], add: made }, 'lot split');
  return true;
}

/** Joins two lots that share a side into one: the two boundaries walked round, the shared stretch left out. */
export function joinLots(doc: RoadDoc, idA: number, idB: number): boolean {
  const lotA = doc.lot(idA), lotB = doc.lot(idB);
  if (!lotA || !lotB || idA === idB) return false;
  const A = lotA.corners, B = lotB.corners;
  const onB = A.map((p) => B.findIndex((q) => near(p, q)));
  // A side of A whose two corners are both corners of B.
  let start = -1;
  for (let i = 0; i < A.length; i++) if (onB[i]! >= 0 && onB[(i + 1) % A.length]! >= 0) { start = i; break; }
  if (start < 0) return false;
  // Walk A from just after the shared run, round to its start; then B the same way.
  let i0 = start;
  while (onB[(i0 - 1 + A.length) % A.length]! >= 0 && (i0 - 1 + A.length) % A.length !== start) i0 = (i0 - 1 + A.length) % A.length;
  let i1 = (start + 1) % A.length;
  while (onB[(i1 + 1) % A.length]! >= 0 && (i1 + 1) % A.length !== i0) i1 = (i1 + 1) % A.length;
  const ring: Vec2[] = [];
  for (let k = i1; ; k = (k + 1) % A.length) { ring.push(A[k]!); if (k === i0) break; }
  const j0 = onB[i0]!, j1 = onB[i1]!;
  for (let k = (j0 + 1) % B.length; k !== j1; k = (k + 1) % B.length) ring.push(B[k]!);
  if (ring.length < 3) return false;
  // The front stays the first lot's: the ring started at the end of the shared run
  const fa = lotA.corners[0]!, fb = lotA.corners[1]!;
  let f = ring.findIndex((p, k) => near(p, fa) && near(ring[(k + 1) % ring.length]!, fb));
  if (f < 0) f = ring.findIndex((p) => near(p, fa));
  const ordered = f > 0 ? [...ring.slice(f), ...ring.slice(0, f)] : ring;
  // A new lot, last in the order (`LotStore` ORDER).
  doc.lotStore.apply({ remove: [idA, idB], add: [{ corners: facingCorners(ordered), ...(lotA.use ? { use: lotA.use, density: lotA.density ?? 'low' } : {}) }] }, 'lots joined');
  return true;
}

export function deleteLot(doc: RoadDoc, id: number): boolean {
  if (!doc.lotStore.has(id)) return false;
  doc.lotStore.apply({ remove: [id] }, 'lot deleted');
  return true;
}

/** The rectangle from `a` to `b` square to `angle` (a street's direction), counter-clockwise; null when too small. */
export function lotRect(a: Vec2, b: Vec2, angle: number): Vec2[] | null {
  const u = { x: Math.cos(angle), y: Math.sin(angle) }, v = { x: -u.y, y: u.x };
  const ds = (b.x - a.x) * u.x + (b.y - a.y) * u.y, dt = (b.x - a.x) * v.x + (b.y - a.y) * v.y;
  if (Math.abs(ds) < MIN_LOT / 2 || Math.abs(dt) < MIN_LOT / 2) return null;
  const p = (s: number, t: number): Vec2 => ({ x: a.x + u.x * s + v.x * t, y: a.y + u.y * s + v.y * t });
  const s0 = Math.min(0, ds), s1 = Math.max(0, ds), t0 = Math.min(0, dt), t1 = Math.max(0, dt);
  return [p(s0, t0), p(s1, t0), p(s1, t1), p(s0, t1)];
}

/** DO NOT go back to the union of the whole map's footways, made again at each network revision */
function pavingNear(net: Network, box: ChangeRect, grow = 0): MultiPoly | null {
  const ribbons = net.ribbonsMeeting(box);
  const junctions: [NodeId, ReadonlyMap<SurfaceLevel, Junction>][] = [];
  for (const id of net.junctionCells.idsMeeting(box)) {
    const byLevel = net.junctions.get(id);
    if (byLevel) junctions.push([id, byLevel]);
  }
  if (!ribbons.length && !junctions.length) return null;
  const paving = union(levelRingsOf(net, Level.Sidewalk, ribbons, junctions));
  if (grow === 0) return paving;
  return paving.map((raw) => raw.map((ring, k) => {
    const pts = ring.map(([x, y]) => ({ x: x!, y: y! }));
    // Grown all round: outer counter-clockwise, holes (the blocks) clockwise, so the right-hand offset grows the paving.
    const oriented = (k === 0) === (lotArea({ corners: pts }) > 0) ? pts : [...pts].reverse();
    return offsetRing(oriented, grow).map((p) => [p.x, p.y]);
  }));
}

/** Room round a lot's box the paving is read over: past the clearance, so the cut inside the box is the whole map's. */
const PAVING_MARGIN = m(2);

/** A lot drawn over the street, cut back to the land: what falls on the paving is taken off, so the lot */
export function onLand(net: Network, points: readonly Vec2[], square = true, clearance = 0): Vec2[] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  // The paving round the lot's box alone (`pavingNear`).
  const margin = Math.abs(clearance) + PAVING_MARGIN;
  // A map with no street keeps the lot as drawn; one with streets, none near it, cuts it against nothing
  const near = net.ribbons.size ? pavingNear(net, [x0 - margin, y0 - margin, x1 + margin, y1 + margin], clearance) ?? [] : null;
  if (!near) return [...points];
  let best: Vec2[] | null = null, bestArea = 0;
  for (const poly of difference([[points.map((p) => [p.x, p.y])]], near)) {
    const ring = (poly[0] ?? []).map(([x, y]) => ({ x: x!, y: y! }));
    const area = Math.abs(lotArea({ corners: ring }));
    if (ring.length >= 3 && area > bestArea) { bestArea = area; best = ring; }
  }
  if (!best || bestArea < MIN_LOT * MIN_LOT / 2) return null;
  return square ? squareCorners(best) : best;
}

/** A lot cut back to the footways, its corners made square */
function squareCorners(ring: Vec2[]): Vec2[] {
  const n = ring.length;
  const longSides: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!;
    if (Math.hypot(q.x - p.x, q.y - p.y) >= STRAIGHT_BACK) longSides.push(i);
  }
  if (longSides.length < 2) return ring;
  // The corners between each long side and the next: their shared point, or - with a curve's short sides between them
  const out: Vec2[] = [];
  for (let k = 0; k < longSides.length; k++) {
    const i = longSides[k]!, j = longSides[(k + 1) % longSides.length]!;
    const a = ring[i]!, b = ring[(i + 1) % n]!, c = ring[j]!, d = ring[(j + 1) % n]!;
    if ((i + 1) % n === j) { out.push(b); continue; }
    const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y;
    const den = ux * vy - uy * vx;
    const t = Math.abs(den) > 0.3 * Math.hypot(ux, uy) * Math.hypot(vx, vy) ? ((c.x - a.x) * vy - (c.y - a.y) * vx) / den : NaN;
    const x = { x: a.x + ux * t, y: a.y + uy * t };
    if (Number.isFinite(t) && Math.hypot(x.x - b.x, x.y - b.y) < m(8)) out.push(x);
    // Not a corner of two streets: the short sides kept as they are.
    else for (let r = (i + 1) % n; r !== (j + 1) % n; r = (r + 1) % n) out.push(ring[r]!);
  }
  return out.length >= 3 ? out : ring;
}

/** A new lot of any shape: the corners the player clicked, in order. */
export function addPolygonLot(doc: RoadDoc, points: readonly Vec2[], front: number): Lot | null {
  if (points.length < 3 || Math.abs(lotArea({ corners: points })) < MIN_LOT * MIN_LOT / 2) return null;
  const ring = [...points.slice(front), ...points.slice(0, front)];
  const corners = facingCorners(ring);
  // The lots there only (their boxes within the overlap test's margin), never every lot of the city.
  const box = rectAround(corners)!;
  if (doc.lotsIn(grow(box, m(0.5))).some((l) => quadsOverlap(corners, l.corners, m(0.5)) && overlapDeep(corners, l.corners))) return null;
  return doc.lotStore.apply({ add: [{ corners }] }, 'lot drawn')[0]!;
}

/** Makes one side of a lot its front - the side on the street, which the building grown there faces */
export function setLotFront(doc: RoadDoc, id: number, side: number): boolean {
  const lot = doc.lot(id);
  if (!lot) return false;
  const n = lot.corners.length;
  const k = ((side % n) + n) % n;
  if (k === 0) return false;
  if (lot.building !== undefined) doc.buildings.remove(lot.building as Parameters<typeof doc.buildings.remove>[0]);
  const { building: _gone, ...rest } = lot;
  doc.lotStore.apply({ put: [{ ...rest, corners: [...lot.corners.slice(k), ...lot.corners.slice(0, k)] }] }, 'lot front');
  return true;
}

/** Whether a corner or the middle of one polygon is well inside the other (the separating-axis test is only for convex shapes). */
function overlapDeep(p: readonly Vec2[], q: readonly Vec2[]): boolean {
  const inner = (a: readonly Vec2[], b: readonly Vec2[]): boolean => {
    const c = lotCentre({ corners: a });
    return [c, ...a.map((x) => lerp(x, c, 0.2))].some((x) => insideLot(x, { corners: b }));
  };
  return inner(p, q) || inner(q, p);
}

/** Moves a lot corner to `to`, and every other lot's corner standing on the same point with it */
export function moveLotCorner(doc: RoadDoc, from: Vec2, to: Vec2): boolean {
  const reach = m(0.8);
  const put: Lot[] = [];
  // The lots with a corner on the point: those whose box reaches it, never every lot of the city.
  for (const l of doc.lotsIn([from.x - reach, from.y - reach, from.x + reach, from.y + reach])) {
    let changed = false;
    const corners = l.corners.map((q) => {
      if (near(q, from, reach)) { changed = true; return { x: to.x, y: to.y }; }
      return q;
    });
    if (changed) put.push({ ...l, corners });
  }
  if (put.length) doc.lotStore.apply({ put }, 'lot corner moved');
  return put.length > 0;
}

/** Bends the side of a lot from corner `a` to corner `b` through `through`: a curve */
export function curveLotSide(doc: RoadDoc, a: Vec2, b: Vec2, through: Vec2): boolean {
  const control = { x: 2 * through.x - (a.x + b.x) / 2, y: 2 * through.y - (a.y + b.y) / 2 };
  const curve = (from: Vec2, to: Vec2): Vec2[] => {
    const out: Vec2[] = [];
    for (let k = 1; k < 12; k++) {
      const t = k / 12, s = 1 - t;
      out.push({ x: s * s * from.x + 2 * s * t * control.x + t * t * to.x, y: s * s * from.y + 2 * s * t * control.y + t * t * to.y });
    }
    return out;
  };
  const put: Lot[] = [];
  // The lots with a corner by `a` (each side bent has one): those whose box reaches it, never every lot.
  const reach = m(1.2);
  for (const l of doc.lotsIn([a.x - reach, a.y - reach, a.x + reach, a.y + reach])) {
    const q = l.corners;
    for (let k = 0; k < q.length; k++) {
      const p = q[k]!, r = q[(k + 1) % q.length]!;
      let inner: Vec2[] | null = null;
      if (near(p, a) && near(r, b)) inner = curve(a, b);
      else if (near(p, b) && near(r, a)) inner = curve(a, b).reverse();
      if (!inner) continue;
      put.push({ ...l, corners: [...q.slice(0, k + 1), ...inner, ...q.slice(k + 1)] });
      break;
    }
  }
  // The curve lies within the triangle of its ends and its control point, and can bulge past `through` along the side
  if (put.length) doc.lotStore.apply({ put, also: [rectAround([a, b, through, control])!] }, 'lot side curved');
  return put.length > 0;
}

/** Zones lots (or clears them, `zone` null). */
export function zoneLots(doc: RoadDoc, ids: readonly number[], zone: { use: ZoneUse; density: ZoneDensity } | null): boolean {
  const store = doc.lotStore;
  // DO NOT walk every lot of the city for a stroke.
  const lots = [...new Set(ids)].map((id) => store.get(id)).filter((l): l is Lot => l !== undefined)
    .sort((p, q) => store.orderOf(p.id)! - store.orderOf(q.id)!);
  const put: Lot[] = [];
  for (const l of lots) {
    if (zone ? l.use === zone.use && l.density === zone.density : !l.use) continue;
    const { use: _u, density: _d, building, ...rest } = l;
    if (zone) put.push({ ...rest, use: zone.use, density: zone.density, ...(building !== undefined ? { building } : {}) });
    else {
      // Taking the zone off takes what grew on it (the player, 2026-10-09): the land goes back to unzoned, empty.
      if (building !== undefined && doc.buildings.has(building as BuildingId)) doc.buildings.remove(building as BuildingId);
      put.push(rest);
    }
  }
  if (put.length) store.apply({ put }, zone ? 'lots zoned' : 'zone taken off the lots');
  return put.length > 0;
}

export function isLot(raw: unknown): raw is Lot {
  const v = raw as Partial<Lot> | null;
  return !!v && Number.isInteger(v.id) && Array.isArray(v.corners) && v.corners.length >= 3 &&
    v.corners.every((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y));
}

// ------------------------------------------------------------------ geometry

/** For a one-row block: whether the street is nearer its -v side than its +v side, at this column. */
function nearerStreet(at: (s: number, t: number) => Vec2, s0: number, s1: number, tMinus: number, tPlus: number,
  paved: (p: Vec2) => boolean): boolean {
  const s = (s0 + s1) / 2;
  for (let d = 0; d < m(12); d += m(1)) {
    const minus = paved(at(s, tMinus - d)), plus = paved(at(s, tPlus + d));
    if (minus !== plus) return minus;
  }
  return true;
}

/** An outline edge at least this long is a straight back of a footway; shorter ones are a corner's curve. */
const STRAIGHT_BACK = m(2);

/** The outline of the paving a building may stand against round a box: the union of the footways (`pavingNear`) */
function footwayEdgesNear(net: Network, box: ChangeRect): number[] {
  const edges: number[] = [];
  for (const poly of pavingNear(net, box) ?? []) for (const ring of poly) {
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k]!, q = ring[(k + 1) % ring.length]!;
      edges.push(p[0]!, p[1]!, q[0]!, q[1]!);
    }
  }
  return edges;
}

/** The lot snap: a point near a street is put on the outer edge of its footway as drawn */
export function lotSnapper(doc: RoadDoc, net: Network, lots?: readonly Pick<Lot, 'id' | 'corners'>[], apart?: Vec2): (p: Vec2, reach: number, skip?: number) => { p: Vec2; kind: 'corner' | 'street' | 'lot' | null } {
  return (p, reach, skip) => {
    let lotBest: Vec2 | null = null, lotD = reach * 0.7;
    const r = lotD;
    for (const l of lots ?? doc.lotsIn([p.x - r, p.y - r, p.x + r, p.y + r])) {
      if (l.id === skip) continue;
      for (const q of l.corners) {
        if (apart && Math.hypot(q.x - apart.x, q.y - apart.y) <= m(0.8)) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < lotD) { lotD = d; lotBest = q; }
      }
    }
    if (lotBest) return { p: { x: lotBest.x, y: lotBest.y }, kind: 'lot' };
    let best: Vec2 | null = null, bestD = reach;
    // The straight backs of the footways near the point (their curves round the corners left out)
    const backs: { d: number; x0: number; y0: number; dx: number; dy: number }[] = [];
    const span = reach * 1.5;
    // The outline round the point, read over the reach and a straight back's length more
    const around = span + STRAIGHT_BACK + PAVING_MARGIN;
    const edges = footwayEdgesNear(net, [p.x - around, p.y - around, p.x + around, p.y + around]);
    for (let e = 0; e < edges.length / 4; e++) {
      const x0 = edges[e * 4]!, y0 = edges[e * 4 + 1]!, x1 = edges[e * 4 + 2]!, y1 = edges[e * 4 + 3]!;
      const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - x0) * dx + (p.y - y0) * dy) / len2)) : 0;
      const qx = x0 + dx * t, qy = y0 + dy * t, d = Math.hypot(qx - p.x, qy - p.y);
      if (d < bestD) { bestD = d; best = { x: qx, y: qy }; }
      if (len2 >= STRAIGHT_BACK * STRAIGHT_BACK && d < span) backs.push({ d, x0, y0, dx, dy });
    }
    backs.sort((u, v) => u.d - v.d);
    let corner: Vec2 | null = null;
    const first = backs[0];
    if (first) {
      for (const other of backs) {
        const den = first.dx * other.dy - first.dy * other.dx;
        // Square enough to be two streets, not one back cut in two.
        if (Math.abs(den) < 0.3 * Math.hypot(first.dx, first.dy) * Math.hypot(other.dx, other.dy)) continue;
        const k = ((other.x0 - first.x0) * other.dy - (other.y0 - first.y0) * other.dx) / den;
        const x = { x: first.x0 + first.dx * k, y: first.y0 + first.dy * k };
        if (Math.hypot(x.x - p.x, x.y - p.y) < span) corner = x;
        break;
      }
    }
    if (corner) return { p: corner, kind: 'corner' };
    if (best) return { p: best, kind: 'street' };
    return { p, kind: null };
  };
}

