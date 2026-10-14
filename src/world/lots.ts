import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { Level, halfWidth } from './roadTypes';
import { difference } from '@core/clipper';
import { levelPolygons } from './surfaces';
import { PavingIndex } from './pavingIndex';
import { hull, lotCentre, orientedBox, simplifyRing } from './lotRings';
import { offsetRing } from './buildings/footprints';
import { touchesRoad } from './buildings/validate';
import { m, stepsIn } from './units';
import { pavedTester, quadsOverlap } from './zoneGrid';
import type { ZoneDensity, ZoneUse } from './zones';
import { rectAround, type ChangeRect } from './changes';
import type { BuildingId } from './buildings/types';

/**
 * Where these lots lie, for the diary (`RoadDoc.lotsChanged`): only that
 * region is marked as changed (Unity `TerrainData.DirtyHeightmapRegion`
 * does the same for a heightmap), the whole map when there is none.
 */
function lotRects(lots: readonly { readonly corners: readonly Vec2[] }[]): readonly ChangeRect[] | null {
  const rects = lots.map((l) => rectAround(l.corners)).filter((r): r is ChangeRect => r !== null);
  return rects.length ? rects : null;
}

/**
 * Lots: the land cut into plots the player zones and buildings grow on, as a
 * town's cadastre is.
 *
 * - A closed block (land with streets all round) is cut into equal lots: its
 *   oriented rectangle in one or two rows - each row facing its own street -
 *   and in equal columns, each lot as near square as the block allows (a
 *   block 80 x 60 m is six lots of about 27 x 30 m). This is the "recursive"
 *   subdivision of CityEngine with no irregularity (equal parts) and street
 *   access forced (two rows at most).
 * - Along a street with open land beside it, a continuous strip as deep as a
 *   lot, from the back of the footway, cut into equal lots too: CityEngine's
 *   offset subdivision.
 *
 * Lots are STORED in the document (`RoadDoc.lots`): the player moves their
 * corners, splits, joins, deletes and adds them. Land is subdivided only once:
 * each block or strip leaves a key (`RoadDoc.lotKeys`) so a lot deleted on
 * purpose is not made again; a road moved or added makes new land (a new key),
 * and lots the paving now covers are removed.
 */

export interface Lot {
  readonly id: number;
  /**
   * The boundary, counter-clockwise (the inside on the left of each side):
   * any polygon - four corners as generated, more where the player drew one,
   * many along a curved side. The first side (corners 0 -> 1) is the front,
   * on the street.
   */
  readonly corners: readonly Vec2[];
  readonly use?: ZoneUse;
  readonly density?: ZoneDensity;
  /** The building that grew on it, while it stands. */
  readonly building?: number;
}

/** Depth of a lot along an open street. */
const LOT_DEPTH = m(32);
/**
 * The frontage a lot aims at: a block's rows and a street's strip are cut
 * into equal lots of about this width (the player, 2026-10-05: square lots of
 * 26-30 m were too big; 2026-10-06: 15 m too small).
 */
const LOT_FRONTAGE = m(22);
/** A block deeper than this is cut in two rows, back to back. */
const TWO_ROWS = m(44);
const MIN_LOT = m(10);
const RASTER = m(2);

export { lotCentre } from './lotRings';

export function lotArea(l: Pick<Lot, 'corners'>): number {
  let a = 0;
  const q = l.corners;
  for (let i = 0; i < q.length; i++) { const p = q[i]!, r = q[(i + 1) % q.length]!; a += p.x * r.y - r.x * p.y; }
  return a / 2;
}

