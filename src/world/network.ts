import { MIN_RIBBON } from '@core/scalar';
import { type Vec2, dot } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { NodeCrossing } from './doc';
import type { NodeId, SegmentId } from './ids';
import { PolylineCache, segmentStartsAt } from './geometry';
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
import type { ChangeRect } from './changes';
import { NetworkBuild } from './networkBuild';
import type { SegmentRibbon, SegmentTrims } from './ribbons';
import { DeltaLog, type NetworkDelta } from './networkDelta';

/** A `hitch:` entry for the frame monitor and `scripts/probe-hitches.mjs`, where the platform measures. */
function measureHitch(name: string, start: number): void {
  if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
    performance.measure(name, { start, end: performance.now() });
  }
}

export type { SegmentRibbon, SegmentTrims } from './ribbons';

/**
 * All geometry derived from the authoring document.
 *
 * Everything here is rebuilt at commit time and never lazily during drawing.
 * The V6 monolith recomputed junction outlines inside the render loop — seven
 * times per node per frame, each one re-filtering every segment in the world —
 * and let `approachAxis` rebuild signal plans from the renderer (defects 5.7
 * and 3.3). Nothing in this class is reachable from a draw call.
 */
export class Network {
  private crossingWalkable: WalkableSurface | null = null;
  private readonly crossingDistances = new Map<string, number>();
  readonly junctions = new Map<NodeId, Map<SurfaceLevel, Junction>>();
  readonly ribbons = new Map<SegmentId, SegmentRibbon>();
  /**
   * The ribbons and the junctions filed by the cells their surfaces reach
   * (`world/cells.ts`): what is derived from the roads of a place (the pole
   * lines, `poleLines.ts`) reads the cells round it, and is made again only
   * when one of them moves - an edit pays for the cells it reaches.
   */
  readonly segmentCells = new CellFiling<SegmentId, SegmentRibbon>();
  readonly junctionCells = new CellFiling<NodeId, ReadonlyMap<SurfaceLevel, Junction>>();
  /** Each ribbon's place in `ribbons`, at a revision (`ribbonsMeeting`). */
  private ribbonOrderAt = { revision: -1, order: new Map<SegmentId, number>() };

  /** @rebuild Called when the network moved (`revision`); otherwise returns the order it made. */
  private ribbonOrder(): ReadonlyMap<SegmentId, number> {
    if (this.ribbonOrderAt.revision !== this.revision) {
      const order = new Map<SegmentId, number>();
      let i = 0;
      for (const id of this.ribbons.keys()) order.set(id, i++);
      this.ribbonOrderAt = { revision: this.revision, order };
    }
    return this.ribbonOrderAt.order;
  }

