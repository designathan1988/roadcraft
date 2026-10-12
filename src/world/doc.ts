import { type MarkingStyleId, isMarkingStyle } from './roads/markingStyle';
import { onChartOf } from './planet/charts';
import { type ApproachRuleEntry, type SignalSettings, normalizeApproachRules, normalizeSignalSettings, rulesDigest, signalDigest } from './roads/rules';
import { type LaneLink, linksDigest, normalizeLaneLinks } from './roads/connectors';
import { cloneRoadSection, normalizeRoadSection, sameRoadSection, type RoadSection } from './roadSection';
import { isLot, type Lot } from './lots';
import type { Vec2 } from '@core/vec2';
import { type CurveShape, fitShapeToRadius } from '@core/bezier';
import {
  type NodeId,
  type PoleId,
  type SegmentId,
  type SpanId,
  IdAllocator,
  asNodeId,
  asPoleId,
  asSegmentId,
  asSpanId,
} from './ids';
import type { UtilityPole, UtilitySpan } from './utilities';
import { type Barrier, type BarrierKind, isBarrierKind } from './barriers';
// Runtime imports, and safe: `geometry` and `legAngles` take `RoadDoc` as a
// TYPE only, so nothing here is part of a runtime cycle.
import { TUNNEL_HEADROOM, type RoadStructure, migrateStructure } from './structures';
import { MAX_TERRAIN_STAMPS, RELIEF_LEGACY, isReliefVersion, type ReliefVersion, type TerrainStamp } from './terrain';
import { clampToMap } from './bounds';
import { normalizeParking, sameParking, type SegmentParking } from './parking';
import { type LandscapeItem, type LandscapeKind, type SignType, SIGN_TEXT_MAX, isLandscapeKind, isSignType } from './landscape';
import { MAX_PAINT_DABS, type PaintDab, isPaintKind } from './terrainPaint';
import { MAX_PLACED_CLOUDS, readCloud, type PlacedCloud } from './clouds';
import { DEFAULT_WEATHER, readWeather, type Weather } from './weather';
import { DEFAULT_ECONOMY, readEconomy, type Economy } from './economy';
import { MAX_PLANTED_TREES, MAX_TREE_CLEARINGS, readPlantedTree, readTreeClearing, type PlantedTree, type TreeClearing } from './trees';
import { MAX_ELEMENTS, readElement, type ElementItem, type ElementKind } from './elements';
import { DEFAULT_GULLY_AUTO, MAX_GULLY_DABS, readGullyDab, type GullyDab } from './gullies';
import { DEFAULT_FOG, MAX_FOG_DABS, readFogDab, readFogSettings, type FogDab, type FogSettings } from './fogPaint';
import { isNatureSettings, type NatureSettings } from './ecology';
import { type TransitData, emptyTransit, hasTransit, normalizeTransit } from './transit';
import { casingHalf, roadProfile } from './roadTypes';
import { BuildingStore } from './buildings/store';
import type { SerializedBuilding } from './buildings/serialize';
import { isZoneDensity, isZoneMark, isZoneUse, type Zone, type ZoneMark } from './zones';
import { normalizePerson, type PersonSpec } from '@people/spec';
import { ChangeJournal, rectAround, type ChangeRect, type DocChangeKind } from './changes';
import { rescaleSerializedDoc } from './rescale';
import { FACE_HALF } from '@core/cubeSphere';
import { METERS_PER_UNIT } from './units';

/** `shape` flattened until no band of a road of this profile folds over (see `RoadDoc.fitCurve`). */
export function fitRoadCurve(
  a: Vec2, b: Vec2, shape: CurveShape | null, type: number,
  lanes: number | null = null, direction: SegmentDirection = 'both', section?: RoadSection,
  parking?: SegmentParking,
): CurveShape | null {
  return fitShapeToRadius(a, b, shape, casingHalf(roadProfile(type, lanes, direction, section, parking)));
}

/** Legal driving directions, relative to the stored `a -> b` orientation. */
export type SegmentDirection = 'both' | 'aToB' | 'bToA';

/** Explicit junction policy. `auto` retains the class-based default policy. */
/** 'mini': a mini-roundabout (docs/VIAS.md V5): every entry gives way to whoever is in it or comes from the left. */
export type JunctionControl = 'auto' | 'signal' | 'stop' | 'yield' | 'priority' | 'none' | 'mini';

/** Stable segment-pair key for a movement through a junction. */
export const movementKey = (from: SegmentId, to: SegmentId): string => `${from}>${to}`;

/** Whether a movement key names segment `id` as its entry or its exit. */
export function movementMentions(key: string, id: SegmentId): boolean {
  const cut = key.indexOf('>');
  const text = String(id);
  return key.slice(0, cut) === text || key.slice(cut + 1) === text;
}

export interface RoadNode {
  readonly id: NodeId;
  x: number;
  y: number;
  /** Authored height above or below the designed ground, in world units. */
  heightOffset: number;
  /** An internal control point of one continuous road gesture. */
  smooth: boolean;
  /**
   * Materialized incidence list.
   *
   * The V6 monolith recomputed this with a linear `filter` over every segment,
   * from inside `nodeDegree`, `intersectionRadius`, `junctionReach`,
   * `crosswalkDistance` and `approachSetback` — roughly six full scans per
   * vehicle per frame (defect 5.7). Here it is maintained on mutation.
   */
  readonly incident: SegmentId[];
  control: JunctionControl;
  blockedMovements: string[];
  /**
   * A pedestrian crossing placed mid-block, on a node that joins exactly two
   * roads. `segment` is the piece the paint lies on (its downstream edge is
   * this node). Dropped as soon as the node stops being a two-road node or the
   * segment leaves it: a real junction draws its own crossings.
   */
  crossing?: NodeCrossing;
  /**
   * The player's own lane connections at this node (docs/VIAS.md V4,
   * `roads/connectors.ts`): for each arriving lane listed, exactly these.
   * Absent: every connection derived. A link to a lane that is gone is left
   * out of the build.
   */
  laneLinks?: readonly LaneLink[];
  /** Each leg's rule under 'priority' control (docs/VIAS.md V5, `roads/rules.ts`); absent legs: derived. */
  approachRules?: readonly ApproachRuleEntry[];
  /** A signal's settings (V5): fixed time, greens, offset, bus priority; absent: adaptive. */
  signal?: SignalSettings;
  /**
   * What a road's end is (docs/VIAS.md V8): absent, the map's edge, where
   * traffic leaves and comes in; 'bulb', a turning circle where it turns
   * round (the player's choice per end, 2026-10-10). Read only while the
   * node is the end of one road.
   */
  end?: RoadEnd;
  /**
   * A U-turn through an opening in the median (docs/VIAS.md V8, retorno): a
   * piece the player puts on a road with a median, on a node joining two
   * pieces of it - the piece whose traffic, arriving here, turns round. One
   * direction per opening: two facing ones, each waiting at its own lane's
   * end, stood in each other's half circle (2026-10-10). Read only while the
   * node joins exactly two roads.
   */
  uturn?: SegmentId;
}

/** A road's end that is not the map's edge: a turning circle (balão de retorno). */
export type RoadEnd = 'bulb';

export type NodeCrossingKind = 'zebra' | 'signal';
export interface NodeCrossing {
  readonly kind: NodeCrossingKind;
  readonly segment: SegmentId;
}

export interface RoadSegment {
  readonly id: SegmentId;
  a: NodeId;
  b: NodeId;
  /** Null means a straight segment; see `CurveShape` for why `h` is absolute. */
  curve: CurveShape | null;
  type: number;
  /**
   * Arc-length offset of this segment's start within the road it was drawn as.
   *
   * Dash phase is anchored to this rather than to a render chain, so splitting
   * a road (which happens automatically whenever one crosses another) leaves
   * every dash boundary at the same world position (defect 1.10).
   */
  dashOrigin: number;
  direction: SegmentDirection;
  /** Optional total travel-lane count; omitted means the class default. */
  lanes: number | null;
  /** Authored cross-section; absent preserves the exact class profile. */
  section?: RoadSection;
  /** On-street parking left and right of a -> b (`parking.ts`); absent means none. */
  parking?: SegmentParking;
  /** Vertical construction mode. Ground is the legacy/default value. */
  structure: RoadStructure;
  /**
   * The sides of its cutting held by retaining walls instead of a batter
   * (docs/VIAS.md V3): the ground is cut back only as far as a portal's
   * cutting (`elevation.ts` `CUT_SHOULDER`) and a concrete wall stands at
   * each edge up to the natural ground (`render/structures.ts`). Absent: the
   * batter, as every road before it.
   */
  cutWalls?: true;
}

/**
 * The authoring document: what the user drew, before any derived geometry.
 *
 * Mutations are applied here, mark entities dirty and move a revision;
 * `Network.rebuild()` then rebuilds what is derived from what changed (see
 * `markNode` for why not from the dirty sets). Nothing in this file knows about lanes,
 * vehicles or rendering.
 */
/**
 * The places a run of points (a wall, a span of wire) covers, for the diary of
 * changes: on the planet one box a stretch, each on its first point's chart
 * with the second carried there - one box round points kept on two charts
 * spanned the atlas between them, and every tile under it was built again.
 * One box round them all on the flat map.
 */
function rectsAlong(points: readonly { readonly x: number; readonly y: number }[], pad: number): ChangeRect[] {
  if (!__PLANET__ || points.length < 2) { const r = rectAround(points, pad); return r ? [r] : []; }
  const out: ChangeRect[] = [];
  for (let i = 1; i < points.length; i++) out.push(rectAround([points[i - 1]!, onChartOf(points[i]!, points[i - 1]!)], pad)!);
  return out;
}

export class RoadDoc {
  readonly nodes = new Map<NodeId, RoadNode>();
  readonly segments = new Map<SegmentId, RoadSegment>();

  /**
   * The overhead utility network: poles and the wire runs between them.
   *
   * A second drawable graph, and deliberately a much simpler one. A pole has
   * no width, so none of the road machinery applies to it - no casing, no
   * junction, no trim, no elevation solve. It stands on whatever the ground
   * under it turns out to be.
   */
  readonly poles = new Map<PoleId, UtilityPole>();
  readonly poleSpans = new Map<SpanId, UtilitySpan>();

  /**
   * Walls, fences and hedges drawn along paths (`barriers.ts`). Like the poles
   * they are not part of the road network and keep their own revision,
   * `barrierRevision`: a fence drawn must not rebuild the roads.
   */
  readonly barriers = new Map<number, Barrier>();
  private barrierIds = new IdAllocator(1);

  /**
   * Street landscaping the player placed on the footways: trees, shrubs,
   * benches, bins, street lights, hydrants, post boxes (`landscape.ts`).
   * Nothing on a street is generated; this is all there is. It moves
   * `utilityRevision`, the gate of everything standing on a footway (the
   * renderer's furniture and the pedestrians' obstacles), never `revision`.
   */
  readonly landscape = new Map<number, LandscapeItem>();
  private landscapeIds = new IdAllocator(1);

  /**
   * Public transport the player laid out: bus stops and terminals, train and
   * metro tracks and stations, lines (`transit.ts`). Plain data, replaced
   * whole by each edit (`setTransit`), with its own revision: a bus stop
   * placed never rebuilds the roads.
   */
  transit: TransitData = emptyTransit();

  /** The public transport replaced by an edit of it. */
  setTransit(next: TransitData): void {
    this.transit = next;    this.changes.record('transit', null);
  }

  private nodeIds = new IdAllocator(1);
  private segIds = new IdAllocator(1);
  private poleIds = new IdAllocator(1);
  private spanIds = new IdAllocator(1);
  private nextTerrainId = 1;

