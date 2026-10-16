import { Digest } from '@core/digest';
import { type Aabb, expand as expandBox } from '@core/aabb';
import type { Polyline } from '@core/polyline';
import type { NodeId, SegmentId } from './ids';
import type { Network } from './network';
import type { NetworkDelta } from './networkDelta';
import { RerootMap } from '@core/rerootMap';
import { CASING_BAND, FOOTWAY_RISE, Level, type RoadType, casingHalf, footwayOn } from './roadTypes';
import { m } from './units';
import {
  BLEND_TAU,
  INDEX_CELL,
  OVERSIZED_CELLS,
  cellKeyOf,
  PROFILE_FADE,
  PROFILE_REACH,
  SpatialIndex,
  heightAtArc,
  packField,
  roadField,
  unpackField,
  smoothstep,
  type FieldData,
  type RoadReads,
} from './roadField';
import { ROAD_TUNING } from './roads/tuning';
import {
  ROAD_GROUND_CLEARANCE,
  TUNNEL_BORE,
  TUNNEL_GRADE,
  TUNNEL_ROOF,
  isRaised,
  isSunken,
  roadStructure,
  type RoadStructure,
} from './structures';

/** ONE continuous height field for every road surface in the network. ## Why this module exists A road surface is not drawn */

/** Station spacing along a profile, in world units. */
const STATION = m(1.6);
/** Hard cap on stations per segment, so a 4 km road does not allocate 1000. */
const MAX_STATIONS = 400;
/** Extra reach past the junction trim that the junction plate has to cover. */
const PLATE_MARGIN = STATION + m(0.4);
/** Lateral samples across the casing when reading the ground under a road. */
const LATERAL = [-1, -0.62, -0.28, 0, 0.28, 0.62, 1] as const;
/** Stations either side of one that must also be cleared (chord protection). */
const DILATE = 2;
/** Steepest gradient of a road at grade (rise / run), from `roads/tuning.ts`. */
const GROUND_GRADE = ROAD_TUNING.grade.ground;
/** How far along a road its grade line is averaged, in world units. */
const SMOOTH_REACH = m(36);
/** How far past its junction plate a profile is tied back to the node height. */
const TIE_REACH = m(28);
/** How far past a junction plate the ground floor stops constraining a ramp. */
const PLATE_BLEND = m(16);
/** The share of a ramp over which the natural ground stops being a floor. */
const RAMP_RELAX = 0.8;
/** Lift above the ground at which a structure stops shaping it: piers, not fill. */
const LIFT_ON = ROAD_TUNING.structure.liftOn;
const LIFT_OFF = ROAD_TUNING.structure.pierFrom;
/** Grade of the straight part of a ramp between a raised deck and a road at grade: sixteen per cent. */
const RAMP_GRADE = ROAD_TUNING.grade.ramp;
/** Maximum authored height change per unit of alignment before a ramp needs more run. */
export const MAX_AUTHORED_GRADE = ROAD_TUNING.grade.authored;
/** Length of the vertical curve at the foot of a ramp, where the grade builds up from level, in world units (8 m). */
const RAMP_CURVE = m(8);
/** Reach of the vertical curves rounded into a road wherever its grade changes (see `roundGradeBreaks`), in world units */
const VERTICAL_CURVE_REACH = m(4.8);
/** Decay length of the grade correction just outside a flat junction plate. */
const PLATE_TANGENT_REACH = m(16);
/** Cancels enough of the incoming grade to round the join without bending the whole hill. */
const PLATE_TANGENT_SHARE = 0.55;
/** Softness of the crest where a ramp meets its deck (a height: 3.2 m of run at the ramp's grade). */
const RAMP_CREST = m(3.2) * RAMP_GRADE;
/** Steepest gradient with which a deck is carried up to a higher deck it meets in the air. */
const DECK_TIE = ROAD_TUNING.grade.deckTie;
/** Steepest grade a deck may take to clear a rise under it. */
const DECK_GRADE = ROAD_TUNING.grade.deck;
/** Peak-to-mean slope ratio of the smoothstep used for vertical curves. */
const CURVE_PEAK = 1.5;
/** Most rounds of the profile solve. */
const MAX_SOLVE_PASSES = 64;
/** How far from a point ON a road any profile can still change what a query there answers */
export const SURFACE_READ_REACH = PROFILE_REACH + BLEND_TAU * Math.log(1e4);

interface Profile {
  readonly id: SegmentId;
  readonly structure: RoadStructure;
  /** A player-authored vertical alignment, independent of legacy structure modes. */
  readonly manualVertical: boolean;
  /** Its cutting held by retaining walls (`RoadSegment.cutWalls`): cut back no wider than a portal's. */
  readonly walls: boolean;
  /** The class index the road was drawn with, for per-class surface tinting. */
  readonly type: number;
  /** Half the casing width — how far this road's surface reaches sideways. */
  readonly half: number;
  /** Central reservation width, zero when the class has none. */
  readonly median: number;
  /** Authored footway width, including the kerb: the wider side's. */
  readonly sidewalk: number;
  /** Each side's footway, left and right of a -> b. */
  readonly sidewalkLeft: number;
  readonly sidewalkRight: number;
  /** A digest of the road's look - its materials, which footway is flush - or 0 for the class's own */
  readonly look: number;
  readonly line: Polyline;
  readonly length: number;
  readonly step: number;
  /** Deck height at station `i`, i.e. at arc `i * step`. */
  readonly h: number[];
  /** Ground under the road at station `i`, plus the surface clearance. */
  readonly ceil: number[];
  /** The designed grade line: the BALANCED ground under the road, smoothed and slope-limited. */
  readonly base: number[];
  /** For a raised structure, the ground under it plus its clearance */
  readonly deck: number[];
  /** Where each station lies, x and y (`stationsAt`): measured once, kept with the profile (its line and step do not change). */
  points?: Float64Array;
  readonly a: NodeId;
  readonly b: NodeId;
  /** Arc length at the `a` end over which the profile is flat (junction plate). */
  plateA: number;
  /** Same at the `b` end. */
  plateB: number;
  /** Half-width of the widest band, used to size the query's influence radius. */
  readonly reach: number;
  readonly bbox: Aabb;
}

/** The solved field: its reads (`roadField.ts`) and what the ground and the cache ask of it. */
export interface RoadElevation extends RoadReads {
  /** The solved height of a node, shared by every road that meets there. */
  nodeHeight(node: NodeId): number;
  /** Whether any road of these structures exists at all. */
  has(structures?: ReadonlySet<RoadStructure>): boolean;
  /** How far the ground should be pulled towards the road at a point, and to what height. */
  shapeAt(x: number, y: number, naturalGround: number): { height: number; weight: number };
  /** Boxes outside which `shapeAt` always answers weight 0 */
  shapeBounds(): readonly Aabb[];
  /** A digest of everything a height, frame or road query can read at any point of a rectangle, the terrain aside */
  digest(minX: number, minY: number, maxX: number, maxY: number, reach?: number): number;
  /** Where this solve and another can differ: the boxes */
  differences?(other: RoadElevation): { minX: number; minY: number; maxX: number; maxY: number }[] | null;
  /** Each road's whole solved profile as a digest, with its box (for `differences`). */
  summaries?(): ReadonlyMap<SegmentId, { digest: number; box: Aabb; oversized: boolean }>;
  /** The profiles a query at a point of `rects` can read, and the roads `also` */
  fieldFor?(rects: readonly (readonly [number, number, number, number])[], also: readonly SegmentId[]): { data: FieldData; transfer: ArrayBuffer[] };
  /** The roads `shapeAt` and the reads can meet at a point of `rects` */
  shapeCut?(rects: readonly (readonly [number, number, number, number])[]): RoadShapeCut;
  /** How many road solves this build ran (a road solved again in a later round counts again): what an edit cost. */
  readonly solved?: number;
}


export const GROUND_ONLY: ReadonlySet<RoadStructure> = new Set<RoadStructure>(['ground']);
const NO_SHAPE = { height: 0, weight: 0 } as const;