  /**
   * The ribbons whose surfaces reach `rect` (`segmentCells`), in the order of
   * `ribbons`: what a loop over every ribbon would meet there, in the order it
   * would meet them, so a search that keeps the first of equals finds the same.
   */
  ribbonsMeeting(rect: ChangeRect): SegmentRibbon[] {
    const order = this.ribbonOrder();
    const out: SegmentRibbon[] = [];
    for (const id of this.segmentCells.idsMeeting(rect)) {
      const ribbon = this.ribbons.get(id);
      if (ribbon && order.has(id)) out.push(ribbon);
    }
    return out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  /**
   * Nodes the editor would refuse to create, with the gap that condemns them,
   * in radians. This is the MARK, and it is derived rather than stored.
   *
   * A flag written into the document would have to be kept in step with every
   * move, split, delete and undo, and a stale mark is worse than none: it either
   * accuses a node that has since been straightened or misses one that has just
   * been bent. Recomputed here, it cannot disagree with the geometry, and it
   * needs no migration for maps saved before the rule existed.
   */
  readonly impossible = new Map<NodeId, number>();
  /**
   * Junctions whose legs are too short to separate their lanes, with how far
   * (units) the worst mouth is cut short of the point where two neighbouring
   * carriageways stop overlapping (`Corner.x`). `reconcile` lets a link too
   * short for both of its junctions squeeze them below that point; the lanes
   * of the two legs then run into each other outside any conflict zone and
   * the cars collide (fuzz fixture `open-body-overlap-on-impossible-short-leg`:
   * mouths cut at 3 units with the carriageways overlapping to 30-52). SUMO
   * warns of the same thing for clusters of junctions joined by short edges:
   * "low throughput, jams and even deadlocks". Derived like `impossible`.
   */
  readonly squeezed = new Map<NodeId, number>();
  readonly trims = new Map<SegmentId, SegmentTrims>();
  /**
   * How far along each leg a junction's flat plate reaches, keyed
   * `node:segment`: the trim the junction's outermost surface would be cut at
   * were it solved on its own. The surfaces are all cut at the carriageway's
   * trim now (`junction/derive.ts`); the elevation solver keeps its plate at
   * the reach it was designed and measured for.
   */
  readonly plateReach = new Map<string, number>();
  /**
   * Nodes where one road carries on at another width, built as a taper rather
   * than as a junction (`junction/transition.ts`).
   */
  readonly transitions = new Set<NodeId>();
  readonly polylines = new PolylineCache();

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

  /**
   * Rebuilds every derived surface, INCREMENTALLY (docs/VIAS.md V0, stage F3):
   * only what the edit changed and what depends on it (`networkBuild.ts`).
   *
   * Two solver passes, then a hard clamp. The first pass finds what each
   * junction wants; segments then reconcile the two ends against their own
   * length and hand back a scale factor; the second pass re-solves the nodes
   * under that pressure with curb radii scaled by the factor, because a
   * smaller radius needs a shorter run and therefore a shorter trim. A third,
   * capped pass guarantees the invariant where the second did not converge,
   * and the trims adopt what the junctions finally used.
   *
   * What changed is published (`changesSince`) for whatever is derived from
   * the network, so it too redoes only what the edit touched.
   * `tests/world/incrementalRebuild.spec.ts` holds the result equal to a
   * rebuild from nothing; `tests/scale/edit.spec.ts` counts the work. `full`
   * forgets everything first: loading a map (`editor/history.ts`).
   * @rebuild Called when the document's revision moved (an edit, a load), never every frame.
   */
  rebuild(options: { readonly full?: boolean } = {}): void {
    const started = performance.now();
    if (options.full || this.build.empty) this.clear();
    this.crossingWalkable = null;
    this.crossingDistances.clear();
    const delta = this.build.rebuild();
    this.log.advance(delta);
    this.revision = this.doc.revision;
    this.trafficRevision = this.doc.trafficRevision;
    // Every authoring invalidation is consumed. Leaving ids in these sets made
    // subsequent edits to the same node look unchanged.
    this.doc.clearDirty();
    measureHitch(options.full ? 'hitch:network/full' : 'hitch:network/rebuild', started);
  }

  /**
   * What changed since the network was in `state` (a token it handed out,
   * `state`), or null: everything (too far behind, a load, a state of
   * another map). The lanes, conflicts, signals and zebras read it to redo
   * only what an edit touched.
   */
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
  }

  /**
   * Takes another network's derived state as the start of its own, without
   * claiming to be up to date: a working copy of the document made for an
   * edit starts from the network it was copied from, and its next rebuild
   * compares this document against what that one was built from and builds
   * again only what differs.
   */
  seedJunctions(from: Network): void {
    this.copyState(from);
    this.build.copyFrom(from.build, false);
    this.revision = -1;
    this.trafficRevision = -1;
  }

