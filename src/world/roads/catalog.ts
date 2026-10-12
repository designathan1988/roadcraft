import { m } from '../units';
import { PARKING_DEPTH } from '../parking';
import { ROAD_TYPES } from '../roadTypes';
import type { CarriagewayMaterial } from '../roadSection';
import type { ProfileElement, RoadProfileSpec } from './profile';
import { type RoadTemplate, classTemplates } from './templates';

/**
 * THE ROAD CATALOGUE (docs/VIAS.md, the player's order of 2026-10-09): ready
 * roads to pick and draw with at once, by category, as Cities: Skylines
 * offers them (its roads menu: small, medium, large roads and highways, each
 * road with its lanes, speed and price per cell; Cities: Skylines II the same
 * categories with two-lane, one-way, parking, alley and divided variants -
 * skylines.paradoxwikis.com/Roads, cs2.paradoxwikis.com/Roads). Every road
 * here is a profile of the free profile (V1) on one of the game's classes, so
 * it builds with the same code as any road; the six classes are here too,
 * as they always were.
 */
export type CatalogCategory = 'streets' | 'avenues' | 'highways' | 'special' | 'mine';
export const CATALOG_CATEGORIES: readonly CatalogCategory[] = ['streets', 'avenues', 'highways', 'special', 'mine'];

export interface CatalogRoad extends RoadTemplate {
  readonly category: CatalogCategory;
}

const type = (id: string): number => ROAD_TYPES.findIndex((t) => t.id === id);

type Lane = Extract<ProfileElement, { kind: 'lane' }>;
interface Shape {
  /** Footway widths, metres; `flush` lays them level with the carriageway. */
  readonly walk: number | readonly [number, number];
  readonly flush?: boolean;
  readonly lane: number;
  /** Lanes towards A then towards B (one-way: one of them 0). */
  readonly back: number;
  readonly fwd: number;
  readonly median?: number;
  readonly medianFlush?: boolean;
  readonly medianMaterial?: 'grass' | 'concrete' | 'pavers';
  /** What runs by each kerb. */
  readonly left?: 'parking' | 'cycle';
  readonly right?: 'parking' | 'cycle';
  /** Bus lanes: the outer lane of each direction, or the inner one (a central corridor). */
  readonly bus?: 'outer' | 'inner';
  readonly speed: number;
  readonly priority: number;
  readonly carriageway?: CarriagewayMaterial;
}

/** A profile from a short description, left edge to right edge looking from A to B. */
export function shapeProfile(s: Shape): RoadProfileSpec {
  const [wl, wr] = typeof s.walk === 'number' ? [s.walk, s.walk] : s.walk;
  const e: ProfileElement[] = [];
  e.push({ kind: 'footway', width: m(wl), ...(s.flush ? { flush: true } : {}) });
  const kerb = (k: 'parking' | 'cycle' | undefined): void => {
    if (k === 'parking') e.push({ kind: 'parking', width: PARKING_DEPTH.parallel });
    if (k === 'cycle') e.push({ kind: 'cycle', width: PARKING_DEPTH.cycle });
  };
  kerb(s.left);
  const lane = (dir: Lane['dir'], i: number, count: number): Lane => {
    // i: 0 is the leftmost of its direction in the A-to-B view.
    const outer = dir === 'backward' ? i === 0 : i === count - 1;
    const inner = dir === 'backward' ? i === count - 1 : i === 0;
    const bus = count > 1 && ((s.bus === 'outer' && outer) || (s.bus === 'inner' && inner));
    return { kind: 'lane', width: m(s.lane), dir, ...(bus ? { use: 'bus' as const } : {}) };
  };
  for (let i = 0; i < s.back; i++) e.push(lane('backward', i, s.back));
  if (s.median) e.push({ kind: 'median', width: m(s.median), ...(s.medianMaterial ? { material: s.medianMaterial } : {}), ...(s.medianFlush ? { flush: true } : {}) });
  for (let i = 0; i < s.fwd; i++) e.push(lane('forward', i, s.fwd));
  kerb(s.right);
  e.push({ kind: 'footway', width: m(wr), ...(s.flush ? { flush: true } : {}) });
  return { elements: e, speedKmh: s.speed, priority: s.priority, ...(s.carriageway ? { carriageway: s.carriageway } : {}) };
}

const road = (id: string, category: CatalogCategory, cls: string, shape: Shape): CatalogRoad =>
  ({ id: `catalog:${id}`, nameKey: `catalog.${id}`, category, type: type(cls), profile: shapeProfile(shape) });

