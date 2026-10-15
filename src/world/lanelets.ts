import { Polyline } from '@core/polyline';
import { offsetPolyline } from '@core/offset';
import type { Vec2 } from '@core/vec2';
import { MIN_RIBBON } from '@core/scalar';
import { Digest } from '@core/digest';
import type { NodeId, SegmentId } from './ids';
import type { JunctionControl, RoadDoc, RoadNode } from './doc';
import type { Network } from './network';
import { laneOffset, laneWidth, roadProfile, travelLanes } from './roadTypes';
import { PARKING_DEPTH } from './parking';
import { laneLineCrossable, laneUse } from './roadSection';
import { orientedPolyline } from './geometry';
import type { ApproachGroup } from './approachGroups';
import { TUNNELS_DRAWN } from './structures';
import { JunctionSurface, type TurnPathResult } from './turnPaths';
import { surfaceParts } from './surfaceParts';
import { JunctionTurns, type TurnPlan } from './junctionTurns';
import type { BodyClass } from './conflictTable';
import {
  type JunctionAsk, type JunctionInput, type JunctionLane, type JunctionLeg, type JunctionMade, type JunctionMeasurer, type LaneAsk, type TurnKind,
  connectorId, isJunction, junctionAsk, junctionKey, junctionMovements,
} from './junctionBuild';
import { WAITING, answered } from './waiting';

export { classifyTurn, connectorId, type TurnKind } from './junctionBuild';

export type LaneletId = string;
export type ConnectorId = string;

/**
 * The atomic unit of vehicle space: a directed, single-lane centreline.
 *
 * There are two kinds and no motion code distinguishes them. A `link` is one
 * lane of one direction of one segment, already trimmed at the junction
 * boundary. A `connector` is one legal movement inside a junction.
 *
 * That single representational choice removes an entire class of defect. The
 * stop line is ALWAYS `s = link.length`, because the setback was consumed when
 * the geometry was trimmed — there is no `stopAt = max(0, L - setback)` left to
 * go negative. And "inside the junction" is not a special case in the physics;
 * it just means being on a connector. The V6 monolith's pin at `progress = 0`
 * (defect 2 / 1b of RELATORIO.md) has no representation here.
 */
export interface Lanelet {
  readonly id: LaneletId;
  readonly kind: 'link' | 'connector';
  readonly centre: Polyline;
  readonly length: number;
  /** Free-flow speed in world units per second. */
  readonly speedLimit: number;

  // link fields
  readonly segment?: SegmentId;
  readonly from?: NodeId;
  readonly to?: NodeId;
  readonly laneIndex?: number;
  /**
   * The kerb-side lane of a street with a cycle lane (`cycle` band) on its
   * right: how far sideways, in `perp` units (negative is right of travel),
   * the middle of the cycle lane lies from this lane's centre. Bicycles ride
   * there (`sim/vehicles/cycleLane.ts`).
   */
  readonly cycleShift?: number;
  /** True when the far end of this link is a junction with a stop line. */
  readonly controlled: boolean;
  /** Buses only (`RoadSection.useForward`, docs/VIAS.md V4); absent: every vehicle. */
  readonly use?: 'bus';
  /** No lane change across the line to lane `laneIndex - 1` / `laneIndex + 1` (solid, or a bus lane's). */
  readonly solidInner?: true;
  readonly solidOuter?: true;

  // connector fields
  readonly node?: NodeId;
  readonly fromLane?: LaneletId;
  readonly toLane?: LaneletId;
  readonly turn?: TurnKind;
  readonly group?: number;
}

export interface Connector {
  readonly id: ConnectorId;
  readonly lanelet: LaneletId;
  readonly node: NodeId;
  readonly fromLane: LaneletId;
  readonly toLane: LaneletId;
  readonly inSegment: SegmentId;
  readonly outSegment: SegmentId;
  readonly turn: TurnKind;
  /**
   * True when this movement is the road the node is ON carried across it -
   * a road bending at a node of two legs, or bending through a junction that
   * has no straight-on movement (`carriedPair`). Its lanes pair one to one,
   * and it has priority where the node is unsignalised. `turn` still states
   * how far it bends, which is what speed and the indicator are read from.
   */
  readonly carried: boolean;
  readonly group: number;
  readonly length: number;
  readonly maxBodyClass: BodyClass | -1;
}

export interface JunctionTopology {
  readonly node: NodeId;
  readonly groups: readonly ApproachGroup[];
  readonly connectors: readonly ConnectorId[];
  /** Inbound link lanelets, in deterministic order. */
  readonly inbound: readonly LaneletId[];
  readonly signalised: boolean;
  /** Explicit policy copied from the authoring node when available. */
  readonly control?: JunctionControl;
}

/**
 * A junction built on turns still to be chosen off the page (`TurnPlan`), kept until they are
 * (`LaneletGraph.redoProvisional`): what its cache entry is made of, and each movement that stood a turn
 * in, with how to shape it again.
 */
interface PendingJunction {
  readonly key: string;
  readonly turns: JunctionTurns;
  readonly groups: readonly ApproachGroup[];
  readonly signalised: boolean;
  readonly connectors: readonly ConnectorId[];
  readonly reshape: readonly { readonly id: ConnectorId; again(): TurnPathResult }[];
}

/** What one junction built, kept between builds (`buildJunctions`). */
/** What `LaneletGraph.takeOut` took out, for `letGo`: the lanelets that went, the junctions' entries and keys, the links' keys. */
interface TakenOut {
  readonly lanes: Set<LaneletId>;
  readonly before: Map<NodeId, JunctionCache>;
  readonly junctionKeys: string[];
  readonly linkKeys: string[];
}

interface JunctionCache {
  readonly node: NodeId;
  /** The turns its movements were shaped with (`turnPath`): kept with the junction, gone with it. */
  readonly turns: JunctionTurns;
  readonly groups: readonly ApproachGroup[];
  readonly signalised: boolean;
  /** The connector lanelets and the connectors, in creation order. */
  readonly lanelets: readonly Lanelet[];
  readonly connectors: readonly Connector[];
}

export const laneletId = (
  segment: SegmentId,
  from: NodeId,
  to: NodeId,
  lane: number,
): LaneletId => `${segment}:${from}>${to}:${lane}`;