/** Extra width past the casing over which the ground is held at road level. */
const SHAPE_INNER = m(1.2);
/** Width of the embankment or cutting that carries the ground back to its natural height. */
const SHAPE_SHOULDER = m(18);
/** Run per unit of rise on a cut or fill batter — a 1:2.5 slope. */
const BATTER = 2.5;
/** Cap on the batter, so one deep cut cannot reshape a quarter of the map. */
const SHAPE_SHOULDER_MAX = m(36);
/** The same batter for a tunnel's approach cutting, and much narrower. */
const CUT_SHOULDER = m(6.4);
/** How far past a road's casing a cutting held by retaining walls is dug (`RoadSegment.cutWalls`) */
export const CUT_WALL_REACH = SHAPE_INNER + CUT_SHOULDER;
/** How far below the road SURFACE the ground beside it is pulled. */
const SHAPE_DROP = m(0.6);
/** How far under the carriageway the ground beside a road is laid */
const BESIDE_DROP = m(0.1);

/** The work of the solves, counted (`tests/scale`): profiles made and nodes whose inputs were read. */
export const elevationWork = { profiles: 0, nodes: 0 };

/** Solves the height of every road surface in the network: from nothing, or from a solve before it, where the network changed. */
export function buildRoadElevation(
  net: Network,
  terrainAt: (x: number, y: number) => number,
  /** A solve of this network on the SAME ground (`terrainAt` answering the same heights, through whatever function) */
  previous?: RoadElevation | null,
): RoadElevation {
  const started = performance.now();
  const flat = terrainAt === FLAT_GROUND;
  // Never level ground for real ground or the other way round, whatever the caller says.
  const asked = (previous ? [memos.get(previous)] : flat ? flatSolvesOf(net) : [])
    .filter((memo): memo is SolveMemo => memo !== undefined && (memo.terrainAt === FLAT_GROUND) === flat);
  // DO NOT compare every road of the map with the solve before: the network's diary says what changed since (`changesSince`).
  let reuse: SolveMemo | null = null;
  let delta: NetworkDelta | null = null;
  if (net.isBuilt()) {
    for (const memo of asked) {
      delta = net.changesSince(memo.state);
      if (delta) { reuse = memo; break; }
    }
  }
  // A solve of every road still reads the ground only where a line or a width moved.
  const stationsFrom = reuse ?? asked[0] ?? null;

  // Persistent (`RerootMap`): this solve writes the roads it made, the one reused keeps reading as it was.
  const profiles = reuse ? reuse.profiles.derive() : new RerootMap<SegmentId, Profile>();
  const settledNodes = reuse ? reuse.nodes.derive() : new RerootMap<NodeId, SettledNode>();
  const summaries = reuse ? reuse.summaries.derive() : new RerootMap<SegmentId, Summary>();
  const index = reuse ? reuse.index.derive() : ProfileIndex.empty();
  const before = reuse?.profiles ?? null;
  /** The structures the roads are built as, counted (`has`): DO NOT gather them from every road at the question. */
  const present = new Map<RoadStructure, number>(reuse?.present ?? []);
  let total = reuse?.total ?? 0;
  const count = (structure: RoadStructure, by: number): void => {
    const n = (present.get(structure) ?? 0) + by;
    if (n > 0) present.set(structure, n); else present.delete(structure);
    total += by;
  };
  /** The profiles this solve made (its own, written freely); every other is the solve reused's, never written. */
  const own = new Set<SegmentId>();
  /** The roads the change reached, and the nodes whose inputs are read again. */
  const touched = new Set<SegmentId>();
  const keyed = new Set<NodeId>();
  if (delta) {
    for (const id of delta.segments) touched.add(id);
    for (const node of delta.nodes) {
      keyed.add(node);
      for (const id of net.doc.node(node)?.incident ?? []) touched.add(id);
    }
  } else {
    for (const id of net.ribbons.keys()) touched.add(id);
  }
  /** Nodes at the ends of a road whose inputs changed. */
  const changedEnds = new Set<NodeId>();

  // ---------------------------------------------------------------- stations
  for (const id of [...touched].sort((p, q) => p - q)) {
    const old = before?.get(id);
    if (old) {
      keyed.add(old.a);
      keyed.add(old.b);
      index.remove(old);
      count(old.structure, -1);
    }
    const ribbon = net.ribbons.get(id);
    const segment = net.doc.segment(id);
    if (!ribbon || !segment) {
      if (old) { profiles.delete(id); summaries.delete(id); }
      continue;
    }
    elevationWork.profiles++;
    const line = ribbon.full;
    const length = Math.max(1e-3, line.length);
    const stationCount = Math.max(2, Math.min(MAX_STATIONS, Math.ceil(length / STATION) + 1));
    const step = length / (stationCount - 1);
    const half = casingHalf(ribbon.road);
    // The ground under a road is read at 7 points across every 4 units of it, and its grade line smoothed: most of a solve.
    const known = stationsFrom?.profiles.get(id);
    const kept = known !== undefined && known.half === half && sameLine(known.line, line);
    const { ceil, base } = kept ? known : readStations(line, half, stationCount, step, terrainAt);

    const trims = net.trims.get(id);
    // A taper where one road carries on at another width is not a junction plate.
    const reachOf = (node: NodeId, trim: number | undefined): number => {
      if (net.doc.node(node)?.smooth && !net.junctions.has(node)) return 0;
      if (net.transitions.has(node)) return PLATE_MARGIN;
      // The plate is flat over the junction's whole footprint, its footways and verges included (`Network.plateReach`).
      let reach = trim ?? 0;
      const outer = net.junctions.get(node)?.get(Level.Casing);
      const inner = net.junctions.get(node)?.get(Level.Asphalt);
      if (outer && inner) {
        let extra = 0;
        for (const leg of outer.legs) {
          const carriage = inner.legs.find((l) => l.seg === leg.seg);
          if (carriage) extra = Math.max(extra, leg.hw - carriage.hw);
        }
        reach += extra;
      }
      return reach + PLATE_MARGIN;
    };
    const plateA = Math.min(length * 0.45, reachOf(segment.a, trims?.a[Level.Casing]));
    const plateB = Math.min(length * 0.45, reachOf(segment.b, trims?.b[Level.Casing]));

    const box = expandBox(line.bbox, half + PLATE_MARGIN + PROFILE_FADE);

    const profile: Profile = {
      id,
      structure: segment.structure,
      manualVertical: Math.abs(net.doc.node(segment.a)?.heightOffset ?? 0) > 1e-6 ||
        Math.abs(net.doc.node(segment.b)?.heightOffset ?? 0) > 1e-6,
      walls: segment.cutWalls === true,
      type: segment.type,
      half,
      median: ribbon.road.median,
      sidewalk: ribbon.road.sidewalk,
      sidewalkLeft: footwayOn(ribbon.road, 'left'),
      sidewalkRight: footwayOn(ribbon.road, 'right'),
      look: lookDigest(ribbon.road),
      line,
      length,
      step,
      h: base.slice(),
      ceil,
      base,
      deck: isRaised(segment.structure) ? ceil.map((value) => value + roadStructure(segment.structure).clearance) : [],
      a: segment.a,
      b: segment.b,
      plateA,
      plateB,
      reach: half + PROFILE_FADE,
      bbox: box,
    };
    profiles.set(id, profile);
    index.add(profile);
    count(profile.structure, 1);
    own.add(id);
    keyed.add(profile.a);
    keyed.add(profile.b);
    if (reuse && (!old || !sameProfile(old, profile))) { changedEnds.add(profile.a); changedEnds.add(profile.b); }
  }

  // ------------------------------------------------------------ node heights
  const profileOf = (id: SegmentId): Profile => profiles.get(id)!;
  /** The roads meeting at a node, in id order (a road from a node to itself twice), asked of the document, not of every road. */
  const incidentIds = new Map<NodeId, readonly SegmentId[]>();
  const incident = (node: NodeId): readonly SegmentId[] => {
    let list = incidentIds.get(node);
    if (!list) {
      const out: SegmentId[] = [];
      for (const id of [...new Set(net.doc.node(node)?.incident ?? [])].sort((p, q) => p - q)) {
        const profile = profiles.get(id);
        if (!profile) continue;
        if (profile.a === node) out.push(id);
        if (profile.b === node) out.push(id);
      }
      incidentIds.set(node, list = out);
    }
    return list;
  };
  /** A node's inputs as text: where it stands, its authored height, its roads. */
  const keyOf = (node: NodeId): string => {
    const point = net.doc.node(node);
    return `${point?.x},${point?.y}|${point?.heightOffset}|${incident(node).join(',')}`;
  };

  // ------------------------------------------------- what is solved again
  const solvedNodes = new Set<NodeId>(changedEnds);
  for (const node of keyed) {
    if (!incident(node).length) { settledNodes.delete(node); continue; }
    elevationWork.nodes++;
    if (!reuse || reuse.nodes.get(node)?.key !== keyOf(node)) solvedNodes.add(node);
  }
  // DO NOT go back to solving every connected piece a change touches
  if (reuse) {
    for (const node of [...solvedNodes]) for (const id of incident(node)) { const p = profileOf(id); solvedNodes.add(p.a); solvedNodes.add(p.b); }
    const queue = [...solvedNodes];
    while (queue.length) {
      const node = queue.pop() as NodeId;
      for (const id of incident(node)) {
        const profile = profileOf(id);
        const other = profile.a === node ? profile.b : profile.a;
        if (solvedNodes.has(other)) continue;
        // Unchanged (or it would be solved already): its memo stands for it, and so does the road's.
        const settledThere = reuse.nodes.get(other) as SettledNode;
        if (settledThere.height <= settledThere.start + 1e-6) continue;
        const was = (before!.get(id) as Profile).h;
        const end = was[profile.a === other ? 0 : was.length - 1] as number;
        if (end < settledThere.height - 1e-6) continue;
        solvedNodes.add(other);
        queue.push(other);
      }
    }
  }
  /** A profile made this solve's own before it is written: from its grade line (`fresh`), or with the heights it had. */
  const mine = (id: SegmentId, fresh: boolean): Profile => {
    const profile = profileOf(id);
    if (own.has(id)) return profile;
    const copy: Profile = { ...profile, h: fresh ? profile.base.slice() : profile.h.slice() };
    own.add(id);
    profiles.set(id, copy);
    index.remove(profile);
    index.add(copy);
    return copy;
  };
  const solvedSet = new Set<SegmentId>();
  for (const node of solvedNodes) for (const id of incident(node)) solvedSet.add(id);
  const solvedProfiles = [...solvedSet].sort((p, q) => p - q).map((id) => mine(id, true));
  // A road made again from the same inputs, at nodes that stand: the heights of the solve reused.
  for (const id of own) {
    if (solvedSet.has(id)) continue;
    const h = profileOf(id).h, was = (before!.get(id) as Profile).h;
    for (let i = 0; i < h.length; i++) h[i] = was[i] as number;
  }
  /** A node's figures: solved here, or as it settled in the solve reused (its inputs did not change). */
  const settledAt = (node: NodeId): SettledNode | undefined => (solvedNodes.has(node) ? undefined : reuse?.nodes.get(node));
  const roadsAt = (node: NodeId): Profile[] => incident(node).map(profileOf);

  /** The mean ground over a junction's own disc, for a node no road at grade reaches. */
  const balancedAtNode = new Map<NodeId, number>();
  for (const node of solvedNodes) {
    const point = net.doc.node(node);
    if (!point) continue;
    let sum = terrainAt(point.x, point.y);
    let samples = 1;
    let radius = m(2.4);
    for (const profile of roadsAt(node)) {
      const plate = profile.a === node ? profile.plateA : profile.plateB;
      radius = Math.max(radius, plate, profile.reach - m(8));
    }
    for (let ring = 1; ring <= 2; ring++) {
      const r = (radius * ring) / 2;
      for (let k = 0; k < 8; k++) {
        const angle = (k / 8) * Math.PI * 2 + ring * 0.4;
        sum += terrainAt(point.x + Math.cos(angle) * r, point.y + Math.sin(angle) * r);
        samples++;
      }
    }
    balancedAtNode.set(node, sum / samples + ROAD_GROUND_CLEARANCE);
  }

  /** Grade height of a node: where the roads meeting there WANT to be. */
  const gradeHeight = new Map<NodeId, number>();
  for (const node of solvedNodes) {
    let sum = 0;
    let n = 0;
    for (const profile of roadsAt(node)) {
      // ONLY roads built at grade.
      if (isRaised(profile.structure) || isSunken(profile.structure)) continue;
      // At the PLATE EDGE, not at the segment's endpoint.
      const edge = profile.a === node ? profile.plateA : profile.length - profile.plateB;
      sum += profile.base[stationIndex(profile, edge)] as number;
      n++;
    }
    gradeHeight.set(node,
      (n > 0 ? sum / n : (balancedAtNode.get(node) ?? 0)) +
      (net.doc.node(node)?.heightOffset ?? 0));
  }

  // A node every one of whose roads is raised stays UP
  const aloft = new Set<NodeId>();
  for (const node of solvedNodes) {
    const list = roadsAt(node);
    if (list.length > 1 && list.every((profile) => isRaised(profile.structure))) aloft.add(node);
  }
  // A node kept from the solve reused answers with what it settled with: its inputs did not change.
  const gradeOf = (node: NodeId): number => settledAt(node)?.grade ?? gradeHeight.get(node) ?? 0;
  const isAloft = { has: (node: NodeId): boolean => settledAt(node)?.aloft ?? aloft.has(node) };

  // ------------------------------------------------------ raised deck heights
  /** The deck a raised span wants at its `a` and at its `b` end. */
  const wantedA = new Map<SegmentId, number>();
  const wantedB = new Map<SegmentId, number>();
  for (const profile of solvedProfiles) {
    if (isRaised(profile.structure)) {
      // What a raised span wants at each of its ends: its clearance over the ground of the plate.
      const ends = (from: number, to: number): number => {
        let top = -Infinity;
        for (let s = from; s <= to + 1e-6; s += profile.step) {
          top = Math.max(top, profile.deck[stationIndex(profile, s)] as number);
        }
        return top;
      };
      wantedA.set(profile.id, ends(0, profile.plateA));
      wantedB.set(profile.id, ends(profile.length - profile.plateB, profile.length));
    }
  }
  /** Free height a sunken span wants, before the ramps are fitted. */
  const wantedOf = (profile: Profile): number => {
    let floor = Infinity;
    for (const value of profile.ceil) if (value < floor) floor = value;
    return Math.min(floor, Math.min(gradeOf(profile.a), gradeOf(profile.b))) + roadStructure(profile.structure).clearance;
  };

  /** The heights this solve gave; a node it did not reach stands where the solve reused left it. */
  const heights = new Map<NodeId, number>();
  const nodeHeight: NodeHeights = { get: (node) => heights.get(node) ?? reuse?.nodes.get(node)?.height };
  /** Each solved node's height before the rounds below: what a kept node's memo holds as `start`. */
  const startHeight = new Map<NodeId, number>();
  const upperReach = new Map<NodeId, number>();
  for (const node of solvedNodes) {
    if (!aloft.has(node)) {
      heights.set(node, gradeHeight.get(node) ?? 0);
      startHeight.set(node, gradeHeight.get(node) ?? 0);
      continue;
    }
    let height = gradeHeight.get(node) ?? 0;
    for (const profile of roadsAt(node)) {
      const end = profile.a === node ? wantedA.get(profile.id) : wantedB.get(profile.id);
      height = Math.max(height, end ?? height);
    }
    // No higher than a ramp from a land end can climb within the span.
    let reachable = Infinity;
    for (const profile of roadsAt(node)) {
      if (!isRaised(profile.structure)) continue;
      const other = profile.a === node ? profile.b : profile.a;
      if (isAloft.has(other)) continue;
      const plateHere = profile.a === node ? profile.plateA : profile.plateB;
      const plateThere = profile.a === node ? profile.plateB : profile.plateA;
      const run = Math.max(0, profile.length - plateHere - plateThere);
      reachable = Math.min(reachable, gradeOf(other) + rampRise(run));
    }
    if (Number.isFinite(reachable)) upperReach.set(node, Math.max(gradeHeight.get(node) ?? 0, reachable));
    if (reachable < height) height = Math.max(gradeHeight.get(node) ?? 0, reachable);
    heights.set(node, height);
    startHeight.set(node, height);
  }
  const capOf = (node: NodeId): number | undefined => { const kept = settledAt(node); return kept ? kept.cap : upperReach.get(node); };
  const caps = { has: (node: NodeId): boolean => capOf(node) !== undefined, get: capOf };

  // ---------------------------------------------------------------- profiles Solved until the nodes stop moving.
  const solve = (profile: Profile): void => {
    if (isRaised(profile.structure)) solveRaised(profile, nodeHeight, isAloft, caps);
    else if (isSunken(profile.structure)) solveSunken(profile, nodeHeight, wantedOf(profile));
    else if (profile.manualVertical) solveVariable(profile, nodeHeight);
    else solveGround(profile, nodeHeight);
  };
  // The nodes at the ends of the roads just solved, and only those
  let dirty: Iterable<SegmentId> = solvedProfiles.map((profile) => profile.id);
  let solvedCount = 0;
  /** Every road solved here: the others hold the heights of the solve reused, and its summaries. */
  const resolved = new Set<SegmentId>();
  for (let pass = 0; pass < MAX_SOLVE_PASSES; pass++) {
    const ends = new Set<NodeId>();
    for (const id of dirty) {
      const profile = mine(id, false);
      solve(profile);
      solvedCount++;
      resolved.add(id);
      ends.add(profile.a);
      ends.add(profile.b);
    }
    const next = new Set<SegmentId>();
    for (const node of ends) {
      const list = incident(node);
      const was = nodeHeight.get(node) ?? 0;
      let height = was;
      for (const id of list) {
        const profile = profileOf(id);
        const end = profile.a === node ? (profile.h[0] as number) : (profile.h[profile.h.length - 1] as number);
        if (end > height + 1e-6) height = end;
      }
      const cap = capOf(node);
      if (cap !== undefined) height = Math.min(height, cap);
      heights.set(node, height);
      if (height > was + 1e-6) for (const id of list) next.add(id);
    }
    dirty = next;
    if (next.size === 0) break;
  }
  for (const id of dirty) { solve(mine(id, false)); solvedCount++; resolved.add(id); }
  // A road kept is pinned already: its nodes kept the heights it was pinned to.
  for (const id of resolved) {
    const profile = profileOf(id);
    pinPlates(profile, nodeHeight.get(profile.a) ?? 0, nodeHeight.get(profile.b) ?? 0);
  }

  // --------------------------------------------------------------- the summaries
  // A road kept whole (the same line, width and heights) keeps its summary: DO NOT digest every station of the town per edit.
  for (const id of resolved) {
    const profile = profileOf(id);
    const d = new Digest().add(profile.id).addText(profile.structure).add(profile.manualVertical ? 1 : 0).add(profile.type)
      .add(profile.half).add(profile.median).add(profile.sidewalk).add(profile.step).addAll(profile.h).addAll(profile.line.xy);
    if (profile.sidewalkLeft !== profile.sidewalkRight || profile.look) d.add(profile.sidewalkLeft).add(profile.sidewalkRight).add(profile.look);
    summaries.set(id, { digest: d.value(), box: profile.bbox, oversized: ProfileIndex.oversized(profile) });
  }
  // What each node settled with, for the next solve: those this one solved or moved.
  for (const node of new Set([...solvedNodes, ...heights.keys()])) {
    const kept = settledAt(node);
    const cap = capOf(node);
    settledNodes.set(node, {
      key: keyOf(node), height: nodeHeight.get(node) ?? 0, start: kept ? kept.start : startHeight.get(node) ?? 0,
      grade: gradeOf(node), aloft: isAloft.has(node), ...(cap !== undefined ? { cap } : {}),
    });
  }
  profiles.seal();
  settledNodes.seal();
  summaries.seal();
  index.seal();

  const near = { s: 0, distance: 0 };
  const quantum = (h: number): number => Math.round(h * 1000);
  /** What a profile can give any point of a rectangle */
  const localDigest = (profile: Profile, minX: number, minY: number, maxX: number, maxY: number): number => {
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const r = Math.hypot(maxX - minX, maxY - minY) / 2;
    profile.line.closestInto(cx, cy, near);
    const reach = near.distance + 2 * r + profile.step;
    const reach2 = reach * reach;
    const digest = new Digest().add(profile.id).addText(profile.structure).add(profile.manualVertical ? 1 : 0)
      .add(profile.type).add(profile.half).add(profile.median).add(profile.sidewalk).add(profile.step).add(profile.h.length);
    if (profile.sidewalkLeft !== profile.sidewalkRight || profile.look) digest.add(profile.sidewalkLeft).add(profile.sidewalkRight).add(profile.look);
    const at = stationsAt(profile);
    for (let i = 0; i < profile.h.length; i++) {
      const dx = at[i * 2]! - cx, dy = at[i * 2 + 1]! - cy;
      if (dx * dx + dy * dy > reach2) continue;
      // Heights to a thousandth of a unit (0.4 mm)
      digest.add(i).add(quantum(profile.h[i]!));
      if (i > 0) digest.add(quantum(profile.h[i - 1]!));
      if (i + 1 < profile.h.length) digest.add(quantum(profile.h[i + 1]!));
    }
    // The line itself where it passes within reach: a piece of it whose nearest point to c is within reach, with its two ends.
    const xy = profile.line.xy;
    for (let k = 0; k + 3 < xy.length; k += 2) {
      const ax = xy[k]!, ay = xy[k + 1]!, bx = xy[k + 2]!, by = xy[k + 3]!;
      const ex = bx - ax, ey = by - ay;
      const len2 = ex * ex + ey * ey;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((cx - ax) * ex + (cy - ay) * ey) / len2)) : 0;
      const qx = ax + ex * t - cx, qy = ay + ey * t - cy;
      if (qx * qx + qy * qy > reach2) continue;
      digest.add(k).add(ax).add(ay).add(bx).add(by);
    }
    return digest.value();
  };

  /** The reads of the field, the same code a road tile worker runs over the roads handed to it (`roadField.ts`). */
  const field = roadField(index, profiles, terrainAt);
  /** Every road's summary and box, gathered only when a whole-map reader asks (`summaries`, `shapeBounds`). */
  let allSummaries: ReadonlyMap<SegmentId, Summary> | null = null;
  let boxes: readonly Aabb[] | null = null;
  const result: RoadElevation = {
    solved: solvedCount,
    at: field.at,
    remembering: field.remembering,
    onSegment: field.onSegment,
    roadAt: field.roadAt,
    surfaceFrameAt: field.surfaceFrameAt,
    fieldFor(rects, also) {
      const chain: Profile[] = [];
      for (const id of also) { const p = profiles.get(id); if (p) chain.push(p); }
      const { profiles: meet, cells } = index.meeting(rects, chain);
      return packField(meet, cells);
    },
    differences(other) {
      const out: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
      const take = (s: Summary): boolean => {
        if (s.oversized) return false;
        const box = s.box;
        out.push({ minX: box.minX - INDEX_CELL, minY: box.minY - INDEX_CELL, maxX: box.maxX + INDEX_CELL, maxY: box.maxY + INDEX_CELL });
        return true;
      };
      // From the solve this one was made from, only the roads it made can differ: DO NOT compare every road of the map.
      if (reuse && memos.get(other) === reuse) {
        for (const id of new Set([...touched, ...resolved])) {
          const s = summaries.get(id), t = reuse.summaries.get(id);
          if (s && t && s.digest === t.digest) continue;
          if ((s && !take(s)) || (t && !take(t))) return null;
        }
        return out;
      }
      const mineAll = result.summaries!();
      const theirs = other.summaries?.();
      if (!theirs) return null;
      for (const [id, s] of mineAll) {
        const t = theirs.get(id);
        if (t && t.digest === s.digest) continue;
        if (!take(s) || (t && !take(t))) return null;
      }
      for (const [id, t] of theirs) if (!mineAll.has(id) && !take(t)) return null;
      return out;
    },
    summaries: () => (allSummaries ??= new Map(summaries.entries())),
    digest: (minX, minY, maxX, maxY, reach) => {
      const known = new Map<Profile, number | null>();
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const r = Math.hypot(maxX - minX, maxY - minY) / 2;
      return index.digest(minX, minY, maxX, maxY, (profile) => {
        let value = known.get(profile);
        if (value === undefined) {
          // Out of reach of every point of the rectangle: nothing there reads it.
          if (reach !== undefined) profile.line.closestInto(cx, cy, near);
          value = reach !== undefined && near.distance - r > reach ? null : localDigest(profile, minX, minY, maxX, maxY);
          known.set(profile, value);
        }
        return value;
      });
    },
    nodeHeight(node) {
      return settledNodes.get(node)?.height ?? terrainAt(net.doc.node(node)?.x ?? 0, net.doc.node(node)?.y ?? 0) + ROAD_GROUND_CLEARANCE;
    },
    // Whole-map readers only (the ground shaped everywhere): gathered once.
    shapeBounds: () => (boxes ??= [...profiles.entries()].map(([, profile]) => profile.bbox)),
    shapeAt: (x, y, naturalGround) => roadShapeAt(index.near(x, y), x, y, naturalGround),
    shapeCut(rects) {
      const { profiles: meet, cells } = index.meeting(rects);
      return { field: packField(meet, cells).data, walls: Uint8Array.from(meet, (profile) => (profile.walls ? 1 : 0)) };
    },
    has(structures) {
      if (!structures) return total > 0;
      for (const structure of structures) if (present.has(structure)) return true;
      return false;
    },
  };
  const memo: SolveMemo = { terrainAt, state: net.state, profiles, nodes: settledNodes, summaries, index, present, total };
  memos.set(result, memo);
  if (flat) flatSolves.set(net, memo);
  if (typeof performance.measure === 'function') {
    performance.measure(reuse ? 'hitch:elevation/incremental' : 'hitch:elevation/full', { start: started, end: performance.now() });
  }
  return result;
}

