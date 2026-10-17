import { measureHitch } from '@core/hitch';
import { ForkMap, ForkSet } from '@core/forkMap';
import { MIN_RIBBON } from '@core/scalar';
import { type Vec2, dot } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { NodeCrossing } from './doc';
import type { NodeId, SegmentId } from './ids';
import { PolylineCache, orientedPolyline, segmentStartsAt } from './geometry';
import { Level, type SurfaceLevel, footwayOn, roadProfile, roadType } from './roadTypes';
import type { Junction } from './junction/build';
import { TRANSITION_BEND } from './junction/transition';
import { WalkableSurface } from './walkable';
import {
  CROSSWALK_CAP,
  CROSSWALK_DEPTH,
  MIN_LINK_LENGTH,
  STOP_BAR_SETBACK,
  STOP_LINE_CAP,
  crosswalkDistance as crosswalkAt,
  stopLineDistance as stopLine,
} from './approach';
import { CellFiling } from './cells';
import { followRamps } from './curbRamps';
import { m } from './units';
import type { ChangeRect } from './changes';
import { type NetworkBake, NetworkBuild } from './networkBuild';
import type { SegmentRibbon, SegmentTrims } from './ribbons';
import { DeltaLog, type NetworkDelta } from './networkDelta';
import type { PoleLineState } from './poleLines';


export type { SegmentRibbon, SegmentTrims } from './ribbons';
export type { NetworkBake } from './networkBuild';

/** All geometry derived from the authoring document. */
/** A crossing's landing on the footways (`Network.crossingLandingAt`): kept clear of everything. */
export interface CrossingLanding {
  readonly x: number;
  readonly y: number;
  readonly tx: number;
  readonly ty: number;
  readonly across: number;
  readonly structure: string;
}

export class Network {
  /** The footway the crossings are fitted to, by cell (`walkable.ts`): kept across rebuilds. */
  private crossingWalkable: WalkableSurface | null = null;
  /** DO NOT clear it on every rebuild: every edit then fitted every crossing of the map again for whoever asked next. */
  private readonly crossingDistances = new Map<SegmentId, Map<NodeId, number>>();
  /** DO NOT work a landing out again for each asker. */
  private readonly crossingLandings = new Map<SegmentId, Map<NodeId, CrossingLanding | null>>();
  /** The junctions and ribbons by id, in the order the rebuilds filed them, never id order: a reader that needs id order sorts what it takes (`CellFiling.idsMeeting`). */
  readonly junctions = new Map<NodeId, Map<SurfaceLevel, Junction>>();
  readonly ribbons = new Map<SegmentId, SegmentRibbon>();
  /** The ribbons and the junctions filed by the cells their surfaces reach (`world/cells.ts`) */
  readonly segmentCells = new CellFiling<SegmentId, SegmentRibbon>();
  readonly junctionCells = new CellFiling<NodeId, ReadonlyMap<SurfaceLevel, Junction>>();
  /** The ribbons with a footway laid flush on a side, filed like `segmentCells` */
  readonly flushCells = new CellFiling<SegmentId, SegmentRibbon>();
  /** DO NOT go back to a rank of every ribbon made again at each revision (`ribbonOrder`) */
  ribbonsMeeting(rect: ChangeRect): SegmentRibbon[] {
    const out: SegmentRibbon[] = [];
    for (const id of this.segmentCells.idsMeeting(rect)) {
      const ribbon = this.ribbons.get(id);
      if (ribbon) out.push(ribbon);
    }
    return out;
  }

  /** Nodes the editor would refuse to create, with the gap that condemns them, in radians. */
  readonly impossible = new Map<NodeId, number>();
  /** Junctions whose legs are too short to separate their lanes, with how far */
  readonly squeezed = new Map<NodeId, number>();
  readonly trims = new Map<SegmentId, SegmentTrims>();
  /** How far along each leg a junction's flat plate reaches, keyed `node:segment` */
  readonly plateReach = new Map<string, number>();
  /** Nodes where one road carries on at another width, built as a taper rather than as a junction (`junction/transition.ts`). */
  readonly transitions = new Set<NodeId>();
  readonly polylines = new PolylineCache();
  /** What the pole lines keep of this network (`poleLines.ts` `PoleLineState`) */
  poleLines: PoleLineState | null = null;
  /** The network this one is a working copy of (`fork`), its maps laid over that one's; null for a network of its own. */
  forkedFrom: Network | null = null;

  /** Matches `RoadDoc.revision` at the time of the last rebuild. */
  revision = -1;
  /** Road plan revision; vertical-only edits leave it unchanged. */
  trafficRevision = -1;

  /** The incremental build: what each piece was made from (`networkBuild.ts`). */
  private readonly build: NetworkBuild;
  /** The states this network has been in and what changed between them (`changesSince`). */
  private readonly log = new DeltaLog();

