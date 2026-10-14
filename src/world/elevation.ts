import { Digest } from '@core/digest';
import { type Aabb, expand as expandBox } from '@core/aabb';
import { Polyline } from '@core/polyline';
import type { NodeId, SegmentId } from './ids';
import type { Network } from './network';
import { CASING_BAND, FOOTWAY_RISE, Level, type RoadType, casingHalf, footwayOn } from './roadTypes';
import { m } from './units';
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

/**
 * ONE continuous height field for every road surface in the network.
 *
 * ## Why this module exists
 *
 * A road surface is not drawn as a strip per segment: the whole network is
 * clipped into four band polygons (`world/surfaces.ts`) and each band becomes a
 * single mesh. A mesh vertex therefore knows only its own `(x, y)` — it does not
 * know which segment it came from — so the elevation has to be a FUNCTION OF
 * POSITION, and that function must be continuous. Anything else tears the mesh:
 *
 *  - a per-segment profile picked by "nearest segment" steps at every point
 *    where the nearest segment changes, which is exactly the middle of every
 *    junction — the cracks, steps and overlapping plates reported as broken
 *    mesh;
 *  - `max(profile, terrain + clearance)` evaluated per vertex makes the surface
 *    copy the terrain inside junctions while the ribbon stays flat, so a
 *    junction became a dented bowl rather than a plate;
 *  - a raised deck whose height was the nearest span's made two spans of one
 *    chain disagree over the junction between them.
 *
 * The field below is continuous by construction and solves the whole network at
 * once, so every band, every marking and every agent reads the SAME number at
 * the same point. That is what makes the surfaces watertight.
 *
 * ## How it is built
 *
 * 1. Every segment gets a longitudinal profile sampled at fixed stations.
 * 2. The ends of every profile are FLAT over the junction's own reach (the trim
 *    distance the network already computed). That flat piece is the junction
 *    plate: because every leg of a node is flat at the same node height over
 *    that reach, the plate and all its legs agree exactly.
 * 3. Node heights are solved globally, so a node shared by four roads has one
 *    height and a raised span landing on a ground road lands ON it.
 * 4. Profiles are grade-limited (raise-only) so a road never exceeds its class
 *    gradient and never dives under the ground it already cleared.
 *
 * ## How it is queried
 *
 * `at(x, y)` blends the profiles of the segments near the point with weights
 * that fall off smoothly with distance. Far from a junction the nearest segment
 * dominates and the answer is its profile; inside a junction all legs are flat
 * at the node height, so every blend of them is that same height. The blend has
 * no discontinuity anywhere, which is the property the mesh needs.
 */

/** Station spacing along a profile, in world units. */
const STATION = m(1.6);
/** Hard cap on stations per segment, so a 4 km road does not allocate 1000. */
const MAX_STATIONS = 400;
/**
 * Extra reach past the junction trim that the junction plate has to cover.
 *
 * More than one `STATION`: a profile is read by interpolating between stations,
 * so it is exactly flat only up to the last station INSIDE the plate, which can
 * be a whole station short of the plate's nominal edge. At three units that
 * left the last unit of every junction polygon interpolating towards the ramp
 * or the deck beyond - a few hundredths of a step in the plate, measured on
 * elevated crossroads. One station plus a unit keeps the flat part past the
 * junction outline whatever the spacing.
 */
const PLATE_MARGIN = STATION + m(0.4);
/** Lateral samples across the casing when reading the ground under a road. */
const LATERAL = [-1, -0.62, -0.28, 0, 0.28, 0.62, 1] as const;
/** Stations either side of one that must also be cleared (chord protection). */
const DILATE = 2;
/** Steepest gradient of a road at grade (rise / run), from `roads/tuning.ts`. */
const GROUND_GRADE = ROAD_TUNING.grade.ground;
/**
 * How far along a road its grade line is averaged, in world units.
 *
 * This is what turns "copy the ground" into "design a road". A road at grade
 * used to take the dilated terrain ceiling as its own profile, so it rode over
 * every hummock the brush left behind: a ribbon rippling along a field, which
 * is exactly what a player means by a road that is not level. A real alignment
 * is a smooth line through the ground with the ground cut away above it and
 * filled in below it, and the length over which it is smooth is what decides
 * how much earth gets moved. Ninety units is about thirty-six metres, long
 * enough to ignore brush-sized bumps and short enough to follow a real hillside.
 */
const SMOOTH_REACH = m(36);
/**
 * How far past its junction plate a profile is tied back to the node height.
 *
 * The designed line and the junction it ends at are solved separately, so they
 * disagree by whatever the smoothing removed. Correcting that over a transition
 * — rather than at the plate edge — is what keeps the join from becoming a
 * visible kink in an otherwise level road.
 */
const TIE_REACH = m(28);
/**
 * How far past a junction plate the ground floor stops constraining a ramp.
 *
 * The junction is a platform cut into whatever it sits on, so the natural
 * ground there is not a floor the structure landing on it has to respect.
 */
const PLATE_BLEND = m(16);
/**
 * The share of a ramp over which the natural ground stops being a floor.
 *
 * A ramp coming down to a junction on a mound has to pass THROUGH the mound;
 * insisting it stay above the untouched ground meant it could not reach the
 * street at all, and the junction was dragged up to meet it instead. The ground
 * along a ramp is excavated for exactly the same reason it is beside a road at
 * grade — see `shapeAt`, which shapes under a structure wherever the structure
 * has come down to the ground.
 */
const RAMP_RELAX = 0.8;
/** Lift above the ground at which a structure stops shaping it: piers, not fill. */
const LIFT_ON = ROAD_TUNING.structure.liftOn;
const LIFT_OFF = ROAD_TUNING.structure.pierFrom;
/**
 * Grade of the straight part of a ramp between a raised deck and a road at
 * grade: sixteen per cent.
 *
 * The first ramp was one smoothstep sized so its peak slope was 8 %, a mean of
 * 5.3 %: a fifteen-unit climb took 262 units, and with the deck held at the
 * highest ground under the span the two ramps of a 900-unit span met in the
 * middle, so the whole structure was one hump. The second, at 10 % over
 * 30-unit curves with a deck that followed the land, still took 183 units and
 * still read, from the game's camera, as a road sloping from end to end - the
 * player rejected both: "the ramp must be a few metres, not a thing with no
 * end".
 *
 * Sixteen per cent is steep for a highway and ordinary for what this is: a
 * short urban access ramp at low speed. Parking and service ramps are built at
 * 15-20 %, residential streets in hilly cities run 15 % and more, and the
 * ramp guidance for low design speeds (AASHTO Green Book ch. 10, TxDOT 15.7)
 * rises steeply as the speed falls. Here it buys what the player asked for: the
 * full climb, curves included, inside 100 units - forty metres - so the ramp is
 * a distinct piece of road at each end and the deck between is level.
 */
const RAMP_GRADE = ROAD_TUNING.grade.ramp;
/** Maximum authored height change per unit of alignment before a ramp needs more run. */
export const MAX_AUTHORED_GRADE = ROAD_TUNING.grade.authored;
/**
 * Length of the vertical curve at the foot of a ramp, where the grade builds up
 * from level, in world units (8 m). The crest at the top is rounded by
 * `RAMP_CREST`.
 *
 * It was 12 units (5 m): the full 16 % arrived within one car length - a kink
 * rather than a curve, 0.11 of grade change inside 3 m on the inspection map.
 * Both curves are as long as the player's rule "the whole climb in at most
 * 100 units" leaves room for: 0.09 at the crest, 0.06 at the sag.
 */
const RAMP_CURVE = m(8);
/**
 * Reach of the vertical curves rounded into a road wherever its grade changes
 * (see `roundGradeBreaks`), in world units (5 m each side).
 */
const VERTICAL_CURVE_REACH = m(4.8);
/** Decay length of the grade correction just outside a flat junction plate. */
const PLATE_TANGENT_REACH = m(16);
/** Cancels enough of the incoming grade to round the join without bending the whole hill. */
const PLATE_TANGENT_SHARE = 0.55;
/** Softness of the crest where a ramp meets its deck (a height: 3.2 m of run at the ramp's grade). */
const RAMP_CREST = m(3.2) * RAMP_GRADE;
/** Steepest gradient with which a deck is carried up to a higher deck it meets in the air. */
const DECK_TIE = ROAD_TUNING.grade.deckTie;
/**
 * Steepest grade a deck may take to clear a rise under it. The deck is a
 * straight line between its two ends; only a hill poking up into it bends it,
 * and then no faster than this.
 */
const DECK_GRADE = ROAD_TUNING.grade.deck;
/**
 * Peak-to-mean slope ratio of the smoothstep used for vertical curves.
 *
 * A ramp eased with `t*t*(3-2t)` reaches 1.5x its average slope in the middle,
 * so a ramp sized as `rise / grade` actually climbs at `1.5 * grade`. Sizing it
 * from the peak is what makes the stated gradient the real one.
 */
