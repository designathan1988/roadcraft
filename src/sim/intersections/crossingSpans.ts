import type { Polyline } from '@core/polyline';
import { BODY_ENVELOPE, HEAVY } from '@world/conflictPoints';
import type { ConnectorId } from '@world/lanelets';
import type { NodeId } from '@world/ids';
import type { Connector } from '@world/lanelets';
import { m } from '@world/units';
import { CROSSWALK_DEPTH } from '@world/approach';
import type { CrossingId } from '../signals/plan';
import type { SimWorld } from '../world';
import type { CrossingOccupant } from '../crossings/state';
import type { Vehicle } from '../vehicles/state';
import { canStopComfortably } from '../vehicles/idm';
import { rebuildWork } from '@world/rebuildWork';

/** Arc interval of a crossing, measured from its `from` kerb. */
export interface CrossingSpan {
  readonly s0: number;
  readonly s1: number;
  /** Arc position along the MOVEMENT where its body first reaches the span. */
  readonly along: number;
}

/** Clearance kept between a vehicle body and a pedestrian */
const REACH = (BODY_ENVELOPE[HEAVY]?.width ?? 0) / 2 + m(0.9);
const SAMPLE = 0.5;
/** How far outside its own box a rounded point of a line may fall, u (`measure`). */
const OUT_OF_BOX = 1e-6;
/** A walker's clearance from a vehicle body (`PedestrianClearance`), plus margin. */
const PERSON_CLEAR = m(0.6);

/** The part of each zebra a movement actually drives over. */
export class CrossingSpans {
  /** By connector, then by crossing: the two ids as they are, never a key string joined from them on every ask */
  private readonly spans = new Map<ConnectorId, Map<CrossingId, CrossingSpan | null>>();
  /** Earliest safe front stop on an incoming lane near another leg's zebra. */
  private readonly approachStops = new Map<string, number>();
  /** Every span of the previous build, with the two paths it was measured on. */
  private measured = new Map<string, Measured>();

  /** What each junction measured: its connectors, its approach lanes and the keys of `measured` it made. */
  private readonly ofJunction = new Map<NodeId, { readonly connectors: ConnectorId[]; readonly lanes: string[]; readonly keys: string[] }>();

  /** @rebuild Every junction: a world's first topology, or a lane graph built whole. */
  build(w: SimWorld): void {
    this.spans.clear();
    this.approachStops.clear();
    this.ofJunction.clear();
    const previous = this.measured;
    this.measured = new Map();
    for (const node of w.graph.junctions.keys()) this.measureJunction(w, node, previous);
  }

  /** DO NOT measure every movement of the map for an edit: every road drawn measured the town's zebras again. */
  update(w: SimWorld, nodes: ReadonlySet<NodeId> | null): void {
    if (nodes === null) { this.build(w); return; }
    const before: string[] = [];
    for (const node of nodes) {
      const made = this.ofJunction.get(node);
      if (!made) continue;
      for (const id of made.connectors) this.spans.delete(id);
      for (const lane of made.lanes) this.approachStops.delete(lane);
      before.push(...made.keys);
      this.ofJunction.delete(node);
    }
    for (const node of [...nodes].sort((x, y) => x - y)) this.measureJunction(w, node, this.measured);
    // What was measured before and not again goes: the cache holds what the junctions have.
    const kept = new Set<string>();
    for (const node of nodes) for (const key of this.ofJunction.get(node)?.keys ?? []) kept.add(key);
    for (const key of before) if (!kept.has(key)) this.measured.delete(key);
  }

