import { clampToWorld } from './bounds';
import { type MarkingStyleId, isMarkingStyle } from './roads/markingStyle';
import { type ApproachRuleEntry, type SignalSettings, normalizeApproachRules, normalizeSignalSettings, rulesDigest, signalDigest } from './roads/rules';
import { type LaneLink, linksDigest, movementKey, normalizeLaneLinks } from './roads/connectors';
import { cloneRoadSection, normalizeRoadSection, sameRoadSection, type RoadSection } from './roadSection';
import { isLot, lotCentre, type Lot } from './lots';
import { OpenLots } from './openLots';
import { LotStore } from './lotStore';
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
// Runtime imports, and safe: `geometry` and `legAngles` take `RoadDoc` as a TYPE only
import { TUNNEL_HEADROOM, type RoadStructure, migrateStructure } from './structures';
import { MAX_TERRAIN_STAMPS, RELIEF_LEGACY, readRelief, type ReliefVersion, type TerrainStamp } from './terrain';
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
import { type SegmentDirection, casingHalf, roadProfile } from './roadTypes';
import { BuildingStore } from './buildings/store';
import type { SerializedBuilding } from './buildings/serialize';
import type { Building, BuildingId } from './buildings/types';
import { isZoneDensity, isZoneMark, isZoneUse, type Zone, type ZoneMark } from './zones';
import { normalizePerson, type PersonSpec } from '@people/spec';
import { ChangeJournal, TILE_LOADED, TILE_UNLOADED, isStreaming, rectAround, type ChangeRect, type DocChangeKind } from './changes';
import { OWNER, TILE, TILE_COUNTED, tileIdBase, tileKey, tileOfKey, tileRect } from './tiles';
import { JournalCursor } from './derived';
import { type GrownRows, selectRows } from './growth/rows';
import { gatesOf } from './buildingGates';
import { PoleIndex } from './poleIndex';
import { TileIndex } from './tileIndex';
import { CellFiling } from './cells';
import { rescaleSerializedDoc } from './rescale';
import { METERS_PER_UNIT, m } from './units';
import { ForkMap, forkWork } from '@core/forkMap';
import { RecordMap } from '@core/recordMap';
import { samePlain, sameText } from '@core/plain';

/** `shape` flattened until no band of a road of this profile folds over (see `RoadDoc.fitCurve`). */
export function fitRoadCurve(
  a: Vec2, b: Vec2, shape: CurveShape | null, type: number,
  lanes: number | null = null, direction: SegmentDirection = 'both', section?: RoadSection,
  parking?: SegmentParking,
): CurveShape | null {
  return fitShapeToRadius(a, b, shape, casingHalf(roadProfile(type, lanes, direction, section, parking)));
}

/** Legal driving directions, relative to the stored `a -> b` orientation (`roadTypes.ts`). */
export type { SegmentDirection };

/** Explicit junction policy. `auto` retains the class-based default policy. */
/** 'mini': a mini-roundabout: every entry gives way to whoever is in it or comes from the left. */
export type JunctionControl = 'auto' | 'signal' | 'stop' | 'yield' | 'priority' | 'none' | 'mini';

/** Stable segment-pair key for a movement through a junction (`roads/connectors.ts`). */
export { movementKey };

/** Whether a movement key names segment `id` as its entry or its exit. */
function movementMentions(key: string, id: SegmentId): boolean {
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
  /** Materialized incidence list. */
  readonly incident: SegmentId[];
  control: JunctionControl;
  blockedMovements: string[];
  /** A pedestrian crossing placed mid-block, on a node that joins exactly two roads. */
  crossing?: NodeCrossing;
  /** The player's own lane connections at this node (`roads/connectors.ts`) */
  laneLinks?: readonly LaneLink[];
  /** Each leg's rule under 'priority' control (`roads/rules.ts`); absent legs: derived. */
  approachRules?: readonly ApproachRuleEntry[];
  /** A signal's settings (V5): fixed time, greens, offset, bus priority; absent: adaptive. */
  signal?: SignalSettings;
  /** What a road's end is: absent, the map's edge, where traffic leaves and comes in */
  end?: RoadEnd;
  /** A U-turn through an opening in the median (retorno) */
  uturn?: SegmentId;
}

/** A road's end that is not the map's edge: a turning circle. */
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
  /** Arc-length offset of this segment's start within the road it was drawn as. */
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
  /** The sides of its cutting held by retaining walls instead of a batter */
  cutWalls?: true;
}

/** The authoring document: what the user drew, before any derived geometry. */
/** The place a run of points (a wall, a span of wire) covers, for the diary of changes: one box round them all. */
function rectsAlong(points: readonly { readonly x: number; readonly y: number }[], pad: number): ChangeRect[] {
  const r = rectAround(points, pad);
  return r ? [r] : [];
}

export class RoadDoc {
  readonly nodes: Map<NodeId, RoadNode> = new RecordMap();
  readonly segments: Map<SegmentId, RoadSegment> = new RecordMap();
  /** The nodes that may have been left with no road (`pruneOrphanNodes`) */
  private loose = new LooseNodes();

  /** The overhead utility network: poles and the wire runs between them. */
  // DO NOT write these maps directly.
  private poleMap: Map<PoleId, UtilityPole> = new RecordMap();
  private spanMap: Map<SpanId, UtilitySpan> = new RecordMap();
  private poleIndex = new PoleIndex();
  get poles(): ReadonlyMap<PoleId, UtilityPole> { return this.poleMap; }
  get poleSpans(): ReadonlyMap<SpanId, UtilitySpan> { return this.spanMap; }

  /** Walls, fences and hedges drawn along paths (`barriers.ts`). */
  // DO NOT write this map directly.
  private barrierMap: Map<number, Barrier> = new RecordMap();
  get barriers(): ReadonlyMap<number, Barrier> { return this.barrierMap; }
  /** The barriers by place (`barriersIn`), filed over the box of their points. */
  private barrierCells = new CellFiling<number, Barrier>(LANDSCAPE_CELL);
  private barrierIds = new IdAllocator(1);

  /** Street landscaping the player placed on the footways: trees, shrubs, benches, bins, street lights, hydrants, post boxes */
  // DO NOT write this map directly.
  private landscapeMap: Map<number, LandscapeItem> = new RecordMap();
  get landscape(): ReadonlyMap<number, LandscapeItem> { return this.landscapeMap; }
  /** The street furniture by place (`landscapeIn`), in cells a few items wide. */
  private landscapeCells = new CellFiling<number, LandscapeItem>(LANDSCAPE_CELL);
  /** How many street name plates carry each name (`roads/streetNames.ts` gives a new street a name none has). */
  private streetNameCount = new Map<string, number>();
  get streetNamesInUse(): ReadonlyMap<string, number> { return this.streetNameCount; }
  private landscapeIds = new IdAllocator(1);

  /** Public transport the player laid out: bus stops and terminals, train and metro tracks and stations, lines */
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
  /** The land this map was made on (`world/terrain.ts` `ReliefVersion`). */
  terrainRelief: ReliefVersion = RELIEF_LEGACY;
  /** The regional standard of the map's road paint */
  markingStyle: MarkingStyleId = 'classic';
  /** The map's ecosystem (`world/ecology.ts`): its biome and seed. */
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
  /** The money the roads are paid from (`economy.ts`). */
  economy: Economy = DEFAULT_ECONOMY;
  /** Trees the player planted (`trees.ts`), oldest first. */
  readonly trees: PlantedTree[] = [];
  /** The planted trees by place (`treesIn`), made when first asked and then kept by the writers */
  private treeGrid: ItemGrid<PlantedTree> | null = null;
  /** @rebuild The whole list filed only on the first ask after it was replaced whole; the writers keep it after. */
  private get treeCells(): ItemGrid<PlantedTree> {
    if (!this.treeGrid) {
      this.treeGrid = new ItemGrid(LANDSCAPE_CELL);
      for (const t of this.trees) this.treeGrid.add(t);
    }
    return this.treeGrid;
  }

  /** The planted trees standing in the cells a rectangle reaches (a superset: test each). */
  treesIn(rect: ChangeRect): PlantedTree[] {
    // A working copy that has not written its trees reads the original's filing (`fork`).
    if (this.below && this.sharedLists.has('trees')) return this.below.treesIn(rect);
    return this.treeCells.near(rect);
  }
  /** Where trees were cut away, the woods' own too (`trees.ts`), oldest first. */
  readonly treeClearings: TreeClearing[] = [];
  /** DO NOT push or splice it from outside. */
  readonly elements: ElementItem[] = [];
  /** The elements by place (`elementsIn`): made when first asked, null after the whole list is replaced (as `treeGrid`). */
  private elementGrid: ItemGrid<ElementItem> | null = null;
  /** @rebuild The whole list filed only on the first ask after it was replaced whole; the writers keep it after. */
  private get elementCells(): ItemGrid<ElementItem> {
    if (!this.elementGrid) {
      this.elementGrid = new ItemGrid(LANDSCAPE_CELL);
      for (const e of this.elements) this.elementGrid.add(e);
    }
    return this.elementGrid;
  }

  /** The elements standing in the cells a rectangle reaches (a superset: test each). */
  elementsIn(rect: ChangeRect): ElementItem[] {
    if (this.below && this.sharedLists.has('elements')) return this.below.elementsIn(rect);
    return this.elementCells.near(rect);
  }

  /** What changed in this document, where and why (`changes.ts`) */
  readonly changes = new ChangeJournal();
  /** The document this one was copied from (`clone`) and that document's diary serial then */
  private forkedFrom: { readonly doc: RoadDoc; readonly version: number } | null = null;
  /** The document this one is a working copy OVER (`fork`) */
  private below: RoadDoc | null = null;
  /** The lists still the original's (`fork`): each copied the first time this copy writes it (`ownList`). */
  private sharedLists = new Set<DocListPart>();
  /** The indices by place still the original's (`fork`): copied when this copy first writes their kind (`ownIndex`). */
  private sharedIndices = new Set<IndexKind>();

  /** The document this working copy was made from (`clone`), while that one still stands as it was then */
  get forkOrigin(): RoadDoc | null {
    const fork = this.forkedFrom;
    return fork && fork.doc.changes.version === fork.version ? fork.doc : null;
  }

  /** The ids (of nodes and of segments: they share the roads' entries) the diary names in the road changes that turned */
  roadIdsChangedFrom(before: RoadDoc): Set<number> | null {
    const mine = this.forkedFrom, theirs = before.forkedFrom;
    let since: number | null = null;
    if (mine && mine.doc === before && mine.version === before.changes.version) since = mine.version;
    else if (theirs && theirs.doc === this && theirs.version === before.changes.version) since = theirs.version;
    else if (mine && theirs && mine.doc === theirs.doc && mine.version === theirs.version && theirs.version === before.changes.version) since = mine.version;
    return since === null ? null : this.changes.idsSince(since, ROAD_KINDS);
  }

  /** Modular buildings. */
  readonly buildings = new BuildingStore(this.changes);

  /** Authored land-use strokes, separate from the buildings they generated. */
  readonly zones: Zone[] = [];
  nextZoneId = 1;
  /** The zoned cells of the street grid (`world/zoneGrid.ts`), stored by place. */
  readonly zoneMarks: ZoneMark[] = [];
  /** The land's lots (`world/lots.ts`): the cadastre the player zones and edits, with its owner (`lotStore.ts`) */
  readonly lotStore = new LotStore(this.changes);

  constructor() {
    // A building or a lot made in a loaded tile takes its id from the tile's range, as every other record (`tileIdAt`).
    this.buildings.idAt = (at) => this.tileIdAt('building', at);
    this.lotStore.idAt = (at) => this.tileIdAt('lot', at);
  }
  /** @deprecated The lots as an array, in their order: made again after each change, for the readers that still walk the whole list */
  get lots(): readonly Lot[] {
    return this.lotStore.list();
  }
  /** The blocks and strips already cut into lots, so a lot deleted on purpose is not made again. */
  get lotKeys(): readonly string[] {
    return this.lotStore.keys;
  }
  /** The id the next lot gets. */
  get nextLotId(): number {
    return this.lotStore.nextId;
  }
  /** A lot by its id. */
  lot(id: number): Lot | undefined {
    return this.lotStore.get(id);
  }
  /** The lots whose box meets a rectangle (a superset: test each), in increasing id order. */
  lotsIn(rect: ChangeRect): Lot[] {
    return this.lotStore.in(rect);
  }
  /** The lot whose shape holds a point, or undefined. */
  lotAt(p: Vec2): Lot | undefined {
    return this.lotStore.at(p);
  }
  /** The open lots in order and by place, for the growth (`openLots.ts`): made when first asked, kept by the diary's entries by id. */
  private openLotsIndex: OpenLots | null = null;
  get openLots(): OpenLots {
    return this.openLotsIndex ??= new OpenLots({
      lots: this.lotStore,
      standing: (id) => this.buildings.has(id as BuildingId),
      place: (id) => { const b = this.buildings.get(id as BuildingId); return b ? { x: b.x, y: b.y } : null; },
      buildingsRevision: () => this.buildings.revision,
      buildingsSince: (serial) => this.changes.since(serial, ['buildings']),
    });
  }

  /** The zoning changed there (`zoneRevision`): the way in for the tools that change it in place */
  zonesChanged(rects: readonly ChangeRect[] | null, cause?: string): void {
    this.changes.record('zones', rects, cause ? { cause } : {});
  }

  /** The people made in the Person Creator, saved with the city. */
  readonly people: PersonSpec[] = [];

  /** Adds a person, or replaces the one with the same id. */
  savePerson(person: PersonSpec): void {
    this.ownList('people');
    const at = this.people.findIndex((p) => p.id === person.id);
    if (at >= 0) this.people[at] = person;
    else this.people.push(person);    this.changes.record('people', null, { ids: [person.id] });
  }

  removePerson(id: number): void {
    const at = this.people.findIndex((p) => p.id === id);
    if (at < 0) return;
    this.ownList('people');
    this.people.splice(at, 1);    this.changes.record('people', null, { ids: [id] });
  }

  /** An id no saved person has. */
  nextPersonId(): number {
    return this.people.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  }

  // ------------------------------------------------------------ revisions Each is the serial of the latest diary entry of