/**
 * The work of the lane graph's builds, counted (`tests/scale/edit.spec.ts`):
 * segments and nodes looked at. An edit must cost the same on a small map and a
 * large one (CLAUDE.md); at the SOURCE every build looks at the whole map
 * (stage F3 makes it local).
 */
export const laneletWork = { segments: 0, nodes: 0 };

/**
 * Builds every lanelet and connector of the network.
 *
 * Link geometry is the lane centreline trimmed by the SAME asphalt trim the
 * junction mouth uses — `Network.trims` is the single source, so a stop line
 * and a junction mouth can never disagree.
 */
/** What one `LaneletGraph.update` built again: the junctions, the lanelets that came or went, the segments. */
export interface GraphChange {
  readonly junctions: ReadonlySet<NodeId>;
  readonly lanelets: ReadonlySet<LaneletId>;
  readonly segments: ReadonlySet<SegmentId>;
}

export class LaneletGraph {
  readonly lanelets = new Map<LaneletId, Lanelet>();
  readonly connectors = new Map<ConnectorId, Connector>();
  readonly junctions = new Map<NodeId, JunctionTopology>();
  /** Outgoing connectors of each link lanelet. */
  readonly exits = new Map<LaneletId, ConnectorId[]>();
  /** Inbound link lanelets of each node. */
  readonly inbound = new Map<NodeId, LaneletId[]>();
  /** Link lanelets leaving each node. */
  readonly outbound = new Map<NodeId, LaneletId[]>();
  /**
   * The link lanelets of each segment, both directions, in the order they were
   * built (the order of `lanelets`). Kept by the one writer of links
   * (`buildLinks`) and cleared with them (`buildSteps`).
   */
  private readonly bySegment = new Map<SegmentId, LaneletId[]>();

  revision = -1;

  /**
   * The link lanelets of each (segment, direction), by the geometry and trims
   * they were built from: a road an edit did not touch keeps the lanelets it
   * had, objects and all.
   */
  private linkCache = new Map<string, Lanelet[]>();
  /** The key each lanelet of this build was made under (`buildLinks`). */
  private readonly laneletKeys = new Map<LaneletId, string>();
  /** What each junction built, by the surface and lanelets it was built from. */
  private junctionCache = new Map<string, JunctionCache>();

  build(doc: RoadDoc, net: Network): void {
    const steps = this.buildSteps(doc, net);
    let step = steps.next();
    while (!step.done) step = steps.next();
    this.netState = net.state;
  }

  /**
   * The turns of the next build chosen off the page (`SimWorld.prepareVehicleTopology`): set, a turn a
   * junction does not know is asked of it and stood in for, and `redoProvisional` builds those
   * junctions again once it holds the answers. Null: every turn is chosen here, as it always was.
   */
  turnPlan: TurnPlan | null = null;

  /** The network's state this graph was last brought up to (`update`). */
  private netState: object | null = null;
  /** The key each junction's cache entry is under (`buildJunction`): found by its node, never by walking the cache. */
  private readonly junctionKeyOf = new Map<NodeId, string>();

  /** The next `update` builds the whole graph (a world reset: what read the graph forgot it all). */
  forget(): void {
    this.netState = null;
  }

