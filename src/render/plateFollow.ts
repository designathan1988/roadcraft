/** A PRODUCT KEPT PLATE BY PLATE follows the plates shown (`TerrainSurface.parts`) by each plate's own revision: a plate that came or changed is taken alone, one that left lets its own go */

/** A plate shown (`TerrainPart`): its own surface and its centre. */
export interface ShownPlate<S> {
  readonly surface: S;
  readonly cx: number;
  readonly cy: number;
}

/** A plate taken: what its own revision was when taken, the part it was shown as, and what the product keeps of it. */
interface Taken<S, K> {
  seen: number;
  part: ShownPlate<S>;
  kept: K | undefined;
}

/** DO NOT key a product on a sum of the plates' revisions or on the shown set as a whole: a plate shown made every plate's work again */
export class PlateFollow<S extends object, K = never> {
  private readonly taken = new Map<S, Taken<S, K>>();
  private readonly shown = new Set<S>();
  /** Moves whenever a plate came, changed or left: what a product keyed on the plates shown reads. */
  version = 0;

  /** `revisionOf`: the plate's own revision of what the product reads (its water's log, its ecology). */
  constructor(private readonly revisionOf: (surface: S) => number) {}

  /** Brought up to the plates shown now: `left` for each plate gone since the last look, then `took` for each come or changed (given what was kept of it); the version. */
  follow(parts: readonly ShownPlate<S>[], took?: (part: ShownPlate<S>, was: K | undefined) => K, left?: (part: ShownPlate<S>, kept: K | undefined) => void): number {
    let moved = false;
    const shown = this.shown;
    shown.clear();
    for (const part of parts) shown.add(part.surface);
    for (const [surface, plate] of this.taken) {
      if (shown.has(surface)) continue;
      this.taken.delete(surface);
      left?.(plate.part, plate.kept);
      moved = true;
    }
    for (const part of parts) {
      const seen = this.revisionOf(part.surface);
      const plate = this.taken.get(part.surface);
      if (plate && plate.seen === seen) continue;
      const kept = took?.(part, plate?.kept);
      if (plate) { plate.seen = seen; plate.part = part; plate.kept = kept; } else this.taken.set(part.surface, { seen, part, kept });
      moved = true;
    }
    if (moved) this.version++;
    return this.version;
  }
}