// ------------------------------------------------------------ ground shaping

/** What the ground's shaping reads of a road (`roadShapeAt`): a solve's own profile, or its copy off the page. */
interface ShapingRoad {
  readonly structure: RoadStructure;
  readonly manualVertical: boolean;
  readonly walls: boolean;
  readonly half: number;
  readonly h: ArrayLike<number>;
  readonly step: number;
  readonly line: Pick<Polyline, 'closestInto'>;
}

/** The roads a shaping of the ground can read inside some rectangles */
export interface RoadShapeCut {
  readonly field: FieldData;
  readonly walls: Uint8Array;
}

/** Scratch of `roadShapeAt`'s nearest-point reads. */
const shapeHit = { s: 0, distance: 0 };

/** DO NOT give either side its own copy of it. */
function roadShapeAt(candidates: Iterable<ShapingRoad>, x: number, y: number, naturalGround: number): { height: number; weight: number } {
  // EVERY structure may shape the ground, and which one does is decided by authority rather than by distance.
  let bestWeight = 0;
  let bestHeight = 0;
  for (const profile of candidates) {
    profile.line.closestInto(x, y, shapeHit);
    const distance = shapeHit.distance;
    const inner = profile.half + SHAPE_INNER;
    // Cheap bound first: rejecting on the widest batter any road could ask for keeps a dense network from paying for every
    if (distance >= inner + SHAPE_SHOULDER_MAX) continue;
    const sunken = isSunken(profile.structure) ||
      (profile.manualVertical && naturalGround - heightAtArc(profile, shapeHit.s) > 0);
    const surface = heightAtArc(profile, shapeHit.s);
    // Under the road (carriageway and footway) the ground is pulled well below the deck, where nothing can show through it.
    const beside = !sunken && distance > profile.half - CASING_BAND;
    const height = beside ? surface - BESIDE_DROP : surface - SHAPE_DROP;
    // The batter is sized from the earthwork it has to carry away
    const shoulder = sunken || (profile.walls && naturalGround > height)
      ? CUT_SHOULDER
      : Math.min(SHAPE_SHOULDER_MAX, Math.max(SHAPE_SHOULDER, Math.abs(naturalGround - height) * BATTER));
    if (distance >= inner + shoulder) continue;
    let weight = 1 - smoothstep(inner, inner + shoulder, distance);
    if (isRaised(profile.structure) ||
      (profile.manualVertical && surface > naturalGround)) {
      // Lifted clear of the ground: the structure stands on piers and the landscape passes under it untouched.
      weight *= 1 - smoothstep(LIFT_ON, LIFT_OFF, surface - naturalGround);
    } else if (sunken) {
      // A road buried under its own hill is a TUNNEL, and a tunnel does not cut the hill open — it bores through it.
      weight *= 1 - smoothstep(TUNNEL_ROOF, TUNNEL_BORE, naturalGround - surface);
    }
    if (weight > bestWeight) {
      bestWeight = weight;
      bestHeight = height;
    }
  }
  return bestWeight <= 0 ? NO_SHAPE : { height: bestHeight, weight: bestWeight };
}

