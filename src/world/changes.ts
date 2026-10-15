/**
 * THE WORLD'S DIARY OF CHANGES: what changed, where, and why - one record for
 * the whole game (the player, 2026-10-08: "se algo muda tem que saber o que
 * mudou, onde, etc."; "as estradas mudam terreno, ninguém sabe como, onde,
 * por quê").
 *
 * Before it, some twenty revision counters on the document said only THAT
 * something of a kind changed somewhere, and every system found out what by
 * digesting the whole map again; one of those findings was wrong for months
 * (the natural ground moved whenever a road shaped the drawn one, and every
 * road was solved and paved again: docs/source/PROBLEMAS.md P12) and nothing showed
 * it.
 *
 * An entry is an EVENT - what already happened, its data captured when it is
 * written (Nystrom, "Event Queue") - with the rectangles it happened in and
 * its cause: the tool and gesture for an edit of the document, or the entry it
 * follows from for what the game derives (the roads' heights solved, the
 * ground cut and filled, the land relit, the road tiles built), so every
 * change can be traced back to the edit that made it. Nobody is called when
 * one is written: whoever depends on a kind of change reads the entries since
 * the serial it last saw (`since`, `touches`), as `render/groundChanges.ts`
 * already did for the drawn ground - no listener to forget to unregister
 * (Nystrom, "Observer": the lapsed listener), no global bus (the diary belongs
 * to the document), and every change goes through one place (Nystrom, "Dirty
 * Flag": the flag a path forgets to set is the bug).
 *
 * Pure: no three, no DOM.
 */

/** A world rectangle: [minX, minY, maxX, maxY]. */
export type ChangeRect = readonly [number, number, number, number];

/**
 * What the player changes in the document. `roads` is the roads' geometry;
 * `traffic` the plan the traffic runs on, written with it when the plan
 * changes (a node raised without changing how it is crossed is not).
 */
export type DocChangeKind =
  | 'roads' | 'traffic' | 'terrain' | 'paint' | 'buildings' | 'zones' | 'lots' | 'utilities' | 'barriers' | 'landscape'
  | 'transit' | 'people' | 'trees' | 'clearings' | 'elements' | 'fog' | 'clouds' | 'weather' | 'nature' | 'gullies'
  /** The balance (`economy.ts`): an edit paid for, or a demolition paid back. */
  | 'economy'
  /**
   * The land already cut into lots (`LotStore.addKeys`): no lot came or went,
   * so a reader of the lots by id (`lots`, every entry with its ids) does not
   * take it for "everything changed".
   */
  | 'lotKeys'
  /**
   * The regional standard of the road paint (`RoadDoc.markingStyle`): every
   * road's paint and the plates it puts up, and nothing of the roads' shape -
   * `revision` (the roads) does not move for it.
   */
  | 'markingStyle'
  /**
   * A building's wear (`Building.decay`: age, soot) and nothing else of it
   * (`BuildingStore.wear`). Only what draws or saves a building reads it; what
   * reads a building's shape, place or use reads `buildings`.
   */
  | 'buildingWear';
/**
 * Every kind of change to the document, listed once (checked complete by the
 * type): what a reader of "anything the player changed" asks the diary for,
 * instead of a hand-kept list of revisions that misses the kinds added later.
 */
const DOC_KINDS = {
  roads: 1, traffic: 1, terrain: 1, paint: 1, buildings: 1, zones: 1, lots: 1, utilities: 1, barriers: 1, landscape: 1,
  transit: 1, people: 1, trees: 1, clearings: 1, elements: 1, fog: 1, clouds: 1, weather: 1, nature: 1, gullies: 1, economy: 1,
  lotKeys: 1, markingStyle: 1, buildingWear: 1,
} as const satisfies Record<DocChangeKind, 1>;
export const DOC_CHANGE_KINDS = Object.keys(DOC_KINDS) as DocChangeKind[];
/** What the game works out from it. */
export type DerivedChangeKind = 'elevation' | 'ground' | 'light' | 'surfaces';
export type ChangeKind = DocChangeKind | DerivedChangeKind;

export interface Change {
  /** Order of writing; every entry has its own. */
  readonly serial: number;
  readonly kind: ChangeKind;
  /** Where, in world units; `null` the whole map. */
  readonly rects: readonly ChangeRect[] | null;
  /** The ids it touched (segments, nodes, stamps, poles...), when it has them. */
  readonly ids?: readonly number[];
  /** Why: the tool and gesture, or what derived it. */
  readonly cause: string;
  /** The entry it follows from (a derived change). */
  readonly parent?: number;
  /** When it was written (`performance.now()`), and how long its work took, ms. */
  readonly at: number;
  readonly ms?: number;
  /** A line for whoever reads the diary: counts, sizes. */
  readonly detail?: string;
}

