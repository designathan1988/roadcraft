import { kmh, m } from './units';
import { PARKING_DEPTH, parkingAllowed, type ParkingKind, type SegmentParking } from './parking';
import type { SegmentDirection } from './doc';
import type { CentreLine, RoadSection, LaneLine, LaneTurnRule, LaneUse, SectionMaterials } from './roadSection';

/**
 * Surface levels, in painting order.
 *
 * The whole point of naming them is that a junction computes a *separate*
 * polygon, with a *separate* trim distance, for each one. The V6 monolith
 * filled seven layers that all stopped at the same distance along every leg,
 * which is why no kerb or footway existed around any junction (defect 1.2).
 */
export enum Level {
  Shadow = 0,
  Casing = 1,
  Sidewalk = 2,
  Curb = 3,
  Asphalt = 4,
  Markings = 5,
  JunctionInterior = 6,
  JunctionDetail = 7,
  Median = 8,
  Overlay = 9,
}

/** Levels that carry a filled surface built from roads and junctions alike. */
export const SURFACE_LEVELS = [
  Level.Casing,
  Level.Sidewalk,
  Level.Curb,
  Level.Asphalt,
] as const;

export type SurfaceLevel = (typeof SURFACE_LEVELS)[number];

export type MarkingStyle = 'none' | 'center' | 'lanes';

export interface RoadType {
  readonly id: string;
  /** Translation key for the class name, resolved by `ui/i18n`. */
  readonly nameKey: string;
  /** Translation key for the one-line description under the name. */
  readonly subKey: string;
  /**
   * Lane count to substitute into `subKey` when the class has been overridden.
   *
   * Null for a stock class, whose description needs no numbers. The model does
   * not format text — it states what the text is about and lets the interface
   * layer render it in whatever language is showing.
   */
  readonly subLanes: number | null;
  /** Whether an overridden description is for a one-way road. */
  readonly subOneWay: boolean;
  /**
   * Carriageway width, kerb face to kerb face, in world units: the travel
   * lanes, the median and any parking lanes.
   */
  readonly width: number;
  /** Total lane count, both directions. */
  readonly lanes: number;
  /**
   * Footway width, in world units: on each side, or the wider one when the
   * sides differ (`sidewalkLeft`/`sidewalkRight`, read through `footwayOn`).
   */
  readonly sidewalk: number;
  /** The footways left and right of a -> b when they differ (docs/VIAS.md V1); absent: `sidewalk` both. */
  readonly sidewalkLeft?: number;
  readonly sidewalkRight?: number;
  /** A footway level with the carriageway, without a kerb (a shared surface). */
  readonly flushLeft?: boolean;
  readonly flushRight?: boolean;
  /** A central reservation painted on the carriageway, not kerbed. */
  readonly medianFlush?: boolean;
  /** What its elements are paved with; the class's own look when absent. */
  readonly materials?: SectionMaterials;
  /** Central reservation width, in world units. Zero when absent. */
  readonly median: number;
  /**
   * Parking lanes inside the kerbs, left and right of the a -> b direction:
   * their depth from the kerb face (world units, 0 when none) and their kind.
   * Stock classes have none; a segment adds them (`RoadSegment.parking`).
   */
  readonly parkingLeft: number;
  readonly parkingRight: number;
  readonly parkingLeftKind: ParkingKind;
  readonly parkingRightKind: ParkingKind;
  /** Free-flow speed, in world units per second. */
  readonly speedLimit: number;
  /** Higher wins right of way at unsignalised junctions. */
  readonly priorityRank: number;
  readonly turnsForward?: readonly LaneTurnRule[];
  readonly turnsBackward?: readonly LaneTurnRule[];
  /** Lane uses and lines from the section (docs/VIAS.md V4, `RoadSection.useForward`). */
  readonly useForward?: readonly LaneUse[];
  readonly useBackward?: readonly LaneUse[];
  readonly linesForward?: readonly LaneLine[];
  readonly linesBackward?: readonly LaneLine[];
  /** The line between the directions (V6, `RoadSection.centreLine`). */
  readonly centreLine?: CentreLine;
  readonly markings: MarkingStyle;
  readonly color: string;
  readonly edge: string;
  readonly curb: string;
  readonly line: string;
}

