import type { SegmentDirection } from '../doc';
import { PARKING_DEPTH, type ParkingKind, type SegmentParking } from '../parking';
import {
  type CarriagewayMaterial, type CentreLine, type FootwayMaterial, type MedianMaterial, type RoadSection,
  ROAD_SECTION_LIMITS, laneUse as laneUseOf, normalizeRoadSection, sectionSidewalk,
} from '../roadSection';
import { type RoadType, laneWidth, roadProfile, roadType } from '../roadTypes';
import { kmh } from '../units';

/** THE ROAD PROFILE */
export type ProfileElement =
  | { readonly kind: 'footway'; readonly width: number; readonly material?: FootwayMaterial; readonly flush?: boolean }
  | { readonly kind: 'parking' | 'cycle'; readonly width: number }
  | {
    readonly kind: 'lane'; readonly width: number; readonly dir: 'forward' | 'backward';
    /** Buses only (`RoadSection.useForward`). */
    readonly use?: 'bus';
    /** The line on its right, to the next lane of its direction: solid (no lane change) instead of dashed. */
    readonly line?: 'solid';
  }
  | { readonly kind: 'median'; readonly width: number; readonly material?: MedianMaterial; readonly flush?: boolean };

export interface RoadProfileSpec {
  /** Left edge to right edge, looking from `a` to `b`. */
  readonly elements: readonly ProfileElement[];
  readonly speedKmh: number;
  readonly priority: number;
  readonly carriageway?: CarriagewayMaterial;
  /** The line between the two directions (V6); absent: the road's own. */
  readonly centreLine?: CentreLine;
}

/** What a segment is made of, as the profile reads it. */
export interface ProfileSource {
  readonly type: number;
  readonly lanes: number | null;
  readonly direction: SegmentDirection;
  readonly section?: RoadSection;
  readonly parking?: SegmentParking;
}

/** The profile of a segment as it stands (its class, lanes, direction, section, parking). */
export function profileOf(source: ProfileSource): RoadProfileSpec {
  const rt = roadProfile(source.type, source.lanes, source.direction, source.section, source.parking);
  const section = source.section;
  const width = laneWidth(rt);
  const elements: ProfileElement[] = [];
  const footway = (side: 'left' | 'right'): ProfileElement => {
    const material = side === 'left' ? section?.materials?.footwayLeft : section?.materials?.footwayRight;
    const flush = side === 'left' ? section?.flushLeft : section?.flushRight;
    return { kind: 'footway', width: section ? sectionSidewalk(section, side) : rt.sidewalk,
      ...(material ? { material } : {}), ...(flush ? { flush: true } : {}) };
  };
  const band = (kind: ParkingKind): void => {
    if (kind === 'parallel') elements.push({ kind: 'parking', width: PARKING_DEPTH.parallel });
    else if (kind === 'cycle') elements.push({ kind: 'cycle', width: PARKING_DEPTH.cycle });
  };
  elements.push(footway('left'));
  band(rt.parkingLeftKind);
  const lanes = rt.lanes;
  // A lane as the section has it (V4)
  const lane = (dir: 'forward' | 'backward', index: number, count: number): ProfileElement => {
    const forward = dir === 'forward';
    const use = laneUseOf(section, forward, index);
    const boundary = forward ? index : index - 1;
    const line = boundary >= 0 && boundary < count - 1 &&
      ((forward ? section?.linesForward : section?.linesBackward)?.[boundary] ?? 'dashed') === 'solid';
    return { kind: 'lane', width, dir, ...(use === 'bus' ? { use: 'bus' as const } : {}), ...(line ? { line: 'solid' as const } : {}) };
  };
  if (source.direction === 'both') {
    const perSide = Math.max(1, Math.floor(lanes / 2));
    for (let i = 0; i < perSide; i++) elements.push(lane('backward', perSide - 1 - i, perSide));
    if (rt.median > 0) {
      elements.push({ kind: 'median', width: rt.median,
        ...(section?.materials?.median ? { material: section.materials.median } : {}),
        ...(section?.medianFlush ? { flush: true } : {}) });
    }
    for (let i = 0; i < perSide; i++) elements.push(lane('forward', i, perSide));
  } else {
    const dir = source.direction === 'aToB' ? 'forward' : 'backward';
    for (let i = 0; i < lanes; i++) elements.push(lane(dir, dir === 'forward' ? i : lanes - 1 - i, lanes));
  }
  band(rt.parkingRightKind);
  elements.push(footway('right'));
  return {
    elements,
    speedKmh: Math.round(rt.speedLimit / kmh(1)),
    priority: rt.priorityRank,
    ...(section?.materials?.carriageway ? { carriageway: section.materials.carriageway } : {}),
    ...(section?.centreLine ? { centreLine: section.centreLine } : {}),
  };
}

/** Why a profile cannot be built as it stands; a translation key under `profile.problem.`. */
export type ProfileProblem =
  | 'footways' | 'noLanes' | 'laneWidths' | 'laneBalance' | 'order' | 'median' | 'parkingSide' | 'width' | 'class' | 'busOnly';

