import type { Aabb } from '@core/aabb';
import type { Vec2 } from '@core/vec2';
import { IdSlots, grown } from '@core/idSlots';
import { m } from '../units';
import { type GroundAt, type PavedAt, PLINTH_MIN, floorHeight } from './foundation';
import { groundVolumes, solidFootprints, volumeLift } from './geometry';
import { type LotSlope, lotHeightAt, lotSurfaces } from './lots';
import type { Building } from './types';

/** The ground graded to every building */

/** Slope of the bank: horizontal run per unit of height. */
export const PAD_BATTER = 3.5;
/** How far a paved lot's plate stands over the graded ground under it. */
export const LOT_PLATE = m(0.03);
/** How far water stands below its lot's edge: a pool's or a pond's rim. */
export const POOL_SINK = m(0.04);
/** Clearance for water over the triangulated terrain between grid corners. */
export const POOL_TERRAIN_CLEARANCE = m(0.06);
/** Furthest a bank may reach from its platform. */
const PAD_REACH = m(40);

/** The platform's height under a ring, as plain numbers (`padLevelAt`) */
export interface PadLevel {
  readonly slope: LotSlope;
  readonly under: number;
}

/** A platform's height under one of its rings at a point (a car park falls with its street). */
export const padLevelAt = (level: PadLevel, x: number, y: number): number => lotHeightAt(level.slope, x, y) - level.under;

export interface Pad {
  readonly rings: readonly (readonly Vec2[])[];
  /** The platform's height under each ring (`padLevelAt`). */
  readonly levels: readonly PadLevel[];
  readonly water: readonly boolean[];
  /** Whether each ring is a paved lot (anything but grass and water). */
  readonly paved: readonly boolean[];
  readonly solidCount: number;
  /** Whether its blocks stand at floors of their own (a split level). */
  readonly stepped: boolean;
  readonly box: Aabb;
  /** Each ring's own bounds, for the nearest-ring search's lower bound (`shapeAt`). */
  readonly boxes: readonly Aabb[];
}

export interface BuildingPads {
  /** The graded height at a point, and how fully it replaces the land (0 or 1): one answer reused, read before the next call. */
  shapeAt(x: number, y: number, naturalGround: number): { height: number; weight: number };
  shapeBounds(): readonly Aabb[];
  readonly count: number;
}

/** Rounding allowed between a ring's distance and its bounds' (`shapeAt`) */
const BOUND_SLACK = 1e-6;

/** The work `shapeAt` did: rings measured (`ringDistance` calls). */
export const padsWork = { rings: 0 };

/** Squares of an edge's distance this close to the least (relative) have their `Math.hypot` taken: far wider than the rounding of either, so the edge `Math.hypot` puts nearest is always among them. */
const HYPOT_TIE = 1e-9;

/** Distance from a point to a closed ring: 0 inside it. */
/** DO NOT take `Math.hypot` of every edge again (it ran for each edge of each ring at each corner of the ground's grid): the edges compared by their squares, the root only of those that can be the nearest. The answer is the least `Math.hypot` of all the edges, to the bit, as before. */
export function ringDistance(ring: readonly Vec2[], x: number, y: number): number {
  let inside = false;
  let best = Infinity;
  let best2 = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    if ((b.y > y) !== (a.y > y) && x < ((a.x - b.x) * (y - b.y)) / (a.y - b.y) + b.x) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    const ex = x - (a.x + dx * t), ey = y - (a.y + dy * t);
    const d2 = ex * ex + ey * ey;
    // A point not a number: the distance not one either, as `Math.min` made it.
    if (d2 !== d2) { best = NaN; continue; }
    // The least square only falls: an edge left out here is past every later least by more than the tie, and its root past the nearest's.
    if (!(d2 <= best2 * (1 + HYPOT_TIE)) && best2 !== Infinity) continue;
    if (d2 < best2) best2 = d2;
    best = Math.min(best, Math.hypot(ex, ey));
  }
  return inside ? 0 : best;
}

