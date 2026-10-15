import type { Aabb } from '@core/aabb';
import type { Vec2 } from '@core/vec2';
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
  /** The graded height at a point, and how fully it replaces the land (0 or 1). */
  shapeAt(x: number, y: number, naturalGround: number): { height: number; weight: number };
  shapeBounds(): readonly Aabb[];
  readonly count: number;
}

/** Rounding allowed between a ring's distance and its bounds' (`shapeAt`) */
const BOUND_SLACK = 1e-6;

/** The work `shapeAt` did: rings measured (`ringDistance` calls). */
export const padsWork = { rings: 0 };

/** Distance from a point to a closed ring: 0 inside it. */
function ringDistance(ring: readonly Vec2[], x: number, y: number): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    if ((b.y > y) !== (a.y > y) && x < ((a.x - b.x) * (y - b.y)) / (a.y - b.y) + b.x) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
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
): TownPads {
  const town = townPads(apron);
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

/** The platforms filed under every grid cell their box reaches: a corner of the ground asks only the ones over it. */
function townPads(apron: number): TownPads {
  const CELL = PAD_CELL;
  const cellKey = padCellKey;
  const cells = new Map<number, Pad[]>();
  const placed = new Map<number, { pad: Pad; keys: number[] }>();
  let bounds: Aabb[] | null = null;
  const keysOf = (pad: Pad): number[] => {
    const keys: number[] = [];
    for (let cx = Math.floor(pad.box.minX / CELL); cx <= Math.floor(pad.box.maxX / CELL); cx++) {
      for (let cy = Math.floor(pad.box.minY / CELL); cy <= Math.floor(pad.box.maxY / CELL); cy++) keys.push(cellKey(cx, cy));
    }
    return keys;
  };
  return {
    get count() { return placed.size; },
    shapeBounds: () => (bounds ??= [...placed.values()].map((p) => p.pad.box)),
    put(id, pad) {
      const was = placed.get(id);
      if (!was && !pad) return;
      bounds = null;
      const keys = pad ? keysOf(pad) : [];
      const now = new Set(keys);
      for (const key of was?.keys ?? []) {
        const list = cells.get(key)!;
        const at = list.indexOf(was!.pad);
        if (pad && now.has(key)) { list[at] = pad; now.delete(key); continue; }
        list.splice(at, 1);
        if (list.length === 0) cells.delete(key);
      }
      for (const key of now) {
        const list = cells.get(key);
        if (list) list.push(pad!); else cells.set(key, [pad!]);
      }
      if (pad) placed.set(id, { pad, keys }); else placed.delete(id);
    },
    shapeAt: (x, y, ground) => shapeOverPads(cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))), apron, x, y, ground),
    cut(boxes) {
      const pads: Pad[] = [];
      const indexOf = new Map<Pad, number>();
      const out = new Map<number, Int32Array>();
      for (const box of boxes) {
        for (let cx = Math.floor(box[0] / CELL); cx <= Math.floor(box[2] / CELL); cx++) {
          for (let cy = Math.floor(box[1] / CELL); cy <= Math.floor(box[3] / CELL); cy++) {
            const key = cellKey(cx, cy);
            if (out.has(key)) continue;
            const list = cells.get(key) ?? NO_PADS;
            const ids = new Int32Array(list.length);
            list.forEach((pad, k) => {
              let at = indexOf.get(pad);
              if (at === undefined) { indexOf.set(pad, at = pads.length); pads.push(pad); }
              ids[k] = at;
            });
            out.set(key, ids);
          }
        }
      }
      return { apron, pads, cells: out };
    },
  };
}

/** The platforms of a cut (`TownPads.cut`) graded as the town grades them */
export function padShaper(cut: PadShapeCut): Pick<BuildingPads, 'shapeAt'> {
  const lists = new Map<number, readonly Pad[]>();
  for (const [key, ids] of cut.cells) lists.set(key, Array.from(ids, (k) => cut.pads[k]!));
  return {
    shapeAt(x, y, ground) {
      const list = lists.get(padCellKey(Math.floor(x / PAD_CELL), Math.floor(y / PAD_CELL)));
      if (!list) throw new Error(`no platforms were cut for (${x}, ${y})`);
      return shapeOverPads(list, cut.apron, x, y, ground);
    },
  };
}

/** The graded height at a point from the platforms filed under its cell, in their order */
function shapeOverPads(list: readonly Pad[] | undefined, apron: number, x: number, y: number, ground: number): { height: number; weight: number } {
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
  for (const pad of list ?? NO_PADS) {
    if (x < pad.box.minX || x > pad.box.maxX || y < pad.box.minY || y > pad.box.maxY) continue;
    for (let i = 0; i < pad.rings.length; i++) {
      // The distance to the ring's bounds never exceeds the distance to the ring
      const rb = pad.boxes[i]!;
      const lb = Math.hypot(Math.max(rb.minX - x, 0, x - rb.maxX), Math.max(rb.minY - y, 0, y - rb.maxY));
      // A paved lot (a car park, a yard), not grass or water.
      const paved = i >= pad.solidCount && !pad.water[i] && pad.paved[i];
      if (lb > nearest + BOUND_SLACK && !(pad.water[i] && lb < waterDistance + BOUND_SLACK)
        && !(pad.stepped && i < pad.solidCount && lb <= apron + BOUND_SLACK)
        && !(paved && lb <= apron + BOUND_SLACK)) continue;
      const ring = pad.rings[i]!;
      padsWork.rings++;
      const d = ringDistance(ring, x, y);
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
  if (nearest === Infinity) return { height: ground, weight: 0 };
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
  if (Math.abs(height - ground) < 1e-3) return { height: ground, weight: 0 };
  return { height, weight: 1 };
}

const NO_PADS: readonly Pad[] = Object.freeze([]);