const CURVE_PEAK = 1.5;
/**
 * Most rounds of the profile solve. A node lifted by one of its roads re-solves
 * the others, and along a chain that travels one node per round; the solve
 * stops as soon as nothing moves, which on any map built so far is within a
 * handful of rounds. The cap only bounds a pathological network.
 */
const MAX_SOLVE_PASSES = 64;
/** Softness of the blend between neighbouring profiles, in world units. */
const BLEND_TAU = m(1);
/**
 * How far from a road its own profile is the whole answer.
 *
 * Comfortably past the widest casing (a boulevard's is 31.5) and past the reach
 * of any junction ring, so every vertex of every road surface is decided by the
 * road and never by the ground beside it.
 */
const PROFILE_REACH = m(24);
/**
 * How far out the road's influence fades to nothing.
 *
 * Beyond `PROFILE_REACH` the answer eases from the road's deck to the terrain,
 * reaching the terrain exactly here. Without that easing the field simply
 * STOPPED at the last road it could find and jumped to the ground: measured on
 * a cross over a hill, an 8.8-unit step a few tens of units off the kerb. No
 * road surface reaches that far today, but a field with a cliff in it is a
 * mesh waiting to tear, and the fade costs one smoothstep per query.
 */
const PROFILE_FADE = m(44);
/**
 * How far from a point ON a road any profile can still change what a query
 * there answers: the point is within `PROFILE_REACH` of its own road, and a
 * profile is blended in only while its weight exp(-(d - best) / BLEND_TAU)
 * is over 1e-4 (`blend`). A road surface reads nothing farther, so a profile
 * past this from a tile cannot change the tile (`digest` with a reach).
 */
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
  /** Each side's footway, left and right of a -> b (docs/VIAS.md V1). */
  readonly sidewalkLeft: number;
  readonly sidewalkRight: number;
  /**
   * A digest of the road's look - its materials, which footway is flush -
   * or 0 for the class's own: a road query answers for it (`roadAt` names
   * the segment), so a tile drawn with it must be drawn again when it changes.
   */
  readonly look: number;
  readonly line: Polyline;
  readonly length: number;
  readonly step: number;
  /** Deck height at station `i`, i.e. at arc `i * step`. */
  readonly h: number[];
  /** Ground under the road at station `i`, plus the surface clearance. */
  readonly ceil: number[];
  /**
   * The designed grade line: the BALANCED ground under the road, smoothed and
   * slope-limited. A road at grade is built from this, not from `ceil`, so it
   * cuts through what rises above it and is filled up over what falls away.
   */
  readonly base: number[];
  /**
   * For a raised structure, the ground under it plus its clearance: what the
   * deck would be over each station if nothing else constrained it. Empty for
   * anything else.
   */
  readonly deck: number[];
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

export interface RoadElevation {
  /**
   * Deck height of the road surface at a world point.
   *
   * `structures` restricts the answer to one structural level, which is what a
   * render pass wants: the ground pass must not read the elevated deck that
   * flies over it. With no filter every road is considered.
   */
  at(x: number, y: number, structures?: ReadonlySet<RoadStructure>, includeManual?: boolean): number;
  /** Deck height on one specific segment — what an agent riding it stands on. */
  onSegment(segment: SegmentId, x: number, y: number): number;
  /** The solved height of a node, shared by every road that meets there. */
  nodeHeight(node: NodeId): number;
  /** Whether any road of these structures exists at all. */
  has(structures?: ReadonlySet<RoadStructure>): boolean;
  /**
   * Everything a surface needs to know about the road nearest a point.
   *
   * `along` and `across` are road-local coordinates: surface textures are laid
   * in that frame rather than in world axes, so asphalt grain runs along the
   * carriageway and a kerb's joints run along the kerb, whatever direction the
   * road happens to point. `type` is the class index, which is what lets one
   * asphalt mesh carry a residential street's grey and an avenue's near-black
   * in the same draw call.
   */
  roadAt(x: number, y: number, structures?: ReadonlySet<RoadStructure>, includeManual?: boolean): RoadSample;
  /**
   * Texture coordinates of (x, y) in the frame of the road nearest to
   * (pickX, pickY), continued in a straight line past the road's ends.
   *
   * `roadAt` answers "which road is this point on", and past the end of a
   * centreline its `across` is a RADIAL distance and its `along` is stuck at
   * the end - right for clearances, and the fan of streaks in every junction
   * corner when used as a texture frame. This extends the frame linearly
   * instead, and lets the caller pick the road from a different point, so a
   * whole triangle can be framed by one road (see `uvFrame` in
   * `render/mesh/surfaceMesh.ts`).
   */
  surfaceFrameAt(
    x: number,
    y: number,
    structures: ReadonlySet<RoadStructure> | undefined,
    pickX: number,
    pickY: number,
    includeManual?: boolean,
    segment?: SegmentId,
    /**
     * Lay `along` at the true length of each line parallel to the road
     * (docs/VIAS.md V1, no stretch on a curve), restarting every `panel`
     * units of road: a pattern keeps its size on the inside and the outside
     * of a bend, with a joint at each panel's edge, as paving is laid.
     */
    panel?: number,
  ): { along: number; across: number };
  /**
   * How far the ground should be pulled towards the road at a point, and to
   * what height.
   *
   * `weight` is 1 where the terrain must meet the road exactly, eases to 0 over
   * the shoulder, and is 0 where the road is buried deeply enough to be a
   * tunnel. See `render/terrain.ts`, which is the only caller.
   */
  shapeAt(x: number, y: number, naturalGround: number): { height: number; weight: number };
  /**
   * Boxes outside which `shapeAt` always answers weight 0: every road's
   * influence box, which is wider than the widest batter it may shape.
   */
  shapeBounds(): readonly Aabb[];
  /**
   * A digest of everything a height, frame or road query can read at any
   * point of a rectangle, the terrain aside: the solved profile of every road
   * the spatial index could hand such a query, in the order it would. Two
   * builds that agree on it answer every query there identically, which is
   * what lets the renderer keep the meshes of the parts of the map an edit
   * did not reach. With `reach`, only for queries at points within reach of
   * their nearest road (`SURFACE_READ_REACH` for a road surface): a road
   * whose line passes farther from the rectangle is left out.
   */
  digest(minX: number, minY: number, maxX: number, maxY: number, reach?: number): number;
  /**
   * Where this solve and another can differ: the boxes (as the spatial index
   * files them) of every road whose solved profile is not the same in both,
   * or that only one has; `null` for everywhere (a road too big to file).
   * A rectangle no box reaches has the same `digest` in both.
   */
  differences?(other: RoadElevation): { minX: number; minY: number; maxX: number; maxY: number }[] | null;
  /** Each road's whole solved profile as a digest, with its box (for `differences`). */
  summaries?(): ReadonlyMap<SegmentId, { digest: number; box: Aabb; oversized: boolean }>;
}

interface RoadSample {
  /** Distance along the nearest road, in world units. */
  readonly along: number;
  /** Signed offset across it. */
  readonly across: number;
  /** Class index of that road, or -1 when there is no road near the point. */
  readonly type: number;
  /** Half the casing width of that road. */
  readonly half: number;
  /** Its central reservation width. */
  readonly median: number;
  /** Its actual footway width, including the kerb. Optional for older query adapters. */
  readonly sidewalk?: number;
  /** Each side's footway, left and right of a -> b, when they differ. */
  readonly sidewalkLeft?: number;
  readonly sidewalkRight?: number;
  /** The segment the point was read off. */
  readonly segment?: SegmentId;
}

export const GROUND_ONLY: ReadonlySet<RoadStructure> = new Set<RoadStructure>(['ground']);
const NO_SHAPE = { height: 0, weight: 0 } as const;

/** Extra width past the casing over which the ground is held at road level. */
const SHAPE_INNER = m(1.2);
/**
 * Width of the embankment or cutting that carries the ground back to its
 * natural height.
 *
 * Wide on purpose. A road laid on rolling ground has to sit at ONE height
 * across its full width, so where the ground falls away there is a difference
 * to absorb; absorbing it over a few units is a wall, and a wall is what the
 * verge skirt used to draw. Forty-five units is about eighteen metres of
 * batter, which is what a real embankment looks like and is also wide enough
 * to read smoothly against a sixteen-unit terrain cell.
 */
const SHAPE_SHOULDER = m(18);
/**
 * Run per unit of rise on a cut or fill batter — a 1:2.5 slope.
 *
 * The shoulder is no longer a fixed width, because a fixed width is a fixed
 * ANGLE only when the height difference is fixed too. A road designed through a
 * hill now cuts several units into it, and forty-five units of shoulder turned a
 * ten-unit cut into a 1:4.5 face and a twenty-five unit one into a cliff. Sizing
 * the batter from the actual difference is what keeps every cut and every
 * embankment at the same believable angle.
 */
