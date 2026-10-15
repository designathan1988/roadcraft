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
import { m } from './units';
import type { ChangeRect } from './changes';
import { NetworkBuild } from './networkBuild';
import type { SegmentRibbon, SegmentTrims } from './ribbons';
import { DeltaLog, type NetworkDelta } from './networkDelta';
import type { PoleLineState } from './poleLines';

/** A `hitch:` entry for the frame monitor, where the platform measures. */
function measureHitch(name: string, start: number): void {
  if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
    performance.measure(name, { start, end: performance.now() });
  }
}

export type { SegmentRibbon, SegmentTrims } from './ribbons';

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
    this.log.advance(delta);
    this.revision = this.doc.revision;
    this.trafficRevision = this.doc.trafficRevision;
    measureHitch(options.full ? 'hitch:network/full' : 'hitch:network/rebuild', started);
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

  /** Takes another network's derived state as the start of its own, without claiming to be up to date */
  seedJunctions(from: Network): void {
    this.copyState(from);
    this.build.copyFrom(from.build, false);
    this.revision = -1;
    this.trafficRevision = -1;
  }

  /** Takes over another network's derived geometry instead of recomputing it. */
  adopt(other: Network): void {
    this.copyState(other);
    this.build.copyFrom(other.build, true);
    this.revision = this.doc.revision;
    this.trafficRevision = this.doc.trafficRevision;
  }

  private copyState(other: Network): void {
    this.junctions.clear();
    for (const [node, byLevel] of other.junctions) this.junctions.set(node, byLevel);
    this.ribbons.clear();
    for (const [seg, ribbon] of other.ribbons) this.ribbons.set(seg, ribbon);
    this.segmentCells.copyFrom(other.segmentCells);
    this.junctionCells.copyFrom(other.junctionCells);
    this.flushCells.copyFrom(other.flushCells);
    this.trims.clear();
    for (const [seg, t] of other.trims) this.trims.set(seg, t);
    this.plateReach.clear();
    for (const [key, reach] of other.plateReach) this.plateReach.set(key, reach);
    this.transitions.clear();
    for (const node of other.transitions) this.transitions.add(node);
    this.impossible.clear();
    for (const [node, gap] of other.impossible) this.impossible.set(node, gap);
    this.squeezed.clear();
    for (const [node, short] of other.squeezed) this.squeezed.set(node, short);
    this.polylines.adopt(other.polylines);
    const before = this.log.state;
    this.log.takeFrom(other.log);
    // The crossing caches belong to the geometry just replaced
    this.forgetCrossings(this.log.since(before));
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
    for (const rect of delta.rects) {
      for (const seg of this.segmentCells.idsMeeting(rect)) { this.crossingDistances.delete(seg); this.crossingLandings.delete(seg); }
    }
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