/** The pads of every building. */
export function buildingPads(
  buildings: Iterable<Building>,
  naturalGround: GroundAt,
  pavedAt: PavedAt | undefined,
  apron: number,
  /** Each building's platform as last worked out, by its record (a record is replaced when the building changes) */
  known?: WeakMap<Building, Pad | null>,
  /** Each building's floor as kept for every reader (`floors.ts`); worked out here without. */
  floorOf?: (b: Building) => number,
  /** A building's platform worked out again by its id (`townPads`): given, the town keeps a bounded number of platforms and each one's box alone; without, every platform. */
  resolve: ((id: number) => Pad | null) | null = null,
): TownPads {
  const town = townPads(apron, resolve);
  for (const b of buildings) {
    let pad: Pad | null;
    if (known?.has(b)) pad = known.get(b) ?? null;
    else {
      pad = padOf(b, naturalGround, pavedAt, apron, floorOf);
      known?.set(b, pad);
    }
    town.put(b.id, pad);
  }
  return town;
}

/** One building's platform (its blocks' and its open lots' rings, levels and bounds); null for one with none. */
export function padOf(b: Building, naturalGround: GroundAt, pavedAt: PavedAt | undefined, apron: number,
  floorOf?: (b: Building) => number): Pad | null {
  const built = solidFootprints(b);
  // Each block's own platform: a block at a floor of its own
  const lifts = groundVolumes(b).filter((v) => !v.open).map(volumeLift);
  // The floor as every reader has it (`floors.ts`), on the same ground and paving.
  const floor = floorOf ? floorOf(b) : floorHeight(b, naturalGround, pavedAt);
  // Under the building, level at the floor less the plinth; under its open lots, the lot's own surface
  const lots = lotSurfaces(b, floor, pavedAt);
  const rings: (readonly Vec2[])[] = [...built, ...lots.map((l) => l.ring)];
  const water = [...built.map(() => false), ...lots.map((l) => l.volume.open === 'water')];
  if (rings.length === 0) return null;
  const flat = floor - PLINTH_MIN;
  // A lawn IS the ground, graded to the lot's surface
  const levels: PadLevel[] = [...built.map((_, i): PadLevel => ({ slope: { kind: 'level', level: flat + (lifts[i] ?? 0) }, under: 0 })), ...lots.map((l): PadLevel => {
    const open = l.volume.open ?? 'grass';
    // A lawn is graded a little under the paving beside it
    const under = open === 'grass' ? LOT_PLATE * 3 : open === 'water'
      ? POOL_SINK + LOT_PLATE + POOL_TERRAIN_CLEARANCE : LOT_PLATE;
    return { slope: l.slope, under };
  })];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const boxes: Aabb[] = [];
  for (const ring of rings) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ring) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    boxes.push({ minX: x0, minY: y0, maxX: x1, maxY: y1 });
    minX = Math.min(minX, x0); minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
  }
  const grow = apron + PAD_REACH;
  const paved = [...built.map(() => false), ...lots.map((l) => (l.volume.open ?? 'grass') !== 'grass' && l.volume.open !== 'water')];
  const stepped = lifts.some((l) => Math.abs(l) > 1e-6);
  return { rings, levels, water, paved, solidCount: built.length, stepped, boxes,
    box: { minX: minX - grow, minY: minY - grow, maxX: maxX + grow, maxY: maxY + grow } };
}

/** The town's platforms, one put in, changed or taken out by its building's id (`put`). */
export interface TownPads extends BuildingPads {
  /** A building's platform now (null: it has none, or is gone). */
  put(id: number, pad: Pad | null): void;
  /** The platforms a point inside `boxes` can read, as plain data for the ground's worker (`padShaper`). */
  cut(boxes: readonly (readonly [number, number, number, number])[]): PadShapeCut;
}

