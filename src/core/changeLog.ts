/** DO NOT keep the last N changes only: a reader that fell behind them read the whole thing again */
interface Entry<T> {
  readonly from: WeakRef<object>;
  readonly to: WeakRef<object>;
  /** In order; null: everything. */
  readonly changes: readonly T[] | null;
}

/** Entries at which the log is first merged; past it, again whenever it has doubled since. */
const MERGE_FROM = 64;

export class ChangeLog<T> {
  private entries: Entry<T>[] = [];
  private token: object = {};
  /** The current token's one reference: the entries either side of a state share it. */
  private tokenRef = new WeakRef(this.token);
  private merged = 0;
  private readonly none: readonly T[] = [];

  /** The state now, for `since`. */
  get state(): object {
    return this.token;
  }

  /** One more change (null: everything), and a new state. */
  push(change: T | null): void {
    const to = {};
    const toRef = new WeakRef(to);
    this.entries.push({ from: this.tokenRef, to: toRef, changes: change === null ? null : [change] });
    this.token = to;
    this.tokenRef = toRef;
    if (this.entries.length >= Math.max(MERGE_FROM, this.merged * 2)) {
      this.merge(() => true);
      this.merged = this.entries.length;
    }
  }

  /** Merges away the states no reader holds: collected, or not `held` */
  merge(held: (state: object) => boolean): void {
    const alive = (ref: WeakRef<object>): boolean => {
      if (ref === this.tokenRef) return true;
      const state = ref.deref();
      return state !== undefined && held(state);
    };
    const out: Entry<T>[] = [];
    for (const entry of this.entries) {
      const last = out[out.length - 1];
      if (last && last.to === entry.from && !alive(entry.from)) {
        out[out.length - 1] = { from: last.from, to: entry.to, changes: last.changes && entry.changes ? [...last.changes, ...entry.changes] : null };
      } else if (!last && !alive(entry.from)) {
        // No one can ask from the oldest state: its entry answers no one.
        continue;
      } else out.push(entry);
    }
    this.entries = out;
  }

  /** What changed since `state`, in order; null when the reader must read it all again */
  since(state: object | null): readonly T[] | null {
    if (state === this.token) return this.none;
    if (state === null) return null;
    const i = this.entries.findIndex((e) => e.from.deref() === state);
    if (i < 0) return null;
    const out: T[] = [];
    for (let j = i; j < this.entries.length; j++) {
      const changes = this.entries[j]!.changes;
      if (changes === null) return null;
      out.push(...changes);
    }
    return out;
  }
}
