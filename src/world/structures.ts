import { ROAD_TUNING } from './roads/tuning';
import { m } from './units';

/** The structural levels a road can be built at. */
export type RoadStructure = 'ground' | 'elevated' | 'bridge' | 'tunnel';

/** Structure ids a saved map may still carry, and what each one loads as. */
const LEGACY_STRUCTURES: Readonly<Record<string, RoadStructure>> = { viaduct: 'elevated' };

/** The structure a stored id stands for today, or null when it is not one. */
export function migrateStructure(value: unknown): RoadStructure | null {
  if (isRoadStructure(value)) return value;
  if (typeof value !== 'string') return null;
  return LEGACY_STRUCTURES[value] ?? null;
}

export interface RoadStructureSpec {
  readonly id: RoadStructure;
  /** Translation key for the structure's name, resolved by `ui/i18n`. */
  readonly key: string;
  /** Height the deck keeps above the highest ground under the span, in units. */
  readonly clearance: number;
  /** Thickness of the structural deck drawn under the asphalt. */
  readonly deck: number;
  /** Whether the structure stands on piers. */
  readonly supports: boolean;
}

/** Clear height inside a tunnel bore, in units (about 4.4 m). */
export const TUNNEL_HEADROOM = m(4.4);
/** Thickness of the arch over the bore. */
export const TUNNEL_ARCH = m(0.6);
/** Depth of a tunnel's floor below the lowest ground along its span. */
const TUNNEL_DEPTH = TUNNEL_HEADROOM + TUNNEL_ARCH + m(2);
/** Cover at which the ground closes over the road: the mouth of the bore. */
const TUNNEL_CLOSE = TUNNEL_HEADROOM + TUNNEL_ARCH + m(0.4);
export const TUNNEL_ROOF = TUNNEL_CLOSE - m(0.16);
export const TUNNEL_BORE = TUNNEL_CLOSE + m(0.16);
/** Cover at which the portal stands: where the ground FIRST rises over the road. */
export const TUNNEL_PORTAL_COVER = m(0.6);
/** Design gradient of a tunnel's approach ramps. */
export const TUNNEL_GRADE = ROAD_TUNING.grade.tunnel;

export const ROAD_STRUCTURES: readonly RoadStructureSpec[] = [
  { id: 'ground', key: 'structure.ground', clearance: 0, deck: m(0.22), supports: false },
  // Fourteen units (5.6 m) to the deck SURFACE, of which the structure itself takes 3.0
  { id: 'elevated', key: 'structure.elevated', clearance: ROAD_TUNING.clearance.elevated, deck: m(1.04), supports: true },
  { id: 'bridge', key: 'structure.bridge', clearance: ROAD_TUNING.clearance.bridge, deck: m(0.96), supports: true },
  { id: 'tunnel', key: 'structure.tunnel', clearance: -TUNNEL_DEPTH, deck: m(0.24), supports: false },
] as const;

/** Clearance a road at grade keeps over the terrain it is laid on. */
export const ROAD_GROUND_CLEARANCE = m(0.12);

export const roadStructure = (id: RoadStructure): RoadStructureSpec =>
  ROAD_STRUCTURES.find((value) => value.id === id) ?? (ROAD_STRUCTURES[0] as RoadStructureSpec);

export const isRoadStructure = (value: unknown): value is RoadStructure =>
  value === 'ground' ||
  value === 'elevated' ||
  value === 'bridge' ||
  value === 'tunnel';

/** Deck over the ground past which a road at grade stands on piers (2 m): the renderer builds them past it */
export const RAISED_LIFT = m(2);

/** True for the structures that stand clear of the ground on piers. */
export const isRaised = (id: RoadStructure): boolean =>
  id === 'elevated' || id === 'bridge';

/** True for the structures that run BELOW the ground. */
export const isSunken = (id: RoadStructure): boolean => id === 'tunnel';

/** Whether tunnels are part of the game at all. */
export const TUNNELS_DRAWN = true;