  readonly terrainStamps: TerrainStamp[] = [];
  /**
   * The land this map was made on (`world/terrain.ts` `ReliefVersion`). A
   * document starts on the old field, as every map saved before the natural
   * landform did and as the tests and tools that build one expect; the game
   * puts a NEW map on the natural land (`main.ts`). A saved map without the
   * key loads on the old field, so its roads stay where they were.
   */
  terrainRelief: ReliefVersion = RELIEF_LEGACY;
  /**
   * The grid's origins on the planet (atlas points): one where each town's
   * building started (`world/planet/charts.ts` setGridOrigin, chosen in
   * `main.ts`). Saved with the map, so a town keeps the grid it was drawn on.
   */
  gridOrigins: { x: number; y: number }[] = [];
  /**
   * The regional standard of the map's road paint (docs/VIAS.md V6,
   * `roads/markingStyle.ts`). 'classic' for every map saved before the
   * regions, so it opens identical; a new map from the game is Brazilian.
   */
  markingStyle: MarkingStyleId = 'classic';
  /**
   * The map's ecosystem (`world/ecology.ts`): its biome and seed. Null on a
   * map made before it, which keeps its ground as it was; the game gives a
   * NEW map one (`main.ts`), and the player can give an old one one.
   */
  nature: NatureSettings | null = null;
  /** Ground painted over the terrain (`terrainPaint.ts`), oldest first. */
  readonly terrainPaint: PaintDab[] = [];
  /** Fog painted over the land (`fogPaint.ts`), oldest first, and how it behaves. */
  readonly fogDabs: FogDab[] = [];
  fogSettings: FogSettings = DEFAULT_FOG;
  /** Gullies cut or wiped with the brush (`gullies.ts`), oldest first, and how much of the steep land carries them of itself (0..1). */
  readonly gullyDabs: GullyDab[] = [];
  gullyAuto = DEFAULT_GULLY_AUTO;
  /** Clouds the player placed in the sky (`clouds.ts`). */
  readonly clouds: PlacedCloud[] = [];
  /** The map's weather (`weather.ts`). */
  weather: Weather = DEFAULT_WEATHER;
  /**
   * The money the roads are paid from (`economy.ts`, docs/VIAS.md V0). Part
   * of the document, so undo gives back what an edit took; saved only when it
   * is not the starting balance, so a map from before it reads the same.
   */
  economy: Economy = DEFAULT_ECONOMY;
  /** Trees the player planted (`trees.ts`), oldest first. */
  readonly trees: PlantedTree[] = [];
  /** Where trees were cut away, the woods' own too (`trees.ts`), oldest first. */
  readonly treeClearings: TreeClearing[] = [];
  /** The elements the player laid with the brush (`elements.ts`), oldest first. */
  readonly elements: ElementItem[] = [];

  /**
   * What changed in this document, where and why (`changes.ts`): every
   * method below that changes it writes an entry, and `replaceWith` - every
   * road drawn and every undo - writes what differs. It is the document's
   * only clock: every revision below is the serial of the latest entry of
   * its kind (Fowler, "Event Sourcing": every change goes through an event,
   * and what is derived is derived from them), so nothing changes without
   * the diary knowing where and why.
   */
  readonly changes = new ChangeJournal();

  /**
   * Modular buildings (docs/buildings.md). They keep their OWN revision,
   * `buildings.revision` (the diary's `buildings` kind): a building edit must
   * not move `revision`, which would rebuild the road network and the
   * simulation for nothing.
   */
  readonly buildings = new BuildingStore(this.changes);

  /** Authored land-use strokes, separate from the buildings they generated. */
  readonly zones: Zone[] = [];
  nextZoneId = 1;
  /**
   * The zoned cells of the street grid (`world/zoneGrid.ts`), stored by
   * place. `zones` above are the rectangles of the first zoning tool, kept
   * only so old maps load; nothing makes them any more.
   */
  readonly zoneMarks: ZoneMark[] = [];
  /** The land's lots (`world/lots.ts`): the cadastre the player zones and edits. */
  readonly lots: Lot[] = [];
  /** The blocks and strips already cut into lots, so a lot deleted on purpose is not made again. */
  readonly lotKeys: string[] = [];
  nextLotId = 1;

  /**
   * The zoning or the lots changed there (`zoneRevision`, `lotRevision`):
   * the way in for the tools that change them in place (`world/lots.ts`,
   * `editor/zoning.ts`), so the overlay and the growth notice it.
   */
  zonesChanged(rects: readonly ChangeRect[] | null, cause?: string): void {
    this.changes.record('zones', rects, cause ? { cause } : {});
  }

  lotsChanged(rects: readonly ChangeRect[] | null, cause?: string): void {
    this.changes.record('lots', rects, cause ? { cause } : {});
  }

  /**
   * The people made in the Person Creator, saved with the city. Their own
   * revision, `peopleRevision`: a person is not part of any network.
   */
  readonly people: PersonSpec[] = [];

  /** Adds a person, or replaces the one with the same id. */
  savePerson(person: PersonSpec): void {
    const at = this.people.findIndex((p) => p.id === person.id);
    if (at >= 0) this.people[at] = person;
    else this.people.push(person);    this.changes.record('people', null, { ids: [person.id] });
  }

  removePerson(id: number): void {
    const at = this.people.findIndex((p) => p.id === id);
    if (at < 0) return;
    this.people.splice(at, 1);    this.changes.record('people', null, { ids: [id] });
  }

  /** An id no saved person has. */
  nextPersonId(): number {
    return this.people.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  }

  // ------------------------------------------------------------ revisions
  // Each is the serial of the latest diary entry of its kind (`changes`):
  // read-only, moved only by writing the change down.

  /** The roads' geometry: every structural change; consumers use it to invalidate caches. */
  get revision(): number { return this.changes.serialOf('roads'); }
  /** Horizontal road and junction topology read by vehicles and pedestrians. */
  get trafficRevision(): number { return this.changes.serialOf('traffic'); }
  get terrainRevision(): number { return this.changes.serialOf('terrain'); }
  /**
   * Pole and wire edits and the street landscaping, which do NOT move
   * `revision`: a pole is not part of the road network, and moving
   * `revision` for one rebuilt the network, the lanelets, the whole
   * simulation topology and every road mesh - about 330 ms per pole on a
   * 180-segment map (tests/bench) - to draw a post. The renderer's utility
   * layer and the footway graph (`sim/peds/sidewalk.ts`) watch this instead.
   */
  get utilityRevision(): number { return this.changes.serialOf('utilities', 'landscape'); }
  /** Walls, fences and hedges: a fence drawn must not rebuild the roads. */
  get barrierRevision(): number { return this.changes.serialOf('barriers'); }
  /** Public transport: a bus stop placed never rebuilds the roads. */
  get transitRevision(): number { return this.changes.serialOf('transit'); }
  get natureRevision(): number { return this.changes.serialOf('nature'); }
  get paintRevision(): number { return this.changes.serialOf('paint'); }
  get fogRevision(): number { return this.changes.serialOf('fog'); }
  get gullyRevision(): number { return this.changes.serialOf('gullies'); }
  get cloudRevision(): number { return this.changes.serialOf('clouds'); }
  get weatherRevision(): number { return this.changes.serialOf('weather'); }
  get treeRevision(): number { return this.changes.serialOf('trees'); }
  get clearingRevision(): number { return this.changes.serialOf('clearings'); }
  get elementRevision(): number { return this.changes.serialOf('elements'); }
  get zoneRevision(): number { return this.changes.serialOf('zones'); }
  get lotRevision(): number { return this.changes.serialOf('lots'); }
  get peopleRevision(): number { return this.changes.serialOf('people'); }
  get economyRevision(): number { return this.changes.serialOf('economy'); }

  /** A road segment's rectangle as drawn: its ends, its bulge and its width. */
  segmentRect(id: SegmentId): ChangeRect | null {
    const s = this.segments.get(id);
    if (!s) return null;
    const a = this.nodes.get(s.a), b = this.nodes.get(s.b);
    if (!a || !b) return null;
    return rectAround([a, b], casingHalf(roadProfile(s.type, s.lanes, s.direction, s.section, s.parking)) + Math.abs(s.curve?.h ?? 0));
  }