/**
 * The colour of a painted line.
 *
 * These lived in `ui/overlay/palette.ts`, and that made `world` import `ui` -
 * the one import cycle in the project, and a violation of the layer order in
 * CLAUDE.md (Layers). A line's colour is a property of the ROAD CLASS, not of
 * the interface: the same yellow centre line has to be produced by the mesh
 * builder, by the minimap and by the overlay, and three consumers in three
 * layers mean the value belongs beside the class it describes.
 */
export const markingColor = (rt: RoadType): string => rt.line;

/**
 * The line between two lanes running the SAME way: always white.
 *
 * `line` is the class's centre-line colour, and for the two street classes it
 * is yellow - the colour that tells a driver the traffic beyond it comes the
 * other way. Every divider used to be painted in it, so a one-way street was
 * marked down its middle exactly like a two-way one, and read as one.
 */
export const LANE_LINE = '#eee8d7';


/** The kerb stone's width on top, beyond the carriageway edge: 15 cm, as a precast kerb. */
export const CURB_BAND = m(0.15);

/**
 * Height of the footway above the carriageway, world units.
 *
 * ONE number for the cross-section: the renderer lifts the footway band by it
 * and stands lamps, poles and pedestrians on it, and the elevation solver
 * counts it into a raised deck's depth. It used to be two constants of the
 * same value, `FOOTWAY_RISE` in render/roadSurfaces.ts and `FOOTWAY_DEPTH` in
 * world/elevation.ts, free to drift apart.
 */
export const FOOTWAY_RISE = m(0.15);
/**
 * Extra half-width of the casing beyond the footway edge: the grass verge that
 * carries the footway's edge down (or up) to the ground beside it, 1 m.
 */
export const CASING_BAND = m(1);

export const ROAD_TYPES: readonly RoadType[] = [
  {
    id: 'local',
    nameKey: 'road.local',
    subKey: 'road.sub.local',
    subLanes: null,
    subOneWay: false,
    width: m(6),
    lanes: 2,
    sidewalk: m(2),
    median: 0,
    parkingLeft: 0,
    parkingRight: 0,
    parkingLeftKind: 'none',
    parkingRightKind: 'none',
    speedLimit: kmh(30),
    priorityRank: 0,
    markings: 'none',
    color: '#5f6365',
    edge: '#aaa9a5',
    curb: '#d5d2cb',
    line: '#e1c45a',
  },
  {
    id: 'urban',
    nameKey: 'road.urban',
    subKey: 'road.sub.urban',
    subLanes: null,
    subOneWay: false,
    width: m(8),
    lanes: 2,
    sidewalk: m(2),
    median: 0,
    parkingLeft: 0,
    parkingRight: 0,
    parkingLeftKind: 'none',
    parkingRightKind: 'none',
    speedLimit: kmh(50),
    priorityRank: 1,
    markings: 'center',
    color: '#3a3d3f',
    edge: '#aaa7a2',
    curb: '#d2cec7',
    line: '#e1c45a',
  },
  {
    id: 'avenue',
    nameKey: 'road.avenue',
    subKey: 'road.sub.avenue',
    subLanes: null,
    subOneWay: false,
    width: m(14),
    lanes: 4,
    sidewalk: m(2),
    median: 0,
    parkingLeft: 0,
    parkingRight: 0,
    parkingLeftKind: 'none',
    parkingRightKind: 'none',
    speedLimit: kmh(60),
    priorityRank: 2,
    markings: 'lanes',
    color: '#35383a',
    edge: '#aaa7a1',
    curb: '#d3cfc7',
    line: '#eee8d7',
  },
  {
    id: 'boulevard',
    nameKey: 'road.boulevard',
    subKey: 'road.sub.boulevard',
    subLanes: null,
    subOneWay: false,
    width: m(18),
    lanes: 4,
    sidewalk: m(3),
    median: m(2),
    parkingLeft: 0,
    parkingRight: 0,
    parkingLeftKind: 'none',
    parkingRightKind: 'none',
    speedLimit: kmh(60),
    priorityRank: 3,
    markings: 'lanes',
    color: '#333638',
    edge: '#aaa69f',
    curb: '#d4cfc7',
    line: '#eee8d8',
  },
  {
    id: 'highway',
    nameKey: 'road.highway',
    subKey: 'road.sub.highway',
    subLanes: null,
    subOneWay: false,
    width: m(18),
    lanes: 4,
    sidewalk: m(1),
    median: m(2),
    parkingLeft: 0,
    parkingRight: 0,
    parkingLeftKind: 'none',
    parkingRightKind: 'none',
    speedLimit: kmh(100),
    priorityRank: 4,
    markings: 'lanes',
    color: '#343638',
    edge: '#aaa7a0',
    curb: '#c9c7c2',
    line: '#eee8d8',
  },
  {
    id: 'ramp',
    nameKey: 'road.ramp',
    subKey: 'road.sub.ramp',
    subLanes: null,
    subOneWay: true,
    width: m(4),
    lanes: 1,
    sidewalk: m(1),
    median: 0,
    parkingLeft: 0,
    parkingRight: 0,
    parkingLeftKind: 'none',
    parkingRightKind: 'none',
    speedLimit: kmh(60),
    priorityRank: 3,
    markings: 'none',
    color: '#3b3d3f',
    edge: '#aaa7a0',
    curb: '#c9c7c2',
    line: '#eee8d8',
  },
];

