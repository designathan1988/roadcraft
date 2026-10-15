import { Polyline } from '@core/polyline';
import { type Vec2, angleOf, normalize, sub } from '@core/vec2';
import { normalizeAngle } from '@core/scalar';
import { Digest } from '@core/digest';
import type { NodeId, SegmentId } from './ids';
import type { JunctionControl, RoadNode } from './doc';
import { segmentLine } from './geometry';
import { roadProfile, travelLanes } from './roadTypes';
import { laneTurnAllowed } from './roadSection';
import { linksDigest, linksOf, movementKey } from './roads/connectors';
import { type ApproachGroup, computeApproachGroups } from './approachGroups';
import { JunctionSurface, type TurnPathResult, bulbTurnPath, medianUturnPath, turnPath, unflat } from './turnPaths';
import type { SurfaceSource } from './surfaceParts';
import { JunctionTurns } from './junctionTurns';
import { BULB_TURN_RADIUS } from './junction/bulb';
import type { BodyClass, JunctionAnswer, JunctionAsk, JunctionLeg, JunctionNode, LaneAsk, TurnKind } from './conflictTable';

export type { JunctionAnswer, JunctionAsk, JunctionLeg, JunctionMeasurer, LaneAsk, TurnKind } from './conflictTable';
import { m } from './units';

/**
 * ONE JUNCTION'S MOVEMENTS, FROM PURE DATA: its node, the roads that meet there, the lanes arriving and
 * leaving, the surface round it - in, its connectors with their shaped turns, its approach groups and
 * whether it is signalised - out. The same code builds a junction on the page (`LaneletGraph.buildJunction`,
 * from the document and the network) and in a conflict worker (`buildJunctionOf`, from the numbers the page
 * sent, `conflictPool.ts`), so the two are the same junction to the last bit (`tests/sim/topologyOffPage.spec.ts`).
 * DO NOT read the document, the network or the graph here: a worker has none of them. Moved out of
 * `lanelets.ts` (2026-10-15).
 */

export const connectorId = (from: string, to: string): string => `${from}->${to}`;

/** A link lane arriving at or leaving the junction (`LaneletGraph.buildSegmentLinks`), its centre made (`LaneAsk` as sent). */
export interface JunctionLane extends Omit<LaneAsk, 'centre'> {
  readonly centre: Polyline;
}

/** Everything one junction's connectors are made of, but its surface (`junctionMovements`). */
export interface JunctionInput {
  readonly node: JunctionNode;
  /** Every road meeting it, once each. */
  readonly legs: readonly JunctionLeg[];
  /** The lanes arriving, and leaving, in id order. */
  readonly inbound: readonly JunctionLane[];
  readonly outbound: readonly JunctionLane[];
}

/** A movement through the junction as `junctionMovements` made it. */
interface MadeConnector {
  /** Its lanes, by their place in `JunctionInput.inbound` and `outbound`. */
  readonly from: number;
  readonly to: number;
  readonly turn: TurnKind;
  readonly carried: boolean;
  readonly group: number;
  readonly speedLimit: number;
  readonly path: Polyline;
  readonly maxBodyClass: BodyClass | -1;
  /** Set when its turn was left to be chosen off the page (`JunctionTurns.defer`): how it is shaped again once chosen. */
  readonly again?: () => TurnPathResult;
}

/** One junction's movements, in the order made, with its approach groups and its control. */
export interface JunctionMade {
  readonly groups: readonly ApproachGroup[];
  readonly signalised: boolean;
  readonly connectors: readonly MadeConnector[];
}

/** Whether a node with these lanes is a junction at all: two roads meet, or a road ends in a turning circle; traffic arrives and leaves. */
export function isJunction(node: Pick<RoadNode, 'incident' | 'end'>, inbound: number, outbound: number): boolean {
  // A road's end that is a turning circle turns its traffic round (`junction/bulb.ts`).
  const bulb = node.incident.length === 1 && node.end === 'bulb';
  return (node.incident.length >= 2 || bulb) && inbound > 0 && outbound > 0;
}

