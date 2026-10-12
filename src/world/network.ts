import { MIN_RIBBON, SEAM_OVERLAP, SURFACE_END_STEP } from '@core/scalar';
import { Ring } from '@core/ring';
import { offsetPolyline } from '@core/offset';
import { Polyline } from '@core/polyline';
import { type Vec2, dot } from '@core/vec2';
import type { RoadDoc, RoadNode, RoadSegment } from './doc';
import type { NodeCrossing, SegmentDirection } from './doc';
import type { NodeId, SegmentId } from './ids';
import { PolylineCache, nodeChart, segmentStartsAt } from './geometry';
import {
  Level,
  SURFACE_LEVELS,
  type SurfaceLevel,
  footwayOn,
  halfWidth,
  roadProfile,
  roadType,
  sideHalfWidth,
} from './roadTypes';
import { type Junction, buildJunction, surfaceMode } from './junction/build';
import { deriveJunctionLevel } from './junction/derive';
import { clampSegmentTrims } from './junction/trim';
import { TRANSITION_BEND } from './junction/transition';
import { impossibleNodes } from './legAngles';
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
import { m } from './units';
import { CellFiling } from './cells';
import type { ChangeRect } from './changes';

/**
 * A mouth cut this little short of where its carriageway separates from the
 * neighbouring leg's is the solver's own rounding (the legs of the last pass
 * are framed at the capped trims), not a junction that cannot hold its lanes:
 * 0.4 m, a tenth of a lane.
 */
const SQUEEZE_NOISE = m(0.4);

/** A junction solved for one pass of `rebuild`, with what the pass handed it (`junctionKey`). */
interface JunctionMemoEntry {
  readonly key: string;
  readonly byLevel: Map<SurfaceLevel, Junction>;
  readonly plate: [SegmentId, number][];
}

function remember(memo: Map<NodeId, JunctionMemoEntry[]>, node: NodeId, entry: JunctionMemoEntry): void {
  const list = memo.get(node);
  if (!list) memo.set(node, [entry]);
  else if (!list.includes(entry)) list.push(entry);
}

/**
 * Everything a segment's polyline, ribbon and junction legs are built from:
 * its record and where its two ends stand. Spelled out field by field, so
 * the same road copied by `replaceWith` (its keys in another order) reads
 * the same.
 */
function segmentSourceKey(doc: RoadDoc, s: RoadSegment): string {
  const a = doc.node(s.a), b = doc.node(s.b);
  return `${s.a}>${s.b}|${s.type}|${s.curve ? `${s.curve.t},${s.curve.h}` : '-'}|${s.dashOrigin}|${s.direction}|${s.lanes}|` +
    `${s.structure}|${s.section ? JSON.stringify(s.section) : '-'}|${s.parking ? JSON.stringify(s.parking) : '-'}|` +
    `${a ? `${a.x},${a.y}` : '-'}|${b ? `${b.x},${b.y}` : '-'}${s.cutWalls ? '|walls' : ''}`;
}

/** Everything of a node a junction there is built from: the whole record, its roads by id. */
function nodeSourceKey(n: RoadNode): string {
  return `${n.x},${n.y}|${n.heightOffset}|${n.smooth ? 1 : 0}|${n.incident.join(',')}|${n.control}|` +
    `${n.blockedMovements.join(',')}|${n.crossing ? `${n.crossing.kind}:${n.crossing.segment}` : '-'}`;
}

/** A `hitch:` entry for the frame monitor and `scripts/probe-hitches.mjs`, where the platform measures. */
function measureHitch(name: string, start: number): void {
  if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
    performance.measure(name, { start, end: performance.now() });
  }
}

/** Per-level trim distances at both ends of a segment. */
export interface SegmentTrims {
  /** Trim at the `a` endpoint, indexed by surface level. */
  readonly a: Record<number, number>;
  /** Trim at the `b` endpoint, indexed by surface level. */
  readonly b: Record<number, number>;
}

