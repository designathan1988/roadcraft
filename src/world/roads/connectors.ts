import type { NodeId, SegmentId } from '../ids';
import type { Vec2 } from '@core/vec2';

/** LANE CONNECTORS BY HAND */
export interface LaneLink {
  /** The arriving road and its lane (laneIndex: 0 innermost). */
  readonly from: SegmentId;
  readonly fromLane: number;
  /** The leaving road and its lane. */
  readonly to: SegmentId;
  readonly toLane: number;
}

const MAX_LINKS = 128;

/** A stored list of links, or undefined when it is not one (or empty). */
export function normalizeLaneLinks(raw: unknown): LaneLink[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LINKS) return undefined;
  const out: LaneLink[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return undefined;
    const { from, fromLane, to, toLane } = item as Record<string, unknown>;
    const ok = [from, fromLane, to, toLane].every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0);
    if (!ok || (fromLane as number) > 7 || (toLane as number) > 7) return undefined;
    const link = { from: from as SegmentId, fromLane: fromLane as number, to: to as SegmentId, toLane: toLane as number };
    const key = linkKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out.length ? sortLinks(out) : undefined;
}

/** Stable segment-pair key for a movement through a junction (`RoadNode.blockedMovements`). */
export const movementKey = (from: SegmentId, to: SegmentId): string => `${from}>${to}`;

export const linkKey = (l: LaneLink): string => `${l.from}:${l.fromLane}>${l.to}:${l.toLane}`;

/** Links in one order, so two lists that say the same thing are the same text. */
function sortLinks(links: readonly LaneLink[]): LaneLink[] {
  return [...links].sort((a, b) => a.from - b.from || a.fromLane - b.fromLane || a.to - b.to || a.toLane - b.toLane);
}

/** The links of one arriving lane. */
export const linksOf = (links: readonly LaneLink[] | undefined, from: SegmentId, fromLane: number): LaneLink[] =>
  (links ?? []).filter((l) => l.from === from && l.fromLane === fromLane);

/** What a node's connections are, for its key: '' when it has none of its own. */
export const linksDigest = (links: readonly LaneLink[] | undefined): string =>
  links && links.length ? links.map(linkKey).join(',') : '';

/** The arriving and leaving lanes a connector editor offers, and the connections now built (`lanelets.ts`). */
export interface NodeLanes {
  readonly node: NodeId;
  readonly arriving: readonly { readonly segment: SegmentId; readonly lane: number }[];
  readonly leaving: readonly { readonly segment: SegmentId; readonly lane: number }[];
  readonly built: readonly LaneLink[];
}

/** The node's links after the player toggles one connection */
export function toggleLaneLink(
  current: readonly LaneLink[] | undefined, lanes: NodeLanes, link: LaneLink,
): LaneLink[] | undefined | null {
  const arrives = (l: LaneLink): boolean => lanes.arriving.some((a) => a.segment === l.from && a.lane === l.fromLane);
  const leaves = (l: LaneLink): boolean => lanes.leaving.some((a) => a.segment === l.to && a.lane === l.toLane);
  if (!arrives(link) || !leaves(link)) return null;
  const valid = (current ?? []).filter((l) => arrives(l) && leaves(l));
  const own = linksOf(valid, link.from, link.fromLane);
  const start = own.length ? own : linksOf(lanes.built, link.from, link.fromLane);
  const key = linkKey(link);
  const next = start.some((l) => linkKey(l) === key) ? start.filter((l) => linkKey(l) !== key) : [...start, link];
  if (!next.length) return null;
  const rest = valid.filter((l) => !(l.from === link.from && l.fromLane === link.fromLane));
  const all = [...rest, ...next];
  return all.length ? sortLinks(all) : undefined;
}

/** A junction's lanes as the connector editor draws them: `NodeLanes`, each lane's end at the junction and its next point, the graph's revision. */
export interface LaneEnds extends NodeLanes {
  readonly revision: number;
  readonly ends: readonly { readonly segment: SegmentId; readonly lane: number; readonly arriving: boolean; readonly at: Vec2; readonly next: Vec2 }[];
}