  /** A node's rectangle: the junction round it, out to its roads' widths. */
  nodeRect(id: NodeId): ChangeRect | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    let pad = NODE_PAD;
    for (const sid of n.incident) {
      const s = this.segments.get(sid);
      if (s) pad = Math.max(pad, casingHalf(roadProfile(s.type, s.lanes, s.direction, s.section, s.parking)) * 2);
    }
    return rectAround([n], pad);
  }

  readonly dirtyNodes = new Set<NodeId>();
  readonly dirtySegments = new Set<SegmentId>();

  node(id: NodeId): RoadNode | undefined {
    return this.nodes.get(id);
  }

  segment(id: SegmentId): RoadSegment | undefined {
    return this.segments.get(id);
  }

  requireNode(id: NodeId): RoadNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`RoadDoc: missing node ${id}`);
    return n;
  }

  requireSegment(id: SegmentId): RoadSegment {
    const s = this.segments.get(id);
    if (!s) throw new Error(`RoadDoc: missing segment ${id}`);
    return s;
  }

  pole(id: PoleId): UtilityPole | undefined {
    return this.poles.get(id);
  }

  addPole(at: { x: number; y: number }, lamp = false): UtilityPole {
    const on = clampToMap(at);
    const id = asPoleId(this.poleIds.take());
    const pole: UtilityPole = { id, x: on.x, y: on.y, lamp };
    this.poles.set(id, pole);    this.changes.record('utilities', [rectAround([pole], ITEM_PAD)!], { ids: [id] });
    return pole;
  }

  /** Strings wire between two existing poles. Returns null for a degenerate run. */
  addPoleSpan(a: PoleId, b: PoleId): UtilitySpan | null {
    if (a === b) return null;
    if (!this.poles.has(a) || !this.poles.has(b)) return null;
    for (const existing of this.poleSpans.values()) {
      const same = existing.a === a && existing.b === b;
      const reversed = existing.a === b && existing.b === a;
      if (same || reversed) return existing;
    }
    const id = asSpanId(this.spanIds.take());
    const span: UtilitySpan = { id, a, b };
    this.poleSpans.set(id, span);    this.changes.record('utilities', rectsAlong([this.poles.get(a)!, this.poles.get(b)!], ITEM_PAD), { ids: [a, b] });
    return span;
  }

  /** Draws a barrier along `points` (two or more, on the map). */
  addBarrier(kind: BarrierKind, points: readonly { x: number; y: number }[]): Barrier | null {
    const path = points.map((p) => clampToMap(p));
    if (path.length < 2) return null;
    const barrier: Barrier = { id: this.barrierIds.take(), kind, points: path.map((p) => ({ x: p.x, y: p.y })) };
    this.barriers.set(barrier.id, barrier);    this.changes.record('barriers', rectsAlong(barrier.points, ITEM_PAD), { ids: [barrier.id] });
    return barrier;
  }

  removeBarrier(id: number): boolean {
    const barrier = this.barriers.get(id);
    if (!barrier || !this.barriers.delete(id)) return false;    this.changes.record('barriers', rectsAlong(barrier.points, ITEM_PAD), { ids: [id] });
    return true;
  }

  /** The barrier whose path passes nearest a point, within `radius`, or null. */
  barrierNear(at: { x: number; y: number }, radius: number): Barrier | null {
    let best: Barrier | null = null;
    let bestD = radius;
    for (const barrier of this.barriers.values()) {
      for (let i = 1; i < barrier.points.length; i++) {
        // On the stretch's first point's chart (`world/planet/charts.ts` layRun).
        const a = barrier.points[i - 1]!, b = onChartOf(barrier.points[i]!, a), q = onChartOf(at, a);
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = dx * dx + dy * dy;
        const t = len > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len)) : 0;
        const d = Math.hypot(a.x + dx * t - q.x, a.y + dy * t - q.y);
        if (d < bestD) { bestD = d; best = barrier; }
      }
    }
    return best;
  }

  /** Places one landscaping item where `snapLandscape` put it. */
  addLandscape(kind: LandscapeKind, at: { x: number; y: number }, extra: { signType?: SignType; text?: string; planted?: number } = {}): LandscapeItem {
    const on = clampToMap(at);
    const text = extra.text?.slice(0, SIGN_TEXT_MAX);
    const item: LandscapeItem = { id: this.landscapeIds.take(), kind, x: on.x, y: on.y,
      ...(extra.signType ? { signType: extra.signType } : {}), ...(text ? { text } : {}),
      ...(extra.planted !== undefined && Number.isFinite(extra.planted) ? { planted: extra.planted } : {}) };
    this.landscape.set(item.id, item);    this.changes.record('landscape', [rectAround([item], ITEM_PAD)!], { ids: [item.id] });
    return item;
  }

  removeLandscape(id: number): boolean {
    const item = this.landscape.get(id);
    if (!item || !this.landscape.delete(id)) return false;    this.changes.record('landscape', [rectAround([item], ITEM_PAD)!], { ids: [id] });
    return true;
  }

  /** Removes a pole and every wire that reached it. */
  removePole(id: PoleId): void {
    const pole = this.poles.get(id);
    if (!pole || !this.poles.delete(id)) return;
    const reached: { x: number; y: number }[] = [pole];
    for (const [spanId, span] of [...this.poleSpans]) {
      if (span.a !== id && span.b !== id) continue;
      const other = this.poles.get(span.a === id ? span.b : span.a);
      if (other) reached.push(other);
      this.poleSpans.delete(spanId);
    }    this.changes.record('utilities', [rectAround(reached, ITEM_PAD)!], { ids: [id] });
  }

  /** The pole nearest a point, within `radius`, or null. */
  poleNear(at: { x: number; y: number }, radius: number): UtilityPole | null {
    let best: UtilityPole | null = null;
    let bestSq = radius * radius;
    for (const pole of this.poles.values()) {
      // On the planet a pole kept on the next piece's chart is met on its chart.
      const q = onChartOf(at, pole);
      const dx = pole.x - q.x;
      const dy = pole.y - q.y;
      const d = dx * dx + dy * dy;
      if (d <= bestSq) {
        bestSq = d;
        best = pole;
      }
    }
    return best;
  }

  degree(id: NodeId): number {
    return this.nodes.get(id)?.incident.length ?? 0;
  }

  /**
   * Whether a node is the map's edge: the end of one road, where traffic and
   * people come in from outside and leave - not a turning circle the player
   * made of it (`RoadNode.end`, docs/VIAS.md V8).
   */
  mapEdge(id: NodeId): boolean {
    const node = this.nodes.get(id);
    return !!node && node.incident.length === 1 && node.end !== 'bulb';
  }

  // ---------------------------------------------------------------- mutation

  /**
   * Adds a node, ON THE MAP.
   *
   * The ground is a finite plate, and every position authored here is clamped
   * to it. Nothing else could enforce it: a node is what a road, its footway,
   * its junction, its lamps, its bins and its lanelets are all derived from,
   * so a node past the rim takes all of them with it — a road hanging over the
   * void, which is what "nothing may leave the map" was reported against.
   */
  addNode(p: Vec2, heightOffset = 0, smooth = false): RoadNode {
    const at = clampToMap(p);
    const id = asNodeId(this.nodeIds.take());
    const n: RoadNode = { id, x: at.x, y: at.y, heightOffset, smooth,
      incident: [], control: 'auto', blockedMovements: [] };
    this.nodes.set(id, n);
    this.markNode(id);
    return n;
  }

  /** Whether a road at `structure` already joins `a` and `b` directly. */
  connects(a: NodeId, b: NodeId, structure: RoadStructure): boolean {
    const node = this.nodes.get(a);
    if (!node) return false;
    return node.incident.some((id) => {
      const s = this.segments.get(id);
      return s !== undefined && s.structure === structure && ((s.a === a && s.b === b) || (s.a === b && s.b === a));
    });
  }

  addSegment(
    a: NodeId,
    b: NodeId,
    type: number,
    curve: CurveShape | null = null,
    dashOrigin = 0,
    direction: SegmentDirection = 'both',
    lanes: number | null = null,
    structure: RoadStructure = 'ground',
    section?: RoadSection,
    parking?: SegmentParking,
  ): RoadSegment | null {
    if (a === b) return null;
    if (!this.nodes.has(a) || !this.nodes.has(b)) return null;
    const authoredSection = normalizeRoadSection(section);
    const authoredParking = normalizeParking(parking);
    const id = asSegmentId(this.segIds.take());
    const s: RoadSegment = {
      id, a, b, curve, type, dashOrigin, direction,
      lanes: normaliseLaneCount(lanes, direction),
      structure,
      ...(authoredSection ? { section: authoredSection } : {}),
      ...(authoredParking ? { parking: authoredParking } : {}),
    };
    this.segments.set(id, s);
    this.requireNode(a).incident.push(id);
    this.requireNode(b).incident.push(id);
    // A third road turns a mid-block crossing into a junction.
    for (const end of [a, b]) dropStaleCrossing(this.requireNode(end));
    this.fitCurve(s);
    this.markSegment(id);
    return s;
  }

  removeSegment(id: SegmentId): void {
    const s = this.segments.get(id);
    if (!s) return;
    this.markSegment(id);
    detach(this.nodes.get(s.a), id);
    detach(this.nodes.get(s.b), id);
    // A turn ban naming a road that is gone bans nothing - until the id is
    // handed out again and it silently bans a movement onto an unrelated road.
    for (const end of [s.a, s.b]) {
      const n = this.nodes.get(end);
      if (!n) continue;
      for (let i = n.blockedMovements.length - 1; i >= 0; i--) {
        if (movementMentions(n.blockedMovements[i] as string, id)) n.blockedMovements.splice(i, 1);
      }
      dropStaleCrossing(n);
    }
    this.segments.delete(id);
  }

  /**
   * Re-applies the turn bans `saved` at `node` that named segment `from`, naming
   * `to` instead. Splitting a road (which happens whenever a new road crosses
   * it) and joining two replace its segment ids; the player's bans used to be
   * left naming the old id, so they silently stopped applying.
   */
  carryMovements(node: NodeId, saved: readonly string[], from: SegmentId, to: SegmentId): void {
    const n = this.nodes.get(node);
    if (!n) return;
    for (const key of saved) {
      if (!movementMentions(key, from)) continue;
      const [a, b] = key.split('>') as [string, string];
      const moved = `${a === String(from) ? to : a}>${b === String(from) ? to : b}`;
      if (!n.blockedMovements.includes(moved)) n.blockedMovements.push(moved);
    }
    this.dirtyNodes.add(node);
    // The geometry is the same; what moves is the plan the traffic runs on.
    this.changes.record('traffic', this.rectsOrMap(this.nodeRect(node)), { ids: [node], detail: 'turn bans carried' });
  }

  /**
   * Re-applies a crossing `saved` at `node` that lay on segment `from` to the
   * segment `to` that replaced it there (a split or a join), exactly as
   * `carryMovements` does for turn bans.
   */
  carryCrossing(node: NodeId, saved: NodeCrossing | undefined, from: SegmentId, to: SegmentId): void {
    const n = this.nodes.get(node);
    if (!n || !saved || saved.segment !== from) return;
    n.crossing = { kind: saved.kind, segment: to };
    dropStaleCrossing(n);
    this.markNode(node);
  }

  removeNode(id: NodeId): void {
    const n = this.nodes.get(id);
    if (!n) return;
    const where = this.rectsOrMap(this.nodeRect(id));
    for (const sid of n.incident.slice()) this.removeSegment(sid);
    this.nodes.delete(id);
    this.dirtyNodes.add(id);
    this.roadsChanged(where, true, { ids: [id], detail: 'node removed' });
  }

  /**
   * Rewires every segment from `source` into `target`, then removes `source`.
   * Used by legacy-map repair after a visually touching endpoint is projected
   * onto and split into the road it was meant to join.
   */
  mergeNodes(target: NodeId, source: NodeId): boolean {
    if (target === source) return true;
    const keep = this.nodes.get(target);
    const remove = this.nodes.get(source);
    if (!keep || !remove) return false;
    if (Math.abs(keep.heightOffset - remove.heightOffset) > 0.75) return false;

    if (keep.control === 'auto' && remove.control !== 'auto') keep.control = remove.control;
    for (const movement of remove.blockedMovements) {
      if (!keep.blockedMovements.includes(movement)) keep.blockedMovements.push(movement);
    }

    for (const id of remove.incident.slice()) {
      const segment = this.segments.get(id);
      if (!segment) continue;
      const other = segment.a === source ? segment.b : segment.a;
      // A road to the node being kept folds to nothing; a road to a neighbour
      // the kept node already reaches would become a second road between the
      // same two nodes - overlapping ribbons and doubled lanes. Both go.
      if (other === target || this.connects(target, other, segment.structure)) {
        this.removeSegment(id);
        continue;
      }
      if (segment.a === source) segment.a = target;
      if (segment.b === source) segment.b = target;
      detach(remove, id);
      if (!keep.incident.includes(id)) keep.incident.push(id);
      this.markSegment(id);
    }
    this.nodes.delete(source);
    this.dirtyNodes.add(source);
    dropStaleCrossing(keep);
    this.markNode(target);
    return true;
  }

  /** Moves a node freely; junction geometry adapts to the resulting angle. */
  /**
   * Writes a node's point on another chart of the planet (`world/planet/charts.ts`):
   * the same ground in other coordinates, so no edit - its curves are not
   * refitted and nothing is clamped. Only a working copy is recoded (an edit
   * worked out on one chart, `editor/commit.ts`).
   */
  recodeNode(id: NodeId, at: Vec2): void {
    const n = this.nodes.get(id);
    if (!n || (n.x === at.x && n.y === at.y)) return;
    n.x = at.x;
    n.y = at.y;
    this.markNode(id);
  }

  moveNode(id: NodeId, to: Vec2): boolean {
    const n = this.nodes.get(id);
    if (!n) return false;
    // Dragging a node off the plate is the same offence as building one there,
    // and is caught in the same place.
    const p = clampToMap(to);
    if (n.x === p.x && n.y === p.y) return true;

    n.x = p.x;
    n.y = p.y;
    this.markNode(id);
    for (const segId of n.incident) {
      const seg = this.segments.get(segId);
      if (seg) this.fitCurve(seg);
    }
    return true;
  }

  /**
   * A curve is never tighter than its road is wide.
   *
   * Every band of a road is an offset of its centreline, and an offset larger
   * than the radius folds back on itself: the inner kerb crosses over, the
   * junction mouth tears open (`open-mouth-seam-after-move`: an elevated
   * spur dragged to a 16.8-unit bend on a 30-unit-wide casing), and an inner
   * lane that should start past the mouth starts behind it
   * (`open-lane-end-inside-mouth-after-joint-scaling`). So whatever sets a
   * curve, moves an end or widens a road, the bulge is flattened until the
   * tightest bend clears the outermost band.
   */
  private fitCurve(s: RoadSegment): void {
    if (!s.curve) return;
    const a = this.nodes.get(s.a);
    const b = this.nodes.get(s.b);
    if (!a || !b) return;
    const fitted = fitRoadCurve(a, b, s.curve, s.type, s.lanes, s.direction, s.section, s.parking);
    if (fitted !== s.curve) {
      s.curve = fitted;
      this.markSegment(s.id);
    }
  }

  setSegmentType(id: SegmentId, type: number): void {
    const s = this.segments.get(id);
    if (!s || s.type === type) return;
    s.type = type;
    this.fitCurve(s);
    this.markSegment(id);
  }

  setSegmentCurve(id: SegmentId, curve: CurveShape | null): void {
    const s = this.segments.get(id);
    if (!s) return;
    s.curve = curve;
    this.fitCurve(s);
    this.markSegment(id);
  }

  setSegmentDirection(id: SegmentId, direction: SegmentDirection): void {
    const s = this.segments.get(id);
    if (!s || s.direction === direction) return;
    s.direction = direction;
    s.lanes = normaliseLaneCount(s.lanes, direction);
    this.fitCurve(s);
    this.markSegment(id);
  }

  setSegmentLanes(id: SegmentId, lanes: number | null): void {
    const s = this.segments.get(id);
    const next = normaliseLaneCount(lanes, s?.direction ?? 'both');
    if (!s || s.lanes === next) return;
    s.lanes = next;
    this.fitCurve(s);
    this.markSegment(id);
  }

  /** Changes every section consumer through the existing geometry/topology revision gates. */
  setSegmentSection(id: SegmentId, section?: RoadSection): void {
    const segment = this.segments.get(id);
    const next = normalizeRoadSection(section);
    if (!segment || (section !== undefined && !next) || sameRoadSection(segment.section, next)) return;
    if (next) segment.section = next;
    else delete segment.section;
    this.fitCurve(segment);
    this.markSegment(id);
  }

  /** Parking on the two sides of a segment; none on either side removes it. */
  setSegmentParking(id: SegmentId, parking?: SegmentParking): void {
    const segment = this.segments.get(id);
    const next = normalizeParking(parking);
    if (!segment || sameParking(segment.parking, next)) return;
    if (next) segment.parking = next;
    else delete segment.parking;
    this.fitCurve(segment);
    this.markSegment(id);
  }

  /** Retaining walls on the sides of the road's cutting (`RoadSegment.cutWalls`). */
  setSegmentCutWalls(id: SegmentId, on: boolean): void {
    const segment = this.segments.get(id);
    if (!segment || (segment.cutWalls === true) === on) return;
    if (on) segment.cutWalls = true;
    else delete segment.cutWalls;
    this.markSegment(id);
  }

  /** The player's lane connections at a node; undefined or empty: all derived (`RoadNode.laneLinks`). */
  setNodeLaneLinks(id: NodeId, links: readonly LaneLink[] | undefined): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const next = normalizeLaneLinks(links);
    if (linksDigest(node.laneLinks) === linksDigest(next)) return;
    if (next) node.laneLinks = next;
    else delete node.laneLinks;
    this.markNode(id);
  }

  /** The regional standard of the road paint (docs/VIAS.md V6): every road painted again. */
  setMarkingStyle(style: MarkingStyleId): void {
    if (this.markingStyle === style) return;
    this.markingStyle = style;
    this.roadsChanged(null, false, { detail: 'paint style' });
  }

  /** A U-turn through the median for the traffic arriving from `from` (`RoadNode.uturn`), or none. */
  setNodeUturn(id: NodeId, from: SegmentId | undefined): void {
    const node = this.nodes.get(id);
    if (!node || node.uturn === from) return;
    if (from !== undefined) node.uturn = from;
    else delete node.uturn;
    this.markNode(id);
  }

  /** What a road's end is (`RoadNode.end`): a turning circle, or (undefined) the map's edge. */
  setNodeEnd(id: NodeId, end: RoadEnd | undefined): void {
    const node = this.nodes.get(id);
    if (!node || node.end === end) return;
    if (end) node.end = end;
    else delete node.end;
    this.markNode(id);
  }

  /** Each leg's rule at a junction (`RoadNode.approachRules`); undefined: all derived. */
  setNodeApproachRules(id: NodeId, rules: readonly ApproachRuleEntry[] | undefined): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const next = normalizeApproachRules(rules);
    if (rulesDigest(node.approachRules) === rulesDigest(next)) return;
    if (next) node.approachRules = next;
    else delete node.approachRules;
    this.markNode(id);
  }

  /** A signal's settings (`RoadNode.signal`); undefined: adaptive with the game's timings. */
  setNodeSignal(id: NodeId, signal: SignalSettings | undefined): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const next = normalizeSignalSettings(signal);
    if (signalDigest(node.signal) === signalDigest(next)) return;
    if (next) node.signal = next;
    else delete node.signal;
    this.markNode(id);
  }

  setSegmentStructure(id: SegmentId, structure: RoadStructure): void {
    const segment = this.segments.get(id);
    if (!segment || segment.structure === structure) return;
    segment.structure = structure;
    this.markSegment(id);
  }

  setNodeHeightOffset(id: NodeId, heightOffset: number): void {
    const node = this.nodes.get(id);
    if (!node || !Number.isFinite(heightOffset) || node.heightOffset === heightOffset) return;
    const junctionModeChanged = (node.heightOffset < -TUNNEL_HEADROOM) !==
      (heightOffset < -TUNNEL_HEADROOM);
    node.heightOffset = heightOffset;
    this.markNode(id, junctionModeChanged);
  }

  /** Gives the map an ecosystem (or takes it away: null). */
  setNature(next: NatureSettings | null): void {
    if (JSON.stringify(this.nature) === JSON.stringify(next)) return;
    this.nature = next ? { ...next } : null;    this.changes.record('nature', null);
  }

  addPaintDab(dab: PaintDab): void {
    this.terrainPaint.push({ ...dab });
    // The oldest dab dropped changes the ground where it lay too: the whole map is laid again.
    const dropped = this.terrainPaint.length > MAX_PAINT_DABS;
    if (dropped) this.terrainPaint.shift();    this.changes.record('paint', dropped ? null : [circleRect(dab)]);
  }

  addFogDab(dab: FogDab): void {
    this.fogDabs.push({ ...dab });
    const dropped = this.fogDabs.length > MAX_FOG_DABS;
    if (dropped) this.fogDabs.shift();    this.changes.record('fog', dropped ? null : [circleRect(dab)]);
  }

  addGullyDab(dab: GullyDab): void {
    this.gullyDabs.push({ ...dab });
    const dropped = this.gullyDabs.length > MAX_GULLY_DABS;
    if (dropped) this.gullyDabs.shift();    this.changes.record('gullies', dropped ? null : [circleRect(dab)]);
  }

  clearGullies(): void {
    if (this.gullyDabs.length === 0) return;
    this.gullyDabs.length = 0;    this.changes.record('gullies', null);
  }

  setGullyAuto(amount: number): void {
    const next = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : DEFAULT_GULLY_AUTO));
    if (next === this.gullyAuto) return;
    this.gullyAuto = next;    this.changes.record('gullies', null);
  }

  /** The balance after an edit was paid for (`economy.ts` `chargeFor`); `cause` says which. */
  setBalance(balance: number, cause?: string): void {
    if (!Number.isFinite(balance) || balance === this.economy.balance) return;
    this.economy = { balance };
    this.changes.record('economy', null, cause ? { cause } : {});
  }

  setWeather(change: Partial<Weather>): void {
    const next = readWeather({ ...this.weather, ...change }, this.weather);
    if (JSON.stringify(next) === JSON.stringify(this.weather)) return;
    this.weather = next;    this.changes.record('weather', null);
  }

  plantTrees(trees: readonly PlantedTree[]): void {
    if (trees.length === 0) return;
    this.trees.push(...trees.map((t) => ({ ...t })));
    const dropped = this.trees.length > MAX_PLANTED_TREES;
    if (dropped) this.trees.splice(0, this.trees.length - MAX_PLANTED_TREES);    this.changes.record('trees', dropped ? null : [rectAround(trees, ITEM_PAD)!]);
  }

  /**
   * Cuts the trees away within `radius` of (x, y): the planted ones there go,
   * and a clearing is kept so none of the woods' own grows there either.
   */
  cutTrees(x: number, y: number, radius: number): void {
    const before = this.trees.length;
    for (let i = this.trees.length - 1; i >= 0; i--) {
      const t = this.trees[i]!;
      if (Math.hypot(t.x - x, t.y - y) <= radius) this.trees.splice(i, 1);
    }
    if (this.trees.length !== before) this.changes.record('trees', [circleRect({ x, y, radius })], { detail: `${before - this.trees.length} cut` });
    this.treeClearings.push({ x, y, radius });
    const dropped = this.treeClearings.length > MAX_TREE_CLEARINGS;
    if (dropped) this.treeClearings.shift();
    this.changes.record('clearings', dropped ? null : [circleRect({ x, y, radius })]);
  }

  /** Every planted tree gone, and every clearing grown over again. */
  clearTrees(): void {
    if (this.trees.length > 0) { this.trees.length = 0; this.changes.record('trees', null); }
    if (this.treeClearings.length > 0) { this.treeClearings.length = 0; this.changes.record('clearings', null); }
  }

  addElements(items: readonly ElementItem[]): void {
    if (items.length === 0) return;
    this.elements.push(...items);
    const dropped = this.elements.length > MAX_ELEMENTS;
    if (dropped) this.elements.splice(0, this.elements.length - MAX_ELEMENTS);    this.changes.record('elements', dropped ? null : [rectAround(items, Math.max(ITEM_PAD, ...items.map((e) => e.size)))!]);
  }

  /** Takes away the elements within `radius` of (x, y) - of one kind, or every kind (`kind` null). How many went. */
  removeElements(x: number, y: number, radius: number, kind: ElementKind | null): number {
    const before = this.elements.length;
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const e = this.elements[i]!;
      if ((kind === null || e.kind === kind) && Math.hypot(e.x - x, e.y - y) <= radius) this.elements.splice(i, 1);
    }
    const gone = before - this.elements.length;
    if (gone > 0) {      this.changes.record('elements', [circleRect({ x, y, radius })]);
    }
    return gone;
  }

  clearElements(): void {
    if (this.elements.length === 0) return;
    this.elements.length = 0;    this.changes.record('elements', null);
  }

  /** A new cloud; null when the sky already holds as many as it may. */
  addCloud(value: Omit<PlacedCloud, 'id'>): PlacedCloud | null {
    if (this.clouds.length >= MAX_PLACED_CLOUDS) return null;
    const id = this.clouds.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    const cloud = { ...value, id };
    this.clouds.push(cloud);    this.changes.record('clouds', [rectAround([cloud], cloud.size)!], { ids: [id] });
    return cloud;
  }

  /** Several clouds at once, as many as the sky has room for: how many were added. */
  addClouds(values: readonly Omit<PlacedCloud, 'id'>[]): number {
    let id = this.clouds.reduce((m, c) => Math.max(m, c.id), 0);
    let added = 0;
    for (const value of values) {
      if (this.clouds.length >= MAX_PLACED_CLOUDS) break;
      this.clouds.push({ ...value, id: ++id });
      added++;
    }
    if (added > 0) {      const placed = this.clouds.slice(-added);
      this.changes.record('clouds', [rectAround(placed, Math.max(...placed.map((c) => c.size)))!]);
    }
    return added;
  }

  updateCloud(id: number, change: Partial<Omit<PlacedCloud, 'id'>>): void {
    const i = this.clouds.findIndex((c) => c.id === id);
    if (i < 0) return;
    const was = this.clouds[i]!;
    const now = { ...was, ...change, id };
    this.clouds[i] = now;    this.changes.record('clouds', [rectAround([was, now], Math.max(was.size, now.size))!], { ids: [id] });
  }

  removeCloud(id: number): void {
    const i = this.clouds.findIndex((c) => c.id === id);
    if (i < 0) return;
    const [was] = this.clouds.splice(i, 1);    this.changes.record('clouds', [rectAround([was!], was!.size)!], { ids: [id] });
  }

  clearFog(): void {
    if (this.fogDabs.length === 0) return;
    this.fogDabs.length = 0;    this.changes.record('fog', null);
  }

  setFogSettings(next: Partial<FogSettings>): void {
    const merged = readFogSettings({ ...this.fogSettings, ...next });
    if (JSON.stringify(merged) === JSON.stringify(this.fogSettings)) return;
    this.fogSettings = merged;    this.changes.record('fog', null);
  }

  clearPaint(): void {
    if (this.terrainPaint.length === 0) return;
    this.terrainPaint.length = 0;    this.changes.record('paint', null);
  }

  addTerrainStamp(value: Omit<TerrainStamp, 'id'>): TerrainStamp {
    const stamp: TerrainStamp = { ...value, id: this.nextTerrainId++ };
    this.terrainStamps.push(stamp);
    // The oldest stamp dropped moves the land where it lay too.
    const dropped = this.terrainStamps.length > MAX_TERRAIN_STAMPS;
    if (dropped) this.terrainStamps.shift();    this.changes.record('terrain', dropped ? null : [circleRect(stamp)], { ids: [stamp.id] });
    return stamp;
  }

  clearTerrain(): void {
    if (this.terrainStamps.length === 0) return;
    this.terrainStamps.length = 0;    this.changes.record('terrain', null);
  }

  setNodeControl(id: NodeId, control: JunctionControl): void {
    const n = this.nodes.get(id);
    if (!n || n.control === control) return;
    n.control = control;
    this.markNode(id);
  }

  /**
   * Puts a mid-block pedestrian crossing on a two-road node, painted on
   * `segment`. A signal crossing is a signalised node; a zebra gives the
   * pedestrian priority. Returns false when the node cannot carry one.
   */
  setNodeCrossing(id: NodeId, kind: NodeCrossingKind, segment: SegmentId): boolean {
    const n = this.nodes.get(id);
    if (!n || n.incident.length !== 2 || !n.incident.includes(segment)) return false;
    n.crossing = { kind, segment };
    n.control = kind === 'signal' ? 'signal' : 'priority';
    this.markNode(id);
    return true;
  }

  /** Removes a node's mid-block crossing; the node goes back to `auto`. */
  clearNodeCrossing(id: NodeId): void {
    const n = this.nodes.get(id);
    if (!n?.crossing) return;
    delete n.crossing;
    n.control = 'auto';
    this.markNode(id);
  }

  setMovementBlocked(id: NodeId, from: SegmentId, to: SegmentId, blocked: boolean): void {
    const n = this.nodes.get(id);
    if (!n || from === to) return;
    const key = movementKey(from, to);
    const index = n.blockedMovements.indexOf(key);
    if (blocked && index < 0) n.blockedMovements.push(key);
    else if (!blocked && index >= 0) n.blockedMovements.splice(index, 1);
    else return;
    this.markNode(id);
  }

  /** Drops nodes with no incident segment. Returns how many were removed. */
  pruneOrphanNodes(): number {
    let removed = 0;
    for (const [id, n] of this.nodes) {
      if (n.incident.length === 0) {
        this.nodes.delete(id);
        this.dirtyNodes.add(id);
        removed++;
      }
    }
    if (removed) this.roadsChanged(null, true, { detail: `${removed} loose nodes dropped` });
    return removed;
  }

  // ------------------------------------------------------------ dirty marking

  /**
   * Marking a node dirty also marks every incident segment, and marking a
   * segment dirty marks both of its endpoints.
   *
   * That second edge matters more than it looks: adding a third leg at node A
   * changes the trim of segment S even though S itself did not change, and
   * moving node A changes S's *length*, which changes the trim clamp at node B.
   *
   * Read this next part before relying on any of it.
   *
   * The load-bearing effect of these methods today is `revision++`. Every
   * consumer — `Network`, `LaneletGraph`, `SimWorld`, the renderer's path cache,
   * the minimap — gates on a revision number. `Network.rebuild()` is
   * incremental, but it does NOT read `dirtyNodes` or `dirtySegments`: it
   * compares each segment's and node's sources with what its last rebuild
   * recorded (docs/VIAS.md V0), because any other network built on this
   * document clears these sets, and a set says "touched", not "changed".
   *
   * So the dirty sets are a correctly-maintained record nothing depends on
   * for correctness; do not delete a `markNode`/`markSegment` call on the
   * grounds that "nothing reads it" — the revision bump is what keeps every
   * cache in the engine honest.
   */
  markNode(id: NodeId, traffic = true): void {
    // A node may already be dirty when it is edited again before a rebuild.
    // The dirty set is an invalidation *set*, while revision is a mutation
    // clock: every real edit must advance it even when the same id is present.
    this.dirtyNodes.add(id);
    // Every real edit is written, even of a node already dirty: the diary is
    // the mutation clock (`revision` is its latest `roads` entry). A node gone
    // has no rectangle: the whole map.
    this.roadsChanged(this.rectsOrMap(this.nodeRect(id)), traffic, { ids: [id] });
    const n = this.nodes.get(id);
    if (!n) return;
    for (const sid of n.incident) {
      if (!this.dirtySegments.has(sid)) {
        this.dirtySegments.add(sid);
        const s = this.segments.get(sid);
        if (s) {
          this.dirtyNodes.add(s.a);
          this.dirtyNodes.add(s.b);
        }
      }
    }
  }

  markSegment(id: SegmentId): void {
    this.dirtySegments.add(id);
    this.roadsChanged(this.rectsOrMap(this.segmentRect(id)), true, { ids: [id] });
    const s = this.segments.get(id);
    if (!s) return;
    this.dirtyNodes.add(s.a);
    this.dirtyNodes.add(s.b);
  }

  clearDirty(): void {
    this.dirtyNodes.clear();
    this.dirtySegments.clear();
  }

  /** A rectangle as the diary takes it: itself, or the whole map when there is none. */
  private rectsOrMap(rect: ChangeRect | null): readonly ChangeRect[] | null {
    return rect ? [rect] : null;
  }

  /**
   * The roads changed there: their geometry (`roads`, read as `revision`)
   * and, when the plan the traffic runs on changes with it, `traffic` (read
   * as `trafficRevision`; a node raised without changing how it is crossed
   * leaves it).
   */
  private roadsChanged(rects: readonly ChangeRect[] | null, traffic: boolean, extra: { readonly ids?: readonly number[]; readonly detail?: string } = {}): void {
    const roads = this.changes.record('roads', rects, extra);
    if (traffic) this.changes.record('traffic', rects, { ...extra, parent: roads });
  }

  /**
   * Makes an independent working copy, including allocator high-water marks.
   *
   * Copying only the serialized ids is insufficient after a high id has been
   * deleted: a speculative edit could otherwise recycle it.  Commits use this
   * clone so a failed operation never mutates the live document.
   */
  clone(): RoadDoc {
    // The buildings are shared, not copied: their records are replaced, never
    // changed in place. Copied through JSON, every road drawn copied every
    // building in town twice (docs/performance.md #19).
    const copy = RoadDoc.fromJSON(this.serialized(false), { repair: false, shareBuildings: this.buildings });
    copy.nodeIds = new IdAllocator(this.nodeIds.peek);
    copy.segIds = new IdAllocator(this.segIds.peek);
    copy.poleIds = new IdAllocator(this.poleIds.peek);
    copy.spanIds = new IdAllocator(this.spanIds.peek);
    copy.barrierIds = new IdAllocator(this.barrierIds.peek);
    copy.landscapeIds = new IdAllocator(this.landscapeIds.peek);
    copy.nextTerrainId = this.nextTerrainId;
    copy.clearDirty();
    for (const id of this.dirtyNodes) copy.dirtyNodes.add(id);
    for (const id of this.dirtySegments) copy.dirtySegments.add(id);
    copy.terrainStamps.length = 0;
    copy.terrainStamps.push(...this.terrainStamps.map((stamp) => ({ ...stamp })));
    copy.terrainRelief = this.terrainRelief;
    copy.gridOrigins = this.gridOrigins.map((o) => ({ ...o }));
    copy.markingStyle = this.markingStyle;
    copy.nature = this.nature ? { ...this.nature } : null;
    copy.buildings.copyAllocator(this.buildings);
    copy.nextZoneId = this.nextZoneId;
    // At the same revisions as this document, every one of them: the copy's
    // diary goes on from this one's (what loading the copy wrote is not a
    // change), so the live network is taken over as it stands (`adopt`).
    copy.changes.continueFrom(this.changes);
    return copy;
  }

  /** Replaces this instance in place while restoring allocator invariants. */
  replaceFromJSON(data: SerializedDoc, options: { readonly repair?: boolean } = {}): void {
    const restored = RoadDoc.fromJSON(data, options);
    this.replaceWith(restored);
  }

  /**
   * Replaces this instance from another valid document - every road drawn
   * (an edited clone, `commitDraft`) and every undo - and writes in the diary
   * what differs: the roads and junctions by id with their rectangles, the
   * land's stamps, the poles, the landscaping and the barriers where they
   * stand, and every other kind whose content moved.
   */
  replaceWith(source: RoadDoc): void {
    const roads = roadDifferences(this, source);
    const stamps = this.terrainRelief !== source.terrainRelief ? null : stampDifferences(this.terrainStamps, source.terrainStamps);
    const items = itemDifferences(this, source);
    const changed = this.replaceContents(source);
    const where = (rects: readonly ChangeRect[] | undefined): readonly ChangeRect[] | null => rects && rects.length ? rects : null;
    if (changed.roads || roads.rects.length) this.roadsChanged(where(roads.rects), changed.roads, { ids: roads.ids });
    if (changed.land || (stamps !== null && stamps.rects.length)) {
      this.changes.record('terrain', where(stamps?.rects), stamps?.ids ? { ids: stamps.ids } : {});
    }
    if (changed.utilities || items.utilities.length) this.changes.record('utilities', where(items.utilities));
    if (items.landscape.length) this.changes.record('landscape', items.landscape);
    if (changed.barriers || items.barriers.length) this.changes.record('barriers', where(items.barriers));
    // The buildings write their own (`BuildingStore.replaceWith`), each where it stands.
    for (const kind of changed.others) this.changes.record(kind, null);
  }

  /**
   * Takes `source`'s contents and says what differed: the roads, the land,
   * the poles and the barriers (written with their places by `replaceWith`),
   * and every other kind whose content moved.
   */
  private replaceContents(source: RoadDoc): {
    roads: boolean; land: boolean; utilities: boolean; barriers: boolean; others: DocChangeKind[];
  } {
    const others: DocChangeKind[] = [];
    let barriersChanged = false;
    // The land moves only when its stamps do. Drawing a road replaces the whole
    // document with an edited clone (`commitDraft`), and moving the terrain
    // for it rewrote all 90 601 terrain corners, their normals and
    // the rivers on every road drawn, for ground that had not changed.
    const landMoved = !sameStamps(this.terrainStamps, source.terrainStamps) || this.terrainRelief !== source.terrainRelief;
    // Likewise the roads and the utility network: undoing a storey or a
    // brush dab replaced the whole document and moved both revisions, which
    // rebuilt every road mesh, the lanelets and the simulation topology for a
    // network that had not changed (CLAUDE.md: a building edit never moves
    // `doc.revision`).
    const roadsChanged = !sameRoads(this, source);
    const utilitiesChanged = !samePoles(this, source);

    this.nodes.clear();
    this.segments.clear();
    for (const [id, node] of source.nodes) {
      this.nodes.set(id, {
        id, x: node.x, y: node.y, heightOffset: node.heightOffset, smooth: node.smooth,
        incident: [...node.incident], control: node.control,
        blockedMovements: [...node.blockedMovements],
        ...(node.crossing ? { crossing: { ...node.crossing } } : {}),
        // The player's settings at the junction (V4, V5): dropped here, every
        // road drawn anywhere wiped them all (`replaceWith` of the edited clone).
        ...(node.laneLinks ? { laneLinks: node.laneLinks.map((l) => ({ ...l })) } : {}),
        ...(node.approachRules ? { approachRules: node.approachRules.map((e) => ({ ...e })) } : {}),
        ...(node.signal ? { signal: { ...node.signal, ...(node.signal.greens ? { greens: [...node.signal.greens] } : {}) } } : {}),
        ...(node.end ? { end: node.end } : {}),
        ...(node.uturn !== undefined ? { uturn: node.uturn } : {}),
      });
    }
    for (const [id, segment] of source.segments) {
      this.segments.set(id, {
        ...segment,
        curve: segment.curve ? { ...segment.curve } : null,
        ...(segment.section ? { section: cloneRoadSection(segment.section) } : {}),
      });
    }
    this.poles.clear();
    this.poleSpans.clear();
    for (const [id, pole] of source.poles) this.poles.set(id, { ...pole });
    for (const [id, span] of source.poleSpans) this.poleSpans.set(id, { ...span });
    this.landscape.clear();
    for (const [id, item] of source.landscape) this.landscape.set(id, { ...item });
    if (!sameBarriers(this, source)) {
      this.barriers.clear();
      for (const [id, barrier] of source.barriers) this.barriers.set(id, { ...barrier, points: barrier.points.map((p) => ({ ...p })) });
      barriersChanged = true;
    }
    // Writes a change only of the buildings that differ.
    this.buildings.replaceWith(source.buildings);
    // The zones and the lots moved only when their content did: every road
    // drawn replaces the document, and moving their revisions for it made
    // every reader of them redo its work for nothing (the dirty flag set
    // only when the primary data changes).
    this.nextZoneId = source.nextZoneId;
    if (JSON.stringify(this.zones) !== JSON.stringify(source.zones) || JSON.stringify(this.zoneMarks) !== JSON.stringify(source.zoneMarks)) {
      this.zones.length = 0;
      this.zones.push(...source.zones.map((zone) => ({ ...zone, buildingIds: [...zone.buildingIds] })));
      this.zoneMarks.length = 0;
      this.zoneMarks.push(...source.zoneMarks.map((mark) => ({ ...mark })));
      others.push('zones');
    }
    this.nextLotId = source.nextLotId;
    if (JSON.stringify(this.lots) !== JSON.stringify(source.lots) || this.lotKeys.join('\n') !== source.lotKeys.join('\n')) {
      this.lots.length = 0;
      this.lots.push(...source.lots.map((lot) => ({ ...lot, corners: lot.corners.map((q) => ({ ...q })) as unknown as Lot['corners'] })));
      this.lotKeys.length = 0;
      this.lotKeys.push(...source.lotKeys);
      others.push('lots');
    }
    if (JSON.stringify(this.transit) !== JSON.stringify(source.transit)) {
      this.transit = JSON.parse(JSON.stringify(source.transit)) as TransitData;
      others.push('transit');
    }
    if (JSON.stringify(this.people) !== JSON.stringify(source.people)) {
      this.people.length = 0;
      this.people.push(...source.people.map((p) => JSON.parse(JSON.stringify(p)) as PersonSpec));
      others.push('people');
    }

    if (JSON.stringify(this.nature) !== JSON.stringify(source.nature)) {
      this.nature = source.nature ? { ...source.nature } : null;
      others.push('nature');
    }

    if (this.economy.balance !== source.economy.balance) {
      this.economy = { ...source.economy };
      others.push('economy');
    }
    if (JSON.stringify(this.weather) !== JSON.stringify(source.weather)) {
      this.weather = { ...source.weather };
      others.push('weather');
    }
    if (JSON.stringify(this.trees) !== JSON.stringify(source.trees)) {
      this.trees.length = 0;
      this.trees.push(...source.trees.map((t) => ({ ...t })));
      others.push('trees');
    }
    if (JSON.stringify(this.treeClearings) !== JSON.stringify(source.treeClearings)) {
      this.treeClearings.length = 0;
      this.treeClearings.push(...source.treeClearings.map((c) => ({ ...c })));
      others.push('clearings');
    }

    if (this.elements.length !== source.elements.length || JSON.stringify(this.elements) !== JSON.stringify(source.elements)) {
      this.elements.length = 0;
      this.elements.push(...source.elements);
      others.push('elements');
    }

    if (JSON.stringify(this.clouds) !== JSON.stringify(source.clouds)) {
      this.clouds.length = 0;
      this.clouds.push(...source.clouds.map((c) => ({ ...c })));
      others.push('clouds');
    }

    if (this.gullyAuto !== source.gullyAuto || JSON.stringify(this.gullyDabs) !== JSON.stringify(source.gullyDabs)) {
      this.gullyDabs.length = 0;
      this.gullyDabs.push(...source.gullyDabs.map((dab) => ({ ...dab })));
      this.gullyAuto = source.gullyAuto;
      others.push('gullies');
    }

    if (JSON.stringify(this.fogDabs) !== JSON.stringify(source.fogDabs) || JSON.stringify(this.fogSettings) !== JSON.stringify(source.fogSettings)) {
      this.fogDabs.length = 0;
      this.fogDabs.push(...source.fogDabs.map((dab) => ({ ...dab })));
      this.fogSettings = { ...source.fogSettings };
      others.push('fog');
    }

    if (!samePaint(this.terrainPaint, source.terrainPaint)) {
      this.terrainPaint.length = 0;
      this.terrainPaint.push(...source.terrainPaint.map((dab) => ({ ...dab })));
      others.push('paint');
    }

    if (this.markingStyle !== source.markingStyle) {
      this.markingStyle = source.markingStyle;
      this.roadsChanged(null, false, { detail: 'paint style' });
    }
    if (landMoved) {
      this.terrainStamps.length = 0;
      this.terrainStamps.push(...source.terrainStamps.map((stamp) => ({ ...stamp })));
      this.terrainRelief = source.terrainRelief;
    }
    this.gridOrigins = source.gridOrigins.map((o) => ({ ...o }));

    this.nodeIds = new IdAllocator(source.nodeIds.peek);
    this.segIds = new IdAllocator(source.segIds.peek);
    this.poleIds = new IdAllocator(source.poleIds.peek);
    this.spanIds = new IdAllocator(source.spanIds.peek);
    this.barrierIds = new IdAllocator(source.barrierIds.peek);
    this.landscapeIds = new IdAllocator(source.landscapeIds.peek);
    this.nextTerrainId = source.nextTerrainId;
    const changed = { roads: roadsChanged, land: landMoved, utilities: utilitiesChanged, barriers: barriersChanged, others };
    if (!roadsChanged) return changed;
    this.clearDirty();
    for (const id of this.nodes.keys()) this.dirtyNodes.add(id);
    for (const id of this.segments.keys()) this.dirtySegments.add(id);
    return changed;
  }

  // ------------------------------------------------------------ serialization

  toJSON(): SerializedDoc {
    return this.serialized(true);
  }

  /**
   * `JSON.stringify(this.toJSON())`, the same text, with the buildings' text
   * kept per record (`BuildingStore.toText`) instead of written again.
   */
  toText(): string {
    if (this.buildings.size === 0) return JSON.stringify(this.serialized(false));
    // The keys in `toJSON`'s order: those before the buildings, the buildings,
    // those after.
    const head: Record<string, unknown> = {};
    const tail: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.serialized(false))) {
      (AFTER_BUILDINGS.has(key) ? tail : head)[key] = value;
    }
    const after = JSON.stringify(tail);
    return `${JSON.stringify(head).slice(0, -1)},"buildings":${this.buildings.toText()}${after === '{}' ? '' : `,${after.slice(1, -1)}`}}`;
  }

  /** `toJSON`, the buildings left out when `withBuildings` is false (`clone` shares them). */
  private serialized(withBuildings: boolean): SerializedDoc {
    return {
      version: 1,
      unit: METERS_PER_UNIT,
      // The planet's size it is made on (`rescale.ts`): a map from a planet of another size is moved onto this one.
      ...(__PLANET__ ? { planetHalf: FACE_HALF } : {}),
      nodes: [...this.nodes.values()].map((n) => ({
        // Copied, never aliased. `setMovementBlocked` mutates this array in
        // place (`push`/`splice`), so handing out the live reference made every
        // history snapshot taken "before" an edit pick up that edit: the
        // snapshot recorded as the pre-block state already contained the block,
        // and one undo restored it unchanged. `History` promises snapshots hold
        // the document as it was; an alias cannot.
        id: n.id, x: n.x, y: n.y, heightOffset: n.heightOffset, smooth: n.smooth,
        control: n.control, blockedMovements: [...n.blockedMovements],
        ...(n.crossing ? { crossing: { kind: n.crossing.kind, segment: n.crossing.segment } } : {}),
        ...(n.laneLinks ? { laneLinks: n.laneLinks.map((l) => ({ ...l })) } : {}),
        ...(n.approachRules ? { approachRules: n.approachRules.map((e) => ({ ...e })) } : {}),
        ...(n.signal ? { signal: { ...n.signal, ...(n.signal.greens ? { greens: [...n.signal.greens] } : {}) } } : {}),
        ...(n.end ? { end: n.end } : {}),
        ...(n.uturn !== undefined ? { uturn: n.uturn as number } : {}),
      })),
      segments: [...this.segments.values()].map((s) => ({
        id: s.id,
        a: s.a,
        b: s.b,
        type: s.type,
        curve: s.curve ? { ...s.curve } : null,
        dashOrigin: s.dashOrigin,
        direction: s.direction,
        lanes: s.lanes,
        structure: s.structure,
        ...(s.section ? { section: cloneRoadSection(s.section) } : {}),
        ...(s.parking ? { parking: { ...s.parking } } : {}),
        ...(s.cutWalls ? { cutWalls: true as const } : {}),
      })),
      terrain: this.terrainStamps.map((stamp) => ({ ...stamp })),
      // Only for the natural land: a legacy map serialises as before.
      ...(this.terrainRelief !== RELIEF_LEGACY ? { relief: this.terrainRelief } : {}),
      ...(this.gridOrigins.length ? { gridOrigins: this.gridOrigins.map((o) => [o.x, o.y] as const) } : {}),
      ...(this.markingStyle !== 'classic' ? { markingStyle: this.markingStyle } : {}),
      ...(this.nature ? { nature: { ...this.nature } } : {}),
      ...(this.terrainPaint.length > 0 ? { paint: this.terrainPaint.map((dab) => ({ ...dab })) } : {}),
      ...(this.fogDabs.length > 0 || JSON.stringify(this.fogSettings) !== JSON.stringify(DEFAULT_FOG)
        ? { fog: { dabs: this.fogDabs.map((dab) => ({ ...dab })), settings: { ...this.fogSettings } } } : {}),
      ...(this.gullyDabs.length > 0 || this.gullyAuto !== DEFAULT_GULLY_AUTO
        ? { gullies: { dabs: this.gullyDabs.map((dab) => ({ ...dab })), auto: this.gullyAuto } } : {}),
      ...(this.clouds.length > 0 ? { clouds: this.clouds.map((c) => ({ ...c })) } : {}),
      ...(this.elements.length > 0 ? { elements: this.elements.map((e) => ({ ...e })) } : {}),
      ...(this.trees.length > 0 ? { trees: this.trees.map((t) => ({ ...t })) } : {}),
      ...(JSON.stringify(this.weather) !== JSON.stringify(DEFAULT_WEATHER) ? { weather: { ...this.weather } } : {}),
      ...(this.treeClearings.length > 0 ? { treeClearings: this.treeClearings.map((c) => ({ ...c })) } : {}),
      poles: [...this.poles.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, lamp: p.lamp })),
      poleSpans: [...this.poleSpans.values()].map((s) => ({ id: s.id, a: s.a, b: s.b })),
      ...(this.landscape.size > 0 ? {
        landscape: [...this.landscape.values()].map((item) => ({ id: item.id, kind: item.kind, x: item.x, y: item.y,
          ...(item.signType ? { signType: item.signType } : {}), ...(item.text ? { text: item.text } : {}),
          ...(item.planted !== undefined ? { planted: item.planted } : {}) })),
      } : {}),
      // Only when there are any, so a map without them serialises as before.
      ...(this.barriers.size > 0 ? {
        barriers: [...this.barriers.values()].map((b) => ({ id: b.id, kind: b.kind, points: b.points.map((p) => ({ x: p.x, y: p.y })) })),
      } : {}),
      // Only when there are any, so a map without buildings serialises
      // exactly as it did before buildings existed.
      ...(withBuildings && this.buildings.size > 0 ? { buildings: this.buildings.toJSON() } : {}),
      ...(this.zones.length > 0 ? { zones: this.zones.map((zone) => ({ ...zone, buildingIds: [...zone.buildingIds] })) } : {}),
      ...(this.zoneMarks.length > 0 ? { zoneMarks: this.zoneMarks.map((mark) => ({ ...mark })) } : {}),
      ...(this.lots.length > 0 || this.lotKeys.length > 0 ? {
        lots: this.lots.map((lot) => ({ ...lot, corners: lot.corners.map((q) => ({ x: q.x, y: q.y })) as unknown as Lot['corners'] })),
        lotKeys: [...this.lotKeys],
      } : {}),
      // Likewise the people: only a city that has some carries the key.
      ...(this.people.length > 0 ? { people: this.people.map((p) => JSON.parse(JSON.stringify(p)) as PersonSpec) } : {}),
      // And the public transport.
      ...(hasTransit(this.transit) ? { transit: JSON.parse(JSON.stringify(this.transit)) as TransitData } : {}),
      // Only off the starting balance: a map that never paid for a road serialises as before.
      ...(this.economy.balance !== DEFAULT_ECONOMY.balance ? { economy: { balance: this.economy.balance } } : {}),
    };
  }

  /**
   * Builds a document from its serialized form.
   *
   * `repair` (the default) is for data entering the model from outside - an
   * autosave, an imported file: coincident nodes are merged and positions are
   * clamped onto the map. A clone or an undo snapshot is the model's own state
   * and must come back EXACTLY (`repair: false`): merging there deleted a road
   * the player could see the next time they drew, undid or reloaded.
   */
  static fromJSON(saved: SerializedDoc, options: { readonly repair?: boolean; readonly shareBuildings?: BuildingStore } = {}): RoadDoc {
    // A map saved in another world unit (every map before 2026-10-10: 0.4 m) in this build's (docs/ESCALA.md).
    const data = rescaleSerializedDoc(saved);
    const repair = options.repair ?? true;
    const doc = new RoadDoc();
    const canonicalNode = new Map<number, NodeId>();
    const nodeAt = new Map<string, RoadNode>();
    for (const n of data.nodes) {
      // Maps produced before cross-structure snapping was fixed can contain two
      // endpoint records at the exact same world position.  They render as one
      // junction but remain two disconnected graphs, so raised spans never see
      // the ground road they are meant to ramp into.  New edits cannot create
      // this state; repair it at the serialization boundary where legacy maps
      // enter the model.
      doc.nodeIds.reserve(n.id);
      const heightOffset = Number.isFinite(n.heightOffset) ? (n.heightOffset as number) : 0;
      const key = `${coordinateKey(n.x, n.y)}\u0000${heightOffset}`;
      const existing = repair ? nodeAt.get(key) : undefined;
      if (existing) {
        canonicalNode.set(n.id, existing.id);
        if (existing.control === 'auto' && n.control && n.control !== 'auto') {
          existing.control = n.control;
        }
        for (const movement of n.blockedMovements ?? []) {
          if (!existing.blockedMovements.includes(movement)) existing.blockedMovements.push(movement);
        }
        continue;
      }
      const id = asNodeId(n.id);
      // Nothing may leave the map (`addNode`/`moveNode` clamp); a file can.
      const at = repair ? clampToMap(n) : n;
      const node: RoadNode = {
        id, x: at.x, y: at.y, heightOffset, smooth: n.smooth ?? false,
        incident: [], control: n.control ?? 'auto',
        blockedMovements: n.blockedMovements ? [...n.blockedMovements] : [],
      };
      doc.nodes.set(id, node);
      nodeAt.set(key, node);
      canonicalNode.set(n.id, id);
    }
    for (const s of data.segments) {
      const id = asSegmentId(s.id);
      const a = canonicalNode.get(s.a) ?? asNodeId(s.a);
      const b = canonicalNode.get(s.b) ?? asNodeId(s.b);
      if (!doc.nodes.has(a) || !doc.nodes.has(b) || a === b) continue;
      const section = normalizeRoadSection(s.section);
      const parking = normalizeParking(s.parking);
      doc.segments.set(id, {
        id,
        a,
        b,
        type: s.type,
        curve: s.curve ?? null,
        dashOrigin: s.dashOrigin ?? 0,
        direction: s.direction ?? 'both',
        lanes: normaliseLaneCount(s.lanes ?? null, s.direction ?? 'both'),
        ...(section ? { section } : {}),
        ...(parking ? { parking } : {}),
        // Through the migration, so a level that has since been merged into
        // another (`viaduct`) loads as the one it became.
        structure: migrateStructure(s.structure) ?? 'ground',
        ...(s.cutWalls === true ? { cutWalls: true as const } : {}),
      });
      doc.requireNode(a).incident.push(id);
      doc.requireNode(b).incident.push(id);
      doc.segIds.reserve(s.id);
    }
    // Crossings last: they name a segment, and only a two-road node that still
    // holds that segment may carry one. A merged (repaired) record has none.
    for (const n of data.nodes) {
      const node = doc.nodes.get(asNodeId(n.id));
      const crossing = n.crossing;
      if (!node || canonicalNode.get(n.id) !== node.id || !crossing) continue;
      if (crossing.kind !== 'zebra' && crossing.kind !== 'signal') continue;
      node.crossing = { kind: crossing.kind, segment: asSegmentId(crossing.segment) };
      dropStaleCrossing(node);
    }
    // The player's lane connections: kept as stored (a link to a lane that
    // is gone is left out of the build, `lanelets.ts`).
    for (const n of data.nodes) {
      const node = doc.nodes.get(asNodeId(n.id));
      if (!node || canonicalNode.get(n.id) !== node.id) continue;
      const links = normalizeLaneLinks(n.laneLinks);
      if (links) node.laneLinks = links;
      const rules = normalizeApproachRules(n.approachRules);
      if (rules) node.approachRules = rules;
      const signal = normalizeSignalSettings(n.signal);
      if (signal) node.signal = signal;
      if (n.end === 'bulb') node.end = 'bulb';
      if (typeof n.uturn === 'number' && node.incident.includes(asSegmentId(n.uturn))) node.uturn = asSegmentId(n.uturn);
    }
    for (const dab of data.paint ?? []) {
      if (!isPaintKind(dab.kind) || ![dab.x, dab.y, dab.radius, dab.strength].every(Number.isFinite)) continue;
      doc.terrainPaint.push({ kind: dab.kind, x: dab.x, y: dab.y, radius: dab.radius, strength: dab.strength });
    }
    const loaded = { cause: 'mapa carregado' } as const;
    if (doc.terrainPaint.length) doc.changes.record('paint', null, loaded);
    // Absent: a map with the default weather (dry and still).
    if (data.weather) { doc.weather = readWeather(data.weather); doc.changes.record('weather', null, loaded); }
    // Absent: a map with no trees planted or cut.
    for (const raw of data.trees ?? []) {
      const tree = readPlantedTree(raw);
      if (tree && doc.trees.length < MAX_PLANTED_TREES) doc.trees.push(tree);
    }
    if (doc.trees.length) doc.changes.record('trees', null, loaded);
    for (const raw of data.treeClearings ?? []) {
      const clearing = readTreeClearing(raw);
      if (clearing && doc.treeClearings.length < MAX_TREE_CLEARINGS) doc.treeClearings.push(clearing);
    }
    if (doc.treeClearings.length) doc.changes.record('clearings', null, loaded);
    // Absent: a map with no elements laid.
    for (const raw of data.elements ?? []) {
      const item = readElement(raw);
      if (item) doc.elements.push(item);
    }
    if (doc.elements.length) doc.changes.record('elements', null, loaded);
    // Absent: a map with no clouds placed.
    for (const raw of data.clouds ?? []) {
      const cloud = readCloud(raw);
      if (cloud && doc.clouds.length < MAX_PLACED_CLOUDS && !doc.clouds.some((c) => c.id === cloud.id)) doc.clouds.push(cloud);
    }
    if (doc.clouds.length) doc.changes.record('clouds', null, loaded);
    // Absent: a map with no gullies laid and the land's own at the default.
    if (data.gullies) {
      for (const raw of data.gullies.dabs ?? []) {
        const dab = readGullyDab(raw);
        if (dab && doc.gullyDabs.length < MAX_GULLY_DABS) doc.gullyDabs.push(dab);
      }
      const auto = data.gullies.auto;
      if (typeof auto === 'number' && Number.isFinite(auto)) doc.gullyAuto = Math.min(1, Math.max(0, auto));
      doc.changes.record('gullies', null, loaded);
    }
    // Absent: a map with no fog painted.
    if (data.fog) {
      for (const raw of data.fog.dabs ?? []) {
        const dab = readFogDab(raw);
        if (dab) doc.fogDabs.push(dab);
      }
      doc.fogSettings = readFogSettings(data.fog.settings);
      doc.changes.record('fog', null, loaded);
    }
    // Absent: a map from before the natural land, which stays on the old one.
    doc.terrainRelief = isReliefVersion(data.relief) ? data.relief : RELIEF_LEGACY;
    doc.gridOrigins = Array.isArray(data.gridOrigins)
      ? data.gridOrigins.filter((o) => Array.isArray(o) && Number.isFinite(o[0]) && Number.isFinite(o[1])).map((o) => ({ x: o[0], y: o[1] }))
      : [];
    doc.markingStyle = isMarkingStyle(data.markingStyle) ? data.markingStyle : 'classic';
    // Absent: a map from before the ecosystem, which keeps its ground.
    doc.nature = isNatureSettings(data.nature) ? { region: data.nature.region, seed: data.nature.seed } : null;
    for (const stamp of data.terrain ?? []) {
      doc.terrainStamps.push({ ...stamp });
      doc.nextTerrainId = Math.max(doc.nextTerrainId, stamp.id + 1);
    }

    // The utility network, if the map has one. A map saved before poles
    // existed simply has no such key, and must load exactly as it did before.
    for (const p of data.poles ?? []) {
      const id = asPoleId(p.id);
      const at = repair ? clampToMap(p) : p;
      doc.poles.set(id, { id, x: at.x, y: at.y, lamp: p.lamp ?? false });
      doc.poleIds.reserve(p.id);
    }
    for (const s of data.poleSpans ?? []) {
      const a = asPoleId(s.a);
      const b = asPoleId(s.b);
      // A span whose poles did not survive is dropped rather than restored as
      // a wire hanging off nothing.
      if (!doc.poles.has(a) || !doc.poles.has(b)) continue;
      const id = asSpanId(s.id);
      doc.poleSpans.set(id, { id, a, b });
      doc.spanIds.reserve(s.id);
    }
    // Public transport, if the map has any; anything malformed is dropped.
    if (data.transit) doc.transit = normalizeTransit(data.transit);
    // The balance, if the map has paid for anything (absent: the starting balance).
    const economy = data.economy === undefined ? null : readEconomy(data.economy);
    if (economy) { doc.economy = economy; doc.changes.record('economy', null, { cause: 'mapa carregado' }); }
    // The player's landscaping, if the map has any; anything malformed is dropped.
    for (const raw of data.landscape ?? []) {
      if (!isLandscapeKind(raw?.kind) || !Number.isFinite(raw.x) || !Number.isFinite(raw.y) || !Number.isInteger(raw.id)) continue;
      const at = repair ? clampToMap(raw) : { x: raw.x, y: raw.y };
      doc.landscape.set(raw.id, { id: raw.id, kind: raw.kind, x: at.x, y: at.y,
        ...(isSignType(raw.signType) ? { signType: raw.signType } : {}),
        ...(typeof raw.text === 'string' && raw.text ? { text: raw.text.slice(0, SIGN_TEXT_MAX) } : {}),
        ...(Number.isFinite(raw.planted) ? { planted: raw.planted } : {}) });
      doc.landscapeIds.reserve(raw.id);
    }
    // Walls, fences and hedges, if the map has any; anything malformed is dropped.
    for (const raw of data.barriers ?? []) {
      if (!isBarrierKind(raw.kind) || !Array.isArray(raw.points)) continue;
      const points = raw.points.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
        .map((p) => (repair ? clampToMap(p) : { x: p.x, y: p.y }));
      if (points.length < 2) continue;
      doc.barriers.set(raw.id, { id: raw.id, kind: raw.kind, points });
      doc.barrierIds.reserve(raw.id);
    }
    // Buildings, if the map has any; each one through `migrateBuilding`.
    if (options.shareBuildings) doc.buildings.shareFrom(options.shareBuildings);
    else if (data.buildings) doc.buildings.load(data.buildings);
    for (const zone of data.zones ?? []) {
      if (!Number.isInteger(zone.id) || zone.id < 1 || !isZoneUse(zone.use) || !isZoneDensity(zone.density)) continue;
      if (![zone.x0, zone.y0, zone.x1, zone.y1, zone.seed].every(Number.isFinite)) continue;
      if (zone.x0 >= zone.x1 || zone.y0 >= zone.y1 || !Array.isArray(zone.buildingIds) ||
          doc.zones.some((old) => old.id === zone.id)) continue;
      doc.zones.push({ ...zone, buildingIds: zone.buildingIds.filter((id) => Number.isInteger(id) && doc.buildings.has(id as Parameters<typeof doc.buildings.has>[0])) });
      doc.nextZoneId = Math.max(doc.nextZoneId, zone.id + 1);
    }
    for (const mark of data.zoneMarks ?? []) {
      if (!isZoneMark(mark)) continue;
      const standing = mark.building !== undefined && doc.buildings.has(mark.building as Parameters<typeof doc.buildings.has>[0]);
      const { building: _gone, ...free } = mark;
      doc.zoneMarks.push(standing ? { ...mark } : free);
    }
    for (const lot of data.lots ?? []) {
      if (!isLot(lot) || doc.lots.some((l) => l.id === lot.id)) continue;
      const standing = lot.building !== undefined && doc.buildings.has(lot.building as Parameters<typeof doc.buildings.has>[0]);
      const { building: _gone, ...free } = lot;
      doc.lots.push(standing ? { ...lot } : free);
      doc.nextLotId = Math.max(doc.nextLotId, lot.id + 1);
    }
    for (const key of data.lotKeys ?? []) if (typeof key === 'string') doc.lotKeys.push(key);
    // People, each brought into range; anything that is not one is dropped.
    const seen = new Set<number>();
    for (const raw of data.people ?? []) {
      const person = normalizePerson(raw);
      if (!person || seen.has(person.id)) continue;
      seen.add(person.id);
      doc.people.push(person);
    }
    for (const id of doc.nodes.keys()) doc.dirtyNodes.add(id);
    for (const id of doc.segments.keys()) doc.dirtySegments.add(id);
    doc.roadsChanged(null, true, { detail: 'mapa carregado' });
    if (data.terrain?.length) doc.changes.record('terrain', null, { cause: 'mapa carregado' });
    return doc;
  }
}

