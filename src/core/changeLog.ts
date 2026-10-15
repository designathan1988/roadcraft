/**
 * The states a derived thing has been in, as tokens, and what changed from
 * each to the next: a reader keeps the token it last read and asks what
 * changed since (`since`), an update at a time, in order - the change a build
 * system hands on, item by item, instead of a revision that says only THAT
 * something changed (Mokhov, Mitchell and Peyton Jones, "Build systems à la
 * carte"). A change of `null` is "everything": a reader past it reads the
 * whole thing again, as one further behind than the log remembers does.
 */
export class ChangeLog<T> {
  private readonly entries: { readonly from: object; readonly change: T | null }[] = [];
  private token: object = {};
  private readonly none: readonly T[] = [];

  /** `kept`: how many changes are remembered. */
  constructor(private readonly kept = 64) {}

  /** The state now, for `since`. */
  get state(): object {
    return this.token;
  }

  /** One more change (null: everything), and a new state. */
  push(change: T | null): void {
    this.entries.push({ from: this.token, change });
    this.token = {};
    if (this.entries.length > this.kept) this.entries.shift();
  }

  /**
   * What changed since `state`, in order; null when the reader must read it
   * all again (no state yet, too far behind, or a change of everything since).
   */
  since(state: object | null): readonly T[] | null {
    if (state === this.token) return this.none;
    if (state === null) return null;
    const i = this.entries.findIndex((e) => e.from === state);
    if (i < 0) return null;
    const out: T[] = [];
    for (let j = i; j < this.entries.length; j++) {
      const change = this.entries[j]!.change;
      if (change === null) return null;
      out.push(change);
    }
    return out;
  }
}