/** The town's platforms a shaping of the ground can read inside some boxes, as plain data */
export interface PadShapeCut {
  readonly apron: number;
  readonly pads: readonly Pad[];
  /** Each cell the boxes reach, by key: its platforms (indices into `pads`) in the town's order, empty for none. */
  readonly cells: ReadonlyMap<number, Int32Array>;
}

/** Side of the cells the town's platforms are filed under (`townPads`). */
const PAD_CELL = m(25.6);
const padCellKey = (cx: number, cy: number): number => cx * 100_003 + cy;

/** The platforms kept worked out (`townPads` with a resolver), and the cells' lists of them kept put together: what a shaping round the view reads again and again, never the whole town's. */
const PADS_KEPT = 1024;
const CELL_LISTS_KEPT = 256;
/** Cells a side of the squares the platforms' ids are filed under. */
const FILE_CELLS = 4;

/** The platforms filed under every grid cell their box reaches: a corner of the ground asks only the ones over it. */
/** DO NOT hold every building's platform (its rings, levels and bounds: ~6.8 KB of the page's heap a building of the city, 2026-10-21): with `resolve`, each one's box is kept in columns by its id (`core/idSlots.ts`) and its id in the squares of `FILE_CELLS` cells it reaches (a platform reaches ~25 cells, ~4 squares); the platform itself is worked out again by `resolve` when a shaping reads it, the last `PADS_KEPT` kept. A cell's platforms are its square's whose box reaches it, in the square's order. */
function townPads(apron: number, resolve: ((id: number) => Pad | null) | null): TownPads {
  const CELL = PAD_CELL;
  const cellKey = padCellKey;
  /** The ids filed under each square, in the town's order. */
  const squares = new Map<number, number[]>();
  const squareOf = (c: number): number => Math.floor(c / FILE_CELLS);
  const grading = new Grading();
  const slots = new IdSlots(1024);
  let minX = new Float64Array(16), minY = new Float64Array(16), maxX = new Float64Array(16), maxY = new Float64Array(16);
  /** Whether a slot holds a platform: the bounds read in the slots' order (the order they were handed out, as the town's was). */
  let filled = new Uint8Array(16);
  slots.onGrow = (n) => { minX = grown(minX, n); minY = grown(minY, n); maxX = grown(maxX, n); maxY = grown(maxY, n); filled = grown(filled, n); };
  /** Platforms worked out, by id, oldest first (every one without `resolve`). */
  const kept = new Map<number, Pad>();
  /** Each cell's platforms put together from its square's ids, oldest first. */
  const lists = new Map<number, readonly Pad[]>();
  /** The squares a box reaches. */
  const squaresOf = (x0: number, y0: number, x1: number, y1: number): number[] => {
    const keys: number[] = [];
    for (let sx = squareOf(Math.floor(x0 / CELL)); sx <= squareOf(Math.floor(x1 / CELL)); sx++) {
      for (let sy = squareOf(Math.floor(y0 / CELL)); sy <= squareOf(Math.floor(y1 / CELL)); sy++) keys.push(cellKey(sx, sy));
    }
    return keys;
  };
  /** Each cell a box reaches. */
  const forEachCell = (x0: number, y0: number, x1: number, y1: number, visit: (key: number) => void): void => {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) visit(cellKey(cx, cy));
  };
  const keep = (id: number, pad: Pad): void => {
    kept.delete(id);
    kept.set(id, pad);
    if (resolve && kept.size > PADS_KEPT) kept.delete(kept.keys().next().value!);
  };
  /** An id's platform: kept, or worked out again. */
  const padAt = (id: number): Pad | null => {
    const known = kept.get(id);
    if (known) return known;
    const pad = resolve?.(id) ?? null;
    if (pad) keep(id, pad);
    return pad;
  };
  /** The ids whose box reaches cell (cx, cy), in its square's order; null for none. */
  const idsIn = (cx: number, cy: number): number[] | null => {
    const square = squares.get(cellKey(squareOf(cx), squareOf(cy)));
    if (!square) return null;
    const out: number[] = [];
    for (const id of square) {
      const slot = slots.get(id);
      if (Math.floor(minX[slot]! / CELL) <= cx && cx <= Math.floor(maxX[slot]! / CELL) && Math.floor(minY[slot]! / CELL) <= cy && cy <= Math.floor(maxY[slot]! / CELL)) out.push(id);
    }
    return out.length ? out : null;
  };
  const forget = (key: number): void => { lists.delete(key); };
  const listOf = (cx: number, cy: number): readonly Pad[] | undefined => {
    const key = cellKey(cx, cy);
    let list = lists.get(key);
    if (!list) {
      const ids = idsIn(cx, cy);
      if (!ids) return undefined;
      const out: Pad[] = [];
      for (const id of ids) { const pad = padAt(id); if (pad) out.push(pad); }
      lists.set(key, list = out);
      if (lists.size > CELL_LISTS_KEPT) lists.delete(lists.keys().next().value!);
    }
    return list;
  };
  return {
    get count() { return slots.size; },
    // Made when asked (a shaping of the whole map), never kept: an object a building.
    shapeBounds: () => {
      const out: Aabb[] = [];
      for (let slot = 0; slot < slots.capacity; slot++) if (filled[slot]) out.push({ minX: minX[slot]!, minY: minY[slot]!, maxX: maxX[slot]!, maxY: maxY[slot]! });
      return out;
    },
    put(id, pad) {
      const slot = slots.get(id);
      if (slot < 0 && !pad) return;
      const now = new Set(pad ? squaresOf(pad.box.minX, pad.box.minY, pad.box.maxX, pad.box.maxY) : []);
      if (pad) forEachCell(pad.box.minX, pad.box.minY, pad.box.maxX, pad.box.maxY, forget);
      if (slot >= 0) {
        forEachCell(minX[slot]!, minY[slot]!, maxX[slot]!, maxY[slot]!, forget);
        for (const key of squaresOf(minX[slot]!, minY[slot]!, maxX[slot]!, maxY[slot]!)) {
          // Still under it: it keeps its place in the square's order.
          if (now.delete(key)) continue;
          const list = squares.get(key)!;
          list.splice(list.indexOf(id), 1);
          if (list.length === 0) squares.delete(key);
        }
      }
      for (const key of now) {
        const list = squares.get(key);
        if (list) list.push(id); else squares.set(key, [id]);
      }
      if (!pad) { filled[slot] = 0; slots.delete(id); kept.delete(id); return; }
      const at = slots.take(id);
      filled[at] = 1;
      minX[at] = pad.box.minX; minY[at] = pad.box.minY; maxX[at] = pad.box.maxX; maxY[at] = pad.box.maxY;
      keep(id, pad);
    },
    shapeAt: (x, y, ground) => shapeOverPads(listOf(Math.floor(x / CELL), Math.floor(y / CELL)), apron, x, y, ground, grading),
    cut(boxes) {
      const pads: Pad[] = [];
      const indexOf = new Map<number, number>();
      const out = new Map<number, Int32Array>();
      for (const box of boxes) {
        for (let cx = Math.floor(box[0] / CELL); cx <= Math.floor(box[2] / CELL); cx++) {
          for (let cy = Math.floor(box[1] / CELL); cy <= Math.floor(box[3] / CELL); cy++) {
            const key = cellKey(cx, cy);
            if (out.has(key)) continue;
            const at: number[] = [];
            for (const id of idsIn(cx, cy) ?? NO_IDS) {
              let k = indexOf.get(id);
              if (k === undefined) {
                const pad = padAt(id);
                k = pad ? pads.length : -1;
                if (pad) pads.push(pad);
                indexOf.set(id, k);
              }
              if (k >= 0) at.push(k);
            }
            out.set(key, Int32Array.from(at));
          }
        }
      }
      return { apron, pads, cells: out };
    },
  };
}

