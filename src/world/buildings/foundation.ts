import { steadyRatio } from '@core/scalar';
import { containsPoint, localFootprint } from './footprints';
import { m } from '../units';
import { type FacadeBay, type GroundBays, GB_NX, GB_NY, GB_X, GB_Y, GB_Z, GROUND_BAY_STRIDE, facadeBays, buildingFrame, frameX, frameY, groundBayComponent, groundBays, groundVolumes, volumeLift } from './geometry';
import type { BayComponent, Building, FaceId } from './types';

/** How a building meets the ground. */

/** The ground floor stands at least this far above the highest ground under it */
export const PLINTH_MIN = m(0.15);
/** The plinth runs this far below the lowest ground, so no slope shows under it. */
export const PLINTH_BURY = m(0.8);
/** The steepest site a building may be placed on */
export const MAX_PLINTH = m(5.5);
/** DO NOT lay the landing at the floor itself. */
export const LANDING_RISE = m(0.012);
export const STEP_RISE = m(0.17);
export const STEP_RUN = m(0.3);

export type GroundAt = (x: number, y: number) => number;

/** Height of a PAVED surface at a point - a footway, a carriageway - or NaN where there is none. */
export type PavedAt = (x: number, y: number) => number;

const NO_PAVING: PavedAt = () => NaN;

/** Components that are a way in, on level 0. */
// Doors only: a shopfront is a window on the street, not a way in.
export const ACCESS_COMPONENTS: ReadonlySet<BayComponent> = new Set<BayComponent>(['door', 'doubleDoor', 'garageDoor', 'loadingDoor']);

/** How far in front of an entrance paving still counts as the street it opens onto. */
const ENTRANCE_REACH = m(1.5);
/** The farthest `floorHeight` reads the ground or the paving past a building's bounds */
export const FLOOR_READ_REACH = ENTRANCE_REACH + m(0.1);
/** Sampling step when looking for the edge of the paving in front of an entrance. */
const SCAN_STEP = m(0.1);
/** Wall kept between a recessed flight and the back of its volume. */
const RECESS_BACK = m(1.2);

/** Extension point: a way into the building on its ground floor. */
export interface Entrance {
  readonly volume: number;
  readonly side: FaceId;
  readonly index: number;
  readonly component: BayComponent;
  /** World point of the threshold, on the facade line. */
  readonly x: number;
  readonly y: number;
  readonly nx: number;
  readonly ny: number;
  readonly width: number;
  /** How far its bay stands out from (negative: is set back into) its side, by a relief. */
  readonly push: number;
  /** Absolute height of the ground at the foot of the steps. */
  readonly ground: number;
  /** Absolute height of its landing, the top of its flight: `LANDING_RISE` over the floor it opens from */
  readonly floor: number;
  /** Number of steps from the ground up to the floor; 0 = level access. */
  readonly steps: number;
  /** How far behind the facade line the threshold is, when the flight is set into the building */
  readonly recess: number;
  /** Length of the slab at `ground` height from the foot of a recessed flight out to the paving, over the verge between them */
  readonly threshold: number;
}

export interface Foundation {
  /** Absolute world height of the ground floor. */
  readonly floor: number;
  readonly lowest: number;
  readonly highest: number;
  /** Absolute height of the bottom of the plinth. */
  readonly bottom: number;
  /** Ground spread under the footprint: what `MAX_PLINTH` limits. */
  readonly spread: number;
  readonly entrances: readonly Entrance[];
}

/** The ground under a building: its lowest and highest point, absolute and about each block's own floor. */
export interface FootprintGround {
  readonly lowest: number;
  readonly highest: number;
  /** The same, each point read about the floor of the block over it - the ground less the block's `Volume.lift` */
  readonly levelLowest: number;
  readonly levelHighest: number;
}

