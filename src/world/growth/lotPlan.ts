import type { Rng } from '@core/rng';
import type { BlueprintBody } from '@world/buildings/blueprints';
import { RETAINING_STONE, mat } from '@world/buildings/cityBuildings';
import { FOLLOWS_GROUND, elementClash, elementsMeet, isStructure, unsupportedElements } from '@world/buildings/elements';
import type { MaterialSpec } from '@world/buildings/materials';
import type { MadeBuilding, Rect } from '@world/buildings/procedural';
import { type Building, type BuildingElement, type ElementKind, type LotSurface, MAX_ELEMENTS, MAX_TERRACE, type Side, type Volume, componentAt } from '@world/buildings/types';
import { bayWidth, baysOn } from '@world/buildings/geometry';
import { m } from '@world/units';
import type { ZoneDensity, ZoneUse } from '@world/zones';
import { type CoverBox, openRunsAlong } from './lotBoundaryRuns';

/** A grown lot, composed the way a plot in a real street is */

export type LotKind = 'house' | 'flats' | 'tower' | 'shop' | 'office' | 'industry';

export function lotKind(use: ZoneUse, density: ZoneDensity): LotKind {
  if (use === 'industrial') return 'industry';
  if (use === 'commercial') return density === 'high' ? 'office' : 'shop';
  return density === 'low' ? 'house' : density === 'medium' ? 'flats' : 'tower';
}

type FrontUse = 'street' | 'garden' | 'carpad' | 'forecourt' | 'plaza' | 'apron';
type SideUse = 'attached' | 'path' | 'drive' | 'drivePath' | 'garden';
type BackUse = 'none' | 'yard' | 'parking' | 'service' | 'courtyard' | 'loading';
/** A loading yard deep enough for a lorry's approach to its docks (`planLot`, industry). */
const YARD_FULL = 22;

interface SidePlan { readonly use: SideUse; readonly width: number }

export interface LotPlan {
  readonly kind: LotKind;
  readonly W: number;
  readonly D: number;
  readonly front: { readonly use: FrontUse; readonly depth: number };
  readonly left: SidePlan;
  readonly right: SidePlan;
  readonly back: { readonly use: BackUse; readonly depth: number; readonly rows: number };
  /** The building's envelope. */
  readonly building: Rect;
  /** A corner lot: the side on a second street, which is a front too (a low boundary, never a blank party wall). */
  readonly corner?: 'left' | 'right';
}

const DRIVE = 3.5, HOUSE_DRIVE = 3, FOOTPATH = 1.2, TRUCK_LANE = 6;
const STALL = 5, AISLE = 6;
/** A lorry's dock: wider than a car's bay (`sim/agents/parking.ts` LORRY_DOCK, 3.2 m). */
const DOCK = 3.6;

/** The loading doors on the ground floor's back faces that stand at `back` (local y, the yard's front edge) */
function loadingDoors(b: Building, back: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const v of b.volumes) {
    if (v.open || v.base !== 0 || v.outline || Math.abs(v.y + v.d - back) > m(0.6)) continue;
    const facade = v.storeys[0]?.facade;
    if (!facade) continue;
    const n = baysOn(b, v, 2), w = bayWidth(b, v, 2);
    for (let i = 0; i < n; i++) if (componentAt(facade, 2, i) === 'loadingDoor') out.push({ x: v.x + (i + 0.5) * w, y: v.y + v.d });
  }
  return out;
}

/** The steepest a car park's stalls are laid: 1 in 20. */
const PARK_SLOPE = 0.05;

const between = (rng: Rng, a: number, b: number): number => a + (b - a) * rng.float();
const half = (x: number): number => Math.floor(x * 2) / 2;

/** The plan of a lot `W` x `D` metres for a kind of building. */
export function planLot(kind: LotKind, W: number, D: number, rng: Rng, corner?: 'left' | 'right'): LotPlan {
  const attached: SidePlan = { use: 'attached', width: 0 };
  let front: LotPlan['front'] = { use: 'street', depth: 0 };
  let left: SidePlan = attached, right: SidePlan = attached;
  let back: LotPlan['back'] = { use: 'none', depth: 0, rows: 0 };
  const flip = rng.float() < 0.5;
  const sides = (a: SidePlan, b: SidePlan): void => { [left, right] = flip ? [b, a] : [a, b]; };
  /** Parking behind: rows the depth allows after `front` and a building of `minBuilding`. */
  const parkingRows = (minBuilding: number): number => {
    const room = D - front.depth - minBuilding;
    return room >= STALL * 2 + AISLE ? 2 : room >= STALL + AISLE ? 1 : 0;
  };

  switch (kind) {
    case 'house': {
      const narrow = W < 10.5;
      front = D >= 22 ? (narrow ? { use: 'carpad', depth: 5.5 } : { use: 'garden', depth: half(between(rng, 3.5, 5.5)) })
        : { use: 'garden', depth: D >= 14 ? 3 : 0 };
      if (front.depth === 0) front = { use: 'street', depth: 0 };
      // A house stands free of its neighbours: a passage on both sides, the boundary walls meeting on the line between
      const passage = { use: 'path' as const, width: 1.1 };
      if (narrow) sides({ use: 'path', width: FOOTPATH }, passage);
      else sides({ use: 'drive', width: HOUSE_DRIVE }, W >= 16 ? { use: 'garden', width: half(between(rng, 3, 4)) } : W >= 13 ? { use: 'path', width: FOOTPATH } : passage);
      const houseD = Math.min(Math.max(8, D - front.depth - between(rng, 8, 12)), 15);
      const yard = D - front.depth - houseD;
      back = yard >= 4 ? { use: 'yard', depth: half(yard), rows: 0 } : back;
      break;
    }
    case 'flats':
    case 'tower': {
      front = kind === 'tower' ? { use: D >= 24 ? 'plaza' : 'street', depth: D >= 24 ? 5 : 0 }
        : W >= 14 && D >= 20 && rng.float() < 0.75 ? { use: 'garden', depth: half(between(rng, 3, 5)) } : { use: 'street', depth: 0 };
      const rows = W >= 18 ? parkingRows(12) : 0;
      if (rows) {
        sides({ use: 'drivePath', width: DRIVE + FOOTPATH }, rng.float() < 0.55 ? attached : { use: 'path', width: 1.5 });
        back = { use: 'parking', depth: rows === 2 ? STALL * 2 + AISLE : STALL + AISLE, rows };
      } else {
        sides(W >= 14 ? { use: 'path', width: 1.5 } : attached, attached);
        const room = D - front.depth - 12;
        back = room >= 5 ? { use: 'courtyard', depth: half(Math.min(room, 12)), rows: 0 } : back;
      }
      break;
    }
    case 'shop': {
      front = D >= 16 && rng.float() < 0.45 ? { use: 'forecourt', depth: half(between(rng, 3, 4.5)) } : { use: 'street', depth: 0 };
      const rows = W >= 15 && rng.float() < 0.6 ? Math.min(1, parkingRows(12)) : 0;
      if (rows) {
        sides({ use: 'drive', width: DRIVE }, attached);
        back = { use: 'parking', depth: STALL + AISLE, rows };
      } else if (D - front.depth >= 14) {
        back = { use: 'service', depth: half(between(rng, 4.5, 6)), rows: 0 };
      }
      break;
    }
    case 'office': {
      front = D >= 22 ? { use: 'plaza', depth: half(between(rng, 5, 7)) } : { use: 'forecourt', depth: D >= 14 ? 3 : 0 };
      if (front.depth === 0) front = { use: 'street', depth: 0 };
      const rows = W >= 16 ? parkingRows(14) : 0;
      if (rows) {
        sides({ use: 'drivePath', width: DRIVE + FOOTPATH }, attached);
        back = { use: 'parking', depth: rows === 2 ? STALL * 2 + AISLE : STALL + AISLE, rows };
      } else if (D - front.depth >= 16) back = { use: 'service', depth: 5, rows: 0 };
      break;
    }
    case 'industry': {
      // Deep enough for a row of visitors' stalls and the aisle before them (5 + 6 m) behind the gate, else a paved forecourt.
      front = D >= 22 ? { use: 'apron', depth: D >= 40 ? STALL + AISLE : 6 } : { use: 'street', depth: 0 };
      if (W >= 20 && D >= 30) {
        sides({ use: 'drive', width: TRUCK_LANE }, W >= 26 ? { use: 'path', width: 1.5 } : attached);
        // Deep enough for a lorry to back square onto a dock: the dock
        const room = D - front.depth;
        back = { use: 'loading', depth: half(room >= YARD_FULL + 14 ? YARD_FULL : Math.min(16, Math.max(12, room * 0.35))), rows: 0 };
      }
      break;
    }
  }
  // A car park is reached from the street: without a drive down a side to it, the back is a paved service yard instead
  if (back.use === 'parking' && left.use !== 'drive' && left.use !== 'drivePath' && right.use !== 'drive' && right.use !== 'drivePath') {
    back = { use: 'service', depth: Math.min(6, back.depth), rows: 0 };
  }
  // The building keeps a usable width: what it cannot keep, the sides give up.
  if (W - left.width - right.width < 6 && kind === 'house' && W >= 8.5) { left = { use: 'path', width: 1 }; right = { use: 'path', width: 1 }; }
  else if (W - left.width - right.width < 6) { left = attached; right = attached; if (back.use === 'parking') back = { use: 'service', depth: Math.min(6, back.depth), rows: 0 }; }
  // A corner lot's side on the second street is a garden strip, not a party wall
  if (corner) {
    const side = corner === 'left' ? left : right;
    const other = corner === 'left' ? right : left;
    if (side.use === 'attached' && W - other.width - 2 >= 6) {
      if (corner === 'left') left = { use: 'garden', width: 2 }; else right = { use: 'garden', width: 2 };
    }
  }
  const building = { x0: left.width, y0: front.depth, x1: W - right.width, y1: D - back.depth };
  return { kind, W, D, front, left, right, back, building, ...(corner ? { corner } : {}) };
}

