import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { deleteLot, lotCentre } from '@world/lots';
import { landscapeNear } from '@world/landscape';
import type { Anchor } from './snap';
import type { FacePoint } from '@core/cubeSphere';
import { chartAt, chartToChartInto, inChartInto } from '@world/planet/charts';
import { roadsBefore, settleRoadEdit } from './roads/economy';

/** What the bulldozer reads of the game and does to it. */
export interface BulldozerHost {
  readonly doc: RoadDoc;
  readonly net: Network;
  /** The building under screen point `at` taken down; false when there is none. */
  bulldozeBuildingAt(at: Vec2): boolean;
  /** Pick radius of a pole and of a street item, world units at the current zoom. */
  poleReach(): number;
  itemReach(): number;
  /** An edit of the document, one undo step. */
  mutate(fn: () => boolean): void;
  hint(key: string): void;
  redraw(): void;
}

/** A press that moved less than this many screen pixels is a click. */
const CLICK_PIXELS = 6;

/**
 * THE BULLDOZER: a click removes the one thing under the pointer, a drag
 * draws a box on the map and removes everything inside it on release, as
 * SimCity's does - each one undo step. The box being dragged lives here
 * with the handlers that use it (Nystrom, "State").
 */
export class Bulldozer {
  /** The box being dragged (screen pixels in the canvas, and the ground under its corners), or the press while it stays a click. */
  private drag: { pointer: number; a: Vec2; b: Vec2; world: Vec2; to: Vec2; anchor: Anchor } | null = null;

  constructor(private readonly host: BulldozerHost) {}

  gesture(): string | null {
    return this.drag ? 'demolir: retângulo' : null;
  }

  inProgress(): boolean {
    return this.drag !== null;
  }

  cancel(): void {
    this.drag = null;
  }

  /** A press at screen point `screen` over `world`, `anchor` what is under it. */
  down(pointer: number, screen: Vec2, world: Vec2, anchor: Anchor): void {
    this.drag = { pointer, a: { ...screen }, b: { ...screen }, world: { ...world }, to: { ...world }, anchor };
  }

  /** The pointer moved; true when it was this tool's drag. */
  move(pointer: number, screen: Vec2, world: Vec2): boolean {
    if (this.drag?.pointer !== pointer) return false;
    this.drag.b = { ...screen };
    this.drag.to = { ...world };
    this.host.redraw();
    return true;
  }

  /** The pointer let go: the click or the box is carried out (`commit` false: dropped). */
  up(pointer: number, commit: boolean): void {
    const box = this.drag;
    if (box?.pointer !== pointer) return;
    this.drag = null;
    if (commit) {
      if (Math.hypot(box.b.x - box.a.x, box.b.y - box.a.y) < CLICK_PIXELS) this.click(box.a, box.world, box.anchor);
      else this.boxed(box.world, box.to);
    }
    this.host.redraw();
  }

  /** The box on the map while it is dragged (no longer a click), for the overlay. */
  box(): { readonly a: Vec2; readonly b: Vec2 } | null {
    const d = this.drag;
    if (!d || Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) < CLICK_PIXELS) return null;
    return { a: d.world, b: d.to };
  }

  /** The bulldozer's click: the one thing under the pointer. */
  private click(screen: Vec2, world: Vec2, anchor: Anchor): void {
    const { host } = this;
    const { doc } = host;
    // A building stands over whatever is under it, so it is tried first.
    if (host.bulldozeBuildingAt(screen)) return;
    // A pole stands ON the footway of a road, so the road under it would
    // otherwise always win the click and the pole could never be hit.
    const pole = doc.poleNear(world, host.poleReach());
    if (pole) {
      host.mutate(() => {
        doc.removePole(pole.id);
        return true;
      });
      host.hint('hint.pole.removed');
      return;
    }
    // Likewise a bench, a tree or a street light on the footway.
    const item = landscapeNear(doc.landscape.values(), world, host.itemReach());
    if (item) {
      host.mutate(() => doc.removeLandscape(item.id));
      host.hint('hint.streetscape.removed');
      return;
    }
    if (anchor.kind === 'segment' && anchor.segment !== undefined) {
      const id = anchor.segment;
      host.mutate(() => {
        // A share of the road's price comes back (`editor/roads/economy.ts`).
        const money = roadsBefore(doc);
        doc.removeSegment(id);
        doc.pruneOrphanNodes();
        settleRoadEdit(money, doc);
        return true;
      });
    }
  }

  /**
   * Everything inside the box removed in one undo step: roads (their middle
   * inside), buildings, lots, poles, trees and benches, walls. The box is on
   * the map, its corners the ground pressed and released, square to the
   * map's axes (the player, 2026-10-06: "o espaço do mapa e não 2D").
   */
  private boxed(a: Vec2, b: Vec2): void {
    const { doc, net } = this.host;
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    // On the planet the box is on the map of the piece it was pressed on, and
    // everything is read on that map (`world/planet/charts.ts`).
    const chart = chartAt(a.x, a.y);
    const on: FacePoint = { x: 0, y: 0 };
    const within = (p: FacePoint): boolean => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    const inside = (p: Vec2): boolean => within(inChartInto(chart, p.x, p.y, on));
    const segments = [...doc.segments.keys()].filter((id) => {
      const line = net.ribbons.get(id)?.full;
      if (!line) return false;
      const mid = line.sampleAt(line.length / 2).p;
      return within(chartToChartInto(net.polylines.chart(doc, id), chart, mid.x, mid.y, on));
    });
    const builtIds = [...doc.buildings.all()].filter((bd) => inside({ x: bd.x, y: bd.y })).map((bd) => bd.id);
    const lots = doc.lots.filter((l) => inside(lotCentre(l))).map((l) => l.id);
    const poles = [...doc.poles.values()].filter((p) => inside(p)).map((p) => p.id);
    const items = [...doc.landscape.values()].filter((it) => inside(it)).map((it) => it.id);
    const walls = [...doc.barriers.values()].filter((bar) => bar.points.some(inside)).map((bar) => bar.id);
    if (!segments.length && !builtIds.length && !lots.length && !poles.length && !items.length && !walls.length) return;
    this.host.mutate(() => {
      const money = roadsBefore(doc);
      for (const id of segments) doc.removeSegment(id);
      if (segments.length) doc.pruneOrphanNodes();
      if (segments.length) settleRoadEdit(money, doc);
      for (const id of lots) deleteLot(doc, id);
      for (const id of builtIds) doc.buildings.remove(id);
      for (const id of poles) doc.removePole(id);
      for (const id of items) doc.removeLandscape(id);
      for (const id of walls) doc.removeBarrier(id);
      return true;
    });
    this.host.hint('hint.lot.deleted');
  }
}