const BATTER = 2.5;
/** Cap on the batter, so one deep cut cannot reshape a quarter of the map. */
const SHAPE_SHOULDER_MAX = m(36);
/**
 * The same batter for a tunnel's approach cutting, and much narrower.
 *
 * A cutting is not an embankment. An embankment spreads: the fill has to find
 * its angle of repose and a wide batter is what makes it read as landscape
 * rather than as a wall. A cutting is dug, its sides are held, and — decisively
 * for this renderer — the ground it holds down has to STEP back up at the
 * portal, because a heightfield cannot have a hole in it. The wider that band,
 * the wider the step, and the step has to be covered by a headwall wide enough
 * to hide it. Sixteen units is a cutting the portal can close.
 */
const CUT_SHOULDER = m(6.4);
/**
 * How far past a road's casing a cutting held by retaining walls is dug
 * (`RoadSegment.cutWalls`): the ground held at road level beside it, then
 * the portal's narrow batter. The renderer covers that band with the wall's
 * backfill and reads the natural ground just past it (`render/structures.ts`).
 */
export const CUT_WALL_REACH = SHAPE_INNER + CUT_SHOULDER;
/**
 * How far below the road SURFACE the ground beside it is pulled.
 *
 * It was `ROAD_GROUND_CLEARANCE` — three tenths of a unit — and that is not
 * enough. The shaper answers for the nearest profile alone while the road mesh
 * reads the blended field, the terrain is a 16-unit grid whose triangles
 * interpolate between shaped corners, and the lowest road band (the verge) is
 * itself only a tenth of a unit below the deck. The three together left the
 * drawn ground up to seven tenths of a unit ABOVE the drawn verge in places —
 * measured by the visual verifier, which counts road vertices under the terrain
 * and found twenty-one of them on a flat crossroads.
 *
 * A unit and a half of margin absorbs all three, and it costs nothing visually:
 * the verge's skirt is sized from `terrainAt` (`soffit` in
 * `render/roadSurfaces.ts`), so it simply grows to meet the ground, and what the
 * player sees at the rim is a shoulder rather than a hairline of sky.
 */
const SHAPE_DROP = m(0.6);
/**
 * How far under the carriageway the ground beside a road is laid: 10 cm, so
 * no ground interpolated across a terrain cell can stand above the asphalt.
 */
const BESIDE_DROP = m(0.1);

/**
 * Solves the height of every road surface in the network.
 *
 * `terrainAt` must be the height the terrain is DRAWN at, not the analytic
 * field behind it: a road is laid on the triangles the player sees, and the
 * difference between the two is larger than the clearance a road carries.
 */
