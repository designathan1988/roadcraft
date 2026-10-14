import { Polyline } from '@core/polyline';
import { offsetPolyline } from '@core/offset';
import { type Vec2, angleOf, normalize, sub } from '@core/vec2';
import { MIN_RIBBON, normalizeAngle } from '@core/scalar';
import { Digest } from '@core/digest';
import type { NodeId, SegmentId } from './ids';
import { movementKey, type JunctionControl, type RoadDoc } from './doc';
import type { Network } from './network';
import { laneOffset, laneWidth, roadProfile, travelLanes } from './roadTypes';
import { PARKING_DEPTH } from './parking';
import { laneLineCrossable, laneTurnAllowed, laneUse } from './roadSection';
import { linksDigest, linksOf } from './roads/connectors';
import { orientedPolyline } from './geometry';
import { type ApproachGroup, computeApproachGroups } from './approachGroups';
import { TUNNELS_DRAWN } from './structures';
import { JunctionSurface, bulbTurnPath, medianUturnPath, turnPath } from './turnPaths';
import { BULB_TURN_RADIUS } from './junction/bulb';
import type { BodyClass } from './conflictPoints';
import { m } from './units';

/**
 * How far along a leg to look when deciding which approaches share an axis.
 *
 * Far enough that a slight kink at the node does not split an axis, near
 * enough that a real curve is not straightened away.
 */
const GROUPING_LOOKAHEAD_FRACTION = 0.2;
const GROUPING_LOOKAHEAD_MAX = m(4.8);

export type LaneletId = string;
export type ConnectorId = string;
export type TurnKind = 'through' | 'left' | 'right' | 'uturn';

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