  /**
   * Takes over another network's derived geometry instead of recomputing it.
   *
   * `commitDraft` works on a clone, builds a network for it to find crossings
   * and splits, and then - on success - replaces the live document with the
   * clone: the clone's network was built from the very same segments, and
   * `RoadDoc.replaceWith` has made the two documents equal. Measured on a
   * 205-segment map: a rebuild cost about 55 ms, and drawing one road paid
   * for three of them. What the other network changed comes across with it
   * (`changesSince`), so whatever reads this one sees the edit.
   */
  adopt(other: Network): void {
    this.copyState(other);
    this.build.copyFrom(other.build, true);
    this.revision = this.doc.revision;
    this.trafficRevision = this.doc.trafficRevision;
    this.doc.clearDirty();
  }

  private copyState(other: Network): void {
    this.junctions.clear();
    for (const [node, byLevel] of other.junctions) this.junctions.set(node, byLevel);
    this.ribbons.clear();
    for (const [seg, ribbon] of other.ribbons) this.ribbons.set(seg, ribbon);
    this.segmentCells.copyFrom(other.segmentCells);
    this.junctionCells.copyFrom(other.junctionCells);
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
    this.log.takeFrom(other.log);
    // The crossing caches belong to the geometry just replaced. Not clearing
    // them here, after every road drawn the zebras, stop lines, lanelets and
    // footway furniture read crossing distances of the network before the
    // edit (a highway joined to a junction still had its zebras).
    this.crossingWalkable = null;
    this.crossingDistances.clear();
  }

  /**
   * Whether a node is one road carrying on rather than an intersection: two
   * legs, and no control device the player put there.
   *
   * Such a node still has a junction outline whenever its two roads differ -
   * a change of class, of lane count, of structure, or a bend - but it has no
   * approach: no zebra, no stop line, and the lanes run to its mouth. It used
   * to get a crossing on both legs, so a street widening into a boulevard was
   * painted as a crossroads with two of its arms missing.
   */
  continues(node: NodeId): boolean {
    const record = this.doc.node(node);
    if (!record || record.incident.length !== 2) return false;
    if (record.control !== 'auto' && record.control !== 'none') return false;
    if (this.junctions.get(node)?.get(Level.Asphalt)?.transition) return true;
    // A continuous two-leg bend has no approach or zebra; the footway follows
    // its outer edge. Width-changing corners and curved alignments use the
    // transition sweep rather than a crossroads plate.
    const legs = this.junctions.get(node)?.get(Level.Asphalt)?.legs;
    if (!legs || legs.length !== 2) return true;
    return dot((legs[0] as { dir: Vec2 }).dir, (legs[1] as { dir: Vec2 }).dir) < -Math.cos(TRANSITION_BEND);
  }

  /**
   * Whether a node is a junction of three legs or more.
   *
   * A zero mouth distance is the sentinel for "no junction mouth on this end":
   * a dead end, a road bending at a node. But a junction leg can have a zero
   * mouth too - the wide arm of a fork, whose corners with the narrower arms
   * fall behind the node, needs no trim. Read as the sentinel, that arm got no
   * crossing and a stop line at the node itself, a crossing's depth past the
   * bar painted for it.
   */
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