export function buildRoadElevation(
  net: Network,
  terrainAt: (x: number, y: number) => number,
  /**
   * A solve of this network on the SAME ground (`terrainAt` answering the
   * same heights, through whatever function): what did not change is taken
   * from it instead of solved again (see `SolveMemo`). The caller vouches for
   * the ground: the renderer passes its last solve only while the land has not
   * moved, and the road tool hands the renderer's to the tunnel test of a
   * commit on the same natural ground. A solve on `FLAT_GROUND` finds the last
   * flat solve by itself.
   */
  previous?: RoadElevation | null,
): RoadElevation {
  const started = performance.now();
  const profiles: Profile[] = [];
  /** The structures among `profiles`, once they are all laid (`has`). */
  let present: Set<RoadStructure> | null = null;
  const byId = new Map<SegmentId, Profile>();
  const prior = previous ? memos.get(previous) : terrainAt === FLAT_GROUND && lastFlat ? memos.get(lastFlat) : undefined;
  // Never level ground for real ground or the other way round, whatever the caller says.
  const reuse = prior && (prior.terrainAt === FLAT_GROUND) === (terrainAt === FLAT_GROUND) ? prior : null;
  const stationsById = new Map<SegmentId, Stations>();
  /** Profiles whose stations were taken from `reuse` (the line, the width and the ground the same). */
  const keptStations = new Set<SegmentId>();

  // ---------------------------------------------------------------- stations
  for (const [id, ribbon] of net.ribbons) {
    const segment = net.doc.segment(id);
    if (!segment) continue;
    const line = ribbon.full;
    const length = Math.max(1e-3, line.length);
    const count = Math.max(2, Math.min(MAX_STATIONS, Math.ceil(length / STATION) + 1));
    const step = length / (count - 1);
    const half = casingHalf(ribbon.road);
    // The ground under a road is read at 7 points across every 4 units of
    // it, and its grade line smoothed: most of a solve. The same line, as
    // wide, on the same ground reads the same - taken as it was.
    const known = reuse?.stations.get(id);
    const kept = known !== undefined && known.half === half && sameLine(known.line, line);
    const { ceil, base } = kept ? known : readStations(line, half, count, step, terrainAt);
    if (kept) keptStations.add(id);
    stationsById.set(id, { line, half, ceil, base });

    const trims = net.trims.get(id);
    // A taper where one road carries on at another width is not a junction
    // plate. Nothing crosses it, so nothing needs it level: holding its whole
    // length flat put a 150-unit shelf in a road climbing a hill. The two
    // profiles simply meet at the node, as two spans of one road do.
    const reachOf = (node: NodeId, trim: number | undefined): number => {
      if (net.doc.node(node)?.smooth && !net.junctions.has(node)) return 0;
      if (net.transitions.has(node)) return PLATE_MARGIN;
      // The plate is flat over the junction's whole footprint, its footways
      // and verges included (`Network.plateReach`).
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
    profiles.push(profile);
    byId.set(id, profile);
  }

  // ------------------------------------------------------------ node heights
  const incident = new Map<NodeId, Profile[]>();
  for (const profile of profiles) {
    for (const node of [profile.a, profile.b]) {
      const list = incident.get(node);
      if (list) list.push(profile);
      else incident.set(node, [profile]);
    }
  }

  // ------------------------------------------------- what is solved again
  // Each node's inputs, as text: where it stands, its authored height, its roads.
  const nodeKeys = new Map<NodeId, string>();
  for (const [node, list] of incident) {
    const point = net.doc.node(node);
    nodeKeys.set(node, `${point?.x},${point?.y}|${point?.heightOffset}|${list.map((p) => p.id).join(',')}`);
  }
  // The connected pieces whose every road and node is as solved before keep
  // their heights (`SolveMemo`); the rest is solved below, and only the rest.
  const solvedNodes = new Set<NodeId>(incident.keys());
  const solvedProfiles = new Set<Profile>(profiles);
  if (reuse) {
    const parent = new Map<NodeId, NodeId>();
    const find = (n: NodeId): NodeId => {
      let root = n;
      while (parent.get(root) !== root) root = parent.get(root) as NodeId;
      for (let at = n; at !== root;) { const next = parent.get(at) as NodeId; parent.set(at, root); at = next; }
      return root;
    };
    for (const node of incident.keys()) parent.set(node, node);
    for (const profile of profiles) parent.set(find(profile.a), find(profile.b));
    const changed = new Set<NodeId>();
    for (const profile of profiles) {
      const before = reuse.profiles.get(profile.id);
      if (!before || !keptStations.has(profile.id) || !sameProfile(before, profile)) changed.add(find(profile.a));
    }
    for (const [node, key] of nodeKeys) if (reuse.nodes.get(node)?.key !== key) changed.add(find(node));
    for (const node of incident.keys()) if (!changed.has(find(node))) solvedNodes.delete(node);
    for (const profile of profiles) {
      if (solvedNodes.has(profile.a)) continue;
      solvedProfiles.delete(profile);
      const before = (reuse.profiles.get(profile.id) as Profile).h;
      for (let i = 0; i < profile.h.length; i++) profile.h[i] = before[i] as number;
    }
  }

  /** The mean ground over a junction's own disc, for a node no road at grade reaches. */
  const balancedAtNode = new Map<NodeId, number>();
  for (const [node, list] of incident) {
    if (!solvedNodes.has(node)) continue;
    const point = net.doc.node(node);
    if (!point) continue;
    let sum = terrainAt(point.x, point.y);
    let count = 1;
    let radius = m(2.4);
    for (const profile of list) {
      const plate = profile.a === node ? profile.plateA : profile.plateB;
      radius = Math.max(radius, plate, profile.reach - m(8));
    }
    for (let ring = 1; ring <= 2; ring++) {
      const r = (radius * ring) / 2;
      for (let k = 0; k < 8; k++) {
        const angle = (k / 8) * Math.PI * 2 + ring * 0.4;
        sum += terrainAt(point.x + Math.cos(angle) * r, point.y + Math.sin(angle) * r);
        count++;
      }
    }
    balancedAtNode.set(node, sum / count + ROAD_GROUND_CLEARANCE);
  }

  /**
   * Grade height of a node: where the roads meeting there WANT to be.
   *
   * The mean of each incident road's own designed grade line at its own end,
   * rather than the highest ground anywhere near the junction. Taking the
   * maximum perched every junction on the tallest hummock within its plate and
   * then made all four legs climb to it — a pimple at every crossroads, and the
   * reason a network over gentle ground looked like a relief map of itself.
   * Averaging the legs puts the junction where the roads already are, and each
   * leg's own tie-in absorbs the small difference.
   */
  const gradeHeight = new Map<NodeId, number>();
  for (const [node, list] of incident) {
    if (!solvedNodes.has(node)) continue;
    let sum = 0;
    let count = 0;
    for (const profile of list) {
      // ONLY roads built at grade. A viaduct's designed grade line exists — it
      // is computed for every profile — but the viaduct never uses it, and
      // letting it vote pulled a junction at the foot of a ramp eight units
      // above the street that actually meets it, which the gradient limiter
      // then refused to climb and left as a step in the plate.
      if (isRaised(profile.structure) || isSunken(profile.structure)) continue;
      // At the PLATE EDGE, not at the segment's endpoint. The plate is a flat
      // platform tens of units across, so the height that matters is the one its
      // legs actually reach where it begins — reading the line at the geometric
      // centre instead put the junction on the crest the plate is meant to cut
      // through, and left every leg with three units to climb in the last four.
      const edge = profile.a === node ? profile.plateA : profile.length - profile.plateB;
      sum += profile.base[stationIndex(profile, edge)] as number;
      count++;
    }
    gradeHeight.set(node,
      (count > 0 ? sum / count : (balancedAtNode.get(node) ?? 0)) +
      (net.doc.node(node)?.heightOffset ?? 0));
  }

  // A node every one of whose roads is raised stays UP: the chain runs over the
  // junction instead of diving to the ground and climbing back out of it. A node
  // with even one road at grade is a landing, and everything meeting there comes
  // down to the grade height, which is what makes a ramp join a street.
  //
  // A node with ONE road is not aloft, even when that road is raised. It used
  // to be, and a raised road that simply ended stopped in mid-air at its full
  // height - thirty units over the grass on a rolling map, with nothing under
  // its end. A structure that ends comes down to the ground: its free end is a
  // landing like any other, and the ramp brings it there.
  const aloft = new Set<NodeId>();
  for (const [node, list] of incident) {
    if (!solvedNodes.has(node)) continue;
    if (list.length > 1 && list.every((profile) => isRaised(profile.structure))) aloft.add(node);
  }

  // ------------------------------------------------------ raised deck heights
  /** Free height each raised span wants, before the ramps are fitted. */
  const wanted = new Map<SegmentId, number>();
  /** The deck a raised span wants at its `a` and at its `b` end. */
  const wantedA = new Map<SegmentId, number>();
  const wantedB = new Map<SegmentId, number>();
  for (const profile of solvedProfiles) {
    const clearance = roadStructure(profile.structure).clearance;
    if (isRaised(profile.structure)) {
      // What a raised span wants at each of its ends: its clearance over the
      // ground of the plate. An aloft node takes the highest of these.
      const ends = (from: number, to: number): number => {
        let top = -Infinity;
        for (let s = from; s <= to + 1e-6; s += profile.step) {
          top = Math.max(top, profile.deck[stationIndex(profile, s)] as number);
        }
        return top;
      };
      wantedA.set(profile.id, ends(0, profile.plateA));
      wantedB.set(profile.id, ends(profile.length - profile.plateB, profile.length));
      continue;
    }
    if (!isSunken(profile.structure)) continue;
    // A tunnel is measured against the LOWEST ground it passes under, not the
    // highest. Against the highest, a bore under a hill would be driven far
    // deeper than it needs to be and its ramps would never fit; against the
    // lowest, the floor is level with what a cutting at each end can reach and
    // the hill in the middle simply provides more cover than the minimum.
    let floor = Infinity;
    for (const value of profile.ceil) if (value < floor) floor = value;
    const ends = Math.min(gradeHeight.get(profile.a) ?? 0, gradeHeight.get(profile.b) ?? 0);
    wanted.set(profile.id, Math.min(floor, ends) + clearance);
  }

  const nodeHeight = new Map<NodeId, number>();
  const upperReach = new Map<NodeId, number>();
  for (const [node] of incident) {
    if (!solvedNodes.has(node)) {
      nodeHeight.set(node, (reuse as SolveMemo).nodes.get(node)?.height as number);
      continue;
    }
    if (!aloft.has(node)) {
      nodeHeight.set(node, gradeHeight.get(node) ?? 0);
      continue;
    }
    let height = gradeHeight.get(node) ?? 0;
    for (const profile of incident.get(node) ?? []) {
      const end = profile.a === node ? wantedA.get(profile.id) : wantedB.get(profile.id);
      height = Math.max(height, end ?? height);
    }
    // No higher than a ramp from a land end can climb within the span. Split
    // an elevated road near its free end and the new node was held at full
    // deck height, while the short span beyond it had to ramp down to the
    // ground in less than a ramp's length: the ramp was cut off at the plate,
    // a cliff of 124 % (the fuzzer's `elevationStep`). The node comes down to
    // what the ramp reaches, and the deck on its other side eases down to it.
    let reachable = Infinity;
    for (const profile of incident.get(node) ?? []) {
      if (!isRaised(profile.structure)) continue;
      const other = profile.a === node ? profile.b : profile.a;
      if (aloft.has(other)) continue;
      const plateHere = profile.a === node ? profile.plateA : profile.plateB;
      const plateThere = profile.a === node ? profile.plateB : profile.plateA;
      const run = Math.max(0, profile.length - plateHere - plateThere);
      reachable = Math.min(reachable, (gradeHeight.get(other) ?? 0) + rampRise(run));
    }
    if (Number.isFinite(reachable)) upperReach.set(node, Math.max(gradeHeight.get(node) ?? 0, reachable));
    if (reachable < height) height = Math.max(gradeHeight.get(node) ?? 0, reachable);
    nodeHeight.set(node, height);
  }

  // ---------------------------------------------------------------- profiles
  // Solved until the nodes stop moving. A profile can be pushed up at its end by
  // its own envelope - a deck lifted over a rise, a ramp that had to clear a
  // mound - which raises the node it ends at, which re-solves every other road
  // meeting there, which may raise the node at ITS far end. Raising only, so
  // the sequence is monotone and settles.
  //
  // It used to be three passes over everything, whatever had happened. Along a
  // chain of raised spans over broken ground the lift travels one node per
  // pass, so after the third the solve simply stopped: a plate left standing
  // up to two units above the node the other legs had been solved against, which
  // is the step players saw where an elevated boulevard met its crossroads.
  // Now only the roads meeting a node that moved are solved again, until none
  // does; and the plates are pinned to the node at the end whatever happened,
  // so a leg and its junction agree exactly even if the cap is ever reached.
  const solve = (profile: Profile): void => {
    if (isRaised(profile.structure)) solveRaised(profile, nodeHeight, aloft, upperReach);
    else if (isSunken(profile.structure)) solveSunken(profile, nodeHeight, wanted);
    else if (profile.manualVertical) solveVariable(profile, nodeHeight);
    else solveGround(profile, nodeHeight);
  };
  let dirty: Iterable<Profile> = solvedProfiles;
  for (let pass = 0; pass < MAX_SOLVE_PASSES; pass++) {
    for (const profile of dirty) solve(profile);
    const next = new Set<Profile>();
    for (const [node, list] of incident) {
      if (!solvedNodes.has(node)) continue;
      const previous = nodeHeight.get(node) ?? 0;
      let height = previous;
      for (const profile of list) {
        const end = profile.a === node ? (profile.h[0] as number) : (profile.h[profile.h.length - 1] as number);
        if (end > height + 1e-6) {
          height = end;
        }
      }
      const cap = upperReach.get(node);
      if (cap !== undefined) height = Math.min(height, cap);
      nodeHeight.set(node, height);
      if (height > previous + 1e-6) for (const profile of list) next.add(profile);
    }
    dirty = next;
    if (next.size === 0) break;
  }
  for (const profile of dirty) solve(profile);
  for (const profile of profiles) {
    pinPlates(profile, nodeHeight.get(profile.a) ?? 0, nodeHeight.get(profile.b) ?? 0);
  }

  // --------------------------------------------------------------- the index
  const index = new SpatialIndex(profiles);
  /** Each road's whole solved profile as a digest, with its box (`differences`). */
  const profileSummaries = new Map<SegmentId, { digest: number; box: Aabb; oversized: boolean }>();
  for (const profile of profiles) {
    const d = new Digest().add(profile.id).addText(profile.structure).add(profile.manualVertical ? 1 : 0).add(profile.type)
      .add(profile.half).add(profile.median).add(profile.sidewalk).add(profile.step).addAll(profile.h).addAll(profile.line.xy);
    if (profile.sidewalkLeft !== profile.sidewalkRight || profile.look) d.add(profile.sidewalkLeft).add(profile.sidewalkRight).add(profile.look);
    profileSummaries.set(profile.id, { digest: d.value(), box: profile.bbox, oversized: index.isOversized(profile) });
  }

  /** Everything a query reads from one profile, digested once per build. */

  /** Where each station of a profile lies (`h[i]` at arc `i * step`), measured once. */
  const stationsOf = new Map<Profile, Float64Array>();
  const stations = (profile: Profile): Float64Array => {
    let xy = stationsOf.get(profile);
    if (!xy) {
      xy = new Float64Array(profile.h.length * 2);
      for (let i = 0; i < profile.h.length; i++) {
        const p = profile.line.sampleAt(Math.min(profile.length, i * profile.step)).p;
        xy[i * 2] = p.x;
        xy[i * 2 + 1] = p.y;
      }
      stationsOf.set(profile, xy);
    }
    return xy;
  };
  const near = { s: 0, distance: 0 };
  const quantum = (h: number): number => Math.round(h * 1000);
  /**
   * What a profile can give any point of a rectangle: its own figures, and
   * only the part of its line and stations a point of the rectangle can be
   * nearest to. A query takes, for a point, the nearest point of a road's
   * line (`closestInto`) - at any distance - and the height there. For the
   * rectangle's centre c, half-diagonal r and distance d from c to the line,
   * every point of the rectangle has its nearest point of the line within
   * d + 2r of c: that part, its stations and their neighbours are all a point
   * of the rectangle can read. The whole profile used to be digested, so a
   * junction made at one end of a street changed every block along it, and
   * every road tile and the ground there were built again (docs/performance.md #10).
   */
  const localDigest = (profile: Profile, minX: number, minY: number, maxX: number, maxY: number): number => {
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const r = Math.hypot(maxX - minX, maxY - minY) / 2;
    profile.line.closestInto(cx, cy, near);
    const reach = near.distance + 2 * r + profile.step;
    const reach2 = reach * reach;
    const digest = new Digest().add(profile.id).addText(profile.structure).add(profile.manualVertical ? 1 : 0)
      .add(profile.type).add(profile.half).add(profile.median).add(profile.sidewalk).add(profile.step).add(profile.h.length);
    if (profile.sidewalkLeft !== profile.sidewalkRight || profile.look) digest.add(profile.sidewalkLeft).add(profile.sidewalkRight).add(profile.look);
    const at = stations(profile);
    for (let i = 0; i < profile.h.length; i++) {
      const dx = at[i * 2]! - cx, dy = at[i * 2 + 1]! - cy;
      if (dx * dx + dy * dy > reach2) continue;
      // Heights to a thousandth of a unit (0.4 mm): a solve run again after a
      // street elsewhere moved them by rounding noise, and the noise marked
      // blocks all over the town as changed (docs/performance.md #10).
      digest.add(i).add(quantum(profile.h[i]!));
      if (i > 0) digest.add(quantum(profile.h[i - 1]!));
      if (i + 1 < profile.h.length) digest.add(quantum(profile.h[i + 1]!));
    }
    // The line itself where it passes within reach: a piece of it whose
    // nearest point to c is within reach, with its two ends.
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

  const hit = { s: 0, distance: 0 };
  const sampleProfile = (profile: Profile, x: number, y: number): number => {
    profile.line.closestInto(x, y, hit);
    return heightAtArc(profile, hit.s);
  };

  const distances: number[] = [];
  const arcs: number[] = [];
  const picked: Profile[] = [];

  /**
   * The last point asked about, and what was found there: the nearest road,
   * the arc length and distance to it, and the blended height.
   *
   * A mesh vertex asks the same point up to five times in a row - the height
   * of the band's top and of its skirt, the texture frame, the class tint - and
   * every one of those used to repeat the whole nearest-road search. The
   * answers are the same numbers, so the last point is remembered. The
   * elevation is immutable once built, so the memo can never be stale.
   */
  const last = {
    x: NaN,
    y: NaN,
    structures: undefined as ReadonlySet<RoadStructure> | undefined,
    includeManual: true,
    road: null as Profile | null,
    s: 0,
    distance: Infinity,
    /** NaN until the height itself has been asked for at this point. */
    height: NaN,
  };
  const remembers = (x: number, y: number, structures: ReadonlySet<RoadStructure> | undefined,
    includeManual: boolean): boolean =>
    last.x === x && last.y === y && last.structures === structures && last.includeManual === includeManual;
  const remember = (x: number, y: number, structures: ReadonlySet<RoadStructure> | undefined,
    includeManual: boolean, road: Profile | null, s: number, distance: number, height: number): void => {
    last.x = x;
    last.y = y;
    last.structures = structures;
    last.includeManual = includeManual;
    last.road = road;
    last.s = s;
    last.distance = distance;
    last.height = height;
  };

  /** The road nearest a point, out of the structural levels asked for; its arc and distance in `last`. */
  const nearest = (
    x: number,
    y: number,
    structures?: ReadonlySet<RoadStructure>,
    includeManual = true,
  ): Profile | null => {
    if (remembers(x, y, structures, includeManual)) return last.road;
    let best: Profile | null = null;
    let bestDistance = Infinity;
    let bestS = 0;
    for (const profile of index.near(x, y)) {
      if (structures && !structures.has(profile.structure)) continue;
      if (!includeManual && profile.manualVertical) continue;
      profile.line.closestInto(x, y, hit);
      if (hit.distance < bestDistance) {
        bestDistance = hit.distance;
        best = profile;
        bestS = hit.s;
      }
    }
    remember(x, y, structures, includeManual, best, bestS, bestDistance, NaN);
    return best;
  };

  const query = (x: number, y: number, structures?: ReadonlySet<RoadStructure>, includeManual = true): number => {
    if (remembers(x, y, structures, includeManual) && !Number.isNaN(last.height)) return last.height;
    const candidates = index.near(x, y);
    let best = Infinity;
    let road: Profile | null = null;
    let roadS = 0;
    let found = 0;
    for (const profile of candidates) {
      if (structures && !structures.has(profile.structure)) continue;
      if (!includeManual && profile.manualVertical) continue;
      profile.line.closestInto(x, y, hit);
      distances[found] = hit.distance;
      arcs[found] = hit.s;
      picked[found] = profile;
      found++;
      if (hit.distance < best) {
        best = hit.distance;
        road = profile;
        roadS = hit.s;
      }
    }
    const height = blend(x, y, best, found);
    remember(x, y, structures, includeManual, road, roadS, best, height);
    return height;
  };

  /** The height at a point from the `found` candidates just measured. */
  const blend = (x: number, y: number, best: number, found: number): number => {
    const ground = terrainAt(x, y) + ROAD_GROUND_CLEARANCE;
    if (found === 0) return ground;
    // How much the roads have to say here at all: everything within
    // `PROFILE_REACH`, nothing past `PROFILE_FADE`, eased in between.
    const authority = 1 - smoothstep(PROFILE_REACH, PROFILE_FADE, best);
    if (authority <= 0) return ground;
    let sum = 0;
    let weight = 0;
    for (let i = 0; i < found; i++) {
      const w = Math.exp(-((distances[i] as number) - best) / BLEND_TAU);
      if (w < 1e-4) continue;
      sum += w * heightAtArc(picked[i] as Profile, arcs[i] as number);
      weight += w;
    }
    if (weight <= 0) return ground;
    const road = sum / weight;
    return authority >= 1 ? road : road * authority + ground * (1 - authority);
  };

  const result: RoadElevation = {
    at: query,
    differences(other) {
      const mine = profileSummaries;
      const theirs = other.summaries?.();
      if (!theirs) return null;
      const out: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
      const take = (s: { box: Aabb; oversized: boolean }): boolean => {
        if (s.oversized) return false;
        const box = s.box;
        out.push({ minX: box.minX - INDEX_CELL, minY: box.minY - INDEX_CELL, maxX: box.maxX + INDEX_CELL, maxY: box.maxY + INDEX_CELL });
        return true;
      };
      for (const [id, s] of mine) {
        const t = theirs.get(id);
        if (t && t.digest === s.digest) continue;
        if (!take(s) || (t && !take(t))) return null;
      }
      for (const [id, t] of theirs) if (!mine.has(id) && !take(t)) return null;
      return out;
    },
    summaries: () => profileSummaries,
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
    onSegment(segment, x, y) {
      const profile = byId.get(segment);
      if (!profile) return terrainAt(x, y) + ROAD_GROUND_CLEARANCE;
      return sampleProfile(profile, x, y);
    },
    nodeHeight(node) {
      return nodeHeight.get(node) ?? terrainAt(net.doc.node(node)?.x ?? 0, net.doc.node(node)?.y ?? 0) + ROAD_GROUND_CLEARANCE;
    },
    roadAt(x, y, structures, includeManual = true) {
      const best = nearest(x, y, structures, includeManual);
      if (!best) return { along: y, across: x, type: -1, half: 0, median: 0 };
      const { s, distance } = last;
      // Signed offset, so the two halves of a carriageway do not mirror the
      // texture into a seam down the centre line.
      const frame = best.line.sampleAt(s);
      const sign = Math.sign((x - frame.p.x) * frame.n.x + (y - frame.p.y) * frame.n.y) || 1;
      return {
        along: s,
        across: distance * sign,
        type: best.type,
        half: best.half,
        median: best.median,
        sidewalk: best.sidewalk,
        ...(best.sidewalkLeft !== best.sidewalkRight ? { sidewalkLeft: best.sidewalkLeft, sidewalkRight: best.sidewalkRight } : {}),
        segment: best.id,
      };
    },
    surfaceFrameAt(x, y, structures, pickX, pickY, includeManual = true, segment, panel) {
      const best = segment === undefined
        ? nearest(pickX, pickY, structures, includeManual)
        : byId.get(segment);
      if (!best) return { along: y, across: x };
      let s = segment === undefined ? last.s : 0;
      if (segment !== undefined) {
        best.line.closestInto(pickX, pickY, hit);
        s = hit.s;
      }
      if (pickX !== x || pickY !== y) {
        best.line.closestInto(x, y, hit);
        s = hit.s;
      }
      const frame = best.line.sampleAt(s);
      const dx = x - frame.p.x;
      const dy = y - frame.p.y;
      const across = dx * frame.n.x + dy * frame.n.y;
      let along = s + dx * frame.t.x + dy * frame.t.y;
      if (panel !== undefined && panel > 0) {
        // A line `across` to the left of a curve is shorter than the
        // centreline by `across` times the turn: d(along) = (1 - across k) ds.
        // Integrated from the panel's start, the turn since then times the
        // offset comes off (a centreline U stretches the inside of a bend and
        // squeezes the outside; GameDev.net, "spline based road geometry UV
        // mapping"). Within a panel only, so the shear it brings never builds up.
        const start = Math.floor(Math.max(0, Math.min(best.length, s)) / panel) * panel;
        const t0 = best.line.sampleAt(start).t;
        const turn = Math.atan2(t0.x * frame.t.y - t0.y * frame.t.x, t0.x * frame.t.x + t0.y * frame.t.y);
        along -= across * turn;
      }
      return { along, across };
    },
    shapeBounds: () => profiles.map((profile) => profile.bbox),
    shapeAt(x, y, naturalGround) {
      // EVERY structure may shape the ground, and which one does is decided by
      // authority rather than by distance.
      //
      // "Only roads at grade" was nearly right and wrong in one case that
      // matters: a ramp coming down off a viaduct is a road at grade by the time
      // it reaches the street, and leaving the ground untouched under it meant
      // the ramp had a hill in its way — so the solver lifted the junction to
      // clear the hill and the street meeting it was left with a step. What
      // actually decides whether the ground is shaped is how far the structure
      // is ABOVE it: on it, cut and fill; well clear of it, piers and nothing.
      //
      // Taking the nearest profile and then asking whether it shapes would lose
      // the answer whenever a flying deck happened to pass closer than the road
      // that is really on the ground, so every candidate is scored and the one
      // with the most to say wins.
      let bestWeight = 0;
      let bestHeight = 0;
      for (const profile of index.near(x, y)) {
        profile.line.closestInto(x, y, hit);
        const distance = hit.distance;
        const inner = profile.half + SHAPE_INNER;
        // Cheap bound first: rejecting on the widest batter any road could ask
        // for keeps a dense network from paying for every road in its cell.
        if (distance >= inner + SHAPE_SHOULDER_MAX) continue;
        const sunken = isSunken(profile.structure) ||
          (profile.manualVertical && naturalGround - heightAtArc(profile, hit.s) > 0);
        const surface = heightAtArc(profile, hit.s);
        // Under the road (carriageway and footway) the ground is pulled well
        // below the deck, where nothing can show through it. Beyond the
        // footway's back edge it is brought up to just under the carriageway's
        // level: the verge then carries a gentle 25 cm fall from the footway,
        // not a 60 cm wall, and the road no longer reads as a slab on the
        // grass. Not to the footway's level: the terrain is a 6.4 m grid, and
        // a corner vertex at footway height lifts the interpolated ground
        // through the asphalt of the kerb return beside it.
        const beside = !sunken && distance > profile.half - CASING_BAND;
        const height = beside ? surface - BESIDE_DROP : surface - SHAPE_DROP;
        // The batter is sized from the earthwork it has to carry away, so a
        // shallow fill blends out quickly and a deep cut opens out properly.
        // A cutting held by retaining walls is dug no wider than a portal's:
        // the wall at the road's edge stands in front of the step
        // (`render/structures.ts` `retainingWalls`).
        const shoulder = sunken || (profile.walls && naturalGround > height)
          ? CUT_SHOULDER
          : Math.min(SHAPE_SHOULDER_MAX, Math.max(SHAPE_SHOULDER, Math.abs(naturalGround - height) * BATTER));
        if (distance >= inner + shoulder) continue;
        let weight = 1 - smoothstep(inner, inner + shoulder, distance);
        if (isRaised(profile.structure) ||
          (profile.manualVertical && surface > naturalGround)) {
          // Lifted clear of the ground: the structure stands on piers and the
          // landscape passes under it untouched.
          weight *= 1 - smoothstep(LIFT_ON, LIFT_OFF, surface - naturalGround);
        } else if (sunken) {
          // A road buried under its own hill is a TUNNEL, and a tunnel does not
          // cut the hill open — it bores through it. Fading the shaping out as
          // the road goes deeper is what produces an open cutting at each portal
          // and solid ground over the bore, from one rule and no special case.
          // The cover is measured to the road's SURFACE, because that is the
          // number the portal geometry is placed against.
          //
          // NOT for a road at grade, which is now allowed to run in a cutting
          // several units deep: the same test would decide the hill had closed
          // over it and quietly bury an open road.
          weight *= 1 - smoothstep(TUNNEL_ROOF, TUNNEL_BORE, naturalGround - surface);
        }
        if (weight > bestWeight) {
          bestWeight = weight;
          bestHeight = height;
        }
      }
      return bestWeight <= 0 ? NO_SHAPE : { height: bestHeight, weight: bestWeight };
    },
    has(structures) {
      if (!structures) return profiles.length > 0;
      // The structures the roads are built as, gathered once (the profiles
      // never change after this build): asked at every point a lot's colour
      // is laid on (`surfaceHeightAt`), a scan of every profile for a
      // structure the town has none of was 0.4 s of an opening (2026-10-14).
      present ??= new Set(profiles.map((profile) => profile.structure));
      for (const structure of structures) if (present.has(structure)) return true;
      return false;
    },
  };
  const settled = new Map<NodeId, { key: string; height: number }>();
  for (const [node, key] of nodeKeys) settled.set(node, { key, height: nodeHeight.get(node) ?? 0 });
  memos.set(result, { terrainAt, stations: stationsById, profiles: byId, nodes: settled });
  if (terrainAt === FLAT_GROUND) lastFlat = result;
  if (typeof performance.measure === 'function') {
    performance.measure(reuse ? 'hitch:elevation/incremental' : 'hitch:elevation/full', { start: started, end: performance.now() });
  }
  return result;
}

// ------------------------------------------------------------ incremental

/** What a road's stations read from the ground: its ceiling and its designed grade line. Never written after. */
interface Stations {
  readonly line: Polyline;
  readonly half: number;
  readonly ceil: number[];
  readonly base: number[];
}

/**
 * What a solve keeps for the next one on the same ground (`previous`).
 *
 * The solve splits exactly along the network's connected pieces: a profile
 * reads only its own stations and the heights of its two nodes, a node only
 * the profiles meeting there, and the rounds raise each piece until IT stops
 * moving (Jacobi rounds, so the order is irrelevant). A piece whose every
 * road has the same line, width, plates, ends, class and structure, and
 * whose every node stands where it stood at the same authored height with
 * the same roads, settles where it settled: its heights are taken whole.
 * Any other piece is solved from scratch as before. That is a verifying
 * trace with early cutoff (Mokhov, Mitchell and Peyton Jones, "Build
 * systems à la carte"), and `tests/world/incrementalRebuild.spec.ts` holds
 * it equal to a solve from nothing.
 */
interface SolveMemo {
  readonly terrainAt: (x: number, y: number) => number;
  readonly stations: ReadonlyMap<SegmentId, Stations>;
  readonly profiles: ReadonlyMap<SegmentId, Profile>;
  /** Each node's inputs as text, and the height it settled at. */
  readonly nodes: ReadonlyMap<NodeId, { readonly key: string; readonly height: number }>;
}

const memos = new WeakMap<RoadElevation, SolveMemo>();

/**
 * Level ground everywhere: the editing rules solve on it, where two roads at
 * one point stand on the same ground and it cancels (`editor/editRules.ts`).
 * It never changes, so every solve on it starts from the last one.
 */
export const FLAT_GROUND = (): number => 0;
let lastFlat: RoadElevation | null = null;

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
    // The MEAN, not the maximum. Taking the maximum across the casing is
    // right for a deck that has to fly over the ground and wrong for a road
    // built into it: on any side slope it perches the carriageway on the high
    // kerb and leaves the low one hanging, which reads as a road tilted for
    // no reason. The mean is the level at which the cut on one side pays for
    // the fill on the other.
    mid.push(sum / LATERAL.length + ROAD_GROUND_CLEARANCE);
  }
  // A chord between two stations must clear the ground at BOTH of its ends or
  // it dives under the terrain in between. Raising every station to the
  // highest within its neighbourhood is what makes the clearance a guarantee.
  dilate(ceil, DILATE);
  // The designed grade line, solved once and independently of any junction:
  // smooth the balanced ground, then limit its gradient in both directions.
  const base = mid.slice();
  smoothProfile(base, step, SMOOTH_REACH);
  slopeLimit(base, step, GROUND_GRADE);
  return { ceil, base };
}