  /** One junction's spans: each movement over each zebra, and each approach's stop before another leg's. */
  private measureJunction(w: SimWorld, node: NodeId, previous: Map<string, Measured>): void {
    const junction = w.graph.junctions.get(node);
    if (!junction) return;
    const made = { connectors: [] as ConnectorId[], lanes: [] as string[], keys: [] as string[] };
    this.ofJunction.set(node, made);
    const incident = w.doc.node(node)?.incident ?? [];
    // DO NOT sample a zebra again for each movement: a fifth of the measuring at 2.5 km (2026-10-15).
    const sampled = new Map<Polyline, Float64Array>();
    const samplesOf = (zebra: Polyline, length: number): Float64Array => {
      let known = sampled.get(zebra);
      if (!known) sampled.set(zebra, known = sampleZebra(zebra, length));
      return known;
    };
    for (const connectorId of junction.connectors) {
      rebuildWork.spans++;
      const connector = w.graph.connectors.get(connectorId);
      const path = connector && w.lanelet(connector.lanelet)?.centre;
      if (!connector || !path) continue;
      made.connectors.push(connector.id);
      for (const segment of incident) {
        const crossing = `${node}:${segment}`;
        const edge = w.sidewalks.edges.get(w.sidewalks.crossings.get(crossing) ?? '');
        if (!edge) continue;
        const id = key(connector.id, crossing);
        const known = previous.get(id);
        const span = known && known.length === edge.length && sameFloats(known.path, path.xy)
          && sameFloats(known.edge, edge.path.xy)
          ? known.span
          : measure(path, edge.path, samplesOf(edge.path, edge.length));
        this.measured.set(id, { path: path.xy, edge: edge.path.xy, length: edge.length, span });
        made.keys.push(id);
        let byCrossing = this.spans.get(connector.id);
        if (!byCrossing) this.spans.set(connector.id, byCrossing = new Map());
        byCrossing.set(crossing, span);
      }
    }
    // A long body stopped at a red signal can project across the zebra of an adjacent acute leg even though its own stop line
    rebuildWork.spans++;
    for (const laneId of junction.inbound) {
      const lane = w.lanelet(laneId);
      if (!lane || lane.kind !== 'link') continue;
      let stop = lane.length;
      for (const segment of incident) {
        if (segment === lane.segment) continue;
        const crossing = `${node}:${segment}`;
        const edge = w.sidewalks.edges.get(w.sidewalks.crossings.get(crossing) ?? '');
        if (!edge) continue;
        const id = `approach:${key(laneId, crossing)}`;
        const known = previous.get(id);
        const span = known && known.length === edge.length && sameFloats(known.path, lane.centre.xy)
          && sameFloats(known.edge, edge.path.xy)
          ? known.span : measure(lane.centre, edge.path, samplesOf(edge.path, edge.length));
        this.measured.set(id, { path: lane.centre.xy, edge: edge.path.xy, length: edge.length, span });
        made.keys.push(id);
        if (span) stop = Math.min(stop, span.along);
      }
      if (stop < lane.length) { this.approachStops.set(laneId, stop); made.lanes.push(laneId); }
    }
  }

  approachStop(lane: string): number | undefined {
    return this.approachStops.get(lane);
  }

  /** Undefined: never measured (treat conservatively). Null: never crossed. */
  span(connector: ConnectorId, crossing: CrossingId): CrossingSpan | null | undefined {
    return this.spans.get(connector)?.get(crossing);
  }
}

const key = (connector: ConnectorId, crossing: CrossingId): string => `${connector}|${crossing}`;

interface Measured {
  readonly path: Float64Array;
  readonly edge: Float64Array;
  readonly length: number;
  readonly span: CrossingSpan | null;
}

/** A crossing `length` long sampled every `SAMPLE`: s, x, y a sample. */
function sampleZebra(crossing: Polyline, length: number): Float64Array {
  const out: number[] = [];
  for (let s = 0; s <= length; s += SAMPLE) {
    const p = crossing.sampleAt(s).p;
    out.push(s, p.x, p.y);
  }
  return Float64Array.from(out);
}