/**
 * The key a junction's connectors are kept under, from its surface's key (`JunctionSurface.key`).
 *
 * What a junction's connectors are made of, read in full by `junctionMovements` and the calls under it:
 * the surface the turns are shaped across, the node's own `control`, `incident` and `blockedMovements`,
 * and every lanelet that meets there - whose own keys carry each segment's type, section, direction and
 * geometry (`LaneletGraph.buildSegmentLinks`). All of it is here, so moving any one of them moves the key:
 *
 *   `node.control` -> `shouldSignalise`
 *   `node.crossing` -> a mid-block crossing's own junction
 *   `node.incident` -> the leg list, `computeApproachGroups`
 *   `node.blockedMovements` -> which movements are dropped
 *   the lanelet keys -> `surface.centre`, the turn geometry, lane counts,
 *   `carriedPair`'s ranking by `section.priority ?? type`
 *   `surface.key` -> the junction's own rings and the incident ribbons'
 */
export function junctionKey(j: JunctionInput, surfaceKey: string): string {
  const node = j.node;
  return `${node.id}|${new Digest().addText(String(surfaceKey)).addText(node.control)
    .addText(node.crossing ? `${node.crossing.kind},${node.crossing.segment}` : '-')
    .addText(node.incident.join(',')).addText(node.blockedMovements.join(',')).addText(linksDigest(node.laneLinks))
    .addText(`${node.uturn ?? '-'}${node.end ?? '-'}`)
    .addText(j.inbound.map((lane) => lane.key).join('|'))
    .addText(j.outbound.map((lane) => lane.key).join('|')).value()}`;
}

/** A leg's centreline oriented to start at `from` (`geometry.ts` `orientedPolyline`, from the leg's own numbers). */
function legLine(leg: JunctionLeg, from: NodeId): Polyline {
  const line = segmentLine(leg.from, leg.to, leg.segment.curve);
  return leg.segment.a === from ? line : line.reversed();
}

/**
 * The connectors of one junction (`isJunction`), shaped across its surface (`surfaceOf`, made only when a
 * movement is shaped), their turns found, kept and left to choose off the page in `turns`.
 */