// ---------------------------------------------------------------- solvers

/** A continuous authored vertical alignment, including ground, bridge and bore. */
function solveVariable(profile: Profile, nodeHeight: Map<NodeId, number>): void {
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
  // The ramp's grade unless the heights set at its two ends ask for more (as
  // `solveGround`): held to it, the limiter left the difference as a cliff
  // against the pinned plate - a road set 17 units up at one end and at
  // grade 100 units on dropped 2.5 units a unit in its last few (fuzz seed 3).
  // The least grade that joins the plates, and a tenth more, makes one ramp;
  // pinned and limited by turns, so no step is left against either plate.
  const grade = Math.max(RAMP_GRADE, (Math.abs(hB - hA) / run) * 1.1);
  for (let round = 0; round < 3; round++) {
    slopeLimit(h, step, grade);
    pinPlates(profile, hA, hB);
  }
  roundGradeBreaks(profile, 'both');
  pinPlates(profile, hA, hB);
}

/**
 * A road at grade: it follows the ground, flat over its junction plates.
 *
 * The plate is what keeps the junction watertight. Every leg of a node is held
 * at exactly the node's height over its plate reach, so the junction polygon —
 * which lies inside that reach — is a plane whatever leg the query lands on.
 */
function solveGround(profile: Profile, nodeHeight: Map<NodeId, number>): void {
  const { h, base, step, length } = profile;
  const hA = nodeHeight.get(profile.a) ?? 0;
  const hB = nodeHeight.get(profile.b) ?? 0;
  // Anchored at the PLATE EDGE, not at the segment's end.
  //
  // The plate is held flat at the node height and the designed line is not, so
  // the offset has to make them agree exactly where they meet. Anchoring it at
  // station zero instead left the first free station a plate-length of gradient
  // away from the plate it adjoins — a step of nearly two units on a crossroads
  // over a hill, which the gradient test caught at 0.92 per unit.
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
  //
  // A fixed length adds `1.5 * shift / TIE_REACH` to the profile's own gradient
  // at the steepest point of the ease, so a big correction over a short tie
  // breaks the gradient limit — and the limiter then flattens the approach and
  // leaves the difference as a step against the plate, which is precisely the
  // defect this was meant to remove. Spending half the budget on the tie keeps
  // the sum inside the limit whatever the correction turns out to be.
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
    // The designed line, translated towards each junction over a transition
    // rather than snapped to it at the plate edge. Applying the correction as a
    // fading OFFSET keeps the shape of the alignment — the crest and the dip the
    // smoothing kept — instead of replacing it with a straight run to the node.
    const wA = 1 - smoothstep(profile.plateA, profile.plateA + tieA, s);
    const wB = 1 - smoothstep(profile.plateB, profile.plateB + tieB, length - s);
    h[i] = (base[i] as number) + shiftA * wA + shiftB * wB;
  }
  // Both directions: a designed line is allowed to descend, so an envelope that
  // only raises would quietly fill in every cut it was asked to make.
  //
  // Alternated with the plate pins, because the two constraints argue: the
  // limiter treats the plate as ordinary samples and will flatten it, and the
  // pin puts it back. Three rounds settle it, and they only have anything to
  // argue about when the junction and its legs disagree — which, with the node
  // height now read at the plate edge, they barely do.
  //
  // The limit is the class's grade unless the two pinned plates ask for more:
  // heights the player set at both ends of a short road may need a steeper
  // ramp than the class allows. Held to the class's grade then, the limiter
  // flattened the road from one end, the pin put the plate back, and the
  // whole difference was left as a cliff against it (108 % and 250 % in the
  // fuzzer, seeds 1 and 3). The least grade that joins the two plates, with a
  // tenth more for the vertical curves rounded in below, makes it one
  // continuous ramp instead - as steep as real short streets are (Grade
  // (slope): 23-37 % on short urban stretches), never a step.
  const free = Math.max(step, length - profile.plateA - profile.plateB);
  const grade = Math.max(GROUND_GRADE, (Math.abs(hB - hA) / free) * 1.1);
  for (let round = 0; round < 3; round++) {
    pinPlates(profile, hA, hB);
    slopeLimit(h, step, grade);
  }
  pinPlates(profile, hA, hB);
  roundGradeBreaks(profile, 'both');
  // The height tie above has zero derivative at its end, so the designed
  // line's own slope survives against the flat plate. A short derivative
  // correction rounds that join; d*exp(-d/reach) starts with unit slope and
  // fades without moving either node's pinned height.
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