/** Samples the ground over every ground volume, at about half-module spacing. */
export function sampleFootprint(b: Building, groundAt: GroundAt): FootprintGround {
  let lowest = Infinity;
  let highest = -Infinity;
  let levelLowest = Infinity;
  let levelHighest = -Infinity;
  // The building's own walls decide; its lots (lawns graded to their own surface, `pads.ts`) only when it has nothing else.
  const all = groundVolumes(b);
  const solid = all.filter((v) => !v.open);
  const f = buildingFrame(b);
  for (const v of solid.length ? solid : all) {
    const lift = volumeLift(v);
    const take = (h: number): void => {
      if (!Number.isFinite(h)) return;
      lowest = Math.min(lowest, h);
      highest = Math.max(highest, h);
      levelLowest = Math.min(levelLowest, h - lift);
      levelHighest = Math.max(levelHighest, h - lift);
    };
    for (const vertex of localFootprint(v)) take(groundAt(frameX(f, vertex.x, vertex.y), frameY(f, vertex.x, vertex.y)));
    const stepsX = Math.max(1, Math.min(24, Math.ceil(v.w / (b.module * 0.5))));
    const stepsY = Math.max(1, Math.min(24, Math.ceil(v.d / (b.module * 0.5))));
    for (let a = 0; a <= stepsX; a++) {
      for (let c = 0; c <= stepsY; c++) {
        const lx = v.x + (v.w * a) / stepsX;
        const ly = v.y + (v.d * c) / stepsY;
        if (v.outline && !containsPoint(v, { x: lx, y: ly })) continue;
        take(groundAt(frameX(f, lx, ly), frameY(f, lx, ly)));
      }
    }
  }
  if (!Number.isFinite(lowest)) return { lowest: 0, highest: 0, levelLowest: 0, levelHighest: 0 };
  return { lowest, highest, levelLowest, levelHighest };
}

const isAccess = (bay: FacadeBay): boolean => bay.level === 0 && ACCESS_COMPONENTS.has(bay.component);

/** Plan length of a flight of `steps`: one tread each, and the top one doubled as a landing. */
export const flightRun = (steps: number): number => (steps > 0 ? (steps + 1) * STEP_RUN : 0);

/** The paving at the level of land at `land` */
function atLevel(pavedAt: PavedAt, land: number, low = land): PavedAt {
  if (pavedAt === NO_PAVING) return pavedAt;
  // Within the plinth's reach of the land under the building, from its lowest point to its highest
  return (x, y) => {
    const h = pavedAt(x, y);
    return h >= low - MAX_PLINTH && h <= land + MAX_PLINTH ? h : NaN;
  };
}

/** The highest paving any entrance opens onto, or -Infinity. */
/** How far out from an access its paving is looked for, nearest first. */
const ENTRANCE_LOOKS = 3;
const entranceLook = (k: number): number => (k === 0 ? m(0.25) : k === 1 ? ENTRANCE_REACH * 0.5 : ENTRANCE_REACH);

/** The ground storey's bays packed (`groundBays`): no bay object made, as the floor is asked for by frame. */
function entrancePaving(bays: GroundBays, pavedAt: PavedAt): number {
  let best = -Infinity;
  for (let i = 0, o = 0; o < bays.length; i++, o += GROUND_BAY_STRIDE) {
    if (!ACCESS_COMPONENTS.has(groundBayComponent(bays, i))) continue;
    const x = bays[o + GB_X]!, y = bays[o + GB_Y]!, nx = bays[o + GB_NX]!, ny = bays[o + GB_NY]!;
    for (let k = 0; k < ENTRANCE_LOOKS; k++) {
      const d = entranceLook(k);
      const h = pavedAt(x + nx * d, y + ny * d);
      if (Number.isFinite(h)) {
        // A door of a block at a floor of its own puts the ground floor that far from its paving
        best = Math.max(best, h - bays[o + GB_Z]!);
        break;
      }
    }
  }
  return best;
}

