import type { LaneletId } from '@world/lanelets';
import type { Vehicle } from '../vehicles/state';

/** The vehicles whose route goes over each lane or movement, filed by the writers of `Vehicle.route` (`SimWorld.noteRoute`). */
export class RouteIndex {
  private readonly byLane = new Map<LaneletId, Set<Vehicle>>();
  /** The ids each vehicle is filed under: its route as last noted. */
  private readonly filed = new Map<Vehicle, readonly LaneletId[]>();

  /** A vehicle filed under its route now, out of the lanes of the route it had. */
  file(v: Vehicle): void {
    this.unfile(v);
    const ids = v.route.slice();
    for (const id of ids) {
      const set = this.byLane.get(id);
      if (set) set.add(v); else this.byLane.set(id, new Set([v]));
    }
    this.filed.set(v, ids);
  }

  unfile(v: Vehicle): void {
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
  routing(id: LaneletId): ReadonlySet<Vehicle> | undefined {
    return this.byLane.get(id);
  }

  clear(): void {
    this.byLane.clear();
    this.filed.clear();
  }
}
