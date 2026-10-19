import type { LaneletId } from '@world/lanelets';

/** The vehicles whose route goes over each lane or movement, filed by the writers of `Vehicle.route` (`SimWorld.noteRoute`); generic, so it does not import the vehicle that the world imports. */
export class RouteIndex<V extends { readonly route: readonly LaneletId[] }> {
  private readonly byLane = new Map<LaneletId, Set<V>>();
  /** The ids each vehicle is filed under: its route as last noted. */
  private readonly filed = new Map<V, readonly LaneletId[]>();
  private readonly before = new Set<LaneletId>();
  private readonly after = new Set<LaneletId>();

  /** A vehicle filed under its route now, out of the lanes of the route it had: DO NOT take it out of every lane and put it back for a step along its route (each lane it enters), only what came and went is touched. */
  file(v: V): void {
    const was = this.filed.get(v);
    const now = v.route;
    const ids = now.slice();
    if (!was) {
      for (const id of ids) this.add(id, v);
    } else if (ids.length === was.length - 1 && sameTail(was, ids)) {
      // A step along: the lane left, unless the route comes back to it.
      if (!ids.includes(was[0]!)) this.drop(was[0]!, v);
    } else {
      // Two sets kept for every call, not made for each (SIM-02).
      const before = this.before, after = this.after;
      for (const id of was) before.add(id);
      for (const id of ids) after.add(id);
      for (const id of before) if (!after.has(id)) this.drop(id, v);
      for (const id of after) if (!before.has(id)) this.add(id, v);
      before.clear();
      after.clear();
    }
    this.filed.set(v, ids);
  }

  private add(id: LaneletId, v: V): void {
    const set = this.byLane.get(id);
    if (set) set.add(v); else this.byLane.set(id, new Set([v]));
  }

  private drop(id: LaneletId, v: V): void {
    const set = this.byLane.get(id);
    if (!set) return;
    set.delete(v);
    if (!set.size) this.byLane.delete(id);
  }

  unfile(v: V): void {
    const was = this.filed.get(v);
    if (!was) return;
    for (const id of was) {
      const set = this.byLane.get(id);
      if (!set) continue;
      set.delete(v);
      if (!set.size) this.byLane.delete(id);
    }
    this.filed.delete(v);
  }

  /** The vehicles whose route goes over `id`, in no set order. */
  routing(id: LaneletId): ReadonlySet<V> | undefined {
    return this.byLane.get(id);
  }

  clear(): void {
    this.byLane.clear();
    this.filed.clear();
  }
}

/** Whether `tail` is `list` without its first. */
function sameTail(list: readonly LaneletId[], tail: readonly LaneletId[]): boolean {
  for (let i = 0; i < tail.length; i++) if (list[i + 1] !== tail[i]) return false;
  return true;
}
