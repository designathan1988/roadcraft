/** DO NOT keep the last N changes only: a reader that fell behind them read the whole thing again */
interface Entry<T> {
  readonly from: WeakRef<object>;
  readonly to: WeakRef<object>;
  /** In order; null: everything. */
  readonly changes: readonly T[] | null;
}

/** Entries at which the log is first merged; past it, again whenever it has doubled since. */
const MERGE_FROM = 64;

/** What a log may hold, given by its owner: each change's weight, and the most it holds for its oldest reader (what the owner holds now: a reader further behind reads it all again for no more). */
export interface LogBound<T> {
  readonly weight: (change: T) => number;
  readonly limit: () => number;
}

export class ChangeLog<T> {
  /** `bound`: none, the log holds what its readers' states keep, however much. */
  constructor(private readonly bound?: LogBound<T>) {}
  private entries: Entry<T>[] = [];
  /** What the entries hold (`bound.weight`). */
  private weight = 0;
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
    if (change !== null && this.bound) this.weight += this.bound.weight(change);
    this.token = to;
    this.tokenRef = toRef;
    // DO NOT wait for the count to double while what it holds passes twice what its owner holds: a reader kept on an old state held every change since (a heap snapshot of the simulation's worker over 70 tiles walked, 2026-10-17: the lane grid's log).
    if (this.entries.length >= Math.max(MERGE_FROM, this.merged * 2) || (this.bound && this.weight > 2 * this.bound.limit())) {
      this.merge(() => true);
      this.merged = this.entries.length;
    }
    // Still past it, every state held: the oldest let go, its reader told to read it all again (`since` null).
    if (this.bound) {
      const most = 2 * this.bound.limit();
      while (this.weight > most && this.entries.length > 1) {
        const first = this.entries.shift()!;
        if (first.changes) this.weight -= this.weightOf(first.changes);
      }
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
        const joined = last.changes && entry.changes ? [...last.changes, ...entry.changes] : null;
        // Past what the owner holds, held as everything (null): its reader reads it all again for no more.
        out[out.length - 1] = { from: last.from, to: entry.to, changes: joined && this.bound && this.weightOf(joined) > this.bound.limit() ? null : joined };
      } else if (!last && !alive(entry.from)) {
        // No one can ask from the oldest state: its entry answers no one.
        continue;
      } else out.push(entry);
    }
    this.entries = out;
    if (this.bound) this.weight = out.reduce((n, e) => n + (e.changes ? this.weightOf(e.changes) : 0), 0);
  }

  private weightOf(changes: readonly T[]): number {
    let n = 0;
    for (const c of changes) n += this.bound!.weight(c);
    return n;
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
