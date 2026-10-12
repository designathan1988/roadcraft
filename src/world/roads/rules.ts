import type { NodeId, SegmentId } from '../ids';
import type { RoadDoc, RoadNode } from '../doc';
import { orientedPolyline } from '../geometry';
import { roadType } from '../roadTypes';
import { m } from '../units';

/**
 * THE RULES OF A JUNCTION (docs/VIAS.md V5): who goes first, as the source;
 * the signs are derived from it (V6). Brazilian practice (CTB art. 29, III):
 * where nothing is signed, a road ("rodovia") goes before the road it meets,
 * whoever circulates in a roundabout goes before whoever enters it, and
 * otherwise the one coming from the driver's right goes first. A junction
 * with signs gives each leg a rule: priority, give way ("Dê a preferência",
 * R-2) or stop ("Parada obrigatória", R-1).
 */
export type ApproachRule = 'priority' | 'yield' | 'stop';
export const APPROACH_RULES: readonly ApproachRule[] = ['priority', 'yield', 'stop'];

export interface ApproachRuleEntry {
  readonly segment: SegmentId;
  readonly rule: ApproachRule;
}

/** A signal's settings (docs/VIAS.md V5); absent: adaptive, the game's own timings. */
export interface SignalSettings {
  /** 'fixed': each stage its green, in order, every cycle (needed for a green wave); absent: adaptive. */
  readonly mode?: 'fixed';
  /** Green of each stage, seconds, in a fixed-time plan; missing ones take the game's own. */
  readonly greens?: readonly number[];
  /** Where in its cycle this signal starts, seconds (a green wave's offset). */
  readonly offset?: number;
  /** A bus approaching on red or at the end of its green is served first (green extension, early green). */
  readonly busPriority?: true;
}

export const GREEN_LIMITS = [6, 90] as const;
export const OFFSET_LIMIT = 300;

export function normalizeApproachRules(raw: unknown): ApproachRuleEntry[] | undefined {
  if (!Array.isArray(raw) || !raw.length || raw.length > 12) return undefined;
  const out: ApproachRuleEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return undefined;
    const { segment, rule } = item as Record<string, unknown>;
    if (typeof segment !== 'number' || !Number.isInteger(segment) || segment < 0) return undefined;
    if (!APPROACH_RULES.includes(rule as ApproachRule)) return undefined;
    if (out.some((e) => e.segment === segment)) continue;
    out.push({ segment: segment as SegmentId, rule: rule as ApproachRule });
  }
  return out.sort((a, b) => a.segment - b.segment);
}

export function normalizeSignalSettings(raw: unknown): SignalSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  const out: { -readonly [K in keyof SignalSettings]: SignalSettings[K] } = {};
  if (v['mode'] === 'fixed') out.mode = 'fixed';
  if (Array.isArray(v['greens']) && v['greens'].length <= 8 && v['greens'].every((g) => typeof g === 'number' && Number.isFinite(g))) {
    const greens = (v['greens'] as number[]).map((g) => Math.round(Math.max(GREEN_LIMITS[0], Math.min(GREEN_LIMITS[1], g))));
    if (greens.length) out.greens = greens;
  }
  if (typeof v['offset'] === 'number' && Number.isFinite(v['offset'])) {
    const offset = Math.round(Math.max(0, Math.min(OFFSET_LIMIT, v['offset'])));
    if (offset > 0) out.offset = offset;
  }
  if (v['busPriority'] === true) out.busPriority = true;
  return Object.keys(out).length ? out : undefined;
}

export const signalDigest = (s: SignalSettings | undefined): string => (s ? JSON.stringify(s) : '');
export const rulesDigest = (r: readonly ApproachRuleEntry[] | undefined): string =>
  r && r.length ? r.map((e) => `${e.segment}:${e.rule}`).join(',') : '';