/** Street classes form the upgrade ladder; highway and access ramps are separate choices. */
export const LAST_UPGRADE_CLASS = 3;

export const roadType = (i: number): RoadType =>
  ROAD_TYPES[Math.max(0, Math.min(ROAD_TYPES.length - 1, i))] as RoadType;

/** Supported physical lane-count range for an individually configured road. */
export const MIN_TRAVEL_LANES = 1;
export const MAX_TRAVEL_LANES = 8;

/**
 * Resolves the physical road profile for a segment.
 *
 * A configured count is the total number of drivable lanes.  Two-way roads
 * therefore split it across directions, while one-way roads use all of it.
 * Older documents omit the count and retain their exact class profile.
 *
 * Parking lanes (`parking`, left and right of a -> b) widen the carriageway
 * kerb to kerb; the travel lanes keep their width and sit between them. A
 * kind the class cannot carry (`parkingAllowed`) is dropped.
 */
export function roadProfile(
  typeIndex: number,
  configuredLanes?: number | null,
  direction: SegmentDirection = 'both',
  section?: RoadSection,
  parking?: SegmentParking,
): RoadType {
  const travel = travelProfile(typeIndex, configuredLanes, direction, section);
  if (!parking) return travel;
  // A kind the class cannot carry is dropped.
  const fit = (kind: ParkingKind): ParkingKind => parkingAllowed(kind, travel) ? kind : 'none';
  const left = fit(parking.left);
  const right = fit(parking.right);
  if (left === 'none' && right === 'none') return travel;
  const parkingLeft = PARKING_DEPTH[left], parkingRight = PARKING_DEPTH[right];
  return {
    ...travel,
    width: travel.width + parkingLeft + parkingRight,
    parkingLeft,
    parkingRight,
    parkingLeftKind: left,
    parkingRightKind: right,
  };
}

