import { ForkMap } from '@core/forkMap';
import { Polyline } from '@core/polyline';
import { type CurveShape, flattenSegment } from '@core/bezier';
import { type Vec2, neg, perp } from '@core/vec2';
import type { RoadDoc, RoadSegment } from './doc';
import type { NodeId, SegmentId } from './ids';

/** A cross-section frame taken at some distance from one end of a segment. */
export interface LegFrame {
  /** Position on the centreline. */
  readonly p: Vec2;
  /** Unit direction pointing AWAY from the reference node. */
  readonly dir: Vec2;
  /** Unit left normal of `dir`. */
  readonly nrm: Vec2;
  /** Total arc length of the segment. */
  readonly length: number;
}

/** Flattened centreline of a segment, oriented a -> b. */
export function segmentPolyline(doc: RoadDoc, seg: RoadSegment): Polyline {
  const a = doc.requireNode(seg.a);
  const b = doc.requireNode(seg.b);
  return segmentLine({ x: a.x, y: a.y }, { x: b.x, y: b.y }, seg.curve);
}

/** A segment's centreline from its two ends and its curve (`segmentPolyline`): what a worker makes it from too (`junctionBuild.ts`). */
export function segmentLine(a: Vec2, b: Vec2, curve: CurveShape | null): Polyline {
  return Polyline.fromPoints(flattenSegment(a, b, curve));
}

/** Centreline oriented so that it starts at `from`. */
export function orientedPolyline(
  doc: RoadDoc,
  seg: RoadSegment,
  from: NodeId,
): Polyline {
  const pl = segmentPolyline(doc, seg);
  return seg.a === from ? pl : pl.reversed();
}

/** Frame at `distance` measured from `nodeId` along `seg`. */
export function frameFromNode(
  pl: Polyline,
  segStartsAtNode: boolean,
  distance: number,
): LegFrame {
  const length = pl.length;
  if (segStartsAtNode) {
    const f = pl.sampleAt(distance);
    return { p: f.p, dir: f.t, nrm: perp(f.t), length };
  }
  const f = pl.sampleAt(length - distance);
  const dir = neg(f.t);
  return { p: f.p, dir, nrm: perp(dir), length };
}

/** The other endpoint of `seg`. */
export const farNode = (seg: RoadSegment, from: NodeId): NodeId =>
  seg.a === from ? seg.b : seg.a;

export const segmentStartsAt = (seg: RoadSegment, node: NodeId): boolean =>
  seg.a === node;

/** Cheap cache of per-segment polylines, rebuilt only for dirty segments. */
export class PolylineCache {
  private map = new Map<SegmentId, Polyline>();

  /** The segment's centreline. */
  get(doc: RoadDoc, id: SegmentId): Polyline {
    let pl = this.map.get(id);
    if (!pl) {
      pl = segmentPolyline(doc, doc.requireSegment(id));
      this.map.set(id, pl);
    }
    return pl;
  }

  invalidate(id: SegmentId): void {
    this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
  }

  /** A working copy over `other` (`Network.fork`): reads through it, keeps only the polylines it makes or drops. */
  forkFrom(other: PolylineCache): void {
    this.map = new ForkMap(other.map);
  }

  /** A working copy's changes (`forkFrom`) written back. */
  takeBack(fork: PolylineCache): void {
    (fork.map as ForkMap<SegmentId, Polyline>).applyTo(this.map);
  }

  get size(): number {
    return this.map.size;
  }
}