/** What stops a profile from being built, empty when nothing does. */
export function profileProblems(profile: RoadProfileSpec, typeIndex: number): ProfileProblem[] {
  return [...new Set(profileIssues(profile, typeIndex).map((issue) => issue.problem))];
}

/** A problem and the elements it is about (by index; empty: the road as a whole). */
export interface ProfileIssue {
  readonly problem: ProfileProblem;
  readonly elements: readonly number[];
}

/** `profileProblems` with the elements each problem is about, so an editor can name the problem on the element that has it */
export function profileIssues(profile: RoadProfileSpec, typeIndex: number): ProfileIssue[] {
  const out: ProfileIssue[] = [];
  const add = (problem: ProfileProblem, elements: readonly number[]): void => {
    const known = out.find((issue) => issue.problem === problem);
    if (known) (known.elements as number[]).push(...elements.filter((i) => !known.elements.includes(i)));
    else out.push({ problem, elements: [...elements] });
  };
  const e = profile.elements;
  const lastIndex = e.length - 1;
  const first = e[0], last = e[lastIndex];
  if (!first || first.kind !== 'footway') add('footways', first ? [0] : []);
  if (!last || last.kind !== 'footway' || e.length < 3) add('footways', last && e.length > 1 ? [lastIndex] : []);
  const innerIndex = e.map((_, i) => i).slice(1, -1);
  for (const i of innerIndex) if (e[i]!.kind === 'footway') add('footways', [i]);
  const laneIndex = innerIndex.filter((i) => e[i]!.kind === 'lane');
  const lanes = laneIndex.map((i) => e[i] as Extract<ProfileElement, { kind: 'lane' }>);
  if (!lanes.length) add('noLanes', []);
  if (lanes.some((l) => l.width !== lanes[0]!.width)) add('laneWidths', laneIndex.filter((i) => e[i]!.width !== lanes[0]!.width));
  const backward = lanes.filter((l) => l.dir === 'backward').length;
  const forward = lanes.length - backward;
  if (backward > 0 && forward > 0 && backward !== forward) add('laneBalance', laneIndex);
  // A direction of bus lanes only leaves every other vehicle without a way (V4).
  for (const dir of ['forward', 'backward'] as const) {
    const own = laneIndex.filter((i) => (e[i] as Extract<ProfileElement, { kind: 'lane' }>).dir === dir);
    if (own.length && own.every((i) => (e[i] as Extract<ProfileElement, { kind: 'lane' }>).use === 'bus')) add('busOnly', own);
  }
  // Parking and cycle lanes only by the kerb.
  innerIndex.forEach((i, k) => {
    const x = e[i]!;
    if ((x.kind === 'parking' || x.kind === 'cycle') && k !== 0 && k !== innerIndex.length - 1) add('parkingSide', [i]);
  });
  // The carriageway in order: backward lanes, then the median, then forward lanes.
  let seenForward = false, seenMedian = false;
  for (const i of innerIndex) {
    const x = e[i]!;
    if (x.kind === 'median') {
      if (seenMedian || seenForward || backward === 0 || forward === 0) add('median', [i]);
      seenMedian = true;
    } else if (x.kind === 'lane') {
      if (x.dir === 'forward') seenForward = true;
      else if (seenForward || seenMedian) add('order', [i]);
    }
  }
  const [minLane, maxLane] = ROAD_SECTION_LIMITS.laneWidth;
  const [minWalk, maxWalk] = ROAD_SECTION_LIMITS.sidewalk;
  e.forEach((x, i) => {
    if (x.kind === 'lane' && (x.width < minLane || x.width > maxLane)) add('width', [i]);
    if (x.kind === 'footway' && (x.width < minWalk || x.width > maxWalk)) add('width', [i]);
    if (x.kind === 'median' && (x.width <= 0 || x.width > ROAD_SECTION_LIMITS.median[1])) add('width', [i]);
  });
  // Highways and ramps park nothing (`parkingAllowed`).
  const id = roadType(typeIndex).id;
  const parked = innerIndex.filter((i) => e[i]!.kind === 'parking' || e[i]!.kind === 'cycle');
  if ((id === 'highway' || id === 'ramp') && parked.length) add('class', parked);
  return out;
}

/** Whether two flat records hold the same values, an absent field the same as `undefined`. */
function sameFlat(a: object, b: object): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k in x) if (x[k] !== y[k]) return false;
  for (const k in y) if (!(k in x) && y[k] !== undefined) return false;
  return true;
}

/** DO NOT compare profiles by `JSON.stringify` */
export function sameProfile(a: RoadProfileSpec, b: RoadProfileSpec): boolean {
  if (a === b) return true;
  const { elements: ea, ...ra } = a;
  const { elements: eb, ...rb } = b;
  return ea.length === eb.length && sameFlat(ra, rb) && ea.every((e, i) => sameFlat(e, eb[i]!));
}