/**
 * The join of a level plate and the grade beyond it, rounded into a vertical
 * curve. `roundGradeBreaks` narrows its window to nothing at a plate edge so
 * as not to move the plate, which leaves the join itself a corner - level,
 * then the full grade from one station to the next (0.062 of grade change
 * inside 3 m on the inspection map). Here the window reaches into the plate,
 * which is level, over one curve's reach beyond its edge only; the plate is
 * never written.
 */
function roundPlateJoins(profile: Profile): void {
  const { h, step, length } = profile;
  const radius = Math.max(1, Math.round(VERTICAL_CURVE_REACH / Math.max(1e-3, step)));
  const source = h.slice();
  const last = source.length - 1;
  const edgeA = profile.plateA / step;
  const edgeB = (length - profile.plateB) / step;
  // Only where the slope limiter took hold right at the edge: there the grade
  // turns from level to near its limit in one station.
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

/**
 * Vertical curves wherever a road's grade changes.
 *
 * The slope limiter and the grade envelopes leave a CORNER where they take
 * hold - level, then 12 %, from one station to the next - and a car on it
 * pitched from one to the other between its axles. A moving average turns each
 * corner into a parabola as long as its window, which is exactly a vertical
 * curve, and cannot steepen anything (a mean of gradients is no steeper than
 * the steepest). The window narrows to nothing at each plate edge, so the
 * plate and its leg still meet at the same height (invariant 3).
 *
 * `raise` keeps only what the rounding lifts: a deck must not sink towards
 * what it clears, so its sags are rounded and its crests left to `smoothMin`.
 */
function roundGradeBreaks(profile: Profile, mode: 'both' | 'raise', intoPlates = false): void {
  const { h, step, length } = profile;
  const radius = Math.max(1, Math.round(VERTICAL_CURVE_REACH / Math.max(1e-3, step)));
  const source = h.slice();
  const last = source.length - 1;
  const edgeA = profile.plateA / step;
  const edgeB = (length - profile.plateB) / step;
  for (let i = 0; i <= last; i++) {
    if (i <= edgeA || i >= edgeB) continue;
    // On a road at grade the window reaches INTO a plate: the plate is level,
    // so averaging over it rounds the join of plate and grade into a vertical
    // curve instead of leaving a corner there (level, then 11 %, between two
    // stations), and the plate itself, which is never written, stays pinned.
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

/**
 * A raised structure: a level deck between two short ramps.
 *
 * ```
 *          deck: a straight line between its two ends
 *        .--------------------------------.      crest: RAMP_CREST
 *       / RAMP_GRADE                        \
 *  ----'  sag: RAMP_CURVE                    '----
 *  plate  |<-- at most ~100 -->|             plate
 * ```
 *
 * The deck is a STRAIGHT line from one end to the other: at a landing it
 * starts one clearance over the junction it lands on, at an aloft end it is
 * the node's height. It does not follow the land up and down - a deck that did
 * read from above as a road sloping from end to end, with no telling where the
 * ramp stopped. Only ground that rises into it lifts it, and then gently.
 *
 * Each landing contributes a ramp that is level at the plate edge, bends up
 * over `RAMP_CURVE` and climbs at `RAMP_GRADE` until it meets the deck, over a
 * rounded crest. Where the span is too short for two ramps they meet over a
 * crest of their own below the deck: the deck is lowered, never steepened.
 */
function solveRaised(
  profile: Profile,
  nodeHeight: Map<NodeId, number>,
  aloft: ReadonlySet<NodeId>,
  upperReach: ReadonlyMap<NodeId, number>,
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
  // Nothing under the deck may come closer than this to its surface: the
  // structure's own depth and a margin of daylight under the soffit.
  const underside = spec.deck + FOOTWAY_RISE + m(0.4);
  for (let i = 0; i < h.length; i++) {
    const t = Math.min(1, Math.max(0, (step * i - profile.plateA) / run));
    const line = startH + (endH - startH) * t;
    h[i] = Math.max(line, (ceil[i] as number) + underside);
  }
  // A rise that pushed into the deck lifts it, and the lift is eased out along
  // the deck rather than left as a bump.
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
    //
    // `ceil` is the natural ground, and a ramp must clear it — except where it
    // lands, because the junction it lands on is a flat platform cut into that
    // ground. Holding the full floor right up to the plate made a ramp landing
    // on a mound insist on staying above the mound, which dragged the junction
    // up with it and left the street meeting it with eight units to climb in
    // one cell. Near a plate the floor is the node's own level instead.
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
  // A raised junction next to a short landing can be lower than the span's
  // free deck. The raise-only envelopes above cannot pull that deck DOWN, and
  // pinning the low node afterward made the last station a near-vertical drop.
  // Shape the approach from that fixed node before the plate is pinned.
  if (nearLanding) {
    for (let i = 0; i < h.length; i++) {
      const s = step * i;
      if (upperReach.has(profile.a)) h[i] = Math.min(h[i] as number, hA + rampRise(s - profile.plateA));
      if (upperReach.has(profile.b)) h[i] = Math.min(h[i] as number, hB + rampRise(edgeB - s));
    }
  }
  flattenPlates(profile, hA, hB);
}


/**
 * Height a ramp has gained `d` units past the plate edge: level at the edge, a
 * parabolic sag over `RAMP_CURVE`, then `RAMP_GRADE` for ever. The deck it
 * climbs to is what stops it (`smoothMin` in `solveRaised`).
 */
function rampRise(d: number): number {
  if (d <= 0) return 0;
  if (d < RAMP_CURVE) return (RAMP_GRADE * d * d) / (2 * RAMP_CURVE);
  return RAMP_GRADE * (d - RAMP_CURVE / 2);
}

/** Plate edge to deck, for a ramp that climbs `rise`: sag, straight and crest. */
function rampLength(rise: number): number {
  return rise <= 0 ? 0 : rise / RAMP_GRADE + RAMP_CURVE;
}

/**
 * The smaller of two heights with the corner between them rounded over a band
 * `k` high (a quadratic smooth minimum). Never above either input, continuous
 * and with a continuous slope, which is what turns the top of a ramp into a
 * crest curve instead of a kink.
 */
function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * A tunnel: a flat floor below the ground, with a ramp up to each end.
 *
 * The exact mirror of `solveRaised`, and deliberately so — the two shapes are
 * the same shape with the sign of the clearance flipped, and writing them as one
 * function with a sign would have made both harder to read than either is on its
 * own. Two differences matter and both are inherent:
 *
 *  - The ground envelope is NOT applied. `ceil` is the floor a road at grade
 *    must stay above, and a tunnel is defined by going under it.
 *  - The gradient envelope runs the other way. `gradeEnvelope` only ever raises,
 *    which is right for keeping a road clear of the ground and wrong here: a
 *    step that is too steep on a descent has to be fixed by LOWERING the higher
 *    sample, or the fix undoes the tunnel.
 *
 * Where the span is too short to hold both ramps at the design gradient the
 * floor is raised until they fit — the same concession `solveRaised` makes — so
 * a short segment becomes an open cutting rather than a cliff. That is honest:
 * the terrain only closes over the road where there is real cover, so a trench
 * that never got deep enough is drawn as the trench it is.
 */
function solveSunken(
  profile: Profile,
  nodeHeight: Map<NodeId, number>,
  wanted: Map<SegmentId, number>,
): void {
  const { h, step, length } = profile;
  const hA = nodeHeight.get(profile.a) ?? 0;
  const hB = nodeHeight.get(profile.b) ?? 0;
  const run = Math.max(1e-3, length - profile.plateA - profile.plateB);
  const target = Math.min(wanted.get(profile.id) ?? 0, hA, hB);

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
    // The HIGHER of the two ends wins, for the reason the raised solver takes
    // the lower: at the end that climbs out, the other ramp is already at full
    // depth, and taking the deeper one cancelled the climb.
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

/**
 * Raises samples until no step between them exceeds the gradient.
 *
 * Raise-only, so a profile that already cleared the ground still clears it.
 * Both directions, repeated, because raising a sample can make its other
 * neighbour too steep. Plates are raised as a block so they stay flat.
 */
function gradeEnvelope(h: number[], step: number, grade: number): void {
  const limit = grade * step;
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < h.length; i++) h[i] = Math.max(h[i] as number, (h[i - 1] as number) - limit);
    for (let i = h.length - 2; i >= 0; i--) h[i] = Math.max(h[i] as number, (h[i + 1] as number) - limit);
  }
}

/**
 * Lowers samples until no step between them exceeds the gradient.
 *
 * The mirror of `gradeEnvelope`: lower-only, so a tunnel that already has its
 * cover keeps it.
 */
function descentEnvelope(h: number[], step: number, grade: number): void {
  const limit = grade * step;
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < h.length; i++) h[i] = Math.min(h[i] as number, (h[i - 1] as number) + limit);
    for (let i = h.length - 2; i >= 0; i--) h[i] = Math.min(h[i] as number, (h[i + 1] as number) + limit);
  }
}