export function junctionMovements(j: JunctionInput, surfaceOf: () => JunctionSurface | null, turns: JunctionTurns): JunctionMade {
  const { node, inbound, outbound } = j;
  const bulb = node.incident.length === 1 && node.end === 'bulb';
  const legOf = new Map<SegmentId, JunctionLeg>();
  for (const l of j.legs) legOf.set(l.segment.id, l);
  const leg = (segment: SegmentId): JunctionLeg => {
    const found = legOf.get(segment);
    if (!found) throw new Error(`junction ${node.id} has no road ${segment}`);
    return found;
  };
  // Only a leg that brings traffic INTO the node is an approach. A one-way
  // road leaving the junction used to get a signal group of its own: a head
  // facing an empty carriageway, and a whole stage of every cycle spent
  // showing green to nobody while every real approach waited at red.
  const approaching = new Set<SegmentId>();
  for (const lane of inbound) approaching.add(lane.segment);
  const legs = node.incident
    .slice()
    .filter((segId) => approaching.has(segId))
    .sort((a, b) => a - b)
    .map((segId) => ({ segment: segId, dir: smoothedDirectionFromNode(legLine(leg(segId), node.id)) }));

  const groups = computeApproachGroups(legs);
  const groupBySegment = new Map<SegmentId, number>();
  for (const g of groups) for (const s of g.segments) groupBySegment.set(s, g.id);

  const made: MadeConnector[] = [];
  const ids = new Set<string>();
  /** How many movements each arriving lane has. */
  const exits = new Array<number>(inbound.length).fill(0);
  const road = carriedPair(node, leg);

  const addConnector = (i: number, o: number, turn: TurnKind, carried = false): void => {
    const inLane = inbound[i]!, outLane = outbound[o]!;
    const cid = connectorId(inLane.id, outLane.id);
    if (ids.has(cid)) return;
    const waiting = inbound.filter((lane) => lane.id !== inLane.id);
    const inCentre = inLane.centre, outCentre = outLane.centre;
    const deferred = turns.deferred;
    const shape = (): TurnPathResult => (bulb
      ? bulbTurnPath(inCentre, outCentre, surfaceOf(), { x: node.x, y: node.y }, BULB_TURN_RADIUS)
      : node.uturn === inLane.segment && turn === 'uturn' && node.incident.length === 2
        ? medianUturnPath(inCentre, outCentre, surfaceOf())
        : turnPath(inCentre, outCentre, surfaceOf(), waiting, { fromRoadEnd: inLane.fromEdge, toRoadEnd: outLane.toEdge }, turns));
    const { path, maxBodyClass } = shape();
    ids.add(cid);
    exits[i]!++;
    made.push({
      from: i, to: o, turn, carried, group: groupBySegment.get(inLane.segment) ?? 0,
      speedLimit: Math.min(inLane.speedLimit, outLane.speedLimit) * turnSpeedFactor(turn), path, maxBodyClass,
      ...(turns.deferred !== deferred ? { again: shape } : {}),
    });
  };

  for (let i = 0; i < inbound.length; i++) {
    const inLane = inbound[i]!;
    const inDir = endDirection(inLane.centre);
    const incomingSegment = leg(inLane.segment).segment;
    const rules = inLane.from === incomingSegment.a ? incomingSegment.section?.turnsForward : incomingSegment.section?.turnsBackward;
    const rule = rules?.[inLane.laneIndex];
    const authored = rule !== undefined && rule !== 'all';
    // The player's own connections for this lane (docs/VIAS.md V4,
    // `roads/connectors.ts`): exactly those, when any is still valid;
    // a movement the node bans stays banned.
    const manual = linksOf(node.laneLinks, inLane.segment, inLane.laneIndex);
    if (manual.length) {
      let count = 0;
      for (const link of manual) {
        const o = outbound.findIndex((lane) => lane.segment === link.to && lane.laneIndex === link.toLane);
        if (o < 0) continue;
        const outLane = outbound[o]!;
        if (node.blockedMovements.includes(movementKey(inLane.segment, link.to))) continue;
        const isReverse = outLane.segment === inLane.segment;
        const turn = isReverse ? 'uturn' : classifyTurn(inDir, tangentAtStart(outLane.centre));
        const carried = !isReverse && road !== null && road.includes(inLane.segment) && road.includes(link.to);
        addConnector(i, o, turn, carried);
        count++;
      }
      if (count > 0) continue;
    }
    const legal: { o: number; turn: TurnKind; carried: boolean }[] = [];
    // U-turns the lane-count rule above set aside. They come back only for
    // a lane that has nothing else: where two roads both run back to the
    // same node (a lens of two curves), EVERY movement classifies as a
    // U-turn, and dropping them all left the lane with no exit at all - a
    // car driving into a node it can never leave (the fuzzer's
    // `deadLanelet`).
    const dropped: typeof legal = [];

    for (let o = 0; o < outbound.length; o++) {
      const outLane = outbound[o]!;
      // A movement back down the segment it came from is a U-turn; allow it
      // only where there is nowhere else to go.
      const isReverse = outLane.segment === inLane.segment;
      const outDir = tangentAtStart(outLane.centre);
      const turn = isReverse ? 'uturn' : classifyTurn(inDir, outDir);
      if (!laneTurnAllowed(rule, turn)) continue;
      // The road the node is ON carries its lanes across, however it bends.
      const carried = !isReverse && road !== null &&
        road.includes(inLane.segment) && road.includes(outLane.segment);
      const inSegment = leg(inLane.segment).segment;
      const inLanes = travelLanes(
        roadProfile(inSegment.type, inSegment.lanes, inSegment.direction, inSegment.section, inSegment.parking),
        inSegment.direction,
      );
      const outSegment = leg(outLane.segment).segment;
      const outLanes = travelLanes(
        roadProfile(outSegment.type, outSegment.lanes, outSegment.direction, outSegment.section, outSegment.parking),
        outSegment.direction,
      );
      if (node.blockedMovements.includes(movementKey(inLane.segment, outLane.segment))) continue;
      if (turn === 'uturn' && outbound.length > inLanes) {
        dropped.push({ o, turn, carried });
        continue;
      }
      legal.push({ o, turn, carried });
      const receivesAuthoredTurn = turn === 'left' ? outLane.laneIndex === 0 :
        turn === 'right' ? outLane.laneIndex === outLanes - 1 :
          outLane.laneIndex === inLane.laneIndex;
      if (authored ? receivesAuthoredTurn : laneIsPlausible(inLane, outLane, carried ? 'through' : turn, inLanes, outLanes)) {
        addConnector(i, o, turn, carried);
      }
    }

    // A wide road may feed a narrower exit. Strict lane matching is useful
    // where alternatives exist, but it must never leave an outer lane with
    // no route at all: vehicles spawned there would reach a green signal
    // with no connector to request. Merge that lane onto the best legal
    // outbound path only when the normal pairing produced none.
    if (exits[i] === 0 && !legal.length) legal.push(...dropped);
    if (exits[i] === 0 && legal.length) {
      legal.sort((a, b) =>
        fallbackTurnRank(a.turn) - fallbackTurnRank(b.turn) ||
        outbound[a.o]!.laneIndex - outbound[b.o]!.laneIndex ||
        outbound[a.o]!.id.localeCompare(outbound[b.o]!.id),
      );
      const fallback = legal[0]!;
      // A lane that merges into the road it is on is still that road:
      // losing `carried` here made the dropped lane give way at a node of
      // three legs, and the lane beside it never had to let it in.
      addConnector(i, fallback.o, fallback.turn, fallback.carried);
    }
  }

  // A U-turn through the median (docs/VIAS.md V8, retorno): from the
  // inner lane of the road it serves, by the median, back the other way -
  // swept like any turn, so only what a body fits is driven (`maxBodyClass`).
  if (node.uturn !== undefined && node.incident.length === 2) {
    for (let i = 0; i < inbound.length; i++) {
      const inLane = inbound[i]!;
      if (inLane.segment !== node.uturn || inLane.laneIndex !== 0) continue;
      for (let o = 0; o < outbound.length; o++) if (outbound[o]!.segment === inLane.segment) addConnector(i, o, 'uturn');
    }
  }

  // Signalise anything with three or more legs that carries real traffic.
  return { groups, signalised: shouldSignalise(node.control, node.incident, leg), connectors: made };
}