/** The stretch of a crossing (its `samples`, `sampleZebra`) that a movement along `path` drives over. */
function measure(path: Polyline, crossing: Polyline, samples: Float64Array): CrossingSpan | null {
  // DO NOT ask the closest point of every sample of every zebra of the junction against every movement and every approach
  const box = path.bbox;
  const gap = (minX: number, minY: number, maxX: number, maxY: number): number =>
    Math.hypot(Math.max(box.minX - maxX, 0, minX - box.maxX), Math.max(box.minY - maxY, 0, minY - box.maxY));
  const zebra = crossing.bbox;
  if (gap(zebra.minX, zebra.minY, zebra.maxX, zebra.maxY) > REACH + OUT_OF_BOX) return null;
  let s0 = Infinity;
  let s1 = -Infinity;
  let centre = Infinity;
  for (let k = 0; k < samples.length; k += 3) {
    const s = samples[k]!, p = { x: samples[k + 1]!, y: samples[k + 2]! };
    if (gap(p.x, p.y, p.x, p.y) > REACH + OUT_OF_BOX) continue;
    const hit = path.closestPoint(p);
    if (hit.distance > REACH) continue;
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
    centre = Math.min(centre, hit.s);
  }
  // Where the FRONT must stop: before the near edge of the painted band and a person standing on it.
  const along = Math.max(0, centre - CROSSWALK_DEPTH / 2 - PERSON_CLEAR);
  return s0 <= s1 ? { s0, s1, along } : null;
}

function sameFloats(a: Float64Array, b: Float64Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A person's radius, a minimum pace assumed for someone about to move, and the look-ahead. */
export const PED_BODY = 1;
export const PED_MIN_PACE = m(0.8);
export const PED_REACH_TIME = 4;
/** Reserve the near half of a zebra before stopping a car for a pedestrian. */
export const PED_CROSSING_STOP_BUFFER = CROSSWALK_DEPTH / 2 + m(0.2);
const CLEAR_PAST = m(2.4);

/** Whether this vehicle's current reservation still protects a zebra span. */
export function reservationCoversCrossing(w: SimWorld, v: Vehicle, connector: Connector,
  segment: number, span: CrossingSpan | null | undefined): boolean {
  if (span === null) return false;
  if (span === undefined) return true;
  const lane = w.lanelet(v.lanelet);
  if (lane?.kind === 'link' && connector.id === v.admittedConnector &&
      connector.inSegment === segment && connector.outSegment !== segment) {
    const distance = Math.max(0, lane.length - v.s) + span.along;
    if (distance > m(2) && canStopComfortably(v.driver, v.v, distance)) return false;
  }
  if (connector.id === lane?.id && v.s - v.archetype.length > span.along + CLEAR_PAST) return false;
  if (connector.id !== lane?.id && connector.id !== v.admittedConnector) {
    const token = v.clearingConnectors.find((t) => t.connector === connector.id);
    if (token && connector.length + token.distanceBeyondExit - v.archetype.length > span.along + CLEAR_PAST) return false;
  }
  return true;
}

/** Whether somebody on a crossing occupies or will soon reach this movement's part of it. */
export function pedestrianAffectsSpan(p: CrossingOccupant, span: CrossingSpan): boolean {
  const at = p.s;
  if (at >= span.s0 - PED_BODY && at <= span.s1 + PED_BODY) return true;
  const ahead = p.forward ? span.s0 - at : at - span.s1;
  return ahead > 0 && ahead < Math.max(p.v, PED_MIN_PACE) * PED_REACH_TIME;
}

/** Whether somebody on this crossing is in, or about to enter, the span. */
export function pedestrianInSpan(w: SimWorld, connector: ConnectorId, crossing: CrossingId): CrossingSpan | null {
  const state = w.crossingStates.get(crossing);
  if (!state?.occupants.length) return null;
  const span = w.crossingSpans.span(connector, crossing);
  if (span === null) return null;
  if (span === undefined) return { s0: 0, s1: state.length, along: 0 };
  for (const p of state.occupants) {
    if (pedestrianAffectsSpan(p, span)) return span;
  }
  return null;
}
