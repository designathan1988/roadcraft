import type { RoadDoc, RoadSegment } from './doc';
import type { ChangeJournal } from './changes';
import type { SegmentId } from './ids';
import { segmentPolyline } from './geometry';
import { type RoadType, roadProfile } from './roadTypes';
import type { RoadStructure } from './structures';
import { METERS_PER_UNIT } from './units';
import { ROAD_TUNING } from './roads/tuning';

/**
 * THE MINIMAL ECONOMY (docs/source/VIAS.md V0, the player's decision of 2026-10-09):
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

/**
 * A document's road prices, kept from its diary: each road's price, and their
 * sum kept by difference (Jane Street's Incremental: an aggregate updated by
 * the change of its parts). A working copy (`RoadDoc.forkOrigin`) starts on the
 * original's, read through, and keeps only the prices of the roads it changed.
 */
interface Ledger {
  readonly journal: ChangeJournal;
  /** The diary's serial read up to. */
  seen: number;
  /** Each road's price (0: gone), over the base's. */
  readonly costs: Map<SegmentId, number>;
  /** The original's ledger as it stood when the copy was made; null for a document's own. */
  readonly base: Ledger | null;
  total: number;
}

const ledgers = new WeakMap<RoadDoc, Ledger>();

function priceOf(ledger: Ledger, id: SegmentId): number {
  for (let at: Ledger | null = ledger; at; at = at.base) {
    const cost = at.costs.get(id);
    if (cost !== undefined) return cost;
  }
  return 0;
}

const segmentPrice = (doc: RoadDoc, s: RoadSegment): number => segmentCost(doc, s, segmentPolyline(doc, s).length);

/** @rebuild Every road priced, only when the diary cannot say which changed (the first ask, a load, entries without ids). */
function priceAll(doc: RoadDoc): Ledger {
  const costs = new Map<SegmentId, number>();
  let total = 0;
  for (const segment of doc.segments.values()) {
    const cost = segmentPrice(doc, segment);
    costs.set(segment.id, cost);
    total += cost;
  }
  return { journal: doc.changes, seen: doc.changes.version, costs, base: null, total };
}

/**
 * What every road in the document is worth: the sum of their prices.
 *
 * Kept from the diary: the roads its entries name since the last ask (a
 * road's id, or a node's - its roads: a node moved or raised changes their
 * length and their build) are priced again, and the sum moves by the
 * difference. A working copy starts from the original's as it stood. DO NOT
 * price every road of the map for each edit and each preview of a draft (and
 * DO NOT keep the prices in a cache by text that empties itself: both were
 * here).
 */
export function roadValue(doc: RoadDoc): number {
  let ledger = ledgers.get(doc);
  if (!ledger || ledger.journal !== doc.changes) {
    const origin = doc.forkOrigin;
    if (origin) {
      roadValue(origin);
      const base = ledgers.get(origin)!;
      ledger = { journal: doc.changes, seen: origin.changes.version, costs: new Map(), base, total: base.total };
    } else ledger = priceAll(doc);
    ledgers.set(doc, ledger);
  }
  // A copy whose original moved on since it was made reads the original as it is now: priced whole instead.
  if (ledger.base && !doc.forkOrigin) { ledger = priceAll(doc); ledgers.set(doc, ledger); }
  if (ledger.seen === doc.changes.version) return ledger.total;
  const entries = doc.changes.since(ledger.seen, ['roads', 'traffic']);
  if (entries === null || entries.some((e) => !e.ids)) {
    ledger = priceAll(doc);
    ledgers.set(doc, ledger);
    return ledger.total;
  }
  const dirty = new Set<SegmentId>();
  for (const entry of entries) {
    for (const id of entry.ids!) {
      // An id may be a road's or a node's (they share the roads' entries): both read.
      dirty.add(id as SegmentId);
      for (const s of doc.node(id as never)?.incident ?? []) dirty.add(s);
    }
  }
  for (const id of dirty) {
    const segment = doc.segment(id);
    const was = priceOf(ledger, id);
    const now = segment ? segmentPrice(doc, segment) : 0;
    if (now === was) continue;
    ledger.costs.set(id, now);
    ledger.total += now - was;
  }
  ledger.seen = doc.changes.version;
  return ledger.total;
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