// ------------------------------------------------------------------ off the page

/**
 * A junction's input and surface as a worker is sent them (`JunctionAsk`), with the turns of its build before.
 * `sent`: the lanes and roads already made for the asks of this message, by id - a lane arrives at one
 * junction and leaves another, a road meets two: one object each, so the message copies it once.
 */
export function junctionAsk(j: JunctionInput, surface: SurfaceSource, before: JunctionTurns | null,
  sent: { readonly lanes: Map<string, LaneAsk>; readonly legs: Map<SegmentId, JunctionLeg> }): JunctionAsk {
  const n = j.node;
  const lane = (l: JunctionLane): LaneAsk => {
    let made = sent.lanes.get(l.id);
    if (!made) {
      sent.lanes.set(l.id, made = {
        id: l.id, key: l.key, segment: l.segment, from: l.from, to: l.to, laneIndex: l.laneIndex, speedLimit: l.speedLimit,
        centre: l.centre.xy, fromEdge: l.fromEdge, toEdge: l.toEdge,
      });
    }
    return made;
  };
  const leg = ({ segment: s, from, to }: JunctionLeg): JunctionLeg => {
    let made = sent.legs.get(s.id);
    if (!made) {
      sent.legs.set(s.id, made = {
        segment: {
          id: s.id, a: s.a, b: s.b, curve: s.curve, type: s.type, lanes: s.lanes, direction: s.direction,
          ...(s.section ? { section: s.section } : {}), ...(s.parking ? { parking: s.parking } : {}),
        },
        from, to,
      });
    }
    return made;
  };
  return {
    node: {
      id: n.id, x: n.x, y: n.y, incident: n.incident, control: n.control, blockedMovements: n.blockedMovements,
      ...(n.crossing ? { crossing: n.crossing } : {}), ...(n.laneLinks ? { laneLinks: n.laneLinks } : {}),
      ...(n.uturn !== undefined ? { uturn: n.uturn } : {}), ...(n.end !== undefined ? { end: n.end } : {}),
    },
    legs: j.legs.map(leg),
    inbound: j.inbound.map(lane),
    outbound: j.outbound.map(lane),
    surface: {
      centre: surface.centre,
      parts: surface.parts.map((p) => ('full' in p ? { full: p.full.xy, half: p.half, mouth: p.mouth } : 'edges' in p ? p.flatXY()
        : Float64Array.from(p.flatMap((q) => [q.x, q.y])))),
    },
    before: before ? before.entries() : null,
  };
}

