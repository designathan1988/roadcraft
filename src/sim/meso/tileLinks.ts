import type { CurveShape } from '@core/bezier';
import { segmentLine } from '@world/geometry';
import type { SegmentParking } from '@world/parking';
import { type RoadSection, laneUse } from '@world/roadSection';
import { type SegmentDirection, roadProfile, travelLanes } from '@world/roadTypes';
import { TUNNELS_DRAWN } from '@world/structures';
import type { TileRecords } from '@world/doc';
import { kindOf } from '../ambient/demand';
import { cellKey } from '../ambient/ambientIndex';
import { CELL_STRIDE, DEMAND_CELL } from './demand';
import { linkCapacity } from './model';

/** A TILE'S MESO LINKS, BAKED FROM ITS STORED RECORDS: what the meso model needs of every directed road of a tile the page does not hold (CLAUDE.md, "Streaming world"), in typed arrays */
// The same numbers `meso.ts` reads off the lane graph for a loaded tile (lanes, free speed, the signal's share), its length the centreline's (the live link's is trimmed to the stop lines).

/** Bumped when what a table holds or how it is baked changes. */
export const TILE_LINKS_FORMAT = 1;

/** A link's flags: into a signal or a stop line (its capacity the green's share), a crossing at its end, its road one-way. */
const LINK_CONTROLLED = 1;
export const LINK_CROSSING = 2;
export const LINK_ONE_WAY = 4;
/** A node's flags: a turning circle (not the world's edge), owned by the tile (not borrowed from a neighbour). */
export const NODE_BULB = 1;
const NODE_OWNED = 2;

/** A link's id: its segment and its direction (0 from the segment's `a` to its `b`), as the meso's slot was before tiles. Exact while segment ids stay under 2^52 (tiles within ~16,000 km of the origin, `tileIdBase`). */
export const linkId = (segment: number, direction: 0 | 1): number => segment * 2 + direction;
export const linkSegment = (link: number): number => Math.floor(link / 2);
export const linkDirection = (link: number): 0 | 1 => (link % 2 === 0 ? 0 : 1);
/** The same road the other way. DO NOT use `^ 1`: a tile's ids pass 2^31. */
export const reverseLink = (link: number): number => (link % 2 === 0 ? link + 1 : link - 1);

/** One tile's links, each a directed road (`link[k]`), and the turns at its nodes; versioned with the tile. */
export interface TileLinks {
  readonly key: number;
  /** The tile's version it was baked from (`TileRecords.version`). */
  readonly version: number;
  readonly format: number;
  readonly count: number;
  readonly link: Float64Array;
  /** The nodes it starts and ends at (a node on the tile's edge by its id from both tiles, `edgeNodeId`: neighbours' tables join there). */
  readonly from: Float64Array;
  readonly to: Float64Array;
  /** World units, along the segment's centreline. */
  readonly length: Float32Array;
  /** Lanes the cars may take (a bus lane is not counted). */
  readonly lanes: Uint8Array;
  /** Free speed, world units a second. */
  readonly vFree: Float32Array;
  /** Vehicles a second (`linkCapacity`), its signal told by the tile's own roads at its end. */
  readonly capacity: Float32Array;
  readonly flags: Uint8Array;
  /** Six a link: its segment's start, middle and end (x, y), in the segment's order: drawn straight from afar. */
  readonly shape: Float32Array;
  /** Each link's turns: `turnTo[turnStart[k] .. turnStart[k + 1])` (links of this table), with their weights. */
  readonly turnStart: Uint32Array;
  readonly turnTo: Uint32Array;
  readonly turnWeight: Float32Array;
  /** The nodes its links touch, their flags, and how many of the tile's roads meet at each. */
  readonly nodes: Float64Array;
  readonly nodeFlags: Uint8Array;
  readonly nodeDegree: Uint16Array;
  /** The tile's buildings by 256 m demand cell (`CELL_STRIDE` numbers a cell): the far streets' trips. */
  readonly cells: Float64Array;
}