/** The roads of a cut (`RoadElevation.shapeCut`) read as the solve reads its own: `shapeAt` */
export function roadShaper(cut: RoadShapeCut, terrainAt: (x: number, y: number) => number = noGround):
  Pick<RoadElevation, 'shapeAt' | 'at' | 'roadAt'> {
  const profiles = unpackField(cut.field).map((p, k) => ({ ...p, walls: cut.walls[k] === 1 }));
  const index = new SpatialIndex(profiles, new Set(cut.field.cells));
  const reads = roadField(index, new Map(profiles.map((p) => [p.id, p])), terrainAt);
  return {
    shapeAt: (x, y, naturalGround) => roadShapeAt(index.near(x, y), x, y, naturalGround),
    at: reads.at,
    roadAt: reads.roadAt,
  };
}

const noGround = (x: number, y: number): number => { throw new Error(`no ground was given for (${x}, ${y})`); };

// ------------------------------------------------------------ incremental

/** A road's summary (`RoadElevation.summaries`): its whole solved profile as a digest, with its box. */
interface Summary {
  readonly digest: number;
  readonly box: Aabb;
  readonly oversized: boolean;
}

/** What a solve keeps for the next one on the same ground (`previous`): persistent, each solve a version of the one before. */
interface SolveMemo {
  readonly terrainAt: (x: number, y: number) => number;
  /** The network's state the solve was made from (`Network.changesSince`). */
  readonly state: object;
  readonly profiles: RerootMap<SegmentId, Profile>;
  /** Each node's inputs as text, and what it settled with. */
  readonly nodes: RerootMap<NodeId, SettledNode>;
  /** Each road's summary (`RoadElevation.summaries`): a road kept whole keeps its own. */
  readonly summaries: RerootMap<SegmentId, Summary>;
  readonly index: ProfileIndex;
  /** The roads by structure, counted, and in all. */
  readonly present: ReadonlyMap<RoadStructure, number>;
  readonly total: number;
}