  /**
   * The graph brought up to the network by what changed since it was last
   * (`Network.changesSince`): the link lanelets of the segments the edit
   * changed and of those meeting a node it changed, and the connectors of the
   * junctions at their ends - nothing else is touched, objects and all. The
   * whole graph is built only when the network cannot say what changed (a
   * load, a first build, a graph of another network). Returns the junctions
   * built again and the lanelets that came or went; null: everything.
   * DO NOT build the whole graph for an edit: every segment's key and every
   * junction's were worked out again, the map's for one road.
   */
  update(doc: RoadDoc, net: Network): GraphChange | null {
    const steps = this.updateSteps(doc, net);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  /**
   * `update` as steps (`SimWorld.prepareVehicleTopology`): a graph built whole goes through `buildSteps`
   * as the incremental path goes through its generator, so it is one more of the preparation's steps and
   * never one call the generator cannot see into. DO NOT read this as slicing: `TopologyCatchUp` runs
   * every plain step in the frame it starts, and only `WAITING` (workers busy) ends a frame.
   */
  *updateSteps(doc: RoadDoc, net: Network, builder: JunctionMeasurer | null = null): Generator<void | typeof WAITING, GraphChange | null, void> {
    const delta = this.netState === null || this.lanelets.size === 0 ? null : net.changesSince(this.netState);
    if (delta === null) {
      // Not brought up to any state until the whole build is done: one left half way is built whole again.
      // Its junctions built by `builder`'s workers when it has them (`junctionsOffPage`), as an edit's turns are chosen by them.
      this.netState = null;
      yield* this.buildSteps(doc, net, builder);
      this.netState = net.state;
      return null;
    }
    this.netState = net.state;
    const { segments, junctions } = this.reach(doc, delta);
    const out = this.takeOut(segments, junctions);
    // In again, from the document as it is: the segments' links, then the junctions' connectors.
    for (const seg of [...segments].sort((a, b) => a - b)) {
      if (!doc.segment(seg)) continue;
      this.buildSegmentLinks(doc, net, seg, this.linkCache, this.linkCache);
      for (const id of this.bySegment.get(seg) ?? []) out.lanes.add(id);
    }
    for (const nodeId of [...junctions].sort((a, b) => a - b)) {
      const node = doc.node(nodeId);
      if (!node) continue;
      this.buildJunction(doc, net, nodeId, node, this.junctionCache, this.junctionCache, (n) => out.before.get(n));
      for (const cid of this.junctions.get(nodeId)?.connectors ?? []) out.lanes.add(cid);
    }
    return this.letGo(net, segments, junctions, out);
  }

  /**
   * The graph brought up to `from`, a graph of the same network already brought up to it and finished
   * (`current`; the preparation's, `SimWorld.prepareVehicleTopology`): what changed since this one was
   * last brought up is TAKEN from `from` - the link lanelets of those segments, the junctions and their
   * connectors, objects and all, with the keys they were built under - not built again. The same graph
   * `update` makes (`tests/sim/topologyOffPage.spec.ts`), and what it returns. DO NOT seed this graph's
   * caches from `from` and `update` it: every lane's key and every junction's surface and key were worked
   * out a second time in the frame of the swap, a city's whole map on its first build (2026-10-15).
   */
  adopt(from: LaneletGraph, doc: RoadDoc, net: Network): GraphChange | null {
    const delta = this.netState === null || this.lanelets.size === 0 ? null : net.changesSince(this.netState);
    if (delta === null) {
      this.takeWhole(from);
      this.brought(net);
      return null;
    }
    const { segments, junctions } = this.reach(doc, delta);
    const out = this.takeOut(segments, junctions);
    for (const seg of [...segments].sort((a, b) => a - b)) {
      if (!doc.segment(seg)) continue;
      for (const id of from.bySegment.get(seg) ?? []) {
        const lane = from.lanelets.get(id)!, key = from.laneletKeys.get(id)!;
        this.lanelets.set(id, lane);
        this.laneletKeys.set(id, key);
        this.linkCache.set(key, from.linkCache.get(key)!);
        push(this.inbound, lane.to!, id);
        push(this.outbound, lane.from!, id);
        push(this.bySegment, seg, id);
        out.lanes.add(id);
      }
    }
    for (const nodeId of [...junctions].sort((a, b) => a - b)) {
      const junction = doc.node(nodeId) ? from.junctions.get(nodeId) : undefined;
      if (!junction) continue;
      for (const cid of junction.connectors) {
        const connector = from.connectors.get(cid)!;
        this.lanelets.set(cid, from.lanelets.get(cid)!);
        this.connectors.set(cid, connector);
        push(this.exits, connector.fromLane, cid);
        out.lanes.add(cid);
      }
      this.junctions.set(nodeId, junction);
      const key = from.junctionKeyOf.get(nodeId);
      if (key !== undefined) { this.junctionCache.set(key, from.junctionCache.get(key)!); this.junctionKeyOf.set(nodeId, key); }
    }
    return this.letGo(net, segments, junctions, out);
  }

  /** Whether this graph stands for the network as it is now, finished: no junction on stand-in turns (`adopt`). */
  current(net: Network): boolean {
    return this.netState === net.state && this.turnPlan === null && this.pending.size === 0;
  }

  /** Every link, junction and connector of `from`, and its caches, as this graph's own (`adopt` of a graph built whole). */
  private takeWhole(from: LaneletGraph): void {
    const copy = <K, V>(into: Map<K, V>, source: ReadonlyMap<K, V>): void => { into.clear(); for (const [k, v] of source) into.set(k, v); };
    const lists = <K>(into: Map<K, string[]>, source: ReadonlyMap<K, readonly string[]>): void => { into.clear(); for (const [k, v] of source) into.set(k, [...v]); };
    copy(this.lanelets, from.lanelets);
    copy(this.connectors, from.connectors);
    copy(this.junctions, from.junctions);
    copy(this.laneletKeys, from.laneletKeys);
    copy(this.junctionKeyOf, from.junctionKeyOf);
    lists(this.exits, from.exits);
    lists(this.inbound, from.inbound);
    lists(this.outbound, from.outbound);
    lists(this.bySegment, from.bySegment);
    this.linkCache = new Map(from.linkCache);
    this.junctionCache = new Map(from.junctionCache);
    this.pending.clear();
    this.siblings.clear();
    this.changes.clear();
  }

  /** The graph now stands for the network as it is. */
  private brought(net: Network): void {
    this.netState = net.state;
    this.revision = net.revision;
  }

  /**
   * What a change of the network reaches (`update`, `adopt`): the segments to build again - those changed,
   * and every segment meeting a node that changed (its stop line and its key read the node) - and the
   * junctions at their ends, before and now.
   */
  private reach(doc: RoadDoc, delta: { readonly segments: ReadonlySet<SegmentId>; readonly nodes: ReadonlySet<NodeId> }): { segments: Set<SegmentId>; junctions: Set<NodeId> } {
    const segments = new Set<SegmentId>(delta.segments);
    for (const nodeId of delta.nodes) for (const seg of doc.node(nodeId)?.incident ?? []) segments.add(seg);
    const junctions = new Set<NodeId>(delta.nodes);
    for (const seg of segments) {
      const now = doc.segment(seg);
      if (now) { junctions.add(now.a); junctions.add(now.b); }
      for (const id of this.bySegment.get(seg) ?? []) {
        const lane = this.lanelets.get(id);
        if (lane?.from !== undefined) junctions.add(lane.from);
        if (lane?.to !== undefined) junctions.add(lane.to);
      }
    }
    return { segments, junctions };
  }

  /**
   * Out with what these segments and junctions made: their lanelets, the junctions' connectors, every
   * list naming them. Their cache entries stay until they are built again: a lanelet or a junction whose
   * key comes round again is handed back, the same object (a height-only edit moves no lane); those not
   * come round go after (`letGo`). Each junction's entry is found by its key (`junctionKeyOf`). DO NOT
   * walk the junction cache to find them: every edit read every junction of the map.
   */
  private takeOut(segments: ReadonlySet<SegmentId>, junctions: ReadonlySet<NodeId>): TakenOut {
    const out: TakenOut = { lanes: new Set(), before: new Map(), junctionKeys: [], linkKeys: [] };
    for (const nodeId of junctions) {
      const key = this.junctionKeyOf.get(nodeId);
      const entry = key === undefined ? undefined : this.junctionCache.get(key);
      if (key !== undefined && entry) { out.before.set(nodeId, entry); out.junctionKeys.push(key); }
      this.junctionKeyOf.delete(nodeId);
      const junction = this.junctions.get(nodeId);
      if (!junction) continue;
      for (const cid of junction.connectors) {
        const connector = this.connectors.get(cid);
        if (connector) drop(this.exits, connector.fromLane, cid);
        this.connectors.delete(cid);
        this.lanelets.delete(cid);
        out.lanes.add(cid);
      }
      this.junctions.delete(nodeId);
    }
    for (const seg of segments) {
      for (const id of this.bySegment.get(seg) ?? []) {
        const lane = this.lanelets.get(id);
        if (lane?.to !== undefined) drop(this.inbound, lane.to, id);
        if (lane?.from !== undefined) drop(this.outbound, lane.from, id);
        const key = this.laneletKeys.get(id);
        if (key !== undefined) out.linkKeys.push(key);
        this.laneletKeys.delete(id);
        this.lanelets.delete(id);
        this.exits.delete(id);
        out.lanes.add(id);
      }
      this.bySegment.delete(seg);
    }
    this.siblings.clear();
    this.changes.clear();
    return out;
  }

  /**
   * The cache entries of before that did not come round again let go (the cache holds what the graph
   * has), and the graph brought up to the network. A link's key names its segment, so only the lanes of
   * the segments built again can hold one of them. DO NOT gather every lanelet's key to find out: every
   * edit read the whole map's.
   */
  private letGo(net: Network, segments: ReadonlySet<SegmentId>, junctions: Set<NodeId>, out: TakenOut): GraphChange {
    const liveLinkKeys = new Set<string>();
    for (const seg of segments) for (const id of this.bySegment.get(seg) ?? []) liveLinkKeys.add(this.laneletKeys.get(id)!);
    for (const key of out.linkKeys) if (!liveLinkKeys.has(key)) this.linkCache.delete(key);
    const keptJunctionKeys = new Set<string>();
    for (const nodeId of junctions) {
      const key = this.junctionKeyOf.get(nodeId);
      if (key !== undefined) keptJunctionKeys.add(key);
    }
    for (const key of out.junctionKeys) if (!keptJunctionKeys.has(key)) this.junctionCache.delete(key);
    this.brought(net);
    return { junctions, lanelets: out.lanes, segments: new Set(segments) };
  }

  /**
   * The junctions the last build stood on turns still to be chosen (`turnPlan`), built again now that
   * the plan holds the answers: their connectors out, then in again from the cache and the plan's
   * turns - the junction a build that chose every turn here makes. A turn the plan could not answer (its
   * workers failed) is chosen here. Only those junctions: DO NOT build the graph again for them.
   */
  redoProvisional(doc: RoadDoc, net: Network): void {
    const plan = this.turnPlan;
    if (!plan) return;
    plan.recording = false;
    for (const [nodeId, turns] of [...plan.provisional].sort((a, b) => a[0] - b[0])) {
      const pending = this.pending.get(nodeId);
      if (pending && pending.turns === turns && this.junctions.has(nodeId)) {
        this.reshape(nodeId, pending);
        continue;
      }
      for (const cid of this.junctions.get(nodeId)?.connectors ?? []) {
        const connector = this.connectors.get(cid);
        if (connector) drop(this.exits, connector.fromLane, cid);
        this.connectors.delete(cid);
        this.lanelets.delete(cid);
      }
      this.junctions.delete(nodeId);
      const node = doc.node(nodeId);
      if (node) this.buildJunction(doc, net, nodeId, node, this.junctionCache, this.junctionCache, () => ({ turns }));
    }
    this.pending.clear();
    this.siblings.clear();
    this.changes.clear();
    this.turnPlan = null;
  }

  /** The junctions built on turns still to be chosen off the page, by node (`buildJunction`, `redoProvisional`). */
  private readonly pending = new Map<NodeId, PendingJunction>();

  /**
   * A junction built on turns still to be chosen, finished with the turns chosen: only the movements
   * that stood one in are shaped again (`turnPath`, now reading the plan's answers), each lanelet and
   * connector the one `buildJunction` makes with them, and the junction kept as it keeps one. DO NOT
   * build the whole junction again for its turns (its surface, its key, every movement): the second
   * build of every junction of a generated city was 0.3 s of a frame on the page (2026-10-15).
   */
  private reshape(nodeId: NodeId, pending: PendingJunction): void {
    for (const { id, again } of pending.reshape) {
      const { path, maxBodyClass } = again();
      const lanelet = this.lanelets.get(id)!, connector = this.connectors.get(id)!;
      this.lanelets.set(id, { ...lanelet, centre: path, length: path.length });
      this.connectors.set(id, { ...connector, length: path.length, maxBodyClass });
    }
    this.junctionKeyOf.set(nodeId, pending.key);
    this.junctionCache.set(pending.key, {
      node: nodeId,
      turns: pending.turns.settle(),
      groups: pending.groups,
      signalised: pending.signalised,
      connectors: pending.connectors.map((id) => this.connectors.get(id)!),
      lanelets: pending.connectors.map((id) => this.lanelets.get(id)!),
    });
  }

  /** `build` in steps, a segment's links or a junction's connectors at a time. */
  /** `builder`: who builds the junctions off the page (`junctionsOffPage`); none, here. */
  *buildSteps(doc: RoadDoc, net: Network, builder: JunctionMeasurer | null = null): Generator<void | typeof WAITING, void, void> {
    this.siblings.clear();
    this.changes.clear();
    // Every junction is built again: none stands on the turns of a build before, none's entry is kept.
    this.pending.clear();
    this.turnPlan?.provisional.clear();
    this.junctionKeyOf.clear();
    this.lanelets.clear();
    this.connectors.clear();
    this.junctions.clear();
    this.exits.clear();
    this.inbound.clear();
    this.outbound.clear();
    this.bySegment.clear();

    const previousLinks = this.linkCache;
    const nextLinks = new Map<string, Lanelet[]>();
    this.laneletKeys.clear();
    yield* this.buildLinks(doc, net, previousLinks, nextLinks);
    this.linkCache = nextLinks;
    const previousJunctions = this.junctionCache;
    const nextJunctions = new Map<string, JunctionCache>();
    yield* this.buildJunctions(doc, net, previousJunctions, nextJunctions, builder);
    this.junctionCache = nextJunctions;
    this.revision = net.revision;
    // Anything asked while the graph was half built is forgotten.
    this.siblings.clear();
    this.changes.clear();
  }

  private *buildLinks(doc: RoadDoc, net: Network, previous: Map<string, Lanelet[]>, next: Map<string, Lanelet[]>): Generator<void, void, void> {
    const ids = [...doc.segments.keys()].sort((a, b) => a - b);

    for (const segId of ids) {
      yield;
      this.buildSegmentLinks(doc, net, segId, previous, next);
    }
  }

  /** The link lanelets of one segment, both directions (`buildLinks`), under the keys they were built from. */
  private buildSegmentLinks(doc: RoadDoc, net: Network, segId: SegmentId, previous: Map<string, Lanelet[]>, next: Map<string, Lanelet[]>): void {
    laneletWork.segments++;
    const seg = doc.requireSegment(segId);
    // A tunnel with no geometry carries no traffic. Skipping the link
    // lanelets removes the segment from the routing graph outright — no
    // lanelets, no connectors, no junction groups — so a vehicle can never
    // pass silently through a bore that is not drawn. The segment itself
    // stays in the document, authored and saved normally.
    if (seg.structure === 'tunnel' && !TUNNELS_DRAWN) return;
    const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking);

    for (const forward of [true, false]) {
      if (!allowsDirection(seg.direction, forward)) continue;
      const lpd = travelLanes(rt, seg.direction);
      const from = forward ? seg.a : seg.b;
      const to = forward ? seg.b : seg.a;

      // A link ends at the STOP LINE, not at the junction mouth, leaving room
      // for the crossing in between. Both distances come from the same trim.
      const startTrim = net.stopLineDistance(segId, from);
      const endTrim = net.stopLineDistance(segId, to);

      const full = orientedPolyline(doc, seg, from);
      const total = full.length;

      // Consume the accessor's answer, do not re-derive it.
      //
      // This used to clamp each end independently against `total * 0.45`,
      // which is a second stop-line formula competing with the first — the
      // exact shape of defect 1.5, and it silently undid the accessor's
      // guarantee that the stop line sits beyond the crossing. Measured on a
      // boulevard with 84-unit arms: the accessor said 38.67 and the lanelet
      // still ended at 37.80, putting the line 0.87 units inside the zebra.
      //
      // The trim solver already reserves `MIN_DRIVABLE_RESERVE` between the
      // two approach zones, so the two ends normally fit. When they do not,
      // scale them JOINTLY: that keeps their ratio, degrades both ends the
      // same way, and never lets one end reach past the other.
      const wanted = startTrim + endTrim;
      const room = Math.max(0, total - MIN_RIBBON);
      // What gives way is the approach zones, never the mouths: a lane that
      // ended inside a junction's mouth would start its connector on the
      // plate (the fuzzer's `trimOrder`). Only where the mouths alone do not
      // fit are both ends scaled whole, as before.
      const mouthStart = Math.min(startTrim, net.mouthDistance(segId, from));
      const mouthEnd = Math.min(endTrim, net.mouthDistance(segId, to));
      const approach = wanted - mouthStart - mouthEnd;
      const spare = room - mouthStart - mouthEnd;
      let s0: number, s1: number;
      if (wanted > room && spare >= 0 && approach > 0) {
        const k = spare / approach;
        s0 = mouthStart + (startTrim - mouthStart) * k;
        s1 = Math.max(s0 + MIN_RIBBON, total - mouthEnd - (endTrim - mouthEnd) * k);
      } else {
        const k = wanted > room && wanted > 0 ? room / wanted : 1;
        s0 = startTrim * k;
        s1 = Math.max(s0 + MIN_RIBBON, total - endTrim * k);
      }
      const centreTrimmed = full.sub(s0, Math.min(s1, total));

      // EVERYTHING of the document this lanelet — and any junction it runs
      // into — is made of. Read in full from `buildJunctions` and the calls
      // under it, so a field left out here is a field a junction cannot see
      // move:
      //
      //   the segment's own points (the lanelet's shape, `carriedPair`'s
      //   bend, `computeApproachGroups`' legs), its `type` and
      //   `section.priority` (`carriedPair` ranks by `priority ?? type`),
      //   `lanes` and `direction` and the whole `section`
      //   (`laneWidth`, `sidewalk`, `median`, `speedKmh`, `priority`, through
      //   `roadProfile`: `laneIsPlausible`'s lane counts, the signal rule),
      //   `structure`, the two stop-line trims, the authored lane arrows
      //   (`section.turnsForward` / `turnsBackward`: `laneTurnAllowed` and
      //   the authored-turn lane choice in `buildJunctions`), and the degree
      //   and pedestrian crossing of the node it runs into (`controlled`).
      //
      // The junction key is built out of these lanelet keys, so this list is
      // what makes that one complete: `TUNNELS_DRAWN` is true and every
      // direction is allowed somewhere, so every segment of a node has at
      // least one lanelet here to speak for it.
      const section = seg.section;
      const crossing = doc.node(to)?.crossing;
      const key = `${segId}|${forward ? 1 : 0}|${seg.type}|${seg.lanes ?? '-'}|${seg.direction}`
        + `|${seg.structure ?? '-'}`
        + `|${section ? `${section.laneWidth},${section.sidewalk},${section.median},${section.speedKmh},${section.priority}` : '-'}`
        + `|${section?.turnsForward?.join(',') ?? '-'}|${section?.turnsBackward?.join(',') ?? '-'}`
        + (section?.useForward || section?.useBackward || section?.linesForward || section?.linesBackward
          ? `|u${section.useForward?.join(',') ?? ''}/${section.useBackward?.join(',') ?? ''}|l${section.linesForward?.join(',') ?? ''}/${section.linesBackward?.join(',') ?? ''}` : '')
        + `|${lpd}|${laneWidth(rt)}|${rt.median}|${rt.speedLimit}|${rt.sidewalk}|${rt.parkingLeft},${rt.parkingRight},${rt.parkingLeftKind},${rt.parkingRightKind}`
        + `|${doc.degree(to)}|${crossing ? `${crossing.kind},${crossing.segment}` : '-'}`
        // Whether it begins or ends at a road's end (`turnPath`'s `RoadEnds`).
        + `|${doc.mapEdge(from) ? 1 : 0}${doc.mapEdge(to) ? 1 : 0}`
        + `|${s0}|${s1}|${new Digest().addAll(full.xy).value()}`;
      let lanes = previous.get(key);
      if (!lanes) {
        const pts = centreTrimmed.toPoints();
        const startTangent = centreTrimmed.sampleAt(0).t;
        const endTangent = centreTrimmed.sampleAt(centreTrimmed.length).t;
        lanes = [];
        for (let lane = 0; lane < lpd; lane++) {
          // Lane 0 is innermost; negative `perp` offset is the right of travel.
          const laneCentre = Polyline.fromPoints(clipToEndSections(
            offsetPolyline(pts, laneOffset(rt, lane, seg.direction, forward)), startTangent, endTangent,
          ));
          lanes.push({
            id: laneletId(segId, from, to, lane),
            kind: 'link',
            centre: laneCentre,
            length: laneCentre.length,
            speedLimit: rt.speedLimit,
            segment: segId,
            from,
            to,
            laneIndex: lane,
            ...((forward ? rt.parkingRightKind : rt.parkingLeftKind) === 'cycle' && lane === lpd - 1
              ? { cycleShift: -(laneWidth(rt) / 2 + PARKING_DEPTH.cycle / 2) } : {}),
            controlled: doc.degree(to) >= 3 || crossing !== undefined,
            ...(laneUse(section, forward, lane) === 'bus' ? { use: 'bus' as const } : {}),
            ...(lane > 0 && !laneLineCrossable(section, forward, lane - 1) ? { solidInner: true as const } : {}),
            ...(lane < lpd - 1 && !laneLineCrossable(section, forward, lane) ? { solidOuter: true as const } : {}),
          });
        }
      }
      next.set(key, lanes);
      for (const lanelet of lanes) {
        this.lanelets.set(lanelet.id, lanelet);
        this.laneletKeys.set(lanelet.id, key);
        push(this.inbound, to, lanelet.id);
        push(this.outbound, from, lanelet.id);
        push(this.bySegment, segId, lanelet.id);
      }
    }
  }