/**
 * One junction built from what the page sent (`JunctionAsk`): the surface made from its pieces, the key, the
 * connectors and their turns - `junctionKey` and `junctionMovements`, as the page runs them. `lines` and
 * `rings`: each lane, road and ring of a message made once.
 */
export function buildJunctionOf(ask: JunctionAsk, lines: Map<Float64Array, Polyline>, rings: Map<Float64Array, Vec2[]>): JunctionAnswer {
  const line = (xy: Float64Array): Polyline => {
    let made = lines.get(xy);
    if (!made) lines.set(xy, (made = Polyline.fromFlat(xy)));
    return made;
  };
  const ring = (xy: Float64Array): Vec2[] => {
    let made = rings.get(xy);
    if (!made) rings.set(xy, (made = unflat(xy)));
    return made;
  };
  const lane = (l: LaneAsk): JunctionLane => ({ ...l, centre: line(l.centre) });
  const input: JunctionInput = { node: ask.node, legs: ask.legs, inbound: ask.inbound.map(lane), outbound: ask.outbound.map(lane) };
  const source: SurfaceSource = {
    centre: ask.surface.centre,
    parts: ask.surface.parts.map((p) => (p instanceof Float64Array ? ring(p) : { full: line(p.full), half: p.half, mouth: p.mouth })),
  };
  let surface: JunctionSurface | undefined;
  const surfaceOf = (): JunctionSurface => (surface ??= new JunctionSurface(source));
  const key = junctionKey(input, surfaceOf().key);
  const turns = new JunctionTurns(ask.before ? JunctionTurns.of(ask.before) : null);
  const made = junctionMovements(input, surfaceOf, turns);
  return {
    key,
    groups: made.groups,
    signalised: made.signalised,
    connectors: made.connectors.map((c) => ({
      from: c.from, to: c.to, turn: c.turn, carried: c.carried, group: c.group, speedLimit: c.speedLimit, maxBodyClass: c.maxBodyClass, path: c.path.xy,
    })),
    turns: turns.settle().entries(),
  };
}

/**
 * How far along a leg to look when deciding which approaches share an axis.
 *
 * Far enough that a slight kink at the node does not split an axis, near
 * enough that a real curve is not straightened away.
 */
const GROUPING_LOOKAHEAD_FRACTION = 0.2;
const GROUPING_LOOKAHEAD_MAX = m(4.8);

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

function shouldSignalise(
  control: JunctionControl,
  incident: readonly SegmentId[],
  leg: (segment: SegmentId) => JunctionLeg,
): boolean {
  if (control === 'signal') return true;
  if (control !== 'auto') return false;
  return incident.length >= 3 &&
    (incident.length >= 4 || incident.some((s) => {
      const { segment } = leg(s);
      return roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking).lanes >= 4;
    }));
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
function carriedPair(node: JunctionNode, leg: (segment: SegmentId) => JunctionLeg): readonly SegmentId[] | null {
  const incident = [...new Set(node.incident)];
  if (incident.length === 2) return incident;
  if (incident.length < 3) return null;
  const legs = incident.map((segment) => {
    const seg = leg(segment).segment;
    return { segment, type: seg.section?.priority ?? seg.type, dir: smoothedDirectionFromNode(legLine(leg(segment), node.id)) };
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
  inLane: JunctionLane,
  outLane: JunctionLane,
  turn: TurnKind,
  inLanes: number,
  outLanes: number,
): boolean {
  const i = inLane.laneIndex;
  const o = outLane.laneIndex;
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