/** What one junction built, kept between builds (`buildJunctions`). */
interface JunctionCache {
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

export const connectorId = (from: LaneletId, to: LaneletId): ConnectorId => `${from}->${to}`;

/**
 * Classifies a movement from its heading change.
 *
 * THIS WAS MIRRORED, and it is the whole of the "signals turn the wrong way"
 * defect. It claimed +Y ran down the map; it does not. The renderer maps world
 * `(x, y)` to three's `(x, h, -y)`, which puts +Y UP on screen - measured, not
 * assumed: projecting `(0, 100)` lands 105 pixels ABOVE the origin. So the
 * frame is right-handed on screen, a positive heading change is
 * counter-clockwise, and counter-clockwise is a LEFT turn.
 *
 * Every other file already agreed with that. `laneOffset` pushes traffic onto
 * `-perp` and calls it right-hand traffic; `render/signals.ts` puts the head
 * on `-perp` and calls it the right-hand kerb. Only this function read the
 * sign the other way, and because every rule downstream is keyed on the label
 * it produces, all of them applied to the opposite movement:
 *
 *   - `laneIsPlausible` made left turns leave from the kerb lane and right
 *     turns from the innermost lane, so both crossed their own approach's
 *     through lanes;
 *   - the right-on-red exemption in `sim/signals/permission.ts` was granted to
 *     the turn that crosses oncoming traffic. Measured over 1500 s of traffic:
 *     every one of the 11 entries on red was a real LEFT turn, 4 of them while
 *     the crossing street had green;
 *   - `CRITICAL_GAP` gave the left turn the shorter gap meant for the right,
 *     and `turnSpeedFactor` the wrong speed.
 */
export function classifyTurn(inDir: Vec2, outDir: Vec2): TurnKind {
  const delta = normalizeAngle(angleOf(outDir) - angleOf(inDir));
  const deg = (delta * 180) / Math.PI;
  if (Math.abs(deg) > 150) return 'uturn';
  if (deg > 30) return 'left';
  if (deg < -30) return 'right';
  return 'through';
}

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
  }

  /**
   * Another graph's caches, as this one's own: the simulation builds the graph
   * of an edit ahead on a graph of its own, a few milliseconds a frame
   * (`SimWorld.prepareVehicleTopology`), and the graph its agents run on then
   * takes every link and junction from it instead of turning them all again
   * in the frame of the swap (docs/performance.md #25).
   */
  seedCaches(from: LaneletGraph): void {
    for (const [key, value] of from.linkCache) this.linkCache.set(key, value);
    for (const [key, value] of from.junctionCache) this.junctionCache.set(key, value);
  }

  /** `build` in steps, a segment's links or a junction's connectors at a time. */
  *buildSteps(doc: RoadDoc, net: Network): Generator<void, void, void> {
    this.siblings.clear();
    this.changes.clear();
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
    yield* this.buildJunctions(doc, net, previousJunctions, nextJunctions);
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
      laneletWork.segments++;
      const seg = doc.requireSegment(segId);
      // A tunnel with no geometry carries no traffic. Skipping the link
      // lanelets removes the segment from the routing graph outright — no
      // lanelets, no connectors, no junction groups — so a vehicle can never
      // pass silently through a bore that is not drawn. The segment itself
      // stays in the document, authored and saved normally.
      if (seg.structure === 'tunnel' && !TUNNELS_DRAWN) continue;
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
  }

  private *buildJunctions(doc: RoadDoc, net: Network,
    previous: Map<string, JunctionCache>, next: Map<string, JunctionCache>): Generator<void, void, void> {
    for (const [nodeId, node] of doc.nodes) {
      yield;
      laneletWork.nodes++;
      // A road's end that is a turning circle turns its traffic round (`junction/bulb.ts`).
      const bulb = node.incident.length === 1 && node.end === 'bulb';
      if (node.incident.length < 2 && !bulb) continue;
      // The surface a turn has to stay on, built once per node and only when
      // the node actually has a movement to shape.
      let surface: JunctionSurface | null | undefined;
      const surfaceOf = (): JunctionSurface | null => (surface ??= new JunctionSurface(net, nodeId));

      const inbound = (this.inbound.get(nodeId) ?? []).slice().sort();
      const outbound = (this.outbound.get(nodeId) ?? []).slice().sort();
      if (!inbound.length || !outbound.length) continue;

      // What a junction's connectors are made of, read in full from this loop
      // and the calls under it: the surface the turns are shaped across, the
      // node's own `control`, `incident` and `blockedMovements`, and every
      // lanelet that meets there — whose own keys carry each segment's type,
      // section, direction and geometry (`buildLinks`). All of it is here, so
      // moving any one of them moves the key:
      //
      //   `node.control` -> `shouldSignalise`
      //   `node.crossing` -> a mid-block crossing's own junction
      //   `node.incident` -> the leg list, `computeApproachGroups`
      //   `node.blockedMovements` -> which movements are dropped
      //   the lanelet keys -> `surface.centre`, the turn geometry, lane counts,
      //   `carriedPair`'s ranking by `section.priority ?? type`
      //   `surface.key` -> the junction's own rings and the incident ribbons'
      //
      // `turnPath` needs the surface anyway, so asking for its key costs
      // nothing extra — and a junction an edit did not reach hands back the
      // connectors it had, objects and all.
      const surfaceKey = surfaceOf()?.key ?? '';
      const key = `${nodeId}|${new Digest().addText(String(surfaceKey)).addText(node.control)
        .addText(node.crossing ? `${node.crossing.kind},${node.crossing.segment}` : '-')
        .addText(node.incident.join(',')).addText(node.blockedMovements.join(',')).addText(linksDigest(node.laneLinks))
        .addText(`${node.uturn ?? '-'}${node.end ?? '-'}`)
        .addText(inbound.map((id) => this.laneletKeys.get(id) ?? id).join('|'))
        .addText(outbound.map((id) => this.laneletKeys.get(id) ?? id).join('|')).value()}`;
      const known = key ? previous.get(key) : undefined;
      if (known) {
        for (const lanelet of known.lanelets) this.lanelets.set(lanelet.id, lanelet);
        for (const connector of known.connectors) {
          this.connectors.set(connector.id, connector);
          push(this.exits, connector.fromLane, connector.id);
        }
        this.junctions.set(nodeId, {
          node: nodeId,
          groups: known.groups,
          connectors: known.connectors.map((connector) => connector.id),
          inbound,
          signalised: known.signalised,
          control: node.control,
        });
        next.set(key, known);
        continue;
      }

      // Only a leg that brings traffic INTO the node is an approach. A one-way
      // road leaving the junction used to get a signal group of its own: a head
      // facing an empty carriageway, and a whole stage of every cycle spent
      // showing green to nobody while every real approach waited at red.
      const approaching = new Set<SegmentId>();
      for (const id of inbound) {
        const segment = this.lanelets.get(id)?.segment;
        if (segment !== undefined) approaching.add(segment);
      }
      const legs = node.incident
        .slice()
        .filter((segId) => approaching.has(segId))
        .sort((a, b) => a - b)
        .map((segId) => {
          const seg = doc.requireSegment(segId);
          const pl = orientedPolyline(doc, seg, nodeId);
          return { segment: segId, dir: smoothedDirectionFromNode(pl) };
        });

      const groups = computeApproachGroups(legs);
      const groupBySegment = new Map<SegmentId, number>();
      for (const g of groups) for (const s of g.segments) groupBySegment.set(s, g.id);

      const connectorIds: ConnectorId[] = [];
      const road = carriedPair(doc, nodeId);

      const addConnector = (
        inId: LaneletId, inLane: Lanelet, outId: LaneletId, outLane: Lanelet, turn: TurnKind, carried = false,
      ): void => {
        const cid = connectorId(inId, outId);
        if (this.connectors.has(cid)) return;
        const waiting = inbound
          .map((id) => this.lanelets.get(id))
          .filter((l): l is Lanelet => !!l && l.id !== inId);
        const inCentre = inLane.centre, outCentre = outLane.centre;
        const turnResult = bulb
          ? bulbTurnPath(inCentre, outCentre, surfaceOf(), { x: node.x, y: node.y }, BULB_TURN_RADIUS)
          : node.uturn === inLane.segment && turn === 'uturn' && node.incident.length === 2
            ? medianUturnPath(inCentre, outCentre, surfaceOf())
            : turnPath(inCentre, outCentre, surfaceOf(), waiting, {
              fromRoadEnd: inLane.from !== undefined && doc.mapEdge(inLane.from),
              toRoadEnd: outLane.to !== undefined && doc.mapEdge(outLane.to),
            });
        const path = turnResult.path;
        const lanelet: Lanelet = {
          id: cid,
          kind: 'connector',
          centre: path,
          length: path.length,
          speedLimit: Math.min(inLane.speedLimit, outLane.speedLimit) * turnSpeedFactor(turn),
          controlled: false,
          node: nodeId,
          fromLane: inId,
          toLane: outId,
          turn,
          group: groupBySegment.get(inLane.segment as SegmentId) ?? 0,
        };
        this.lanelets.set(cid, lanelet);
        this.connectors.set(cid, {
          id: cid,
          lanelet: cid,
          node: nodeId,
          fromLane: inId,
          toLane: outId,
          inSegment: inLane.segment as SegmentId,
          outSegment: outLane.segment as SegmentId,
          turn,
          carried,
          group: lanelet.group ?? 0,
          length: path.length,
          maxBodyClass: turnResult.maxBodyClass,
        });
        push(this.exits, inId, cid);
        connectorIds.push(cid);
      };

      for (const inId of inbound) {
        const inLane = this.lanelets.get(inId);
        if (!inLane || inLane.segment === undefined) continue;
        const inDir = endDirection(inLane.centre);
        const incomingSegment = doc.requireSegment(inLane.segment);
        const rules = inLane.from === incomingSegment.a ? incomingSegment.section?.turnsForward : incomingSegment.section?.turnsBackward;
        const rule = rules?.[inLane.laneIndex ?? 0];
        const authored = rule !== undefined && rule !== 'all';
        // The player's own connections for this lane (docs/VIAS.md V4,
        // `roads/connectors.ts`): exactly those, when any is still valid;
        // a movement the node bans stays banned.
        const manual = linksOf(node.laneLinks, inLane.segment, inLane.laneIndex ?? 0);
        if (manual.length) {
          let made = 0;
          for (const link of manual) {
            const outId = outbound.find((id) => {
              const l = this.lanelets.get(id);
              return l?.segment === link.to && (l.laneIndex ?? 0) === link.toLane;
            });
            const outLane = outId === undefined ? undefined : this.lanelets.get(outId);
            if (!outId || !outLane) continue;
            if (node.blockedMovements.includes(movementKey(inLane.segment, link.to))) continue;
            const isReverse = outLane.segment === inLane.segment;
            const turn = isReverse ? 'uturn' : classifyTurn(inDir, tangentAtStart(outLane.centre));
            const carried = !isReverse && road !== null && road.includes(inLane.segment) && road.includes(link.to);
            addConnector(inId, inLane, outId, outLane, turn, carried);
            made++;
          }
          if (made > 0) continue;
        }
        const legal: { outId: LaneletId; outLane: Lanelet; turn: TurnKind; carried: boolean }[] = [];
        // U-turns the lane-count rule above set aside. They come back only for
        // a lane that has nothing else: where two roads both run back to the
        // same node (a lens of two curves), EVERY movement classifies as a
        // U-turn, and dropping them all left the lane with no exit at all - a
        // car driving into a node it can never leave (the fuzzer's
        // `deadLanelet`).
        const dropped: typeof legal = [];

        for (const outId of outbound) {
          const outLane = this.lanelets.get(outId);
          if (!outLane || outLane.segment === undefined) continue;

          // A movement back down the segment it came from is a U-turn; allow it
          // only where there is nowhere else to go.
          const isReverse = outLane.segment === inLane.segment;
          const outDir = tangentAtStart(outLane.centre);
          const turn = isReverse ? 'uturn' : classifyTurn(inDir, outDir);
          if (!laneTurnAllowed(rule, turn)) continue;
          // The road the node is ON carries its lanes across, however it bends.
          const carried = !isReverse && road !== null &&
            road.includes(inLane.segment) && road.includes(outLane.segment);
          const inSegment = doc.requireSegment(inLane.segment);
          const inLanes = travelLanes(
            roadProfile(inSegment.type, inSegment.lanes, inSegment.direction, inSegment.section, inSegment.parking),
            inSegment.direction,
          );
          const outSegment = doc.requireSegment(outLane.segment);
          const outLanes = travelLanes(
            roadProfile(outSegment.type, outSegment.lanes, outSegment.direction, outSegment.section, outSegment.parking),
            outSegment.direction,
          );
          if (node.blockedMovements.includes(movementKey(inLane.segment, outLane.segment))) continue;
          if (turn === 'uturn' && outbound.length > inLanes) {
            dropped.push({ outId, outLane, turn, carried });
            continue;
          }
          legal.push({ outId, outLane, turn, carried });
          const receivesAuthoredTurn = turn === 'left' ? (outLane.laneIndex ?? 0) === 0 :
            turn === 'right' ? (outLane.laneIndex ?? 0) === outLanes - 1 :
              (outLane.laneIndex ?? 0) === (inLane.laneIndex ?? 0);
          if (authored ? receivesAuthoredTurn : laneIsPlausible(inLane, outLane, carried ? 'through' : turn, inLanes, outLanes)) {
            addConnector(inId, inLane, outId, outLane, turn, carried);
          }
        }

        // A wide road may feed a narrower exit. Strict lane matching is useful
        // where alternatives exist, but it must never leave an outer lane with
        // no route at all: vehicles spawned there would reach a green signal
        // with no connector to request. Merge that lane onto the best legal
        // outbound path only when the normal pairing produced none.
        if (this.exitsOf(inId).length === 0 && !legal.length) legal.push(...dropped);
        if (this.exitsOf(inId).length === 0 && legal.length) {
          legal.sort((a, b) =>
            fallbackTurnRank(a.turn) - fallbackTurnRank(b.turn) ||
            (a.outLane.laneIndex ?? 0) - (b.outLane.laneIndex ?? 0) ||
            a.outId.localeCompare(b.outId),
          );
          const fallback = legal[0]!;
          // A lane that merges into the road it is on is still that road:
          // losing `carried` here made the dropped lane give way at a node of
          // three legs, and the lane beside it never had to let it in.
          addConnector(inId, inLane, fallback.outId, fallback.outLane, fallback.turn, fallback.carried);
        }
      }

      // A U-turn through the median (docs/VIAS.md V8, retorno): from the
      // inner lane of the road it serves, by the median, back the other way -
      // swept like any turn, so only what a body fits is driven (`maxBodyClass`).
      if (node.uturn !== undefined && node.incident.length === 2) {
        for (const inId of inbound) {
          const inLane = this.lanelets.get(inId);
          if (!inLane || inLane.segment !== node.uturn || (inLane.laneIndex ?? 0) !== 0) continue;
          for (const outId of outbound) {
            const outLane = this.lanelets.get(outId);
            if (outLane?.segment === inLane.segment) addConnector(inId, inLane, outId, outLane, 'uturn');
          }
        }
      }

      // Signalise anything with three or more legs that carries real traffic.
      const signalised = shouldSignalise(node.control, node.incident, doc);
      this.junctions.set(nodeId, {
        node: nodeId,
        groups,
        connectors: connectorIds,
        inbound,
        signalised,
        control: node.control,
      });
      next.set(key, {
        groups,
        signalised,
        connectors: connectorIds.map((id) => this.connectors.get(id)!),
        lanelets: connectorIds.map((id) => this.lanelets.get(id)!),
      });
    }
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

function shouldSignalise(
  control: JunctionControl,
  incident: readonly SegmentId[],
  doc: RoadDoc,
): boolean {
  if (control === 'signal') return true;
  if (control !== 'auto') return false;
  return incident.length >= 3 &&
    (incident.length >= 4 || incident.some((s) => {
      const segment = doc.requireSegment(s);
      return roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking).lanes >= 4;
    }));
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const turnSpeedFactor = (turn: TurnKind): number =>
  turn === 'through' ? 1 : turn === 'right' ? 0.6 : turn === 'left' ? 0.65 : 0.45;

function endDirection(pl: Polyline): Vec2 {
  if (pl.n < 2) return { x: 1, y: 0 };
  return pl.sampleAt(pl.length).t;
}

/**
 * The immediate tangent where a lane leaves its node.
 *
 * Deliberately unsmoothed. Turn classification asks what a driver does at
 * the junction, so a curve further along the block must not rotate the
 * answer — a left turn onto a road that bends right is still a left turn.
 */
function tangentAtStart(pl: Polyline): Vec2 {
  if (pl.n < 2) return { x: 1, y: 0 };
  return pl.sampleAt(0).t;
}

/** A pair of legs clearly straighter than every other pair by at least this much. */
const CARRIED_MARGIN = (15 * Math.PI) / 180;
/** A pair bending more than this is a corner between two roads, not one road. */
const CARRIED_MAX_BEND = (100 * Math.PI) / 180;
/** Below this bend a movement is already classified as straight on. */
const STRAIGHT_BEND = (30 * Math.PI) / 180;

/**
 * The two legs that are ONE ROAD carried across a node, when that road bends.
 *
 * `classifyTurn` calls anything bending more than 30 degrees a turn. For a
 * movement from one road into another that is right; for a road that simply
 * bends at a node it is only half right - it states how sharp the bend is,
 * which speed and the indicator should read - and two things keyed on the
 * label went wrong with it:
 *
 *   - lane pairing. A turn leaves from the lane on its own side and arrives in
 *     the lane on its own side, so a two-lane carriageway bending 45 degrees at
 *     a node was paired lane 0 to lane 0 only, and lane 1 was merged into lane
 *     0 by the no-route fallback: every such bend a lane drop. On a ring of
 *     streets - a roundabout drawn as a polygon, bending at every node - the
 *     circulating carriageway became a single lane with a merge at every node,
 *     and it locked solid: not one vehicle left it in five minutes;
 *   - right of way. `continues` in `sim/intersections/admission.ts` makes the
 *     road the node is on the priority road; with no straight-on movement
 *     nothing was, and every approach gave way to every other;
 *
 * A node of two legs is one road, whatever the angle. At a node of three or
 * more with no straight-on pair at all, the road is the pair that goes on most
 * nearly straight among the pairs of the highest class - and only when one
 * pair clearly does, so a symmetric Y keeps its three turns.
 */
function carriedPair(doc: RoadDoc, nodeId: NodeId): readonly SegmentId[] | null {
  const node = doc.node(nodeId);
  if (!node) return null;
  const incident = [...new Set(node.incident)];
  if (incident.length === 2) return incident;
  if (incident.length < 3) return null;
  const legs = incident.map((segment) => {
    const seg = doc.requireSegment(segment);
    return { segment, type: seg.section?.priority ?? seg.type, dir: smoothedDirectionFromNode(orientedPolyline(doc, seg, nodeId)) };
  });
  const pairs: { members: SegmentId[]; rank: number; bend: number }[] = [];
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i]!;
      const b = legs[j]!;
      // Both directions point away from the node: a straight road has them
      // opposed, so the bend is what is left of a half turn.
      const between = Math.abs(normalizeAngle(angleOf(b.dir) - angleOf(a.dir)));
      const bend = Math.PI - between;
      if (bend < STRAIGHT_BEND) return null;
      pairs.push({ members: [a.segment, b.segment], rank: Math.min(a.type, b.type), bend });
    }
  }
  pairs.sort((a, b) => b.rank - a.rank || a.bend - b.bend);
  const best = pairs[0];
  if (!best || best.bend > CARRIED_MAX_BEND) return null;
  const rival = pairs.find((p) => p !== best && p.rank === best.rank);
  if (rival && rival.bend - best.bend < CARRIED_MARGIN) return null;
  return best.members;
}