/** What a node settled with: kept whole while its inputs (`key`) are the same. */
interface SettledNode {
  /** Where it stands, its authored height, its roads, as text. */
  readonly key: string;
  /** The height it settled at, and the one it started the rounds from (equal: no road carried it up). */
  readonly height: number;
  readonly start: number;
  /** Its grade height, whether every road there is raised, and the most a ramp lets it rise. */
  readonly grade: number;
  readonly aloft: boolean;
  readonly cap?: number;
}

/** The nodes' heights as the solvers read them. */
interface NodeHeights {
  get(node: NodeId): number | undefined;
}

const memos = new WeakMap<RoadElevation, SolveMemo>();

/** Level ground everywhere: the editing rules solve on it */
export const FLAT_GROUND = (): number => 0;
/** Each network's last solve on level ground: the next one on it, or on a working copy of it (`Network.fork`), starts there. */
const flatSolves = new WeakMap<Network, SolveMemo>();

/** The solves on level ground a solve of `net` may start from: its own last, then those of the networks it is a copy of. */
function flatSolvesOf(net: Network): (SolveMemo | undefined)[] {
  const out: (SolveMemo | undefined)[] = [];
  for (let at: Network | null = net; at; at = at.forkedFrom) out.push(flatSolves.get(at));
  return out;
}

/** Where each station of a profile lies (`h[i]` at arc `i * step`), measured once per profile (a profile is shared by solves). */
function stationsAt(profile: Profile): Float64Array {
  if (profile.points) return profile.points;
  const xy = new Float64Array(profile.h.length * 2);
  for (let i = 0; i < profile.h.length; i++) {
    const p = profile.line.sampleAt(Math.min(profile.length, i * profile.step)).p;
    xy[i * 2] = p.x;
    xy[i * 2 + 1] = p.y;
  }
  return (profile.points = xy);
}