/** Distance from a facade to the first paving in front of it, or Infinity if there is none within `limit` */
function pavingEdge(bay: FacadeBay, pavedAt: PavedAt, limit: number): number {
  const paved = (d: number): boolean => Number.isFinite(pavedAt(bay.x + bay.nx * d, bay.y + bay.ny * d));
  let outside = 0;
  for (let d = SCAN_STEP; d <= limit + 1e-9; d += SCAN_STEP * 2.5) {
    if (!paved(d)) {
      outside = d;
      continue;
    }
    // The edge is between the last dry sample and this one: halve the gap.
    let inside = d;
    while (inside - outside > SCAN_STEP * 0.25) {
      const mid = (inside + outside) / 2;
      if (paved(mid)) inside = mid;
      else outside = mid;
    }
    return outside;
  }
  return paved(0) ? 0 : Infinity;
}

export function foundationOf(
  b: Building,
  groundAt: GroundAt,
  bays?: readonly FacadeBay[],
  anyPaving: PavedAt = NO_PAVING,
  designedFloor?: number,
): Foundation {
  // Only the ground storey's ways in are read: its bays alone put in the world, off the layout kept for the blocks (`bayLayout`).
  const all = bays ?? facadeBays(b, 0);
  const { lowest, highest, levelLowest, levelHighest } = sampleFootprint(b, groundAt);
  const pavedAt = atLevel(anyPaving, highest, lowest);
  const groundFloor = designedFloor ?? floorOver(highest, groundBays(b), pavedAt, lotFront(b, pavedAt));
  const volumes = new Map(b.volumes.map((v) => [v.id, v]));
  const entrances: Entrance[] = [];
  for (const bay of all) {
    if (!isAccess(bay)) continue;
    // The floor this door opens from: its block's own, on a split level.
    const floor = groundFloor + bay.z;
    // What a person stands on at `d` in front of the facade: the paving where there is some, the land elsewhere.
    const surface = (d: number): number => {
      const x = bay.x + bay.nx * d;
      const y = bay.y + bay.ny * d;
      const paved = pavedAt(x, y);
      return Number.isFinite(paved) ? paved : groundAt(x, y);
    };
    let ground = surface(b.module * 0.5);
    let steps = stepsFor(floor - ground);
    let recess = 0;
    let threshold = 0;
    if (steps > 0) {
      // A flight may run out to the paving and no further.
      const room = pavingEdge(bay, pavedAt, flightRun(stepsFor(floor - Math.min(ground, lowest))) + m(0.5));
      // At and past the edge of the paving, the paving is what one stands on
      const stand = (d: number): number => (d >= room ? surface(room + SCAN_STEP * 0.3) : surface(d));
      ground = stand(b.module * 0.5);
      steps = stepsFor(floor - ground);
      if (flightRun(steps) <= room) {
        // Read the ground again where the flight would land.
        ground = Math.min(ground, stand(Math.max(b.module * 0.5, flightRun(steps) + m(0.4))));
        steps = stepsFor(floor - ground);
      }
      if (flightRun(steps) > room) {
        // No room in front: the flight is set into the building.
        const fromPaving = room <= ENTRANCE_REACH;
        ground = stand(fromPaving ? room : m(0.2));
        threshold = fromPaving ? room : 0;
        steps = stepsFor(floor - ground);
        const v = volumes.get(bay.volume);
        const depth = v ? (bay.side === 0 || bay.side === 2 ? v.d : v.w) : b.module;
        // A volume too shallow for the whole flight takes as many treads as fit, each a little steeper.
        const fit = Math.max(0, depth - RECESS_BACK);
        if (flightRun(steps) > fit) steps = Math.max(0, Math.floor(fit / STEP_RUN + 1e-9) - 1);
        recess = flightRun(steps);
        if (steps === 0) threshold = 0;
      }
    }
    entrances.push({
      volume: bay.volume,
      side: bay.side,
      index: bay.index,
      component: bay.component,
      x: bay.x,
      y: bay.y,
      nx: bay.nx,
      ny: bay.ny,
      width: bay.width,
      push: bay.push,
      ground,
      floor: floor + LANDING_RISE,
      steps,
      recess,
      threshold,
    });
  }
  return {
    floor: groundFloor,
    lowest,
    highest,
    bottom: lowest - PLINTH_BURY,
    spread: levelHighest - levelLowest,
    entrances: mergeEntrances(entrances),
  };
}

