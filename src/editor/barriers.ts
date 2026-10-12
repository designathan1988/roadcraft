import type { Vec2 } from '@core/vec2';
import { BARRIER_SIZE, KERB_BARRIERS, type BarrierKind } from '@world/barriers';
import { ROAD_CLEARANCE, touchesRoad } from '@world/buildings/validate';
import type { Network } from '@world/network';
import { CURB_BAND, Level, halfWidth } from '@world/roadTypes';
import { m } from '@world/units';
import { chartAt, inChart, layRun, onChartOf } from '@world/planet/charts';
import { PLANET_MAX_PIECE } from './planetFrame';

/**
 * ON THE PLANET a run's points are kept each on the chart of the piece it lies
 * on (`layRun`), a stretch worked out on its first point's chart, the second
 * carried there; a road's ribbon is kept on its segment's chart, and a point
 * is measured against it carried onto that chart (`onRibbon`).
 */
const onRibbon = (net: Network, id: number, p: Vec2): Vec2 => {
  const chart = net.polylines.chart(net.doc, id as never);
  return chartAt(p.x, p.y) === chart ? p : inChart(chart, p);
};

/**
 * Drawing walls, fences and hedges along a path (`world/barriers.ts`).
 *
 * A point put down near a road goes onto the back of its footway, the line a
 * building's front snaps to (`buildingSnap.ts`), so a boundary drawn along a
 * street stands flush with the pavement and with the houses on it. Elsewhere
 * it stays where it was put.
 */

/** How far from the back of a footway a point is still put onto it, world units. */
const FOOTWAY_REACH = m(3);
/** Shortest length of a run worth building, world units. */
export const MIN_BARRIER_RUN = m(0.5);

export function snapBarrierPoint(net: Network | null, kind: BarrierKind, at: Vec2): Vec2 {
  if (!net) return at;
  const half = m(BARRIER_SIZE[kind].thickness) / 2;
  let best: { d: number; p: Vec2 } | null = null;
  for (const ribbon of net.ribbons.values()) {
    if (net.doc.segment(ribbon.id)?.structure === 'tunnel') continue;
    // A kerb barrier stands just behind the kerb stone, on the footway's
    // road edge; the others along the footway's back.
    const back = KERB_BARRIERS.has(kind)
      ? ribbon.road.width / 2 + CURB_BAND + half + m(0.15)
      : halfWidth(ribbon.road, Level.Sidewalk) + ROAD_CLEARANCE + half + m(0.02);
    const q = onRibbon(net, ribbon.id, at);
    const hit = ribbon.full.closestPoint(q);
    const off = Math.abs(hit.distance - back);
    if (off > FOOTWAY_REACH || (best && off >= best.d)) continue;
    const frame = ribbon.full.sampleAt(hit.s);
    const side = (q.x - frame.p.x) * frame.n.x + (q.y - frame.p.y) * frame.n.y >= 0 ? 1 : -1;
    best = { d: off, p: { x: frame.p.x + frame.n.x * side * back, y: frame.p.y + frame.n.y * side * back } };
  }
  return best ? best.p : at;
}

/**
 * Why a run cannot be built, or null: it reaches a road or its footway, as a
 * building's own parts may not (`validateBuilding`, same test).
 */
export function barrierProblem(net: Network | null, kind: BarrierKind, points: readonly Vec2[]): 'road' | 'short' | null {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const b = onChartOf(points[i]!, points[i - 1]!);
    length += Math.hypot(b.x - points[i - 1]!.x, b.y - points[i - 1]!.y);
  }
  if (points.length < 2 || length < MIN_BARRIER_RUN) return 'short';
  if (!net) return null;
  const half = Math.max(m(0.02), m(BARRIER_SIZE[kind].thickness) / 2 - m(0.05));
  for (let i = 1; i < points.length; i++) {
    // The stretch's footprint on its first point's chart.
    const a = points[i - 1]!, b = onChartOf(points[i]!, a);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const nx = -(b.y - a.y) / len * half, ny = (b.x - a.x) / len * half;
    const rect = [
      { x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny },
    ];
    if (KERB_BARRIERS.has(kind) ? onCarriageway(net, rect) : touchesRoad(net, rect)) return 'road';
  }
  return null;
}

/** What the walls tool reads of the game and does to it. */
export interface BarrierToolHost {
  net(): Network | null;
  kind(): BarrierKind;
  /** Removes the run under a shift-click, if any; true when one was. */
  removeAt(at: Vec2): boolean;
  /** Builds a run, one undo step. */
  build(kind: BarrierKind, path: readonly Vec2[]): void;
  hint(key: string): void;
  redraw(): void;
}