const NO_PROFILES: readonly never[] = Object.freeze([]);

/** The profiles in id order with `profile` put in its place (replacing the one of its id): a new list, the old one kept. */
function withProfile(list: readonly Profile[], profile: Profile): Profile[] {
  let at = 0;
  while (at < list.length && list[at]!.id < profile.id) at++;
  const out = list.slice();
  if (at < list.length && list[at]!.id === profile.id) out[at] = profile;
  else out.splice(at, 0, profile);
  return out;
}

/** THE PROFILES BY THE CELLS THEIR BOXES COVER (`INDEX_CELL`), persistent: a solve files the roads it made, not every road */
class ProfileIndex {
  private constructor(
    private readonly buckets: RerootMap<number, readonly Profile[]>,
    /** Profiles over too many cells (`OVERSIZED_CELLS`), in id order: read by every query. */
    private oversizedList: readonly Profile[],
    /** How many profiles the cells hold. */
    private bucketed: number,
  ) {}

  static empty(): ProfileIndex {
    return new ProfileIndex(new RerootMap(), NO_PROFILES, 0);
  }

  /** The cells a box covers, or null when it covers too many to be filed in them. */
  private static cells(box: Aabb): readonly [number, number, number, number] | null {
    const x0 = Math.floor(box.minX / INDEX_CELL), x1 = Math.floor(box.maxX / INDEX_CELL);
    const y0 = Math.floor(box.minY / INDEX_CELL), y1 = Math.floor(box.maxY / INDEX_CELL);
    return (x1 - x0 + 1) * (y1 - y0 + 1) > OVERSIZED_CELLS ? null : [x0, x1, y0, y1];
  }

  static oversized(profile: Profile): boolean {
    return ProfileIndex.cells(profile.bbox) === null;
  }

  /** The next version, to be written; this one keeps answering as it did. */
  derive(): ProfileIndex {
    return new ProfileIndex(this.buckets.derive(), this.oversizedList, this.bucketed);
  }

  seal(): void {
    this.buckets.seal();
  }

  add(profile: Profile): void {
    const cells = ProfileIndex.cells(profile.bbox);
    if (!cells) { this.oversizedList = withProfile(this.oversizedList, profile); return; }
    const [x0, x1, y0, y1] = cells;
    this.bucketed++;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = cellKeyOf(x, y);
        this.buckets.set(key, withProfile(this.buckets.get(key) ?? NO_PROFILES, profile));
      }
    }
  }

  remove(profile: Profile): void {
    const cells = ProfileIndex.cells(profile.bbox);
    if (!cells) { this.oversizedList = this.oversizedList.filter((p) => p.id !== profile.id); return; }
    const [x0, x1, y0, y1] = cells;
    this.bucketed--;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = cellKeyOf(x, y);
        const list = this.buckets.get(key);
        if (!list) continue;
        const rest = list.filter((p) => p.id !== profile.id);
        if (rest.length) this.buckets.set(key, rest); else this.buckets.delete(key);
      }
    }
  }

  near(x: number, y: number): readonly Profile[] {
    if (this.bucketed === 0) return this.oversizedList;
    const bucket = this.buckets.get(cellKeyOf(Math.floor(x / INDEX_CELL), Math.floor(y / INDEX_CELL)));
    if (this.oversizedList.length === 0) return bucket ?? NO_PROFILES;
    return bucket ? [...bucket, ...this.oversizedList] : this.oversizedList;
  }

  /** Digest of every profile `near` can return for a point of the rectangle, in its order; a profile `of` gives null for is left out. */
  digest(minX: number, minY: number, maxX: number, maxY: number, of: (profile: Profile) => number | null): number {
    const digest = new Digest();
    for (let x = Math.floor(minX / INDEX_CELL); x <= Math.floor(maxX / INDEX_CELL); x++) {
      for (let y = Math.floor(minY / INDEX_CELL); y <= Math.floor(maxY / INDEX_CELL); y++) {
        const key = cellKeyOf(x, y);
        digest.add(key);
        for (const profile of this.buckets.get(key) ?? NO_PROFILES) {
          const value = of(profile);
          if (value !== null) digest.add(value);
        }
      }
    }
    digest.add(-1);
    for (const profile of this.oversizedList) {
      const value = of(profile);
      if (value !== null) digest.add(value);
    }
    return digest.value();
  }

  /** Every profile `near` can return for a point of the rectangles, and `also`, in id order; with the cells read. */
  meeting(rects: readonly (readonly [number, number, number, number])[], also: readonly Profile[] = []): { profiles: Profile[]; cells: number[] } {
    const picked = new Map<SegmentId, Profile>();
    for (const profile of this.oversizedList) picked.set(profile.id, profile);
    for (const profile of also) picked.set(profile.id, profile);
    const cells = new Set<number>();
    for (const [minX, minY, maxX, maxY] of rects) {
      for (let x = Math.floor(minX / INDEX_CELL); x <= Math.floor(maxX / INDEX_CELL); x++) {
        for (let y = Math.floor(minY / INDEX_CELL); y <= Math.floor(maxY / INDEX_CELL); y++) {
          const key = cellKeyOf(x, y);
          if (cells.has(key)) continue;
          cells.add(key);
          for (const profile of this.buckets.get(key) ?? NO_PROFILES) picked.set(profile.id, profile);
        }
      }
    }
    return { profiles: [...picked.values()].sort((p, q) => p.id - q.id), cells: [...cells] };
  }
}