/** Side-by-side ways in become ONE wide flight. */
function mergeEntrances(list: readonly Entrance[]): Entrance[] {
  const out: Entrance[] = [];
  for (const entrance of list) {
    const last = out[out.length - 1];
    if (last && adjacentEntrance(last, entrance)) {
      out[out.length - 1] = { ...last, width: last.width + entrance.width };
      continue;
    }
    out.push(entrance);
  }
  return out;
}

function adjacentEntrance(a: Entrance, b: Entrance): boolean {
  if (a.volume !== b.volume || a.side !== b.side || a.component !== b.component) return false;
  if (Math.abs(a.ground - b.ground) > 1e-6 || Math.abs(a.floor - b.floor) > 1e-6 || a.steps !== b.steps || a.recess !== b.recess || a.threshold !== b.threshold) return false;
  // One bay further along the same side: the two runs touch.
  const bays = a.width > 1e-6 ? Math.round(steadyRatio(a.width, Math.max(1e-6, b.width))) : 1;
  return b.index === a.index + Math.max(1, bays);
}

/** The absolute ground-floor height of a building, uncached. Same rule as `foundationOf`. */
export function floorHeight(b: Building, groundAt: GroundAt, pavedAt: PavedAt = NO_PAVING): number {
  const { lowest, highest } = sampleFootprint(b, groundAt);
  const paved = atLevel(pavedAt, highest, lowest);
  return floorOver(highest, groundBays(b), paved, lotFront(b, paved));
}

/** The highest pavement along the open edges of a building's lots */
function lotFront(b: Building, pavedAt: PavedAt): number {
  if (pavedAt === NO_PAVING) return -Infinity;
  let best = -Infinity;
  const f = buildingFrame(b);
  for (const v of b.volumes) {
    if (!v.open) continue;
    const ring = localFootprint(v);
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < 1e-6) continue;
      // Either side of the edge: only the outside can be a street.
      const nx = (q.y - p.y) / len, ny = -(q.x - p.x) / len;
      for (const t of [0.25, 0.5, 0.75]) for (const side of [1, -1]) {
        const lx = p.x + (q.x - p.x) * t + side * nx * m(0.6), ly = p.y + (q.y - p.y) * t + side * ny * m(0.6);
        const h = pavedAt(frameX(f, lx, ly), frameY(f, lx, ly));
        if (Number.isFinite(h)) best = Math.max(best, h);
      }
    }
  }
  return best;
}

/** Height of a ground floor's threshold over the pavement it opens onto. */
export const THRESHOLD = m(0.04);

/** The ground floor's height. */
function floorOver(highest: number, bays: GroundBays, pavedAt: PavedAt, lot = -Infinity): number {
  if (pavedAt === NO_PAVING) return highest + PLINTH_MIN;
  const door = entrancePaving(bays, pavedAt);
  if (Number.isFinite(door)) return door + THRESHOLD;
  if (Number.isFinite(lot)) return lot + THRESHOLD;
  let front = -Infinity;
  for (let o = 0; o < bays.length; o += GROUND_BAY_STRIDE) {
    const h = pavedAt(bays[o + GB_X]! + bays[o + GB_NX]! * m(0.5), bays[o + GB_Y]! + bays[o + GB_NY]! * m(0.5));
    if (Number.isFinite(h)) front = Math.max(front, h - bays[o + GB_Z]!);
  }
  return Number.isFinite(front) ? front + THRESHOLD : highest + PLINTH_MIN;
}

/** Steps needed to climb `rise`; a threshold under two risers needs none. */
function stepsFor(rise: number): number {
  if (!(rise > STEP_RISE * 1.5)) return 0;
  return Math.min(40, Math.ceil(rise / STEP_RISE));
}