/** What a reader stands on: one rectangle, its items' rectangles, or nothing. */
export type ChangeArea = ChangeRect | readonly ChangeRect[] | null;

/**
 * How many entries are kept, in all and of each kind: a reader older than
 * that takes everything as changed. Of EACH kind: in one ring for all, a
 * burst of one kind (2.048 buildings of a growing city) forgot the others,
 * and a reader of the ground that had missed nothing was told "everything
 * changed" and laid the whole map again (docs/AUDITORIA-2026-10-14.md D8/C1).
 * NO single ring for a reader of some kinds: a kind is forgotten only by
 * entries of its own.
 */
const KEPT = 2048;

/**
 * The entries of one kind, newest last, in a ring of `KEPT`, and the serial
 * up to which they may be missing (one overwritten, or the copy's start).
 */
class KindLog {
  private readonly ring: Change[] = [];
  private written = 0;
  constructor(public missingUpTo: number) {}

  push(entry: Change): void {
    const at = this.written % KEPT;
    const old = this.ring[at];
    if (old) this.missingUpTo = Math.max(this.missingUpTo, old.serial);
    this.ring[at] = entry;
    this.written++;
  }

  /** Its entries after `since`, newest first, into `out`; each one looked at counted. */
  after(since: number, out: Change[]): void {
    for (let i = this.written - 1; i >= Math.max(0, this.written - KEPT); i--) {
      const entry = this.ring[i % KEPT]!;
      journalWork.entries++;
      if (entry.serial <= since) return;
      out.push(entry);
    }
  }
}

/**
 * The work of the diary's readers: entries looked at to answer `since` and
 * `touches`. A count, not a time (`tests/scale/buildingEdit.spec.ts`): a
 * reader of one kind that walks every entry of the others since it last saw
 * its own - one building more, one entry more to walk - shows at once.
 */
export const journalWork = { entries: 0 };

const isRect = (area: ChangeRect | readonly ChangeRect[]): area is ChangeRect => typeof area[0] === 'number';
const overlaps = (r: ChangeRect, a: ChangeRect): boolean => r[0] <= a[2] && r[2] >= a[0] && r[1] <= a[3] && r[3] >= a[1];

/** The rectangle round a set of points, grown by `pad`; null for none. */
export function rectAround(points: Iterable<{ readonly x: number; readonly y: number }>, pad = 0): ChangeRect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return minX <= maxX ? [minX - pad, minY - pad, maxX + pad, maxY + pad] : null;
}

export class ChangeJournal {
  private serial = 0;
  /** Entries after `forgotten`, oldest first, in a ring of `KEPT`. */
  private readonly ring: (Change | undefined)[] = new Array<Change | undefined>(KEPT);
  private count = 0;
  /** The cause given to the document's entries until the next (`causeNext`). */
  private pendingCause = 'edit';
  /** The serial of the latest entry of each kind, kept after the entry itself is forgotten. */
  private readonly lastOf = new Map<ChangeKind, number>();
  /** The entries of each kind (`since` with kinds reads these, never the others'). */
  private readonly byKind = new Map<ChangeKind, KindLog>();
  /** Up to where every kind may be missing entries: a copy starts with none (`continueFrom`). */
  private startedAt = 0;

  /** The serial of the latest entry: what a reader that has seen everything holds. */
  get version(): number {
    return this.serial;
  }

  /**
   * The serial of the latest entry of any of these kinds, 0 when none was
   * written: the document's revisions (`RoadDoc.revision`, `terrainRevision`...)
   * are this, so a change not written in the diary moves no revision and
   * nothing can change without the diary knowing (Nystrom, "Dirty Flag": one
   * narrow way in, where the flag is set).
   */
  serialOf(...kinds: readonly ChangeKind[]): number {
    let latest = 0;
    for (const kind of kinds) latest = Math.max(latest, this.lastOf.get(kind) ?? 0);
    return latest;
  }

  /**
   * Goes on from where `other` stands: its serial and the latest serial of
   * each kind, with none of its entries (a reader asking about them is told
   * `null`, everything changed). A working copy of the document
   * (`RoadDoc.clone`) is at the same revisions as the document it was copied
   * from, so the live network can be taken over as it stands.
   */
  continueFrom(other: ChangeJournal): void {
    this.serial = other.serial;
    this.count = 0;
    this.ring.fill(undefined);
    this.lastOf.clear();
    for (const [kind, serial] of other.lastOf) this.lastOf.set(kind, serial);
    this.byKind.clear();
    this.startedAt = other.serial;
    this.pendingCause = other.pendingCause;
  }

  /** The serial before which entries are no longer kept. */
  get forgotten(): number {
    return Math.max(0, this.serial - this.count);
  }

  /** What the next edits of the document come from (a tool and gesture: "estrada: desenhar"). */
  causeNext(cause: string): void {
    this.pendingCause = cause;
  }