export interface SegmentRibbon {
  readonly id: SegmentId;
  readonly typeIndex: number;
  readonly direction: SegmentDirection;
  /** Resolved width and marking profile, including lane overrides. */
  readonly road: ReturnType<typeof roadProfile>;
  /** Centreline trimmed for this level, in world space. */
  readonly centre: Record<number, Polyline>;
  /** Closed carriageway outline for this level. */
  readonly rings: Record<number, Ring>;
  /** Arc-length offset for dash phase continuity across splits. */
  readonly dashOrigin: number;
  /** Full untrimmed centreline, shared by every level. */
  readonly full: Polyline;
}

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

  constructor(readonly doc: RoadDoc) {}

  /** Nodes that carry a junction surface. */
  junctionNodes(): NodeId[] {
    return [...this.junctions.keys()];
  }

  junctionAt(node: NodeId, level: SurfaceLevel): Junction | undefined {
    return this.junctions.get(node)?.get(level);
  }

  /**
   * Rebuilds every derived surface.
   *
   * Two solver passes, then a hard clamp. The first pass finds what each
   * junction wants; segments then reconcile the two ends against their own
   * length and hand back a scale factor; the second pass re-solves with curb
   * radii scaled by that factor, because a smaller radius needs a shorter run
   * and therefore a shorter trim. A final clamp guarantees the invariant even
   * where the second pass did not fully converge.
   *
   * INCREMENTAL by default (docs/VIAS.md V0): the geometry of a segment or a
   * junction whose inputs are the same as at the last rebuild is taken as it
   * was. What each was built from is recorded (`sources`) and compared, as a
   * build system with verifying traces decides a target is up to date
   * (Mokhov, Mitchell and Peyton Jones, "Build systems à la carte"), and a
   * result rebuilt to the same value stops the change there (early cutoff,
   * as Salsa's "backdating"): a junction is solved again only when its node,
   * one of its roads or the radius scale and trim caps its pass hands it
   * differ, a ribbon only when its road, its trims or the bends at its ends
   * do. The document's `dirtyNodes`/`dirtySegments` are not used for it: any
   * other network built on the same document clears them (`clearDirty`), and
   * they are written whenever something is touched, not when it changed (the
   * caveat of write-based change filters, Unity Entities docs). The cheap
   * whole-network steps (`reconcile`, the clamps, the marks) still run over
   * everything, so the result is the full rebuild's by construction;
   * `tests/world/incrementalRebuild.spec.ts` holds the two equal. `full`
   * forgets everything first: loading a map (`editor/history.ts`).
   */
  rebuild(options: { readonly full?: boolean } = {}): void {
    if (options.full) this.forget();
    const started = performance.now();
    this.junctionMemo = this.nextJunctionMemo.size ? this.nextJunctionMemo : this.junctionMemo;
    this.nextJunctionMemo = new Map();
    this.crossingWalkable = null;
    this.crossingDistances.clear();
    this.refreshSources();
    this.junctions.clear();
    this.ribbons.clear();
    this.trims.clear();
    this.plateReach.clear();
    this.transitions.clear();

    const active = [...this.doc.nodes.keys()].filter(
      (id) => surfaceMode(this.doc, this.polylines, id) === 'junction',
    );

    // ---- pass 1: unconstrained -------------------------------------------
    let scaleBySegment = new Map<number, number>();
    const solved = this.solve(active, scaleBySegment);
    scaleBySegment = this.reconcile(solved);

    // ---- passes 2 and 3: ONLY the nodes under length pressure -------------
    //
    // Both later passes exist for one situation: a link too short to give both
    // of its junctions everything they asked for. `reconcile` reports exactly
    // which segments that happened on — `scaleBySegment` holds a segment only
    // when its own clamp bit — so a node touching none of them is re-solved to
    // the identical answer. Its radii are unscaled and its trim caps do not
    // bind, because a cap can only bind where the clamp lowered something.
    //
    // Re-solving all of them anyway is what made drawing a road stall. Measured
    // on a 205-segment map: a full rebuild took 55 ms, `commitDraft` pays for
    // three of them plus a simulation topology rebuild, and the map freezes for
    // about a fifth of a second per road — worse the bigger the map gets, which
    // is precisely the complaint. On an ordinary map almost nothing is under
    // pressure, so the two extra passes now cost almost nothing.
    const pressured2 = nodesTouching(this.doc, active, scaleBySegment);
    if (pressured2.length) {
      for (const [node, byLevel] of this.solve(pressured2, scaleBySegment)) {
        solved.set(node, byLevel);
      }
      scaleBySegment = this.reconcile(solved);
    }

    // A short link can still need a hard length clamp after its radii have
    // been reduced. Rebuild the visible junction geometry once with those
    // exact caps so a junction mouth cannot remain farther out than the ribbon
    // that butts into it.
    const pressured3 = nodesTouching(this.doc, active, scaleBySegment);
    if (pressured3.length) {
      for (const [node, byLevel] of this.solve(pressured3, scaleBySegment, true)) {
        solved.set(node, byLevel);
      }
    }

    // ---- store, applying the hard clamp -----------------------------------
    for (const [node, byLevel] of solved) {
      this.junctions.set(node, byLevel);
      if (byLevel.get(Level.Asphalt)?.transition) this.transitions.add(node);
      const bounds = junctionBounds(byLevel);
      if (bounds) this.junctionCells.file(node, byLevel, bounds); else this.junctionCells.remove(node);
    }
    for (const node of [...this.junctionCells.ids()]) if (!this.junctions.has(node)) this.junctionCells.remove(node);

    // The third pass only lowers trims (`capTrims` is a `Math.min`), so the
    // junctions can end up tighter than the numbers `reconcile` stored on pass
    // two. Adopting the built geometry's own trims makes the mouth and the
    // ribbon read the same number BY CONSTRUCTION rather than by coincidence.
    //
    // Without this they diverged for real: a randomised sweep found a five-leg
    // node where `trims` said 20.25 while the junction had settled at 15.91,
    // which is 4.3 units of bare terrain between the mouth and the ribbon —
    // defect 1.5 arriving through the solver instead of through a second
    // formula. The road fuzzer (`tests/fuzz`, category `trimOrder`) sweeps for it.
    this.adoptSolvedTrims(solved);
    // The plate reaches are reconciled against each segment's length the way
    // the trims are, so two plates never claim more of a short link than it has.
    for (const [id, segment] of this.doc.segments) {
      const keyA = `${segment.a}:${id}`, keyB = `${segment.b}:${id}`;
      const a = this.plateReach.get(keyA), b = this.plateReach.get(keyB);
      if (a === undefined && b === undefined) continue;
      const clamped = clampSegmentTrims({ a: a ?? 0, b: b ?? 0, length: this.polylines.get(this.doc, id).length });
      if (a !== undefined) this.plateReach.set(keyA, clamped.a);
      if (b !== undefined) this.plateReach.set(keyB, clamped.b);
    }

    this.buildRibbons();
    this.impossible.clear();
    // The network's OWN cache, not a fresh one. Building a second cache here
    // re-flattened every bezier in the document a second time on every rebuild,
    // and a rebuild happens on every edit — pure duplicated work for a set of
    // polylines that were computed moments earlier and are still valid.
    for (const [node, gap] of impossibleNodes(this.doc, this.polylines)) {
      this.impossible.set(node, gap);
    }
    this.findSqueezed();

    this.revision = this.doc.revision;
    this.trafficRevision = this.doc.trafficRevision;
    // A full rebuild has consumed every authoring invalidation.  Leaving ids
    // in these sets made subsequent edits to the same node look unchanged.
    this.doc.clearDirty();
    measureHitch(options.full ? 'hitch:network/full' : 'hitch:network/rebuild', started);
  }

  /** Drops everything remembered from earlier rebuilds: the next one builds every piece. */
  private forget(): void {
    this.junctionMemo = new Map();
    this.nextJunctionMemo = new Map();
    this.ribbonMemo = new Map();
    this.segmentSource = new Map();
    this.nodeSource = new Map();
    this.polylines.clear();
  }

  /**
   * What each segment and node is built from, as text, compared with what
   * the last rebuild recorded: a segment whose record or end positions moved
   * loses its polyline and its ribbon, a node whose record moved or one of
   * whose roads did loses its solved junctions. Everything else keeps what
   * was built for it.
   */
  private refreshSources(): void {
    const segments = new Map<SegmentId, string>();
    for (const [id, segment] of this.doc.segments) {
      const key = segmentSourceKey(this.doc, segment);
      segments.set(id, key);
      if (this.segmentSource.get(id) !== key) {
        this.polylines.invalidate(id);
        this.ribbonMemo.delete(id);
      }
    }
    for (const id of this.segmentSource.keys()) {
      if (!segments.has(id)) {
        this.polylines.invalidate(id);
        this.ribbonMemo.delete(id);
      }
    }
    const nodes = new Map<NodeId, string>();
    for (const [id, node] of this.doc.nodes) {
      const key = nodeSourceKey(node);
      nodes.set(id, key);
      let changed = this.nodeSource.get(id) !== key;
      for (const seg of node.incident) {
        if (changed) break;
        changed = this.segmentSource.get(seg) !== segments.get(seg);
      }
      if (changed) this.junctionMemo.delete(id);
    }
    for (const id of this.nodeSource.keys()) if (!nodes.has(id)) this.junctionMemo.delete(id);
    this.segmentSource = segments;
    this.nodeSource = nodes;
  }

  /**
   * Takes over another network's derived geometry instead of recomputing it.
   *
   * `commitDraft` works on a clone, builds a network for it to find crossings
   * and splits, and then — on success — replaces the live document with the
   * clone and rebuilds the live network from scratch. That last rebuild is pure
   * repetition: the clone's network was just built from the very same segments,
   * and `RoadDoc.replaceWith` has already made the two documents equal.
   *
   * Measured on a 205-segment map: a rebuild costs about 55 ms, and drawing one
   * road paid for three of them. Dropping this one is a third of the stall the
   * user feels, and it grows with the map, which is exactly the complaint.
   *
   * The polyline cache comes across too. It is keyed by segment id, and after
   * `replaceWith` the ids and their geometry are the same objects' values, so
   * every entry in it is still the right answer.
   */
  /**
   * Takes another network's solved junctions as its memory (`solve`): a
   * working copy of the document made for an edit starts from the junctions
   * of the network it was copied from, not from nothing.
   */
  seedJunctions(from: Network): void {
    // Everything the other network remembers, with the sources it was built
    // from: the next rebuild compares this document against them and builds
    // again only what differs (`refreshSources`), whatever document the other
    // one was built for.
    this.junctionMemo = new Map([...from.junctionMemo, ...from.nextJunctionMemo]);
    this.nextJunctionMemo = new Map();
    this.ribbonMemo = new Map(from.ribbonMemo);
    this.segmentSource = new Map(from.segmentSource);
    this.nodeSource = new Map(from.nodeSource);
    this.polylines.adopt(from.polylines);
  }

  adopt(other: Network): void {
    this.junctionMemo = new Map();
    this.nextJunctionMemo = new Map([...other.junctionMemo, ...other.nextJunctionMemo]);
    this.ribbonMemo = new Map(other.ribbonMemo);
    this.segmentSource = new Map(other.segmentSource);
    this.nodeSource = new Map(other.nodeSource);
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
    // The crossing caches belong to the geometry just replaced. `rebuild` clears
    // them; this second way in did not, and after every road drawn the zebras,
    // stop lines, lanelets and footway furniture read crossing distances of the
    // network before the edit (a highway joined to a junction still had its
    // zebras) until some later edit happened to rebuild.
    this.crossingWalkable = null;
    this.crossingDistances.clear();
    this.revision = this.doc.revision;
    this.trafficRevision = this.doc.trafficRevision;
    this.doc.clearDirty();
  }

  private solve(
    nodes: readonly NodeId[],
    radiusScaleBySegment: ReadonlyMap<number, number>,
    useReconciledTrimCaps = false,
  ): Map<NodeId, Map<SurfaceLevel, Junction>> {
    const out = new Map<NodeId, Map<SurfaceLevel, Junction>>();
    for (const node of nodes) {
      // A junction is built from its node, the segments that meet there and
      // their lines (`buildJunction` reads nothing else), the radius scale and
      // the trim caps of this pass: a node whose inputs are the same as at the
      // last rebuild takes the junction solved then. Every junction of the
      // map was solved again, two or three times, for every road drawn
      // (docs/performance.md #17).
      // The node and its roads are the same as when an entry was made (an
      // entry of a node whose sources changed is dropped, `refreshSources`):
      // what is left to compare is what this pass hands it.
      const key = this.junctionKey(node, radiusScaleBySegment, useReconciledTrimCaps);
      const known = this.junctionMemo.get(node)?.find((entry) => entry.key === key) ??
        this.nextJunctionMemo.get(node)?.find((entry) => entry.key === key);
      if (known) {
        remember(this.nextJunctionMemo, node, known);
        for (const [seg, reach] of known.plate) this.plateReach.set(`${node}:${seg}`, reach);
        if (known.byLevel.size) out.set(node, known.byLevel);
        continue;
      }
      const plate: [SegmentId, number][] = [];
      const byLevel = new Map<SurfaceLevel, Junction>();
      const build = (level: SurfaceLevel): Junction | null => {
        const maxTrimBySegment = useReconciledTrimCaps
          ? this.trimCapsAt(node, level)
          : undefined;
        return buildJunction(this.doc, this.polylines, node, level, {
          radiusScaleBySegment,
          ...(maxTrimBySegment ? { maxTrimBySegment } : {}),
        });
      };
      // Solved once, on the carriageway; every outer surface is that outline
      // carried out to its own edge (`junction/derive.ts`). Only a junction
      // the carriageway cannot draw as one (a taper, a merge) is built per surface.
      const carriageway = build(Level.Asphalt);
      const footprint = build(Level.Casing);
      footprint?.legs.forEach((leg, i) => {
        this.plateReach.set(`${node}:${leg.seg}`, footprint.trims[i] as number);
        plate.push([leg.seg, footprint.trims[i] as number]);
      });
      for (const level of SURFACE_LEVELS) {
        const j = level === Level.Asphalt
          ? carriageway
          : (carriageway ? deriveJunctionLevel(this.doc, this.polylines, carriageway, level) : null) ?? build(level);
        if (j) byLevel.set(level, j);
      }
      if (byLevel.size) out.set(node, byLevel);
      remember(this.nextJunctionMemo, node, { key, byLevel, plate });
    }
    return out;
  }

  /**
   * Junctions as solved at the last rebuild, and at this one, per node and
   * per pass (`junctionKey`). Only entries of nodes whose sources are as
   * recorded (`refreshSources`) are ever looked up.
   */
  private junctionMemo = new Map<NodeId, JunctionMemoEntry[]>();
  private nextJunctionMemo = new Map<NodeId, JunctionMemoEntry[]>();
  /** Each segment's ribbon as last built, with what it was built from (`buildRibbons`). */
  private ribbonMemo = new Map<SegmentId, { readonly ribbon: SegmentRibbon; readonly trims: string; readonly bendA: number; readonly bendB: number }>();
  /** Each segment's and node's sources at the last rebuild (`refreshSources`). */
  private segmentSource = new Map<SegmentId, string>();
  private nodeSource = new Map<NodeId, string>();

  /**
   * What a pass hands a node's junction beyond the node and its roads (which
   * `refreshSources` vouches for): the radius scale of each road and, on the
   * capped pass, the trim each road was reconciled to at this end.
   */
  private junctionKey(node: NodeId, scales: ReadonlyMap<number, number>, capped: boolean): string {
    const source = this.doc.node(node);
    if (!source) return 'gone';
    const parts: string[] = [capped ? 'capped' : 'free'];
    for (const id of source.incident) {
      const segment = this.doc.segment(id);
      if (!segment) { parts.push('gone'); continue; }
      parts.push(String(scales.get(id) ?? 1));
      if (capped) {
        const trims = this.trims.get(id);
        parts.push(JSON.stringify(trims ? (segment.a === node ? trims.a : trims.b) : null));
      }
    }
    return parts.join('|');
  }

  /** Final per-leg caps for one junction after segment-end reconciliation. */
  private trimCapsAt(node: NodeId, level: SurfaceLevel): ReadonlyMap<number, number> {
    const caps = new Map<SegmentId, number>();
    const source = this.doc.node(node);
    if (!source) return caps;
    for (const id of source.incident) {
      const segment = this.doc.segment(id);
      const trims = this.trims.get(id);
      if (!segment || !trims) continue;
      const side = segment.a === node ? trims.a : trims.b;
      caps.set(id, side[level] ?? 0);
    }
    return caps;
  }

  /**
   * Reconciles each segment's two ends against its length, per level, and
   * returns the curb-radius scale each segment should use on the next pass.
   *
   * This writes `this.trims`, so it is also what the ribbon builder and every
   * consumer of a stop line reads. There is one trim number per segment end per
   * level in the entire engine.
   */
  private reconcile(
    solved: ReadonlyMap<NodeId, Map<SurfaceLevel, Junction>>,
  ): Map<number, number> {
    const demand = new Map<SegmentId, SegmentTrims>();

    const ensure = (id: SegmentId): SegmentTrims => {
      let t = demand.get(id);
      if (!t) {
        t = { a: {}, b: {} };
        demand.set(id, t);
      }
      return t;
    };

    for (const [node, byLevel] of solved) {
      for (const [level, junction] of byLevel) {
        junction.legs.forEach((leg, i) => {
          const seg = this.doc.segment(leg.seg);
          if (!seg) return;
          const slot = ensure(leg.seg);
          const side = seg.a === node ? slot.a : slot.b;
          side[level] = Math.max(side[level] ?? 0, junction.trims[i] as number);
        });
      }
    }

    // The part of a mouth no length budget may take: as far out as the
    // carriageway's edges of two neighbouring legs still cross (`Corner.x`).
    // Nearer the node than that the two legs are one another's carriageway,
    // and a link cut there has the traffic of the next leg driving through it.
    const hard = new Map<SegmentId, { a: number; b: number }>();
    for (const [node, byLevel] of solved) {
      const junction = byLevel.get(Level.Asphalt);
      if (!junction || junction.transition) continue;
      for (const corner of junction.corners) {
        const x = corner.x;
        if (!x || corner.psi >= Math.PI / 2) continue;
        for (const index of [corner.i, corner.j]) {
          const leg = junction.legs[index];
          const seg = leg ? this.doc.segment(leg.seg) : undefined;
          if (!leg || !seg) continue;
          const along = (x.x - leg.origin.x) * leg.dir.x + (x.y - leg.origin.y) * leg.dir.y;
          if (!(along > 0)) continue;
          const h = hard.get(leg.seg) ?? { a: 0, b: 0 };
          if (seg.a === node) h.a = Math.max(h.a, along); else h.b = Math.max(h.b, along);
          hard.set(leg.seg, h);
        }
      }
    }

    const scale = new Map<number, number>();

    for (const id of this.doc.segments.keys()) {
      const t = demand.get(id) ?? { a: {}, b: {} };
      const length = this.polylines.get(this.doc, id).length;
      const floor = hard.get(id);
      let worst = 1;

      for (const level of SURFACE_LEVELS) {
        const a = t.a[level] ?? 0;
        const b = t.b[level] ?? 0;
        const clamped = clampSegmentTrims({ a, b, length });
        let ca = clamped.a, cb = clamped.b;
        if (floor && clamped.scale < 1) {
          // The budget may squeeze the kerb returns, never the overlap itself,
          // as long as the segment can hold both ends' overlaps at all.
          const fa = Math.min(a, floor.a), fb = Math.min(b, floor.b);
          if (fa + fb <= length - MIN_RIBBON) { ca = Math.max(ca, fa); cb = Math.max(cb, fb); }
        }
        t.a[level] = ca;
        t.b[level] = cb;
        if (clamped.scale < worst) worst = clamped.scale;
      }

      this.trims.set(id, t);
      if (worst < 1) scale.set(id, worst);
    }

    return scale;
  }

  /**
   * Copies the trims the built junctions actually used back into `this.trims`.
   *
   * Only lowers: a segment end with no junction keeps whatever `reconcile`
   * decided, and an end whose junction ended up tighter adopts the tighter
   * number. Raising here would push a ribbon back out past a mouth that was
   * deliberately capped, which is the failure this exists to prevent.
   */
  private adoptSolvedTrims(
    solved: ReadonlyMap<NodeId, Map<SurfaceLevel, Junction>>,
  ): void {
    for (const [node, byLevel] of solved) {
      for (const [level, junction] of byLevel) {
        junction.legs.forEach((leg, i) => {
          const seg = this.doc.segment(leg.seg);
          const stored = this.trims.get(leg.seg);
          if (!seg || !stored) return;
          const side = seg.a === node ? stored.a : stored.b;
          side[level] = Math.min(side[level] ?? Infinity, junction.trims[i] as number);
        });
      }
    }
  }

  /**
   * Fills `squeezed` from the junctions as built and the trims as stored: for
   * every corner whose two carriageway edges still cross (`Corner.x`, an
   * acute wedge as in `reconcile`), how far along each leg that crossing lies,
   * against the trim the leg's mouth was finally cut at.
   */
  private findSqueezed(): void {
    this.squeezed.clear();
    for (const [node, byLevel] of this.junctions) {
      const junction = byLevel.get(Level.Asphalt);
      if (!junction || junction.transition) continue;
      let worst = 0;
      for (const corner of junction.corners) {
        const x = corner.x;
        if (!x || corner.psi >= Math.PI / 2) continue;
        for (const index of [corner.i, corner.j]) {
          const leg = junction.legs[index];
          const seg = leg ? this.doc.segment(leg.seg) : undefined;
          const trims = leg ? this.trims.get(leg.seg) : undefined;
          if (!leg || !seg || !trims) continue;
          const along = (x.x - leg.origin.x) * leg.dir.x + (x.y - leg.origin.y) * leg.dir.y;
          const trim = (seg.a === node ? trims.a : trims.b)[Level.Asphalt] ?? 0;
          worst = Math.max(worst, along - trim);
        }
      }
      if (worst > SQUEEZE_NOISE) this.squeezed.set(node, worst);
    }
  }

  /**
   * How far the road turns at a node joining exactly two segments, radians
   * (0 straight on); 0 anywhere else. Read off the two polylines' ends.
   */
  private bendAt(nodeId: NodeId, segId: SegmentId): number {
    const node = this.doc.node(nodeId);
    if (!node || node.incident.length !== 2) return 0;
    const away = (id: SegmentId): Vec2 | null => {
      const seg = this.doc.segment(id);
      if (!seg) return null;
      const pts = this.polylines.at(this.doc, id, nodeChart(this.doc, nodeId)).toPoints();
      if (pts.length < 2) return null;
      const [p, q] = seg.a === nodeId ? [pts[0]!, pts[1]!] : [pts[pts.length - 1]!, pts[pts.length - 2]!];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      return len > 0 ? { x: (q.x - p.x) / len, y: (q.y - p.y) / len } : null;
    };
    const other = node.incident.find((id) => id !== segId);
    const u = away(segId);
    const v = other === undefined ? null : away(other);
    if (!u || !v) return 0;
    // Straight on, the two directions away from the node are opposed.
    const cos = Math.max(-1, Math.min(1, -(u.x * v.x + u.y * v.y)));
    // Bends past the junction threshold get a junction instead; cap the push.
    return Math.min(Math.acos(cos), (20 * Math.PI) / 180);
  }

  private buildRibbons(): void {
    const memo = new Map<SegmentId, { readonly ribbon: SegmentRibbon; readonly trims: string; readonly bendA: number; readonly bendB: number }>();
    for (const [id, seg] of this.doc.segments) {
      const t = this.trims.get(id) ?? { a: {}, b: {} };
      // A ribbon is its road (as recorded, `refreshSources`), its trims and
      // the bends at its two ends: the same three, the same ribbon.
      const trimsKey = JSON.stringify(t);
      const bendA = this.bendAt(seg.a, id);
      const bendB = this.bendAt(seg.b, id);
      const known = this.ribbonMemo.get(id);
      if (known && known.trims === trimsKey && known.bendA === bendA && known.bendB === bendB) {
        this.ribbons.set(id, known.ribbon);
        this.segmentCells.file(id, known.ribbon, ribbonBounds(known.ribbon));
        memo.set(id, known);
        continue;
      }
      const full = this.polylines.get(this.doc, id);
      const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking);
      const length = full.length;

      const centre: Record<number, Polyline> = {};
      const rings: Record<number, Ring> = {};

      for (const level of SURFACE_LEVELS) {
        // Pull the ribbon back INTO the junction by a hair. Under a single
        // nonzero fill this overlap is invisible, and it removes any chance of
        // a hairline of terrain showing where the two surfaces meet — the seam
        // the V6 monolith produced by compositing translucent layers twice.
        const a = Math.max(0, (t.a[level] ?? 0) - SEAM_OVERLAP);
        const b = Math.max(0, (t.b[level] ?? 0) - SEAM_OVERLAP);
        const s0 = Math.min(a, Math.max(0, length - MIN_RIBBON));
        const s1 = Math.max(s0 + MIN_RIBBON * 0.5, length - b);

        const trimmed = full.sub(s0, Math.min(s1, length));
        centre[level] = trimmed;
        // The SURFACE overlaps its neighbour; the CENTRELINE above does not.
        //
        // `SEAM_OVERLAP` exists so a ribbon pushes a hair into the junction it
        // meets and nonzero fill hides the join. At a chain node — two roads of
        // one class running straight through — `surfaceMode` builds NO junction,
        // so the trims are zero, and `Math.max(0, 0 - SEAM_OVERLAP)` clamps the
        // overlap away exactly where there is no junction to hide behind. The
        // two ribbons then meet edge to edge and the surface under them shows
        // through the join as a pale line across the road, at every node where
        // one road continues into the next.
        //
        // So an end that was not trimmed is pushed OUT instead, into its
        // neighbour. `centre` keeps the honest length: it carries the dash phase
        // and every marking, and lengthening it would slide the lane lines.
        // At a bend with no junction the two ribbons meet square to their
        // own ends, which leaves a wedge open on the outside of the bend:
        // half the width times the tangent of half the bend. A fixed hair of
        // overlap covered it only on dead-straight joins; 3 to 5 degree bends
        // showed holes in the asphalt (audit P2-26).
        const base = SEAM_OVERLAP + (level - Level.Casing) * SURFACE_END_STEP;
        // Each side to its own width (docs/VIAS.md V1): a footway wider on
        // one side is an outline offset further on that side.
        const hw = halfWidth(rt, level);
        rings[level] = ribbonRing(
          overlapUntrimmedEnds(
            trimmed,
            s0 <= 0,
            s1 >= length,
            base + hw * Math.tan(bendA / 2),
            base + hw * Math.tan(bendB / 2),
          ),
          sideHalfWidth(rt, level, 'left'),
          sideHalfWidth(rt, level, 'right'),
        );
      }

      const ribbon: SegmentRibbon = {
        id,
        typeIndex: seg.type,
        direction: seg.direction,
        road: rt,
        centre,
        rings,
        dashOrigin: seg.dashOrigin,
        full,
      };
      this.ribbons.set(id, ribbon);
      this.segmentCells.file(id, ribbon, ribbonBounds(ribbon));
      memo.set(id, { ribbon, trims: trimsKey, bendA, bendB });
    }
    for (const id of [...this.segmentCells.ids()]) if (!this.ribbons.has(id)) this.segmentCells.remove(id);
    this.ribbonMemo = memo;
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
    // On the segment's own chart, where its footways are drawn (`world/planet/charts.ts`).
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