/** How far a car park's or a loading yard's drive may climb or fall from the street to the yard */
const RAMP_LANDING = 6;
export function yardRamp(plan: LotPlan): { readonly start: number; readonly end: number; readonly grade: number } | null {
  if (plan.back.use !== 'parking' && plan.back.use !== 'loading') return null;
  const drive = [plan.left, plan.right].some((s) => s.use === 'drive' || s.use === 'drivePath');
  if (!drive) return null;
  const end = plan.D - plan.back.depth;
  const start = Math.max(plan.front.depth, RAMP_LANDING);
  if (end - start < 2) return null;
  return { start, end, grade: plan.kind === 'industry' ? 0.1 : 0.125 };
}

/** The drive of a house down (or up) to a garage in its lower ground floor (`world/buildings/splitLevel.ts` `garageUnder`) */
export const GARAGE_GRADE = 0.25;
export function garageRamp(plan: LotPlan): { readonly start: number; readonly end: number; readonly grade: number } | null {
  if (plan.kind !== 'house' || ![plan.left, plan.right].some((s) => s.use === 'drive')) return null;
  const end = plan.D - plan.back.depth;
  const start = Math.max(plan.front.depth, 1);
  if (end - start < 2) return null;
  return { start, end, grade: GARAGE_GRADE };
}

/** The side of the lot its drive runs down, if it has one. */
export const driveSide = (plan: LotPlan): 'left' | 'right' | null =>
  plan.left.use === 'drive' || plan.left.use === 'drivePath' ? 'left' : plan.right.use === 'drive' || plan.right.use === 'drivePath' ? 'right' : null;

/** Depth of the paved apron behind a house where a car turns into its garage under the back. */
const GARAGE_APRON = 6;

// ---------------------------------------------------------------- furnishing

/** Elements kept free for a lot's boundary, which is laid after everything else. */
const BOUNDARY_RESERVE = 30;
/** A yard falls or rises at least this much (m) before it is terraced; risers and treads of its steps; the most risers. */
const TERRACE_MIN = 0.8;
const STEP_RISE_M = 0.17;
const STEP_RUN_M = 0.3;
const TERRACE_MAX_RISERS = 20;
/** Parts a car drives over: laid in a drive as anywhere. */
const FLAT_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>(['pavement', 'drain', 'parking']);
const BOUNDARY_SET: ReadonlySet<ElementKind> = new Set<ElementKind>(['wall', 'fence', 'hedge', 'railing', 'gate']);
const PAVERS = mat('brick', 0x9a958c);
const PAVERS_WARM = mat('brick', 0xb08a6e);
const CONCRETE_PATH = mat('concrete', 0xc8c4bb);
const STONE_PATH = mat('stone', 0xd2cbbd);
const ALLEY_COBBLES = mat('stone', 0x8a857c);
/** A retaining wall's stone, and the flights cut through one. */
const RETAINING = RETAINING_STONE;

interface Lot {
  surface(r: Rect, s: LotSurface): void;
  /** A drive's ramp over `r`, from `from` metres above the floor at its front edge to `to` at its back edge (`Volume.ramp`). */
  ramp(r: Rect, s: LotSurface, from: number, to: number): void;
  /** `region` laid with `s` round its `holes` (each laid on its own), in rects that do not overlap. */
  tile(region: Rect, holes: readonly Rect[], s: LotSurface): void;
  put(kind: ElementKind, x: number, y: number, facing: Side, w: number, d: number, h: number, z?: number, material?: MaterialSpec): boolean;
  /** Whether `put` would take that part now (the same rules), without laying it. */
  fits(kind: ElementKind, x: number, y: number, facing: Side, w: number, d: number, h: number, z?: number, material?: MaterialSpec): boolean;
  /** A run of `kind` along x at `y` from `x0` to `x1`, with gaps [middle, width]. */
  runX(kind: ElementKind, y: number, x0: number, x1: number, h: number, gaps?: readonly (readonly [number, number])[], z?: number): void;
  runY(kind: ElementKind, x: number, y0: number, y1: number, h: number, z?: number): void;
  /** A path laid as a strip of paving over the ground. */
  path(r: Rect, material?: MaterialSpec): void;
  busy(x: number, y: number, r?: number): boolean;
}