  private *buildJunctions(doc: RoadDoc, net: Network, previous: Map<string, JunctionCache>, next: Map<string, JunctionCache>,
    builder: JunctionMeasurer | null): Generator<void | typeof WAITING, void, void> {
    /** The last build's junction at each node, for the turns of a junction built again (`JunctionTurns`). */
    let previousAt: Map<NodeId, JunctionCache> | null = null;
    const before = (nodeId: NodeId): JunctionCache | undefined => {
      if (!previousAt) {
        previousAt = new Map();
        for (const entry of previous.values()) previousAt.set(entry.node, entry);
      }
      return previousAt.get(nodeId);
    };
    if (builder?.buildJunctions && (yield* this.junctionsOffPage(doc, net, previous, next, before, builder))) return;
    for (const [nodeId, node] of doc.nodes) {
      yield;
      this.buildJunction(doc, net, nodeId, node, previous, next, before);
    }
  }

  /**
   * Every junction of a whole build made OFF THE PAGE (`builder`'s workers, `conflictPool.ts`): each one's
   * input sent as plain numbers (`junctionAsk`: its node, its roads, its lanes, the pieces of its surface),
   * `WAITING` yielded while the workers build them (`buildJunctionOf`: the surface, the key, every movement
   * shaped and its turn chosen), and each placed here from its answer, in the order the page builds them - or
   * handed back from the cache when its key is known, as `buildJunction` hands it back. False when the
   * workers failed: the page builds them. DO NOT build a whole build's junctions on the page when there are
   * workers: a generated city's surfaces, keys and turns held one frame 1.2-1.4 s at 2.5 km (2026-10-15).
   */
  private *junctionsOffPage(doc: RoadDoc, net: Network, previous: Map<string, JunctionCache>, next: Map<string, JunctionCache>,
    before: (node: NodeId) => JunctionCache | undefined, builder: JunctionMeasurer): Generator<void | typeof WAITING, boolean, void> {
    const asked: { nodeId: NodeId; node: RoadNode; input: JunctionInput }[] = [];
    const asks: JunctionAsk[] = [];
    const sent = { lanes: new Map<LaneletId, LaneAsk>(), legs: new Map<SegmentId, JunctionLeg>() };
    for (const [nodeId, node] of doc.nodes) {
      const input = this.junctionInput(doc, nodeId, node);
      if (!input) continue;
      asked.push({ nodeId, node, input });
      asks.push(junctionAsk(input, surfaceParts(net, nodeId), before(nodeId)?.turns ?? null, sent));
    }
    const answers = asks.length ? yield* answered(builder.buildJunctions!(asks), 'the junctions are built') : [];
    if (!answers) return false;
    laneletWork.nodes += doc.nodes.size;
    for (let k = 0; k < asked.length; k++) {
      const { nodeId, node, input } = asked[k]!, answer = answers[k]!;
      if (this.takeKnown(nodeId, node, input, answer.key, previous, next)) continue;
      const made: JunctionMade = {
        groups: answer.groups,
        signalised: answer.signalised,
        connectors: answer.connectors.map((c) => ({ ...c, path: Polyline.fromFlat(c.path) })),
      };
      this.place(nodeId, node, input, answer.key, made, JunctionTurns.of(answer.turns), next);
    }
    return true;
  }

