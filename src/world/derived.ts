import type { Change, ChangeJournal, ChangeKind, ChangeRect, JournalReader } from './changes';

/** DO NOT key a product on a global revision (`${doc.buildings.revision}`) and build the map again */

/** ONE WAY TO READ THE DIARY the cursor every reader shares, instead of fourteen hand-written  calls each with its own */
export class JournalCursor implements JournalReader {
  private journal: ChangeJournal | null = null;
  private seen = -1;

  /** The serial last read (`JournalReader`): its diary keeps what came after it for it. */
  get seenSerial(): number {
    return this.seen;
  }

  /** `needIds`: an entry without ids means everything changed (the reader works by item). */
  constructor(readonly kinds: readonly ChangeKind[], private readonly needIds = false) {}

  /** The entries of its kinds since the last read, oldest first; null: everything changed. */
  read(journal: ChangeJournal): readonly Change[] | null {
    const same = this.journal === journal;
    const seen = this.seen;
    if (!same) journal.follow(this);
    this.journal = journal;
    this.seen = journal.version;
    if (!same || seen < 0) return null;
    const entries = journal.since(seen, this.kinds);
    if (entries === null) return null;
    if (this.needIds && entries.some((e) => !e.ids)) return null;
    return entries;
  }

  /** Forgets what was read: the next read is everything. */
  reset(): void {
    this.journal = null;
    this.seen = -1;
  }
}

/** What a product reads and how it is computed, key by key. */
export interface DerivedSpec<D, K, V> {
  /** For the ledger and the console. */
  readonly name: string;
  /** The kinds of change it reads; nothing else makes it compute. */
  readonly kinds: readonly ChangeKind[];
  /** Whether an entry without ids makes everything dirty (a product by item). */
  readonly byId: boolean;
  /** DO NOT walk the map anywhere else in a product: `dirty` and `compute` work on what one change touched. */
  allKeys(source: D): Iterable<K>;
  /** The keys one change makes dirty, added to `out`. */
  dirty(change: Change, out: Set<K>, source: D): void;
  /** The value of a key now; undefined: there is none (the item is gone). */
  compute(key: K, source: D): V | undefined;
  /** Whether two values are the same (Salsa's backdating); by identity when absent. */
  equals?(a: V, b: V): boolean;
  /** Told of each key whose value changed, for an index kept beside the values. */
  changed?(key: K, before: V | undefined, after: V | undefined): void;
}

/** What a product did: computes and whole rebuilds, since it was made (the ledger reads these). */
export interface DerivedWork {
  computes: number;
  wholes: number;
  /** Computes of the last refresh. */
  last: number;
}

/** No entry added (`Derived.refresh`). */
const NO_CHANGES: readonly Change[] = Object.freeze([]);

/** A product derived from the document, key by key. */
export class Derived<D extends { readonly changes: ChangeJournal }, K, V> {
  private readonly values = new Map<K, V>();
  private readonly cursor: JournalCursor;
  readonly work: DerivedWork = { computes: 0, wholes: 0, last: 0 };

  constructor(readonly spec: DerivedSpec<D, K, V>) {
    this.cursor = new JournalCursor(spec.kinds, spec.byId);
  }

  get(key: K): V | undefined {
    return this.values.get(key);
  }

  entries(): IterableIterator<[K, V]> {
    return this.values.entries();
  }

  get size(): number {
    return this.values.size;
  }

  /** Computes what the changes since the last refresh made dirty, and what `more` does (entries the caller adds: where the streamed world's active region moved, `render/activeTiles.ts`; null, everything); returns the keys whose value changed. */
  refresh(source: D, more: readonly Change[] | null = NO_CHANGES): ReadonlySet<K> {
    const entries = this.cursor.read(source.changes);
    const dirty = new Set<K>();
    // An added entry without ids makes a product by item whole (`byId`), as one of the diary's does.
    if (entries === null || more === null || (this.spec.byId && more.some((e) => !e.ids))) {
      this.work.wholes++;
      for (const key of this.values.keys()) dirty.add(key);
      for (const key of this.spec.allKeys(source)) dirty.add(key);
    } else {
      for (const change of entries) this.spec.dirty(change, dirty, source);
      for (const change of more) this.spec.dirty(change, dirty, source);
    }
    const changed = new Set<K>();
    for (const key of dirty) {
      const before = this.values.get(key);
      const after = this.spec.compute(key, source);
      this.work.computes++;
      const same = before === undefined || after === undefined ? before === after
        : this.spec.equals ? this.spec.equals(before, after) : before === after;
      if (same) continue;
      if (after === undefined) this.values.delete(key); else this.values.set(key, after);
      changed.add(key);
      this.spec.changed?.(key, before, after);
    }
    this.work.last = dirty.size;
    return changed;
  }
}

/** Side of a cell of `ChangeSweep`'s filing, world units. */
const SWEEP_CELL = 64; // world units (1 m)
/** A rectangle covering more cells than this is taken as the whole map: the sweep answers "changed" everywhere. */
const SWEEP_MAX_CELLS = 4096;

/** DO NOT ask the journal per reader per frame: each asked for every entry since its serial */
export class ChangeSweep implements JournalReader {
  private from = -1;
  private now = -1;
  /** Rectangles by cell; null: a change of the whole map (or one too wide to file). */
  private cells: Map<number, ChangeRect[]> | null = new Map();

  constructor(readonly journal: ChangeJournal, readonly kinds: readonly ChangeKind[]) {
    journal.follow(this);
  }

  /** What it has read up to (`JournalReader`): its diary keeps what came after it until the next `advance`. */
  get seenSerial(): number {
    return this.now;
  }

  /** The serial the readers are brought up to. */
  get serial(): number {
    return this.now;
  }

  /** Reads what was written since the last advance (once a frame). */
  advance(): void {
    const now = this.journal.serialOf(...this.kinds);
    if (now === this.now) return;
    const from = this.now;
    this.from = from;
    this.now = now;
    if (from < 0 || now < from) { this.cells = null; return; }
    const entries = this.journal.since(from, this.kinds);
    if (entries === null) { this.cells = null; return; }
    const cells = new Map<number, ChangeRect[]>();
    for (const entry of entries) {
      if (entry.rects === null) { this.cells = null; return; }
      for (const r of entry.rects) {
        const i0 = Math.floor(r[0] / SWEEP_CELL), i1 = Math.floor(r[2] / SWEEP_CELL);
        const j0 = Math.floor(r[1] / SWEEP_CELL), j1 = Math.floor(r[3] / SWEEP_CELL);
        if ((i1 - i0 + 1) * (j1 - j0 + 1) > SWEEP_MAX_CELLS) { this.cells = null; return; }
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            const k = (i + 32768) * 65536 + (j + 32768);
            const list = cells.get(k);
            if (list) list.push(r); else cells.set(k, [r]);
          }
        }
      }
    }
    this.cells = cells;
  }

  /** Whether a change of the kinds after `seen` reaches the point. */
  touches(seen: number, x: number, y: number): boolean {
    if (seen >= this.now) return false;
    if (seen !== this.from) return this.journal.touches(seen, [x, y, x, y], this.kinds);
    if (this.cells === null) return true;
    const list = this.cells.get((Math.floor(x / SWEEP_CELL) + 32768) * 65536 + (Math.floor(y / SWEEP_CELL) + 32768));
    if (!list) return false;
    for (const r of list) if (r[0] <= x && r[2] >= x && r[1] <= y && r[3] >= y) return true;
    return false;
  }
}
