import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '../doc';
import type { RoadElevation } from '../elevation';
import type { NodeId, SegmentId } from '../ids';
import type { Network } from '../network';
import { RAISED_LIFT, TUNNEL_BORE, isRaised, type RoadStructure } from '../structures';
import { ROAD_TUNING } from './tuning';

/**
 * HOW A ROAD IS BUILT at each point along it (docs/VIAS.md V3): on the
 * ground, on an embankment, in a cutting, on piers, in a tunnel. Read from
 * the solved deck against the natural ground and the road's structure, with
 * the thresholds the renderer builds with: piers past `RAISED_LIFT`
 * (`render/structures.ts` `structureRibbons`), a bore past `TUNNEL_BORE`;
 * an embankment or a cutting past the economy's `fillFrom`. One function, so
 * the preview names what the game will build.
 */
export type BuildMode = 'ground' | 'embankment' | 'cutting' | 'bridge' | 'tunnel';
export const BUILD_MODES: readonly BuildMode[] = ['ground', 'embankment', 'cutting', 'bridge', 'tunnel'];

/** The way of building at one point: `lift` is the deck over the natural ground (world units). */
export function buildModeAt(structure: RoadStructure, lift: number): BuildMode {
  // A tunnel's segment is bored only where it is buried; its approaches are
  // built as any road is (a cutting, at grade, even on fill).
  if (lift < -TUNNEL_BORE) return 'tunnel';
  if (isRaised(structure) || lift > RAISED_LIFT) return 'bridge';
  const fill = ROAD_TUNING.economy.fillFrom;
  if (lift >= fill) return 'embankment';
  if (lift <= -fill) return 'cutting';
  return 'ground';
}

/** A point of a road being built: where, how far along, its deck, the ground under it, and how. */
export interface RoadStation {
  /** Distance along the road from its start (world units). */
  readonly s: number;
  readonly x: number;
  readonly y: number;
  /** The solved deck height (world height). */
  readonly deck: number;
  /** The natural ground under it. */
  readonly ground: number;
  readonly mode: BuildMode;
}

/** A stretch built one way. */
export interface BuildRun {
  readonly mode: BuildMode;
  readonly from: number;
  readonly to: number;
}

/**
 * The segments of a road laid from `startAt`, in order and each with its
 * direction: walked node to node through `ids` from the node at the start.
 */
export function orderAlong(doc: RoadDoc, ids: ReadonlySet<SegmentId>, startAt: Vec2): { id: SegmentId; reversed: boolean }[] {
  let current: NodeId | null = null;
  let best = Infinity;
  for (const id of ids) {
    const seg = doc.segment(id);
    if (!seg) continue;
    for (const n of [seg.a, seg.b]) {
      const node = doc.node(n);
      if (!node) continue;
      const d = Math.hypot(node.x - startAt.x, node.y - startAt.y);
      if (d < best) { best = d; current = n; }
    }
  }
  const out: { id: SegmentId; reversed: boolean }[] = [];
  const used = new Set<SegmentId>();
  while (current !== null && out.length < ids.size) {
    const node: NodeId = current;
    const next = [...ids].find((id) => !used.has(id) && (doc.segment(id)?.a === node || doc.segment(id)?.b === node));
    if (next === undefined) break;
    const seg = doc.segment(next)!;
    used.add(next);
    out.push({ id: next, reversed: seg.b === node });
    current = seg.b === node ? seg.a : seg.b;
  }
  return out;
}

/**
 * The stations of a road every `step` units along it (and at each end of
 * each segment), from the network, the solved heights and the natural
 * ground: what the preview draws and what the build is.
 */
export function stationsAlong(
  net: Network,
  elevation: RoadElevation,
  ground: (x: number, y: number) => number,
  path: readonly { id: SegmentId; reversed: boolean }[],
  step: number,
): RoadStation[] {
  const out: RoadStation[] = [];
  let base = 0;
  for (const { id, reversed } of path) {
    const ribbon = net.ribbons.get(id);
    const seg = net.doc.segment(id);
    if (!ribbon || !seg) continue;
    const length = ribbon.full.length;
    const n = Math.max(1, Math.ceil(length / step));
    for (let i = out.length && base > 0 ? 1 : 0; i <= n; i++) {
      const along = (i / n) * length;
      const p = ribbon.full.sampleAt(reversed ? length - along : along).p;
      const deck = elevation.onSegment(id, p.x, p.y);
      const g = ground(p.x, p.y);
      out.push({ s: base + along, x: p.x, y: p.y, deck, ground: g, mode: buildModeAt(seg.structure, deck - g) });
    }
    base += length;
  }
  return out;
}

/** The stations as stretches of one way of building, in order. */
export function buildRuns(stations: readonly RoadStation[]): BuildRun[] {
  const runs: { mode: BuildMode; from: number; to: number }[] = [];
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i]!;
    const last = runs[runs.length - 1];
    if (last && last.mode === st.mode) continue;
    // A stretch changes half way between two stations built different ways.
    const edge = i === 0 ? st.s : (stations[i - 1]!.s + st.s) / 2;
    if (last) last.to = edge;
    runs.push({ mode: st.mode, from: edge, to: edge });
  }
  const tail = runs[runs.length - 1];
  if (tail) tail.to = stations[stations.length - 1]!.s;
  return runs;
}

/** Length built each way. */
export function buildTotals(runs: readonly BuildRun[]): Record<BuildMode, number> {
  const out: Record<BuildMode, number> = { ground: 0, embankment: 0, cutting: 0, bridge: 0, tunnel: 0 };
  for (const run of runs) out[run.mode] += run.to - run.from;
  return out;
}