/** Exact serialization key; normalises the two JavaScript spellings of zero. */
function coordinateKey(x: number, y: number): string {
  const nx = Object.is(x, -0) ? 0 : x;
  const ny = Object.is(y, -0) ? 0 : y;
  return `${nx}\u0000${ny}`;
}

export interface SerializedDoc {
  readonly version: 1;
  /** Metres per world unit the map was saved in (`world/units.ts`); absent: 0.4, every map before 2026-10-10 (`rescale.ts`). */
  readonly unit?: number;
  /** On the planet: the FACE_HALF of the planet it was made on (absent: 3 000, `rescale.ts`). */
  readonly planetHalf?: number;
  readonly nodes: readonly {
    id: number; x: number; y: number; heightOffset?: number; smooth?: boolean;
    control?: JunctionControl; blockedMovements?: readonly string[];
    crossing?: { kind: NodeCrossingKind; segment: number };
    /** The player's lane connections (docs/VIAS.md V4); absent on every older map. */
    laneLinks?: readonly { from: number; fromLane: number; to: number; toLane: number }[];
    /** Each leg's rule (docs/VIAS.md V5); absent on every older map. */
    approachRules?: readonly { segment: number; rule: string }[];
    /** A signal's settings (V5); absent on every older map. */
    signal?: unknown;
    /** A road's end that is a turning circle (V8); absent: the map's edge. */
    end?: string;
    /** A U-turn through the median (V8): the road its traffic arrives from; absent on every older map. */
    uturn?: number;
  }[];
  readonly segments: readonly {
    id: number;
    a: number;
    b: number;
    type: number;
    curve: CurveShape | null;
    dashOrigin?: number;
    direction?: SegmentDirection;
    lanes?: number | null;
    section?: RoadSection;
    parking?: SegmentParking;
    /** A current structure id, or a legacy one `migrateStructure` maps. */
    structure?: RoadStructure | 'viaduct';
    /** Retaining walls in its cutting (docs/VIAS.md V3); absent on every older map. */
    cutWalls?: boolean;
  }[];
  readonly terrain?: readonly TerrainStamp[];
  /** `ReliefVersion`; absent on maps made before the natural landform. */
  readonly relief?: number;
  readonly gridOrigins?: readonly (readonly [number, number])[];
  /** The regional standard of the road paint (docs/VIAS.md V6); absent: 'classic'. */
  readonly markingStyle?: string;
  /** The ecosystem (`NatureSettings`); absent on maps made before it. */
  readonly nature?: { readonly region: string; readonly seed: number };
  /**
   * The utility network. OPTIONAL, and it has to stay that way: every map
   * saved before poles existed has no such key, and loading one must not
   * fail or silently drop the roads around it.
   */
  readonly poles?: readonly { id: number; x: number; y: number; lamp?: boolean }[];
  readonly poleSpans?: readonly { id: number; a: number; b: number }[];
  /** Ground painted over the terrain (`terrainPaint.ts`); OPTIONAL. */
  readonly paint?: readonly { kind: string; x: number; y: number; radius: number; strength: number }[];
  readonly fog?: { readonly dabs?: readonly unknown[]; readonly settings?: unknown };
  readonly gullies?: { readonly dabs?: readonly unknown[]; readonly auto?: unknown };
  readonly clouds?: readonly unknown[];
  readonly elements?: readonly unknown[];
  readonly trees?: readonly unknown[];
  readonly weather?: unknown;
  readonly treeClearings?: readonly unknown[];
  /** The player's landscaping (`landscape.ts`); OPTIONAL like the poles. */
  readonly landscape?: readonly { id: number; kind: string; x: number; y: number; signType?: string; text?: string; planted?: number }[];
  /** Public transport (`transit.ts`); OPTIONAL like the poles. */
  readonly transit?: unknown;
  /** Walls, fences and hedges (`barriers.ts`); OPTIONAL like the poles. */
  readonly barriers?: readonly { id: number; kind: string; points: readonly { x: number; y: number }[] }[];
  /**
   * Modular buildings (docs/buildings.md). OPTIONAL, for the same reason as
   * the poles: every map saved before buildings existed has no such key.
   */
  readonly buildings?: readonly SerializedBuilding[];
  /** Roadside land-use strokes; absent in maps saved before zoning. */
  readonly zones?: readonly Zone[];
  readonly zoneMarks?: readonly ZoneMark[];
  /** The lots (`lots.ts`); absent in maps saved before them. */
  readonly lots?: readonly Lot[];
  readonly lotKeys?: readonly string[];
  /** People from the Person Creator; OPTIONAL like the buildings. Normalised on load. */
  readonly people?: readonly unknown[];
  /** The balance (`economy.ts`); absent at the starting balance. */
  readonly economy?: { readonly balance: number };
}