/**
 * The direction of a leg once a kink at the node is smoothed away.
 *
 * Approach grouping asks a different question from turn classification:
 * which arms of a junction form one axis and can share a signal stage. A
 * slight bend right at the node must not split an otherwise straight axis,
 * so this looks ahead before deciding.
 *
 * The two therefore DISAGREE on a curved leg, and that is correct. They were
 * once both spelled with the same function name - one local here, one an
 * unused export elsewhere - which made the disagreement look like a bug and
 * invited someone to "fix" it by unifying them.
 */
function smoothedDirectionFromNode(pl: Polyline): Vec2 {
  const look = Math.min(GROUPING_LOOKAHEAD_MAX, Math.max(1, pl.length * GROUPING_LOOKAHEAD_FRACTION));
  return normalize(sub(pl.sampleAt(look).p, pl.point(0)));
}

/**
 * Rejects lane pairings that no driver would make, so the connector set stays
 * small and turns start and finish in sensible lanes. Lane 0 is innermost.
 */
/**
 * Whether a movement from this lane to that one is one a driver would make.
 *
 * `laneIndex` 0 is the INNERMOST lane; higher indices sit progressively further
 * to the right of travel. So the innermost lane turns left and the outermost
 * lane turns right.
 *
 * THE RULE THAT MATTERS: connections leaving one approach are ORDER PRESERVING
 * and INJECTIVE — lane `i` goes to lane `i`, and no two of them ever land on
 * the same receiving lane. Two paths that keep their lane order are concentric;
 * they never cross. Two that converge do, and `ConflictIndex` then generates a
 * perfectly correct crossing point between two movements that a real layout
 * draws as parallel.
 *
 * That is not a hypothetical. The previous rule was
 *
 *   if (turn === 'right') return i === 0 || o === i;   // lane 0 -> ANY lane
 *   return o === i || Math.abs(o - i) === 1;           // through may drift one
 *
 * so `right(lane 0)` reached every receiving lane and `through` could drift
 * sideways. Measured on a 4x4 grid of four-lane avenues, 89.1 % of the conflicts
 * that stopped a vehicle at its own green light named a holder on the SAME
 * approach that was ALSO green — 56.8 % of them a second right turn, and even
 * `through(0)` against `through(1)`, which cannot cross under any geometry.
 *
 * Unequal lane counts are handled by the merge fallback in `build`, not here:
 * an inbound lane that this rule leaves with no exit at all is given one, and
 * that merge is deliberate and singular rather than an accident of pairing.
 *
 * LANE DISCIPLINE (CTB art. 38). A driver about to turn must already be in the
 * lane the turn leaves from, and must land in the corresponding lane of the
 * receiving road — never cross the carriageway to reach the turn. So a right
 * turn leaves the OUTERMOST lane and enters the outermost receiving lane, and a
 * left turn leaves the innermost and enters the innermost.
 *
 * That makes a turn reachable only from one lane, which is exactly why
 * `src/sim/vehicles/laneChange.ts` exists: a vehicle that wants a turn its
 * current lane cannot serve moves across to the lane that can, in advance, with
 * a gap. Before lane changing existed this rule was unshippable, because a left
 * turn lands a vehicle in the innermost lane and a following right turn was
 * then unreachable for the rest of its life.
 */
function laneIsPlausible(
  inLane: Lanelet,
  outLane: Lanelet,
  turn: TurnKind,
  inLanes: number,
  outLanes: number,
): boolean {
  const i = inLane.laneIndex ?? 0;
  const o = outLane.laneIndex ?? 0;
  if (turn === 'left' || turn === 'uturn') return i === 0 && o === 0;
  if (turn === 'right') return i === inLanes - 1 && o === outLanes - 1;
  return o === i;
}

/** Prefer a forward continuation when a necessary lane merge has no exact match. */
function fallbackTurnRank(turn: TurnKind): number {
  if (turn === 'through') return 0;
  if (turn === 'right') return 1;
  if (turn === 'left') return 2;
  return 3;
}