/**
 * Closes a trimmed centreline into a carriageway outline of half-width `hw`.
 *
 * Both sides are offset with full miter compensation and loop pruning, then
 * joined by butt ends. The ends are square by design: they butt against a
 * junction mouth cut at exactly the same distance.
 */
/**
 * The nodes that touch a segment whose length clamp actually bit.
 *
 * `reconcile` returns a scale only for segments where it had to take something
 * away, so this is the exact set whose junctions can still change on a later
 * pass. Everything else is already final.
 */
function nodesTouching(
  doc: RoadDoc,
  candidates: readonly NodeId[],
  scaleBySegment: ReadonlyMap<number, number>,
): NodeId[] {
  if (scaleBySegment.size === 0) return [];
  const out: NodeId[] = [];
  for (const id of candidates) {
    const node = doc.node(id);
    if (!node) continue;
    for (const seg of node.incident) {
      if (scaleBySegment.has(seg)) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}

/**
 * Pushes an untrimmed end of a ribbon `amount` past the node.
 *
 * Only ends that were not trimmed move, and they move ALONG the end tangent, so
 * the cross-section stays square to the road and the two neighbours overlap by
 * a strip rather than crossing at an angle. An end that meets a junction is
 * already handled by the subtraction that names this constant and is left
 * alone.
 */
function overlapUntrimmedEnds(
  line: Polyline,
  atStart: boolean,
  atEnd: boolean,
  amount = SEAM_OVERLAP,
  amountEnd = amount,
): Polyline {
  if (!atStart && !atEnd) return line;
  const pts = line.toPoints();
  if (pts.length < 2) return line;

  const push = (from: Vec2, towards: Vec2, amount: number): Vec2 => {
    const dx = from.x - towards.x;
    const dy = from.y - towards.y;
    const len = Math.hypot(dx, dy);
    if (len < MIN_RIBBON * 0.01) return from;
    return { x: from.x + (dx / len) * amount, y: from.y + (dy / len) * amount };
  };

  const out = [...pts];
  if (atStart) out[0] = push(out[0] as Vec2, out[1] as Vec2, amount);
  if (atEnd) {
    const last = out.length - 1;
    out[last] = push(out[last] as Vec2, out[last - 1] as Vec2, amountEnd);
  }
  return Polyline.fromPoints(out);
}

export function ribbonRing(centre: Polyline, hw: number, hwRight = hw): Ring {
  if (centre.n < 2 || centre.length <= 0) {
    return new Ring({ x: 0, y: 0 }, []);
  }
  const pts = centre.toPoints();
  const left = offsetPolyline(pts, hw);
  const right = offsetPolyline(pts, -hwRight);
  const loop: Vec2[] = [...left, ...right.slice().reverse()];
  return Ring.fromPolygon(loop).ensurePositive();
}

/**
 * Everything a ribbon puts on any level (`surfaces.ts` levelRings): its rings,
 * and the short overlaps at a curved leg's mouths, which stay within the
 * widest half-width of its centreline.
 */
function ribbonBounds(ribbon: SegmentRibbon): ChangeRect {
  let reach = 0;
  for (const level of SURFACE_LEVELS) reach = Math.max(reach, halfWidth(ribbon.road, level));
  const b = ribbon.full.bbox;
  let x0 = b.minX - reach, y0 = b.minY - reach, x1 = b.maxX + reach, y1 = b.maxY + reach;
  for (const level of SURFACE_LEVELS) {
    const ring = ribbon.rings[level];
    if (!ring || ring.isEmpty) continue;
    const r = ring.bbox;
    x0 = Math.min(x0, r.minX); y0 = Math.min(y0, r.minY); x1 = Math.max(x1, r.maxX); y1 = Math.max(y1, r.maxY);
  }
  return [x0, y0, x1, y1];
}

/** Every ring a node's junctions put on any level; null for none. */
function junctionBounds(byLevel: ReadonlyMap<SurfaceLevel, Junction>): ChangeRect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const junction of byLevel.values()) {
    for (const ring of junction.rings) {
      if (ring.isEmpty) continue;
      const r = ring.bbox;
      x0 = Math.min(x0, r.minX); y0 = Math.min(y0, r.minY); x1 = Math.max(x1, r.maxX); y1 = Math.max(y1, r.maxY);
    }
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}