function travelProfile(
  typeIndex: number,
  configuredLanes?: number | null,
  direction: SegmentDirection = 'both',
  section?: RoadSection,
): RoadType {
  const base = roadType(typeIndex);
  if (section) {
    const standard = travelProfile(typeIndex, configuredLanes, direction);
    const median = direction === 'both' && standard.lanes >= 2 ? section.median : 0;
    return {
      ...standard,
      width: standard.lanes * section.laneWidth + median,
      sidewalk: section.sidewalk,
      ...(section.sidewalkLeft !== undefined ? { sidewalkLeft: section.sidewalkLeft, sidewalkRight: section.sidewalkRight } : {}),
      ...(section.flushLeft ? { flushLeft: true } : {}),
      ...(section.flushRight ? { flushRight: true } : {}),
      ...(section.medianFlush && median > 0 ? { medianFlush: true } : {}),
      ...(section.materials ? { materials: section.materials } : {}),
      median,
      speedLimit: kmh(section.speedKmh),
      priorityRank: section.priority,
      ...(section.turnsForward ? { turnsForward: section.turnsForward } : {}),
      ...(section.turnsBackward ? { turnsBackward: section.turnsBackward } : {}),
      ...(section.useForward ? { useForward: section.useForward } : {}),
      ...(section.useBackward ? { useBackward: section.useBackward } : {}),
      ...(section.linesForward ? { linesForward: section.linesForward } : {}),
      ...(section.linesBackward ? { linesBackward: section.linesBackward } : {}),
      ...(section.centreLine ? { centreLine: section.centreLine } : {}),
    };
  }
  if ((configuredLanes === undefined || configuredLanes === null) &&
    direction === 'both' && base.lanes >= 2) return base;
  const lanes = configuredLanes === undefined || configuredLanes === null
    ? direction === 'both' ? Math.max(2, base.lanes) : base.lanes
    : Math.max(MIN_TRAVEL_LANES, Math.min(MAX_TRAVEL_LANES, Math.round(configuredLanes)));
  const median = direction === 'both' && lanes >= 2 ? base.median : 0;
  if (lanes === base.lanes && median === base.median) return base;
  const width = median + laneWidth(base) * lanes;
  return {
    ...base,
    width,
    lanes,
    median,
    markings: lanes <= 1 ? 'none' : lanes === 2 ? 'center' : 'lanes',
    subKey: lanes === 1 ? 'road.sub.custom.one' : 'road.sub.custom.other',
    subLanes: lanes,
    subOneWay: direction !== 'both',
  };
}

/**
 * Half-width of a road type at a given surface level.
 *
 * These are the `hw[level][leg]` values that drive the whole junction builder.
 * They are strictly decreasing from Casing to Asphalt, which is what guarantees
 * the level rings nest (see the containment assertion in the junction tests).
 */
export function halfWidth(rt: RoadType, level: SurfaceLevel): number {
  switch (level) {
    case Level.Asphalt:
      return rt.width / 2;
    case Level.Curb:
      return rt.width / 2 + CURB_BAND;
    case Level.Sidewalk:
      return rt.width / 2 + rt.sidewalk;
    case Level.Casing:
      return rt.width / 2 + rt.sidewalk + CASING_BAND;
  }
}

/** One side of a road, left or right of a -> b. */
export type RoadSide = 'left' | 'right';

/** The footway on one side of a -> b, kerb included. */
export const footwayOn = (rt: RoadType, side: RoadSide): number =>
  (side === 'left' ? rt.sidewalkLeft : rt.sidewalkRight) ?? rt.sidewalk;

/** Whether the footway on one side is level with the carriageway (no kerb). */
export const flushOn = (rt: RoadType, side: RoadSide): boolean =>
  (side === 'left' ? rt.flushLeft : rt.flushRight) === true;

/**
 * Whether the road's outline is the plain one: the same footway both sides,
 * each kerbed (every road before docs/VIAS.md V1).
 */
export const symmetric = (rt: RoadType): boolean =>
  rt.sidewalkLeft === undefined && !rt.flushLeft && !rt.flushRight;

/**
 * Half-width of one side of a road at a surface level, left or right of
 * a -> b: the outline a ribbon and a junction leg are cut to. `halfWidth` is
 * the wider side, for whatever only needs the road's reach. A flush footway
 * has no kerb stone: its kerb level is the carriageway's edge.
 */