  constructor(readonly doc: RoadDoc) {
    this.build = new NetworkBuild(this);
  }

  /** Nodes that carry a junction surface. */
  junctionNodes(): NodeId[] {
    return [...this.junctions.keys()];
  }

  junctionAt(node: NodeId, level: SurfaceLevel): Junction | undefined {
    return this.junctions.get(node)?.get(level);
  }

  /** @rebuild Rebuilds every derived surface, INCREMENTALLY */
  rebuild(options: { readonly full?: boolean } = {}): void {
    const started = performance.now();
    if (options.full || this.build.empty) this.clear();
    const delta = this.build.rebuild();
    this.forgetCrossings(delta);
    this.log.advance(delta, this.ribbons.size + this.junctions.size);
    this.revision = this.doc.revision;
    this.trafficRevision = this.doc.trafficRevision;
    // The dropped kerbs follow in this step, never in a walker's read (`curbRamps.ts` `walkingRise`).
    followRamps(this);
    measureHitch(options.full ? 'hitch:network/full' : 'hitch:network/rebuild', started);
  }

  /** The junctions and ribbons of `nodes` and `segments` as this build solved them, for another thread's build (`NetworkBuild.exportBake`). */
  exportBake(nodes: Iterable<NodeId>, segments: Iterable<SegmentId>): NetworkBake {
    return this.build.exportBake(nodes, segments);
  }

  /** A tile's junctions and ribbons solved off the page, taken by the next rebuild where the inputs are the same (`NetworkBuild.takeBakes`). */
  offerBake(bake: NetworkBake): void {
    this.build.offerBake(bake);
  }

  /** What changed since the network was in `state` (a token it handed out, `state`), or null: everything */
  changesSince(state: object | null): NetworkDelta | null {
    return this.log.since(state);
  }

  /** The current state's token, for `changesSince`. */
  get state(): object {
    return this.log.state;
  }

  /** Forgets every derived piece: the next rebuild builds the whole map. */
  private clear(): void {
    this.build.forget();
    this.polylines.clear();
    this.junctions.clear();
    this.ribbons.clear();
    this.trims.clear();
    this.plateReach.clear();
    this.transitions.clear();
    this.impossible.clear();
    this.squeezed.clear();
    this.segmentCells.copyFrom(new CellFiling());
    this.junctionCells.copyFrom(new CellFiling());
    this.flushCells.copyFrom(new CellFiling());
  }

  /** DO NOT copy the network for an edit (`adopt`, twice per road drawn): `work`'s network, layered over this one, holding only what it writes. */
  /** Whether the network is rebuilt up to its document: its derived maps answer for what the document holds. */
  isBuilt(): boolean {
    return this.revision === this.doc.revision;
  }

  fork(work: RoadDoc): Network {
    const copy = new Network(work);
    const own = copy as unknown as Record<string, unknown>;
    own['junctions'] = new ForkMap(this.junctions);
    own['ribbons'] = new ForkMap(this.ribbons);
    own['segmentCells'] = CellFiling.over(this.segmentCells);
    own['junctionCells'] = CellFiling.over(this.junctionCells);
    own['flushCells'] = CellFiling.over(this.flushCells);
    own['impossible'] = new ForkMap(this.impossible);
    own['squeezed'] = new ForkMap(this.squeezed);
    own['trims'] = new ForkMap(this.trims);
    own['plateReach'] = new ForkMap(this.plateReach);
    own['transitions'] = new ForkSet(this.transitions);
    copy.polylines.forkFrom(this.polylines);
    copy.build.forkFrom(this.build);
    copy.log.takeFrom(this.log);
    copy.forkedFrom = this;
    const upToDate = this.isBuilt();
    copy.revision = upToDate ? work.revision : -1;
    copy.trafficRevision = upToDate ? work.trafficRevision : -1;
    return copy;
  }

  /** A working network (`fork`) taken back once its document was (`RoadDoc.takeBack`): only what it wrote, then its state. */
  takeBack(work: Network): void {
    for (const name of ['junctions', 'ribbons', 'impossible', 'squeezed', 'trims', 'plateReach'] as const) {
      const from = work[name] as unknown;
      if (!(from instanceof ForkMap)) throw new Error('Network.takeBack: not a working copy of this network');
      from.applyTo(this[name] as Map<unknown, unknown>);
    }
    this.segmentCells.takeBack(work.segmentCells);
    this.junctionCells.takeBack(work.junctionCells);
    this.flushCells.takeBack(work.flushCells);
    (work.transitions as ForkSet<NodeId>).applyTo(this.transitions);
    this.polylines.takeBack(work.polylines);
    this.build.takeBack(work.build);
    const before = this.log.state;
    this.log.takeFrom(work.log);
    this.forgetCrossings(this.log.since(before));
    this.revision = this.doc.revision;
    this.trafficRevision = this.doc.trafficRevision;
    followRamps(this);
  }