function detach(n: RoadNode | undefined, id: SegmentId): void {
  if (!n) return;
  const i = n.incident.indexOf(id);
  if (i >= 0) n.incident.splice(i, 1);
}

function normaliseLaneCount(lanes: number | null, direction: SegmentDirection): number | null {
  if (lanes === null) return null;
  const value = Math.max(1, Math.min(8, Math.round(lanes)));
  // A two-way road must have an equal number of lanes on both sides.
  return direction === 'both' ? Math.max(2, Math.ceil(value / 2) * 2) : value;
}

/** Whether two versions of a node are the same, field for field. */
function sameNode(p: RoadNode, q: RoadNode): boolean {
  return p.x === q.x && p.y === q.y && p.heightOffset === q.heightOffset && p.smooth === q.smooth &&
    p.control === q.control && sameList(p.incident, q.incident) && sameList(p.blockedMovements, q.blockedMovements) &&
    p.crossing?.kind === q.crossing?.kind && p.crossing?.segment === q.crossing?.segment &&
    linksDigest(p.laneLinks) === linksDigest(q.laneLinks) && rulesDigest(p.approachRules) === rulesDigest(q.approachRules) &&
    signalDigest(p.signal) === signalDigest(q.signal) && p.end === q.end && p.uturn === q.uturn;
}