function sameLine(a: Polyline, b: Polyline): boolean {
  if (a === b) return true;
  const x = a.xy, y = b.xy;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Whether a profile is built from the same inputs as the one solved before it. */
function sameProfile(a: Profile, b: Profile): boolean {
  return a.structure === b.structure && a.manualVertical === b.manualVertical && a.type === b.type &&
    a.half === b.half && a.median === b.median && a.sidewalk === b.sidewalk && a.length === b.length &&
    a.step === b.step && a.plateA === b.plateA && a.plateB === b.plateB && a.a === b.a && a.b === b.b &&
    a.ceil === b.ceil && a.base === b.base && a.sidewalkLeft === b.sidewalkLeft && a.sidewalkRight === b.sidewalkRight &&
    a.look === b.look;
}

/** A digest of what a road looks like beyond its widths (materials, flush footways); 0 for the class's own. */
function lookDigest(rt: RoadType): number {
  if (!rt.materials && !rt.flushLeft && !rt.flushRight && !rt.medianFlush) return 0;
  return new Digest().addText(JSON.stringify(rt.materials ?? null)).add(rt.flushLeft ? 1 : 0).add(rt.flushRight ? 1 : 0)
    .add(rt.medianFlush ? 1 : 0).value() || 1;
}

/** The ground under a road: the dilated ceiling and the designed grade line (see the stations step). */
function readStations(line: Polyline, half: number, count: number, step: number,
  terrainAt: (x: number, y: number) => number): { ceil: number[]; base: number[] } {
  const ceil: number[] = [];
  /** Mean ground across the casing: the line that balances cut against fill. */
  const mid: number[] = [];
  for (let i = 0; i < count; i++) {
    const frame = line.sampleAt(step * i);
    let ground = -Infinity;
    let sum = 0;
    for (const unit of LATERAL) {
      const value = terrainAt(frame.p.x + frame.n.x * half * unit, frame.p.y + frame.n.y * half * unit);
      if (value > ground) ground = value;
      sum += value;
    }
    ceil.push(ground + ROAD_GROUND_CLEARANCE);
    // The MEAN, not the maximum.
    mid.push(sum / LATERAL.length + ROAD_GROUND_CLEARANCE);
  }
  // A chord between two stations must clear the ground at BOTH of its ends or it dives under the terrain in between.
  dilate(ceil, DILATE);
  // The designed grade line, solved once and independently of any junction
  const base = mid.slice();
  smoothProfile(base, step, SMOOTH_REACH);
  slopeLimit(base, step, GROUND_GRADE);
  return { ceil, base };
}

// ---------------------------------------------------------------- solvers

/** A continuous authored vertical alignment, including ground, bridge and bore. */
function solveVariable(profile: Profile, nodeHeight: NodeHeights): void {
  const { h, base, step, length } = profile;
  const hA = nodeHeight.get(profile.a) ?? 0;
  const hB = nodeHeight.get(profile.b) ?? 0;
  const edgeA = profile.plateA;
  const edgeB = length - profile.plateB;
  const liftA = hA - (base[stationIndex(profile, edgeA)] as number);
  const liftB = hB - (base[stationIndex(profile, edgeB)] as number);
  const run = Math.max(1e-6, edgeB - edgeA);
  for (let i = 0; i < h.length; i++) {
    const s = i * step;
    if (s <= edgeA) h[i] = hA;
    else if (s >= edgeB) h[i] = hB;
    else {
      const u = (s - edgeA) / run;
      const eased = u * u * (3 - 2 * u);
      h[i] = (base[i] as number) + liftA * (1 - eased) + liftB * eased;
    }
  }
  // The ramp's grade unless the heights set at its two ends ask for more (as `solveGround`)
  const grade = Math.max(RAMP_GRADE, (Math.abs(hB - hA) / run) * 1.1);
  for (let round = 0; round < 3; round++) {
    slopeLimit(h, step, grade);
    pinPlates(profile, hA, hB);
  }
  roundGradeBreaks(profile, 'both');
  pinPlates(profile, hA, hB);
}

/** A road at grade: it follows the ground, flat over its junction plates. */
function solveGround(profile: Profile, nodeHeight: NodeHeights): void {
  const { h, base, step, length } = profile;
  const hA = nodeHeight.get(profile.a) ?? 0;
  const hB = nodeHeight.get(profile.b) ?? 0;
  // Anchored at the PLATE EDGE, not at the segment's end.
  const edgeA = stationIndex(profile, profile.plateA);
  const edgeB = stationIndex(profile, length - profile.plateB);
  const shiftA = hA - (base[edgeA] as number);
  const shiftB = hB - (base[edgeB] as number);
  const baseAt = (s: number): number => {
    const at = Math.min(base.length - 1, Math.max(0, s / step));
    const lo = Math.floor(at);
    const hi = Math.min(base.length - 1, lo + 1);
    return (base[lo] as number) + ((base[hi] as number) - (base[lo] as number)) * (at - lo);
  };
  const slopeA = (baseAt(profile.plateA + step) - baseAt(profile.plateA - step)) / (2 * step);
  const slopeB = (baseAt(length - profile.plateB + step) - baseAt(length - profile.plateB - step)) / (2 * step);
  // The transition is sized from the correction it has to carry.
  const tieFor = (shift: number): number =>
    Math.min(
      Math.max(m(0.4), length * 0.4),
      Math.max(TIE_REACH, (Math.abs(shift) * CURVE_PEAK) / (GROUND_GRADE * 0.5)),
    );
  const tieA = tieFor(shiftA);
  const tieB = tieFor(shiftB);

  for (let i = 0; i < h.length; i++) {
    const s = step * i;
    if (s <= profile.plateA) {
      h[i] = hA;
      continue;
    }
    if (s >= length - profile.plateB) {
      h[i] = hB;
      continue;
    }
    // The designed line, translated towards each junction over a transition rather than snapped to it at the plate edge.
    const wA = 1 - smoothstep(profile.plateA, profile.plateA + tieA, s);
    const wB = 1 - smoothstep(profile.plateB, profile.plateB + tieB, length - s);
    h[i] = (base[i] as number) + shiftA * wA + shiftB * wB;
  }
  // Both directions: a designed line is allowed to descend
  const free = Math.max(step, length - profile.plateA - profile.plateB);
  const grade = Math.max(GROUND_GRADE, (Math.abs(hB - hA) / free) * 1.1);
  for (let round = 0; round < 3; round++) {
    pinPlates(profile, hA, hB);
    slopeLimit(h, step, grade);
  }
  pinPlates(profile, hA, hB);
  roundGradeBreaks(profile, 'both');
  // The height tie above has zero derivative at its end, so the designed line's own slope survives against the flat plate.
  for (let i = 0; i < h.length; i++) {
    const s = step * i;
    if (s <= profile.plateA || s >= length - profile.plateB) continue;
    const fromA = s - profile.plateA;
    const fromB = length - profile.plateB - s;
    h[i] = (h[i] as number)
      - PLATE_TANGENT_SHARE * slopeA * fromA * Math.exp(-fromA / PLATE_TANGENT_REACH)
      + PLATE_TANGENT_SHARE * slopeB * fromB * Math.exp(-fromB / PLATE_TANGENT_REACH);
  }
  roundPlateJoins(profile);
}

/** The join of a level plate and the grade beyond it, rounded into a vertical curve. */
function roundPlateJoins(profile: Profile): void {
  const { h, step, length } = profile;
  const radius = Math.max(1, Math.round(VERTICAL_CURVE_REACH / Math.max(1e-3, step)));
  const source = h.slice();
  const last = source.length - 1;
  const edgeA = profile.plateA / step;
  const edgeB = (length - profile.plateB) / step;
  // Only where the slope limiter took hold right at the edge
  const steep = (from: number, dir: 1 | -1): boolean => {
    const i0 = Math.round(from), i1 = i0 + dir * radius;
    if (i1 < 0 || i1 > last) return false;
    return Math.abs((source[i1] as number) - (source[i0] as number)) / (radius * step) >= 0.75 * GROUND_GRADE;
  };
  const nearA = steep(Math.ceil(edgeA), 1), nearB = steep(Math.floor(edgeB), -1);
  for (let i = 0; i <= last; i++) {
    if (i <= edgeA || i >= edgeB) continue;
    if (!((nearA && i - edgeA <= radius) || (nearB && edgeB - i <= radius))) continue;
    const r = Math.min(radius, i, last - i);
    if (r < 1) continue;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += source[i + k] as number;
    h[i] = sum / (r * 2 + 1);
  }
}

/** Vertical curves wherever a road's grade changes. */
function roundGradeBreaks(profile: Profile, mode: 'both' | 'raise', intoPlates = false): void {
  const { h, step, length } = profile;
  const radius = Math.max(1, Math.round(VERTICAL_CURVE_REACH / Math.max(1e-3, step)));
  const source = h.slice();
  const last = source.length - 1;
  const edgeA = profile.plateA / step;
  const edgeB = (length - profile.plateB) / step;
  for (let i = 0; i <= last; i++) {
    if (i <= edgeA || i >= edgeB) continue;
    // On a road at grade the window reaches INTO a plate
    const r = intoPlates
      ? Math.min(radius, i, last - i)
      : Math.min(radius, Math.floor(i - edgeA), Math.floor(edgeB - i));
    if (r < 1) continue;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += source[i + k] as number;
    const mean = sum / (r * 2 + 1);
    h[i] = mode === 'raise' ? Math.max(source[i] as number, mean) : mean;
  }
}

/** A raised structure: a level deck between two short ramps. */
function solveRaised(
  profile: Profile,
  nodeHeight: NodeHeights,
  aloft: { has(node: NodeId): boolean },
  upperReach: { has(node: NodeId): boolean; get(node: NodeId): number | undefined },
): void {

  const { h, ceil, step, length } = profile;
  const spec = roadStructure(profile.structure);
  const hA = nodeHeight.get(profile.a) ?? 0;
  const hB = nodeHeight.get(profile.b) ?? 0;
  const landA = !aloft.has(profile.a);
  const landB = !aloft.has(profile.b);
  const nearLanding = upperReach.has(profile.a) || upperReach.has(profile.b);
  const edgeB = length - profile.plateB;
  const run = Math.max(1e-3, edgeB - profile.plateA);

  // The straight deck, from end to end.
  const startH = landA ? hA + spec.clearance + RAMP_CREST * 0.25 : hA;
  const endH = landB ? hB + spec.clearance + RAMP_CREST * 0.25 : hB;
  // Nothing under the deck may come closer than this to its surface
  const underside = spec.deck + FOOTWAY_RISE + m(0.4);
  for (let i = 0; i < h.length; i++) {
    const t = Math.min(1, Math.max(0, (step * i - profile.plateA) / run));
    const line = startH + (endH - startH) * t;
    h[i] = Math.max(line, (ceil[i] as number) + underside);
  }
  // A rise that pushed into the deck lifts it, and the lift is eased out along the deck rather than left as a bump.
  gradeEnvelope(h, step, nearLanding ? RAMP_GRADE : DECK_GRADE);
  if (!landA || !landB) {
    for (let i = 0; i < h.length; i++) {
      const s = step * i;
      if (!landA && s <= profile.plateA) h[i] = Math.max(h[i] as number, hA);
      if (!landB && s >= edgeB) h[i] = Math.max(h[i] as number, hB);
    }
    gradeEnvelope(h, step, nearLanding ? RAMP_GRADE : DECK_TIE);
  }

  for (let i = 0; i < h.length; i++) {
    const s = step * i;
    let value = h[i] as number;
    if (landA) value = smoothMin(value, hA + rampRise(s - profile.plateA), RAMP_CREST);
    if (landB) value = smoothMin(value, hB + rampRise(edgeB - s), RAMP_CREST);
    h[i] = value;
  }
  const rampA = landA ? rampLength(Math.max(0, startH - hA)) : 0;
  const rampB = landB ? rampLength(Math.max(0, endH - hB)) : 0;

  for (let i = 0; i < h.length; i++) {
    const s = step * i;
    // The ground floor is RELAXED towards each junction.
    const reachA = Math.max(PLATE_BLEND, rampA * RAMP_RELAX);
    const reachB = Math.max(PLATE_BLEND, rampB * RAMP_RELAX);
    const nearA = 1 - smoothstep(profile.plateA, profile.plateA + reachA, s);
    const nearB = 1 - smoothstep(profile.plateB, profile.plateB + reachB, length - s);
    const near = Math.max(nearA, nearB);
    const level = nearA >= nearB ? hA : hB;
    const floor = near <= 0
      ? (ceil[i] as number)
      : (ceil[i] as number) * (1 - near) + Math.min(ceil[i] as number, level) * near;
    h[i] = Math.max(h[i] as number, floor);
  }
  gradeEnvelope(h, step, RAMP_GRADE);
  roundGradeBreaks(profile, 'raise');
  // A raised junction next to a short landing can be lower than the span's free deck.
  if (nearLanding) {
    for (let i = 0; i < h.length; i++) {
      const s = step * i;
      if (upperReach.has(profile.a)) h[i] = Math.min(h[i] as number, hA + rampRise(s - profile.plateA));
      if (upperReach.has(profile.b)) h[i] = Math.min(h[i] as number, hB + rampRise(edgeB - s));
    }
  }
  flattenPlates(profile, hA, hB);
}


/** Height a ramp has gained `d` units past the plate edge */
function rampRise(d: number): number {
  if (d <= 0) return 0;
  if (d < RAMP_CURVE) return (RAMP_GRADE * d * d) / (2 * RAMP_CURVE);
  return RAMP_GRADE * (d - RAMP_CURVE / 2);
}

/** Plate edge to deck, for a ramp that climbs `rise`: sag, straight and crest. */
function rampLength(rise: number): number {
  return rise <= 0 ? 0 : rise / RAMP_GRADE + RAMP_CURVE;
}

/** The smaller of two heights with the corner between them rounded over a band `k` high (a quadratic smooth minimum). */
function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** A tunnel: a flat floor below the ground, with a ramp up to each end. */
function solveSunken(
  profile: Profile,
  nodeHeight: NodeHeights,
  /** The floor's height it wants (`wantedOf`). */
  wanted: number,
): void {
  const { h, step, length } = profile;
  const hA = nodeHeight.get(profile.a) ?? 0;
  const hB = nodeHeight.get(profile.b) ?? 0;
  const run = Math.max(1e-3, length - profile.plateA - profile.plateB);
  const target = Math.min(wanted, hA, hB);

  const slope = TUNNEL_GRADE / CURVE_PEAK;
  const dropA = Math.max(0, hA - target);
  const dropB = Math.max(0, hB - target);
  const need = (dropA + dropB) / slope;
  const scale = need > run ? run / need : 1;
  const floor = Math.min(hA, hB, target + (1 - scale) * Math.max(dropA, dropB));
  const rampA = Math.max(0, (hA - floor) / slope);
  const rampB = Math.max(0, (hB - floor) / slope);

  for (let i = 0; i < h.length; i++) {
    const s = step * i;
    if (s <= profile.plateA) {
      h[i] = hA;
      continue;
    }
    if (s >= length - profile.plateB) {
      h[i] = hB;
      continue;
    }
    const along = s - profile.plateA;
    const back = run - along;
    const down = rampA <= 0 ? floor : hA + (floor - hA) * ease(along / rampA);
    const up = rampB <= 0 ? floor : hB + (floor - hB) * ease(back / rampB);
    // The HIGHER of the two ends wins, for the reason the raised solver takes the lower
    h[i] = Math.max(down, up);
  }
  descentEnvelope(h, step, TUNNEL_GRADE);
  flattenPlates(profile, hA, hB);
}

/** Holds both junction plates flat at the height the node settled on. */
function flattenPlates(profile: Profile, hA: number, hB: number): void {
  const { h, step, length } = profile;
  let topA = hA;
  let topB = hB;
  for (let i = 0; i < h.length; i++) {
    const s = step * i;
    if (s <= profile.plateA) topA = Math.max(topA, h[i] as number);
    if (s >= length - profile.plateB) topB = Math.max(topB, h[i] as number);
  }
  for (let i = 0; i < h.length; i++) {
    const s = step * i;
    if (s <= profile.plateA) h[i] = topA;
    else if (s >= length - profile.plateB) h[i] = topB;
  }
}

/** Raises samples until no step between them exceeds the gradient. */
function gradeEnvelope(h: number[], step: number, grade: number): void {
  const limit = grade * step;
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < h.length; i++) h[i] = Math.max(h[i] as number, (h[i - 1] as number) - limit);
    for (let i = h.length - 2; i >= 0; i--) h[i] = Math.max(h[i] as number, (h[i + 1] as number) - limit);
  }
}