const NO_IDS: readonly number[] = Object.freeze([]);

/** The platforms of a cut (`TownPads.cut`) graded as the town grades them */
export function padShaper(cut: PadShapeCut): Pick<BuildingPads, 'shapeAt'> {
  const lists = new Map<number, readonly Pad[]>();
  for (const [key, ids] of cut.cells) lists.set(key, Array.from(ids, (k) => cut.pads[k]!));
  const grading = new Grading();
  return {
    shapeAt(x, y, ground) {
      const list = lists.get(padCellKey(Math.floor(x / PAD_CELL), Math.floor(y / PAD_CELL)));
      if (!list) throw new Error(`no platforms were cut for (${x}, ${y})`);
      return shapeOverPads(list, cut.apron, x, y, ground, grading);
    },
  };
}

/** What `shapeOverPads` works in, point after point, owned by the platforms that grade (`buildingPads`, `padShaper`): each ring's bound and its distance (NaN: not measured), grown, never made per point; the answer, one for every point (DO NOT make an object a corner graded). */
class Grading {
  bounds = new Float64Array(64);
  measured = new Float64Array(64);
  readonly ringAt: (readonly Vec2[])[] = [];
  private readonly shaped = { height: 0, weight: 0 };

  answer(height: number, weight: number): { height: number; weight: number } {
    this.shaped.height = height; this.shaped.weight = weight;
    return this.shaped;
  }