/** Whether two versions of a segment are the same, field for field (its ends' positions aside). */
function sameSegment(p: RoadSegment, q: RoadSegment): boolean {
  return p.a === q.a && p.b === q.b && p.type === q.type && p.dashOrigin === q.dashOrigin &&
    p.direction === q.direction && p.lanes === q.lanes && p.structure === q.structure && p.cutWalls === q.cutWalls &&
    sameRoadSection(p.section, q.section) && sameParking(p.parking, q.parking) &&
    (p.curve?.t ?? null) === (q.curve?.t ?? null) && (p.curve?.h ?? null) === (q.curve?.h ?? null);
}

/** Whether two documents hold the same nodes and segments, field for field. */
function sameRoads(a: RoadDoc, b: RoadDoc): boolean {
  if (a.nodes.size !== b.nodes.size || a.segments.size !== b.segments.size) return false;
  for (const [id, p] of a.nodes) {
    const q = b.nodes.get(id);
    if (!q || !sameNode(p, q)) return false;
  }
  for (const [id, p] of a.segments) {
    const q = b.segments.get(id);
    if (!q || !sameSegment(p, q)) return false;
  }
  return true;
}

/** Around a junction with no road yet, world units. */
const NODE_PAD = 30;
/** Around a pole, a bench, a tree, a fence: what stands round it. */
const ITEM_PAD = 6;

