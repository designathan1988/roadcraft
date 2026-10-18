import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { deleteLot, lotCentre } from '@world/lots';
import { landscapeNearIn } from '@world/landscape';
import { onCarriageway } from '@world/carriageway';
import { type Anchor, ribbonsNear } from './snap';
import { roadsBefore, settleRoadEdit } from './roads/economy';
import { removeWithStreetKit } from './roads/streetKit';
import type { SegmentId } from '@world/ids';

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

/** Roads taken away as the player demolishes them, by any tool: their power line and furniture with them, a share of their price back (`editor/roads/economy.ts`). */
export function removeRoads(doc: RoadDoc, net: Network, ids: readonly SegmentId[]): boolean {
  return removeWithStreetKit(doc, net, ids, () => {
    const money = roadsBefore(doc);
    for (const id of ids) doc.removeSegment(id);
    doc.pruneOrphanNodes();
    settleRoadEdit(money, doc);
    return true;
  });
}

/** A press that moved less than this many screen pixels is a click. */
const CLICK_PIXELS = 6;

/** THE BULLDOZER: a click removes the one thing under the pointer */
export class Bulldozer {
  /** The box being dragged (screen pixels in the canvas, and the ground under its corners), or the press while it stays a click. */
  private drag: { pointer: number; a: Vec2; b: Vec2; world: Vec2; to: Vec2; anchor: Anchor } | null = null;

  constructor(private readonly host: BulldozerHost) {}

  gesture(): string | null {
    return this.drag ? 'gesture.bulldoze.box' : null;
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

  /** @perInput The pointer moved; true when it was this tool's drag. */
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

  /** @perInput The bulldozer's click: the one thing under the pointer. */
  private click(screen: Vec2, world: Vec2, anchor: Anchor): void {
    const { host } = this;
    const { doc } = host;
    // A building stands over whatever is under it, so it is tried first.
    if (host.bulldozeBuildingAt(screen)) return;
    // A click on a road's carriageway is for the road: poles and street items stand on the footways, and their pick reach (some 7 m zoomed out) must not take a lamp for the road under the pointer.
    const onRoad = anchor.kind === 'segment' && onCarriageway(host.net, world);
    // A pole stands ON the footway of a road
    const pole = onRoad ? null : doc.poleNear(world, host.poleReach());
    if (pole) {
      host.mutate(() => {
        doc.removePole(pole.id);
        return true;
      });
      host.hint('hint.pole.removed');
      return;
    }
    // Likewise a bench, a tree or a street light on the footway.
    const item = onRoad ? null : landscapeNearIn(doc, world, host.itemReach());
    if (item) {
      host.mutate(() => doc.removeLandscape(item.id));
      host.hint('hint.streetscape.removed');
      return;
    }
    if (anchor.kind === 'segment' && anchor.segment !== undefined) {
      const id = anchor.segment;
      host.mutate(() => removeRoads(doc, host.net, [id]));
    }
  }

  /** Everything inside the box removed in one undo step: roads */
  private boxed(a: Vec2, b: Vec2): void {
    const { doc, net } = this.host;
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const box = [x0, y0, x1, y1] as const;
    const inside = (p: Vec2): boolean => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    // DO NOT walk `doc.segments`, `doc.buildings.all()`, `doc.landscape` or `doc.barriers` here
    const segments = ribbonsNear(net, box).filter((ribbon) => inside(ribbon.full.sampleAt(ribbon.full.length / 2).p)).map((ribbon) => ribbon.id);
    const builtIds = doc.buildings.near(x0, y0, x1, y1).filter((bd) => inside({ x: bd.x, y: bd.y })).map((bd) => bd.id);
    // By the lots' index (`LotStore.in`): a centre inside the box is a lot whose box meets it.
    const lots = doc.lotsIn(box).filter((l) => inside(lotCentre(l))).map((l) => l.id);
    const poles = doc.polesIn([x0, y0, x1, y1]).filter((p) => inside(p)).sort((p, q) => p.id - q.id).map((p) => p.id);
    const items = doc.landscapeIn(box).filter((it) => inside(it)).map((it) => it.id);
    const walls = doc.barriersIn(box).filter((bar) => bar.points.some(inside)).map((bar) => bar.id);
    if (!segments.length && !builtIds.length && !lots.length && !poles.length && !items.length && !walls.length) return;
    this.host.mutate(() => {
      if (segments.length) removeRoads(doc, net, segments);
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