  /** Drops the crossing distances a change of the network may have moved */
  private forgetCrossings(delta: NetworkDelta | null): void {
    if (delta === null) { this.crossingDistances.clear(); this.crossingLandings.clear(); return; }
    for (const seg of delta.segments) { this.crossingDistances.delete(seg); this.crossingLandings.delete(seg); }
    for (const node of delta.nodes) {
      for (const seg of this.doc.node(node)?.incident ?? []) {
        this.crossingDistances.get(seg)?.delete(node);
        this.crossingLandings.get(seg)?.delete(node);
      }
    }
    // Every rectangle in one look (`idsMeetingAny`): one at a time read the cells they share again, and named a road once a rectangle.
    if (delta.rects.length) for (const seg of this.segmentCells.idsMeetingAny(delta.rects)) { this.crossingDistances.delete(seg); this.crossingLandings.delete(seg); }
  }

  /** Where the crossing of `seg` at `node` lands on the footways */
  crossingLandingAt(seg: SegmentId, node: NodeId): CrossingLanding | null {
    const kept = this.crossingLandings.get(seg)?.get(node);
    if (kept !== undefined) return kept;
    let landing: CrossingLanding | null = null;
    const crossing = this.crosswalkDistanceAt(seg, node);
    if (crossing > 0) {
      const segment = this.doc.requireSegment(seg);
      const road = roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking);
      const frame = orientedPolyline(this.doc, segment, node).sampleAt(crossing);
      landing = { x: frame.p.x, y: frame.p.y, tx: frame.t.x, ty: frame.t.y,
        across: road.width / 2 + road.sidewalk + m(0.3), structure: segment.structure };
    }
    let byNode = this.crossingLandings.get(seg);
    if (!byNode) this.crossingLandings.set(seg, byNode = new Map());
    byNode.set(node, landing);
    return landing;
  }

  /** Whether a node is one road carrying on rather than an intersection */
  continues(node: NodeId): boolean {
    const record = this.doc.node(node);
    if (!record || record.incident.length !== 2) return false;
    if (record.control !== 'auto' && record.control !== 'none') return false;
    if (this.junctions.get(node)?.get(Level.Asphalt)?.transition) return true;
    // A continuous two-leg bend has no approach or zebra; the footway follows its outer edge.
    const legs = this.junctions.get(node)?.get(Level.Asphalt)?.legs;
    if (!legs || legs.length !== 2) return true;
    return dot((legs[0] as { dir: Vec2 }).dir, (legs[1] as { dir: Vec2 }).dir) < -Math.cos(TRANSITION_BEND);
  }

  /** Whether a node is a junction of three legs or more. */
  /** The node's authored crossing, while the node still joins exactly two roads. */
  private midBlockCrossing(node: NodeId): NodeCrossing | undefined {
    const n = this.doc.node(node);
    return n?.crossing && n.incident.length === 2 ? n.crossing : undefined;
  }

  /** Whether `seg` is one of two one-way pieces carrying one flow through a priority node. */
  private circulating(seg: SegmentId, node: NodeId): boolean {
    const n = this.doc.node(node);
    if (!n || n.control !== 'priority') return false;
    const arrives = (s: { a: NodeId; b: NodeId; direction: string }): boolean =>
      (s.direction === 'aToB' && s.b === node) || (s.direction === 'bToA' && s.a === node);
    const leaves = (s: { a: NodeId; b: NodeId; direction: string }): boolean =>
      (s.direction === 'aToB' && s.a === node) || (s.direction === 'bToA' && s.b === node);
    const oneWay = n.incident.map((id) => this.doc.segment(id)).filter((s) => !!s && s.direction !== 'both');
    if (!oneWay.some((s) => s!.id === seg)) return false;
    return oneWay.filter((s) => arrives(s!)).length === 1 && oneWay.filter((s) => leaves(s!)).length === 1;
  }

  private isJunction(node: NodeId): boolean {
    return (this.doc.node(node)?.incident.length ?? 0) >= 3;
  }

  /** Distance from a node to this segment's junction mouth, at asphalt level. */
  mouthDistance(seg: SegmentId, node: NodeId): number {
    const s = this.doc.segment(seg);
    if (!s) return 0;
    const t = this.trims.get(seg);
    if (!t) return 0;
    const side = segmentStartsAt(s, node) ? t.a : t.b;
    return side[Level.Asphalt] ?? 0;
  }

  /** Distance from a node at which vehicles must stop on the given segment. */
  stopLineDistance(seg: SegmentId, node: NodeId): number {
    // A mid-block crossing (`RoadNode.crossing`): the paint lies on one piece, its far edge at the node.
    if (this.midBlockCrossing(node)) return CROSSWALK_DEPTH + STOP_BAR_SETBACK;
    const mouth = this.mouthDistance(seg, node);
    if (mouth <= 0 && !this.isJunction(node)) return 0;
    // Nothing stops where a road merely carries on: the link runs to the mouth and the lanes continue across the node.
    if (this.continues(node)) return mouth;
    // Nor where it circulates through a priority node (a roundabout's ring): it has the way, and no crossing lies across it.
    if (this.circulating(seg, node)) return mouth;
    const length = this.polylines.get(this.doc, seg).length;
    // Never let the approach zone eat the whole segment.
    const capped = Math.min(stopLine(mouth), length * STOP_LINE_CAP);
    // ...but the fractional cap may never pull the stop line onto the zebra.
    const crossing = this.crosswalkDistanceAt(seg, node);
    const behindCrossing =
      crossing > 0 ? crossing + CROSSWALK_DEPTH / 2 + STOP_BAR_SETBACK : 0;
    // ...and never inside the junction plate.
    return Math.max(capped, behindCrossing, mouth);
  }

  /** Distance from a node to the centre of this segment's crossing. */
  /** The footway the crossings are fitted to, built once per network */
  crossingSurface(): WalkableSurface {
    return this.crossingWalkable ??= new WalkableSurface(this);
  }

  crosswalkDistanceAt(seg: SegmentId, node: NodeId): number {
    const cached = this.crossingDistances.get(seg)?.get(node);
    if (cached !== undefined) return cached;
    // An authored mid-block crossing is exactly where the player put it
    const placed = this.midBlockCrossing(node);
    if (placed) return placed.segment === seg ? CROSSWALK_DEPTH / 2 : 0;
    // No zebra across a circulating stream: at a priority node where two one-way pieces carry one flow on
    if (this.circulating(seg, node)) return 0;
    // A turning circle is walked round on its footway (`walkways.ts`), not crossed.
    if (this.doc.node(node)?.end === 'bulb' && this.doc.degree(node) === 1) return 0;
    if (this.doc.node(node)?.incident.some((id) => {
      const kind = this.doc.segment(id)?.type;
      return kind !== undefined &&
        (roadType(kind).id === 'highway' || roadType(kind).id === 'ramp');
    })) return 0;
    const mouth = this.mouthDistance(seg, node);
    if (mouth <= 0 && !this.isJunction(node)) return 0;
    if (this.continues(node)) return 0;
    const length = this.polylines.get(this.doc, seg).length;
    const clear = mouth + CROSSWALK_DEPTH / 2 + 1;

    // Both ends of a segment want an approach zone, and a short link cannot give both.
    const halfBudget = Math.max(0, (length - MIN_RIBBON) / 2);
    const segment = this.doc.segment(seg);
    if (!segment) return 0;
    const other = segmentStartsAt(segment, node) ? segment.b : segment.a;
    const oppositeMouth = this.mouthDistance(seg, other);
    const storageCap = length - oppositeMouth - MIN_LINK_LENGTH - CROSSWALK_DEPTH / 2 - STOP_BAR_SETBACK;
    const orderingCap = Math.min(halfBudget - CROSSWALK_DEPTH / 2 - STOP_BAR_SETBACK, storageCap);
    if (orderingCap < clear) return 0;

    const proposed = Math.min(Math.max(crosswalkAt(mouth), clear), length * CROSSWALK_CAP, orderingCap);
    const limit = Math.min(length * CROSSWALK_CAP, orderingCap);
    const profile = roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking);
    // The middle of each side's own footway (an asymmetric road).
    const lateralLeft = profile.width / 2 + footwayOn(profile, 'left') / 2;
    const lateralRight = profile.width / 2 + footwayOn(profile, 'right') / 2;
    const line = this.polylines.get(this.doc, seg);
    const walkable = this.crossingSurface();
    const fits = (distance: number): boolean => {
      const frame = line.sampleAt(segment.a === node ? distance : length - distance);
      const nx = -frame.t.y, ny = frame.t.x;
      return walkable.footway(frame.p.x + nx * lateralLeft, frame.p.y + ny * lateralLeft) &&
        walkable.footway(frame.p.x - nx * lateralRight, frame.p.y - ny * lateralRight);
    };
    const keep = (distance: number): number => {
      let byNode = this.crossingDistances.get(seg);
      if (!byNode) this.crossingDistances.set(seg, byNode = new Map());
      byNode.set(node, distance);
      return distance;
    };
    for (let distance = proposed; distance <= limit; distance += 0.5) {
      if (fits(distance)) return keep(distance);
    }
    return keep(fits(limit) ? limit : 0);
  }
}
