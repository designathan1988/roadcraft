import type { Vec2 } from '@core/vec2';
import { BARRIER_SIZE, KERB_BARRIERS, type BarrierKind } from '@world/barriers';
import { ROAD_CLEARANCE, touchesRoad } from '@world/buildings/validate';
import type { Network } from '@world/network';
import { CURB_BAND, Level, halfWidth } from '@world/roadTypes';
import { m } from '@world/units';
import { ribbonsNear } from './snap';

/** Drawing walls, fences and hedges along a path (`world/barriers.ts`). */

/** How far from the back of a footway a point is still put onto it, world units. */
const FOOTWAY_REACH = m(3);
/** Shortest length of a run worth building, world units. */
const MIN_BARRIER_RUN = m(0.5);

function snapBarrierPoint(net: Network | null, kind: BarrierKind, at: Vec2): Vec2 {
  if (!net) return at;
  const half = m(BARRIER_SIZE[kind].thickness) / 2;
  let best: { d: number; p: Vec2 } | null = null;
  // DO NOT walk `net.ribbons` here: it runs on every pointer move (`plan`).
  const reach = ROAD_CLEARANCE + CURB_BAND + half + m(0.15) + FOOTWAY_REACH;
  for (const ribbon of ribbonsNear(net, [at.x - reach, at.y - reach, at.x + reach, at.y + reach])) {
    if (net.doc.segment(ribbon.id)?.structure === 'tunnel') continue;
    // A kerb barrier stands just behind the kerb stone, on the footway's road edge; the others along the footway's back.
    const back = KERB_BARRIERS.has(kind)
      ? ribbon.road.width / 2 + CURB_BAND + half + m(0.15)
      : halfWidth(ribbon.road, Level.Sidewalk) + ROAD_CLEARANCE + half + m(0.02);
    const q = at;
    const hit = ribbon.full.closestPoint(q);
    const off = Math.abs(hit.distance - back);
    if (off > FOOTWAY_REACH || (best && off >= best.d)) continue;
    const frame = ribbon.full.sampleAt(hit.s);
    const side = (q.x - frame.p.x) * frame.n.x + (q.y - frame.p.y) * frame.n.y >= 0 ? 1 : -1;
    best = { d: off, p: { x: frame.p.x + frame.n.x * side * back, y: frame.p.y + frame.n.y * side * back } };
  }
  return best ? best.p : at;
}

/** Why a run cannot be built, or null: it reaches a road or its footway, as a building's own parts may not */
function barrierProblem(net: Network | null, kind: BarrierKind, points: readonly Vec2[]): 'road' | 'short' | null {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    length += Math.hypot(b.x - points[i - 1]!.x, b.y - points[i - 1]!.y);
  }
  if (points.length < 2 || length < MIN_BARRIER_RUN) return 'short';
  if (!net) return null;
  const half = Math.max(m(0.02), m(BARRIER_SIZE[kind].thickness) / 2 - m(0.05));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
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

/** THE WALLS TOOL: a wall, fence or hedge traced point by point */
export class BarrierTool {
  /** The points put down so far; null when no run is being traced. */
  private points: Vec2[] | null = null;
  /** The last click, to tell a double click (which ends the run). */
  private lastClick: { t: number; x: number; y: number } | null = null;
  /** The pointer over the map. */
  private cursor: Vec2 | null = null;

  constructor(private readonly host: BarrierToolHost) {}

  /** The gesture in progress, as a dictionary key (the interface translates it), or null. */
  gesture(): string | null {
    return this.points ? 'gesture.barrier.tracing' : null;
  }

  cancel(): void {
    this.points = null;
  }

  /** @perInput A press at `world` (screen position `screenX/Y`, `detail` the click count the browser reports). */
  down(world: Vec2, shift: boolean, screenX: number, screenY: number, detail: number): void {
    const { host } = this;
    // DO NOT let a Shift-click with no run under it fall through to a point: it began a fence the player never asked for.
    if (shift) {
      host.hint(host.removeAt(world) ? 'hint.barrier.removed' : 'hint.barrier.nothing');
      return;
    }
    const point = snapBarrierPoint(host.net(), host.kind(), world);
    this.points = [...(this.points ?? []), point];
    // A double click ends the run.
    const now = performance.now();
    const last = this.lastClick;
    this.lastClick = { t: now, x: screenX, y: screenY };
    if (detail >= 2 || (last && now - last.t < 450 && Math.hypot(screenX - last.x, screenY - last.y) < 10)) {
      this.lastClick = null;
      this.finish();
    }
    host.redraw();
  }

  /** @perInput Runs once a pointer move: nothing it reaches may walk the map. */
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
    // A double click lands two points on one spot: one of them is enough.
    const path = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1]!.x, p.y - points[i - 1]!.y) > 1e-3).map((p) => ({ x: p.x, y: p.y }));
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

  /** The run as it will stand, for the overlay: its points */
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
  // DO NOT walk `net.ribbons` here: it runs on every pointer move (`plan`).
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of rect) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  for (const ribbon of ribbonsNear(net, [x0, y0, x1, y1])) {
    const reach = ribbon.road.width / 2 + CURB_BAND - m(0.02);
    for (const p of rect) if (ribbon.full.closestPoint(p).distance < reach) return true;
  }
  return false;
}