  get cause(): string {
    return this.pendingCause;
  }

  /** Writes an entry; returns its serial. An empty list of rectangles writes nothing (0). */
  record(kind: ChangeKind, rects: readonly ChangeRect[] | null, extra: {
    readonly ids?: readonly number[]; readonly cause?: string; readonly parent?: number; readonly ms?: number; readonly detail?: string;
  } = {}): number {
    if (rects !== null && rects.length === 0) return 0;
    const serial = ++this.serial;
    const entry: Change = {
      serial, kind, rects, cause: extra.cause ?? this.pendingCause, at: performance.now(),
      ...(extra.ids && extra.ids.length ? { ids: extra.ids } : {}),
      ...(extra.parent ? { parent: extra.parent } : {}),
      ...(extra.ms !== undefined ? { ms: extra.ms } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
    };
    this.ring[serial % KEPT] = entry;
    if (this.count < KEPT) this.count++;
    this.lastOf.set(kind, serial);
    let log = this.byKind.get(kind);
    if (!log) this.byKind.set(kind, (log = new KindLog(this.startedAt)));
    log.push(entry);
    return serial;
  }

  /**
   * The entries after `since` (oldest first), of these kinds only when given;
   * `null` if some were forgotten. With kinds, only their own entries are
   * read, and none when none was written since (`serialOf`): the revision a
   * reader holds tells it at once - Salsa's last-changed revision per
   * durability, `runtime.rs` `revisions`. NOT the whole diary walked for a
   * kind that did not move: one building more was one entry more for every
   * reader of the ground.
   */
  since(since: number, kinds?: readonly ChangeKind[]): Change[] | null {
    if (kinds) {
      if (since >= this.serialOf(...kinds)) return [];
      const out: Change[] = [];
      for (const kind of new Set(kinds)) {
        const log = this.byKind.get(kind);
        if (since < (log ? log.missingUpTo : this.startedAt)) return null;
        log?.after(since, out);
      }
      return out.sort((a, b) => a.serial - b.serial);
    }
    if (since < this.forgotten) return null;
    const out: Change[] = [];
    for (let s = since + 1; s <= this.serial; s++) {
      const entry = this.ring[s % KEPT];
      journalWork.entries++;
      if (entry && entry.serial === s) out.push(entry);
    }
    return out;
  }

  /**
   * Whether a change after `since`, of these kinds, reaches `area` (`null`:
   * a reader with nothing on the map). An area may be its items' own
   * rectangles: then only a change reaching one of them counts.
   */
  touches(since: number, area: ChangeArea, kinds?: readonly ChangeKind[]): boolean {
    if (area === null || since >= this.serial) return false;
    const list = isRect(area) ? [area] : area;
    if (list.length === 0) return false;
    const entries = this.since(since, kinds);
    if (entries === null) return true;
    for (const entry of entries) {
      if (entry.rects === null) return true;
      for (const r of entry.rects) for (const a of list) if (overlaps(r, a)) return true;
    }
    return false;
  }

  /** The last `n` entries, newest first. */
  latest(n: number): Change[] {
    const out: Change[] = [];
    for (let s = this.serial; s > this.forgotten && out.length < n; s--) {
      const entry = this.ring[s % KEPT];
      if (entry && entry.serial === s) out.push(entry);
    }
    return out;
  }

  /** An entry by its serial, while it is kept. */
  get(serial: number): Change | undefined {
    const entry = this.ring[serial % KEPT];
    return entry && entry.serial === serial ? entry : undefined;
  }
}

/** Side of a cell of `ChangeSweep`'s filing, world units. */
const SWEEP_CELL = 64; // world units (1 m)
/** A rectangle covering more cells than this is taken as the whole map: the sweep answers "changed" everywhere. */
const SWEEP_MAX_CELLS = 4096;

/**
 * The diary's new entries of some kinds read ONCE for many readers of
 * points (every parked car, every placed thing): `advance` files the
 * rectangles written since the last advance by cell; a reader that had
 * caught up with the last advance asks only the cell of its point.
 *
 * `touches(seen, x, y)` answers as `ChangeJournal.touches(seen, [x, y, x, y],
 * kinds)` does; a reader behind the last advance is answered by the journal
 * itself (once: it is caught up after).
 *
 * DO NOT ask the journal per reader per frame: each asked for every entry
 * since its serial - readers x entries a frame, 30 s of a 2 560 m city's
 * growing (`render/agents.ts` `offRoadDeck`, 2026-10-15), quadratic in the
 * city.
 */
export class ChangeSweep {
  private from = -1;
  private now = -1;
  /** Rectangles by cell; null: a change of the whole map (or one too wide to file). */
  private cells: Map<number, ChangeRect[]> | null = new Map();

  constructor(readonly journal: ChangeJournal, private readonly kinds: readonly ChangeKind[]) {}

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
