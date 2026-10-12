import { Polyline } from '@core/polyline';
import { flattenSegment } from '@core/bezier';
import { type Vec2, neg, perp } from '@core/vec2';
import type { RoadDoc, RoadSegment } from './doc';
import type { NodeId, SegmentId } from './ids';
import { chartAt, chartBetween, chartToChartInto, inChartInto } from './planet/charts';

const chartToChart = (from: number, to: number, p: Vec2): Vec2 => chartToChartInto(from, to, p.x, p.y, { x: 0, y: 0 });

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

/**
 * The chart a segment is worked out on (`world/planet/charts.ts`): on the
 * planet, the owner of the ground halfway between its ends, whatever pieces
 * the ends are written on; 0 on the flat map.
 */
export function segmentChart(doc: RoadDoc, seg: RoadSegment): number {
  if (!__PLANET__) return 0;
  const a = doc.requireNode(seg.a), b = doc.requireNode(seg.b);
  return chartBetween(a.x, a.y, b.x, b.y);
}

/** The chart a node is written on: the one its junction and every road seen from it are worked out on. */
export function nodeChart(doc: RoadDoc, node: NodeId): number {
  if (!__PLANET__) return 0;
  const n = doc.requireNode(node);
  return chartAt(n.x, n.y);
}

/**
 * Flattened centreline of a segment, oriented a -> b, on `chart`'s map (the
 * segment's own chart, `segmentChart`, by default): its ends carried onto
 * that chart, its curve laid there.
 *
 * Straight segments return their two endpoints exactly — no sampling error is
 * introduced where none is needed.
 */
export function segmentPolyline(doc: RoadDoc, seg: RoadSegment, chart = segmentChart(doc, seg)): Polyline {
  const a = doc.requireNode(seg.a);
  const b = doc.requireNode(seg.b);
  return Polyline.fromPoints(
    flattenSegment(inChartInto(chart, a.x, a.y, { x: 0, y: 0 }), inChartInto(chart, b.x, b.y, { x: 0, y: 0 }), seg.curve),
  );
}

/**
 * Centreline oriented so that it starts at `from`, on the chart `from` is
 * written on: what is framed at a node is framed on its chart.
 */
export function orientedPolyline(
  doc: RoadDoc,
  seg: RoadSegment,
  from: NodeId,
): Polyline {
  const pl = __PLANET__ ? fromChartOf(doc, seg, nodeChart(doc, from)) : segmentPolyline(doc, seg);
  return seg.a === from ? pl : pl.reversed();
}

/**
 * The segment's centreline on another chart: its own polyline's points
 * carried there (the curve is laid on the segment's own chart, so the same
 * ground is drawn whichever chart reads it).
 */
function fromChartOf(doc: RoadDoc, seg: RoadSegment, chart: number): Polyline {
  const own = segmentChart(doc, seg);
  const pl = segmentPolyline(doc, seg, own);
  return own === chart ? pl : carryPolyline(pl, own, chart);
}

/** A polyline of chart `from`'s map on chart `to`'s, point by point. */
export function carryPolyline(pl: Polyline, from: number, to: number): Polyline {
  if (!__PLANET__ || from === to) return pl;
  return Polyline.fromPoints(pl.toPoints().map((p) => chartToChart(from, to, p)));
}

/**
 * Frame at `distance` measured from `nodeId` along `seg`.
 *
 * `dir` always points away from `nodeId`, which is what makes every downstream
 * formula (corners, trims, stop lines, crosswalks) sign-consistent regardless
 * of how the segment happens to be stored.
 */
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

  /** On the planet, the segment's centreline on other charts (a junction's), by segment then chart. */
  private elsewhere = new Map<SegmentId, Map<number, Polyline>>();

  /** On the planet, each segment's own chart (`segmentChart`), kept with its centreline. */
  private charts = new Map<SegmentId, number>();

  /** The segment's centreline on its own chart (`segmentChart`). */
  get(doc: RoadDoc, id: SegmentId): Polyline {
    let pl = this.map.get(id);
    if (!pl) {
      const seg = doc.requireSegment(id);
      const chart = segmentChart(doc, seg);
      pl = segmentPolyline(doc, seg, chart);
      this.map.set(id, pl);
      if (__PLANET__) this.charts.set(id, chart);
    }
    return pl;
  }

  /** The chart `get` lays the segment on. */
  chart(doc: RoadDoc, id: SegmentId): number {
    if (!__PLANET__) return 0;
    this.get(doc, id);
    return this.charts.get(id) as number;
  }

  /** The segment's centreline on `chart`'s map: its own carried there (`carryPolyline`), or its own. */
  at(doc: RoadDoc, id: SegmentId, chart: number): Polyline {
    if (!__PLANET__) return this.get(doc, id);
    const own = this.chart(doc, id);
    if (own === chart) return this.get(doc, id);
    let byChart = this.elsewhere.get(id);
    if (!byChart) this.elsewhere.set(id, byChart = new Map());
    let pl = byChart.get(chart);
    if (!pl) byChart.set(chart, pl = carryPolyline(this.get(doc, id), own, chart));
    return pl;
  }

  invalidate(id: SegmentId): void {
    this.map.delete(id);
    this.elsewhere.delete(id);
    this.charts.delete(id);
  }

  clear(): void {
    this.map.clear();
    this.elsewhere.clear();
    this.charts.clear();
  }

  /**
   * Takes over another cache's entries.
   *
   * Used when one network adopts another's geometry after the two documents
   * have been made equal: every polyline in there was flattened from the same
   * segment id and is still the right answer, so re-flattening it would be work
   * for an identical result.
   */
  adopt(other: PolylineCache): void {
    this.map.clear();
    for (const [id, pl] of other.map) this.map.set(id, pl);
    this.elsewhere.clear();
    for (const [id, byChart] of other.elsewhere) this.elsewhere.set(id, new Map(byChart));
    this.charts.clear();
    for (const [id, chart] of other.charts) this.charts.set(id, chart);
  }

  get size(): number {
    return this.map.size;
  }
}