/** Lays the plan on a body whose building already stands in its envelope */
export function furnishLot(body: BlueprintBody, plan: LotPlan, made: MadeBuilding, rng: Rng,
  /** The lot's slope: the natural ground in the middle of the back yard less at the street front, metres */
  hill?: {
    readonly yard: number;
    readonly split?: { readonly y: number; readonly lift: number };
    /** How the land falls (-) or rises (+) across the back zone, from its front to the lot's back, metres. */
    readonly backFall?: number;
    /** A garage under the back, in the lower ground floor of a house a whole storey down (`splitLevel.ts` `garageUnder`) */
    readonly garage?: { readonly x: number; readonly y: number; readonly w: number };
    /** The natural ground about the street floor at a point of the lot, metres (where a drive's ramp is walled). */
    readonly landAt?: (x: number, y: number) => number;
  }): boolean {
  const split = hill?.split && Math.abs(hill.split.lift) > 0.05 ? hill.split : null;
  const backLevel = split?.lift ?? 0;
  const { W, D, front, left, right, back } = plan;
  const env = plan.building;
  const F = front.depth, Bk = D - back.depth;
  const X = (x: number): number => m(x - W / 2), Y = (y: number): number => m(y);
  let nextVolume = Math.max(0, ...body.volumes.map((v) => v.id)) + 1;
  const elements: BuildingElement[] = (body.elements ??= []);
  let nextElement = Math.max(0, ...elements.map((e) => e.id)) + 1;
  const taken: Rect[] = [];
  /** The car's way: each drive from its gate to the back, and its mouth into the car park's aisle. */
  const keepClear: Rect[] = [];
  /** A boundary run is being laid (`runX`, `runY`): its pieces may stand along the drive. */
  let laying = false;
  /** The x spans kept clear in front of the people's gates (`put`), filled once the door is known. */
  const gateWays: { x0: number; x1: number }[] = [];
  const probe = (): Building => ({ ...body, id: 0, x: 0, y: 0, rotation: 0 } as Building);

  const lot: Lot = {
    surface(r, s) {
      if (r.x1 - r.x0 < 2 - 1e-6 || r.y1 - r.y0 < 2 - 1e-6) return;
      body.volumes.push({ id: nextVolume++, x: X(r.x0), y: Y(r.y0), w: m(r.x1 - r.x0), d: m(r.y1 - r.y0), base: 0,
        roof: 'flat', storeys: [{ facade: { fill: 'wall' } }], open: s } as Volume);
    },
    ramp(r, s, from, to) {
      if (r.x1 - r.x0 < 2 - 1e-6 || r.y1 - r.y0 < 2 - 1e-6) return;
      body.volumes.push({ id: nextVolume++, x: X(r.x0), y: Y(r.y0), w: m(r.x1 - r.x0), d: m(r.y1 - r.y0), base: 0,
        roof: 'flat', storeys: [{ facade: { fill: 'wall' } }], open: s, ramp: m(from), terrace: m(to) } as Volume);
    },
    tile(region, holes, s) {
      const inside = holes.map((h) => ({ x0: Math.max(h.x0, region.x0), y0: Math.max(h.y0, region.y0), x1: Math.min(h.x1, region.x1), y1: Math.min(h.y1, region.y1) }))
        .filter((h) => h.x1 > h.x0 && h.y1 > h.y0);
      const ys = [...new Set([region.y0, region.y1, ...inside.flatMap((h) => [h.y0, h.y1])])].sort((a, b) => a - b);
      for (let j = 0; j + 1 < ys.length; j++) {
        const y0 = ys[j]!, y1 = ys[j + 1]!;
        const cuts = inside.filter((h) => h.y0 < y1 - 1e-6 && h.y1 > y0 + 1e-6).map((h) => [h.x0, h.x1] as const).sort((a, b) => a[0] - b[0]);
        let x = region.x0;
        for (const [a, b] of [...cuts, [region.x1, region.x1] as const]) {
          if (a - x >= 2) lot.surface({ x0: x, y0, x1: a, y1 }, s);
          x = Math.max(x, b);
        }
      }
    },
    fits(kind, x, y, facing, w, d, h, z = 0, material) {
      // The boundary - walls, fences, hedges, gates - is laid last, so the budget keeps room for it
      const boundary = kind === 'wall' || kind === 'fence' || kind === 'hedge' || kind === 'gate' || kind === 'railing';
      if (elements.length >= MAX_ELEMENTS - (boundary ? 2 : BOUNDARY_RESERVE) || w < 0.1 || d < 0.1 || h < 0.1) return false;
      // Only the boundary's own runs and the gates may stand at the drive's edge
      if (!(laying || kind === 'gate') && z < 2 && !FLAT_KINDS.has(kind)) {
        const [hw, hd] = facing === 1 || facing === 3 ? [d / 2, w / 2] : [w / 2, d / 2];
        if (keepClear.some((r) => x + hw > r.x0 && x - hw < r.x1 && y + hd > r.y0 && y - hd < r.y1)) return false;
        // The way from a people's gate to the door: nothing in the opening and half a metre either side, across the front
        if (y - hd < Math.max(F, 1) && gateWays.some((g) => x + hw > g.x0 && x - hw < g.x1)) return false;
      }
      const el: BuildingElement = { id: nextElement, kind, x: X(x), y: Y(y), facing, w: m(Math.min(w, 40)), d: m(d), z: m(z), h: m(h) };
      if (elementClash(probe(), el)) return false;
      // Nothing solid in another's footprint
      return laying || isStructure(material ? { ...el, material } : el) || !elements.some((o) => elementsMeet(el, o));
    },
    put(kind, x, y, facing, w, d, h, z = 0, material) {
      if (!lot.fits(kind, x, y, facing, w, d, h, z, material)) return false;
      const el: BuildingElement = { id: nextElement, kind, x: X(x), y: Y(y), facing, w: m(Math.min(w, 40)), d: m(d), z: m(z), h: m(h),
        ...(material ? { material } : {}) };
      if (laying || isStructure(el)) {
        for (let i = elements.length - 1; i >= 0; i--) if (elementsMeet(el, elements[i]!)) elements.splice(i, 1);
      }
      elements.push(el);
      nextElement++;
      return true;
    },
    runX(kind, y, x0, x1, h, gaps = [], z = 0) {
      const cuts = gaps.map(([c, w]) => [c - w / 2, c + w / 2] as const).sort((p, q) => p[0] - q[0]);
      let from = x0;
      for (const [g0, g1] of [...cuts, [x1, x1] as const]) {
        const to = Math.min(g0, x1);
        const n = Math.ceil((to - from) / 20);
        const thick = kind === 'fence' ? 0.12 : kind === 'hedge' ? 0.7 : 0.2;
        // A piece that meets something (a porch, a step) is split, and only the part that really meets it is left out
        const piece = (a: number, b: number): void => {
          laying = true;
          const ok = lot.put(kind, (a + b) / 2, y, 0, b - a, thick, h, z);
          laying = false;
          if (ok || b - a < 1) return;
          piece(a, (a + b) / 2);
          piece((a + b) / 2, b);
        };
        for (let k = 0; k < n && to - from > 0.3; k++) {
          piece(from + ((to - from) * k) / n, from + ((to - from) * (k + 1)) / n);
        }
        from = Math.max(from, g1);
      }
    },
    runY(kind, x, y0, y1, h, z = 0) {
      const n = Math.ceil((y1 - y0) / 20);
      const thick = kind === 'fence' ? 0.12 : kind === 'hedge' ? 0.7 : 0.2;
      const piece = (a: number, b: number): void => {
        laying = true;
        const ok = lot.put(kind, x, (a + b) / 2, 1, b - a, thick, h, z);
        laying = false;
        if (ok || b - a < 1) return;
        piece(a, (a + b) / 2);
        piece((a + b) / 2, b);
      };
      for (let k = 0; k < n && y1 - y0 > 0.3; k++) piece(y0 + ((y1 - y0) * k) / n, y0 + ((y1 - y0) * (k + 1)) / n);
    },
    path(r, material = PAVERS) {
      if (r.x1 - r.x0 < 0.3 || r.y1 - r.y0 < 0.3) return;
      taken.push(r);
      lot.put('pavement', (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, 0, r.x1 - r.x0, r.y1 - r.y0, 0.1, 0, material);
    },
    busy(x, y, r = 0.8) {
      return taken.some((t) => x + r > t.x0 && x - r < t.x1 && y + r > t.y0 && y - r < t.y1);
    },
  };

  const maxTerrace = MAX_TERRACE / m(1) - 0.1;
  /** Everything laid since (`fromVolume`, `fromElement`) raised (negative: lowered) `rise` metres */
  const lift = (fromVolume: number, fromElement: number, rise: number, behind = -Infinity): void => {
    if (Math.abs(rise) < 1e-6) return;
    for (const v of body.volumes) {
      if (!v.open || v.id < fromVolume || v.y < Y(behind) - 1e-6) continue;
      v.terrace = m(Math.max(-maxTerrace, Math.min(maxTerrace, rise + (v.terrace ?? 0) / m(1))));
      // A ramp (a sloped car park) goes up or down whole: both its edges.
      if (v.ramp !== undefined) v.ramp = m(Math.max(-maxTerrace, Math.min(maxTerrace, rise + v.ramp / m(1))));
    }
    for (const el of elements) if (el.id >= fromElement && !FOLLOWS_GROUND.has(el.kind) && el.y >= Y(behind) - 1e-6) el.z += m(rise);
  };
  /** A retaining wall in stone from (x0, y0) to (x1, y1) */
  const retain = (x0: number, y0: number, x1: number, y1: number): void => {
    const h = backLevel > 0 ? backLevel + 0.15 : 0.95;
    const alongY = Math.abs(x1 - x0) < Math.abs(y1 - y0);
    const length = alongY ? y1 - y0 : x1 - x0;
    const n = Math.ceil(length / 20);
    for (let k = 0; k < n && length > 0.4; k++) {
      const a = k / n, b = (k + 1) / n;
      if (alongY) lot.put('slab', x0, y0 + (y1 - y0) * (a + b) / 2, 1, (y1 - y0) / n, 0.3, h, 0, RETAINING);
      else lot.put('slab', x0 + (x1 - x0) * (a + b) / 2, y0, 0, (x1 - x0) / n, 0.3, h, 0, RETAINING);
    }
  };
  /** A flight `width` wide from the street floor's level at `y` to the back level beyond it, at `x`. */
  const flightBack = (x: number, y: number, width: number): void => {
    const risers = Math.max(2, Math.round(Math.abs(backLevel) / STEP_RISE_M));
    const run = (risers + 1) * STEP_RUN_M;
    taken.push({ x0: x - width / 2, y0: y, x1: x + width / 2, y1: y + run });
    if (backLevel > 0) lot.put('stair', x, y + run / 2, 0, width, run, backLevel, 0, RETAINING);
    else lot.put('stair', x, y + run / 2, 2, width, run, -backLevel, backLevel, RETAINING);
  };

  /** The yard from `y0` back to `y1` laid as a terrace `fall` metres above (or below) the floor, rounded to whole risers */
  const stepYard = (y0: number, y1: number, fall: number, fromVolume: number, fromElement: number, stairX: number, base = 0): void => {
    const room = maxTerrace - Math.max(0, Math.sign(fall) * base);
    const risers = Math.min(TERRACE_MAX_RISERS, Math.round(Math.abs(fall) * 0.85 / STEP_RISE_M), Math.floor(room / STEP_RISE_M));
    if (risers < 4) return;
    const rise = risers * STEP_RISE_M * Math.sign(fall);
    const run = (risers + 1) * STEP_RUN_M;
    if (y1 - y0 < run + 2 || W < 6) return;
    // The flight lands on open lawn, as near the building's middle as it can: never in the pool, on a path or a paved corner
    const flightClear = (x: number): boolean => {
      const fx0 = x - 1.05, fx1 = x + 1.05, fy0 = y0 + 0.05, fy1 = y0 + run + 0.5;
      if (taken.some((t) => fx0 < t.x1 && t.x0 < fx1 && fy0 < t.y1 && t.y0 < fy1)) return false;
      return fall > 0 ? lot.fits('stair', x, y0 + run / 2, 0, 1.3, run, risers * STEP_RISE_M, 0)
        : lot.fits('stair', x, y0 + run / 2, 2, 1.3, run, risers * STEP_RISE_M, -risers * STEP_RISE_M);
    };
    let sx: number | null = null;
    for (let d = 0; d <= W && sx === null; d += 0.5) {
      for (const x of [stairX + d, stairX - d]) if (x >= 1.2 && x <= W - 1.2 && flightClear(x)) { sx = x; break; }
    }
    if (sx === null) return;
    const inYard = (yy: number): boolean => yy >= Y(y0) - 1e-6;
    for (const v of body.volumes) if (v.open && v.id >= fromVolume && inYard(v.y)) v.terrace = m(rise);
    // What stands on the platform and is not laid on the ground as it goes
    for (const el of elements) if (el.id >= fromElement && inYard(el.y) && !FOLLOWS_GROUND.has(el.kind)) el.z += m(rise);
    // The steps' place and the wall's line cleared of the garden's parts.
    const clear = (el: BuildingElement): boolean => {
      if (el.id < fromElement || BOUNDARY_SET.has(el.kind)) return false;
      const ex = el.x / m(1) + W / 2, ey = el.y / m(1);
      const half = Math.max(el.w, el.d) / m(1) / 2;
      const onWall = Math.abs(ey - y0) < half + 0.4;
      const onStair = Math.abs(ex - sx) < half + 1 && ey > y0 - 0.5 && ey < y0 + run + 0.5;
      return onWall || onStair;
    };
    elements.splice(0, elements.length, ...elements.filter((el) => !clear(el)));
    const stone = RETAINING;
    // The flight first, into the higher platform: up the slope (it goes down to the front, `facing` 0), or down it
    if (rise > 0) lot.put('stair', sx, y0 + run / 2, 0, 1.3, run, rise, 0, stone);
    else lot.put('stair', sx, y0 + run / 2, 2, 1.3, run, -rise, rise, stone);
    // The wall: from the lower platform up to the higher one and a hand's breadth over it; a guard rail's height over a drop.
    const wallH = rise > 0 ? rise + 0.15 : 0.95;
    for (const [a, b] of [[0.15, sx - 0.75], [sx + 0.75, W - 0.15]] as const) {
      if (b - a < 0.4) continue;
      const n = Math.ceil((b - a) / 20);
      for (let k = 0; k < n; k++) {
        const pa = a + ((b - a) * k) / n, pb = a + ((b - a) * (k + 1)) / n;
        lot.put('slab', (pa + pb) / 2, y0 - 0.15, 0, pb - pa, 0.3, wallH, 0, stone);
      }
    }
  };

  // ---- the strips beside the building: what part of each is drive, and what path
  const strip = (side: 'left' | 'right'): { drive: Rect | null; walk: Rect | null; garden: Rect | null } => {
    const s = side === 'left' ? left : right;
    const x0 = side === 'left' ? 0 : W - s.width, x1 = side === 'left' ? s.width : W;
    const out = { drive: null as Rect | null, walk: null as Rect | null, garden: null as Rect | null };
    const driveW = s.use === 'drivePath' ? s.width - FOOTPATH : s.width;
    if (s.use === 'drive' || s.use === 'drivePath') {
      out.drive = side === 'left' ? { x0, y0: 0, x1: x0 + driveW, y1: Bk } : { x0: x1 - driveW, y0: 0, x1, y1: Bk };
    }
    if (s.use === 'drivePath') out.walk = side === 'left' ? { x0: x0 + driveW, y0: F, x1, y1: Bk } : { x0, y0: F, x1: x0 + FOOTPATH, y1: Bk };
    if (s.use === 'path') out.walk = { x0, y0: F, x1, y1: Bk };
    if (s.use === 'garden') out.garden = { x0, y0: F, x1, y1: Bk };
    return out;
  };
  const L = strip('left'), R = strip('right');
  const drives = [L.drive, R.drive].filter((r): r is Rect => r !== null);
  const walks = [L.walk, R.walk].filter((r): r is Rect => r !== null);
  // Which drives go down or up as a ramp (to a yard or a garage at a level of its own).
  const garage = split && hill?.garage ? hill.garage : null;
  const ramp = split ? yardRamp(plan) ?? (garage ? garageRamp(plan) : null) : null;
  for (const r of drives) {
    // The drive less a hand's width each side
    const outer = ramp ? 0.5 : 0.35;
    keepClear.push({ x0: r.x0 + (r.x0 < W / 2 ? outer : 0.35), y0: 0, x1: r.x1 - (r.x0 < W / 2 ? 0.35 : outer), y1: Bk });
    if (back.use === 'parking') keepClear.push({ x0: r.x0, y0: Bk - 0.5, x1: r.x1 + 0.5, y1: Math.min(D, Bk + (back.rows === 2 ? STALL + AISLE : AISLE)) });
  }
  const door = env.x0 + made.entrance;
  const backDoor = made.backDoor !== undefined ? env.x0 + made.backDoor : null;
  // The people's gates as the boundary will place them
  const peopleGate = plan.kind === 'shop' || plan.kind === 'office' ? 2 : plan.kind === 'house' ? 1.2 : 1.6;
  if (F > 0) gateWays.push({ x0: door - peopleGate / 2 - 0.5, x1: door + peopleGate / 2 + 0.5 });
  else for (const w of walks) gateWays.push({ x0: w.x0 - 0.5, x1: w.x1 + 0.5 });
  const isHouse = plan.kind === 'house';
  const driveSurface: LotSurface = isHouse ? 'concrete' : plan.kind === 'industry' ? 'concrete' : 'asphalt';

  // ---- what the building leaves of its envelope: a terrace, a court garden
  for (const f of made.free) {
    const r = { x0: env.x0 + f.x0, y0: env.y0 + f.y0, x1: env.x0 + f.x1, y1: env.y0 + f.y1 };
    // A court behind the step of a split-level building is at its back level
    const raised = split !== null && r.y0 >= split.y - 1e-6;
    const fromVolume = nextVolume, fromElement = nextElement;
    furnishFree(r);
    if (raised) {
      lift(fromVolume, fromElement, backLevel);
      if (r.x0 <= env.x0 + 1e-6 && left.width > 0) retain(env.x0 + 0.15, r.y0, env.x0 + 0.15, r.y1);
      if (r.x1 >= env.x1 - 1e-6 && right.width > 0) retain(env.x1 - 0.15, r.y0, env.x1 - 0.15, r.y1);
    }
  }
  function furnishFree(r: Rect): void {
    if (plan.kind === 'industry') {
      lot.surface(r, 'asphalt');
      for (let x = r.x0 + 0.3; x + 2.5 <= r.x1 - 0.2; x += 2.5) lot.put('parking', x + 1.25, r.y0 + Math.min(2.5, (r.y1 - r.y0) / 2), 0, 2.5, Math.min(5, r.y1 - r.y0 - 0.2), 0.12);
    } else if (r.y1 - r.y0 <= 6 && r.x1 - r.x0 <= 8) {
      lot.surface(r, 'tiles');
      lot.put('planter', r.x1 - 0.8, r.y1 - 0.8, 0, 1, 1, 0.6);
      lot.put('bench', (r.x0 + r.x1) / 2, r.y1 - 0.5, 2, 1.4, 0.45, 0.45);
    } else {
      // A courtyard garden: a paved square in the middle of a lawn, benches, trees.
      const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
      const pw = Math.min(r.x1 - r.x0 - 2, 6), pd = Math.min(r.y1 - r.y0 - 2, 6);
      if (pw >= 2 && pd >= 2) {
        lot.path({ x0: cx - pw / 2, y0: cy - pd / 2, x1: cx + pw / 2, y1: cy + pd / 2 }, STONE_PATH);
        lot.put('bench', cx, cy - pd / 2 + 0.6, 0, 1.6, 0.5, 0.45);
        lot.put('bench', cx, cy + pd / 2 - 0.6, 2, 1.6, 0.5, 0.45);
      }
      for (const [x, y] of [[r.x0 + 1.5, r.y0 + 1.5], [r.x1 - 1.5, r.y1 - 1.5]] as const) lot.put('tree', x, y, 0, 3, 3, 5);
      lot.put('flowers', r.x1 - 1.2, r.y0 + 1.2, 0, 1.4, 1.4, 0.4);
    }
  }

  // ---- front zone
  if (F > 0) {
    const frontSurface: LotSurface = front.use === 'garden' ? 'grass' : front.use === 'carpad' ? 'grass'
      : front.use === 'forecourt' ? 'pavers' : front.use === 'plaza' ? 'paving' : 'asphalt';
    // Across the front: the drives' own surface where they cross it, the front's elsewhere.
    const cuts = drives.map((r) => [r.x0, r.x1] as const).sort((p, q) => p[0] - q[0]);
    let x = 0;
    for (const [a, b] of [...cuts, [W, W] as const]) {
      if (a - x >= 2) lot.surface({ x0: x, y0: 0, x1: a, y1: F }, frontSurface);
      if (b > a) lot.surface({ x0: a, y0: 0, x1: b, y1: F }, driveSurface);
      x = Math.max(x, b);
    }
    // The path from the gate to the door, and along the building to the side passages.
    if (front.use === 'garden' || front.use === 'carpad') {
      lot.path({ x0: door - 0.7, y0: 0, x1: door + 0.7, y1: F }, isHouse ? PAVERS_WARM : PAVERS);
      for (const w of walks) {
        const [a, b] = w.x0 < door ? [w.x0, door - 0.7] : [door + 0.7, w.x1];
        lot.path({ x0: a, y0: F - FOOTPATH, x1: b, y1: F }, isHouse ? PAVERS_WARM : PAVERS);
      }
      if (front.use === 'carpad') {
        // The car's pad in the front garden, on the side away from the path.
        const padLeft = door > W / 2;
        const pad = padLeft ? { x0: 0.3, y0: 0, x1: Math.min(3.3, door - 1), y1: F - 0.2 } : { x0: Math.max(door + 1, W - 3.3), y0: 0, x1: W - 0.3, y1: F - 0.2 };
        lot.path(pad, CONCRETE_PATH);
      }
      // Planting: shrubs inside the boundary, flowers under the windows, a tree if there is room.
      for (let px = 1.2; px < W - 1; px += 2.6) if (!lot.busy(px, 1.5) && !drives.some((r) => px > r.x0 - 1 && px < r.x1 + 1)) lot.put(rng.float() < 0.5 ? 'shrub' : 'flowers', px, 1.5, 0, 1.2, 1.2, 0.8);
      if (F >= 4) for (let px = env.x0 + 1.5; px < env.x1 - 1; px += 3.5) if (!lot.busy(px, F - 2.4, 1.2)) { lot.put('tree', px, F - 2.4, 0, 2.6, 2.6, 4.5); break; }
      for (let px = env.x0 + 1; px < env.x1 - 0.8; px += 2) if (!lot.busy(px, F - 0.6, 0.7)) lot.put('flowers', px, F - 0.6, 0, 1.6, 0.8, 0.35);
    } else if (front.use === 'forecourt') {
      // Tables outside the shop: benches in pairs, planters between, bollards at the kerb.
      for (let px = 1.6; px < W - 1.2; px += 3.6) {
        if (Math.abs(px - door) < 1.6) continue;
        if (rng.float() < 0.7 && F >= 3) {
          lot.put('bench', px, F * 0.35, 0, 1.3, 0.45, 0.45);
          lot.put('bench', px, F * 0.35 + 1.3, 2, 1.3, 0.45, 0.45);
        } else lot.put('planter', px, F * 0.5, 0, 1, 1, 0.6);
      }
      for (let px = 0.8; px < W - 0.5; px += 1.8) if (Math.abs(px - door) > 1.2 && !drives.some((r) => px > r.x0 - 0.3 && px < r.x1 + 0.3)) lot.put('bollard', px, 0.35, 0, 0.2, 0.2, 0.9);
      lot.put('bin', W - 1.2, F - 0.6, 0, 0.7, 0.6, 1);
    } else if (front.use === 'plaza') {
      // A plaza: trees in planters, benches facing the street, lamps, bollards.
      for (let px = 2.5; px < W - 2; px += 6) {
        if (Math.abs(px - door) < 3) continue;
        lot.put('planter', px, F * 0.45, 0, 2, 2, 0.6);
        lot.put('tree', px, F * 0.45, 0, 2.5, 2.5, 5);
        lot.put('bench', px, F * 0.45 + 1.6, 0, 1.6, 0.5, 0.45);
      }
      for (const px of [1, W - 1]) lot.put('lamp', px, F - 0.8, 0, 0.3, 0.3, 4.5);
      for (let px = 0.8; px < W - 0.5; px += 2) if (!drives.some((r) => px > r.x0 - 0.3 && px < r.x1 + 0.3)) lot.put('bollard', px, 0.35, 0, 0.2, 0.2, 0.9);
    } else if (front.use === 'apron') {
      // A works' front: visitors' stalls off the apron, the walk to the office painted across it.
      lot.path({ x0: door - 0.8, y0: 0, x1: door + 0.8, y1: F }, CONCRETE_PATH);
      // The stalls along the building, the aisle between them and the gate: only on an apron deep enough for both
      if (F >= STALL + AISLE - 1e-6) {
        for (let px = env.x0 + 0.3; px + 2.5 <= env.x1; px += 2.5) {
          if (Math.abs(px + 1.25 - door) < 2.2) continue;
          lot.put('parking', px + 1.25, F - 2.6, 2, 2.5, 5, 0.12);
        }
      }
      lot.put('lamp', door + 1.6, F - 0.6, 0, 0.3, 0.3, 5);
    }
  }

  // ---- side strips: the drives at the street floor's level all the way back (a car drives in off the street)
  for (const s of [L, R]) {
    if (s.drive) {
      const r = { ...s.drive, y0: Math.max(F, s.drive.y0) };
      if (ramp && r.y1 - ramp.start >= 2) {
        const r0 = Math.max(r.y0, ramp.start);
        lot.surface({ ...r, y1: ramp.start }, driveSurface);
        lot.ramp({ ...r, y0: r0 }, driveSurface, 0, backLevel);
        // Its outer side walled where it runs in a cut or on a fill
        const land = hill?.landAt;
        if (land) {
          const wx = r.x0 < W / 2 ? r.x0 + 0.35 : r.x1 - 0.35;
          const n = Math.max(1, Math.round((r.y1 - r0) / 2));
          for (let k = 0; k < n; k++) {
            const ya = r0 + ((r.y1 - r0) * k) / n, yb = r0 + ((r.y1 - r0) * (k + 1)) / n, yc = (ya + yb) / 2;
            const surface = (backLevel * (yc - r0)) / (r.y1 - r0);
            const cut = Math.max(land(wx, ya), land(wx, yb)) - surface, fill = surface - Math.min(land(wx, ya), land(wx, yb));
            if (cut > 0.3) lot.put('slab', wx, yc, 1, yb - ya, 0.25, cut + 0.15, 0, RETAINING);
            else if (fill > 0.3) lot.put('slab', wx, yc, 1, yb - ya, 0.25, 0.95, 0, RETAINING);
          }
        }
      } else lot.surface(r, driveSurface);
      // A house with its garage under the back has no carport on its ramp.
      if (isHouse && Bk - F >= 6 && !garage) {
        // A carport: a roof on four posts over the car, beside the house.
        const y0 = F + 0.3, y1 = F + 5.8, x0 = r.x0 + 0.05, x1 = r.x1 - 0.05;
        lot.put('slab', (x0 + x1) / 2, (y0 + y1) / 2, 0, x1 - x0, y1 - y0, 0.15, 2.4, mat('concrete', 0xd0ccc4));
        for (const [px, py] of [[x0 + 0.15, y0 + 0.15], [x1 - 0.15, y0 + 0.15], [x0 + 0.15, y1 - 0.15], [x1 - 0.15, y1 - 0.15]] as const) lot.put('pillar', px, py, 0, 0.18, 0.18, 2.4);
      }
      lot.put('drain', (r.x0 + r.x1) / 2, Math.min(Bk - 0.6, F + 7), 0, 0.5, 0.5, 0.1);
    }
  }
  const stripVolumes = nextVolume, stripElements = nextElement;
  for (const s of [L, R]) {
    if (s.walk) {
      // A passage between buildings is an alley, used as one (the player's order of 2026-10-05): old cobbles - its one paving
      lot.path(s.walk, isHouse ? CONCRETE_PATH : ALLEY_COBBLES);
      if (!isHouse && s.walk.y1 - s.walk.y0 > 12) lot.put('lamp', s.walk.x0 + 0.3, (s.walk.y0 + s.walk.y1) / 2, 0, 0.3, 0.3, 3.5);
      if (!isHouse) {
        const wx = (s.walk.x0 + s.walk.x1) / 2, len = s.walk.y1 - s.walk.y0;
        for (let py = s.walk.y0 + 2; py < s.walk.y1 - 1; py += 5) lot.put('drain', wx, py, 0, 0.35, 0.35, 0.1);
        const side = s.walk.x1 - wx > 0.6 ? s.walk.x1 - 0.35 : wx;
        if (len > 6) {
          lot.put('bin', side, s.walk.y1 - 2, 3, 1.1, 0.6, 1.1);
          lot.put('slab', side, s.walk.y1 - 3.4, 0, 0.6, 0.8, 0.5, 0, mat('wood', 0x7a5b3a));
          lot.put('slab', side, s.walk.y1 - 3.4, 0, 0.5, 0.6, 0.4, 0.5, mat('wood', 0x8b6a45));
        }
      }
    }
    if (s.garden) {
      const g = s.garden;
      // In two lawns where the building steps: the front one at the street floor's level, the back one at the back level.
      const cut = split && split.y > g.y0 + 2 && split.y < g.y1 - 2 ? split.y : null;
      if (cut !== null) { lot.surface({ ...g, y1: cut }, 'grass'); lot.surface({ ...g, y0: cut }, 'grass'); }
      else lot.surface(g, 'grass');
      for (let py = g.y0 + 2; py < g.y1 - 1.5; py += 5) lot.put(py % 10 < 5 ? 'tree' : 'shrub', (g.x0 + g.x1) / 2, py, 0, 2.4, 2.4, 4);
    }
  }
  if (split) {
    lift(stripVolumes, stripElements, backLevel, split.y);
    for (const s of [L, R]) {
      // The passage: a flight down (up) at the step.
      if (s.walk && split.y > s.walk.y0 + 1 && split.y < s.walk.y1 - 1) flightBack((s.walk.x0 + s.walk.x1) / 2, split.y, Math.max(0.8, s.walk.x1 - s.walk.x0 - 0.1));
      // The side garden: a retaining wall across it at the step.
      if (s.garden && split.y > s.garden.y0 + 2 && split.y < s.garden.y1 - 2) retain(s.garden.x0 + 0.1, split.y, s.garden.x1 - 0.1, split.y);
      // The drive, at the street floor to its end: a wall across its end where the back of the lot is at its own level
      if (s.drive && D - Bk > 0 && !ramp) retain(s.drive.x0 + 0.1, Bk + 0.15, s.drive.x1 - 0.1, Bk + 0.15);
    }
  }

  // ---- back zone (behind a split-level building, at its back level)
  const by0 = Bk, by1 = D;
  const backVolumes = nextVolume, backElements = nextElement;
  switch (back.use) {
    case 'yard': {
      const yardVolumes = nextVolume, yardElements = nextElement;
      // The terrace on the back door, the lawn, a service corner, a pool or beds, a shed.
      const drive = drives[0];
      const apronY = garage ? Math.min(by0, garage.y) : by0;
      const apron = garage && drive && by1 - apronY >= GARAGE_APRON + 1
        ? { x0: Math.min(drive.x0, garage.x - garage.w / 2), y0: apronY, x1: Math.max(drive.x1, garage.x + garage.w / 2 + 0.3), y1: apronY + GARAGE_APRON }
        : null;
      const terrace = apron
        ? (apron.x0 > W / 2 ? { x0: env.x0, y0: by0, x1: Math.max(env.x0, apron.x0), y1: Math.min(by1, by0 + 3) } : { x0: Math.min(env.x1, apron.x1), y0: by0, x1: env.x1, y1: Math.min(by1, by0 + 3) })
        : { x0: env.x0, y0: by0, x1: env.x1, y1: Math.min(by1, by0 + 3) };
      const lawnY0 = terrace.y1, depth = by1 - lawnY0;
      // On a hillside the lawn is stepped below (`stepYard`) with its flight at the building's middle
      const stepped = !!hill && Math.abs(hill.yard - backLevel) >= TERRACE_MIN;
      // With a garage's apron behind the house, the garden is stepped from behind the apron
      const stepFrom = apron ? Math.max(lawnY0, apron.y1) : lawnY0;
      const poolW = Math.min(8, W - 5);
      const stairMid = (env.x0 + env.x1) / 2;
      const poolX0 = !stepped ? (W - poolW) / 2
        : stairMid + 1.2 + poolW <= W - 0.5 ? stairMid + 1.2
          : stairMid - 1.2 - poolW >= 0.5 ? stairMid - 1.2 - poolW : null;
      const poolAt = depth >= 6 && W >= 11 && poolX0 !== null && rng.float() < 0.45
        ? { x0: poolX0, y0: lawnY0 + 1, x1: poolX0 + poolW, y1: lawnY0 + 4.5 } : null;
      // No pool where a car turns in to its garage.
      const pool = apron ? null : poolAt;
      if (apron) {
        // In two bands, so the garden stepped from behind the apron is laid on its own.
        lot.tile({ x0: 0, y0: by0, x1: W, y1: stepFrom }, [terrace, apron], 'grass');
        lot.tile({ x0: 0, y0: stepFrom, x1: W, y1: by1 }, [], 'grass');
      } else lot.tile({ x0: 0, y0: by0, x1: W, y1: by1 }, pool ? [terrace, pool] : [terrace], 'grass');
      lot.surface(terrace, 'tiles');
      if (apron) {
        lot.surface(apron, 'concrete');
        taken.push(apron);
        keepClear.push(apron);
        lot.put('drain', (apron.x0 + apron.x1) / 2, apron.y0 + 1.2, 0, 0.5, 0.5, 0.1);
      }
      if (pool) {
        lot.surface(pool, 'water');
        // Its deck: a paved edge on the terrace side, two loungers.
        lot.path({ x0: pool.x0, y0: lawnY0, x1: pool.x1, y1: pool.y0 }, mat('stone', 0xe0d8c8));
        // Two loungers on the deck beside it, clear of the coping.
        for (const k of [0, 1]) lot.put('bench', pool.x1 + 1.4, pool.y0 + 0.6 + k * 1.6, 3, 1.8, 0.65, 0.35, undefined, mat('wood', 0xe8e4dc));
      }
      taken.push(terrace);
      lot.put('bench', (terrace.x0 + terrace.x1) / 2 + 1.5, terrace.y0 + 1.6, 2, 1.4, 0.45, 0.45);
      const service = apron ? null : drives[0] ?? walks[0];
      if (service) {
        // The drive or the passage ends in a paved service corner: bins, a drain.
        const sx0 = service.x0, sx1 = Math.max(service.x1, service.x0 + 2.5);
        lot.path({ x0: sx0, y0: by0, x1: sx1, y1: Math.min(by1, by0 + 3) }, CONCRETE_PATH);
        lot.put('bin', (sx0 + sx1) / 2, by0 + 2.4, 2, 1.3, 0.65, 1.1);
        lot.put('drain', (sx0 + sx1) / 2, by0 + 1, 0, 0.5, 0.5, 0.1);
      }
      if (pool) taken.push(pool);
      else if (depth >= 4) {
        // Beds along the back wall.
        for (let px = 1.5; px < W - 1.5; px += 2.2) if (!lot.busy(px, by1 - 1.2)) lot.put('flowers', px, by1 - 1.2, 0, 1.6, 1.2, 0.4);
      }
      if (depth >= 5) {
        for (const px of [2.6, W - 2.6]) if (!lot.busy(px, by1 - 2.8, 1.5)) lot.put('tree', px, by1 - 2.8, 0, 3, 3, 5);
      }
      // A yard that is lived in (the player's order of 2026-10-05: "quintais muito pobres")
      if (depth >= 7 && W >= 9) {
        const shedX = rng.float() < 0.5 ? 1.6 : W - 1.6;
        if (!lot.busy(shedX, by1 - 1.4, 1.4)) {
          lot.put('wall', shedX, by1 - 1.4, 2, 2.4, 1.9, 2.1, undefined, mat('wood', 0x8a6a48));
          lot.put('slab', shedX, by1 - 1.4, 2, 2.8, 2.3, 0.12, 2.1, mat('metal', 0x5a5f61));
          lot.path({ x0: shedX - 0.5, y0: lawnY0, x1: shedX + 0.5, y1: by1 - 2.5 }, mat('stone', 0xbdb6a8));
        }
      }
      if (terrace.x1 - terrace.x0 >= 5 && terrace.y1 - terrace.y0 >= 2.5) {
        const px0 = terrace.x0 + 0.3, px1 = Math.min(terrace.x1 - 0.3, terrace.x0 + 5.5), py = terrace.y1 - 0.3;
        void py;
        lot.put('planter', (px0 + px1) / 2, (terrace.y0 + terrace.y1) / 2, 0, 1.4, 0.8, 0.75, undefined, mat('wood', 0x9c7a55));
      }
      if (!pool && depth >= 8) {
        const vx = W * (0.35 + rng.float() * 0.3);
        for (let k = 0; k < 3; k++) if (!lot.busy(vx + k * 1.3, lawnY0 + 3, 0.7)) lot.put('planter', vx + k * 1.3, lawnY0 + 3, 0, 0.9, 2.6, 0.35, undefined, mat('wood', 0x6b4f35));
      }
      // DO NOT drop this draw: it was the barbecue's, and without it every later piece of the yard
      rng.float();
      // A clothes line across the lawn: two posts and the line between.
      if (depth >= 6 && W >= 8 && rng.float() < 0.55) {
        const cy = lawnY0 + depth * (0.4 + rng.float() * 0.3), cx0 = W * (0.15 + rng.float() * 0.2), cx1 = cx0 + W * 0.4;
        if (!lot.busy(cx0, cy, 0.4) && !lot.busy(cx1, cy, 0.4)) {
          for (const cx of [cx0, cx1]) lot.put('pillar', cx, cy, 0, 0.08, 0.08, 1.9, undefined, mat('metal', 0x9aa0a2));
          lot.put('slab', (cx0 + cx1) / 2, cy, 0, cx1 - cx0, 0.03, 0.02, 1.8, mat('metal', 0xd8d8d0));
          lot.put('slab', (cx0 + cx1) / 2 - 0.6, cy, 0, 0.7, 0.03, 0.6, 1.2, mat('plaster', 0xc85a5a));
          lot.put('slab', (cx0 + cx1) / 2 + 0.5, cy, 0, 0.6, 0.03, 0.5, 1.3, mat('plaster', 0xe8e4d4));
        }
      }
      // The laundry sink by the back door and a water tank on its stand.
      if (W >= 7 && rng.float() < 0.6) {
        const tx = rng.float() < 0.5 ? W - 1.3 : 1.3, ty = by0 + 1.2;
        if (!lot.busy(tx, ty, 0.7)) {
          lot.put('wall', tx, ty, 0, 0.7, 0.55, 0.85, undefined, mat('concrete', 0xbdb8ae));
        }
      }
      for (const px of [1.5, W - 1.5]) {
        for (let py = lawnY0 + 1.5; py < by1 - 3; py += 3.2) if (!lot.busy(px, py, 0.9)) lot.put('shrub', px, py, 0, 1.3, 1.3, 1.4);
      }
      // The rest of a long back yard, filled the way back yards are (the player asked four times): an edicula
      if (depth >= 10 && W >= 8) {
        // Each yard its own: a character drawn for the lot and its pieces laid out from it, mirrored at random
        const far = by1 - 0.4;
        const flip = rng.float() < 0.5;
        const fx = (x: number): number => (flip ? W - x : x);
        const pick = rng.int(0, 4);
        const jit = (a: number): number => a + (rng.float() - 0.5) * 1.2;
        const put = (kind: ElementKind, x: number, y: number, f: Side, w: number, d: number, h: number, z?: number, mt?: MaterialSpec): boolean =>
          !lot.busy(fx(x), y, Math.max(w, d) / 2) && lot.put(kind, fx(x), y, f, w, d, h, z, mt);
        const edicula = (x: number, y: number, wide: number, deep: number): void => {
          if (!put('wall', x, y, 2, wide, deep, 2.6, undefined, mat('plaster', [0xe9dcc4, 0xd8c7a8, 0xc9d4c4, 0xe4cfc0][rng.int(0, 3)]!))) return;
          lot.put('slab', fx(x), y, 2, wide + 0.6, deep + 0.6, 0.22, 2.6, mat('tile', [0xa4533a, 0x8a4a35, 0x6e6a64][rng.int(0, 2)]!));
          for (let k = 1; k < 7; k++) {
            const t = k / 7, sx = (terrace.x0 + terrace.x1) / 2 + (fx(x) - (terrace.x0 + terrace.x1) / 2) * t;
            const sy = lawnY0 + (y - deep / 2 - 0.6 - lawnY0) * t;
            if (!lot.busy(sx, sy, 0.3)) lot.put('pavement', sx, sy, 0, 0.7, 0.55, 0.06, 0, mat('stone', 0xb8b2a6));
          }
        };
        const trees = (n: number, y: number): void => { for (let k = 0; k < n; k++) put('tree', jit(1.8 + k * ((W - 3.6) / Math.max(1, n - 1))), jit(y), 0, 3, 3, 3.6 + rng.float() * 1.8); };
        const beds = (x0: number, y0: number, cols: number, rows: number): void => {
          for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) put('planter', x0 + i * 1.5, y0 + j * 1.25, 0, 1.15, 0.85, 0.35, undefined, mat('wood', 0x7a5636));
        };
        const swing = (x: number, y: number): void => {
          if (!put('pillar', x - 1.1, y, 0, 0.1, 0.1, 2.2, undefined, mat('metal', 0x2f6e9e))) return;
          lot.put('pillar', fx(x + 1.1), y, 0, 0.1, 0.1, 2.2, undefined, mat('metal', 0x2f6e9e));
          lot.put('slab', fx(x), y, 0, 2.3, 0.08, 0.08, 2.2, mat('metal', 0x2f6e9e));
          // The seat hangs from the bar on two ropes.
          for (const k of [-1, 1]) lot.put('pillar', fx(x) + k * 0.22, y, 0, 0.02, 0.02, 1.7, 0.5, mat('metal', 0x8a8f94));
          lot.put('slab', fx(x), y, 0, 0.5, 0.25, 0.05, 0.45, mat('wood', 0x8a6040));
        };
        const table = (x: number, y: number): void => {
          if (!put('slab', x, y, 0, 1.0, 1.0, 0.05, 0.72, mat('wood', 0x8d6a46))) return;
          lot.put('pillar', fx(x), y, 0, 0.1, 0.1, 0.72, undefined, mat('metal', 0x3a3d40));
          for (const [oy, f] of [[0.95, 2], [-0.95, 0]] as const) lot.put('bench', fx(x), y + oy, f, 1.1, 0.42, 0.45, undefined, mat('wood', 0x7a5a3c));
        };
        const dogHouse = (x: number, y: number): void => {
          if (put('wall', x, y, 3, 1.0, 0.9, 0.8, undefined, mat('wood', 0x9a6a3f))) lot.put('slab', fx(x), y, 3, 1.2, 1.1, 0.12, 0.8, mat('tile', 0x8a3e2c));
        };
        const coop = (x: number, y: number): void => {
          if (put('fence', x, y, 0, 2.4, 1.6, 1.2, undefined, mat('metal', 0x8a9094))) lot.put('wall', fx(x + 0.7), y, 0, 0.9, 1.2, 1.0, undefined, mat('wood', 0x8c6a48));
        };
        const firewood = (x: number, y: number): void => { put('slab', x, y, 2, 1.6, 0.5, 0.9, 0, mat('wood', 0x6e4c2c)); };
        const bigTrampoline = (x: number, y: number): void => {
          if (!put('slab', x, y, 0, 2.6, 2.6, 0.08, 0.6, mat('panel', 0x24303a))) return;
          // On four legs at its rim.
          for (const [dx, dy] of [[-1.15, -1.15], [1.15, -1.15], [-1.15, 1.15], [1.15, 1.15]] as const) lot.put('pillar', fx(x) + dx, y + dy, 0, 0.06, 0.06, 0.6, 0, mat('metal', 0x3a3d40));
        };
        switch (pick) {
          case 0: // An orchard: rows of fruit trees, a bench under them.
            trees(3, far - 1.8); trees(2, lawnY0 + depth * 0.55); put('bench', jit(W / 2), lawnY0 + depth * 0.35, 2, 1.4, 0.45, 0.45);
            break;
          case 1: // A family yard: a swing, a trampoline, a dog house, a table.
            swing(jit(W * 0.6), lawnY0 + depth * 0.6); bigTrampoline(jit(W * 0.3), lawnY0 + depth * 0.7); dogHouse(W - 1.4, jit(lawnY0 + depth * 0.4)); table(jit(W * 0.4), lawnY0 + depth * 0.3);
            break;
          case 2: // A kitchen garden: beds in rows, a coop, compost, a fruit tree.
            beds(1.6, lawnY0 + depth * 0.35, Math.min(4, Math.floor((W - 3) / 1.5)), 3); coop(W - 2, far - 1.6); trees(1, far - 1.8); firewood(1.2, far - 0.5);
            break;
          case 3: // A worker's yard: an edicula, firewood, a dog house, a table by the door.
            edicula(W - 3.2, far - 2.2, 4.4 + rng.float(), 3.4 + rng.float()); firewood(1.2, far - 0.5); dogHouse(1.4, jit(lawnY0 + depth * 0.5)); table(jit(W * 0.35), lawnY0 + depth * 0.25);
            break;
          default: // A garden for leisure: an edicula with a deck, a table, fruit trees, beds.
            edicula(W / 2, far - 2.2, 5 + rng.float(), 3.6); put('pavement', W / 2, far - 4.6, 0, 5, 1.6, 0.08, 0, mat('wood', 0x9a7650));
            table(jit(W * 0.3), lawnY0 + depth * 0.45); trees(2, lawnY0 + depth * 0.65); beds(1.6, lawnY0 + depth * 0.2, 2, 1);
        }
      }
      // Potted plants along the terrace edge.
      for (let px = terrace.x0 + 0.6; px < terrace.x1 - 0.5; px += 1.6) if (!lot.busy(px, terrace.y1 - 0.4, 0.3)) lot.put('planter', px, terrace.y1 - 0.4, 0, 0.5, 0.5, 0.55);
      // On a hillside, the garden beyond the terrace is a platform of its own, stepped up or down the slope
      if (stepped) stepYard(stepFrom, by1, hill!.yard - backLevel, yardVolumes, yardElements, (env.x0 + env.x1) / 2, backLevel);
      break;
    }
    case 'parking': {
      // At its back level, a car park on a hillside keeps falling with the land at up to 1 in 20 across its depth
      const fall = split && hill?.backFall !== undefined ? Math.max(-PARK_SLOPE, Math.min(PARK_SLOPE, hill.backFall / Math.max(1, by1 - by0))) * (by1 - by0) : 0;
      if (Math.abs(fall) >= 0.1) lot.ramp({ x0: 0, y0: by0, x1: W, y1: by1 }, 'asphalt', 0, fall);
      else lot.surface({ x0: 0, y0: by0, x1: W, y1: by1 }, 'asphalt');
      // Rows along the back boundary (and along the building for two), clear of the drive's mouth.
      const mouth = drives[0];
      const rowY = [by1 - STALL / 2 - 0.15];
      if (back.rows === 2) rowY.push(by0 + STALL / 2);
      for (const [k, y] of rowY.entries()) {
        const facing: Side = k === 0 ? 2 : 0;
        // The row is split where the drive comes in and at the back door's path.
        const skips: [number, number][] = [];
        if (mouth && k === 1) skips.push([mouth.x0 - 0.2, mouth.x1 + 0.2]);
        if (backDoor !== null && k === 1) skips.push([backDoor - 0.9, backDoor + 0.9]);
        let x = 0.4;
        const end = W - 0.4;
        const runs: [number, number][] = [];
        for (const [a, b] of skips.sort((p, q) => p[0] - q[0])) { if (a > x) runs.push([x, a]); x = Math.max(x, b); }
        if (end > x) runs.push([x, end]);
        for (const [a, b] of runs) {
          const n = Math.floor((b - a) / 2.5);
          if (n < 1) {
            if (b - a >= 1.2) { lot.put('planter', (a + b) / 2, y, 0, Math.min(2, b - a - 0.2), 1.2, 0.5); lot.put('shrub', (a + b) / 2, y, 0, 1, 1, 0.9); }
            continue;
          }
          const used = n * 2.5, x0 = a + (b - a - used) / 2;
          lot.put('parking', x0 + used / 2, y, facing, used, STALL, 0.12);
          // A tree in a planter at the end of a long row.
          if (b - a - used >= 1.4) { lot.put('planter', b - (b - a - used) / 2, y, 0, Math.min(1.6, b - a - used - 0.2), 1.6, 0.5); }
        }
      }
      // The back door's walk across to the cars; lamps; a drain in the aisle; the bins by the drive.
      if (backDoor !== null) lot.path({ x0: backDoor - 0.7, y0: by0, x1: backDoor + 0.7, y1: by0 + (back.rows === 2 ? STALL : 1.2) }, PAVERS);
      const aisleY = back.rows === 2 ? by0 + STALL + AISLE / 2 : by0 + AISLE / 2;
      lot.put('drain', W / 2, aisleY, 0, 0.5, 0.5, 0.1);
      for (const px of [0.6, W - 0.6]) lot.put('lamp', px, aisleY, 0, 0.3, 0.3, 5);
      // What the back of a car park holds, a little of it on each lot
      if (back.rows === 1) {
        const spots: [number, number][] = [[1.2, by0 + 0.8], [W - 1.4, by0 + 0.8], [W / 2, by0 + 0.6]];
        const props: ((x: number, y: number) => void)[] = [
          (x, y) => { lot.put('bin', x, y, 0, 2.2, 1.4, 1.3, undefined, mat('metal', 0x2f5a3c)); },
          (x, y) => { for (let k = -1; k <= 1; k++) lot.put('railing', x + k * 0.6, y, 0, 0.05, 0.8, 0.8, undefined, mat('metal', 0x9aa0a4)); },
          (x, y) => { lot.put('wall', x, y, 0, 0.8, 0.4, 1.6, undefined, mat('metal', 0x8a9094)); },
          (x, y) => { lot.put('slab', x, y, 0, 1.2, 1.0, 0.14, 0, mat('wood', 0x9c7a50)); lot.put('slab', x, y, 0, 1.2, 1.0, 0.14, 0.14, mat('wood', 0x8b6c45)); },
          (x, y) => { for (const k of [-1, 1]) lot.put('pillar', x + k * 0.9, y, 0, 0.08, 0.08, 2.3, undefined, mat('metal', 0x4a4e52)); lot.put('slab', x, y, 0, 2.2, 1.4, 0.06, 2.3, mat('metal', 0x6a7074)); lot.put('bench', x, y, 0, 1.4, 0.45, 0.45); },
        ];
        for (const [x, y] of spots) if (rng.float() < 0.7 && !lot.busy(x, y, 1)) props[rng.int(0, props.length - 1)]!(x, y);
      }
      break;
    }
    case 'service': {
      lot.surface({ x0: 0, y0: by0, x1: W, y1: by1 }, 'concrete');
      const bd = backDoor ?? (env.x0 + env.x1) / 2;
      lot.put('bin', Math.min(W - 1.2, bd + 2.2), by0 + 0.6, 0, 1.4, 0.7, 1.1);
      // The back of a shop as it is: a skip, refuse sacks, stacked crates and pallets.
      lot.put('bin', Math.min(W - 1.4, bd + 4), by0 + 0.9, 0, 2.2, 1.4, 1.3, undefined, mat('metal', 0x2f5a3c));
      for (let k = 0; k < 3; k++) lot.put('rocks', Math.min(W - 0.6, bd + 2.6 + k * 0.5), by0 + 1.6, 0, 0.5, 0.45, 0.4, undefined, mat('plaster', 0x1c1d1f));
      lot.put('slab', Math.max(0.8, bd - 3), by0 + 1, 0, 1.2, 1.0, 0.14, 0, mat('wood', 0x9c7a50));
      lot.put('slab', Math.max(0.8, bd - 3), by0 + 1, 0, 0.6, 0.6, 0.45, 0.14, mat('wood', 0x7f6040));
      lot.put('drain', bd, by0 + (by1 - by0) / 2, 0, 0.5, 0.5, 0.1);
      lot.put('lamp', Math.max(0.6, bd - 1.6), by0 + 0.4, 0, 0.3, 0.3, 3.2);
      // A caged store of gas cylinders, a water tank on a stand, crates and a stack of empty drink crates
      if (W >= 8 && by1 - by0 >= 4) {
        const gx = 1.2, gy = by1 - 1;
        lot.put('fence', gx, gy, 0, 1.6, 0.9, 1.4, undefined, mat('metal', 0x7a8084));
        for (let k = 0; k < 3; k++) lot.put('pillar', gx - 0.5 + k * 0.5, gy, 0, 0.32, 0.32, 0.9, undefined, mat('metal', 0x3a6fb0));
        for (let k = 0; k < 4; k++) lot.put('slab', Math.min(W - 2.6, bd + 1.2) + (k % 2) * 0.45, by1 - 2.2, 0, 0.42, 0.32, 0.28, Math.floor(k / 2) * 0.28, mat('plaster', k % 2 ? 0xc9a227 : 0xb23b2e));
      }
      for (let px = env.x0 + 1; px < env.x1 - 1 && px < bd - 2.5; px += 2.4) lot.put('ac', px, by0 + 0.2, 2, 0.8, 0.35, 0.6, 2.6);
      if (by1 - by0 >= 5 && W >= 8) lot.put('planter', 1, by1 - 1, 0, 1, 1, 0.6);
      break;
    }
    case 'courtyard': {
      // Residents' garden: lawn, a paved square with benches, a play corner, trees.
      const play = by1 - by0 >= 8 && W >= 12 ? { x0: W - 5, y0: by1 - 4.5, x1: W - 1, y1: by1 - 0.5 } : null;
      lot.tile({ x0: 0, y0: by0, x1: W, y1: by1 }, play ? [play] : [], 'grass');
      if (play) { lot.surface(play, 'sand'); lot.put('bench', play.x0 - 0.6, (play.y0 + play.y1) / 2, 1, 1.4, 0.45, 0.45); taken.push(play); }
      const cx = (env.x0 + env.x1) / 2;
      if (backDoor !== null) lot.path({ x0: backDoor - 0.7, y0: by0, x1: backDoor + 0.7, y1: by0 + 2 }, PAVERS);
      lot.path({ x0: cx - 3, y0: by0 + 2, x1: cx + 3, y1: Math.min(by1 - 0.5, by0 + 6) }, STONE_PATH);
      lot.put('bench', cx - 1.5, by0 + 4, 0, 1.6, 0.5, 0.45);
      lot.put('bench', cx + 1.5, by0 + 4, 0, 1.6, 0.5, 0.45);
      for (const w of walks) lot.path({ x0: w.x0, y0: by0, x1: w.x1, y1: by0 + 2 }, PAVERS);
      for (const px of [2.6, W - 2.6]) if (!lot.busy(px, by1 - 2.8, 1.4)) lot.put('tree', px, by1 - 2.8, 0, 3, 3, 5);
      lot.put('bin', 1.2, by0 + 0.6, 0, 1.4, 0.7, 1.1);
      break;
    }
    case 'loading': {
      lot.surface({ x0: 0, y0: by0, x1: W, y1: by1 }, 'concrete');
      // Lorry bays at the loading doors
      const dockDepth = Math.min(12, by1 - by0 - 0.5);
      const doors = loadingDoors(body as Building, Y(by0)).map((d) => ({ x: d.x / m(1) + W / 2, y: d.y / m(1) })).sort((p, q) => p.x - q.x);
      let last = -Infinity;
      for (const door of doors) {
        // A door near the lot's edge: its dock moved in off the boundary, by no more than a bay's margin.
        const x = Math.max(0.3 + DOCK / 2, Math.min(W - 0.3 - DOCK / 2, door.x)), y = door.y;
        if (Math.abs(x - door.x) > 0.6 || x - last < DOCK + 0.5) continue;
        // From the wall the door is in (a hall's back may stand a hand into the yard).
        const y0 = Math.max(by0, y), depth = Math.min(dockDepth, by1 - y0 - 0.5);
        if (!lot.put('parking', x, y0 + depth / 2, 0, DOCK, depth, 0.12)) continue;
        lot.put('bollard', x - DOCK / 2 - 0.25, by0 + 0.5, 0, 0.25, 0.25, 1);
        last = x;
      }
      // A hall with no loading door on the yard: bays along its back as before.
      if (last === -Infinity) for (let px = env.x0 + 0.5; px + DOCK <= env.x1 - 0.3; px += 4.5) {
        lot.put('parking', px + DOCK / 2, by0 + 6, 0, DOCK, dockDepth, 0.12);
        lot.put('bollard', px - 0.25, by0 + 0.5, 0, 0.25, 0.25, 1);
      }
      for (const px of [0.6, W - 0.6]) lot.put('lamp', px, (by0 + by1) / 2, 0, 0.3, 0.3, 6);
      lot.put('drain', W / 2, by0 + (by1 - by0) * 0.6, 0, 0.6, 0.6, 0.1);
      break;
    }
    default: break;
  }
  // Behind a split-level building the back zone is at its back level
  if (split) lift(backVolumes, backElements, backLevel);

  // ---- boundaries and gates The boundary walls stand right on the lot's edge
  const inset = 0.1;
  // Along the street the boundary stands as close to the footway as a part may (`touchesRoad`: 2 cm), whatever its thickness
  const frontAt = (kind: ElementKind | 'gate'): number => (kind === 'hedge' ? 0.7 : kind === 'fence' || kind === 'gate' ? 0.12 : 0.2) / 2 + 0.04;
  const boundary = ((): { front: ElementKind | null; frontH: number; frontBase: number; sides: ElementKind; sidesH: number } => {
    switch (plan.kind) {
      case 'house': {
        const style = rng.int(0, 2);
        return style === 0 ? { front: 'fence', frontH: 1.1, frontBase: 0.6, sides: 'wall', sidesH: 2 }
          : style === 1 ? { front: 'hedge', frontH: 1.1, frontBase: 0, sides: 'wall', sidesH: 1.9 }
          : { front: 'wall', frontH: 1.4, frontBase: 0, sides: 'wall', sidesH: 2 };
      }
      case 'flats':
      case 'tower': return { front: 'fence', frontH: 1.6, frontBase: 0.45, sides: 'wall', sidesH: 2.2 };
      case 'industry': return { front: 'fence', frontH: 2.4, frontBase: 0, sides: 'fence', sidesH: 2.4 };
      // A shop's forecourt behind a low railing, an office's plaza behind a railing on a low wall: closed as every lot is
      case 'shop': return { front: 'railing', frontH: 1, frontBase: 0, sides: 'wall', sidesH: 2.2 };
      default: return { front: 'fence', frontH: 1.4, frontBase: 0.45, sides: 'wall', sidesH: 2.2 };
    }
  })();
  // Front: across the whole frontage where nothing is built on it; gates at the path and the drives.
  const frontGaps: [number, number][] = [];
  const gates: { x: number; w: number }[] = [];
  // The people's gate on the path to the door, whatever is in front of it; a shop's and an office's as wide as a shop door.
  if (F > 0) gates.push({ x: door, w: peopleGate });
  // A works' apron has its visitors' stalls: a wide car gate onto it, beside the people's
  if (front.use === 'apron') gates.push({ x: door > W / 2 ? Math.max(3.4, door - 4.6) : Math.min(W - 3.4, door + 4.6), w: 6 });
  for (const r of drives) gates.push({ x: (r.x0 + r.x1) / 2, w: r.x1 - r.x0 - 0.4 });
  if (front.use === 'carpad') gates.push({ x: door > W / 2 ? 1.8 : W - 1.8, w: 2.8 });
  for (const w of walks) if (F === 0) gates.push({ x: (w.x0 + w.x1) / 2, w: w.x1 - w.x0 - 0.2 });
  // The gates first, and a gap in the wall only where a gate really went in: a gate refused
  for (const g of gates) {
    if (lot.put('gate', g.x, frontAt('gate'), 0, g.w, 0.12, plan.kind === 'industry' ? 2.2 : g.w > 2 ? 1.8 : 1.4)) frontGaps.push([g.x, g.w + 0.1]);
  }
  const builtFront = F === 0 ? [env.x0 - 0.05, env.x1 + 0.05] as const : null;
  const frontRun = (x0: number, x1: number): void => {
    if (boundary.front && F > 0) {
      if (boundary.frontBase > 0) lot.runX('wall', frontAt('wall'), x0, x1, boundary.frontBase, frontGaps);
      lot.runX(boundary.front, boundary.frontBase > 0 ? frontAt('wall') : frontAt(boundary.front), x0, x1, boundary.frontH, frontGaps, boundary.frontBase);
    } else if (F === 0 || boundary.front === null) {
      // The street front of a shop or a plaza is open; its side strips are closed by their gates.
      for (const s of [L, R]) for (const r of [s.drive, s.walk, s.garden]) {
        if (!r || r.x1 < x0 || r.x0 > x1) continue;
        if (F === 0 && s.garden) lot.runX('wall', frontAt('wall'), r.x0, r.x1, 1.6);
      }
    }
  };
  if (builtFront) { frontRun(0, builtFront[0]); frontRun(builtFront[1], W); } else frontRun(0, W);
  // Sides: full depth, except where the building stands on the boundary.
  const sideHalf = (boundary.sides === 'hedge' ? 0.7 : boundary.sides === 'fence' ? 0.12 : 0.2) / 2;
  /** A side on a second street (a corner lot) is closed as the front is: a low wall, a fence on it, a railing. */
  // Set in from the edge by its own thickness, as the front is (`frontAt`)
  const streetSide = (x: number, y0: number, y1: number): void => {
    const kind = boundary.front ?? 'wall';
    const at = (k: ElementKind): number => (x < W / 2 ? frontAt(k) : W - frontAt(k));
    const onBase = boundary.front !== null && boundary.frontBase > 0;
    if (onBase) lot.runY('wall', at('wall'), y0, y1, boundary.frontBase);
    lot.runY(kind, onBase ? at('wall') : at(kind), y0, y1, boundary.front ? boundary.frontH : 1.6, boundary.front ? boundary.frontBase : 0);
  };
  const isCorner = (x: number): boolean => plan.corner !== undefined && (plan.corner === 'left') === (x < W / 2);
  for (const [s, x] of [[left, sideHalf], [right, W - sideHalf]] as const) {
    const lowFront = plan.kind === 'house' || plan.kind === 'flats' ? Math.min(boundary.sidesH, 1.3) : boundary.sidesH;
    if (isCorner(x)) {
      if (s.use === 'attached') { if (F > 0) streetSide(x, inset, F); if (D - Bk > 0) streetSide(x, Bk, D - inset); }
      else streetSide(x, inset, D - inset);
    } else if (s.use === 'attached') {
      if (F > 0) lot.runY(boundary.sides, x, inset, F, lowFront);
      if (D - Bk > 0) lot.runY(boundary.sides, x, Bk, D - inset, boundary.sidesH);
    } else {
      if (F > 0) lot.runY(boundary.sides, x, inset, F, lowFront);
      lot.runY(boundary.sides, x, Math.max(F, inset), D - inset, boundary.sidesH);
    }
  }
  // Back.
  if (D - Bk > 0) lot.runX(boundary.sides, D - sideHalf, sideHalf, W - sideHalf, boundary.sidesH);
  // ---- the boundary made whole: every stretch of the lot's edge that no wall, fence, hedge, railing
  {
    const U = m(1);
    /** What closes the edge now: each boundary part grown by 0.3 m, the building's ground floor by 0.45 m (lot metres). */
    const covers = (): CoverBox[] => {
      const boxes: CoverBox[] = [];
      for (const e of elements) {
        if (!BOUNDARY_SET.has(e.kind)) continue;
        const across = e.facing === 1 || e.facing === 3;
        const hw = (across ? e.d : e.w) / U / 2 + 0.3, hd = (across ? e.w : e.d) / U / 2 + 0.3;
        boxes.push({ kind: 'centre', cx: e.x / U + W / 2, cy: e.y / U, hw, hd });
      }
      for (const v of body.volumes) {
        if (v.open || v.base !== 0) continue;
        const x0 = v.x / U + W / 2, y0 = v.y / U;
        boxes.push({ kind: 'span', x0: x0 - 0.45, x1: x0 + v.w / U + 0.45, y0: y0 - 0.45, y1: y0 + v.d / U + 0.45 });
      }
      return boxes;
    };
    /** The open stretches along an edge from 0 to `len` (`lotBoundaryRuns.ts`). */
    const openRuns = (len: number, along: 'x' | 'y', fixed: number): [number, number][] => openRunsAlong(len, along, fixed, covers());
    const frontKind = boundary.front ?? 'wall';
    for (const [a, b] of openRuns(W, 'x', 0.15)) {
      if (boundary.front && boundary.frontBase > 0) lot.runX('wall', frontAt('wall'), a, b, boundary.frontBase);
      lot.runX(frontKind, boundary.front && boundary.frontBase > 0 ? frontAt('wall') : frontAt(frontKind), a, b,
        boundary.front ? boundary.frontH : 1.6, [], boundary.front ? boundary.frontBase : 0);
    }
    for (const [a, b] of openRuns(W, 'x', D - 0.15)) lot.runX(boundary.sides, D - sideHalf, a, b, boundary.sidesH);
    const lowFront = plan.kind === 'house' || plan.kind === 'flats' ? Math.min(boundary.sidesH, 1.3) : boundary.sidesH;
    for (const x of [0.15, W - 0.15]) {
      for (const [a, b] of openRuns(D, 'y', x)) {
        const at = x < W / 2 ? sideHalf : W - sideHalf;
        if (isCorner(x)) { streetSide(at, Math.max(a, inset), Math.min(b, D - inset)); continue; }
        // Low beside the front garden, full height behind it.
        if (a < F) lot.runY(boundary.sides, at, Math.max(a, inset), Math.min(b, F), lowFront);
        if (b > F) lot.runY(boundary.sides, at, Math.max(a, F), Math.min(b, D - inset), boundary.sidesH);
      }
    }
  }
  // Nothing left in the air: a part whose posts were refused or cleared above
  const loose = unsupportedElements(probe());
  if (loose.size) elements.splice(0, elements.length, ...elements.filter((el) => !loose.has(el.id)));
  (body as { nextVolumeId?: number }).nextVolumeId = nextVolume;
  (body as { nextElementId?: number }).nextElementId = nextElement;
  return true;
}