const circleRect = (c: { readonly x: number; readonly y: number; readonly radius: number }): ChangeRect =>
  [c.x - c.radius, c.y - c.radius, c.x + c.radius, c.y + c.radius];

/**
 * Where two documents' roads differ: every segment and node that is new,
 * gone or changed (a segment whose end moved counts as changed), as it was
 * and as it is, with their ids.
 */
function roadDifferences(a: RoadDoc, b: RoadDoc): { rects: ChangeRect[]; ids: number[] } {
  const rects: ChangeRect[] = [];
  const ids: number[] = [];
  const add = (rect: ChangeRect | null): void => { if (rect) rects.push(rect); };
  const endsMoved = (s: RoadSegment): boolean => {
    for (const end of [s.a, s.b]) {
      const p = a.nodes.get(end), q = b.nodes.get(end);
      if (!p || !q || p.x !== q.x || p.y !== q.y) return true;
    }
    return false;
  };
  for (const [id, p] of a.segments) {
    const q = b.segments.get(id);
    if (q && sameSegment(p, q) && !endsMoved(p)) continue;
    ids.push(id);
    add(a.segmentRect(id));
    if (q) add(b.segmentRect(id));
  }
  for (const id of b.segments.keys()) {
    if (a.segments.has(id)) continue;
    ids.push(id);
    add(b.segmentRect(id));
  }
  for (const [id, p] of a.nodes) {
    const q = b.nodes.get(id);
    if (q && sameNode(p, q)) continue;
    add(a.nodeRect(id));
    if (q) add(b.nodeRect(id));
  }
  for (const id of b.nodes.keys()) if (!a.nodes.has(id)) add(b.nodeRect(id));
  return { rects, ids };
}