/**
 * A moving average over a fixed length of road, in place.
 *
 * Symmetric and clamped at the ends, so the profile does not sag towards zero
 * where the window runs off the segment. This is the whole of what makes a road
 * "designed" rather than "draped": everything shorter than the window is earth
 * to be moved, everything longer than it is landscape to be followed.
 */
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

/**
 * Limits the gradient between neighbouring stations, in BOTH directions.
 *
 * `gradeEnvelope` only ever raises, which is right for a profile that must stay
 * above the ground and wrong for one that is allowed to cut into it: raising to
 * fix a descent would undo the cut. Clamping each sample against both of its
 * neighbours, alternating direction, settles on a profile within the gradient
 * that stays as close to the input as the limit allows.
 */
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

/** 0 below `a`, 1 above `b`, smooth in between. */
function smoothstep(a: number, b: number, value: number): number {
  const u = Math.min(1, Math.max(0, (value - a) / Math.max(1e-6, b - a)));
  return u * u * (3 - 2 * u);
}

const ease = (t: number): number => {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
};

function stationIndex(profile: Profile, s: number): number {
  const at = Math.round(s / profile.step);
  return at < 0 ? 0 : at >= profile.h.length ? profile.h.length - 1 : at;
}

/** Linear read of a profile at an arc position — continuous, never stepped. */
function heightAtArc(profile: Profile, s: number): number {
  const { h, step } = profile;
  const at = Math.min(h.length - 1, Math.max(0, s / step));
  const low = Math.floor(at);
  const high = Math.min(h.length - 1, low + 1);
  const a = h[low] as number;
  const b = h[high] as number;
  return a + (b - a) * (at - low);
}

