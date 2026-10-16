// The lots as planned before 2026-10-15 (src/world/lots.ts at 8434df1), cell by cell, on the world's raster with the block bound of 2026-10-16
import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { carriesPedestrians } from '@world/pedestrianAccess';
import { Level, type SurfaceLevel, halfWidth } from '@world/roadTypes';
import type { NodeId } from '@world/ids';
import type { Junction } from '@world/junction/build';
import { type MultiPoly, difference, union } from '@core/clipper';
import { levelRingsOf } from '@world/surfaces';
import { hull, lotCentre, orientedBox, simplifyRing } from '@world/lotRings';
import { offsetRing } from '@world/buildings/footprints';
import { touchesRoad } from '@world/buildings/validate';
import { m, stepsIn } from '@world/units';
import { pavedTester } from '@world/zoneGrid';
import type { ZoneDensity, ZoneUse } from '@world/zones';
import { rectAround, type ChangeRect } from '@world/changes';
import { grow } from '@world/cells';

/** Lots: the land cut into plots the player zones and buildings grow on, as a town's cadastre is. - A closed block */

interface Lot {
  readonly id: number;
  /** The boundary, counter-clockwise (the inside on the left of each side): any polygon */
  readonly corners: readonly Vec2[];
  readonly use?: ZoneUse;
  readonly density?: ZoneDensity;
  /** The building that grew on it, while it stands. */
  readonly building?: number;
}

/** Depth of a lot along an open street. */
const LOT_DEPTH = m(32);
/** The frontage a lot aims at: a block's rows and a street's strip are cut into equal lots of about this width */
const LOT_FRONTAGE = m(22);
/** A block deeper than this is cut in two rows, back to back. */
const TWO_ROWS = m(44);
const MIN_LOT = m(10);
const RASTER = m(2);
/** Land wider or deeper than this is open land, never a block. */
const MAX_BLOCK = m(1024);
/** An outline edge at least this long is a straight back of a footway; shorter ones are a corner's curve. */
const STRAIGHT_BACK = m(2);

;

function lotArea(l: Pick<Lot, 'corners'>): number {
  let a = 0;
  const q = l.corners;
  for (let i = 0; i < q.length; i++) { const p = q[i]!, r = q[(i + 1) % q.length]!; a += p.x * r.y - r.x * p.y; }
  return a / 2;
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
function* planLotsSteps(doc: RoadDoc, net: Network): Generator<void, LotPlan> {
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
  interface Land {
    readonly minX: number; readonly minY: number; readonly W: number; readonly H: number;
    readonly label: Int32Array;
    readonly pieces: { cells: number[]; open: boolean }[];
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
    // The raster laid on the world's: its cells where any plan puts them, whatever the streets' extent (2026-10-16)
    minX = Math.floor(minX / RASTER) * RASTER;
    minY = Math.floor(minY / RASTER) * RASTER;
    const W = Math.ceil((maxX - minX) / RASTER), H = Math.ceil((maxY - minY) / RASTER);
    const label = new Int32Array(W * H).fill(-1);
    const isPaved = new Uint8Array(W * H);
    // Only the cells within a street's box (grown by a lot's depth) can be paved: those are tested, the rest is land.
    const near = new Uint8Array(W * H);
    for (const b of boxes) {
      const i0 = Math.max(0, Math.floor((b[0] - minX) / RASTER)), i1 = Math.min(W - 1, Math.floor((b[2] - minX) / RASTER));
      const j0 = Math.max(0, Math.floor((b[1] - minY) / RASTER)), j1 = Math.min(H - 1, Math.floor((b[3] - minY) / RASTER));
      for (let j = j0; j <= j1; j++) near.fill(1, j * W + i0, j * W + i1 + 1);
    }
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        if (near[j * W + i] && paved({ x: minX + (i + 0.5) * RASTER, y: minY + (j + 0.5) * RASTER })) isPaved[j * W + i] = 1;
      }
      yield;
    }
    const pieces: { cells: number[]; open: boolean }[] = [];
    const stack: number[] = [];
    for (let start = 0; start < W * H; start++) {
      if (isPaved[start] || label[start]! >= 0) continue;
      const id = pieces.length;
      const piece = { cells: [] as number[], open: false };
      pieces.push(piece);
      label[start] = id;
      stack.push(start);
      while (stack.length) {
        const c = stack.pop()!;
        piece.cells.push(c);
        const i = c % W, j = (c - i) / W;
        if (i === 0 || j === 0 || i === W - 1 || j === H - 1) piece.open = true;
        for (const n of [i > 0 ? c - 1 : -1, i < W - 1 ? c + 1 : -1, j > 0 ? c - W : -1, j < H - 1 ? c + W : -1]) {
          if (n < 0 || isPaved[n] || label[n]! >= 0) continue;
          label[n] = id;
          stack.push(n);
        }
      }
      // Land wider or deeper than a block may be is open land (2026-10-16)
      let i0 = W, i1 = -1, j0 = H, j1 = -1;
      for (const c of piece.cells) {
        const i = c % W, j = (c - i) / W;
        i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      }
      if ((i1 - i0 + 1) * RASTER > MAX_BLOCK || (j1 - j0 + 1) * RASTER > MAX_BLOCK) piece.open = true;
    }
    const land: Land = { minX, minY, W, H, label, pieces };
    for (const i of members) landOf.set(ribbons[i]!.id, land);
    const pieceAt = (p: Vec2): number => pieceIn(land, p);

    // --- closed blocks
    for (const [id, piece] of pieces.entries()) {
      if (piece.open || piece.cells.length * RASTER * RASTER < MIN_LOT * MIN_LOT * 2) continue;
      yield;
      const pts = piece.cells.map((c) => ({ x: minX + ((c % W) + 0.5) * RASTER, y: minY + (Math.floor(c / W) + 0.5) * RASTER }));
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
        const ok = !paved(p) && !paved(q) && land.pieces[pieceIn(land, p)]?.open === true;
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

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

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
function onLand(net: Network, points: readonly Vec2[], square = true, clearance = 0): Vec2[] | null {
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