  /** The roads' geometry: every structural change; consumers use it to invalidate caches. */
  get revision(): number { return this.changes.serialOf('roads'); }
  /** Horizontal road and junction topology read by vehicles and pedestrians. */
  get trafficRevision(): number { return this.changes.serialOf('traffic'); }
  get terrainRevision(): number { return this.changes.serialOf('terrain'); }
  /** Pole and wire edits and the street landscaping, which do NOT move `revision` */
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
    const on = onWorld(at);
    const id = asPoleId(this.takeId('pole', on, this.poleIds));
    const pole: UtilityPole = { id, x: on.x, y: on.y, lamp };
    this.putPoleRecord(pole);
    this.changes.record('utilities', [rectAround([pole], ITEM_PAD)!], { ids: [id] });
    return pole;
  }

  /** The poles standing in the cells a rectangle reaches (`PoleIndex.near`): a superset, test each. */
  polesIn(rect: ChangeRect): UtilityPole[] {
    return this.poleIndex.near(rect).map((id) => this.poleMap.get(id)!);
  }

  /** The spans reaching a pole, in the order they were strung. */
  spansAt(id: PoleId): UtilitySpan[] {
    return [...this.poleIndex.spansAt(id)].map((sid) => this.spanMap.get(sid)!);
  }

  private putPoleRecord(pole: UtilityPole): void {
    this.ownIndex('poles');
    this.poleMap.set(pole.id, pole);
    this.poleIndex.putPole(pole);
  }

  private deletePoleRecord(id: PoleId): void {
    this.ownIndex('poles');
    this.poleMap.delete(id);
    this.poleIndex.deletePole(id);
  }

  private putSpanRecord(span: UtilitySpan): void {
    this.ownIndex('poles');
    const was = this.spanMap.get(span.id);
    this.spanMap.set(span.id, span);
    // The same ends: the span keeps its place in each pole's order, as in the map.
    if (was && was.a === span.a && was.b === span.b) return;
    if (was) this.poleIndex.deleteSpan(was);
    this.poleIndex.putSpan(span);
  }

  private deleteSpanRecord(id: SpanId): void {
    const was = this.spanMap.get(id);
    if (!was) return;
    this.ownIndex('poles');
    this.spanMap.delete(id);
    this.poleIndex.deleteSpan(was);
  }

  private clearPoleRecords(): void {
    this.poleMap.clear();
    this.spanMap.clear();
    // A working copy's index is the original's until it writes: a new one, never the shared one cleared.
    if (this.sharedIndices.delete('poles')) this.poleIndex = new PoleIndex();
    else this.poleIndex.clear();
  }

  /** Strings wire between two existing poles. Returns null for a degenerate run. */
  addPoleSpan(a: PoleId, b: PoleId): UtilitySpan | null {
    if (a === b) return null;
    if (!this.poles.has(a) || !this.poles.has(b)) return null;
    for (const existing of this.spansAt(a)) {
      if (existing.a === b || existing.b === b) return existing;
    }
    const id = asSpanId(this.takeId('span', this.poles.get(a)!, this.spanIds));
    const span: UtilitySpan = { id, a, b };
    this.putSpanRecord(span);
    this.changes.record('utilities', rectsAlong([this.poles.get(a)!, this.poles.get(b)!], ITEM_PAD), { ids: [a, b, id] });
    return span;
  }

  /** Draws a barrier along `points` (two or more, on the map). */
  addBarrier(kind: BarrierKind, points: readonly { x: number; y: number }[]): Barrier | null {
    const path = points.map((p) => onWorld(p));
    if (path.length < 2) return null;
    const barrier: Barrier = { id: this.takeId('barrier', path[0]!, this.barrierIds), kind, points: path.map((p) => ({ x: p.x, y: p.y })) };
    this.putBarrierRecord(barrier);
    this.changes.record('barriers', rectsAlong(barrier.points, ITEM_PAD), { ids: [barrier.id] });
    return barrier;
  }

  removeBarrier(id: number): boolean {
    const barrier = this.barriers.get(id);
    if (!barrier) return false;
    this.deleteBarrierRecord(id);
    this.changes.record('barriers', rectsAlong(barrier.points, ITEM_PAD), { ids: [id] });
    return true;
  }

  /** The barriers whose box reaches a rectangle (a superset: test each), in increasing id order. */
  /** The barriers whose box reaches any of `rects` (a superset: test each), each once, in increasing id order (`CellFiling.idsMeetingAny`). */
  barriersInAny(rects: readonly ChangeRect[]): Barrier[] {
    return this.barrierCells.idsMeetingAny(rects).map((id) => this.barrierMap.get(id)!);
  }

  barriersIn(rect: ChangeRect): Barrier[] {
    return this.barrierCells.idsMeeting(rect).map((id) => this.barrierMap.get(id)!);
  }

  /** A barrier put (new, or replacing the one of its id, which keeps its place in the map's order). */
  private putBarrierRecord(barrier: Barrier): void {
    this.ownIndex('barriers');
    this.barrierMap.set(barrier.id, barrier);
    this.barrierCells.file(barrier.id, barrier, rectAround(barrier.points)!);
  }

  private deleteBarrierRecord(id: number): void {
    this.ownIndex('barriers');
    this.barrierMap.delete(id);
    this.barrierCells.remove(id);
  }

  private clearBarrierRecords(): void {
    this.barrierMap.clear();
    if (this.sharedIndices.delete('barriers')) this.barrierCells = new CellFiling(LANDSCAPE_CELL);
    else this.barrierCells.copyFrom(new CellFiling(LANDSCAPE_CELL));
  }

  /** The barrier whose path passes nearest a point, within `radius`, or null: those round it only (`barriersIn`). */
  barrierNear(at: { x: number; y: number }, radius: number): Barrier | null {
    let best: Barrier | null = null;
    let bestD = radius;
    for (const barrier of this.barriersIn([at.x - radius, at.y - radius, at.x + radius, at.y + radius])) {
      for (let i = 1; i < barrier.points.length; i++) {
        const a = barrier.points[i - 1]!, b = barrier.points[i]!, q = at;
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
    return this.addLandscapeMany([{ kind, at, extra }])[0]!;
  }

  /** DO NOT place a batch item by item with `addLandscape` */
  addLandscapeMany(list: readonly { readonly kind: LandscapeKind; readonly at: { x: number; y: number };
    readonly extra?: { signType?: SignType; text?: string; planted?: number } }[]): LandscapeItem[] {
    const items = list.map(({ kind, at, extra = {} }) => {
      const on = onWorld(at);
      const text = extra.text?.slice(0, SIGN_TEXT_MAX);
      const item: LandscapeItem = { id: this.takeId('landscape', on, this.landscapeIds), kind, x: on.x, y: on.y,
        ...(extra.signType ? { signType: extra.signType } : {}), ...(text ? { text } : {}),
        ...(extra.planted !== undefined && Number.isFinite(extra.planted) ? { planted: extra.planted } : {}) };
      this.putLandscapeRecord(item);
      return item;
    });
    if (items.length) this.changes.record('landscape', items.map((item) => rectAround([item], ITEM_PAD)!), { ids: items.map((item) => item.id) });
    return items;
  }

  removeLandscape(id: number): boolean {
    const item = this.landscape.get(id);
    if (!item) return false;
    this.deleteLandscapeRecord(id);
    this.changes.record('landscape', [rectAround([item], ITEM_PAD)!], { ids: [id] });
    return true;
  }

  /** The street furniture standing in the cells a rectangle reaches (a superset: test each), in increasing id order. */
  landscapeIn(rect: ChangeRect): LandscapeItem[] {
    return this.landscapeCells.idsMeeting(rect).map((id) => this.landscapeMap.get(id)!);
  }

  /** The street furniture whose box reaches any of `rects`, each once, in increasing id order (`CellFiling.idsMeetingAny`). */
  landscapeInAny(rects: readonly ChangeRect[]): LandscapeItem[] {
    return this.landscapeCells.idsMeetingAny(rects).map((id) => this.landscapeMap.get(id)!);
  }

  /** A record put (new, or replacing the one of its id, which keeps its place in the map's order). */
  private putLandscapeRecord(item: LandscapeItem): void {
    this.ownIndex('landscape');
    const was = this.landscapeMap.get(item.id);
    if (was) this.countStreetName(was, -1);
    this.landscapeMap.set(item.id, item);
    this.landscapeCells.file(item.id, item, [item.x, item.y, item.x, item.y]);
    this.countStreetName(item, 1);
  }

  private deleteLandscapeRecord(id: number): void {
    const was = this.landscapeMap.get(id);
    if (!was) return;
    this.ownIndex('landscape');
    this.landscapeMap.delete(id);
    this.landscapeCells.remove(id);
    this.countStreetName(was, -1);
  }

  private countStreetName(item: LandscapeItem, by: 1 | -1): void {
    if (item.kind !== 'streetname' || !item.text) return;
    const n = (this.streetNameCount.get(item.text) ?? 0) + by;
    if (n > 0) this.streetNameCount.set(item.text, n); else this.streetNameCount.delete(item.text);
  }

  private clearLandscapeRecords(): void {
    this.landscapeMap.clear();
    if (this.sharedIndices.delete('landscape')) {
      this.landscapeCells = new CellFiling(LANDSCAPE_CELL);
      this.streetNameCount = new Map();
    } else {
      this.landscapeCells.copyFrom(new CellFiling(LANDSCAPE_CELL));
      this.streetNameCount.clear();
    }
  }

  /** Removes a pole and every wire that reached it. */
  removePole(id: PoleId): void {
    const pole = this.poles.get(id);
    if (!pole) return;
    const reached: { x: number; y: number }[] = [pole];
    // The pole and its spans by id (a reader by id: the undo image).
    const ids: number[] = [id];
    for (const span of this.spansAt(id)) {
      const other = this.poles.get(span.a === id ? span.b : span.a);
      if (other) reached.push(other);
      this.deleteSpanRecord(span.id);
      ids.push(span.id);
    }
    this.deletePoleRecord(id);
    this.changes.record('utilities', [rectAround(reached, ITEM_PAD)!], { ids });
  }

  /** The pole nearest a point, within `radius`, or null. */
  poleNear(at: { x: number; y: number }, radius: number): UtilityPole | null {
    let best: UtilityPole | null = null;
    let bestSq = radius * radius;
    for (const pole of this.polesIn([at.x - radius, at.y - radius, at.x + radius, at.y + radius])) {
      const dx = pole.x - at.x;
      const dy = pole.y - at.y;
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

  /** A node an edit may change, or undefined: DO NOT edit a copy of a node whose own tile is not loaded (a tile's edge node borrowed by a neighbour): the owner's record takes its place when that tile comes (`loadTile`), and the edit would be lost. */
  private editableNode(id: NodeId): RoadNode | undefined {
    const node = this.nodes.get(id);
    if (!node || this.tileContents.size === 0) return node;
    return this.tileContents.has(OWNER.node(node)) ? node : undefined;
  }

  /** Whether an edit may change the node (`editableNode`): the tools leave alone a node whose own tile is not loaded. */
  canEditNode(id: NodeId): boolean {
    return this.editableNode(id) !== undefined;
  }

  /** Whether a node is the map's edge: the end of one road, where traffic and people come in from outside and leave */
  mapEdge(id: NodeId): boolean {
    const node = this.nodes.get(id);
    return !!node && node.incident.length === 1 && node.end !== 'bulb';
  }

  // ---------------------------------------------------------------- mutation

  /** Adds a node, ON THE MAP. */
  addNode(p: Vec2, heightOffset = 0, smooth = false): RoadNode {
    const at = onWorld(p);
    const id = asNodeId(this.takeId('node', at, this.nodeIds));
    const n: RoadNode = { id, x: at.x, y: at.y, heightOffset, smooth,
      incident: [], control: 'auto', blockedMovements: [] };
    this.nodes.set(id, n);
    this.loose.add(id);
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
    const na = this.nodes.get(a)!, nb = this.nodes.get(b)!;
    const id = asSegmentId(this.takeId('segment', { x: (na.x + nb.x) / 2, y: (na.y + nb.y) / 2 }, this.segIds));
    const s: RoadSegment = {
      id, a, b, curve, type, dashOrigin, direction,
      lanes: normaliseLaneCount(lanes, direction),
      structure,
      ...(authoredSection ? { section: authoredSection } : {}),
      ...(authoredParking ? { parking: authoredParking } : {}),
    };
    this.segments.set(id, s);
    this.nodeToWrite(a)!.incident.push(id);
    this.nodeToWrite(b)!.incident.push(id);
    // A third road turns a mid-block crossing into a junction.
    for (const end of [a, b]) dropStaleCrossing(this.nodeToWrite(end));
    this.fitCurve(s);
    this.markSegment(id);
    return s;
  }

  removeSegment(id: SegmentId): void {
    const s = this.segments.get(id);
    if (!s) return;
    this.markSegment(id);
    detach(this.nodeToWrite(s.a), id);
    detach(this.nodeToWrite(s.b), id);
    this.loose.add(s.a);
    this.loose.add(s.b);
    // A turn ban naming a road that is gone bans nothing
    for (const end of [s.a, s.b]) {
      const n = this.nodeToWrite(end);
      if (!n) continue;
      for (let i = n.blockedMovements.length - 1; i >= 0; i--) {
        if (movementMentions(n.blockedMovements[i] as string, id)) n.blockedMovements.splice(i, 1);
      }
      dropStaleCrossing(n);
    }
    this.segments.delete(id);
  }

  /** Re-applies the turn bans `saved` at `node` that named segment `from`, naming `to` instead. */
  carryMovements(node: NodeId, saved: readonly string[], from: SegmentId, to: SegmentId): void {
    const n = this.nodeToWrite(node);
    if (!n) return;
    for (const key of saved) {
      if (!movementMentions(key, from)) continue;
      const [a, b] = key.split('>') as [string, string];
      const moved = `${a === String(from) ? to : a}>${b === String(from) ? to : b}`;
      if (!n.blockedMovements.includes(moved)) n.blockedMovements.push(moved);
    }
    // The geometry is the same; what moves is the plan the traffic runs on.
    this.changes.record('traffic', this.rectsOrMap(this.nodeRect(node)), { ids: [node], detail: 'turn bans carried' });
  }

  /** Re-applies a crossing `saved` at `node` that lay on segment `from` to the segment `to` that replaced it there */
  carryCrossing(node: NodeId, saved: NodeCrossing | undefined, from: SegmentId, to: SegmentId): void {
    if (!this.nodes.has(node) || !saved || saved.segment !== from) return;
    const n = this.nodeToWrite(node)!;
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
    this.roadsChanged(where, true, { nodes: [id], detail: 'node removed' });
  }

  /** Rewires every segment from `source` into `target`, then removes `source`. */
  mergeNodes(target: NodeId, source: NodeId): boolean {
    if (target === source) return true;
    const kept = this.nodes.get(target);
    const removed = this.nodes.get(source);
    if (!kept || !removed) return false;
    if (Math.abs(kept.heightOffset - removed.heightOffset) > 0.75) return false;
    const keep = this.nodeToWrite(target)!;
    const remove = this.nodeToWrite(source)!;

    if (keep.control === 'auto' && remove.control !== 'auto') keep.control = remove.control;
    for (const movement of remove.blockedMovements) {
      if (!keep.blockedMovements.includes(movement)) keep.blockedMovements.push(movement);
    }

    // Where the node that goes stood: its junction is gone from there.
    const gone = this.nodeRect(source);
    for (const id of remove.incident.slice()) {
      const segment = this.segments.get(id);
      if (!segment) continue;
      const other = segment.a === source ? segment.b : segment.a;
      // A road to the node being kept folds to nothing
      if (other === target || this.connects(target, other, segment.structure)) {
        this.removeSegment(id);
        continue;
      }
      const before = this.segmentRect(id);
      const moved = this.segmentToWrite(id)!;
      if (moved.a === source) moved.a = target;
      if (moved.b === source) moved.b = target;
      detach(remove, id);
      if (!keep.incident.includes(id)) keep.incident.push(id);
      this.markSegment(id, before);
    }
    this.nodes.delete(source);
    dropStaleCrossing(keep);
    this.markNode(target, true, gone ? [gone] : []);
    // The node that went, by id, for a reader by id (its rectangle is in the entry above).
    this.roadsChanged(gone ? [gone] : null, true, { nodes: [source], detail: 'node merged away' });
    return true;
  }

  /** Moves a node freely; junction geometry adapts to the resulting angle. */
  moveNode(id: NodeId, to: Vec2): boolean {
    const was = this.editableNode(id);
    if (!was) return false;
    // Dragging a node off the plate is the same offence as building one there, and is caught in the same place.
    const p = onWorld(to);
    if (was.x === p.x && was.y === p.y) return true;

    // DO NOT write only the rectangle after the move: whatever is derived where the node was
    const before = this.roadAreas(id);
    const n = this.nodeToWrite(id)!;
    n.x = p.x;
    n.y = p.y;
    for (const segId of n.incident) {
      const seg = this.segments.get(segId);
      if (seg) this.fitCurve(seg);
    }
    this.markNode(id, true, [...before, ...this.roadAreas(id)]);
    return true;
  }

  /** A node's junction and its roads' rectangles, as they stand now. */
  private roadAreas(id: NodeId): ChangeRect[] {
    const out: ChangeRect[] = [];
    const rect = this.nodeRect(id);
    if (rect) out.push(rect);
    for (const sid of this.nodes.get(id)?.incident ?? []) {
      const s = this.segmentRect(sid);
      if (s) out.push(s);
    }
    return out;
  }

  /** A curve is never tighter than its road is wide. */
  private fitCurve(s: RoadSegment): void {
    if (!s.curve) return;
    const a = this.nodes.get(s.a);
    const b = this.nodes.get(s.b);
    if (!a || !b) return;
    const fitted = fitRoadCurve(a, b, s.curve, s.type, s.lanes, s.direction, s.section, s.parking);
    if (fitted !== s.curve) {
      // `s` may be the original's record, read through by a working copy: the change goes to its own.
      this.segmentToWrite(s.id)!.curve = fitted;
      this.markSegment(s.id);
    }
  }

  // The setters below write where the road was as well as where it is (`markSegment`'s `before`)
  setSegmentType(id: SegmentId, type: number): void {
    const was = this.segments.get(id);
    if (!was || was.type === type) return;
    const before = this.segmentRect(id);
    const s = this.segmentToWrite(id)!;
    s.type = type;
    this.fitCurve(s);
    this.markSegment(id, before);
  }

  setSegmentCurve(id: SegmentId, curve: CurveShape | null): void {
    if (!this.segments.has(id)) return;
    const before = this.segmentRect(id);
    const s = this.segmentToWrite(id)!;
    s.curve = curve;
    this.fitCurve(s);
    this.markSegment(id, before);
  }

  setSegmentDirection(id: SegmentId, direction: SegmentDirection): void {
    const was = this.segments.get(id);
    if (!was || was.direction === direction) return;
    const before = this.segmentRect(id);
    const s = this.segmentToWrite(id)!;
    s.direction = direction;
    s.lanes = normaliseLaneCount(s.lanes, direction);
    this.fitCurve(s);
    this.markSegment(id, before);
  }

  setSegmentLanes(id: SegmentId, lanes: number | null): void {
    const was = this.segments.get(id);
    const next = normaliseLaneCount(lanes, was?.direction ?? 'both');
    if (!was || was.lanes === next) return;
    const before = this.segmentRect(id);
    const s = this.segmentToWrite(id)!;
    s.lanes = next;
    this.fitCurve(s);
    this.markSegment(id, before);
  }

  /** Changes every section consumer through the existing geometry/topology revision gates. */
  setSegmentSection(id: SegmentId, section?: RoadSection): void {
    const was = this.segments.get(id);
    const next = normalizeRoadSection(section);
    if (!was || (section !== undefined && !next) || sameRoadSection(was.section, next)) return;
    const before = this.segmentRect(id);
    const segment = this.segmentToWrite(id)!;
    if (next) segment.section = next;
    else delete segment.section;
    this.fitCurve(segment);
    this.markSegment(id, before);
  }

  /** Parking on the two sides of a segment; none on either side removes it. */
  setSegmentParking(id: SegmentId, parking?: SegmentParking): void {
    const was = this.segments.get(id);
    const next = normalizeParking(parking);
    if (!was || sameParking(was.parking, next)) return;
    const before = this.segmentRect(id);
    const segment = this.segmentToWrite(id)!;
    if (next) segment.parking = next;
    else delete segment.parking;
    this.fitCurve(segment);
    this.markSegment(id, before);
  }

  /** Retaining walls on the sides of the road's cutting (`RoadSegment.cutWalls`). */
  setSegmentCutWalls(id: SegmentId, on: boolean): void {
    const was = this.segments.get(id);
    if (!was || (was.cutWalls === true) === on) return;
    const segment = this.segmentToWrite(id)!;
    if (on) segment.cutWalls = true;
    else delete segment.cutWalls;
    this.markSegment(id);
  }

  /** The player's lane connections at a node; undefined or empty: all derived (`RoadNode.laneLinks`). */
  setNodeLaneLinks(id: NodeId, links: readonly LaneLink[] | undefined): void {
    const was = this.editableNode(id);
    if (!was) return;
    const next = normalizeLaneLinks(links);
    if (linksDigest(was.laneLinks) === linksDigest(next)) return;
    const node = this.nodeToWrite(id)!;
    if (next) node.laneLinks = next;
    else delete node.laneLinks;
    this.markNode(id);
  }

  /** The regional standard of the road paint: every road painted again. */
  setMarkingStyle(style: MarkingStyleId): void {
    if (this.markingStyle === style) return;
    this.markingStyle = style;
    // DO NOT write it as a change of the roads again
    this.changes.record('markingStyle', null, { detail: 'paint style' });
  }

  /** A U-turn through the median for the traffic arriving from `from` (`RoadNode.uturn`), or none. */
  setNodeUturn(id: NodeId, from: SegmentId | undefined): void {
    const was = this.editableNode(id);
    if (!was || was.uturn === from) return;
    const node = this.nodeToWrite(id)!;
    if (from !== undefined) node.uturn = from;
    else delete node.uturn;
    this.markNode(id);
  }

  /** What a road's end is (`RoadNode.end`): a turning circle, or (undefined) the map's edge. */
  setNodeEnd(id: NodeId, end: RoadEnd | undefined): void {
    const was = this.editableNode(id);
    if (!was || was.end === end) return;
    const node = this.nodeToWrite(id)!;
    if (end) node.end = end;
    else delete node.end;
    this.markNode(id);
  }

  /** Each leg's rule at a junction (`RoadNode.approachRules`); undefined: all derived. */
  setNodeApproachRules(id: NodeId, rules: readonly ApproachRuleEntry[] | undefined): void {
    const was = this.editableNode(id);
    if (!was) return;
    const next = normalizeApproachRules(rules);
    if (rulesDigest(was.approachRules) === rulesDigest(next)) return;
    const node = this.nodeToWrite(id)!;
    if (next) node.approachRules = next;
    else delete node.approachRules;
    this.markNode(id);
  }

  /** A signal's settings (`RoadNode.signal`); undefined: adaptive with the game's timings. */
  setNodeSignal(id: NodeId, signal: SignalSettings | undefined): void {
    const was = this.editableNode(id);
    if (!was) return;
    const next = normalizeSignalSettings(signal);
    if (signalDigest(was.signal) === signalDigest(next)) return;
    const node = this.nodeToWrite(id)!;
    if (next) node.signal = next;
    else delete node.signal;
    this.markNode(id);
  }

  setSegmentStructure(id: SegmentId, structure: RoadStructure): void {
    const was = this.segments.get(id);
    if (!was || was.structure === structure) return;
    this.segmentToWrite(id)!.structure = structure;
    this.markSegment(id);
  }

  setNodeHeightOffset(id: NodeId, heightOffset: number): void {
    const was = this.editableNode(id);
    if (!was || !Number.isFinite(heightOffset) || was.heightOffset === heightOffset) return;
    const junctionModeChanged = (was.heightOffset < -TUNNEL_HEADROOM) !==
      (heightOffset < -TUNNEL_HEADROOM);
    this.nodeToWrite(id)!.heightOffset = heightOffset;
    this.markNode(id, junctionModeChanged);
  }

  /** Gives the map an ecosystem (or takes it away: null). */
  setNature(next: NatureSettings | null): void {
    if (JSON.stringify(this.nature) === JSON.stringify(next)) return;
    this.nature = next ? { ...next } : null;    this.changes.record('nature', null);
  }

  /** Each tile's count of a capped list's items (by `OWNER`), counted from the list when first asked. */
  private tileCountsOf(part: CappedPart): Map<number, number> {
    let counts = this.capCounts.get(part);
    if (!counts) {
      counts = new Map();
      for (const item of this.listOf(part) as readonly { x: number; y: number }[]) {
        const key = OWNER.at(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      this.capCounts.set(part, counts);
    }
    return counts;
  }

  /** The items of `items` their tiles have room for (`TILE_CAPS`), in order: DO NOT take an old item away to make room - the player's work is never deleted, the new item is refused (the caller says so). */
  private withRoom<T extends { readonly x: number; readonly y: number }>(part: CappedPart, items: readonly T[]): { readonly taken: T[]; readonly counts: Map<number, number> } {
    const counts = this.tileCountsOf(part);
    const cap = TILE_CAPS[part];
    const taken: T[] = [];
    for (const item of items) {
      const key = OWNER.at(item), n = counts.get(key) ?? 0;
      if (n >= cap) continue;
      counts.set(key, n + 1);
      taken.push(item);
    }
    return { taken, counts };
  }

  /** The counts kept through the list's own write (`ownList` lets them go): the add counted its items already. */
  private keepCounts(part: CappedPart, counts: Map<number, number>): void {
    this.capCounts.set(part, counts);
  }

  // DO NOT write `null` (the whole map) for it: on a map at the cap every dab, stamp or tree laid the whole map again.
  /** False: its tile holds as many dabs as it may (`TILE_CAPS`), nothing laid. */
  addPaintDab(dab: PaintDab): boolean {
    const { taken, counts } = this.withRoom('terrainPaint', [dab]);
    if (!taken.length) return false;
    this.ownList('terrainPaint');
    this.terrainPaint.push({ ...dab });
    this.keepCounts('terrainPaint', counts);
    this.changes.record('paint', [circleRect(dab)]);
    return true;
  }

  /** False: its tile is full, nothing laid. */
  addFogDab(dab: FogDab): boolean {
    const { taken, counts } = this.withRoom('fogDabs', [dab]);
    if (!taken.length) return false;
    this.ownList('fogDabs');
    this.fogDabs.push({ ...dab });
    this.keepCounts('fogDabs', counts);
    this.changes.record('fog', [circleRect(dab)]);
    return true;
  }

  /** False: its tile is full, nothing laid. */
  addGullyDab(dab: GullyDab): boolean {
    const { taken, counts } = this.withRoom('gullyDabs', [dab]);
    if (!taken.length) return false;
    this.ownList('gullyDabs');
    this.gullyDabs.push({ ...dab });
    this.keepCounts('gullyDabs', counts);
    this.changes.record('gullies', [circleRect(dab)]);
    return true;
  }

  // A list cleared is written where its items lay (one box round them all), not as the whole map
  clearGullies(): void {
    if (this.gullyDabs.length === 0) return;
    this.ownList('gullyDabs');
    const where = circlesBox(this.gullyDabs);
    this.gullyDabs.length = 0;
    this.changes.record('gullies', where);
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

  /** How many were planted: those of a full tile (`TILE_CAPS`) are refused, none taken away for them. */
  plantTrees(trees: readonly PlantedTree[]): number {
    if (trees.length === 0) return 0;
    const { taken, counts } = this.withRoom('trees', trees);
    if (!taken.length) return 0;
    this.ownList('trees');
    for (const t of taken) { const tree = { ...t }; this.trees.push(tree); this.treeGrid?.add(tree); }
    this.keepCounts('trees', counts);
    this.changes.record('trees', [rectAround(taken, ITEM_PAD)!]);
    return taken.length;
  }

  /** Cuts the trees away within `radius` of (x, y); false (nothing cut): its tile holds as many clearings as it may (`TILE_CAPS`). */
  cutTrees(x: number, y: number, radius: number): boolean {
    const { taken, counts } = this.withRoom('treeClearings', [{ x, y }]);
    if (!taken.length) return false;
    this.ownList('trees');
    this.ownList('treeClearings');
    const before = this.trees.length;
    // DO NOT splice each one out (trees x trees cut), nor walk every tree of the map for each dab of the brush.
    const there = new Set(this.treeCells.near([x - radius, y - radius, x + radius, y + radius]).filter((t) => Math.hypot(t.x - x, t.y - y) <= radius));
    if (there.size) keepWhere(this.trees, (t) => !there.has(t));
    for (const t of there) this.treeCells.remove(t);
    if (this.trees.length !== before) this.changes.record('trees', [circleRect({ x, y, radius })], { detail: `${before - this.trees.length} cut` });
    this.treeClearings.push({ x, y, radius });
    this.keepCounts('treeClearings', counts);
    this.changes.record('clearings', [circleRect({ x, y, radius })]);
    return true;
  }

  /** Every planted tree gone, and every clearing grown over again. */
  clearTrees(): void {
    if (this.trees.length > 0) {
      this.ownList('trees');
      const where = rectAround(this.trees, ITEM_PAD)!;
      this.trees.length = 0;
      this.treeGrid = null;
      this.changes.record('trees', [where]);
    }
    if (this.treeClearings.length > 0) {
      this.ownList('treeClearings');
      const where = circlesBox(this.treeClearings);
      this.treeClearings.length = 0;
      this.changes.record('clearings', where);
    }
  }

  /** How many were laid: those of a full tile (`TILE_CAPS`) are refused, none taken away for them. */
  addElements(items: readonly ElementItem[]): number {
    if (items.length === 0) return 0;
    const { taken, counts } = this.withRoom('elements', items);
    if (!taken.length) return 0;
    this.ownList('elements');
    for (const item of taken) { this.elements.push(item); this.elementGrid?.add(item); }
    this.keepCounts('elements', counts);
    this.changes.record('elements', [elementsBox(taken)!]);
    return taken.length;
  }

  /** Takes away the elements within `radius` of (x, y) - of one kind, or every kind (`kind` null). How many went. */
  removeElements(x: number, y: number, radius: number, kind: ElementKind | null): number {
    this.ownList('elements');
    // The ones there, by place; the list then kept in one pass without them.
    const there = new Set(this.elementCells.near([x - radius, y - radius, x + radius, y + radius])
      .filter((e) => (kind === null || e.kind === kind) && Math.hypot(e.x - x, e.y - y) <= radius));
    const before = this.elements.length;
    if (there.size) keepWhere(this.elements, (e) => !there.has(e));
    for (const e of there) this.elementCells.remove(e);
    const gone = before - this.elements.length;
    if (gone > 0) {      this.changes.record('elements', [circleRect({ x, y, radius })]);
    }
    return gone;
  }

  /** Takes away these elements (the very items), in one pass; how many went. */
  removeElementItems(items: ReadonlySet<ElementItem>): number {
    if (items.size === 0) return 0;
    this.ownList('elements');
    const before = this.elements.length;
    keepWhere(this.elements, (e) => !items.has(e));
    for (const e of items) this.elementGrid?.remove(e);
    const gone = before - this.elements.length;
    if (gone > 0) this.changes.record('elements', [elementsBox([...items])!]);
    return gone;
  }

  clearElements(): void {
    if (this.elements.length === 0) return;
    this.ownList('elements');
    const where = elementsBox(this.elements)!;
    this.elements.length = 0;
    this.elementGrid = null;
    this.changes.record('elements', [where]);
  }

  /** A new cloud; null when the sky already holds as many as it may. */
  addCloud(value: Omit<PlacedCloud, 'id'>): PlacedCloud | null {
    if (this.clouds.length >= MAX_PLACED_CLOUDS) return null;
    this.ownList('clouds');
    const id = this.clouds.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    const cloud = placedCloud(value, id);
    this.clouds.push(cloud);    this.changes.record('clouds', [rectAround([cloud], cloud.size)!], { ids: [id] });
    return cloud;
  }

  /** Several clouds at once, as many as the sky has room for: how many were added. */
  addClouds(values: readonly Omit<PlacedCloud, 'id'>[]): number {
    this.ownList('clouds');
    let id = this.clouds.reduce((m, c) => Math.max(m, c.id), 0);
    let added = 0;
    for (const value of values) {
      if (this.clouds.length >= MAX_PLACED_CLOUDS) break;
      this.clouds.push(placedCloud(value, ++id));
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
    this.ownList('clouds');
    const was = this.clouds[i]!;
    const now = { ...was, ...change, id };
    this.clouds[i] = now;    this.changes.record('clouds', [rectAround([was, now], Math.max(was.size, now.size))!], { ids: [id] });
  }

  removeCloud(id: number): void {
    const i = this.clouds.findIndex((c) => c.id === id);
    if (i < 0) return;
    this.ownList('clouds');
    const [was] = this.clouds.splice(i, 1);    this.changes.record('clouds', [rectAround([was!], was!.size)!], { ids: [id] });
  }

  clearFog(): void {
    if (this.fogDabs.length === 0) return;
    this.ownList('fogDabs');
    const where = circlesBox(this.fogDabs);
    this.fogDabs.length = 0;
    this.changes.record('fog', where);
  }

  setFogSettings(next: Partial<FogSettings>): void {
    const merged = readFogSettings({ ...this.fogSettings, ...next });
    if (JSON.stringify(merged) === JSON.stringify(this.fogSettings)) return;
    this.fogSettings = merged;    this.changes.record('fog', null);
  }

  clearPaint(): void {
    if (this.terrainPaint.length === 0) return;
    this.ownList('terrainPaint');
    const where = circlesBox(this.terrainPaint);
    this.terrainPaint.length = 0;
    this.changes.record('paint', where);
  }

  /** The stamp laid; null: its tile holds as many as it may (`TILE_CAPS`), the land left as it is (DO NOT drop the oldest: the relief sculpted first went away). */
  addTerrainStamp(value: Omit<TerrainStamp, 'id'>): TerrainStamp | null {
    const { taken, counts } = this.withRoom('terrainStamps', [value]);
    if (!taken.length) return null;
    this.ownList('terrainStamps');
    const stamp: TerrainStamp = { ...value, id: this.nextTerrainId++ };
    this.terrainStamps.push(stamp);
    this.keepCounts('terrainStamps', counts);
    this.changes.record('terrain', [circleRect(stamp)], { ids: [stamp.id] });
    return stamp;
  }

  clearTerrain(): void {
    if (this.terrainStamps.length === 0) return;
    this.ownList('terrainStamps');
    const where = circlesBox(this.terrainStamps);
    const ids = this.terrainStamps.map((s) => s.id);
    this.terrainStamps.length = 0;
    this.changes.record('terrain', where, { ids });
  }

  setNodeControl(id: NodeId, control: JunctionControl): void {
    const was = this.editableNode(id);
    if (!was || was.control === control) return;
    this.nodeToWrite(id)!.control = control;
    this.markNode(id);
  }

  /** Puts a mid-block pedestrian crossing on a two-road node, painted on `segment`. */
  setNodeCrossing(id: NodeId, kind: NodeCrossingKind, segment: SegmentId): boolean {
    const was = this.editableNode(id);
    if (!was || was.incident.length !== 2 || !was.incident.includes(segment)) return false;
    const n = this.nodeToWrite(id)!;
    n.crossing = { kind, segment };
    n.control = kind === 'signal' ? 'signal' : 'priority';
    this.markNode(id);
    return true;
  }

  /** Removes a node's mid-block crossing; the node goes back to `auto`. */
  clearNodeCrossing(id: NodeId): void {
    if (!this.editableNode(id)?.crossing) return;
    const n = this.nodeToWrite(id)!;
    delete n.crossing;
    n.control = 'auto';
    this.markNode(id);
  }

  setMovementBlocked(id: NodeId, from: SegmentId, to: SegmentId, blocked: boolean): void {
    const was = this.editableNode(id);
    if (!was || from === to) return;
    const key = movementKey(from, to);
    const index = was.blockedMovements.indexOf(key);
    if (blocked && index < 0) this.nodeToWrite(id)!.blockedMovements.push(key);
    else if (!blocked && index >= 0) this.nodeToWrite(id)!.blockedMovements.splice(index, 1);
    else return;
    this.markNode(id);
  }

  /** DO NOT walk every node of the map for it: every road taken away ends here. */
  pruneOrphanNodes(): number {
    const rects: ChangeRect[] = [];
    const ids: number[] = [];
    // In id order, as the walk over the map met them.
    for (const id of this.loose.sorted()) {
      const n = this.nodes.get(id);
      if (!n || n.incident.length !== 0) continue;
      // Its rectangle before it goes: DO NOT write `null` (the whole map) for a few loose nodes
      const rect = this.nodeRect(id);
      if (rect) rects.push(rect);
      ids.push(id);
      this.nodes.delete(id);
    }
    this.loose.clear();
    if (ids.length) this.roadsChanged(rects, true, { nodes: ids, detail: `${ids.length} loose nodes dropped` });
    return ids.length;
  }

  // ------------------------------------------------------------ change marking

  /** DO NOT bring them back: what changed is the diary's to say. */
  markNode(id: NodeId, traffic = true, also: readonly ChangeRect[] = []): void {
    // Every real edit is written, even of a node edited before: the diary is the mutation clock
    const rect = this.nodeRect(id);
    const rects = rect ? [rect, ...also] : also;
    this.roadsChanged(rects.length ? rects : null, traffic, { nodes: [id] });
  }

  /** DO NOT write only the segment's rectangle: what is derived round a junction would keep the old mouths. */
  markSegment(id: SegmentId, before: ChangeRect | null = null): void {
    const rects: ChangeRect[] = [];
    const rect = this.segmentRect(id);
    if (rect) rects.push(rect);
    if (before) rects.push(before);
    const s = this.segments.get(id);
    if (s) for (const end of [s.a, s.b]) { const r = this.nodeRect(end); if (r) rects.push(r); }
    // With its two ends: their records (`incident`) change with it, and a reader by id
    this.roadsChanged(rects.length ? rects : null, true, { segments: [id], nodes: s ? [s.a, s.b] : [] });
  }

  /** A rectangle as the diary takes it: itself, or the whole map when there is none. */
  private rectsOrMap(rect: ChangeRect | null): readonly ChangeRect[] | null {
    return rect ? [rect] : null;
  }

  /** The roads changed there: their geometry */
  /** `nodes`, `segments`: what it touched, told apart (an id may name a node and a segment of one tile); `ids` their union, as every other kind writes them. */
  private roadsChanged(rects: readonly ChangeRect[] | null, traffic: boolean, touched: { readonly nodes?: readonly number[]; readonly segments?: readonly number[]; readonly detail?: string } = {}): void {
    const nodes = touched.nodes ?? [], segments = touched.segments ?? [];
    const extra = {
      ...(nodes.length || segments.length ? { ids: [...new Set([...segments, ...nodes])], nodes: [...new Set(nodes)], segments: [...new Set(segments)] } : {}),
      ...(touched.detail ? { detail: touched.detail } : {}),
    };
    const roads = this.changes.record('roads', rects, extra);
    if (traffic) this.changes.record('traffic', rects, { ...extra, parent: roads });
  }

  // ------------------------------------------------------------ tiles (CLAUDE.md, "Streaming world")

  /** The tiles in this document (the active region, CLAUDE.md "Streaming world"): the page holds the tiles near the camera, never the world. */
  private tileContents = new Set<number>();
  /** Each loaded tile's buildings' gates (`TileRecords.gates`) while no building of it changed: written back as they are, not worked out again from every building at each write (`tileRecords`). */
  private readonly tileGates = new Map<number, readonly number[]>();
  /** The buildings' diary as the gates last read it: an entry over a tile lets its gates go. */
  private readonly gatesCursor = new JournalCursor(['buildings']);
  /** How many items of each capped list each tile holds (`TILE_CAPS`), counted when first asked; let go whenever the list is written otherwise than by its add. */
  private readonly capCounts = new Map<CappedPart, Map<number, number>>();
  /** Each tile's nodes, roads, land keys and dabs, kept by the diary (`tileIndex.ts`): a tile's members read without walking the region. */
  private readonly tileIndex = ((doc: RoadDoc) => new TileIndex({
    get changes() { return doc.changes; },
    get nodes() { return doc.nodes; },
    get segments() { return doc.segments; },
    get lotKeyList() { return doc.lotStore.keys; },
    get paintList() { return doc.terrainPaint; },
  }, lotKeyPlace))(this);
  /** Each loaded tile's next ids, by kind (`TileRecords.next`): a record made in a tile takes its id from the tile's range. */
  private tileNext = new Map<number, TileNext>();
  /** Each loaded tile's grown rows (`TileRecords.grown`, kept by `preparedGrown`), and its lots as they were put in: a row is written back only while its lot is that very record (an edit replaces it). */
  private tileGrown = new Map<number, { readonly grown: PreparedGrown; readonly lots: ReadonlyMap<number, Lot> }>();

  /** Whether an edit is open (`beginEdit`..`endEdit`): no tile comes in or goes out then. */
  get editing(): boolean {
    return this.recorder !== null;
  }

  /** The tiles in this document now. */
  get loadedTiles(): ReadonlySet<number> {
    return this.tileContents;
  }

  /** Whether a tile is in this document. */
  hasTile(key: number): boolean {
    return this.tileContents.has(key);
  }

  /** A new record's id: from the range of the loaded tile it stands in (`tileIdBase`), so it never meets an id of a tile not on the page; a map's own allocator where no tile is loaded (a map from before the tiles). */
  private takeId(kind: keyof TileNext, at: { readonly x: number; readonly y: number }, legacy: IdAllocator): number {
    const key = OWNER.at(at);
    const next = this.tileContents.has(key) ? this.tileNext.get(key) : undefined;
    if (!next) return legacy.take();
    const id = next[kind]++;
    if (id >= tileIdBase(key) + TILE_COUNTED) throw new Error(`tile ${key} has no ${kind} id left`);
    return id;
  }

  /** The id a building or a lot made at a place takes (`BuildingStore`, `LotStore`): a loaded tile's, or null for the store's own allocator. */
  tileIdAt(kind: 'building' | 'lot', at: { readonly x: number; readonly y: number }): number | null {
    const key = OWNER.at(at);
    const next = this.tileContents.has(key) ? this.tileNext.get(key) : undefined;
    if (!next) return null;
    const id = next[kind]++;
    if (id >= tileIdBase(key) + TILE_COUNTED) throw new Error(`tile ${key} has no ${kind} id left`);
    return id;
  }

  /** A tile's records put in (`world/tiles.ts` TileRecords): read and checked as a map is (`fromJSON`), moved in, one diary entry per kind with the tile's square and the ids (cause `TILE_LOADED`)
   *  - its roads join the nodes already here (a neighbour's on the edge), its borrowed ends come in only while their own tile is not here. Never during an edit (`beginEdit`). */
  loadTile(records: TileRecords): void {
    if (this.tileContents.has(records.key)) return;
    if (this.recorder) throw new Error('a tile cannot come in during an edit');
    const owned = new Set(records.nodes.map((n) => n.id));
    const ownedPoles = new Set(records.poles.map((p) => p.id));
    // DO NOT read the tile into a document of its own first (`fromJSON` into a throwaway, every record copied again): its records read straight here.
    // Its nodes and roads as the tile alone has them: a crossing is judged on the tile's own roads, as a stored map of it would be.
    const pieceNodes = new Map<NodeId, RoadNode>();
    const storedNodes = [...records.nodes, ...records.borrowedNodes.filter((n) => !owned.has(n.id))];
    for (const n of storedNodes) if (!pieceNodes.has(asNodeId(n.id))) pieceNodes.set(asNodeId(n.id), nodeRecord(n, n));
    const pieceSegments = new Map<SegmentId, RoadSegment>();
    for (const s of records.segments) {
      const a = asNodeId(s.a), b = asNodeId(s.b);
      if (!pieceNodes.has(a) || !pieceNodes.has(b) || a === b) continue;
      const segment = segmentRecord(s, a, b);
      pieceSegments.set(segment.id, segment);
      pieceNodes.get(a)!.incident.push(segment.id);
      pieceNodes.get(b)!.incident.push(segment.id);
    }
    for (const n of storedNodes) finishNode(pieceNodes.get(asNodeId(n.id))!, n);
    const { i, j } = tileOfKey(records.key);
    const square = tileRect(i, j);
    const tile = { nodes: [] as NodeId[], borrowedNodes: [] as NodeId[], segments: [] as SegmentId[] };
    const cause = this.changes.cause;
    this.changes.causeNext(TILE_LOADED);
    const nodeIds: number[] = [], segmentIds: number[] = [];
    const rects: ChangeRect[] = [square];
    // The nodes: an owner's record takes the place of a borrowed copy (its incident roads kept); a borrowed one comes in only if absent.
    for (const [id, node] of pieceNodes) {
      const here = this.nodes.get(id);
      if (owned.has(id)) {
        tile.nodes.push(id);
        this.nodes.set(id, { ...node, incident: here ? here.incident : [] });
      } else {
        tile.borrowedNodes.push(id);
        if (here) continue;
        this.nodes.set(id, { ...node, incident: [] });
      }
      nodeIds.push(id);
      const r = this.nodeRect(id);
      if (r) rects.push(r);
    }
    for (const [id, segment] of pieceSegments) {
      if (this.segments.has(id)) continue;
      this.segments.set(id, segment);
      this.nodeToWrite(segment.a)!.incident.push(id);
      this.nodeToWrite(segment.b)!.incident.push(id);
      tile.segments.push(id);
      segmentIds.push(id);
      // Its ends named too: a junction already here (a neighbour's edge node) gains a leg and is built again.
      nodeIds.push(segment.a, segment.b);
    }
    for (const id of [...tile.nodes, ...tile.borrowedNodes]) if (this.requireNode(id).incident.length === 0) this.loose.add(id);
    if (nodeIds.length || segmentIds.length) this.roadsChanged(rects, true, { nodes: nodeIds, segments: segmentIds, detail: 'tile' });
    // The utilities: borrowed poles as the nodes.
    const utilityIds: number[] = [];
    const piecePoles = new Map<PoleId, UtilityPole>();
    for (const p of [...records.poles, ...records.borrowedPoles.filter((q) => !ownedPoles.has(q.id))]) {
      if (!piecePoles.has(asPoleId(p.id))) piecePoles.set(asPoleId(p.id), { id: asPoleId(p.id), x: p.x, y: p.y, lamp: p.lamp ?? false });
    }
    for (const [id, pole] of piecePoles) {
      if (ownedPoles.has(id) || !this.poleMap.has(id)) { this.putPoleRecord(pole); utilityIds.push(id); }
    }
    for (const sp of records.poleSpans) {
      const a = asPoleId(sp.a), b = asPoleId(sp.b), id = asSpanId(sp.id);
      // A span whose poles did not come is dropped rather than put in as a wire hanging off nothing.
      if (!piecePoles.has(a) || !piecePoles.has(b) || this.spanMap.has(id)) continue;
      this.putSpanRecord({ id, a, b });
      utilityIds.push(id);
    }
    if (utilityIds.length) this.changes.record('utilities', [square], { ids: utilityIds });
    const landscapeIds: number[] = [];
    for (const raw of records.landscape) { const item = landscapeRecord(raw, false); if (item) { this.putLandscapeRecord(item); landscapeIds.push(item.id); } }
    if (landscapeIds.length) this.changes.record('landscape', [square], { ids: landscapeIds });
    const barrierIds: number[] = [];
    for (const raw of records.barriers) { const barrier = barrierRecord(raw, false); if (barrier) { this.putBarrierRecord(barrier); barrierIds.push(barrier.id); } }
    if (barrierIds.length) this.changes.record('barriers', [square], { ids: barrierIds });
    // The buildings and the lots, each in one entry of its own store: a prepared tile's buildings as they are (read from its table), another's migrated.
    const prepared = preparedTiles.has(records);
    const buildings = prepared ? records.buildings as unknown as readonly Building[] : migratedBuildings(records.buildings);
    this.buildings.placeAll(buildings, prepared);
    const lotIds = new Set<number>();
    const lots: Lot[] = [];
    for (const lot of records.lots) {
      if (!isLot(lot) || lotIds.has(lot.id)) continue;
      lotIds.add(lot.id);
      lots.push(lotRecord(lot, (id) => this.buildings.has(id as BuildingId)));
    }
    this.lotStore.restore(lots.map((lot) => ({ id: lot.id, value: lot })), TILE_LOADED);
    this.lotStore.addKeys(records.lotKeys, records.lotKeys.map(() => square), TILE_LOADED);
    // The lists: put after the rest, each item kept to be found again.
    const paint: PaintDab[] = [];
    for (const dab of records.paint) {
      if (isPaintKind(dab.kind) && [dab.x, dab.y, dab.radius, dab.strength].every(Number.isFinite)) paint.push({ kind: dab.kind, x: dab.x, y: dab.y, radius: dab.radius, strength: dab.strength });
    }
    if (paint.length) { this.ownList('terrainPaint'); for (const dab of paint) this.terrainPaint.push(dab); this.changes.record('paint', [square]); }
    const trees = records.trees.map(readPlantedTree).filter((t): t is PlantedTree => t !== null);
    if (trees.length) {
      this.ownList('trees');
      for (const t of trees) { this.trees.push(t); this.treeGrid?.add(t); }
      this.changes.record('trees', [square]);
    }
    const elements = records.elements.map(readElement).filter((e): e is ElementItem => e !== null);
    if (elements.length) {
      this.ownList('elements');
      for (const e of elements) { this.elements.push(e); this.elementGrid?.add(e); }
      this.changes.record('elements', [square]);
    }
    this.tileContents.add(records.key);
    this.tileNext.set(records.key, tileNextOf(records));
    // The gates it came with stand for its buildings until one changes (the diary, `tileGatesOf`).
    this.followGates();
    if (records.gates) this.tileGates.set(records.key, records.gates); else this.tileGates.delete(records.key);
    const grown = preparedTiles.get(records);
    if (grown) this.tileGrown.set(records.key, { grown, lots: new Map(lots.map((lot) => [lot.id, this.lot(lot.id)!])) });
    else this.tileGrown.delete(records.key);
    this.changes.causeNext(cause);
  }

  /** A tile's gates: those kept while none of its buildings changed, else worked out from them now and kept. */
  private tileGatesOf(key: number, buildings: readonly Building[]): readonly number[] {
    this.followGates();
    let gates = this.tileGates.get(key);
    if (!gates) { gates = gatesOf(buildings); this.tileGates.set(key, gates); }
    return gates;
  }

  /** The buildings' diary since the gates last read it: each tile an edit reached lets its gates go (a tile put in or let go reaches no other's buildings). */
  private followGates(): void {
    const entries = this.gatesCursor.read(this.changes);
    if (entries === null) { this.tileGates.clear(); return; }
    for (const entry of entries) {
      if (isStreaming(entry)) continue;
      if (entry.rects === null) { this.tileGates.clear(); return; }
      for (const [x0, y0, x1, y1] of entry.rects) {
        for (let i = Math.floor(x0 / TILE); i <= Math.floor(x1 / TILE); i++) {
          for (let j = Math.floor(y0 / TILE); j <= Math.floor(y1 / TILE); j++) this.tileGates.delete(tileKey(i, j));
        }
      }
    }
  }

  /** The streamed world closed (`main.ts` afterStreamedWorld): no tile is held any more, and no id is taken from a tile's range; the records stay until the document is replaced. */
  leaveTiles(): void {
    if (this.recorder) throw new Error('the tiles cannot be left during an edit');
    this.tileContents.clear();
    this.tileNext.clear();
    this.tileGrown.clear();
    this.tileGates.clear();
  }

  /** What a tile holds now, by `OWNER` (what the player added or moved there included): read off the page's document, which holds the active region only, so bounded by it, never by the world */
  private tileMembers(key: number): TileMembers {
    const { i, j } = tileOfKey(key);
    const square = tileRect(i, j);
    const mine = (p: { readonly x: number; readonly y: number }): boolean => OWNER.at(p) === key;
    const nodes: RoadNode[] = [], segments: RoadSegment[] = [], borrowed = new Map<NodeId, RoadNode>();
    // The tile's own, by id (`tileIndex.ts`), in id order: DO NOT walk every node and road of the region for one tile.
    const filed = this.tileIndex.roadsOf(key);
    for (const id of [...filed.nodes].sort((p, q) => p - q)) { const node = this.nodes.get(id as NodeId); if (node) nodes.push(node); }
    for (const id of [...filed.segments].sort((p, q) => p - q)) {
      const s = this.segments.get(id as SegmentId);
      const a = s && this.nodes.get(s.a), b = s && this.nodes.get(s.b);
      if (!s || !a || !b) continue;
      segments.push(s);
      for (const end of [a, b]) if (OWNER.node(end) !== key) borrowed.set(end.id, end);
    }
    const poles = this.polesIn(square).filter(mine);
    // A span by the middle of its poles (`OWNER.span`): one near the edge may end on a pole of the next tile, borrowed.
    const spans: UtilitySpan[] = [];
    const borrowedPoles = new Map<PoleId, UtilityPole>();
    const seen = new Set<SpanId>();
    for (const near of this.polesIn([square[0] - SPAN_REACH, square[1] - SPAN_REACH, square[2] + SPAN_REACH, square[3] + SPAN_REACH])) {
      for (const span of this.spansAt(near.id)) {
        if (seen.has(span.id)) continue;
        seen.add(span.id);
        const a = this.poleMap.get(span.a), b = this.poleMap.get(span.b);
        if (!a || !b || OWNER.span(a, b) !== key) continue;
        spans.push(span);
        for (const end of [a, b]) if (!mine(end)) borrowedPoles.set(end.id, end);
      }
    }
    return {
      square, nodes, segments, borrowedNodes: [...borrowed.values()], poles, borrowedPoles: [...borrowedPoles.values()], spans,
      landscape: this.landscapeIn(square).filter(mine),
      barriers: this.barriersIn(square).filter((b) => b.points.length > 0 && mine(b.points[0]!)),
      buildings: this.buildings.near(square[0], square[1], square[2], square[3]).filter(mine),
      lots: this.lotStore.in(square).filter((lot) => mine(lotCentre(lot))),
      lotKeys: [...this.tileIndex.keysOf(key)],
      paint: [...this.tileIndex.paintOf<PaintDab>(key)],
      trees: this.treesIn(square).filter(mine),
      elements: this.elementsIn(square).filter(mine),
    };
  }

  /** The ids of what a tile holds now (`tileMembers`), the parts another copy of the document follows: what that copy takes in or lets go with the tile (`sim/host/simClient.ts`). */
  tileIds(key: number): { readonly nodes: readonly NodeId[]; readonly borrowedNodes: readonly NodeId[]; readonly segments: readonly SegmentId[]; readonly lots: readonly number[]; readonly buildings: readonly BuildingId[] } {
    const t = this.tileMembers(key);
    return {
      nodes: t.nodes.map((n) => n.id), borrowedNodes: t.borrowedNodes.map((n) => n.id), segments: t.segments.map((s) => s.id),
      lots: t.lots.map((lot) => lot.id), buildings: t.buildings.map((b) => b.id),
    };
  }

  /** A tile as the store keeps it (`world/tiles.ts` TileRecords), from what the page's document holds of it now: written when it changed, before it goes out. */
  tileRecords(key: number, version: number): TileRecords {
    const t = this.tileMembers(key);
    const next = this.tileNext.get(key) ?? freshTileNext(key);
    // DO NOT write a grown building no edit touched as a whole record: it is written back as its row (the generator's few numbers), made again where it is read.
    const kept = this.tileGrown.get(key);
    const made = kept?.grown;
    const asRows = new Set<number>();
    if (kept && made) {
      // Each row's lot: a building whose lot was moved, curved, rezoned, split or joined since is written whole (its row would be made again on another lot).
      const lotOf = new Map<number, number>();
      for (let k = 0; k < made.rows.id.length; k++) lotOf.set(made.rows.id[k]!, made.rows.lot[k]!);
      for (const b of t.buildings) {
        if (!made.made.has(b)) continue;
        const lot = lotOf.get(b.id);
        if (lot !== undefined && this.lot(lot) !== undefined && this.lot(lot) === kept.lots.get(lot)) asRows.add(b.id);
      }
    }
    const grown = made && asRows.size ? selectRows(made.rows, asRows) : null;
    return {
      key, version,
      nodes: t.nodes.map(savedNode), borrowedNodes: t.borrowedNodes.map(savedNode), segments: t.segments.map(savedSegment),
      poles: t.poles.map(savedPole), borrowedPoles: t.borrowedPoles.map(savedPole), poleSpans: t.spans.map(savedSpan),
      // DO NOT copy a building (a record is replaced, never edited, `BuildingStore`): the write posts each as its table's row (`tileStore.ts` tileWrite).
      buildings: asRows.size ? t.buildings.filter((b) => !asRows.has(b.id)) : t.buildings,
      // Every building's gates, the rows' too (a write does not make them again, `tileWrite`): the ones kept while no building of the tile changed.
      ...(grown ? { grown } : {}),
      ...(t.buildings.length ? { gates: this.tileGatesOf(key, t.buildings) } : {}),
      lots: t.lots.map((lot) => ({ ...lot, corners: lot.corners.map((q) => ({ x: q.x, y: q.y })) })),
      lotKeys: [...t.lotKeys],
      landscape: t.landscape.map(savedLandscape), barriers: t.barriers.map(savedBarrier),
      paint: t.paint.map((dab) => ({ ...dab })), trees: t.trees.map((tree) => ({ ...tree })), elements: t.elements.map((e) => ({ ...e })),
      next: { ...next },
    };
  }

  /** A tile taken out of the page's document (cause `TILE_UNLOADED`): what it holds now (`tileMembers`); a node at its edge stays while a road of a tile still here ends on it */
  unloadTile(key: number, gone?: Map<RecordPart, Set<number>>): ReadonlyMap<ListPart, readonly number[]> {
    const removedAt = new Map<ListPart, number[]>();
    if (!this.tileContents.has(key)) return removedAt;
    if (this.recorder) throw new Error('a tile cannot go out during an edit');
    const t = this.tileMembers(key);
    // The records that go with it, by id (`gone`): an undo step naming one cannot be taken any more, whatever range its id came from (`History.letGoTile`).
    if (gone) {
      const put = (part: RecordPart, ids: Iterable<number>): void => { const set = gone.get(part) ?? new Set<number>(); for (const id of ids) set.add(id); gone.set(part, set); };
      put('segments', t.segments.map((s) => s.id)); put('nodes', t.nodes.map((n) => n.id)); put('poles', t.poles.map((p) => p.id));
      put('poleSpans', t.spans.map((s) => s.id)); put('landscape', t.landscape.map((x) => x.id)); put('barriers', t.barriers.map((x) => x.id));
      put('buildings', t.buildings.map((b) => b.id)); put('lots', t.lots.map((l) => l.id));
    }
    this.tileContents.delete(key);
    this.tileGrown.delete(key);
    this.tileGates.delete(key);
    // Its allocators go with it (they are its records', read only while it is here, `tileRecords`): DO NOT keep one for every tile ever loaded.
    this.tileNext.delete(key);
    const cause = this.changes.cause;
    this.changes.causeNext(TILE_UNLOADED);
    const nodeIds: number[] = [], segmentIds: number[] = [];
    const rects: ChangeRect[] = [t.square];
    for (const s of t.segments) {
      const r = this.segmentRect(s.id);
      if (r) rects.push(r);
      detach(this.nodeToWrite(s.a), s.id);
      detach(this.nodeToWrite(s.b), s.id);
      this.segments.delete(s.id);
      // Its ends named too: a node that stays (a neighbour's edge node) loses a leg and is built again.
      segmentIds.push(s.id);
      nodeIds.push(s.a, s.b);
    }
    // A node goes once no road here ends on it and the tile it belongs to is not here (its own tile's, or one borrowed).
    for (const node of [...t.nodes, ...t.borrowedNodes]) {
      if (node.incident.length > 0) continue;
      const owner = OWNER.node(node);
      if (owner !== key && this.tileContents.has(owner)) continue;
      const r = this.nodeRect(node.id);
      if (r) rects.push(r);
      this.nodes.delete(node.id);
      nodeIds.push(node.id);
    }
    if (nodeIds.length || segmentIds.length) this.roadsChanged(rects, true, { nodes: nodeIds, segments: segmentIds, detail: 'tile' });
    const utilityIds: number[] = [];
    for (const span of t.spans) { this.deleteSpanRecord(span.id); utilityIds.push(span.id); }
    for (const pole of [...t.poles, ...t.borrowedPoles]) {
      if (this.spansAt(pole.id).length > 0) continue;
      const owner = OWNER.at(pole);
      if (owner !== key && this.tileContents.has(owner)) continue;
      this.deletePoleRecord(pole.id);
      utilityIds.push(pole.id);
    }
    if (utilityIds.length) this.changes.record('utilities', [t.square], { ids: utilityIds });
    for (const item of t.landscape) this.deleteLandscapeRecord(item.id);
    if (t.landscape.length) this.changes.record('landscape', [t.square], { ids: t.landscape.map((x) => x.id) });
    for (const b of t.barriers) this.deleteBarrierRecord(b.id);
    if (t.barriers.length) this.changes.record('barriers', [t.square], { ids: t.barriers.map((x) => x.id) });
    this.buildings.dropAll(t.buildings.map((b) => b.id));
    this.lotStore.restore(t.lots.map((lot) => ({ id: lot.id, value: undefined })), TILE_UNLOADED);
    const keysAt = this.lotStore.dropKeys(t.lotKeys, t.square, TILE_UNLOADED);
    if (keysAt.length) removedAt.set('lotKeys', keysAt);
    const without = <T>(part: DocListPart & ListPart, list: T[], gone: readonly T[], kind: 'paint' | 'trees' | 'elements'): void => {
      if (!gone.length) return;
      this.ownList(part);
      const set = new Set<T>(gone);
      const at: number[] = [];
      let k = 0;
      for (let n = 0; n < list.length; n++) { const item = list[n]!; if (!set.has(item)) list[k++] = item; else at.push(n); }
      list.length = k;
      removedAt.set(part, at);
      this.changes.record(kind, [t.square]);
    };
    without('terrainPaint', this.terrainPaint, t.paint, 'paint');
    for (const tree of t.trees) this.treeGrid?.remove(tree);
    without('trees', this.trees, t.trees, 'trees');
    for (const e of t.elements) this.elementGrid?.remove(e);
    without('elements', this.elements, t.elements, 'elements');
    this.changes.causeNext(cause);
    return removedAt;
  }

  // ------------------------------------------------------------ working copy

  /** DO NOT go back to copying the document for an edit (CLAUDE.md, "Rebuilding everything when one part changes"). */
  fork(): RoadDoc {
    const copy = new RoadDoc();
    this.layOver(copy);
    return copy;
  }

  /** The segments this copy of `before` added that `before` does not hold: an edit's own, whichever range their ids came from (a loaded tile's or the map's allocator). */
  addedSegments(before: RoadDoc): RoadSegment[] {
    const map = this.segments;
    const out: RoadSegment[] = [];
    if (map instanceof ForkMap && this.below === before) {
      for (const [id, seg] of (map as ForkMap<SegmentId, RoadSegment>).changes().added) if (!before.segments.has(id)) out.push(seg);
      return out;
    }
    // @rebuild An independent copy (`clone`) cannot say what it wrote: every segment compared.
    for (const [id, seg] of map) if (!before.segments.has(id)) out.push(seg);
    return out;
  }

  /** Takes back an edit made on a working copy of this document (`fork`): what it wrote and its diary entries (`takeFork`). */
  takeBack(copy: RoadDoc): void {
    if (copy.below !== this) throw new Error('RoadDoc.takeBack: not a working copy of this document');
    this.takeFork(copy);
  }

  /** Makes `copy` a working copy over this document as it stands (`fork`); also how a copy taken back starts again. */
  private layOver(copy: RoadDoc): void {
    const own = copy as unknown as { nodes: Map<NodeId, RoadNode>; segments: Map<SegmentId, RoadSegment> };
    own.nodes = new ForkMap(this.nodes);
    own.segments = new ForkMap(this.segments);
    // The nodes that may have lost their last road: the original's read through, its own kept apart.
    copy.loose = this.loose.over();
    copy.poleMap = new ForkMap(this.poleMap);
    copy.spanMap = new ForkMap(this.spanMap);
    copy.poleIndex = this.poleIndex;
    copy.barrierMap = new ForkMap(this.barrierMap);
    copy.barrierCells = this.barrierCells;
    copy.landscapeMap = new ForkMap(this.landscapeMap);
    copy.landscapeCells = this.landscapeCells;
    copy.streetNameCount = this.streetNameCount;
    copy.sharedIndices = new Set(INDEX_KINDS);
    for (const part of DOC_LISTS) copy.setList(part, this.listOf(part) as unknown[]);
    copy.sharedLists = new Set(DOC_LISTS);
    copy.treeGrid = null;
    copy.elementGrid = null;
    // Values, each replaced whole by its writers, never changed in place: shared.
    copy.transit = this.transit;
    copy.terrainRelief = this.terrainRelief;
    copy.markingStyle = this.markingStyle;
    copy.nature = this.nature;
    copy.fogSettings = this.fogSettings;
    copy.gullyAuto = this.gullyAuto;
    copy.weather = this.weather;
    copy.economy = this.economy;
    copy.nextZoneId = this.nextZoneId;
    copy.nodeIds = new IdAllocator(this.nodeIds.peek);
    copy.segIds = new IdAllocator(this.segIds.peek);
    copy.poleIds = new IdAllocator(this.poleIds.peek);
    copy.spanIds = new IdAllocator(this.spanIds.peek);
    copy.barrierIds = new IdAllocator(this.barrierIds.peek);
    copy.landscapeIds = new IdAllocator(this.landscapeIds.peek);
    copy.nextTerrainId = this.nextTerrainId;
    // The same tiles, their counters copied: a dry run that is let go takes no id of a tile for good (`takeFork` carries them on).
    copy.tileContents = this.tileContents;
    copy.tileGrown = this.tileGrown;
    copy.tileNext = new Map([...this.tileNext].map(([key, next]) => [key, { ...next }]));
    copy.buildings.forkFrom(this.buildings);
    copy.lotStore.forkFrom(this.lotStore);
    copy.openLotsIndex = null;
    copy.changes.forkFrom(this.changes);
    copy.forkedFrom = { doc: this, version: this.changes.version };
    copy.below = this;
  }

  /** A working copy (`fork`) of this document taken back */
  private takeFork(copy: RoadDoc): void {
    if (copy.forkedFrom?.doc !== this || copy.forkedFrom.version !== this.changes.version) {
      throw new Error('RoadDoc.replaceWith: a working copy of this document as it stood before a later change');
    }
    (copy.nodes as ForkMap<NodeId, RoadNode>).applyTo(this.nodes);
    (copy.segments as ForkMap<SegmentId, RoadSegment>).applyTo(this.segments);
    // Pruned by the copy: what it holds now; else the original's and the copy's.
    this.loose.take(copy.loose);
    (copy.poleMap as ForkMap<PoleId, UtilityPole>).applyTo(this.poleMap, (_, pole) => this.putPoleRecord(pole), (id) => this.deletePoleRecord(id));
    (copy.spanMap as ForkMap<SpanId, UtilitySpan>).applyTo(this.spanMap, (_, span) => this.putSpanRecord(span), (id) => this.deleteSpanRecord(id));
    (copy.landscapeMap as ForkMap<number, LandscapeItem>).applyTo(this.landscapeMap, (_, item) => this.putLandscapeRecord(item), (id) => this.deleteLandscapeRecord(id));
    (copy.barrierMap as ForkMap<number, Barrier>).applyTo(this.barrierMap, (_, barrier) => this.putBarrierRecord(barrier), (id) => this.deleteBarrierRecord(id));
    this.buildings.takeFork(copy.buildings);
    this.lotStore.takeFork(copy.lotStore);
    // The lists the copy wrote (it owns them): their items in place here, the filings by place kept by difference.
    for (const part of DOC_LISTS) {
      if (copy.sharedLists.has(part)) continue;
      this.noteList(part);
      const mine = this.listOf(part) as unknown[], theirs = copy.listOf(part);
      const grid = part === 'trees' ? this.treeGrid : part === 'elements' ? this.elementGrid : null;
      if (grid) {
        const kept = new Set(theirs), had = new Set(mine);
        for (const item of mine) if (!kept.has(item)) grid.remove(item as PlantedTree & ElementItem);
        for (const item of theirs) if (!had.has(item)) grid.add(item as PlantedTree & ElementItem);
      }
      mine.length = 0;
      for (const item of theirs) mine.push(item);
    }
    this.transit = copy.transit;
    this.terrainRelief = copy.terrainRelief;
    this.markingStyle = copy.markingStyle;
    this.nature = copy.nature;
    this.fogSettings = copy.fogSettings;
    this.gullyAuto = copy.gullyAuto;
    this.weather = copy.weather;
    this.economy = copy.economy;
    this.nextZoneId = copy.nextZoneId;
    this.nodeIds = new IdAllocator(copy.nodeIds.peek);
    this.segIds = new IdAllocator(copy.segIds.peek);
    this.poleIds = new IdAllocator(copy.poleIds.peek);
    this.spanIds = new IdAllocator(copy.spanIds.peek);
    this.barrierIds = new IdAllocator(copy.barrierIds.peek);
    this.landscapeIds = new IdAllocator(copy.landscapeIds.peek);
    this.nextTerrainId = copy.nextTerrainId;
    // The counters the copy moved carried on, tile by tile (a tile loaded meanwhile keeps its own).
    for (const [key, next] of copy.tileNext) if (this.tileContents.has(key)) this.tileNext.set(key, next);
    this.changes.take(copy.changes);
    this.layOver(copy);
  }

  /** A node's record to change in place: a working copy's own (copied from the original's the first time), or the record itself. */
  private nodeToWrite(id: NodeId): RoadNode | undefined {
    const map = this.nodes;
    if (map instanceof ForkMap) return map.writable(id, copyNode);
    if (this.recorder) this.note('nodes', id, map.get(id));
    return map.get(id);
  }

  /** A segment's record to change in place (as `nodeToWrite`). */
  private segmentToWrite(id: SegmentId): RoadSegment | undefined {
    const map = this.segments;
    if (map instanceof ForkMap) return map.writable(id, copySegment);
    if (this.recorder) this.note('segments', id, map.get(id));
    return map.get(id);
  }

  /** A list about to be written in place: a working copy's own, copied from the original's the first time (`fork`). */
  private ownList(part: DocListPart): void {
    this.capCounts.delete(part as CappedPart);
    this.noteList(part);
    if (!this.sharedLists.delete(part)) return;
    const list = this.listOf(part);
    this.setList(part, list.slice());
    forkWork.copied += list.length;
    if (part === 'trees') this.treeGrid = null;
    if (part === 'elements') this.elementGrid = null;
  }

  /** A list of the document set whole: only a working copy's, laid over or owned (`layOver`, `ownList`). */
  private setList(part: DocListPart, list: unknown[]): void {
    this.capCounts.delete(part as CappedPart);
    (this as unknown as Record<DocListPart, unknown[]>)[part] = list;
  }

  /** An index by place about to be written: a working copy's own, copied from the original's the first time (`fork`). */
  private ownIndex(kind: IndexKind): void {
    if (!this.sharedIndices.delete(kind)) return;
    switch (kind) {
      case 'poles':
        this.poleIndex = this.poleIndex.over();
        return;
      case 'barriers':
        this.barrierCells = CellFiling.over(this.barrierCells);
        return;
      case 'landscape':
        this.landscapeCells = CellFiling.over(this.landscapeCells);
        this.streetNameCount = new ForkMap(this.streetNameCount);
    }
  }

  /** Makes an independent working copy, including allocator high-water marks. */
  clone(): RoadDoc {
    // Field by field, each record copied as `replaceContents` copies it.
    const copy = new RoadDoc();
    for (const [id, node] of this.nodes) copy.nodes.set(id, copyNode(node));
    copy.loose = this.loose.copy();
    for (const [id, segment] of this.segments) copy.segments.set(id, copySegment(segment));
    for (const pole of this.poles.values()) copy.putPoleRecord({ ...pole });
    for (const span of this.poleSpans.values()) copy.putSpanRecord({ ...span });
    for (const item of this.landscape.values()) copy.putLandscapeRecord({ ...item });
    for (const barrier of this.barriers.values()) copy.putBarrierRecord({ ...barrier, points: barrier.points.map((q) => ({ ...q })) });
    copy.buildings.shareFrom(this.buildings);
    copy.buildings.copyAllocator(this.buildings);
    pushAll(copy.terrainStamps, this.terrainStamps.map((stamp) => ({ ...stamp })));
    copy.terrainRelief = this.terrainRelief;
    copy.markingStyle = this.markingStyle;
    copy.nature = this.nature ? { ...this.nature } : null;
    pushAll(copy.terrainPaint, this.terrainPaint.map((dab) => ({ ...dab })));
    pushAll(copy.fogDabs, this.fogDabs.map((dab) => ({ ...dab })));
    copy.fogSettings = { ...this.fogSettings };
    pushAll(copy.gullyDabs, this.gullyDabs.map((dab) => ({ ...dab })));
    copy.gullyAuto = this.gullyAuto;
    pushAll(copy.clouds, this.clouds.map((c) => ({ ...c })));
    pushAll(copy.elements, this.elements.map((e) => ({ ...e })));
    pushAll(copy.trees, this.trees.map((t) => ({ ...t })));
    pushAll(copy.treeClearings, this.treeClearings.map((c) => ({ ...c })));
    copy.weather = { ...this.weather };
    copy.economy = { ...this.economy };
    pushAll(copy.zones, this.zones.map((zone) => ({ ...zone, buildingIds: [...zone.buildingIds] })));
    pushAll(copy.zoneMarks, this.zoneMarks.map((mark) => ({ ...mark })));
    // The records shared, as the buildings' (never changed in place: `LotStore` OWNERSHIP).
    copy.lotStore.shareFrom(this.lotStore);
    copy.nextZoneId = this.nextZoneId;
    // Deep, as the file writes them (`serialized`): nested specs, never aliased.
    pushAll(copy.people, this.people.map((person) => JSON.parse(JSON.stringify(person)) as PersonSpec));
    copy.transit = JSON.parse(JSON.stringify(this.transit)) as TransitData;
    copy.nodeIds = new IdAllocator(this.nodeIds.peek);
    copy.segIds = new IdAllocator(this.segIds.peek);
    copy.poleIds = new IdAllocator(this.poleIds.peek);
    copy.spanIds = new IdAllocator(this.spanIds.peek);
    copy.barrierIds = new IdAllocator(this.barrierIds.peek);
    copy.landscapeIds = new IdAllocator(this.landscapeIds.peek);
    copy.nextTerrainId = this.nextTerrainId;
    // At the same revisions as this document, every one of them: the copy's diary goes on from this one's
    copy.changes.continueFrom(this.changes);
    copy.forkedFrom = { doc: this, version: this.changes.version };
    return copy;
  }

  /** Replaces this instance in place while restoring allocator invariants. */
  /** `preparedBuildings`: its buildings prepared by a worker (`editor/preparedCity.ts`), filed as they are. */
  replaceFromJSON(data: SerializedDoc, options: { readonly repair?: boolean; readonly preparedBuildings?: boolean } = {}): void {
    const restored = RoadDoc.fromJSON(data, options);
    this.replaceWith(restored);
  }

  /** Replaces this instance from another valid document - every road drawn (an edited clone, `commitDraft`) and every undo */
  replaceWith(source: RoadDoc): void {
    // A working copy over this document (`fork`): what it wrote, and its own diary entries.
    if (source.below === this) {
      this.takeFork(source);
      return;
    }
    // The whole map replaced during an edit (a map opened, a city generated): the edit's undo puts back the map as it was.
    // As its text (`toText`, the buildings' text kept per record): a third of the objects' memory, and its bytes the budget's own.
    if (this.recorder && !this.recorder.whole) this.recorder.whole = this.toText();
    const moved = this.movedIn(source);
    // Read before anything here is written: it holds while this diary stands where the copy was made.
    const buildingIds = this.buildingsMovedIn(source);
    const lotIds = this.lotsMovedIn(source);
    const roads = moved('roads', 'traffic') ? roadDifferences(this, source) : { rects: [], nodes: [], segments: [], traffic: false };
    const stamps = !moved('terrain') ? { rects: [], ids: [] }
      : this.terrainRelief !== source.terrainRelief ? null : stampDifferences(this.terrainStamps, source.terrainStamps);
    const items = itemDifferences(this, source, moved);
    // The roads differ exactly where `roadDifferences` found a node or a segment that does: DO NOT walk them twice.
    const changed = this.replaceContents(source, moved, buildingIds, lotIds, roads.nodes.length > 0 || roads.segments.length > 0);
    const where = (rects: readonly ChangeRect[] | undefined): readonly ChangeRect[] | null => rects && rects.length ? rects : null;
    // The traffic's plan only when it moved (`roadDifferences`): a node only raised leaves it, as `setNodeHeightOffset` does.
    if (changed.roads || roads.rects.length) this.roadsChanged(where(roads.rects), roads.traffic, { nodes: roads.nodes, segments: roads.segments });
    if (changed.land || (stamps !== null && stamps.rects.length)) {
      this.changes.record('terrain', where(stamps?.rects), stamps?.ids ? { ids: stamps.ids } : {});
    }
    // The poles and wires where they differ, and only they: DO NOT read the landscaping into the poles' comparison again
    if (items.utilities.length) this.changes.record('utilities', items.utilities);
    if (items.landscape.length) this.changes.record('landscape', items.landscape);
    if (changed.barriers || items.barriers.length) this.changes.record('barriers', where(items.barriers));
    // The buildings write their own (`BuildingStore.replaceWith`), each where it stands.
    for (const kind of changed.others) this.changes.record(kind, null);
  }

  /** Whether `source` changed any of these kinds since it was copied from this document */
  private movedIn(source: RoadDoc): MovedKinds {
    const fork = source.forkedFrom;
    if (!fork || fork.doc !== this || fork.version !== this.changes.version) return () => true;
    return (...kinds) => source.changes.serialOf(...kinds) > this.changes.serialOf(...kinds);
  }

  /** The ids of the buildings a working copy of this document changed since it was copied (`movedIn`), from the copy's diary */
  private buildingsMovedIn(source: RoadDoc): readonly BuildingId[] | null {
    const fork = source.forkedFrom;
    if (!fork || fork.doc !== this || fork.version !== this.changes.version) return null;
    return source.buildings.changedSince(fork.version);
  }

  /** The ids of the lots a working copy of this document changed since it was copied, as `buildingsMovedIn`; null: compare them all. */
  private lotsMovedIn(source: RoadDoc): readonly number[] | null {
    const fork = source.forkedFrom;
    if (!fork || fork.doc !== this || fork.version !== this.changes.version) return null;
    return source.lotStore.changedSince(fork.version);
  }

  // --------------------------------------------------- undo by records `world/docImage.ts` keeps the document as last

  /** DO NOT keep an image of the whole map for undo (`structuredClone` of every record at the first edit): the edit records */
  private recorder: EditRecorder | null = null;

  /** An edit begins (`editor/history.ts`): from now each record, list and value keeps its state before its first write. */
  beginEdit(): void {
    const recorder: EditRecorder = { records: new Map(), lists: new Map(), values: new Map(), whole: null };
    for (const part of VALUE_PARTS) recorder.values.set(part, this.valueOf(part));
    this.recorder = recorder;
    this.listen(recorder);
  }

  /** The edit ends: what it changed, as the states before and after (a command and its inverse); null when nothing did. */
  endEdit(): DocPatch | null {
    const rec = this.recorder;
    if (!rec) return null;
    this.recorder = null;
    this.listen(null);
    // The map after is the map as it stands: taken only when the step is undone (`editor/history.ts`), never kept twice.
    if (rec.whole) {
      return { records: [], lists: [], values: [], whole: { before: rec.whole, after: null }, bytes: wholeBytes(rec.whole, null) };
    }
    const records: DocPatch['records'][number][] = [];
    for (const [part, kept] of rec.records) {
      for (const [id, before] of kept) {
        const after = copyRecord(part, this.recordOf(part, id));
        if (before === after || (before !== undefined && after !== undefined && samePlain(before, after))) continue;
        records.push({ part, id, before, after });
      }
    }
    const lists: DocPatch['lists'][number][] = [];
    for (const [part, was] of rec.lists) {
      const now = this.listOf(part);
      let start = 0;
      while (start < was.length && start < now.length && samePlain(was[start], now[start])) start++;
      let end = 0;
      while (end < was.length - start && end < now.length - start && samePlain(was[was.length - 1 - end], now[now.length - 1 - end])) end++;
      if (start === was.length && start === now.length) continue;
      lists.push({ part, start, before: was.slice(start, was.length - end).map(copyItem), after: now.slice(start, now.length - end).map(copyItem) });
    }
    const values: DocPatch['values'][number][] = [];
    for (const [part, before] of rec.values) {
      const now = this.valueOf(part);
      if (!samePlain(before, now)) values.push({ part, before, after: copyItem(now) });
    }
    if (!records.length && !lists.length && !values.length) return null;
    return { records, lists, values, bytes: patchBytes(records, lists, values) };
  }

  /** A record's state before its first write in the edit, kept once. */
  private note(part: RecordPart, id: number, was: unknown): void {
    const rec = this.recorder!;
    // The whole map is put back by this step already (`replaceWith`): nothing of its records to keep.
    if (rec.whole) return;
    let kept = rec.records.get(part);
    if (!kept) rec.records.set(part, kept = new Map());
    if (!kept.has(id)) kept.set(id, copyRecord(part, was));
  }

  /** A list's state before its first write in the edit, kept once (only the lists the edit writes are copied). */
  private noteList(part: ListPart): void {
    const rec = this.recorder;
    if (rec && !rec.whole && !rec.lists.has(part)) rec.lists.set(part, this.listOf(part).slice());
  }

  /** The record maps and the stores told of their writes while an edit is recorded (`RecordMap.before`). */
  private listen(rec: EditRecorder | null): void {
    const tell = <K extends number, V>(map: Map<K, V>, part: RecordPart): void => {
      if (map instanceof RecordMap) map.before = rec ? (key: K, was: V | undefined) => this.note(part, key, was) : null;
    };
    tell(this.nodes, 'nodes');
    tell(this.segments, 'segments');
    tell(this.poleMap, 'poles');
    tell(this.spanMap, 'poleSpans');
    tell(this.landscapeMap, 'landscape');
    tell(this.barrierMap, 'barriers');
    this.buildings.watch(rec ? (id, was) => this.note('buildings', id, was) : null);
    this.lotStore.watch(rec ? (id, was) => this.note('lots', id, was) : null, rec ? () => this.noteList('lotKeys') : null);
  }

  /** A record of the document as it stands, by its part. */
  private recordOf(part: RecordPart, id: number): unknown {
    switch (part) {
      case 'nodes': return this.nodes.get(id as NodeId);
      case 'segments': return this.segments.get(id as SegmentId);
      case 'poles': return this.poleMap.get(id as PoleId);
      case 'poleSpans': return this.spanMap.get(id as SpanId);
      case 'landscape': return this.landscapeMap.get(id);
      case 'barriers': return this.barrierMap.get(id);
      case 'buildings': return this.buildings.get(id as BuildingId);
      case 'lots': return this.lotStore.get(id);
    }
  }

  /** The id allocators' next ids: nodes, segments, poles, spans, barriers, landscaping, terrain stamps, buildings. */
  allocatorMarks(): number[] {
    return [this.nodeIds.peek, this.segIds.peek, this.poleIds.peek, this.spanIds.peek, this.barrierIds.peek, this.landscapeIds.peek, this.nextTerrainId, this.buildings.nextId];
  }

  restore(r: Restoration): void {
    if (r.whole) { this.replaceFromJSON(JSON.parse(r.whole) as SerializedDoc, { repair: false }); return; }
    const roads: ChangeRect[] = [], utilities: ChangeRect[] = [], landscape: ChangeRect[] = [], barriers: ChangeRect[] = [];
    // The kinds changed as a whole (a value: the relief, the weather...)
    const kinds = new Set<DocChangeKind>();
    const listRects = new Map<DocChangeKind, ChangeRect[] | null>();
    let roadsTouched = false;
    // DO NOT write `traffic` for every road record: an undo of a node raised rebuilt the simulation's plan.
    let traffic = false;
    const nodeIds: number[] = [], segmentIds: number[] = [];
    const utilityIds: number[] = [], landscapeIds: number[] = [], barrierIds: number[] = [];
    const lotRecords: { id: number; value: Lot | undefined }[] = [];
    // Where the roads stand: each record's own rectangle, and a node's roads (its move moves them).
    const roadRects = (): void => {
      for (const { part, id } of r.records) {
        if (part === 'nodes') {
          const rect = this.nodeRect(id as NodeId);
          if (rect) roads.push(rect);
          for (const sid of this.nodes.get(id as NodeId)?.incident ?? []) { const s = this.segmentRect(sid); if (s) roads.push(s); }
        } else if (part === 'segments') {
          const rect = this.segmentRect(id as SegmentId);
          if (rect) roads.push(rect);
        }
      }
    };
    const itemRects = (): void => {
      for (const { part, id } of r.records) {
        if (part === 'poles') { const p = this.poles.get(id as PoleId); if (p) utilities.push(rectAround([p], ITEM_PAD)!); }
        if (part === 'poleSpans') {
          const s = this.poleSpans.get(id as SpanId), p = s && this.poles.get(s.a), q = s && this.poles.get(s.b);
          if (p && q) utilities.push(rectAround([p, q], ITEM_PAD)!);
        }
        if (part === 'landscape') { const item = this.landscape.get(id); if (item) landscape.push(rectAround([item], ITEM_PAD)!); }
        if (part === 'barriers') { const b = this.barriers.get(id); if (b) barriers.push(rectAround(b.points, ITEM_PAD)!); }
      }
    };
    roadRects();
    itemRects();
    for (const { part, id, value } of r.records) {
      const put = <T>(map: Map<number, T>): void => { if (value === undefined) map.delete(id); else map.set(id, structuredClone(value) as T); };
      switch (part) {
        case 'nodes': {
          const was = this.nodes.get(id as NodeId);
          if ((was || value !== undefined) && nodeMovesTraffic(was, value as RoadNode | undefined)) traffic = true;
          put(this.nodes as Map<number, RoadNode>); this.loose.add(id as NodeId); roadsTouched = true; nodeIds.push(id); break;
        }
        case 'segments': put(this.segments as Map<number, RoadSegment>); roadsTouched = true; traffic = true; segmentIds.push(id); break;
        case 'poles': if (value === undefined) this.deletePoleRecord(id as PoleId); else this.putPoleRecord(structuredClone(value) as UtilityPole); kinds.add('utilities'); utilityIds.push(id); break;
        case 'poleSpans': if (value === undefined) this.deleteSpanRecord(id as SpanId); else this.putSpanRecord(structuredClone(value) as UtilitySpan); kinds.add('utilities'); utilityIds.push(id); break;
        case 'landscape':
          if (value === undefined) this.deleteLandscapeRecord(id); else this.putLandscapeRecord(structuredClone(value) as LandscapeItem);
          kinds.add('landscape'); landscapeIds.push(id); break;
        case 'barriers':
          if (value === undefined) this.deleteBarrierRecord(id); else this.putBarrierRecord(structuredClone(value) as Barrier);
          kinds.add('barriers'); barrierIds.push(id); break;
        case 'buildings': this.buildings.restore(id as BuildingId, value as Building | undefined); break;
        // Kept by reference, as the buildings (`LotStore` OWNERSHIP); all of them in one entry, below.
        case 'lots': lotRecords.push({ id, value: value as Lot | undefined }); break;
      }
    }
    if (lotRecords.length) this.lotStore.restore(lotRecords, 'restaurados');
    for (const { part, start, remove, items } of r.lists) {
      const kind = LIST_KINDS[part];
      const put = items.map((item) => structuredClone(item));
      if (part !== 'lotKeys') this.ownList(part);
      // The keys through their owner, which keeps them as a set too.
      const gone = part === 'lotKeys' ? this.lotStore.spliceKeys(start, remove, put as string[]) : spliceIn(this.listOf(part) as unknown[], start, remove, put);
      if (part === 'elements') {
        for (const e of gone as ElementItem[]) this.elementGrid?.remove(e);
        for (const e of put as ElementItem[]) this.elementGrid?.add(e);
      } else if (part === 'trees') {
        for (const t of gone as PlantedTree[]) this.treeGrid?.remove(t);
        for (const t of put as PlantedTree[]) this.treeGrid?.add(t);
      }
      // DO NOT write `null` (the whole map) for a stretch of a list whose items have places.
      if (listRects.has(kind) && listRects.get(kind) === null) continue;
      const rects = listRects.get(kind) ?? [];
      const left = listBox(part, gone), came = listBox(part, items);
      if (left === undefined || came === undefined) { listRects.set(kind, null); continue; }
      if (left) rects.push(left);
      if (came) rects.push(came);
      listRects.set(kind, rects);
    }
    for (const { part, value } of r.values) this.restoreValue(part, value, kinds);
    roadRects();
    itemRects();
    const where = (rects: readonly ChangeRect[]): readonly ChangeRect[] | null => (rects.length ? rects : null);
    if (roadsTouched) this.roadsChanged(where(roads), traffic, { nodes: nodeIds, segments: segmentIds, detail: 'restored' });
    // The paint style is written with the other values below, as its own kind (`setMarkingStyle`).
    // With the poles and spans put back, as their writers name them (`addPole`, `addPoleSpan`).
    if (kinds.has('utilities')) this.changes.record('utilities', where(utilities), { ids: utilityIds });
    if (kinds.has('landscape')) this.changes.record('landscape', where(landscape), { ids: landscapeIds });
    if (kinds.has('barriers')) this.changes.record('barriers', where(barriers), { ids: barrierIds });
    for (const [kind, rects] of listRects) {
      if (kinds.has(kind)) continue;
      // A stretch put back as it was moves nothing (an empty list of rectangles writes no entry).
      this.changes.record(kind, rects);
    }
    for (const kind of kinds) if (!['utilities', 'landscape', 'barriers'].includes(kind)) this.changes.record(kind, null);
  }

  /** A list of the document by its part's name (`restore`, `world/docImage.ts`); read-only to the image (written through `restore`). */
  listOf(part: ListPart): readonly unknown[] {
    switch (part) {
      case 'terrainStamps': return this.terrainStamps;
      case 'terrainPaint': return this.terrainPaint;
      case 'fogDabs': return this.fogDabs;
      case 'gullyDabs': return this.gullyDabs;
      case 'clouds': return this.clouds;
      case 'trees': return this.trees;
      case 'treeClearings': return this.treeClearings;
      case 'elements': return this.elements;
      case 'zones': return this.zones;
      case 'zoneMarks': return this.zoneMarks;
      case 'lotKeys': return this.lotStore.keys;
      case 'people': return this.people;
    }
  }

  /** A value of the document by its part's name (`world/docImage.ts`). */
  valueOf(part: ValuePart): unknown {
    switch (part) {
      case 'terrainRelief': return this.terrainRelief;
      case 'markingStyle': return this.markingStyle;
      case 'nature': return this.nature;
      case 'fogSettings': return this.fogSettings;
      case 'gullyAuto': return this.gullyAuto;
      case 'weather': return this.weather;
      case 'economy': return this.economy;
      case 'transit': return this.transit;
      case 'nextZoneId': return this.nextZoneId;
      case 'nextLotId': return this.lotStore.nextId;
      case 'allocators': return this.allocatorMarks();
    }
  }

  private restoreValue(part: ValuePart, raw: unknown, kinds: Set<DocChangeKind>): void {
    const value = structuredClone(raw);
    switch (part) {
      case 'terrainRelief': this.terrainRelief = value as ReliefVersion; kinds.add('terrain'); return;
      case 'markingStyle': this.markingStyle = value as MarkingStyleId; kinds.add('markingStyle'); return;
      case 'nature': this.nature = value as NatureSettings | null; kinds.add('nature'); return;
      case 'fogSettings': this.fogSettings = value as FogSettings; kinds.add('fog'); return;
      case 'gullyAuto': this.gullyAuto = value as number; kinds.add('gullies'); return;
      case 'weather': this.weather = value as Weather; kinds.add('weather'); return;
      case 'economy': this.economy = value as Economy; kinds.add('economy'); return;
      case 'transit': this.transit = value as TransitData; kinds.add('transit'); return;
      case 'nextZoneId': this.nextZoneId = value as number; return;
      case 'nextLotId': this.lotStore.restoreNextId(value as number); return;
      case 'allocators': {
        const [nodes, segs, poles, spans, barriers, landscape, terrain, buildings] = value as number[];
        this.nodeIds = new IdAllocator(nodes!);
        this.segIds = new IdAllocator(segs!);
        this.poleIds = new IdAllocator(poles!);
        this.spanIds = new IdAllocator(spans!);
        this.barrierIds = new IdAllocator(barriers!);
        this.landscapeIds = new IdAllocator(landscape!);
        this.nextTerrainId = terrain!;
        this.buildings.restoreNextId(buildings!);
        return;
      }
    }
  }

  /** Takes `source`'s contents and says what differed: the roads, the land, the poles and the barriers */
  private replaceContents(source: RoadDoc, moved: MovedKinds, buildingIds: readonly BuildingId[] | null, lotIds: readonly number[] | null, roadsDiffer: boolean): {
    roads: boolean; land: boolean; barriers: boolean; others: DocChangeKind[];
  } {
    const others: DocChangeKind[] = [];
    let barriersChanged = false;
    // The land moves only when its stamps do.
    const landMoved = moved('terrain') && (!sameStamps(this.terrainStamps, source.terrainStamps) || this.terrainRelief !== source.terrainRelief);
    // Likewise the roads and the utility network
    const roadsMoved = moved('roads', 'traffic');
    const roadsChanged = roadsMoved && roadsDiffer;

    if (roadsMoved) {
      this.nodes.clear();
      this.segments.clear();
      this.loose.clear();
      for (const [id, node] of source.nodes) {
        this.nodes.set(id, copyNode(node));
        if (node.incident.length === 0) this.loose.add(id);
      }
      for (const [id, segment] of source.segments) this.segments.set(id, copySegment(segment));
    }
    if (moved('utilities')) {
      this.clearPoleRecords();
      for (const pole of source.poles.values()) this.putPoleRecord({ ...pole });
      for (const span of source.poleSpans.values()) this.putSpanRecord({ ...span });
    }
    if (moved('landscape')) {
      this.clearLandscapeRecords();
      for (const item of source.landscape.values()) this.putLandscapeRecord({ ...item });
    }
    if (moved('barriers') && !sameBarriers(this, source)) {
      this.clearBarrierRecords();
      for (const barrier of source.barriers.values()) this.putBarrierRecord({ ...barrier, points: barrier.points.map((p) => ({ ...p })) });
      barriersChanged = true;
    }
    // Writes a change only of the buildings that differ; of a working copy, reads only those its diary names
    this.buildings.replaceWith(source.buildings, buildingIds);
    // The zones and the lots moved only when their content did
    this.nextZoneId = source.nextZoneId;
    if (moved('zones') && (!sameText(this.zones, source.zones) || !sameText(this.zoneMarks, source.zoneMarks))) {
      this.ownList('zones');
      this.ownList('zoneMarks');
      this.zones.length = 0;
      pushAll(this.zones, source.zones.map((zone) => ({ ...zone, buildingIds: [...zone.buildingIds] })));
      this.zoneMarks.length = 0;
      pushAll(this.zoneMarks, source.zoneMarks.map((mark) => ({ ...mark })));
      others.push('zones');
    }
    // The lots write their own, by id (`LotStore.replaceWith`); of a working copy, only those its diary names.
    if (moved('lots', 'lotKeys')) this.lotStore.replaceWith(source.lotStore, lotIds, 'replaced by an edit or an undo');
    if (moved('transit') && !sameText(this.transit, source.transit)) {
      this.transit = JSON.parse(JSON.stringify(source.transit)) as TransitData;
      others.push('transit');
    }
    if (moved('people') && !sameText(this.people, source.people)) {
      this.ownList('people');
      this.people.length = 0;
      pushAll(this.people, source.people.map((p) => JSON.parse(JSON.stringify(p)) as PersonSpec));
      others.push('people');
    }

    if (moved('nature') && !sameText(this.nature, source.nature)) {
      this.nature = source.nature ? { ...source.nature } : null;
      others.push('nature');
    }

    if (this.economy.balance !== source.economy.balance) {
      this.economy = { ...source.economy };
      others.push('economy');
    }
    if (moved('weather') && !sameText(this.weather, source.weather)) {
      this.weather = { ...source.weather };
      others.push('weather');
    }
    if (moved('trees') && !sameText(this.trees, source.trees)) {
      this.ownList('trees');
      this.trees.length = 0;
      this.treeGrid = null;
      pushAll(this.trees, source.trees.map((t) => ({ ...t })));
      others.push('trees');
    }
    if (moved('clearings') && !sameText(this.treeClearings, source.treeClearings)) {
      this.ownList('treeClearings');
      this.treeClearings.length = 0;
      pushAll(this.treeClearings, source.treeClearings.map((c) => ({ ...c })));
      others.push('clearings');
    }

    if (moved('elements') && (this.elements.length !== source.elements.length || !sameText(this.elements, source.elements))) {
      this.ownList('elements');
      this.elements.length = 0;
      this.elementGrid = null;
      pushAll(this.elements, source.elements);
      others.push('elements');
    }

    if (moved('clouds') && !sameText(this.clouds, source.clouds)) {
      this.ownList('clouds');
      this.clouds.length = 0;
      pushAll(this.clouds, source.clouds.map((c) => ({ ...c })));
      others.push('clouds');
    }

    if (moved('gullies') && (this.gullyAuto !== source.gullyAuto || !sameText(this.gullyDabs, source.gullyDabs))) {
      this.ownList('gullyDabs');
      this.gullyDabs.length = 0;
      pushAll(this.gullyDabs, source.gullyDabs.map((dab) => ({ ...dab })));
      this.gullyAuto = source.gullyAuto;
      others.push('gullies');
    }

    if (moved('fog') && (!sameText(this.fogDabs, source.fogDabs) || !sameText(this.fogSettings, source.fogSettings))) {
      this.ownList('fogDabs');
      this.fogDabs.length = 0;
      pushAll(this.fogDabs, source.fogDabs.map((dab) => ({ ...dab })));
      this.fogSettings = { ...source.fogSettings };
      others.push('fog');
    }

    if (moved('paint') && !samePaint(this.terrainPaint, source.terrainPaint)) {
      this.ownList('terrainPaint');
      this.terrainPaint.length = 0;
      pushAll(this.terrainPaint, source.terrainPaint.map((dab) => ({ ...dab })));
      others.push('paint');
    }

    if (this.markingStyle !== source.markingStyle) {
      this.markingStyle = source.markingStyle;
      others.push('markingStyle');
    }

    if (landMoved) {
      this.ownList('terrainStamps');
      this.terrainStamps.length = 0;
      pushAll(this.terrainStamps, source.terrainStamps.map((stamp) => ({ ...stamp })));
      this.terrainRelief = source.terrainRelief;
    }

    this.nodeIds = new IdAllocator(source.nodeIds.peek);
    this.segIds = new IdAllocator(source.segIds.peek);
    this.poleIds = new IdAllocator(source.poleIds.peek);
    this.spanIds = new IdAllocator(source.spanIds.peek);
    this.barrierIds = new IdAllocator(source.barrierIds.peek);
    this.landscapeIds = new IdAllocator(source.landscapeIds.peek);
    this.nextTerrainId = source.nextTerrainId;
    return { roads: roadsChanged, land: landMoved, barriers: barriersChanged, others };
  }

  // ------------------------------------------------------------ serialization

  toJSON(): SerializedDoc {
    return this.serialized(true);
  }

  /** `JSON.stringify(this.toJSON())`, the same text, with the buildings' text kept per record */
  toText(): string {
    if (this.buildings.size === 0) return JSON.stringify(this.serialized(false));
    // The keys in `toJSON`'s order: those before the buildings, the buildings, those after.
    const head: Record<string, unknown> = {};
    const tail: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.serialized(false))) {
      (AFTER_BUILDINGS.has(key) ? tail : head)[key] = value;
    }
    const after = JSON.stringify(tail);
    return `${JSON.stringify(head).slice(0, -1)},"buildings":${this.buildings.toText()}${after === '{}' ? '' : `,${after.slice(1, -1)}`}}`;
  }

  /** One part of what a map saved by tiles keeps outside its tiles (`editor/chunkedSave.ts`): only that part copied. */
  savedGlobals(part: GlobalPart): Partial<SavedGlobals> {
    switch (part) {
      case 'values': return {
        version: 1,
        unit: METERS_PER_UNIT,
        ...(this.terrainRelief !== RELIEF_LEGACY ? { relief: this.terrainRelief } : {}),
        ...(this.markingStyle !== 'classic' ? { markingStyle: this.markingStyle } : {}),
        ...(this.nature ? { nature: { ...this.nature } } : {}),
        ...(!samePlain(this.weather, DEFAULT_WEATHER) ? { weather: { ...this.weather } } : {}),
        fogSettings: { ...this.fogSettings },
        gullyAuto: this.gullyAuto,
        ...(this.economy.balance !== DEFAULT_ECONOMY.balance ? { economy: { balance: this.economy.balance } } : {}),
      };
      case 'lotKeys': return this.lotStore.keys.length > 0 ? { lotKeys: [...this.lotStore.keys] } : {};
      case 'people': return this.people.length > 0 ? { people: this.people.map((p) => structuredClone(p)) } : {};
      case 'transit': return hasTransit(this.transit) ? { transit: structuredClone(this.transit) } : {};
    }
  }

  /** The map's parts no tile holds (CLAUDE.md, "Streaming world"): its terrain stamps, fog, gullies, clouds, clearings, zones, people, transit, economy, weather and the like, as `toJSON` writes them - the streamed world's values (`editor/tileStore.ts` WorldMeta). */
  worldValues(): Omit<SerializedDoc, 'version' | 'nodes' | 'segments' | 'poles' | 'poleSpans' | 'landscape' | 'barriers' | 'buildings' | 'lots' | 'lotKeys' | 'paint' | 'trees' | 'elements'> {
    const { version: _v, nodes: _n, segments: _s, poles: _p, poleSpans: _ps, landscape: _l, barriers: _b, buildings: _bu, lots: _lo, lotKeys: _k, paint: _pa, trees: _t, elements: _e, ...rest } = this.serialized(false, false);
    // DO NOT start the map's own allocators at 1 again each session: a record made where no tile is loaded takes from them (`takeId`), and its id would meet an older one.
    return { ...rest, allocators: this.allocatorMarks() };
  }

  /** The allocators' next ids as saved (`allocatorMarks`, the streamed world's values): each kept above them, never below what this document already holds. */
  private reserveAllocators(marks: readonly number[]): void {
    const [nodes, segs, poles, spans, barriers, landscape, terrain, buildings] = marks;
    const above = (allocator: IdAllocator, next: number | undefined): void => { if (Number.isInteger(next) && next! > 0) allocator.reserve(next! - 1); };
    above(this.nodeIds, nodes); above(this.segIds, segs); above(this.poleIds, poles); above(this.spanIds, spans);
    above(this.barrierIds, barriers); above(this.landscapeIds, landscape);
    if (Number.isInteger(terrain)) this.nextTerrainId = Math.max(this.nextTerrainId, terrain!);
    if (Number.isInteger(buildings) && buildings! > this.buildings.nextId) this.buildings.restoreNextId(buildings!);
  }

  /** `toJSON`, the buildings left out when `withBuildings` is false (`clone` shares them). */
  private serialized(withBuildings: boolean, withRecords = true): SerializedDoc {
    return {
      version: 1,
      unit: METERS_PER_UNIT,
      nodes: withRecords ? inIdOrder(this.nodes.values()).map(savedNode) : [],
      segments: withRecords ? inIdOrder(this.segments.values()).map(savedSegment) : [],
      terrain: [],
      ...this.worldPart('terrain'),
      ...this.worldPart('markingStyle'),
      ...this.worldPart('nature'),
      ...(withRecords && this.terrainPaint.length > 0 ? { paint: this.terrainPaint.map((dab) => ({ ...dab })) } : {}),
      ...this.worldPart('fog'),
      ...this.worldPart('gullies'),
      ...this.worldPart('clouds'),
      ...(withRecords && this.elements.length > 0 ? { elements: this.elements.map((e) => ({ ...e })) } : {}),
      ...(withRecords && this.trees.length > 0 ? { trees: this.trees.map((t) => ({ ...t })) } : {}),
      ...this.worldPart('weather'),
      ...this.worldPart('clearings'),
      poles: withRecords ? inIdOrder(this.poles.values()).map(savedPole) : [],
      poleSpans: withRecords ? inIdOrder(this.poleSpans.values()).map(savedSpan) : [],
      ...(withRecords && this.landscape.size > 0 ? { landscape: inIdOrder(this.landscape.values()).map(savedLandscape) } : {}),
      // Only when there are any, so a map without them serialises as before.
      ...(withRecords && this.barriers.size > 0 ? { barriers: inIdOrder(this.barriers.values()).map(savedBarrier) } : {}),
      // Only when there are any, so a map without buildings serialises exactly as it did before buildings existed.
      ...(withBuildings && this.buildings.size > 0 ? { buildings: this.buildings.toJSON() } : {}),
      ...this.worldPart('zones'),
      ...(withRecords && (this.lotStore.size > 0 || this.lotStore.keys.length > 0) ? {
        lots: this.lotStore.toJSON(),
        lotKeys: [...this.lotStore.keys],
      } : {}),
      ...this.worldPart('people'),
      ...this.worldPart('transit'),
      ...this.worldPart('economy'),
    };
  }

  /** One of the map's parts no tile holds, as `toJSON` writes it (`WorldPart`): the streamed world writes each apart, only when its kind changed (`worldStreamer.ts`). */
  worldPart(part: WorldPart): Partial<SerializedDoc> {
    switch (part) {
      // Only for the natural land: a legacy map serialises as before.
      case 'terrain': return { terrain: this.terrainStamps.map((stamp) => ({ ...stamp })), ...(this.terrainRelief !== RELIEF_LEGACY ? { relief: this.terrainRelief } : {}) };
      case 'markingStyle': return this.markingStyle !== 'classic' ? { markingStyle: this.markingStyle } : {};
      case 'nature': return this.nature ? { nature: { ...this.nature } } : {};
      case 'fog': return this.fogDabs.length > 0 || JSON.stringify(this.fogSettings) !== JSON.stringify(DEFAULT_FOG)
        ? { fog: { dabs: this.fogDabs.map((dab) => ({ ...dab })), settings: { ...this.fogSettings } } } : {};
      case 'gullies': return this.gullyDabs.length > 0 || this.gullyAuto !== DEFAULT_GULLY_AUTO
        ? { gullies: { dabs: this.gullyDabs.map((dab) => ({ ...dab })), auto: this.gullyAuto } } : {};
      case 'clouds': return this.clouds.length > 0 ? { clouds: this.clouds.map((c) => ({ ...c })) } : {};
      case 'weather': return JSON.stringify(this.weather) !== JSON.stringify(DEFAULT_WEATHER) ? { weather: { ...this.weather } } : {};
      case 'clearings': return this.treeClearings.length > 0 ? { treeClearings: this.treeClearings.map((c) => ({ ...c })) } : {};
      case 'zones': return {
        ...(this.zones.length > 0 ? { zones: this.zones.map((zone) => ({ ...zone, buildingIds: [...zone.buildingIds] })) } : {}),
        ...(this.zoneMarks.length > 0 ? { zoneMarks: this.zoneMarks.map((mark) => ({ ...mark })) } : {}),
      };
      // Likewise the people: only a city that has some carries the key.
      case 'people': return this.people.length > 0 ? { people: this.people.map((p) => JSON.parse(JSON.stringify(p)) as PersonSpec) } : {};
      // And the public transport.
      case 'transit': return hasTransit(this.transit) ? { transit: JSON.parse(JSON.stringify(this.transit)) as TransitData } : {};
      // Only off the starting balance: a map that never paid for a road serialises as before.
      case 'economy': return this.economy.balance !== DEFAULT_ECONOMY.balance ? { economy: { balance: this.economy.balance } } : {};
      case 'allocators': return { allocators: this.allocatorMarks() };
    }
  }

  /** Builds a document from its serialized form. */
  static fromJSON(saved: SerializedDoc, options: { readonly repair?: boolean; readonly shareBuildings?: BuildingStore; readonly preparedBuildings?: boolean } = {}): RoadDoc {
    // A map saved in another world unit (every map before 2026-10-10: 0.4 m) in this build's.
    const data = rescaleSerializedDoc(saved);
    const repair = options.repair ?? true;
    const doc = new RoadDoc();
    const canonicalNode = new Map<number, NodeId>();
    const nodeAt = new Map<string, RoadNode>();
    for (const n of data.nodes) {
      // Maps produced before cross-structure snapping was fixed can contain two endpoint records at the exact same world
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
      const node = nodeRecord(n, repair ? onWorld(n) : n);
      doc.nodes.set(id, node);
      nodeAt.set(key, node);
      canonicalNode.set(n.id, id);
    }
    for (const s of data.segments) {
      const id = asSegmentId(s.id);
      const a = canonicalNode.get(s.a) ?? asNodeId(s.a);
      const b = canonicalNode.get(s.b) ?? asNodeId(s.b);
      if (!doc.nodes.has(a) || !doc.nodes.has(b) || a === b) continue;
      doc.segments.set(id, segmentRecord(s, a, b));
      doc.requireNode(a).incident.push(id);
      doc.requireNode(b).incident.push(id);
      doc.segIds.reserve(s.id);
    }
    for (const [id, node] of doc.nodes) if (node.incident.length === 0) doc.loose.add(id);
    // Crossings and the rest last: they name segments (`finishNode`).
    for (const n of data.nodes) {
      const node = doc.nodes.get(asNodeId(n.id));
      if (node && canonicalNode.get(n.id) === node.id) finishNode(node, n);
    }
    for (const dab of data.paint ?? []) {
      if (!isPaintKind(dab.kind) || ![dab.x, dab.y, dab.radius, dab.strength].every(Number.isFinite)) continue;
      doc.terrainPaint.push({ kind: dab.kind, x: dab.x, y: dab.y, radius: dab.radius, strength: dab.strength });
    }
    const loaded = { cause: 'map loaded' } as const;
    if (doc.terrainPaint.length) doc.changes.record('paint', null, loaded);
    // Absent: a map with the default weather (dry and still).
    if (data.weather) { doc.weather = readWeather(data.weather); doc.changes.record('weather', null, loaded); }
    // Absent: a map with no trees planted or cut.
    for (const raw of data.trees ?? []) {
      const tree = readPlantedTree(raw);
      // Every tree read, however many: a cap refuses a new one, it never drops what was saved (decision 5.1).
      if (tree) doc.trees.push(tree);
    }
    if (doc.trees.length) doc.changes.record('trees', null, loaded);
    for (const raw of data.treeClearings ?? []) {
      const clearing = readTreeClearing(raw);
      if (clearing) doc.treeClearings.push(clearing);
    }
    if (doc.treeClearings.length) doc.changes.record('clearings', null, loaded);
    // Absent: a map with no elements laid.
    for (const raw of data.elements ?? []) {
      const item = readElement(raw);
      if (item) doc.elements.push(item);
    }
    if (doc.elements.length) doc.changes.record('elements', null, loaded);
    // Absent: a map with no clouds placed.
    const cloudIds = new Set<number>();
    for (const raw of data.clouds ?? []) {
      const cloud = readCloud(raw);
      if (!cloud || doc.clouds.length >= MAX_PLACED_CLOUDS || cloudIds.has(cloud.id)) continue;
      cloudIds.add(cloud.id);
      doc.clouds.push(cloud);
    }
    if (doc.clouds.length) doc.changes.record('clouds', null, loaded);
    // Absent: a map with no gullies laid and the land's own at the default.
    if (data.gullies) {
      for (const raw of data.gullies.dabs ?? []) {
        const dab = readGullyDab(raw);
        if (dab) doc.gullyDabs.push(dab);
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
    doc.terrainRelief = readRelief(data.relief) ?? RELIEF_LEGACY;
    doc.markingStyle = isMarkingStyle(data.markingStyle) ? data.markingStyle : 'classic';
    // Absent: a map from before the ecosystem, which keeps its ground.
    doc.nature = isNatureSettings(data.nature) ? { region: data.nature.region, seed: data.nature.seed } : null;
    for (const stamp of data.terrain ?? []) {
      doc.terrainStamps.push({ ...stamp });
      doc.nextTerrainId = Math.max(doc.nextTerrainId, stamp.id + 1);
    }

    // The utility network, if the map has one.
    for (const p of data.poles ?? []) {
      const id = asPoleId(p.id);
      const at = repair ? onWorld(p) : p;
      doc.putPoleRecord({ id, x: at.x, y: at.y, lamp: p.lamp ?? false });
      doc.poleIds.reserve(p.id);
    }
    for (const s of data.poleSpans ?? []) {
      const a = asPoleId(s.a);
      const b = asPoleId(s.b);
      // A span whose poles did not survive is dropped rather than restored as a wire hanging off nothing.
      if (!doc.poles.has(a) || !doc.poles.has(b)) continue;
      const id = asSpanId(s.id);
      doc.putSpanRecord({ id, a, b });
      doc.spanIds.reserve(s.id);
    }
    // Public transport, if the map has any; anything malformed is dropped.
    if (data.transit) doc.transit = normalizeTransit(data.transit);
    // The balance, if the map has paid for anything (absent: the starting balance).
    const economy = data.economy === undefined ? null : readEconomy(data.economy);
    if (economy) { doc.economy = economy; doc.changes.record('economy', null, { cause: 'map loaded' }); }
    // The player's landscaping, if the map has any; anything malformed is dropped.
    for (const raw of data.landscape ?? []) {
      const item = landscapeRecord(raw, repair);
      if (!item) continue;
      doc.putLandscapeRecord(item);
      doc.landscapeIds.reserve(item.id);
    }
    // Walls, fences and hedges, if the map has any; anything malformed is dropped.
    for (const raw of data.barriers ?? []) {
      const barrier = barrierRecord(raw, repair);
      if (!barrier) continue;
      doc.putBarrierRecord(barrier);
      doc.barrierIds.reserve(barrier.id);
    }
    // Buildings, if the map has any; each one through `migrateBuilding`.
    if (options.shareBuildings) doc.buildings.shareFrom(options.shareBuildings);
    else if (data.buildings && options.preparedBuildings) doc.buildings.loadPrepared(data.buildings as unknown as readonly Building[]);
    else if (data.buildings) doc.buildings.load(data.buildings);
    // The ids already read by a set, NOT `doc.lots.some(...)` per record
    const zoneIds = new Set<number>();
    for (const zone of data.zones ?? []) {
      if (!Number.isInteger(zone.id) || zone.id < 1 || !isZoneUse(zone.use) || !isZoneDensity(zone.density)) continue;
      if (![zone.x0, zone.y0, zone.x1, zone.y1, zone.seed].every(Number.isFinite)) continue;
      if (zone.x0 >= zone.x1 || zone.y0 >= zone.y1 || !Array.isArray(zone.buildingIds) || zoneIds.has(zone.id)) continue;
      zoneIds.add(zone.id);
      doc.zones.push({ ...zone, buildingIds: zone.buildingIds.filter((id) => Number.isInteger(id) && doc.buildings.has(id as Parameters<typeof doc.buildings.has>[0])) });
      doc.nextZoneId = Math.max(doc.nextZoneId, zone.id + 1);
    }
    for (const mark of data.zoneMarks ?? []) {
      if (!isZoneMark(mark)) continue;
      const standing = mark.building !== undefined && doc.buildings.has(mark.building as Parameters<typeof doc.buildings.has>[0]);
      const { building: _gone, ...free } = mark;
      doc.zoneMarks.push(standing ? { ...mark } : free);
    }
    const lotIds = new Set<number>();
    const lots: Lot[] = [];
    for (const lot of data.lots ?? []) {
      if (!isLot(lot) || lotIds.has(lot.id)) continue;
      lotIds.add(lot.id);
      lots.push(lotRecord(lot, (id) => doc.buildings.has(id as BuildingId)));
    }
    doc.lotStore.load(lots, (data.lotKeys ?? []).filter((key): key is string => typeof key === 'string'));
    // People, each brought into range; anything that is not one is dropped.
    const seen = new Set<number>();
    for (const raw of data.people ?? []) {
      const person = normalizePerson(raw);
      if (!person || seen.has(person.id)) continue;
      seen.add(person.id);
      doc.people.push(person);
    }
    if (Array.isArray(data.allocators)) doc.reserveAllocators(data.allocators);
    doc.roadsChanged(null, true, { detail: 'map loaded' });
    if (data.terrain?.length) doc.changes.record('terrain', null, { cause: 'map loaded' });
    return doc;
  }
}

/** The nodes that may have been left with no road (`RoadDoc.pruneOrphanNodes`) */
class LooseNodes {
  private own = new Set<NodeId>();
  constructor(private below: LooseNodes | null = null) {}

  add(id: NodeId): void {
    this.own.add(id);
  }

  /** Each once, in id order (as the walk over the map met them). */
  sorted(): NodeId[] {
    const all = new Set(this.below?.sorted());
    for (const id of this.own) all.add(id);
    return [...all].sort((p, q) => p - q);
  }

  clear(): void {
    this.own.clear();
    this.below = null;
  }

  /** A working copy's, over this one. */
  over(): LooseNodes {
    return new LooseNodes(this);
  }

  /** An independent copy (`RoadDoc.clone`). */
  copy(): LooseNodes {
    const out = new LooseNodes();
    for (const id of this.sorted()) out.add(id);
    return out;
  }

  /** A working copy's over this one taken back: what it holds now (only its own once it pruned). */
  take(copy: LooseNodes): void {
    if (copy.below === null) {
      this.own = copy.own;
      this.below = null;
    } else for (const id of copy.own) this.own.add(id);
    copy.own = new Set();
  }
}

/** Exact serialization key; normalises the two JavaScript spellings of zero. */
function coordinateKey(x: number, y: number): string {
  const nx = Object.is(x, -0) ? 0 : x;
  const ny = Object.is(y, -0) ? 0 : y;
  return `${nx}\u0000${ny}`;
}

/** The document's keyed collections, its ordered lists and its single values, as undo restores them (`RoadDoc.restore`). */
export type RecordPart = 'nodes' | 'segments' | 'poles' | 'poleSpans' | 'landscape' | 'barriers' | 'buildings' | 'lots';
export type ListPart = 'terrainStamps' | 'terrainPaint' | 'fogDabs' | 'gullyDabs' | 'clouds' | 'trees' | 'treeClearings' | 'elements'
  | 'zones' | 'zoneMarks' | 'lotKeys' | 'people';
export type ValuePart = 'terrainRelief' | 'markingStyle' | 'nature' | 'fogSettings' | 'gullyAuto' | 'weather' | 'economy' | 'transit'
  | 'nextZoneId' | 'nextLotId' | 'allocators';
/** The lists the document holds itself (the lots' keys are the lot store's): what a working copy shares until it writes (`RoadDoc.fork`). */
type DocListPart = Exclude<ListPart, 'lotKeys'>;
/** The lists with a cap, each item placed (`OWNER.at`). */
type CappedPart = 'terrainStamps' | 'terrainPaint' | 'fogDabs' | 'gullyDabs' | 'trees' | 'treeClearings' | 'elements';
/** DECISION 5.1 (the player's, 2026-10-17): each list's cap is a TILE's, and past it the new item is refused with a word to the player; nothing is ever taken away for it. */
const TILE_CAPS: Readonly<Record<CappedPart, number>> = {
  terrainStamps: MAX_TERRAIN_STAMPS, terrainPaint: MAX_PAINT_DABS, fogDabs: MAX_FOG_DABS, gullyDabs: MAX_GULLY_DABS,
  trees: MAX_PLANTED_TREES, treeClearings: MAX_TREE_CLEARINGS, elements: MAX_ELEMENTS,
};
const DOC_LISTS: readonly DocListPart[] = ['terrainStamps', 'terrainPaint', 'fogDabs', 'gullyDabs', 'clouds', 'trees', 'treeClearings', 'elements', 'zones', 'zoneMarks', 'people'];
/** The indices by place a working copy reads from the original until it writes their kind (`RoadDoc.ownIndex`). */
type IndexKind = 'poles' | 'barriers' | 'landscape';
const INDEX_KINDS: readonly IndexKind[] = ['poles', 'barriers', 'landscape'];
/** The kinds the roads' changes are written under (`roadsChanged`). */
const ROAD_KINDS: readonly DocChangeKind[] = ['roads', 'traffic'];
/** The diary kind each list is written under. */
export const LIST_KINDS: Readonly<Record<ListPart, DocChangeKind>> = {
  terrainStamps: 'terrain', terrainPaint: 'paint', fogDabs: 'fog', gullyDabs: 'gullies', clouds: 'clouds', trees: 'trees',
  treeClearings: 'clearings', elements: 'elements', zones: 'zones', zoneMarks: 'zones', lotKeys: 'lotKeys', people: 'people',
};
/** What undo or redo puts back: records (undefined: none), stretches of lists (`splice`), values. */
/** What a tile holds in the page's document now (`RoadDoc.tileMembers`). */
interface TileMembers {
  readonly square: ChangeRect;
  readonly nodes: RoadNode[];
  readonly borrowedNodes: RoadNode[];
  readonly segments: RoadSegment[];
  readonly poles: UtilityPole[];
  readonly borrowedPoles: UtilityPole[];
  readonly spans: UtilitySpan[];
  readonly landscape: LandscapeItem[];
  readonly barriers: Barrier[];
  readonly buildings: Building[];
  readonly lots: Lot[];
  readonly lotKeys: string[];
  readonly paint: PaintDab[];
  readonly trees: PlantedTree[];
  readonly elements: ElementItem[];
}

/** A tile's next ids, by kind (`TileRecords.next`). */
type TileNext = { -readonly [K in keyof TileRecords['next']]: number };

/** A tile never written yet counts from the start of its range. */
const freshTileNext = (key: number): TileNext => {
  const base = tileIdBase(key);
  return { node: base, segment: base, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base };
};

/** A tile's counters as written, raised past every id of its range its records hold: a counter written behind (an old save, a tile made by hand) never hands out an id in use, which would overwrite that record. */
function tileNextOf(records: TileRecords): TileNext {
  const base = tileIdBase(records.key);
  const next: TileNext = { ...records.next };
  const above = (kind: keyof TileNext, list: readonly unknown[]): void => {
    next[kind] = Math.max(next[kind], base);
    for (const r of list) {
      const id = (r as { readonly id?: unknown }).id;
      if (typeof id === 'number' && id >= next[kind] && id < base + TILE_COUNTED) next[kind] = id + 1;
    }
  };
  above('node', records.nodes); above('segment', records.segments); above('pole', records.poles); above('span', records.poleSpans);
  above('building', records.buildings); above('lot', records.lots); above('landscape', records.landscape); above('barrier', records.barriers);
  return next;
}

/** How far a span reaches past its pole: the longest a wire runs (`roads/powerLine.ts` spans are tens of metres; a margin). */
const SPAN_REACH = m(200);

/** A place on the world, copied and held within the world's reach (`bounds.ts` WORLD_HALF, thousands of km: no map edge, only numbers kept finite). */
const onWorld = (p: { readonly x: number; readonly y: number }): { x: number; y: number } => clampToWorld(p);

/** Where a lot key says its land lies (`lots.ts` keys: `b:` a block's middle, `s:` a strip's, in steps of 4 m). */
/** A stored node as a document holds it, at `at`, before its roads: what names a road comes after them (`finishNode`). */
function nodeRecord(n: SerializedDoc['nodes'][number], at: { readonly x: number; readonly y: number }): RoadNode {
  const heightOffset = Number.isFinite(n.heightOffset) ? (n.heightOffset as number) : 0;
  return {
    id: asNodeId(n.id), x: at.x, y: at.y, heightOffset, smooth: n.smooth ?? false,
    incident: [], control: n.control ?? 'auto',
    blockedMovements: n.blockedMovements ? [...n.blockedMovements] : [],
  };
}

/** A stored road between nodes `a` and `b` as a document holds it. */
function segmentRecord(s: SerializedDoc['segments'][number], a: NodeId, b: NodeId): RoadSegment {
  const section = normalizeRoadSection(s.section);
  const parking = normalizeParking(s.parking);
  return {
    id: asSegmentId(s.id),
    a,
    b,
    type: s.type,
    curve: s.curve ?? null,
    dashOrigin: s.dashOrigin ?? 0,
    direction: s.direction ?? 'both',
    lanes: normaliseLaneCount(s.lanes ?? null, s.direction ?? 'both'),
    ...(section ? { section } : {}),
    ...(parking ? { parking } : {}),
    // Through the migration, so a level that has since been merged into another (`viaduct`) loads as the one it became.
    structure: migrateStructure(s.structure) ?? 'ground',
    ...(s.cutWalls === true ? { cutWalls: true as const } : {}),
  };
}

/** What of a stored node names its roads, put on it once its roads are in (`incident`): a crossing only on a two-road node that still holds its road, the player's lane connections (kept as stored: a link to a lane that is gone is left out of the build, `lanelets.ts`), rules, signal, end, U-turn. */
function finishNode(node: RoadNode, n: SerializedDoc['nodes'][number]): void {
  const crossing = n.crossing;
  if (crossing && (crossing.kind === 'zebra' || crossing.kind === 'signal')) {
    node.crossing = { kind: crossing.kind, segment: asSegmentId(crossing.segment) };
    dropStaleCrossing(node);
  }
  const links = normalizeLaneLinks(n.laneLinks);
  if (links) node.laneLinks = links;
  const rules = normalizeApproachRules(n.approachRules);
  if (rules) node.approachRules = rules;
  const signal = normalizeSignalSettings(n.signal);
  if (signal) node.signal = signal;
  if (n.end === 'bulb') node.end = 'bulb';
  if (typeof n.uturn === 'number' && node.incident.includes(asSegmentId(n.uturn))) node.uturn = asSegmentId(n.uturn);
}

/** A stored landscape item, or null when it is not one; `repair`: kept on the map. */
function landscapeRecord(raw: NonNullable<SerializedDoc['landscape']>[number], repair: boolean): LandscapeItem | null {
  if (!isLandscapeKind(raw?.kind) || !Number.isFinite(raw.x) || !Number.isFinite(raw.y) || !Number.isInteger(raw.id)) return null;
  const at = repair ? onWorld(raw) : { x: raw.x, y: raw.y };
  return { id: raw.id, kind: raw.kind, x: at.x, y: at.y,
    ...(isSignType(raw.signType) ? { signType: raw.signType } : {}),
    ...(typeof raw.text === 'string' && raw.text ? { text: raw.text.slice(0, SIGN_TEXT_MAX) } : {}),
    ...(Number.isFinite(raw.planted) ? { planted: raw.planted } : {}) };
}

/** A stored wall, fence or hedge, or null when it is not one (fewer than two points). */
function barrierRecord(raw: NonNullable<SerializedDoc['barriers']>[number], repair: boolean): Barrier | null {
  if (!isBarrierKind(raw.kind) || !Array.isArray(raw.points)) return null;
  const points = raw.points.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    .map((p) => (repair ? onWorld(p) : { x: p.x, y: p.y }));
  return points.length < 2 ? null : { id: raw.id, kind: raw.kind, points };
}

/** A tile's buildings not prepared by a worker (`preparedTiles`), each through `migrateBuilding` as a map's are (`BuildingStore.load`). */
function migratedBuildings(raw: TileRecords['buildings']): Building[] {
  const store = new BuildingStore();
  store.load(raw as unknown as readonly unknown[]);
  return [...store.all()];
}

/** A stored lot as a store keeps it: its own corners (a stored record is never changed in place, and the data read may be), its building only if it stands. */
function lotRecord(lot: Lot, standing: (id: number) => boolean): Lot {
  const { building: _gone, ...free } = { ...lot, corners: lot.corners.map((q) => ({ x: q.x, y: q.y })) };
  return lot.building !== undefined && standing(lot.building) ? { ...free, building: lot.building } : free;
}

function lotKeyPlace(key: string): { x: number; y: number } | null {
  const [x, y] = key.slice(2).split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: x! * m(4), y: y! * m(4) } : null;
}

/** A tile as the store keeps it (`TileStore`): the records it owns, as a saved map holds them, and the ends of its roads and spans that are its neighbours' */
/** The tiles whose buildings a worker prepared (`editor/tileStore.ts` `prepareTile`: migrated and interned there): `loadTile` files them as they are. A set beside the records, never a field of them: every list field of `TileRecords` is a list. */
export const preparedTiles = new WeakMap<TileRecords, PreparedGrown | null>();

/** A prepared tile's grown rows and the buildings made from them (`editor/tileStore.ts` preparedRecords), each the very record so made: a record is replaced, never edited (`BuildingStore`), so one still in `made` is exactly its row's, written back as the row (`tileRecords`). */
export interface PreparedGrown {
  readonly rows: GrownRows;
  readonly made: WeakSet<object>;
}

export interface TileRecords {
  readonly key: number;
  /** Written again at each change of the tile (the store's), for what is baked from it (far levels, link tables) to know it is stale. */
  readonly version: number;
  readonly nodes: SerializedDoc['nodes'];
  /** The nodes of other tiles its roads end on, as they were when written: put in the document only while their own tile is not. */
  readonly borrowedNodes: SerializedDoc['nodes'];
  readonly segments: SerializedDoc['segments'];
  /** Every car gate and parking edge of its buildings (`parkingLayout.ts` gatesOf), four numbers each: what its streets' parking keeps clear of, for a bake of its roads that does not read its buildings (`render/nearRoadTiles.ts`); none in a tile written before it was kept. */
  readonly gates?: readonly number[];
  readonly poles: NonNullable<SerializedDoc['poles']>;
  readonly borrowedPoles: NonNullable<SerializedDoc['poles']>;
  readonly poleSpans: NonNullable<SerializedDoc['poleSpans']>;
  readonly buildings: readonly unknown[];
  /** The buildings its generator grew, as rows (`growth/rows.ts`): made records again by whoever reads them (`growth/grownRows.ts` `tileBuildingsOf`). */
  readonly grown?: GrownRows;
  readonly lots: readonly Lot[];
  readonly lotKeys: readonly string[];
  readonly landscape: NonNullable<SerializedDoc['landscape']>;
  readonly barriers: NonNullable<SerializedDoc['barriers']>;
  readonly paint: NonNullable<SerializedDoc['paint']>;
  readonly trees: NonNullable<SerializedDoc['trees']>;
  readonly elements: NonNullable<SerializedDoc['elements']>;
  /** The next id each kind counts out in the tile's range (`TILE_COUNTED`), from `tileIdBase`. */
  readonly next: Readonly<Record<'node' | 'segment' | 'pole' | 'span' | 'building' | 'lot' | 'landscape' | 'barrier', number>>;
}

/** An edit as a command and its inverse (`beginEdit`/`endEdit`, `world/docImage.ts`): the states before and after of what it changed. */
export interface DocPatch {
  readonly records: readonly { readonly part: RecordPart; readonly id: number; readonly before: unknown; readonly after: unknown }[];
  readonly lists: readonly { readonly part: ListPart; readonly start: number; readonly before: readonly unknown[]; readonly after: readonly unknown[] }[];
  readonly values: readonly { readonly part: ValuePart; readonly before: unknown; readonly after: unknown }[];
  /** The whole map before and after as its text (`RoadDoc.toText`), when the edit replaced it whole (a map opened, a city generated). */
  readonly whole?: { readonly before: string; readonly after: string | null };
  /** Roughly what it holds, UTF-16 bytes of its text. */
  readonly bytes: number;
}

const textBytes = (value: unknown): number => (value === undefined ? 0 : 2 * JSON.stringify(value).length);

/** What a step that replaced the whole map holds: its texts, UTF-16 bytes, read off their lengths. */
export const wholeBytes = (before: string, after: string | null): number => 2 * (before.length + (after?.length ?? 0));

/** What a patch holds, UTF-16 bytes of its text (`editor/history.ts` keeps the steps under a budget). */
function patchBytes(records: DocPatch['records'], lists: DocPatch['lists'], values: DocPatch['values']): number {
  let bytes = 0;
  for (const r of records) bytes += textBytes(r.before) + (r.part === 'buildings' || r.part === 'lots' ? 0 : textBytes(r.after));
  for (const l of lists) bytes += textBytes(l.before) + textBytes(l.after);
  for (const v of values) bytes += textBytes(v.before) + textBytes(v.after);
  return bytes;
}

export interface Restoration {
  readonly records: readonly { readonly part: RecordPart; readonly id: number; readonly value: unknown }[];
  /** The whole map as its text, when the edit replaced it whole (`RoadDoc.replaceWith`): put back as it is, nothing else. */
  readonly whole?: string;
  readonly lists: readonly { readonly part: ListPart; readonly start: number; readonly remove: number; readonly items: readonly unknown[] }[];
  readonly values: readonly { readonly part: ValuePart; readonly value: unknown }[];
}

/** The map's parts no tile holds (`RoadDoc.worldPart`), each named as the diary's kind that changes it (`allocators`: the map's own id allocators). */
export type WorldPart = 'terrain' | 'markingStyle' | 'nature' | 'fog' | 'gullies' | 'clouds' | 'weather' | 'clearings' | 'zones' | 'people' | 'transit' | 'economy' | 'allocators';
export const WORLD_PARTS: readonly WorldPart[] = ['terrain', 'markingStyle', 'nature', 'fog', 'gullies', 'clouds', 'weather', 'clearings', 'zones', 'people', 'transit', 'economy', 'allocators'];

export interface SerializedDoc {
  readonly version: 1;
  /** Metres per world unit the map was saved in (`world/units.ts`); absent: 0.4, every map before 2026-10-10 (`rescale.ts`). */
  readonly unit?: number;
  readonly nodes: readonly {
    id: number; x: number; y: number; heightOffset?: number; smooth?: boolean;
    control?: JunctionControl; blockedMovements?: readonly string[];
    crossing?: { kind: NodeCrossingKind; segment: number };
    /** The player's lane connections; absent on every older map. */
    laneLinks?: readonly { from: number; fromLane: number; to: number; toLane: number }[];
    /** Each leg's rule; absent on every older map. */
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
    /** Retaining walls in its cutting; absent on every older map. */
    cutWalls?: boolean;
  }[];
  readonly terrain?: readonly TerrainStamp[];
  /** `ReliefVersion`; absent on maps made before the natural landform. */
  readonly relief?: number;
  /** The regional standard of the road paint; absent: 'classic'. */
  readonly markingStyle?: string;
  /** The ecosystem (`NatureSettings`); absent on maps made before it. */
  readonly nature?: { readonly region: string; readonly seed: number };
  /** The utility network. */
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
  /** Modular buildings. */
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
  /** The map's own allocators' next ids (`allocatorMarks`): written with the streamed world's values only (`worldValues`). */
  readonly allocators?: readonly number[];
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
/** A node's record copied whole, nothing aliased (`clone`, `replaceContents`). */
function copyNode(node: RoadNode): RoadNode {
  return {
    id: node.id, x: node.x, y: node.y, heightOffset: node.heightOffset, smooth: node.smooth,
    incident: [...node.incident], control: node.control,
    blockedMovements: [...node.blockedMovements],
    ...(node.crossing ? { crossing: { ...node.crossing } } : {}),
    ...(node.laneLinks ? { laneLinks: node.laneLinks.map((l) => ({ ...l })) } : {}),
    ...(node.approachRules ? { approachRules: node.approachRules.map((e) => ({ ...e })) } : {}),
    ...(node.signal ? { signal: { ...node.signal, ...(node.signal.greens ? { greens: [...node.signal.greens] } : {}) } } : {}),
    ...(node.end ? { end: node.end } : {}),
    ...(node.uturn !== undefined ? { uturn: node.uturn } : {}),
  };
}

/** A segment's record copied whole (`clone`, `replaceContents`). */
function copySegment(segment: RoadSegment): RoadSegment {
  return {
    ...segment,
    curve: segment.curve ? { ...segment.curve } : null,
    ...(segment.section ? { section: cloneRoadSection(segment.section) } : {}),
    ...(segment.parking ? { parking: { ...segment.parking } } : {}),
  };
}

/** A cloud placed, its keys in the order a map read back has them (`readCloud`): DO NOT let an undo of the whole map write them in another. */
const placedCloud = (v: Omit<PlacedCloud, 'id'>, id: number): PlacedCloud =>
  ({ id, x: v.x, y: v.y, height: v.height, size: v.size, density: v.density, yaw: v.yaw });

/** Around a junction with no road yet, world units. */
const NODE_PAD = 30;
/** Side of the cells the street furniture is filed in (`RoadDoc.landscapeIn`), world units. */
const LANDSCAPE_CELL = m(32);
/** Around a pole, a bench, a tree, a fence: what stands round it. */
const ITEM_PAD = 6;

const circleRect = (c: { readonly x: number; readonly y: number; readonly radius: number }): ChangeRect =>
  [c.x - c.radius, c.y - c.radius, c.x + c.radius, c.y + c.radius];

/** One box round circles (dabs, stamps, clearings), as the diary takes it: where they all lay; none for none. */
function circlesBox(items: readonly { readonly x: number; readonly y: number; readonly radius: number }[]): ChangeRect[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of items) {
    minX = Math.min(minX, c.x - c.radius); minY = Math.min(minY, c.y - c.radius);
    maxX = Math.max(maxX, c.x + c.radius); maxY = Math.max(maxY, c.y + c.radius);
  }
  return minX <= maxX ? [[minX, minY, maxX, maxY]] : [];
}

/** The box round elements, grown by the largest one's size; null for none. */
function elementsBox(items: readonly ElementItem[]): ChangeRect | null {
  let pad = ITEM_PAD;
  for (const e of items) pad = Math.max(pad, e.size);
  return rectAround(items, pad);
}

/** The box round a stretch of one of the document's lists (`RoadDoc.restore`) */
function listBox(part: ListPart, items: readonly unknown[]): ChangeRect | null | undefined {
  if (items.length === 0) return null;
  switch (part) {
    case 'terrainStamps': case 'terrainPaint': case 'fogDabs': case 'gullyDabs': case 'treeClearings':
      return circlesBox(items as readonly { x: number; y: number; radius: number }[])[0] ?? null;
    case 'trees': return rectAround(items as readonly PlantedTree[], ITEM_PAD);
    case 'elements': return elementsBox(items as readonly ElementItem[]);
    case 'clouds': {
      let pad = 0;
      for (const c of items as readonly PlacedCloud[]) pad = Math.max(pad, c.size);
      return rectAround(items as readonly PlacedCloud[], pad);
    }
    default: return undefined;
  }
}

/** `list.splice(start, remove, ...items)` without spreading `items` into arguments: a stretch of tens of thousands */
function spliceIn<T>(list: T[], start: number, remove: number, items: readonly T[]): T[] {
  const tail = list.splice(start + remove);
  const gone = list.splice(start, remove);
  for (const item of items) list.push(item);
  for (const item of tail) list.push(item);
  return gone;
}

/** Whether a node's change moves the plan the traffic runs on */
function nodeMovesTraffic(p: RoadNode | undefined, q: RoadNode | undefined): boolean {
  if (!p || !q) return true;
  if ((p.heightOffset < -TUNNEL_HEADROOM) !== (q.heightOffset < -TUNNEL_HEADROOM)) return true;
  return !sameNode(p, { ...q, heightOffset: p.heightOffset });
}

/** Whether a source document changed any of these kinds since it was copied (`RoadDoc.movedIn`). */
type MovedKinds = (...kinds: readonly DocChangeKind[]) => boolean;

/** Where two documents' roads differ: every segment and node that is new, gone or changed */
function roadDifferences(a: RoadDoc, b: RoadDoc): { rects: ChangeRect[]; nodes: number[]; segments: number[]; traffic: boolean } {
  const rects: ChangeRect[] = [];
  const nodes: number[] = [], segments: number[] = [];
  // Every segment that differs moves the traffic's plan (`markSegment`); a node only by more than its height
  let traffic = false;
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
    segments.push(id);
    traffic = true;
    add(a.segmentRect(id));
    if (q) add(b.segmentRect(id));
  }
  for (const id of b.segments.keys()) {
    if (a.segments.has(id)) continue;
    segments.push(id);
    traffic = true;
    add(b.segmentRect(id));
  }
  // The nodes by id too, as `markNode` writes them: a reader by id (the undo image) reads them.
  for (const [id, p] of a.nodes) {
    const q = b.nodes.get(id);
    if (q && sameNode(p, q)) continue;
    if (nodeMovesTraffic(p, q)) traffic = true;
    nodes.push(id);
    add(a.nodeRect(id));
    if (q) add(b.nodeRect(id));
  }
  for (const id of b.nodes.keys()) if (!a.nodes.has(id)) { traffic = true; nodes.push(id); add(b.nodeRect(id)); }
  return { rects, nodes, segments, traffic };
}

/** The land's stamps added, gone or changed between two lists, by id. */
function stampDifferences(a: readonly TerrainStamp[], b: readonly TerrainStamp[]): { rects: ChangeRect[]; ids: number[] } {
  const rects: ChangeRect[] = [];
  const ids: number[] = [];
  const mine = new Map(a.map((s) => [s.id, s]));
  const theirs = new Map(b.map((s) => [s.id, s]));
  for (const [id, s] of mine) {
    const t = theirs.get(id);
    if (t && sameText(s, t)) continue;
    ids.push(id);
    rects.push(circleRect(s));
    if (t) rects.push(circleRect(t));
  }
  for (const [id, t] of theirs) if (!mine.has(id)) { ids.push(id); rects.push(circleRect(t)); }
  return { rects, ids };
}

/** Where two documents' poles and wires, landscaping and barriers differ. */
function itemDifferences(a: RoadDoc, b: RoadDoc, moved: MovedKinds): { utilities: ChangeRect[]; landscape: ChangeRect[]; barriers: ChangeRect[] } {
  const utilities: ChangeRect[] = [], landscape: ChangeRect[] = [], barriers: ChangeRect[] = [];
  const at = (p: { x: number; y: number }): ChangeRect => rectAround([p], ITEM_PAD)!;
  if (moved('utilities')) {
    for (const [id, p] of a.poles) { const q = b.poles.get(id); if (!q || p.x !== q.x || p.y !== q.y || p.lamp !== q.lamp) { utilities.push(at(p)); if (q) utilities.push(at(q)); } }
    for (const [id, q] of b.poles) if (!a.poles.has(id)) utilities.push(at(q));
    const spanRect = (doc: RoadDoc, s: UtilitySpan): ChangeRect | null => {
      const p = doc.poles.get(s.a), q = doc.poles.get(s.b);
      return p && q ? rectAround([p, q], ITEM_PAD) : null;
    };
    for (const [id, s] of a.poleSpans) { const t = b.poleSpans.get(id); if (!t || t.a !== s.a || t.b !== s.b) { const r = spanRect(a, s); if (r) utilities.push(r); } }
    for (const [id, t] of b.poleSpans) if (!a.poleSpans.has(id)) { const r = spanRect(b, t); if (r) utilities.push(r); }
  }
  if (moved('landscape')) {
    for (const [id, p] of a.landscape) {
      const q = b.landscape.get(id);
      if (q && p.kind === q.kind && p.x === q.x && p.y === q.y && p.signType === q.signType && p.text === q.text && p.planted === q.planted) continue;
      landscape.push(at(p));
      if (q) landscape.push(at(q));
    }
    for (const [id, q] of b.landscape) if (!a.landscape.has(id)) landscape.push(at(q));
  }
  if (moved('barriers')) {
    for (const [id, p] of a.barriers) {
      const q = b.barriers.get(id);
      if (q && sameText(p, q)) continue;
      barriers.push(rectAround(p.points, ITEM_PAD)!);
      if (q) barriers.push(rectAround(q.points, ITEM_PAD)!);
    }
    for (const [id, q] of b.barriers) if (!a.barriers.has(id)) barriers.push(rectAround(q.points, ITEM_PAD)!);
  }
  return { utilities, landscape, barriers };
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

/** Things standing at a point (an element of the brush), by the cell of their point */
class ItemGrid<T extends { readonly x: number; readonly y: number }> {
  private readonly cells = new Map<number, Set<T>>();
  constructor(private readonly side: number) {}
  private keyOf(x: number, y: number): number { return (Math.floor(x / this.side) + 32768) * 65536 + (Math.floor(y / this.side) + 32768); }
  add(item: T): void {
    const key = this.keyOf(item.x, item.y);
    const set = this.cells.get(key);
    if (set) set.add(item); else this.cells.set(key, new Set([item]));
  }
  remove(item: T): void {
    const key = this.keyOf(item.x, item.y);
    const set = this.cells.get(key);
    if (!set) return;
    set.delete(item);
    if (set.size === 0) this.cells.delete(key);
  }
  /** The items in the cells a rectangle reaches. */
  near(rect: ChangeRect): T[] {
    const out: T[] = [];
    for (let i = Math.floor(rect[0] / this.side); i <= Math.floor(rect[2] / this.side); i++) {
      for (let j = Math.floor(rect[1] / this.side); j <= Math.floor(rect[3] / this.side); j++) {
        for (const item of this.cells.get((i + 32768) * 65536 + (j + 32768)) ?? []) out.push(item);
      }
    }
    return out;
  }
}

/** Keeps in `list`, in order and in place, the items `keep` says; one pass. */
function keepWhere<T>(list: T[], keep: (item: T) => boolean): void {
  let at = 0;
  for (const item of list) if (keep(item)) list[at++] = item;
  list.length = at;
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
  // The control the crossing put there goes with it, so the new junction picks its own
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

/** What an edit keeps while it is recorded (`RoadDoc.beginEdit`): each thing's state before its first write. */
interface EditRecorder {
  readonly records: Map<RecordPart, Map<number, unknown>>;
  readonly lists: Map<ListPart, unknown[]>;
  readonly values: Map<ValuePart, unknown>;
  /** The map before, as its text (`toText`). */
  whole: string | null;
}

const VALUE_PARTS: readonly ValuePart[] = ['terrainRelief', 'markingStyle', 'nature', 'fogSettings', 'gullyAuto', 'weather', 'economy', 'transit', 'nextZoneId', 'nextLotId', 'allocators'];

/** A record kept apart from the one that goes on being written: the roads' copied as the fork copies them, the stores' by reference */
function copyRecord(part: RecordPart, value: unknown): unknown {
  if (value === undefined) return undefined;
  switch (part) {
    case 'nodes': return copyNode(value as RoadNode);
    case 'segments': return copySegment(value as RoadSegment);
    case 'buildings': case 'lots': return value;
    default: return structuredClone(value);
  }
}

const copyItem = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

/** The parts of what a map saved by tiles keeps outside its tiles, each written again only when its kinds change: the single values, the land's keys, the people, the transport. */
export const GLOBAL_PARTS = ['values', 'lotKeys', 'people', 'transit'] as const;
export type GlobalPart = (typeof GLOBAL_PARTS)[number];

/** What a map saved by tiles keeps outside its tiles (`RoadDoc.savedGlobals`): what has no place on the map. */
export interface SavedGlobals {
  readonly version: 1;
  readonly unit?: number;
  readonly relief?: number;
  readonly markingStyle?: string;
  readonly nature?: { readonly region: string; readonly seed: number };
  readonly weather?: unknown;
  readonly fogSettings?: unknown;
  readonly gullyAuto?: number;
  readonly lotKeys?: readonly string[];
  readonly people?: readonly unknown[];
  readonly transit?: unknown;
  readonly economy?: { readonly balance: number };
}

/** A node as the file holds it (`toJSON`, a map saved by tiles): copied, never aliased. */
export function savedNode(n: RoadNode): SerializedDoc['nodes'][number] {
  return {
    id: n.id, x: n.x, y: n.y, heightOffset: n.heightOffset, smooth: n.smooth,
    control: n.control, blockedMovements: [...n.blockedMovements],
    ...(n.crossing ? { crossing: { kind: n.crossing.kind, segment: n.crossing.segment } } : {}),
    ...(n.laneLinks ? { laneLinks: n.laneLinks.map((l) => ({ ...l })) } : {}),
    ...(n.approachRules ? { approachRules: n.approachRules.map((e) => ({ ...e })) } : {}),
    ...(n.signal ? { signal: { ...n.signal, ...(n.signal.greens ? { greens: [...n.signal.greens] } : {}) } } : {}),
    ...(n.end ? { end: n.end } : {}),
    ...(n.uturn !== undefined ? { uturn: n.uturn as number } : {}),
  };
}

/** DO NOT write records in the map's insertion order: an undo puts a removed record back at the end, and the map saved would not be the map it undid to. The file holds them by id (a load's order). */
function inIdOrder<T extends { readonly id: number }>(records: Iterable<T>): T[] {
  const list = [...records];
  // Nearly always in order already (ids grow): sorted only when one came back.
  for (let i = 1; i < list.length; i++) if (list[i - 1]!.id > list[i]!.id) return list.sort((a, b) => a.id - b.id);
  return list;
}

/** A segment as the file holds it. */
export function savedSegment(s: RoadSegment): SerializedDoc['segments'][number] {
  return {
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
  };
}

/** A pole, a span, a landscaping item and a barrier as the file holds them. */
export const savedPole = (p: UtilityPole): NonNullable<SerializedDoc['poles']>[number] => ({ id: p.id, x: p.x, y: p.y, lamp: p.lamp });
export const savedSpan = (s: UtilitySpan): NonNullable<SerializedDoc['poleSpans']>[number] => ({ id: s.id, a: s.a, b: s.b });
export const savedLandscape = (item: LandscapeItem): NonNullable<SerializedDoc['landscape']>[number] => ({ id: item.id, kind: item.kind, x: item.x, y: item.y,
  ...(item.signType ? { signType: item.signType } : {}), ...(item.text ? { text: item.text } : {}),
  ...(item.planted !== undefined ? { planted: item.planted } : {}) });
export const savedBarrier = (b: Barrier): NonNullable<SerializedDoc['barriers']>[number] => ({ id: b.id, kind: b.kind, points: b.points.map((p) => ({ x: p.x, y: p.y })) });

/** Each of `items` pushed onto `into`, in order. DO NOT spread a whole map's list into `push` (EDT-14): its arguments past the engine's stack (~100 000) threw RangeError. */
function pushAll<T>(into: T[], items: readonly T[]): void {
  for (let i = 0; i < items.length; i++) into.push(items[i]!);
}