/** A node as a tile keeps it (a stored record, or the document's own). */
interface BakeNode {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly end?: string;
  readonly crossing?: { readonly kind: string; readonly segment: number };
}
/** A segment as a tile keeps it. */
interface BakeSegment {
  readonly id: number;
  readonly a: number;
  readonly b: number;
  readonly type: number;
  readonly curve?: CurveShape | null;
  readonly direction?: SegmentDirection;
  readonly lanes?: number | null;
  readonly section?: RoadSection;
  readonly parking?: SegmentParking;
  readonly structure?: string;
}
/** What of a tile the table is baked from. */
type TileLinkSource = Pick<TileRecords, 'key' | 'version' | 'buildings'> & {
  readonly nodes: readonly BakeNode[];
  readonly borrowedNodes: readonly BakeNode[];
  readonly segments: readonly BakeSegment[];
};

const allows = (direction: SegmentDirection, forward: boolean): boolean => direction === 'both' || (direction === 'aToB') === forward;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One link before it is packed. */
interface Draft {
  readonly link: number;
  readonly from: number;
  readonly to: number;
  readonly length: number;
  readonly lanes: number;
  readonly vFree: number;
  readonly crossing: boolean;
  readonly oneWay: boolean;
  readonly shape: readonly number[];
}

/** The tile's links baked from its records: every segment it owns, both directions as its profile allows (`lanelets.ts` buildSegmentLinks), and every movement at each node by direction (no lane detail) */
export function bakeTileLinks(tile: TileLinkSource): TileLinks {
  const nodes = new Map<number, BakeNode>();
  // A tile's own record wins over a borrowed copy of the same node.
  for (const n of tile.borrowedNodes) nodes.set(n.id, n);
  const owned = new Set<number>();
  for (const n of tile.nodes) { nodes.set(n.id, n); owned.add(n.id); }

  const degree = new Map<number, number>();
  const segments: { readonly s: BakeSegment; readonly a: BakeNode; readonly b: BakeNode }[] = [];
  for (const s of tile.segments) {
    const a = nodes.get(s.a), b = nodes.get(s.b);
    if (!a || !b || a.id === b.id) continue;
    segments.push({ s, a, b });
    degree.set(a.id, (degree.get(a.id) ?? 0) + 1);
    degree.set(b.id, (degree.get(b.id) ?? 0) + 1);
  }
  // A crossing counts only on a node of two roads that still holds its segment (`RoadDoc.fromJSON`).
  const crossingAt = (n: BakeNode): boolean => !!n.crossing && degree.get(n.id) === 2;

  const drafts: Draft[] = [];
  for (const { s, a, b } of segments.sort((p, q) => p.s.id - q.s.id)) {
    // A tunnel with no geometry carries no traffic (`lanelets.ts`).
    if (s.structure === 'tunnel' && !TUNNELS_DRAWN) continue;
    const direction = s.direction ?? 'both';
    const rt = roadProfile(s.type, s.lanes ?? null, direction, s.section, s.parking);
    const lpd = travelLanes(rt, direction);
    const line = segmentLine({ x: a.x, y: a.y }, { x: b.x, y: b.y }, s.curve ?? null);
    const mid = line.sampleAt(line.length / 2).p;
    const shape = [a.x, a.y, mid.x, mid.y, b.x, b.y];
    for (const forward of [true, false]) {
      if (!allows(direction, forward)) continue;
      let lanes = 0;
      for (let k = 0; k < lpd; k++) if (laneUse(s.section, forward, k) !== 'bus') lanes++;
      if (lanes === 0) continue;
      const to = forward ? b : a;
      drafts.push({
        link: linkId(s.id, forward ? 0 : 1), from: forward ? a.id : b.id, to: to.id, length: line.length, lanes, vFree: rt.speedLimit,
        crossing: crossingAt(to), oneWay: direction !== 'both', shape,
      });
    }
  }

  const count = drafts.length;
  const out = {
    link: new Float64Array(count), from: new Float64Array(count), to: new Float64Array(count), length: new Float32Array(count),
    lanes: new Uint8Array(count), vFree: new Float32Array(count), capacity: new Float32Array(count), flags: new Uint8Array(count),
    shape: new Float32Array(count * 6),
  };
  const leaving = new Map<number, number[]>();
  drafts.forEach((d, k) => {
    // Into a junction of three roads or more, or a crossing: a stop line (`lanelets.ts` controlled).
    const controlled = (degree.get(d.to) ?? 0) >= 3 || d.crossing;
    out.link[k] = d.link; out.from[k] = d.from; out.to[k] = d.to; out.length[k] = d.length;
    out.lanes[k] = Math.min(255, d.lanes); out.vFree[k] = d.vFree; out.capacity[k] = linkCapacity(d.vFree, d.lanes, controlled);
    out.flags[k] = (controlled ? LINK_CONTROLLED : 0) | (d.crossing ? LINK_CROSSING : 0) | (d.oneWay ? LINK_ONE_WAY : 0);
    out.shape.set(d.shape, k * 6);
    const list = leaving.get(d.from);
    if (list) list.push(k); else leaving.set(d.from, [k]);
  });

  // Every movement at the node: each road leaving it, by its lanes; back the way it came only when nothing else (as `meso.ts` reads the lane graph's).
  const turnStart = new Uint32Array(count + 1);
  const turnTo: number[] = [], turnWeight: number[] = [];
  for (let k = 0; k < count; k++) {
    turnStart[k] = turnTo.length;
    const outs = leaving.get(out.to[k]!) ?? [];
    const back = reverseLink(out.link[k]!);
    const others = outs.filter((j) => out.link[j] !== back);
    for (const j of others.length ? others : outs) { turnTo.push(j); turnWeight.push(out.lanes[j]!); }
  }
  turnStart[count] = turnTo.length;

  const touched = [...new Set([...out.from, ...out.to])].sort((p, q) => p - q);
  const nodeFlags = new Uint8Array(touched.length), nodeDegree = new Uint16Array(touched.length);
  touched.forEach((id, k) => {
    const n = nodes.get(id);
    nodeFlags[k] = (n?.end === 'bulb' ? NODE_BULB : 0) | (owned.has(id) ? NODE_OWNED : 0);
    nodeDegree[k] = Math.min(65535, degree.get(id) ?? 0);
  });

  return {
    key: tile.key, version: tile.version, format: TILE_LINKS_FORMAT, count, ...out,
    turnStart, turnTo: Uint32Array.from(turnTo), turnWeight: Float32Array.from(turnWeight),
    nodes: Float64Array.from(touched), nodeFlags, nodeDegree,
    cells: demandCells(tile.buildings),
  };
}

/** The buildings by demand cell and kind (`meso/demand.ts`): a far street's trips start and end where they stand. */
function demandCells(buildings: readonly unknown[]): Float64Array {
  const KINDS = ['home', 'shop', 'work', 'civic'] as const;
  const cells = new Map<number, number[]>();
  for (const record of buildings) {
    const b = record as { x?: unknown; y?: unknown; use?: string; function?: string } | null;
    if (!b || !finite(b.x) || !finite(b.y)) continue;
    const cell = cellKey(Math.floor(b.x / DEMAND_CELL), Math.floor(b.y / DEMAND_CELL));
    let c = cells.get(cell);
    if (!c) cells.set(cell, c = [0, 0, 0, 0, 0]);
    const kind = KINDS.indexOf(kindOf(b as Parameters<typeof kindOf>[0]));
    c[kind] = c[kind]! + 1;
    c[4] = c[4]! + 1;
  }
  const out = new Float64Array(cells.size * CELL_STRIDE);
  let at = 0;
  for (const cell of [...cells.keys()].sort((p, q) => p - q)) {
    out[at] = cell;
    out.set(cells.get(cell)!, at + 1);
    at += CELL_STRIDE;
  }
  return out;
}