  /**
   * What a junction's connectors are made of (`junctionBuild.ts`), read off the document and this graph's
   * links; null when the node is no junction (`isJunction`).
   */
  private junctionInput(doc: RoadDoc, nodeId: NodeId, node: RoadNode): JunctionInput | null {
    const inbound = this.inbound.get(nodeId) ?? [], outbound = this.outbound.get(nodeId) ?? [];
    if (!isJunction(node, inbound.length, outbound.length)) return null;
    const lane = (id: LaneletId): JunctionLane => {
      const l = this.lanelets.get(id)!;
      return {
        id, key: this.laneletKeys.get(id) ?? id, segment: l.segment!, from: l.from!, to: l.to!, laneIndex: l.laneIndex ?? 0,
        speedLimit: l.speedLimit, centre: l.centre, fromEdge: doc.mapEdge(l.from!), toEdge: doc.mapEdge(l.to!),
      };
    };
    const legs = [...new Set(node.incident)].map((segId) => {
      const segment = doc.requireSegment(segId);
      const a = doc.requireNode(segment.a), b = doc.requireNode(segment.b);
      return { segment, from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y } };
    });
    return { node, legs, inbound: inbound.slice().sort().map(lane), outbound: outbound.slice().sort().map(lane) };
  }

  /** The junction at `nodeId` handed back whole from the cache when its key is known (a junction an edit did not reach: objects and all). */
  private takeKnown(nodeId: NodeId, node: RoadNode, input: JunctionInput, key: string, previous: Map<string, JunctionCache>, next: Map<string, JunctionCache>): boolean {
    const known = key ? previous.get(key) : undefined;
    if (!known) return false;
    for (const lanelet of known.lanelets) this.lanelets.set(lanelet.id, lanelet);
    for (const connector of known.connectors) {
      this.connectors.set(connector.id, connector);
      push(this.exits, connector.fromLane, connector.id);
    }
    this.junctions.set(nodeId, {
      node: nodeId,
      groups: known.groups,
      connectors: known.connectors.map((connector) => connector.id),
      inbound: input.inbound.map((lane) => lane.id),
      signalised: known.signalised,
      control: node.control,
    });
    next.set(key, known);
    this.junctionKeyOf.set(nodeId, key);
    return true;
  }

  /**
   * A junction's movements (`junctionMovements`, here or in a worker) made this graph's: a lanelet and a
   * connector each, in the order made, the junction, and its cache entry - or, standing on turns still to
   * be chosen off the page, its pending record (`redoProvisional`).
   */
  private place(nodeId: NodeId, node: RoadNode, input: JunctionInput, key: string, made: JunctionMade, turns: JunctionTurns, next: Map<string, JunctionCache>): void {
    const connectorIds: ConnectorId[] = [];
    /** The movements that stood a turn in (`turns.defer`), shaped again once it is chosen (`reshape`). */
    const reshape: { id: ConnectorId; again(): TurnPathResult }[] = [];
    for (const c of made.connectors) {
      const inLane = input.inbound[c.from]!, outLane = input.outbound[c.to]!;
      const cid = connectorId(inLane.id, outLane.id);
      const path = c.path;
      const lanelet: Lanelet = {
        id: cid,
        kind: 'connector',
        centre: path,
        length: path.length,
        speedLimit: c.speedLimit,
        controlled: false,
        node: nodeId,
        fromLane: inLane.id,
        toLane: outLane.id,
        turn: c.turn,
        group: c.group,
      };
      this.lanelets.set(cid, lanelet);
      this.connectors.set(cid, {
        id: cid,
        lanelet: cid,
        node: nodeId,
        fromLane: inLane.id,
        toLane: outLane.id,
        inSegment: inLane.segment,
        outSegment: outLane.segment,
        turn: c.turn,
        carried: c.carried,
        group: c.group,
        length: path.length,
        maxBodyClass: c.maxBodyClass,
      });
      push(this.exits, inLane.id, cid);
      connectorIds.push(cid);
      if (c.again) reshape.push({ id: cid, again: c.again });
    }
    const { groups, signalised } = made;
    this.junctions.set(nodeId, {
      node: nodeId,
      groups,
      connectors: connectorIds,
      inbound: input.inbound.map((lane) => lane.id),
      signalised,
      control: node.control,
    });
    // A junction standing on turns still to be chosen off the page is not kept: finished with them
    // (`redoProvisional`), and a later build must not hand back its stand-ins.
    if (turns.provisional) {
      this.pending.set(nodeId, { key, turns, groups, signalised, connectors: connectorIds, reshape });
      return;
    }
    this.junctionKeyOf.set(nodeId, key);
    next.set(key, {
      node: nodeId,
      turns: turns.settle(),
      groups,
      signalised,
      connectors: connectorIds.map((id) => this.connectors.get(id)!),
      lanelets: connectorIds.map((id) => this.lanelets.get(id)!),
    });
  }

  /** The connectors of one node (`buildJunctions`): kept whole when its key is known, built otherwise (`junctionBuild.ts`). */
  private buildJunction(doc: RoadDoc, net: Network, nodeId: NodeId, node: RoadNode,
    previous: Map<string, JunctionCache>, next: Map<string, JunctionCache>, before: (node: NodeId) => { readonly turns: JunctionTurns } | undefined): void {
    laneletWork.nodes++;
    // Built again: whatever it stood in for its turns, and the key it was kept under, go with the build
    // before. DO NOT keep them: a junction left on stand-in turns by a preparation given up (the network
    // edited while its workers chose them) and built again later was reshaped with the old build's
    // movements, and one never built again kept its stand-ins (`redoProvisional`).
    this.pending.delete(nodeId);
    this.turnPlan?.provisional.delete(nodeId);
    this.junctionKeyOf.delete(nodeId);
    const input = this.junctionInput(doc, nodeId, node);
    if (!input) return;
    // The surface a turn has to stay on, built once per node. `turnPath` needs the surface anyway, so
    // asking for its key costs nothing extra - and a junction an edit did not reach hands back the
    // connectors it had, objects and all (`junctionKey`).
    let surface: JunctionSurface | null | undefined;
    const surfaceOf = (): JunctionSurface | null => (surface ??= new JunctionSurface(net, nodeId));
    const key = junctionKey(input, surfaceOf()?.key ?? '');
    if (this.takeKnown(nodeId, node, input, key, previous, next)) return;
    // The turns this junction chose before: a movement whose geometry did not move keeps its turn.
    const turns = new JunctionTurns(before(nodeId)?.turns ?? null, this.turnPlan, nodeId);
    this.place(nodeId, node, input, key, junctionMovements(input, surfaceOf, turns), turns, next);
  }

  /**
   * The connectors of the junction at `node` ALONE, made as the whole graph's
   * build makes them (`buildJunction`): from the link lanelets of the roads
   * that meet there (`buildSegmentLinks`) and the junction's own surface - all
   * a junction's connectors read (the turns stay on the plate and its legs,
   * the lanes that wait are the ones arriving there). What asks whether a
   * movement of one junction can be driven asks this, never a graph of the
   * whole map: `editor/streetObjects.ts` built one, and walked every
   * connector of it, on every click of the U-turn tool.
   * @perInput Runs once a question about one junction: it reads that junction and its roads.
   */
  static junctionConnectors(doc: RoadDoc, net: Network, nodeId: NodeId): { readonly connectors: readonly Connector[]; readonly centres: ReadonlyMap<ConnectorId, Polyline> } {
    const node = doc.node(nodeId);
    if (!node) return { connectors: [], centres: new Map() };
    const graph = new LaneletGraph();
    for (const segId of [...new Set(node.incident)].sort((a, b) => a - b)) graph.buildSegmentLinks(doc, net, segId, new Map(), new Map());
    graph.buildJunction(doc, net, nodeId, node, new Map(), new Map(), () => undefined);
    const connectors = (graph.junctions.get(nodeId)?.connectors ?? []).map((id) => graph.connectors.get(id)!);
    return { connectors, centres: new Map(connectors.map((c) => [c.id, graph.lanelets.get(c.lanelet)!.centre])) };
  }


  /**
   * The link lanelets of one segment, both directions, in the order of
   * `lanelets`: the same as filtering every lanelet for `kind === 'link' &&
   * segment === id`, read off an index. DO NOT walk `lanelets` to find one
   * road's lanes (the inspector did, every 0.4 s, for the whole map).
   */
  linksOfSegment(segment: SegmentId): readonly LaneletId[] {
    return this.bySegment.get(segment) ?? [];
  }

  exitsOf(lane: LaneletId): readonly ConnectorId[] {
    return this.exits.get(lane) ?? [];
  }

  lanelet(id: LaneletId): Lanelet | undefined {
    return this.lanelets.get(id);
  }

  /**
   * The other lanes of the same carriageway, adjacent ones first.
   *
   * Lane discipline makes each turn legal from exactly one lane, so both route
   * planning and lane changing have to be able to see across the carriageway.
   * Lane indices are contiguous from 0, so walking outward from this one and
   * stopping at the first gap enumerates the direction without needing to know
   * its width here.
   */
  siblingLanes(id: LaneletId): LaneletId[] {
    // The same lanes until the graph is built again (`buildSteps` clears it):
    // asked for every vehicle on every tick, making the ids as strings each
    // time cost 3 s in 3.5 minutes of 400 cars at 4x.
    let known = this.siblings.get(id);
    if (!known) this.siblings.set(id, known = this.findSiblings(id));
    return known;
  }
  private readonly siblings = new Map<LaneletId, LaneletId[]>();

  /** Whether a vehicle of this shape may drive a lane (a bus lane is buses only, docs/VIAS.md V4). */
  laneUsable(id: LaneletId, shape: string): boolean {
    const lane = this.lanelets.get(id);
    return !!lane && (lane.use !== 'bus' || shape === 'bus');
  }

  /**
   * The lanes of the same carriageway a vehicle of this shape may change
   * into from `id`: across dashed lines only (MBST vol. IV, LMS-1/LMS-2), and
   * into lanes it may drive. Nearest first, as `siblingLanes`.
   */
  changeTargets(id: LaneletId, shape: string): readonly LaneletId[] {
    const key = shape === 'bus' ? `${id}|b` : id;
    let known = this.changes.get(key);
    if (!known) this.changes.set(key, known = this.findChangeTargets(id, shape));
    return known;
  }
  private readonly changes = new Map<string, readonly LaneletId[]>();

  private findChangeTargets(id: LaneletId, shape: string): LaneletId[] {
    const lane = this.lanelets.get(id);
    if (!lane || lane.kind !== 'link' || lane.segment === undefined || lane.from === undefined || lane.to === undefined) return [];
    const here = lane.laneIndex ?? 0;
    const out: LaneletId[] = [];
    for (const step of [-1, 1]) {
      let at = lane;
      for (let k = here + step; k >= 0; k += step) {
        // The line between `at` and the next lane out.
        if (step < 0 ? at.solidInner : at.solidOuter) break;
        const next = this.lanelets.get(laneletId(lane.segment, lane.from, lane.to, k));
        if (!next) break;
        at = next;
        if (next.use === 'bus' && shape !== 'bus') break;
        out.push(next.id);
      }
    }
    return out;
  }

  private findSiblings(id: LaneletId): LaneletId[] {
    const lane = this.lanelets.get(id);
    if (
      !lane ||
      lane.kind !== 'link' ||
      lane.segment === undefined ||
      lane.from === undefined ||
      lane.to === undefined
    ) return [];

    const here = lane.laneIndex ?? 0;
    const out: LaneletId[] = [];
    for (const step of [-1, 1]) {
      for (let k = here + step; k >= 0; k += step) {
        const sibling = laneletId(lane.segment, lane.from, lane.to, k);
        if (!this.lanelets.has(sibling)) break;
        out.push(sibling);
      }
    }
    return out;
  }
}