/** Lowers samples until no step between them exceeds the gradient. */
function descentEnvelope(h: number[], step: number, grade: number): void {
  const limit = grade * step;
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < h.length; i++) h[i] = Math.min(h[i] as number, (h[i - 1] as number) + limit);
    for (let i = h.length - 2; i >= 0; i--) h[i] = Math.min(h[i] as number, (h[i + 1] as number) + limit);
  }
}

/** A moving average over a fixed length of road, in place. */
function smoothProfile(values: number[], step: number, reach: number): void {
  const radius = Math.max(1, Math.round(reach / Math.max(1e-3, step)));
  if (values.length < 3) return;
  const source = values.slice();
  const last = source.length - 1;
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      sum += source[j < 0 ? 0 : j > last ? last : j] as number;
    }
    values[i] = sum / (radius * 2 + 1);
  }
}

/** Limits the gradient between neighbouring stations, in BOTH directions. */
function slopeLimit(h: number[], step: number, grade: number): void {
  const limit = grade * Math.max(1e-3, step);
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 1; i < h.length; i++) {
      const previous = h[i - 1] as number;
      h[i] = Math.min(previous + limit, Math.max(previous - limit, h[i] as number));
    }
    for (let i = h.length - 2; i >= 0; i--) {
      const next = h[i + 1] as number;
      h[i] = Math.min(next + limit, Math.max(next - limit, h[i] as number));
    }
  }
}

/** Holds both junction plates flat at exactly the height the node settled on. */
function pinPlates(profile: Profile, hA: number, hB: number): void {
  const { h, step, length } = profile;
  for (let i = 0; i < h.length; i++) {
    const s = step * i;
    if (s <= profile.plateA) h[i] = hA;
    else if (s >= length - profile.plateB) h[i] = hB;
  }
}

function dilate(values: number[], reach: number): void {
  const source = values.slice();
  for (let i = 0; i < values.length; i++) {
    let high = source[i] as number;
    for (let k = -reach; k <= reach; k++) {
      const j = i + k;
      if (j < 0 || j >= source.length) continue;
      const value = source[j] as number;
      if (value > high) high = value;
    }
    values[i] = high;
  }
}

const ease = (t: number): number => {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
};

function stationIndex(profile: Profile, s: number): number {
  const at = Math.round(s / profile.step);
  return at < 0 ? 0 : at >= profile.h.length ? profile.h.length - 1 : at;
}