/** A road's rank at a junction: its authored priority, else its class (the order `admission.ts` uses). */
export function roadRank(doc: RoadDoc, segment: SegmentId): number {
  const s = doc.segment(segment);
  return s?.section?.priority ?? s?.type ?? 0;
}

/**
 * The road a junction is ON: the pair of legs whose lesser rank is the
 * highest, the straighter pair on a tie. Null when no pair stands out (every
 * leg the same rank and no straight pair: nothing is the main road).
 */
export function mainRoadLegs(doc: RoadDoc, nodeId: NodeId): readonly [SegmentId, SegmentId] | null {
  const node = doc.node(nodeId);
  if (!node || node.incident.length < 2) return null;
  const dirs = new Map<SegmentId, { x: number; y: number }>();
  for (const id of node.incident) {
    const seg = doc.segment(id);
    if (!seg) continue;
    const line = orientedPolyline(doc, seg, nodeId);
    const p = line.sampleAt(Math.min(line.length, m(4.8))).p;
    const len = Math.hypot(p.x - node.x, p.y - node.y) || 1;
    dirs.set(id, { x: (p.x - node.x) / len, y: (p.y - node.y) / len });
  }
  let best: [SegmentId, SegmentId] | null = null;
  let bestRank = -Infinity, bestStraight = Infinity;
  const legs = [...dirs.keys()];
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i]!, b = legs[j]!;
      const da = dirs.get(a)!, db = dirs.get(b)!;
      const straight = da.x * db.x + da.y * db.y; // -1: straight on
      if (straight > -0.5) continue;
      const rank = Math.min(roadRank(doc, a), roadRank(doc, b));
      if (rank > bestRank || (rank === bestRank && straight < bestStraight)) {
        best = [a, b];
        bestRank = rank;
        bestStraight = straight;
      }
    }
  }
  return best;
}

/**
 * The rule of one leg of a junction with signs ('priority' control): the
 * player's own, or by default the main road's legs priority and every other
 * leg give way.
 */
export function legRule(doc: RoadDoc, node: RoadNode, segment: SegmentId): ApproachRule {
  const own = node.approachRules?.find((e) => e.segment === segment)?.rule;
  if (own) return own;
  const main = mainRoadLegs(doc, node.id);
  return main && main.includes(segment) ? 'priority' : 'yield';
}

/** Whether a road is a "rodovia" for CTB art. 29, III, a (the highway class). */
export const isHighwayClass = (doc: RoadDoc, segment: SegmentId): boolean => {
  const s = doc.segment(segment);
  const id = s ? roadType(s.type).id : '';
  return id === 'highway' || id === 'ramp';
};

/**
 * The sign a leg's driver meets at a junction (docs/VIAS.md V6), derived from
 * the junction's control as the simulation reads it (`admission.ts`
 * `rightOfWay`): "Pare em todas" a stop on every leg; "Dê a preferência" and
 * a mini-roundabout a give-way on every leg (R-2 at each entry); "Placas"
 * each leg's rule, the main road unsigned. Automatic, signal and nothing
 * signed put up no sign (the game decides, a signal head, CTB art. 29).
 */
export type ApproachSign = 'stop' | 'yield';
export function approachSign(doc: RoadDoc, node: RoadNode, segment: SegmentId): ApproachSign | null {
  if (node.incident.length < 3) return null;
  switch (node.control) {
    case 'stop': return 'stop';
    case 'yield':
    case 'mini': return 'yield';
    case 'priority': {
      const rule = legRule(doc, node, segment);
      return rule === 'priority' ? null : rule;
    }
    default: return null;
  }
}

/** Whether traffic on a segment arrives at the node (not a one-way leaving it). */
export function arrivesAt(doc: RoadDoc, node: NodeId, segment: SegmentId): boolean {
  const s = doc.segment(segment);
  if (!s || s.a === s.b) return false;
  if (s.direction === 'both') return true;
  return (s.direction === 'aToB') === (s.b === node);
}