/** The land's stamps added, gone or changed between two lists, by id. */
function stampDifferences(a: readonly TerrainStamp[], b: readonly TerrainStamp[]): { rects: ChangeRect[]; ids: number[] } {
  const rects: ChangeRect[] = [];
  const ids: number[] = [];
  const mine = new Map(a.map((s) => [s.id, s]));
  const theirs = new Map(b.map((s) => [s.id, s]));
  for (const [id, s] of mine) {
    const t = theirs.get(id);
    if (t && JSON.stringify(s) === JSON.stringify(t)) continue;
    ids.push(id);
    rects.push(circleRect(s));
    if (t) rects.push(circleRect(t));
  }
  for (const [id, t] of theirs) if (!mine.has(id)) { ids.push(id); rects.push(circleRect(t)); }
  return { rects, ids };
}

/** Where two documents' poles and wires, landscaping and barriers differ. */
function itemDifferences(a: RoadDoc, b: RoadDoc): { utilities: ChangeRect[]; landscape: ChangeRect[]; barriers: ChangeRect[] } {
  const utilities: ChangeRect[] = [], landscape: ChangeRect[] = [], barriers: ChangeRect[] = [];
  const at = (p: { x: number; y: number }): ChangeRect => rectAround([p], ITEM_PAD)!;
  for (const [id, p] of a.poles) { const q = b.poles.get(id); if (!q || p.x !== q.x || p.y !== q.y || p.lamp !== q.lamp) { utilities.push(at(p)); if (q) utilities.push(at(q)); } }
  for (const [id, q] of b.poles) if (!a.poles.has(id)) utilities.push(at(q));
  const spanRect = (doc: RoadDoc, s: UtilitySpan): ChangeRect | null => {
    const p = doc.poles.get(s.a), q = doc.poles.get(s.b);
    return p && q ? rectAround([p, q], ITEM_PAD) : null;
  };
  for (const [id, s] of a.poleSpans) { const t = b.poleSpans.get(id); if (!t || t.a !== s.a || t.b !== s.b) { const r = spanRect(a, s); if (r) utilities.push(r); } }
  for (const [id, t] of b.poleSpans) if (!a.poleSpans.has(id)) { const r = spanRect(b, t); if (r) utilities.push(r); }
  for (const [id, p] of a.landscape) {
    const q = b.landscape.get(id);
    if (q && p.kind === q.kind && p.x === q.x && p.y === q.y && p.signType === q.signType && p.text === q.text && p.planted === q.planted) continue;
    landscape.push(at(p));
    if (q) landscape.push(at(q));
  }
  for (const [id, q] of b.landscape) if (!a.landscape.has(id)) landscape.push(at(q));
  for (const [id, p] of a.barriers) {
    const q = b.barriers.get(id);
    if (q && JSON.stringify(p) === JSON.stringify(q)) continue;
    barriers.push(rectAround(p.points, ITEM_PAD)!);
    if (q) barriers.push(rectAround(q.points, ITEM_PAD)!);
  }
  for (const [id, q] of b.barriers) if (!a.barriers.has(id)) barriers.push(rectAround(q.points, ITEM_PAD)!);
  return { utilities, landscape, barriers };
}

/** Whether two documents hold the same poles and spans. */
function samePoles(a: RoadDoc, b: RoadDoc): boolean {
  if (a.poles.size !== b.poles.size || a.poleSpans.size !== b.poleSpans.size) return false;
  if (a.landscape.size !== b.landscape.size) return false;
  for (const [id, p] of a.landscape) {
    const q = b.landscape.get(id);
    if (!q || p.kind !== q.kind || p.x !== q.x || p.y !== q.y || p.signType !== q.signType || p.text !== q.text) return false;
  }
  for (const [id, p] of a.poles) {
    const q = b.poles.get(id);
    if (!q || p.x !== q.x || p.y !== q.y || p.lamp !== q.lamp) return false;
  }
  for (const [id, p] of a.poleSpans) {
    const q = b.poleSpans.get(id);
    if (!q || p.a !== q.a || p.b !== q.b) return false;
  }
  return true;
}

/** Whether two documents hold the same barriers, point for point. */
function sameBarriers(a: RoadDoc, b: RoadDoc): boolean {
  if (a.barriers.size !== b.barriers.size) return false;
  for (const [id, p] of a.barriers) {
    const q = b.barriers.get(id);
    if (!q || p.kind !== q.kind || p.points.length !== q.points.length) return false;
    for (let i = 0; i < p.points.length; i++) {
      if (p.points[i]!.x !== q.points[i]!.x || p.points[i]!.y !== q.points[i]!.y) return false;
    }
  }
  return true;
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** `toJSON`'s keys written after the buildings (`RoadDoc.toText`). */
const AFTER_BUILDINGS = new Set(['zones', 'zoneMarks', 'lots', 'lotKeys', 'people', 'transit', 'economy']);

/** Two stamp lists that shape the same land (stamp by stamp, field by field). */
export function sameStamps(a: readonly TerrainStamp[], b: readonly TerrainStamp[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as TerrainStamp;
    const q = b[i] as TerrainStamp;
    if (p === q) continue;
    const keys = new Set([...Object.keys(p), ...Object.keys(q)]) as Set<keyof TerrainStamp>;
    for (const key of keys) if (p[key] !== q[key]) return false;
  }
  return true;
}

/** A crossing stays only on a two-road node that still holds its segment. */
function dropStaleCrossing(node: RoadNode | undefined): void {
  if (!node?.crossing) return;
  if (node.incident.length === 2 && node.incident.includes(node.crossing.segment)) return;
  const placed = node.crossing.kind === 'signal' ? 'signal' : 'priority';
  delete node.crossing;
  // The control the crossing put there goes with it, so the new junction picks
  // its own; a control the player changed since is theirs and stays.
  if (node.control === placed) node.control = 'auto';
}

function samePaint(a: readonly PaintDab[], b: readonly PaintDab[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!, q = b[i]!;
    if (p.kind !== q.kind || p.x !== q.x || p.y !== q.y || p.radius !== q.radius || p.strength !== q.strength) return false;
  }
  return true;
}