/**
 * A lane's centre between the cross-sections at its two ends.
 *
 * The lane is the road's trimmed centre offset sideways, and the trim can
 * leave a last piece of a few centimetres where the cut falls just past a
 * vertex of the curve. On the inside of the curve the offset's mitre vertex
 * there lands beyond the end of that short piece, so the lane ran on past its
 * own end and came back: its last direction pointed backwards, and every turn
 * out of it was shaped as a hook no vehicle fitted (fuzz `turnOffSurface`,
 * seeds 21 and 26, a 0.06-unit piece and a 0.2-unit step back). An open
 * offset is clipped at its ends, as CavalierContours clips a raw open offset
 * at the circles round its end points: the run of vertices right before an end
 * that lies past that end's cross-section is dropped. Only that run, so a lane
 * that winds back on itself further along keeps its shape.
 */
export function clipToEndSections(points: readonly Vec2[], startTangent: Vec2, endTangent: Vec2): Vec2[] {
  if (points.length < 3) return points.slice();
  const first = points[0]!, last = points[points.length - 1]!;
  let from = 1, to = points.length - 2;
  while (to >= from && (points[to]!.x - last.x) * endTangent.x + (points[to]!.y - last.y) * endTangent.y > 0) to--;
  while (from <= to && (points[from]!.x - first.x) * startTangent.x + (points[from]!.y - first.y) * startTangent.y < 0) from++;
  return [first, ...points.slice(from, to + 1), last];
}

function allowsDirection(direction: 'both' | 'aToB' | 'bToA', forward: boolean): boolean {
  return direction === 'both' || (direction === 'aToB') === forward;
}

/** `value` taken out of the list at `key`; the list gone when empty. */
function drop<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (!list) return;
  const at = list.indexOf(value);
  if (at >= 0) list.splice(at, 1);
  if (!list.length) map.delete(key);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