// ------------------------------------------------------------ spatial index

/**
 * A uniform grid over the segments' influence boxes.
 *
 * The query runs once per mesh vertex — hundreds of thousands of times on a
 * large map — and a linear scan over every segment made the rebuild quadratic in
 * the size of the network. The grid makes it proportional to the number of roads
 * that actually reach the point, which is a handful.
 */
/** Side of the spatial index's cells, world units. */
const INDEX_CELL = m(25.6);
class SpatialIndex {
  private readonly cell = INDEX_CELL;
  private readonly buckets = new Map<number, Profile[]>();
  private readonly oversized: Profile[] = [];
  isOversized(profile: Profile): boolean {
    return this.oversized.includes(profile);
  }
  private readonly all: readonly Profile[];

  constructor(profiles: readonly Profile[]) {
    this.all = profiles;
    for (const profile of profiles) {
      const box = profile.bbox;
      const x0 = Math.floor(box.minX / this.cell);
      const x1 = Math.floor(box.maxX / this.cell);
      const y0 = Math.floor(box.minY / this.cell);
      const y1 = Math.floor(box.maxY / this.cell);
      // A pathological box (a road across the whole map) would fill the grid;
      // those stay in the fallback list instead of being spread over it.
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
        this.oversized.push(profile);
        continue;
      }
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = x * 73_856_093 + y * 19_349_663;
          const bucket = this.buckets.get(key);
          if (bucket) bucket.push(profile);
          else this.buckets.set(key, [profile]);
        }
      }
    }
  }

  /** Digest of every profile `near` can return for a point of the rectangle, in its order; a profile `of` gives null for is left out. */
  digest(minX: number, minY: number, maxX: number, maxY: number, of: (profile: Profile) => number | null): number {
    // The same reading with or without buckets: a network with no bucketed
    // road (empty, or every road oversized) read differently, so its first
    // bucketed road changed every block of the map (docs/performance.md #10).
    const digest = new Digest();
    for (let x = Math.floor(minX / this.cell); x <= Math.floor(maxX / this.cell); x++) {
      for (let y = Math.floor(minY / this.cell); y <= Math.floor(maxY / this.cell); y++) {
        const key = x * 73_856_093 + y * 19_349_663;
        digest.add(key);
        for (const profile of this.buckets.get(key) ?? EMPTY) {
          const value = of(profile);
          if (value !== null) digest.add(value);
        }
      }
    }
    digest.add(-1);
    for (const profile of this.oversized) {
      const value = of(profile);
      if (value !== null) digest.add(value);
    }
    return digest.value();
  }

  near(x: number, y: number): readonly Profile[] {
    if (this.buckets.size === 0) return this.all;
    const key = Math.floor(x / this.cell) * 73_856_093 + Math.floor(y / this.cell) * 19_349_663;
    const bucket = this.buckets.get(key);
    if (this.oversized.length === 0) return bucket ?? EMPTY;
    return bucket ? [...bucket, ...this.oversized] : this.oversized;
  }
}

const EMPTY: readonly Profile[] = [];
