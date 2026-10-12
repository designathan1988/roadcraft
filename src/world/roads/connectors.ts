import type { NodeId, SegmentId } from '../ids';

/**
 * LANE CONNECTORS BY HAND (docs/VIAS.md V4): which lane of a road arriving
 * at a node may continue into which lane of a road leaving it. The game
 * derives the connections itself (`lanelets.ts` `buildJunctions`: lane
 * arrows, plausible lane pairs, a fallback so no lane is left without an
 * exit); a node may carry the player's own for some of its arriving lanes
 * (`RoadNode.laneLinks`), and for those lanes exactly the player's
 * connections are built - never overwritten by the derived ones. A link to
 * or from a lane that no longer exists (a road removed, split or narrowed)
 * is left out of the build and dropped the next time the node is edited.
 *
 * As in Traffic Manager: President Edition's lane connector
 * (github.com/CitiesSkylinesMods/TMPE, `LaneConnectionSubManager.cs`): a
 * lane with connections of its own uses only those, the others keep the
 * game's; invalid lanes lose their connections.
 */
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

export const linkKey = (l: LaneLink): string => `${l.from}:${l.fromLane}>${l.to}:${l.toLane}`;

/** Links in one order, so two lists that say the same thing are the same text. */
export function sortLinks(links: readonly LaneLink[]): LaneLink[] {
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

/**
 * The node's links after the player toggles one connection (docs/VIAS.md V4):
 * the first edit of an arriving lane starts from the connections the game
 * built for it, so taking one away leaves the rest; a lane is never left
 * without a way on (the toggle that would is refused: null). Links to lanes
 * the node no longer has are dropped. An arriving lane whose links come back
 * to exactly what the game builds by itself keeps them (they are the
 * player's), until "restore" clears the node.
 */
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