export function sideHalfWidth(rt: RoadType, level: SurfaceLevel, side: RoadSide): number {
  if (symmetric(rt)) return halfWidth(rt, level);
  const half = rt.width / 2;
  switch (level) {
    case Level.Asphalt:
      return half;
    case Level.Curb:
      return half + (flushOn(rt, side) ? 0 : CURB_BAND);
    case Level.Sidewalk:
      return half + footwayOn(rt, side);
    case Level.Casing:
      return half + footwayOn(rt, side) + CASING_BAND;
  }
}

export const sidewalkHalf = (rt: RoadType): number => rt.width / 2 + rt.sidewalk;
export const casingHalf = (rt: RoadType): number =>
  rt.width / 2 + rt.sidewalk + CASING_BAND;

export const lanesPerDirection = (rt: RoadType): number =>
  Math.max(1, Math.floor(rt.lanes / 2));

/** Number of lanes a vehicle may use in one travelling direction. */
export const travelLanes = (rt: RoadType, direction: SegmentDirection): number =>
  direction === 'both' ? lanesPerDirection(rt) : rt.lanes;

/** Width of one travel lane: the carriageway less its median and parking lanes. */
export const laneWidth = (rt: RoadType): number =>
  (rt.width - rt.median - rt.parkingLeft - rt.parkingRight) / rt.lanes;

/** Width of the travel lanes and median together, between the parking lanes. */
export const travelWidth = (rt: RoadType): number =>
  rt.width - rt.parkingLeft - rt.parkingRight;

/**
 * Lateral offset of the travel way's centre from the road centreline, in the
 * a -> b frame (positive: left). Zero unless the two sides park differently:
 * the kerbs stay symmetric about the centreline and the lanes move over.
 */
export const travelShift = (rt: RoadType): number =>
  (rt.parkingRight - rt.parkingLeft) / 2;

/** Materializes the current profile for the first authored edit without changing old maps. */
export function sectionFromProfile(rt: RoadType): RoadSection {
  return { laneWidth: laneWidth(rt), sidewalk: rt.sidewalk, median: rt.median,
    speedKmh: rt.speedLimit / kmh(1), priority: rt.priorityRank,
    ...(rt.turnsForward ? { turnsForward: [...rt.turnsForward] } : {}),
    ...(rt.turnsBackward ? { turnsBackward: [...rt.turnsBackward] } : {}),
    ...(rt.useForward ? { useForward: [...rt.useForward] } : {}),
    ...(rt.useBackward ? { useBackward: [...rt.useBackward] } : {}),
    ...(rt.linesForward ? { linesForward: [...rt.linesForward] } : {}),
    ...(rt.linesBackward ? { linesBackward: [...rt.linesBackward] } : {}),
    ...(rt.centreLine ? { centreLine: rt.centreLine } : {}) };
}

/**
 * Signed lateral offset of a lane's centreline from the road centreline.
 * For two-way roads lane 0 is the innermost (nearest the centre); higher
 * indices move outward. One-way lanes are centred as a complete carriageway.
 *
 * `forward` says which frame the offset is wanted in: true for a -> b (the
 * segment's own direction), false for a lane read along b -> a. It matters
 * only when the two sides park differently and the travel way is off centre.
 */
export function laneOffset(rt: RoadType, lane: number, direction: SegmentDirection = 'both', forward = true): number {
  const count = travelLanes(rt, direction);
  const idx = Math.max(0, Math.min(count - 1, lane));
  const shift = travelShift(rt) * (forward ? 1 : -1);
  // A one-way carriageway is centred on its road centreline instead of being
  // pushed onto the right-hand half reserved by two-way traffic. `perp` is the
  // LEFT normal in this coordinate system, so right-hand traffic is negative.
  if (direction !== 'both') return shift - laneWidth(rt) * (idx - (count - 1) / 2);
  return shift - (rt.median / 2 + laneWidth(rt) * (idx + 0.5));
}