/**
 * THE WALLS TOOL: a wall, fence or hedge traced point by point - a click a
 * point, a double click or Enter ends the run, Backspace takes the last
 * point back, Esc drops it, Shift-click removes a run. The run being traced
 * lives here, with the handlers that use it, not in `main.ts`.
 */
export class BarrierTool {
  /** The points put down so far; null when no run is being traced. */
  private points: Vec2[] | null = null;
  /** The last click, to tell a double click (which ends the run). */
  private lastClick: { t: number; x: number; y: number } | null = null;
  /** The pointer over the map. */
  private cursor: Vec2 | null = null;

  constructor(private readonly host: BarrierToolHost) {}

  gesture(): string | null {
    return this.points ? 'cerca: traçando' : null;
  }

  cancel(): void {
    this.points = null;
  }

  /** A press at `world` (screen position `screenX/Y`, `detail` the click count the browser reports). */
  down(world: Vec2, shift: boolean, screenX: number, screenY: number, detail: number): void {
    const { host } = this;
    // Shift-click removes a run; a click puts a point down.
    if (shift && host.removeAt(world)) {
      host.hint('hint.barrier.removed');
      return;
    }
    const point = snapBarrierPoint(host.net(), host.kind(), world);
    this.points = [...(this.points ?? []), point];
    // A double click ends the run. Detected here by time and distance:
    // `detail` on a pointerdown is 0 in Chrome, so the run never ended and
    // the wall, fence or hedge was never built - only its path was drawn.
    const now = performance.now();
    const last = this.lastClick;
    this.lastClick = { t: now, x: screenX, y: screenY };
    if (detail >= 2 || (last && now - last.t < 450 && Math.hypot(screenX - last.x, screenY - last.y) < 10)) {
      this.lastClick = null;
      this.finish();
    }
    host.redraw();
  }

  move(world: Vec2): void {
    this.cursor = world;
    this.host.redraw();
  }

  /** A key while a run is traced; true when the tool took it. */
  key(key: string): boolean {
    if (!this.points) return false;
    if (key === 'Enter') { this.finish(); return true; }
    if (key === 'Backspace') {
      this.points.pop();
      if (this.points.length === 0) this.points = null;
      this.host.redraw();
      return true;
    }
    if (key === 'Escape') { this.points = null; this.host.redraw(); return true; }
    return false;
  }

  /** Builds the run traced so far, in one undo step, or says why it cannot be. */
  private finish(): void {
    const { host } = this;
    const points = this.points ?? [];
    this.points = null;
    // A double click lands two points on one spot: one of them is enough. On
    // the planet the run is laid in pieces kept on their own charts (`layRun`).
    const path = layRun(points.filter((p, i) => {
      if (i === 0) return true;
      const q = onChartOf(p, points[i - 1]!);
      return Math.hypot(q.x - points[i - 1]!.x, q.y - points[i - 1]!.y) > 1e-3;
    }), PLANET_MAX_PIECE);
    if (path.length < 2) { host.redraw(); return; }
    const problem = barrierProblem(host.net(), host.kind(), path);
    if (problem) {
      host.hint(`hint.barrier.${problem}`);
      host.redraw();
      return;
    }
    host.build(host.kind(), path);
    host.hint('hint.barrier.built');
  }

  /**
   * The run as it will stand, for the overlay: its points (the pointer's
   * added), whether it would reach a road, and the points put down with the
   * pointer's snapped point.
   */
  plan(): { line: Vec2[]; bad: boolean; dots: Vec2[] } {
    const kind = this.host.kind(), net = this.host.net();
    const cursor = this.cursor ? snapBarrierPoint(net, kind, this.cursor) : null;
    const line = [...(this.points ?? []), ...(this.points && cursor ? [cursor] : [])];
    const bad = line.length >= 2 && barrierProblem(net, kind, line) === 'road';
    return { line, bad, dots: [...(this.points ?? []), ...(cursor ? [cursor] : [])] };
  }
}

/** Whether any corner of a footprint is on a carriageway or its kerb (a kerb barrier may stand on the footway). */
function onCarriageway(net: Network, rect: readonly Vec2[]): boolean {
  for (const ribbon of net.ribbons.values()) {
    const reach = ribbon.road.width / 2 + CURB_BAND - m(0.02);
    for (const p of rect) if (ribbon.full.closestPoint(onRibbon(net, ribbon.id, p)).distance < reach) return true;
  }
  return false;
}