export function insideLot(point: Vec2, l: Pick<Lot, 'corners'>): boolean {
  let inside = false;
  const q = l.corners;
  if (!q.length) return false;
  const p = point;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i]!, b = q[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** The lot's frame for a building: front middle, facing angle (along the front), width and depth. */
export function lotFrame(l: Pick<Lot, 'corners'>): { anchor: Vec2; rotation: number; width: number; depth: number } {
  const a = l.corners[0]!, b = l.corners[1]!;
  const width = Math.hypot(b.x - a.x, b.y - a.y);
  const u = { x: (b.x - a.x) / (width || 1), y: (b.y - a.y) / (width || 1) }, n = { x: -u.y, y: u.x };
  // Depth: how far the lot goes back from its front, at the quarter points
  // of the front and its middle - the least of them, so a building made for
  // it fits a lot narrowing at the back.
  let depth = Infinity;
  for (const t of [0.25, 0.5, 0.75]) {
    const o = { x: a.x + (b.x - a.x) * t + n.x * 1e-3, y: a.y + (b.y - a.y) * t + n.y * 1e-3 };
    depth = Math.min(depth, rayExit(l.corners, o, n));
  }
  return { anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, rotation: Math.atan2(u.y, u.x), width, depth: Number.isFinite(depth) ? depth : 0 };
}

/**
 * Where a building can stand on a lot: the largest rectangle square to the
 * lot's front that lies wholly inside it, as near the street as it can be
 * (a setback costs it area). On a lot cut back to a bent street or round a
 * corner's curve, the front-edge frame (`lotFrame`) ran over the lot's own
 * boundary - onto the footway or the neighbour - and the building was
 * refused there; the player found a sixth of the zoned lots bare.
 * Scanlines across the depth, the chord of each, every front and back pair.
 */
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

/**
 * The corners in the order a building reads its lot: front-start to front-end
 * with the back on the LEFT of that direction (as the street grid's cells
 * have it, `ZoneCell.rotation`) - so a building made for the lot faces the
 * street. Given the other way round, the building stood back to front, its
 * yard over the footway, and was refused.
 */
function facingCorners<T extends readonly Vec2[]>(c: T): Vec2[] {
  // Counter-clockwise keeps the inside on the left of every side; reversed,
  // the front side keeps its two corners, swapped.
  if (lotArea({ corners: c }) >= 0) return [...c];
  return [c[1]!, c[0]!, ...[...c.slice(2)].reverse()];
}

/**
 * New lots for land with none yet, and the lots the paving now covers. Pure:
 * the caller stores the result (`applyLots`).
 */
export interface LotPlan {
  add: Candidate[];
  keys: string[];
  drop: number[];
  /**
   * Where the land of each key lies (`keys[i]`'s at `keyRects[i]`): a key new
   * to the document is written in the diary there (`applyLots`). Absent (a
   * plan made by hand): a key with no place is the whole map.
   */
  keyRects?: ChangeRect[];
}

export function planLots(doc: RoadDoc, net: Network): LotPlan {
  const steps = planLotsSteps(doc, net);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * `planLots` a little at a time: it yields between rows of the raster, blocks
 * and streets, and returns the plan. Replanning a town's lots in one go was a
 * quarter-second frame after every road edit; the game runs this a few
 * milliseconds a frame (`main.ts`, as `zoneGridSteps`) and applies the plan
 * only if nothing it read has changed meanwhile.
 */
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
  /**
   * A new lot made to fit round the lots already there: what of it lies on
   * one is cut away (a boolean difference - the separating-axis test was only
   * right for convex lots, and two lots cut to a bent street overlapped), and
   * it is kept if most of it is left. Null otherwise.
   */
  // The lots there (kept, then added) filed by the cells their boxes cover:
  // each new lot read every lot of the town - 12.5 s of a 2 560 m town's growing.
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

  // The land as rasters over the streets' reach: paved or not, then labelled
  // into connected pieces; those that do not reach the raster's edge are
  // closed blocks. One raster a GROUP of streets lying near one another: one
  // raster round towns far apart spanned the empty land between them - some
  // 23 million cells tested, a zone stroke's proposal waiting 3.3 s (the
  // player, 2026-10-10: "tem que aparecer na hora que clica").
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
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]!;
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j]!;
      if (a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]) parent[root(i)] = root(j);
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
    const label = new Int32Array(W * H).fill(-1);
    const isPaved = new Uint8Array(W * H);
    // Only the cells within a street's box (grown by a lot's depth) can be
    // paved: those are tested, the rest is land. A town's group box is mostly
    // open country, and every one of its cells was measured against the
    // streets (most of a proposal's time).
    const near = new Uint8Array(W * H);
    for (const k of members) {
      const b = boxes[k]!;
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
      /**
       * A row's lots, as spans along the block: the row cut in equal columns,
       * except where stored lots already stand in it - then what is left either
       * side of them is cut instead. A proposed lot touching a stored one was
       * dropped whole, and a gap up to a lot wide was left beside it.
       */
      const rowSpans = (r: number): [number, number][] => {
        const t0 = -D / 2 + r * depth, t1 = t0 + depth;
        const taken: [number, number][] = [];
        for (const l of kept) {
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
        // The front faces the street: the row's outer long edge (one row: the
        // side nearer a street).
        const towardMinus = rows === 2 ? r === 0 : nearerStreet(at, s0, s1, -D / 2, D / 2, paved);
        // Reaching past the street sides (the front, a single row's back, the
        // block's two ends) by a little, so the cut to the land below meets the
        // footway exactly: the raster box stops up to half a cell short of it.
        const reach = m(2.5), edge = 1e-6;
        const a0 = s0 <= -L / 2 + edge ? s0 - reach : s0, a1 = s1 >= L / 2 - edge ? s1 + reach : s1;
        const b0 = towardMinus || rows === 1 ? t0 - reach : t0, b1 = !towardMinus || rows === 1 ? t1 + reach : t1;
        const corners: [Vec2, Vec2, Vec2, Vec2] = towardMinus
          ? [at(a1, b0), at(a0, b0), at(a0, b1), at(a1, b1)]
          : [at(a0, b1), at(a1, b1), at(a1, b0), at(a0, b0)];
        // Most of it on this block's land, and cut back to it: a block that is
        // no rectangle (a bent street, a corner's curve) would otherwise have
        // lots hanging over its streets - the player saw zoned lots over the
        // roads (2026-10-09). The front stays the side along the street.
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
  for (const segId of ids) {
    const ribbon = net.ribbons.get(segId);
    if (!ribbon || !ribbons.includes(ribbon)) continue;
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
        // Cut in equal lots, round the lots already there: a corner lot of a
        // cross street's strip, or a stored lot. Each proposed lot touching
        // one was dropped whole, and a gap up to a lot wide was left at every
        // corner of a street between two others (the player's empty spaces).
        const taken: [number, number][] = [];
        for (const l of [...kept, ...add]) {
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
          // Inside the strip: a corner in its band, and not a lot merely
          // touching its far end.
          if (near && ls1 > s0 + m(0.5) && ls0 < s1 - m(0.5)) taken.push([ls0, ls1]);
        }
        for (const [a, b] of cutSpans(freeSpans(s0, s1, taken, MIN_LOT), LOT_FRONTAGE)) {
          // Facing the street: front-start, front-end along the street's
          // direction on its left, against it on its right.
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
  // No snap afterwards: every lot is cut to the land, flush with its footways
  // (a hair back, `LAND_CLEARANCE`); a snap put the corners back onto the
  // footway's edge, and what grew there touched the street.
  return { add, keys, drop, keyRects };
}

/**
 * How far a planned lot stands back from the paving: a hair, so what grows on
 * it is never on the footway (`validate.ts` `touchesRoad` measures from the
 * road's line, and the drawn footway's edge lies a few millimetres either
 * side of that), and no strip of grass shows between them.
 */
const LAND_CLEARANCE = m(0.08);
/** Side of the grid the lots are filed in while a plan is made (`planLotsSteps`). */
const FIT_CELL = m(64);

/**
 * A proposed lot (four corners, the front first) cut back to the land: the
 * paving taken off (`onLand`), the front found again along the street, the
 * corners in the order a building reads them. Null when less than half of it
 * is land - a lot that would be mostly street is no lot.
 */
function landLot(net: Network, corners: readonly Vec2[]): Vec2[] | null {
  const land = onLand(net, corners, false, LAND_CLEARANCE);
  if (!land) return null;
  if (Math.abs(lotArea({ corners: land })) < Math.abs(lotArea({ corners })) * 0.5) return null;
  // Land within a road's reach though off its paving (outside a bend, where
  // the cross street's line runs on to its node) is no lot: nothing could
  // grow on it, and a zoned lot left bare is what the player saw.
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
  const known = new Set(doc.lotKeys);
  if (!plan.add.length && !plan.drop.length && plan.keys.every((k) => known.has(k))) return false;
  // The covered lots taken out in place, in one pass. DO NOT go back to
  // `doc.lots.splice(0, n, ...kept)`: every lot of the town spread into
  // arguments passes the engine's limit (MDN, `Function.prototype.apply`),
  // after two more copies of the list; and nothing to drop walks nothing.
  const gone: Lot[] = [];
  if (plan.drop.length) {
    const dropped = new Set(plan.drop);
    let at = 0;
    for (const lot of doc.lots) {
      if (dropped.has(lot.id)) gone.push(lot);
      else doc.lots[at++] = lot;
    }
    doc.lots.length = at;
  }
  for (const c of plan.add) doc.lots.push({ id: doc.nextLotId++, corners: c.corners });
  // Where the lots went and came, and the land of each key new to the
  // document. DO NOT write `null` (the whole map) when only keys are new:
  // every reader of the lots worked the town out again for land that has no
  // lot more or less. A key with no place (a plan made by hand) is the whole map.
  const rects: ChangeRect[] = [];
  for (const lot of [...gone, ...plan.add]) { const r = rectAround(lot.corners); if (r) rects.push(r); }
  let placeless = false;
  // By a set, not `lotKeys.includes` per key (keys × keys).
  plan.keys.forEach((k, i) => {
    if (known.has(k)) return;
    known.add(k);
    doc.lotKeys.push(k);
    const r = plan.keyRects?.[i];
    if (r) rects.push(r); else placeless = true;
  });
  doc.lotsChanged(placeless ? null : rects, 'lotes planejados');
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

/**
 * A piece of a cut lot with its front set: the side lying along the old
 * front, or else the side nearest it - a back piece of a lot cut parallel to
 * its street then faces the same way.
 */
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
  const at = doc.lots.findIndex((l) => l.id === id);
  if (at < 0) return false;
  const lot = doc.lots[at]!;
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
  const made = pieces.map((piece) => ({ id: doc.nextLotId++, corners: facingCorners(withFront(piece, front)), ...(lot.use ? { use: lot.use, density: lot.density ?? 'low' as const } : {}) }));
  doc.lots.splice(at, 1, ...made);
  doc.lotsChanged(lotRects([lot]), 'lote dividido');
  return true;
}

/**
 * Joins two lots that share a side into one: the two boundaries walked
 * round, the shared stretch left out. False when they share no side.
 */
export function joinLots(doc: RoadDoc, idA: number, idB: number): boolean {
  const ia = doc.lots.findIndex((l) => l.id === idA), ib = doc.lots.findIndex((l) => l.id === idB);
  if (ia < 0 || ib < 0 || ia === ib) return false;
  const A = doc.lots[ia]!.corners, B = doc.lots[ib]!.corners;
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
  const lotA = doc.lots[ia]!;
  // The front stays the first lot's: the ring started at the end of the
  // shared run; the front side is found again by its corners.
  const fa = lotA.corners[0]!, fb = lotA.corners[1]!;
  let f = ring.findIndex((p, k) => near(p, fa) && near(ring[(k + 1) % ring.length]!, fb));
  if (f < 0) f = ring.findIndex((p) => near(p, fa));
  const ordered = f > 0 ? [...ring.slice(f), ...ring.slice(0, f)] : ring;
  const joined: Lot = { id: doc.nextLotId++, corners: facingCorners(ordered), ...(lotA.use ? { use: lotA.use, density: lotA.density ?? 'low' } : {}) };
  doc.lots.splice(Math.max(ia, ib), 1);
  doc.lots.splice(Math.min(ia, ib), 1, joined);
  doc.lotsChanged(lotRects([joined]), 'lotes unidos');
  return true;
}

export function deleteLot(doc: RoadDoc, id: number): boolean {
  const at = doc.lots.findIndex((l) => l.id === id);
  if (at < 0) return false;
  const gone = doc.lots.splice(at, 1);
  doc.lotsChanged(lotRects(gone), 'lote apagado');
  return true;
}

/** A new lot: a rectangle from `a` to `b` aligned with `angle` (the nearest street's direction). */
export function addLot(doc: RoadDoc, a: Vec2, b: Vec2, angle: number): Lot | null {
  const rect = lotRect(a, b, angle);
  return rect ? addPolygonLot(doc, rect, 0) : null;
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

/** The paving as drawn (footways and all within them), grown by `grow`, indexed (`pavingIndex.ts`) by network (`onLand`). */
const PAVING = new WeakMap<Network, { revision: number; grow: number; index: PavingIndex }[]>();
function pavingOf(net: Network, grow = 0): PavingIndex {
  const cached = (PAVING.get(net) ?? []).filter((c) => c.revision === net.revision);
  const known = cached.find((c) => c.grow === grow);
  if (known) return known.index;
  const index = new PavingIndex((net.doc.segments.size ? levelPolygons(net, Level.Sidewalk) : []).map((raw) => grow === 0 ? raw : raw.map((ring, k) => {
    const pts = ring.map(([x, y]) => ({ x: x!, y: y! }));
    // Grown all round: outer counter-clockwise, holes (the blocks) clockwise, so the right-hand offset grows the paving.
    const oriented = (k === 0) === (lotArea({ corners: pts }) > 0) ? pts : [...pts].reverse();
    return offsetRing(oriented, grow).map((p) => [p.x, p.y]);
  })));
  PAVING.set(net, [...cached, { revision: net.revision, grow, index }]);
  return index;
}

/**
 * A lot drawn over the street, cut back to the land: what falls on the paving
 * is taken off, so the lot - and the building grown on it - meets the footway
 * exactly, along a straight back and round a corner's curve alike (the
 * player, 2026-10-06: "snap certinho nas calçadas, rente"). The largest piece
 * is kept; null when nothing of it is on land.
 */
export function onLand(net: Network, points: readonly Vec2[], square = true, clearance = 0): Vec2[] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  // The paving within the lot's box alone (`pavingIndex.ts`): a town's is one piece with every block a hole.
  const near = pavingOf(net, clearance).near(x0, y0, x1, y1);
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

/**
 * A lot cut back to the footways, its corners made square: each run of short
 * sides round a corner's curve between two long straight ones is replaced by
 * the point where the two straight ones meet. The lot is then a straight line
 * from corner to corner, and what grows on it reaches the footway at the
 * corner with no gap (the player, 2026-10-06), standing over the curve's
 * sliver of paving as a building on a street corner does.
 */
function squareCorners(ring: Vec2[]): Vec2[] {
  const n = ring.length;
  const longSides: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!;
    if (Math.hypot(q.x - p.x, q.y - p.y) >= STRAIGHT_BACK) longSides.push(i);
  }
  if (longSides.length < 2) return ring;
  // The corners between each long side and the next: their shared point, or
  // - with a curve's short sides between them - where their lines meet.
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

/**
 * A new lot of any shape: the corners the player clicked, in order. `front`
 * is the side on the street (the caller picks the side nearest one).
 */
export function addPolygonLot(doc: RoadDoc, points: readonly Vec2[], front: number): Lot | null {
  if (points.length < 3 || Math.abs(lotArea({ corners: points })) < MIN_LOT * MIN_LOT / 2) return null;
  const ring = [...points.slice(front), ...points.slice(0, front)];
  const corners = facingCorners(ring);
  if (doc.lots.some((l) => quadsOverlap(corners, l.corners, m(0.5)) && overlapDeep(corners, l.corners))) return null;
  const lot: Lot = { id: doc.nextLotId++, corners };
  doc.lots.push(lot);
  doc.lotsChanged(lotRects([lot]), 'lote desenhado');
  return lot;
}

/**
 * Makes one side of a lot its front - the side on the street, which the
 * building grown there faces (`Lot.corners`: the first side is the front).
 * A building already standing faced the old front: it is taken down, and one
 * facing the new front grows in its place.
 */
export function setLotFront(doc: RoadDoc, id: number, side: number): boolean {
  const at = doc.lots.findIndex((l) => l.id === id);
  const lot = doc.lots[at];
  if (!lot) return false;
  const n = lot.corners.length;
  const k = ((side % n) + n) % n;
  if (k === 0) return false;
  if (lot.building !== undefined) doc.buildings.remove(lot.building as Parameters<typeof doc.buildings.remove>[0]);
  const { building: _gone, ...rest } = lot;
  doc.lots[at] = { ...rest, corners: [...lot.corners.slice(k), ...lot.corners.slice(0, k)] };
  doc.lotsChanged(lotRects([lot]), 'frente do lote');
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

/**
 * Moves a lot corner to `to`, and every other lot's corner standing on the
 * same point with it, so neighbours keep sharing their boundary.
 */
export function moveLotCorner(doc: RoadDoc, from: Vec2, to: Vec2): boolean {
  const touched: { corners: readonly Vec2[] }[] = [];
  for (let i = 0; i < doc.lots.length; i++) {
    const l = doc.lots[i]!;
    let changed = false;
    const corners = l.corners.map((q) => {
      if (near(q, from, m(0.8))) { changed = true; return { x: to.x, y: to.y }; }
      return q;
    });
    if (changed) { doc.lots[i] = { ...l, corners }; touched.push(l, { corners }); }
  }
  if (touched.length) doc.lotsChanged(lotRects(touched), 'canto do lote movido');
  return touched.length > 0;
}

/**
 * Bends the side of a lot from corner `a` to corner `b` through `through`:
 * a curve (a quadratic arc in 12 straight pieces) replaces it - in this lot
 * and in every neighbour sharing that side, so the boundary stays shared.
 */
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
  let changed = false;
  for (let i = 0; i < doc.lots.length; i++) {
    const l = doc.lots[i]!;
    const q = l.corners;
    for (let k = 0; k < q.length; k++) {
      const p = q[k]!, r = q[(k + 1) % q.length]!;
      let inner: Vec2[] | null = null;
      if (near(p, a) && near(r, b)) inner = curve(a, b);
      else if (near(p, b) && near(r, a)) inner = curve(a, b).reverse();
      if (!inner) continue;
      const corners = [...q.slice(0, k + 1), ...inner, ...q.slice(k + 1)];
      doc.lots[i] = { ...l, corners };
      changed = true;
      break;
    }
  }
  // The curve lies within the triangle of its ends and its control point, and
  // can bulge past `through` along the side: the control point is written too.
  if (changed) doc.lotsChanged(lotRects([{ corners: [a, b, through, control] }]), 'lado do lote curvado');
  return changed;
}

/** Zones lots (or clears them, `zone` null). */
export function zoneLots(doc: RoadDoc, ids: readonly number[], zone: { use: ZoneUse; density: ZoneDensity } | null): boolean {
  const zoned: Lot[] = [];
  // By a set: `ids.includes` per lot was lots × the lots of the stroke.
  const wanted = new Set(ids);
  for (let i = 0; i < doc.lots.length && wanted.size; i++) {
    const l = doc.lots[i]!;
    if (!wanted.delete(l.id)) continue;
    if (zone ? l.use === zone.use && l.density === zone.density : !l.use) continue;
    const { use: _u, density: _d, building, ...rest } = l;
    if (zone) doc.lots[i] = { ...rest, use: zone.use, density: zone.density, ...(building !== undefined ? { building } : {}) };
    else {
      // Taking the zone off takes what grew on it (the player, 2026-10-09):
      // the land goes back to unzoned, empty.
      if (building !== undefined && doc.buildings.has(building as BuildingId)) doc.buildings.remove(building as BuildingId);
      doc.lots[i] = rest;
    }
    zoned.push(l);
  }
  if (zoned.length) doc.lotsChanged(lotRects(zoned), zone ? 'lotes zoneados' : 'zona tirada dos lotes');
  return zoned.length > 0;
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

/** The footways' outer edges as drawn, in a grid, by network (`footwayEdges`). */
const EDGE_CELL = m(16);
/** An outline edge at least this long is a straight back of a footway; shorter ones are a corner's curve. */
const STRAIGHT_BACK = m(2);
interface FootwayEdges {
  readonly revision: number;
  readonly cells: Map<number, number[]>;
  /** Edges as x0, y0, x1, y1, four numbers each. */
  readonly edges: number[];
}
const EDGES = new WeakMap<Network, FootwayEdges>();
const edgeKey = (i: number, j: number): number => i * 65_536 + j;

/**
 * The outline of the paving a building may stand against: the union of every
 * footway as the game draws it (`levelPolygons`, the sidewalk level) - the
 * straight backs of the footways, and their curves round each junction's
 * corners. Built once per network.
 */
function footwayEdges(net: Network): FootwayEdges {
  const known = EDGES.get(net);
  if (known && known.revision === net.revision) return known;
  const cells = new Map<number, number[]>();
  const edges: number[] = [];
  const paving = net.doc.segments.size ? levelPolygons(net, Level.Sidewalk) : [];
  for (const poly of paving) for (const ring of poly) {
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k]!, q = ring[(k + 1) % ring.length]!;
      const at = edges.length / 4;
      edges.push(p[0]!, p[1]!, q[0]!, q[1]!);
      for (let i = Math.floor(Math.min(p[0]!, q[0]!) / EDGE_CELL); i <= Math.floor(Math.max(p[0]!, q[0]!) / EDGE_CELL); i++) {
        for (let j = Math.floor(Math.min(p[1]!, q[1]!) / EDGE_CELL); j <= Math.floor(Math.max(p[1]!, q[1]!) / EDGE_CELL); j++) {
          const list = cells.get(edgeKey(i, j));
          if (list) list.push(at); else cells.set(edgeKey(i, j), [at]);
        }
      }
    }
  }
  const built = { revision: net.revision, cells, edges };
  EDGES.set(net, built);
  return built;
}

/**
 * The lot snap: a point near a street is put on the outer edge of its footway
 * as drawn - the straight back of it, or its curve round a corner - so a lot,
 * and the building that grows on it, stands flush against the paving with no
 * gap and no overlap (the player, 2026-10-06). Near a corner of that outline
 * (where a straight back meets the curve, or two backs meet), onto the corner
 * itself. Another lot's corner first, so neighbours close up.
 */
export function lotSnapper(doc: RoadDoc, net: Network, lots: readonly Pick<Lot, 'id' | 'corners'>[] = doc.lots): (p: Vec2, reach: number, skip?: number) => { p: Vec2; kind: 'corner' | 'street' | 'lot' | null } {
  const { cells, edges } = footwayEdges(net);
  return (p, reach, skip) => {
    let lotBest: Vec2 | null = null, lotD = reach * 0.7;
    for (const l of lots) {
      if (l.id === skip) continue;
      for (const q of l.corners) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < lotD) { lotD = d; lotBest = q; } }
    }
    if (lotBest) return { p: { x: lotBest.x, y: lotBest.y }, kind: 'lot' };
    let best: Vec2 | null = null, bestD = reach;
    // The straight backs of the footways near the point (their curves round
    // the corners left out): two of them that meet make a corner.
    const backs: { d: number; x0: number; y0: number; dx: number; dy: number }[] = [];
    const seen = new Set<number>();
    const span = reach * 1.5;
    for (let i = Math.floor((p.x - span) / EDGE_CELL); i <= Math.floor((p.x + span) / EDGE_CELL); i++) {
      for (let j = Math.floor((p.y - span) / EDGE_CELL); j <= Math.floor((p.y + span) / EDGE_CELL); j++) {
        for (const e of cells.get(edgeKey(i, j)) ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          const x0 = edges[e * 4]!, y0 = edges[e * 4 + 1]!, x1 = edges[e * 4 + 2]!, y1 = edges[e * 4 + 3]!;
          const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - x0) * dx + (p.y - y0) * dy) / len2)) : 0;
          const qx = x0 + dx * t, qy = y0 + dy * t, d = Math.hypot(qx - p.x, qy - p.y);
          if (d < bestD) { bestD = d; best = { x: qx, y: qy }; }
          if (len2 >= STRAIGHT_BACK * STRAIGHT_BACK && d < span) backs.push({ d, x0, y0, dx, dy });
        }
      }
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