  /** The distance from (x, y) to ring `at` of the walk (`ring`), measured once for both walks of `shapeOverPads`. */
  distanceOf(at: number, ring: readonly Vec2[], x: number, y: number): number {
    let d = this.measured[at]!;
    if (Number.isNaN(d)) { padsWork.rings++; d = ringDistance(ring, x, y); this.measured[at] = d; }
    return d;
  }
}

/** The graded height at a point from the platforms filed under its cell, in their order */
function shapeOverPads(list: readonly Pad[] | undefined, apron: number, x: number, y: number, ground: number, g: Grading): { height: number; weight: number } {
  // The nearest platform decides: two buildings side by side share the strip between them as each one's own apron
  let nearest = Infinity;
  let level = 0;
  let owner: Pad | null = null;
  let solid = false;
  let waterDistance = Infinity;
  let waterLevel = 0;
  let waterOwner: Pad | null = null;
  // A split-level building's lowest block platform within an apron of the point
  let stepLow = Infinity;
  let stepPad: Pad | null = null;
  // The lowest paving of a lot within an apron of the point (a car park, a yard, a drive's ramp, a terrace)
  let pavedLow = Infinity;
  let pavedPad: Pad | null = null;
  // THE NEAREST RING FIRST, AS A NUMBER: every ring's bound, the one of the lowest measured, then only those whose bound can still beat the best (the ring's own distance never under its bound, `BOUND_SLACK` for the rounding). DO NOT measure in the platforms' order against the nearest so far: it starts at Infinity, and most rings of a dense cell were measured for nothing (12.8 s of the ground's worker in an opening).
  const rings = list ?? NO_PADS;
  let count = 0;
  for (const pad of rings) {
    if (x < pad.box.minX || x > pad.box.maxX || y < pad.box.minY || y > pad.box.maxY) continue;
    count += pad.rings.length;
  }
  if (g.bounds.length < count) { g.bounds = new Float64Array(count * 2); g.measured = new Float64Array(count * 2); }
  const { bounds, measured, ringAt } = g;
  let k = 0, first = -1;
  for (const pad of rings) {
    if (x < pad.box.minX || x > pad.box.maxX || y < pad.box.minY || y > pad.box.maxY) continue;
    for (let i = 0; i < pad.rings.length; i++, k++) {
      const rb = pad.boxes[i]!;
      bounds[k] = Math.hypot(Math.max(rb.minX - x, 0, x - rb.maxX), Math.max(rb.minY - y, 0, y - rb.maxY));
      measured[k] = NaN;
      if (first < 0 || bounds[k]! < bounds[first]!) first = k;
    }
  }
  let least = Infinity;
  if (first >= 0) {
    k = 0;
    for (const pad of rings) {
      if (x < pad.box.minX || x > pad.box.maxX || y < pad.box.minY || y > pad.box.maxY) continue;
      for (let i = 0; i < pad.rings.length; i++) ringAt[k++] = pad.rings[i]!;
    }
    least = g.distanceOf(first, ringAt[first]!, x, y);
    for (let at = 0; at < count; at++) {
      if (bounds[at]! > least + BOUND_SLACK) continue;
      const d = g.distanceOf(at, ringAt[at]!, x, y);
      if (d < least) least = d;
    }
  }
  // The walk as it always was, in the platforms' order (its ties, its water, steps and paving), a ring past the least distance left out: it can neither be the nearest nor tie with it.
  k = 0;
  for (const pad of rings) {
    if (x < pad.box.minX || x > pad.box.maxX || y < pad.box.minY || y > pad.box.maxY) continue;
    for (let i = 0; i < pad.rings.length; i++, k++) {
      // The distance to the ring's bounds never exceeds the distance to the ring
      const lb = bounds[k]!;
      // A paved lot (a car park, a yard), not grass or water.
      const paved = i >= pad.solidCount && !pad.water[i] && pad.paved[i];
      if (lb > Math.min(nearest, least) + BOUND_SLACK && !(pad.water[i] && lb < waterDistance + BOUND_SLACK)
        && !(pad.stepped && i < pad.solidCount && lb <= apron + BOUND_SLACK)
        && !(paved && lb <= apron + BOUND_SLACK)) continue;
      const ring = pad.rings[i]!;
      const d = g.distanceOf(k, ring, x, y);
      // Inside a paved lot, its plate decides, not a lawn whose edge it shares.
      if (d < nearest || (d === 0 && paved && nearest === 0)) { nearest = d; level = padLevelAt(pad.levels[i]!, x, y); owner = pad; solid = i < pad.solidCount; }
      if (pad.water[i] && d < waterDistance) { waterDistance = d; waterLevel = padLevelAt(pad.levels[i]!, x, y); waterOwner = pad; }
      if (pad.stepped && i < pad.solidCount && d <= apron) {
        const l = padLevelAt(pad.levels[i]!, x, y);
        if (l < stepLow) { stepLow = l; stepPad = pad; }
      }
      if (paved && d <= apron) {
        const l = padLevelAt(pad.levels[i]!, x, y);
        if (l < pavedLow) { pavedLow = l; pavedPad = pad; }
      }
    }
  }
  if (nearest === Infinity) return g.answer(ground, 0);
  if (solid && nearest === 0 && stepPad === owner && stepLow < level) level = stepLow;
  // A water basin is cut into the ground under its surrounding deck too.
  if ((waterOwner === owner || !solid) && apron > 0 && waterDistance < 2 * apron && waterLevel < level) {
    // A neighbouring open garden can own a terrain grid corner beside the pool
    const t = Math.min(1, (2 * apron - waterDistance) / apron);
    level += (waterLevel - level) * t * t * (3 - 2 * t);
  }
  const out = Math.max(0, nearest - apron) / PAD_BATTER;
  // Fill below the platform, cut above it, and the land itself once the bank has met it.
  let height = ground < level ? Math.max(ground, level - out) : Math.min(ground, level + out);
  // Never over a lot's paving close by - unless that would dig under another building's floor.
  if (pavedLow < height && !(solid && owner !== pavedPad)) height = pavedLow;
  if (Math.abs(height - ground) < 1e-3) return g.answer(ground, 0);
  return g.answer(height, 1);
}

const NO_PADS: readonly Pad[] = Object.freeze([]);
