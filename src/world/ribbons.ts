import { MIN_RIBBON, SEAM_OVERLAP, SURFACE_END_STEP } from '@core/scalar';
import { Ring } from '@core/ring';
import { offsetPolyline } from '@core/offset';
import { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';
import type { RoadDoc, RoadSegment, SegmentDirection } from './doc';
import type { NodeId, SegmentId } from './ids';
import { Level, SURFACE_LEVELS, type SurfaceLevel, halfWidth, roadProfile, sideHalfWidth } from './roadTypes';
import type { Junction } from './junction/build';
import type { PolylineCache } from './geometry';
import type { ChangeRect } from './changes';

/** A road's surface between the junctions at its ends (`Network.ribbons`) */

/** Per-level trim distances at both ends of a segment. */
export interface SegmentTrims {
  /** Trim at the `a` endpoint, indexed by surface level. */
  readonly a: Record<number, number>;
  /** Trim at the `b` endpoint, indexed by surface level. */
  readonly b: Record<number, number>;
}

export interface SegmentRibbon {
  readonly id: SegmentId;
  readonly typeIndex: number;
  readonly direction: SegmentDirection;
  /** Resolved width and marking profile, including lane overrides. */
  readonly road: ReturnType<typeof roadProfile>;
  /** Centreline trimmed for this level, in world space. */
  readonly centre: Record<number, Polyline>;
  /** Closed carriageway outline for this level. */
  readonly rings: Record<number, Ring>;
  /** Arc-length offset for dash phase continuity across splits. */
  readonly dashOrigin: number;
  /** Full untrimmed centreline, shared by every level. */
  readonly full: Polyline;
}

/** How far the road turns at a node joining exactly two segments, radians (0 straight on); 0 anywhere else. */
export function bendAt(doc: RoadDoc, polylines: PolylineCache, nodeId: NodeId, segId: SegmentId): number {
  const node = doc.node(nodeId);
  if (!node || node.incident.length !== 2) return 0;
  const away = (id: SegmentId): Vec2 | null => {
    const seg = doc.segment(id);
    if (!seg) return null;
    const pts = polylines.get(doc, id).toPoints();
    if (pts.length < 2) return null;
    const [p, q] = seg.a === nodeId ? [pts[0]!, pts[1]!] : [pts[pts.length - 1]!, pts[pts.length - 2]!];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    return len > 0 ? { x: (q.x - p.x) / len, y: (q.y - p.y) / len } : null;
  };
  const other = node.incident.find((id) => id !== segId);
  const u = away(segId);
  const v = other === undefined ? null : away(other);
  if (!u || !v) return 0;
  // Straight on, the two directions away from the node are opposed.
  const cos = Math.max(-1, Math.min(1, -(u.x * v.x + u.y * v.y)));
  // Bends past the junction threshold get a junction instead; cap the push.
  return Math.min(Math.acos(cos), (20 * Math.PI) / 180);
}

/** A road's ribbon from its road, its trims and the bends at its two ends. */
export function makeRibbon(doc: RoadDoc, polylines: PolylineCache, id: SegmentId, seg: RoadSegment, t: SegmentTrims,
  bendA: number, bendB: number): SegmentRibbon {
  const full = polylines.get(doc, id);
  const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking);
  const length = full.length;
  const centre: Record<number, Polyline> = {};
  const rings: Record<number, Ring> = {};
  for (const level of SURFACE_LEVELS) {
    // Pull the ribbon back INTO the junction by a hair.
    const a = Math.max(0, (t.a[level] ?? 0) - SEAM_OVERLAP);
    const b = Math.max(0, (t.b[level] ?? 0) - SEAM_OVERLAP);
    const s0 = Math.min(a, Math.max(0, length - MIN_RIBBON));
    const s1 = Math.max(s0 + MIN_RIBBON * 0.5, length - b);
    const trimmed = full.sub(s0, Math.min(s1, length));
    centre[level] = trimmed;
    // The SURFACE overlaps its neighbour; the CENTRELINE above does not.
    const base = SEAM_OVERLAP + (level - Level.Casing) * SURFACE_END_STEP;
    // Each side to its own width.
    const hw = halfWidth(rt, level);
    rings[level] = ribbonRing(
      overlapUntrimmedEnds(trimmed, s0 <= 0, s1 >= length, base + hw * Math.tan(bendA / 2), base + hw * Math.tan(bendB / 2)),
      sideHalfWidth(rt, level, 'left'),
      sideHalfWidth(rt, level, 'right'),
    );
  }
  return { id, typeIndex: seg.type, direction: seg.direction, road: rt, centre, rings, dashOrigin: seg.dashOrigin, full };
}

/** Pushes an untrimmed end of a ribbon `amount` past the node, ALONG the end tangent */
function overlapUntrimmedEnds(line: Polyline, atStart: boolean, atEnd: boolean, amount: number, amountEnd: number): Polyline {
  if (!atStart && !atEnd) return line;
  const pts = line.toPoints();
  if (pts.length < 2) return line;
  const push = (from: Vec2, towards: Vec2, by: number): Vec2 => {
    const dx = from.x - towards.x;
    const dy = from.y - towards.y;
    const len = Math.hypot(dx, dy);
    if (len < MIN_RIBBON * 0.01) return from;
    return { x: from.x + (dx / len) * by, y: from.y + (dy / len) * by };
  };
  const out = [...pts];
  if (atStart) out[0] = push(out[0] as Vec2, out[1] as Vec2, amount);
  if (atEnd) {
    const last = out.length - 1;
    out[last] = push(out[last] as Vec2, out[last - 1] as Vec2, amountEnd);
  }
  return Polyline.fromPoints(out);
}

/** Closes a trimmed centreline into a carriageway outline */
function ribbonRing(centre: Polyline, hw: number, hwRight = hw): Ring {
  if (centre.n < 2 || centre.length <= 0) return new Ring({ x: 0, y: 0 }, []);
  const pts = centre.toPoints();
  const left = offsetPolyline(pts, hw);
  const right = offsetPolyline(pts, -hwRight);
  const loop: Vec2[] = [...left, ...right.slice().reverse()];
  return Ring.fromPolygon(loop).ensurePositive();
}

/** Everything a ribbon puts on any level (`surfaces.ts` levelRings) */
export function ribbonBounds(ribbon: SegmentRibbon): ChangeRect {
  let reach = 0;
  for (const level of SURFACE_LEVELS) reach = Math.max(reach, halfWidth(ribbon.road, level));
  const b = ribbon.full.bbox;
  let x0 = b.minX - reach, y0 = b.minY - reach, x1 = b.maxX + reach, y1 = b.maxY + reach;
  for (const level of SURFACE_LEVELS) {
    const ring = ribbon.rings[level];
    if (!ring || ring.isEmpty) continue;
    const r = ring.bbox;
    x0 = Math.min(x0, r.minX); y0 = Math.min(y0, r.minY); x1 = Math.max(x1, r.maxX); y1 = Math.max(y1, r.maxY);
  }
  return [x0, y0, x1, y1];
}

/** Every ring a node's junctions put on any level; null for none. */
export function junctionBounds(byLevel: ReadonlyMap<SurfaceLevel, Junction>): ChangeRect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const junction of byLevel.values()) {
    for (const ring of junction.rings) {
      if (ring.isEmpty) continue;
      const r = ring.bbox;
      x0 = Math.min(x0, r.minX); y0 = Math.min(y0, r.minY); x1 = Math.max(x1, r.maxX); y1 = Math.max(y1, r.maxY);
    }
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}