/** The segment's own fields for a profile (`profileProblems` must be empty). */
export interface AppliedProfile {
  /** Null: the class's own lane count. */
  readonly lanes: number | null;
  readonly direction: SegmentDirection;
  /** Absent: the class's own section, exactly (its lanes need not be whole metres). */
  readonly section: RoadSection | undefined;
  readonly parking: SegmentParking | undefined;
}

/** The segment's fields for a profile. */
export function applyProfile(profile: RoadProfileSpec, typeIndex?: number): AppliedProfile {
  const authored = authoredFields(profile);
  if (typeIndex === undefined) return authored;
  const same = (p: RoadProfileSpec): boolean => sameProfile(p, profile);
  const base = { type: typeIndex, direction: authored.direction, ...(authored.parking ? { parking: authored.parking } : {}) };
  if (same(profileOf({ ...base, lanes: null }))) return { ...authored, lanes: null, section: undefined };
  if (same(profileOf({ ...base, lanes: authored.lanes }))) return { ...authored, section: undefined };
  return authored;
}

function authoredFields(profile: RoadProfileSpec): AppliedProfile & { readonly lanes: number; readonly section: RoadSection } {
  const e = profile.elements;
  const left = e[0] as Extract<ProfileElement, { kind: 'footway' }>;
  const right = e[e.length - 1] as Extract<ProfileElement, { kind: 'footway' }>;
  const inner = e.slice(1, -1);
  const lanes = inner.filter((x): x is Extract<ProfileElement, { kind: 'lane' }> => x.kind === 'lane');
  const median = inner.find((x): x is Extract<ProfileElement, { kind: 'median' }> => x.kind === 'median');
  const backward = lanes.filter((l) => l.dir === 'backward').length;
  const forward = lanes.length - backward;
  const direction: SegmentDirection = backward && forward ? 'both' : forward ? 'aToB' : 'bToA';
  const kindAt = (x: ProfileElement | undefined): ParkingKind => x?.kind === 'parking' ? 'parallel' : x?.kind === 'cycle' ? 'cycle' : 'none';
  const parkingLeft = kindAt(inner[0]);
  const parkingRight = kindAt(inner[inner.length - 1]);
  const materials = {
    ...(profile.carriageway ? { carriageway: profile.carriageway } : {}),
    ...(left.material ? { footwayLeft: left.material } : {}),
    ...(right.material ? { footwayRight: right.material } : {}),
    ...(median?.material ? { median: median.material } : {}),
  };
  const raw = {
    laneWidth: lanes[0]?.width ?? ROAD_SECTION_LIMITS.laneWidth[0],
    sidewalk: Math.max(left.width, right.width),
    ...(left.width !== right.width ? { sidewalkLeft: left.width, sidewalkRight: right.width } : {}),
    median: median?.width ?? 0,
    speedKmh: profile.speedKmh,
    priority: profile.priority,
    ...(left.flush ? { flushLeft: true } : {}),
    ...(right.flush ? { flushRight: true } : {}),
    ...(median?.flush ? { medianFlush: true } : {}),
    ...(Object.keys(materials).length ? { materials } : {}),
    ...(profile.centreLine ? { centreLine: profile.centreLine } : {}),
  };
  // Lane uses and lines by laneIndex (V4): forward lanes left to right are laneIndex 0, 1, ...
  const fwd = lanes.filter((l) => l.dir === 'forward');
  const bwd = lanes.filter((l) => l.dir === 'backward').reverse();
  const uses = (list: typeof lanes): string[] => list.map((l) => l.use ?? 'all');
  // A forward lane's own `line` is the line to the next one; a backward lane's is the line to the previous index.
  const linesFwd = fwd.slice(0, -1).map((l) => l.line ?? 'dashed');
  const linesBwd = bwd.slice(1).map((l) => l.line ?? 'dashed');
  const laneLists = {
    ...(uses(fwd).some((u) => u !== 'all') ? { useForward: uses(fwd) } : {}),
    ...(uses(bwd).some((u) => u !== 'all') ? { useBackward: uses(bwd) } : {}),
    ...(linesFwd.some((x) => x !== 'dashed') ? { linesForward: linesFwd } : {}),
    ...(linesBwd.some((x) => x !== 'dashed') ? { linesBackward: linesBwd } : {}),
  };
  const section = normalizeRoadSection({ ...raw, ...laneLists }) as RoadSection;
  return {
    lanes: lanes.length,
    direction,
    section,
    parking: parkingLeft === 'none' && parkingRight === 'none' ? undefined : { left: parkingLeft, right: parkingRight },
  };
}

/** The road a profile builds, as every consumer reads it. */
export function profileRoad(profile: RoadProfileSpec, typeIndex: number): RoadType {
  const applied = applyProfile(profile, typeIndex);
  return roadProfile(typeIndex, applied.lanes, applied.direction, applied.section, applied.parking);
}

/** Total width of a profile, footways included, world units. */
export const profileWidth = (profile: RoadProfileSpec): number =>
  profile.elements.reduce((sum, x) => sum + x.width, 0);
