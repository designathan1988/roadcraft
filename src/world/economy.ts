import type { RoadDoc, RoadSegment } from './doc';
import { segmentPolyline } from './geometry';
import { type RoadType, roadProfile } from './roadTypes';
import type { RoadStructure } from './structures';
import { METERS_PER_UNIT } from './units';
import { ROAD_TUNING } from './roads/tuning';

/**
 * THE MINIMAL ECONOMY (docs/VIAS.md V0, the player's decision of 2026-10-09):
 * a balance, saved with the map, and what roads cost to build.
 *
 * A road's price is its cross-section - carriageway, central reservation,
 * footways, each by its own price per square metre - times its length in
 * each way of building it, times that way's multiplier: at grade, on an
 * embankment, in a cutting, on piers, in a tunnel (`ROAD_TUNING.economy`).
 * The way is read from what the player authored, not from a solve: a
 * structure (`tunnel`, or the legacy `elevated`/`bridge`) prices the whole
 * road; a road at grade is priced by its authored height over the designed
 * ground along it (linear between its two nodes, as the editing rules read
 * it), so a ramp up to a viaduct pays embankment, then piers.
 *
 * What an edit costs is what the roads are worth after it less what they
 * were worth before (`roadValue`): a road drawn costs its price, a road
 * split or joined costs nothing, a road widened costs the difference, and a
 * road demolished gives back a share of its price (`chargeFor`). Every road
 * edit, whatever tool made it, is charged by that one rule.
 */
export type BuildKind = 'ground' | 'embankment' | 'trench' | 'bridge' | 'tunnel';
export const BUILD_KINDS: readonly BuildKind[] = ['ground', 'embankment', 'trench', 'bridge', 'tunnel'];

export interface Economy {
  /** Money in hand. Never negative through an edit: one that cannot be paid is refused. */
  readonly balance: number;
}

export const DEFAULT_ECONOMY: Economy = { balance: ROAD_TUNING.economy.startingFunds };

/** The saved form, or null when it is not one (`editor/persistence.ts` refuses the map then). */
export function readEconomy(data: unknown): Economy | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const balance = (data as { balance?: unknown }).balance;
  return typeof balance === 'number' && Number.isFinite(balance) ? { balance } : null;
}

const E = ROAD_TUNING.economy;
/** Prices per square world unit, from the per-square-metre figures (a build-time conversion). */
const PER_SQUARE_UNIT = {
  carriageway: E.perSquareMetre.carriageway * METERS_PER_UNIT * METERS_PER_UNIT,
  median: E.perSquareMetre.median * METERS_PER_UNIT * METERS_PER_UNIT,
  footway: E.perSquareMetre.footway * METERS_PER_UNIT * METERS_PER_UNIT,
};

/** Price of one world unit of road of this cross-section, built at grade. */
export function pricePerUnit(rt: RoadType): number {
  const carriageway = Math.max(0, rt.width - rt.median);
  return carriageway * PER_SQUARE_UNIT.carriageway + rt.median * PER_SQUARE_UNIT.median +
    2 * rt.sidewalk * PER_SQUARE_UNIT.footway;
}

/**
 * How much of a road of `length` is built each way, from its structure and
 * the authored height at its two ends (world units over the designed ground).
 * Exact for the linear height between them, so a road split anywhere sums
 * to the same lengths.
 */
export function buildLengths(structure: RoadStructure, heightA: number, heightB: number, length: number): Record<BuildKind, number> {
  const out: Record<BuildKind, number> = { ground: 0, embankment: 0, trench: 0, bridge: 0, tunnel: 0 };
  if (structure === 'tunnel') { out.tunnel = length; return out; }
  if (structure === 'elevated' || structure === 'bridge') { out.bridge = length; return out; }
  const fill = E.fillFrom, piers = ROAD_TUNING.structure.pierFrom;
  /** Share of the road whose height lies in [lo, hi). */
  const share = (lo: number, hi: number): number => {
    if (heightA === heightB) return heightA >= lo && heightA < hi ? 1 : 0;
    const t0 = (lo - heightA) / (heightB - heightA), t1 = (hi - heightA) / (heightB - heightA);
    return Math.max(0, Math.min(1, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)));
  };
  out.trench = length * share(-Infinity, -fill);
  out.ground = length * share(-fill, fill);
  out.embankment = length * share(fill, piers);
  out.bridge = length * share(piers, Infinity);
  return out;
}

/** What one road costs to build, as it stands in `doc`, with its length `length` (world units). */
export function segmentCost(doc: RoadDoc, segment: RoadSegment, length: number): number {
  const rt = roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking);
  const lengths = buildLengths(segment.structure, doc.node(segment.a)?.heightOffset ?? 0, doc.node(segment.b)?.heightOffset ?? 0, length);
  const unit = pricePerUnit(rt);
  let total = 0;
  for (const kind of BUILD_KINDS) total += lengths[kind] * unit * E.structure[kind];
  return total;
}

/** Everything a road's price is made of, as text. */
function costKey(doc: RoadDoc, s: RoadSegment): string {
  const a = doc.node(s.a), b = doc.node(s.b);
  return `${s.type}|${s.lanes}|${s.direction}|${s.structure}|${s.curve ? `${s.curve.t},${s.curve.h}` : '-'}|` +
    `${s.section ? JSON.stringify(s.section) : '-'}|${s.parking ? JSON.stringify(s.parking) : '-'}|` +
    `${a?.x},${a?.y},${a?.heightOffset}|${b?.x},${b?.y},${b?.heightOffset}`;
}

/**
 * Road prices as worked out, by everything they were worked out from: the
 * same text is the same price, in any document (an edit's working copy
 * included). Emptied when it grows past what a big map holds.
 */
const priced = new Map<string, number>();
const PRICED_MAX = 50_000;

/**
 * What every road in the document is worth: the sum of their prices. Only
 * roads never priced as they stand are priced (their line flattened).
 */
export function roadValue(doc: RoadDoc): number {
  if (priced.size > PRICED_MAX) priced.clear();
  let total = 0;
  for (const segment of doc.segments.values()) {
    const key = costKey(doc, segment);
    let cost = priced.get(key);
    if (cost === undefined) {
      cost = segmentCost(doc, segment, segmentPolyline(doc, segment).length);
      priced.set(key, cost);
    }
    total += cost;
  }
  return total;
}

/** What an edit costs and what the balance becomes. */
export interface RoadCharge {
  /** Money taken (positive) or given back (negative). */
  readonly amount: number;
  /** The balance after the edit. */
  readonly balance: number;
  /** False when the edit costs more than the balance holds: it is refused. */
  readonly affordable: boolean;
}

/**
 * The charge for turning roads worth `valueBefore` into roads worth
 * `valueAfter` with `balance` in hand: the difference when they are worth
 * more, a share of it given back (`demolitionRefund`) when they are worth
 * less. Less than one unit of money either way is the rounding of a road
 * re-cut (a split), not an edit: nothing.
 */
export function chargeFor(valueBefore: number, valueAfter: number, balance: number): RoadCharge {
  const delta = valueAfter - valueBefore;
  if (Math.abs(delta) < 1) return { amount: 0, balance, affordable: true };
  if (delta > 0) {
    const amount = Math.round(delta);
    return { amount, balance: balance - amount, affordable: amount <= balance };
  }
  const refund = Math.round(-delta * E.demolitionRefund);
  return { amount: -refund, balance: balance + refund, affordable: true };
}
