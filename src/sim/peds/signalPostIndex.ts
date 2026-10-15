import type { NodeId } from '@world/ids';
import { type SignalPost, signalPostPlace, signalPosts } from '@world/signalPosts';
import { m } from '@world/units';
import type { SimWorld } from '../world';

/** Cell of the posts' grid, world units: a walker's look ahead (`walk.ts` LOOK). */
const POST_CELL = m(8);
const cellOf = (gx: number, gy: number): number => (gx + 32768) * 65536 + (gy + 32768);

/**
 * The traffic signal posts by place, for the walkers to keep clear of
 * (`walk.ts`: a post is a body standing still in their stripes, as a car's
 * discs are). Where each post stands is the world's one definition
 * (`world/signalPosts.ts`, the posts the renderer draws). Kept from the
 * junctions' control changes (`SimWorld.signalChangesSince`): a junction the
 * advisor turns to a signal, or back, has its own posts put up or taken
 * away; every post is placed again only when the junctions were rebuilt.
 * DO NOT ask the world for every post of the map to keep those round one
 * walker: every junction of the town, for every walker, every tick.
 */
export class SignalPostIndex {
  private serial = -1;
  private readonly byNode = new Map<NodeId, SignalPost[]>();
  private readonly cells = new Map<number, SignalPost[]>();
  /** What `near` hands out, written again by each call. */
  private readonly found: SignalPost[] = [];

  /** Brought up to the junctions' controls now. */
  follow(w: SimWorld): void {
    const { serial, nodes } = w.signalChangesSince(this.serial);
    if (serial === this.serial && nodes !== null) return;
    this.serial = serial;
    if (nodes === null) {
      this.byNode.clear();
      this.cells.clear();
      this.placeAll(w);
      return;
    }
    for (const node of new Set(nodes)) {
      this.lift(node);
      this.placeJunction(w, node);
    }
  }

  /**
   * One junction's posts: one on each approach of a signal group, where the
   * world stands it (`signalPostPlace`), as `signalPosts` lists them.
   * DO NOT ask `signalPosts` for them: its whole-map pass is in the same
   * function as the pass round a point.
   */
  private placeJunction(w: SimWorld, node: NodeId): void {
    const junction = w.graph.junctions.get(node);
    const record = w.doc.node(node);
    if (!junction?.signalised || !record) return;
    for (const segment of record.incident) {
      if (!junction.groups.some((group) => group.segments.includes(segment))) continue;
      const post = signalPostPlace(w.net, node, segment);
      if (post) this.file(post);
    }
  }

  /** @rebuild Every post of the map placed: the junctions were rebuilt (an edit of the roads, a new map). */
  private placeAll(w: SimWorld): void {
    for (const post of signalPosts(w.net, w.graph)) this.file(post);
  }

  private file(post: SignalPost): void {
    const list = this.byNode.get(post.node);
    if (list) list.push(post); else this.byNode.set(post.node, [post]);
    const k = cellOf(Math.floor(post.x / POST_CELL), Math.floor(post.y / POST_CELL));
    const cell = this.cells.get(k);
    if (cell) cell.push(post); else this.cells.set(k, [post]);
  }

  /** A junction's posts taken away. */
  private lift(node: NodeId): void {
    const posts = this.byNode.get(node);
    if (!posts) return;
    this.byNode.delete(node);
    for (const post of posts) {
      const k = cellOf(Math.floor(post.x / POST_CELL), Math.floor(post.y / POST_CELL));
      const cell = this.cells.get(k);
      if (!cell) continue;
      const at = cell.indexOf(post);
      if (at >= 0) cell.splice(at, 1);
      if (!cell.length) this.cells.delete(k);
    }
  }

  /**
   * The posts filed in the cells within `reach` of a point (a superset: the
   * caller keeps its own test). The list is the index's own, written again
   * by the next call.
   */
  near(x: number, y: number, reach: number): readonly SignalPost[] {
    const out = this.found;
    out.length = 0;
    if (!this.cells.size) return out;
    for (let gx = Math.floor((x - reach) / POST_CELL); gx <= Math.floor((x + reach) / POST_CELL); gx++) {
      for (let gy = Math.floor((y - reach) / POST_CELL); gy <= Math.floor((y + reach) / POST_CELL); gy++) {
        const cell = this.cells.get(cellOf(gx, gy));
        if (cell) for (const post of cell) out.push(post);
      }
    }
    return out;
  }
}