  /**
   * Distance from a node at which vehicles must stop on the given segment.
   *
   * Derived from the same asphalt trim the junction mouth uses, plus the
   * approach zone that holds the crossing. There is one trim in the engine, so
   * a stop line and a junction mouth cannot disagree.
   *
   * The V6 monolith had a separate `approachSetback` formula that could exceed
   * the segment's own length, which pinned vehicles at progress zero forever
   * (defect 2 / 1b of RELATORIO.md).
   */
  stopLineDistance(seg: SegmentId, node: NodeId): number {
    // A mid-block crossing (`RoadNode.crossing`): the paint lies on one piece,
    // its far edge at the node. Both approaches stop a whole crosswalk plus the
    // setback short of the node, so neither bar can reach the paint (MUTCD
    // 3B.16 wants 1.2 m at least in front of the near crosswalk line).
    if (this.midBlockCrossing(node)) return CROSSWALK_DEPTH + STOP_BAR_SETBACK;
    const mouth = this.mouthDistance(seg, node);
    if (mouth <= 0 && !this.isJunction(node)) return 0;
    // Nothing stops where a road merely carries on: the link runs to the mouth
    // and the lanes continue across the node.
    if (this.continues(node)) return mouth;
    // Nor where it circulates through a priority node (a roundabout's ring):
    // it has the way, and no crossing lies across it.
    if (this.circulating(seg, node)) return mouth;
    const length = this.polylines.get(this.doc, seg).length;
    // Never let the approach zone eat the whole segment.
    const capped = Math.min(stopLine(mouth), length * STOP_LINE_CAP);
    // ...but the fractional cap may never pull the stop line onto the zebra.
    // The crossing's position is the protected one — a kerb placed for it must
    // stay out of the carriageway — so when the two constraints disagree it is
    // the stop line that moves outward, not the crossing that moves in.
    // Without this, a boulevard with 84-unit arms put the bar 0.87 units inside
    // the far edge of its own crossing: the two distances reached their shared
    // ordering through separate clamps (0.45 and 0.49 of segment length) and
    // nothing structural kept them ordered once both bound.
    const crossing = this.crosswalkDistanceAt(seg, node);
    const behindCrossing =
      crossing > 0 ? crossing + CROSSWALK_DEPTH / 2 + STOP_BAR_SETBACK : 0;
    // ...and never inside the junction plate. On a short leg into a wide, acute
    // junction the fractional cap bit below the mouth itself (the fuzzer's
    // `trimOrder`: a 184-unit leg with an 85-unit mouth stopped its lanes at
    // 83), which ended the lanelets and started every connector ON the plate.
    return Math.max(capped, behindCrossing, mouth);
  }

  /**
   * Distance from a node to the centre of this segment's crossing.
   *
   * Clamped against the MOUTH, never against a bare fraction of the segment.
   * On a short edge beside a wide junction, a fractional cap pushes the
   * crossing back inside the junction — and any kerb placed for it then sits in
   * the carriageway, which is precisely the class of bug this rewrite exists to
   * make impossible. The crossing may end up closer to the segment's midpoint
   * than is ideal; it may never end up inside the road.
   */
  /**
   * The footway the crossings are fitted to, built once per network: a build
   * spread over frames asks for it in a step of its own
   * (`render/roadSurfaces.ts`), not inside the step that paints the markings.
   */
  crossingSurface(): WalkableSurface {
    return this.crossingWalkable ??= new WalkableSurface(this);
  }

  crosswalkDistanceAt(seg: SegmentId, node: NodeId): number {
    const cacheKey = `${seg}:${node}`;
    const cached = this.crossingDistances.get(cacheKey);
    if (cached !== undefined) return cached;
    // An authored mid-block crossing is exactly where the player put it: its
    // centre half a crosswalk back from the node, on the piece it names.
    const placed = this.midBlockCrossing(node);
    if (placed) return placed.segment === seg ? CROSSWALK_DEPTH / 2 : 0;
    // No zebra across a circulating stream: at a priority node where two
    // one-way pieces carry one flow on (one arrives, the other leaves - the
    // ring of a roundabout), people cross the arms, never the ring.
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

    // Both ends of a segment want an approach zone, and a short link cannot
    // give both. Half the drivable length is this end's share; a crossing that
    // does not leave room for its own stop line inside that share is a crossing
    // a driver would park on, so there is no crossing here at all.
    //
    // Suppressing it is what keeps the ordering unbreakable further down:
    // with the crossing capped this way, both stop lines fit without anyone
    // rescaling them, and rescaling is what used to pull the bar inside the
    // zebra on a 16-unit link between two junctions.
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
    // The middle of each side's own footway (an asymmetric road, docs/VIAS.md V1).
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
    for (let distance = proposed; distance <= limit; distance += 0.5) {
      if (fits(distance)) {
        this.crossingDistances.set(cacheKey, distance);
        return distance;
      }
    }
    const result = fits(limit) ? limit : 0;
    this.crossingDistances.set(cacheKey, result);
    return result;
  }
}
