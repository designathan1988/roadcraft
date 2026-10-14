import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { deleteLot, lotCentre } from '@world/lots';
import { landscapeNear } from '@world/landscape';
import { LANDSCAPE_RADIUS_MOST, barriersMeeting, landscapeAround } from './itemCells';
import { type Anchor, ribbonsNear } from './snap';
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

  /**
   * The pointer moved; true when it was this tool's drag.
   * @perInput Runs once a pointer move: nothing it reaches may walk the map.
   */
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

  /**
   * The bulldozer's click: the one thing under the pointer.
   * @perInput Runs once an input on one thing (a press, a release, a click): nothing it reaches may walk the map.
   */
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
    // The items round the pointer (`itemCells.ts`): one counts within its own radius of the reach.
    const reach = host.itemReach();
    const item = landscapeNear(landscapeAround(doc, world, reach + LANDSCAPE_RADIUS_MOST), world, reach);
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
    const box = [x0, y0, x1, y1] as const;
    const inside = (p: Vec2): boolean => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    // Each kind from its own index, the box's cells only: a road's middle lies
    // in its ribbon's filed bounds, a building's anchor in its stored bounds,
    // an item's point and a wall's points in their filed boxes.
    // DO NOT walk `doc.segments`, `doc.buildings.all()`, `doc.landscape` or
    // `doc.barriers` here: a box on a street read the whole map, five times.
    const segments = ribbonsNear(net, box).filter((ribbon) => inside(ribbon.full.sampleAt(ribbon.full.length / 2).p)).map((ribbon) => ribbon.id);
    const builtIds = doc.buildings.near(x0, y0, x1, y1).filter((bd) => inside({ x: bd.x, y: bd.y })).map((bd) => bd.id);
    // The lots have no index of their own yet (`world/lots.ts`, their diary
    // entries carry no ids): read whole, once a box let go.
    const lots = doc.lots.filter((l) => inside(lotCentre(l))).map((l) => l.id);
    const poles = doc.polesIn([x0, y0, x1, y1]).filter((p) => inside(p)).sort((p, q) => p.id - q.id).map((p) => p.id);
    const items = landscapeAround(doc, { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, Math.max(x1 - x0, y1 - y0) / 2).filter((it) => inside(it)).map((it) => it.id);
    const walls = barriersMeeting(doc, box).filter((bar) => bar.points.some(inside)).map((bar) => bar.id);
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