/** The ready roads, by category; the classes in theirs. */
export function catalogRoads(): CatalogRoad[] {
  const classes = new Map(classTemplates().map((t) => [t.id, t]));
  const cls = (id: string, category: CatalogCategory): CatalogRoad => ({ ...classes.get(`class:${id}`)!, category });
  return [
    // Streets
    cls('local', 'streets'),
    cls('urban', 'streets'),
    road('oneWay1', 'streets', 'local', { walk: 2, lane: 3, back: 0, fwd: 1, speed: 30, priority: 0 }),
    road('oneWay2', 'streets', 'urban', { walk: 2, lane: 3, back: 0, fwd: 2, speed: 40, priority: 1 }),
    road('parkingBoth', 'streets', 'urban', { walk: 2, lane: 3, back: 1, fwd: 1, left: 'parking', right: 'parking', speed: 40, priority: 1 }),
    road('parkingOne', 'streets', 'urban', { walk: 2, lane: 3, back: 1, fwd: 1, right: 'parking', speed: 40, priority: 1 }),
    road('cycleStreet', 'streets', 'urban', { walk: 2, lane: 3, back: 1, fwd: 1, left: 'cycle', right: 'cycle', speed: 40, priority: 1 }),
    road('greenStreet', 'streets', 'urban', { walk: 3, lane: 3, back: 1, fwd: 1, median: 2, medianMaterial: 'grass', speed: 40, priority: 1 }),
    road('wideWalks', 'streets', 'local', { walk: 4, lane: 3, back: 1, fwd: 1, speed: 30, priority: 0 }),
    road('narrow', 'streets', 'local', { walk: 1, lane: 3, back: 1, fwd: 1, speed: 30, priority: 0 }),
    road('shared', 'streets', 'local', { walk: 3, flush: true, lane: 3, back: 1, fwd: 1, speed: 20, priority: 0, carriageway: 'cobble' }),
    road('cobble', 'streets', 'local', { walk: 2, lane: 3, back: 1, fwd: 1, speed: 30, priority: 0, carriageway: 'cobble' }),
    // Avenues
    cls('avenue', 'avenues'),
    road('avenueMedian', 'avenues', 'avenue', { walk: 3, lane: 3, back: 2, fwd: 2, median: 2, medianMaterial: 'grass', speed: 60, priority: 2 }),
    road('avenue6', 'avenues', 'avenue', { walk: 3, lane: 3, back: 3, fwd: 3, median: 3, medianMaterial: 'grass', speed: 60, priority: 2 }),
    road('avenueCycle', 'avenues', 'avenue', { walk: 3, lane: 3, back: 2, fwd: 2, left: 'cycle', right: 'cycle', median: 2, medianMaterial: 'grass', speed: 60, priority: 2 }),
    road('avenueParking', 'avenues', 'avenue', { walk: 3, lane: 3, back: 2, fwd: 2, left: 'parking', right: 'parking', speed: 50, priority: 2 }),
    road('avenueBusSide', 'avenues', 'avenue', { walk: 3, lane: 3, back: 2, fwd: 2, median: 2, medianMaterial: 'grass', bus: 'outer', speed: 60, priority: 2 }),
    road('avenueBusCentre', 'avenues', 'avenue', { walk: 3, lane: 3, back: 3, fwd: 3, median: 2, medianMaterial: 'concrete', bus: 'inner', speed: 60, priority: 2 }),
    road('avenueOneWay3', 'avenues', 'avenue', { walk: 3, lane: 3, back: 0, fwd: 3, speed: 60, priority: 2 }),
    road('avenueOneWay4', 'avenues', 'avenue', { walk: 3, lane: 3, back: 0, fwd: 4, speed: 60, priority: 2 }),
    cls('boulevard', 'avenues'),
    // Highways
    cls('highway', 'highways'),
    road('highway6', 'highways', 'highway', { walk: 1, lane: 4, back: 3, fwd: 3, median: 3, medianMaterial: 'concrete', speed: 110, priority: 4 }),
    road('highwayOneWay2', 'highways', 'highway', { walk: 1, lane: 4, back: 0, fwd: 2, speed: 100, priority: 4 }),
    road('highwayOneWay3', 'highways', 'highway', { walk: 1, lane: 4, back: 0, fwd: 3, speed: 110, priority: 4 }),
    road('expressway2', 'highways', 'highway', { walk: 1, lane: 4, back: 1, fwd: 1, median: 2, medianMaterial: 'concrete', speed: 80, priority: 4 }),
    // Special
    cls('ramp', 'special'),
    road('ramp2', 'special', 'ramp', { walk: 1, lane: 4, back: 0, fwd: 2, speed: 60, priority: 3 }),
    road('rural', 'special', 'local', { walk: 1, lane: 3, back: 1, fwd: 1, speed: 40, priority: 0, carriageway: 'cobble' }),
    road('concreteRoad', 'special', 'urban', { walk: 2, lane: 4, back: 1, fwd: 1, speed: 60, priority: 1, carriageway: 'concrete' }),
  ];
}
