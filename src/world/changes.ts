/** THE WORLD'S DIARY OF CHANGES: what changed, where, and why - one record for the whole game */

/** A world rectangle: [minX, minY, maxX, maxY]. */
export type ChangeRect = readonly [number, number, number, number];

/** What the player changes in the document. */
export type DocChangeKind =
  | 'roads' | 'traffic' | 'terrain' | 'paint' | 'buildings' | 'zones' | 'lots' | 'utilities' | 'barriers' | 'landscape'
  | 'transit' | 'people' | 'trees' | 'clearings' | 'elements' | 'fog' | 'clouds' | 'weather' | 'nature' | 'gullies'
  /** The balance (`economy.ts`): an edit paid for, or a demolition paid back. */
  | 'economy'
  /** The land already cut into lots (`LotStore.addKeys`): no lot came or went, so a reader of the lots by id */
  | 'lotKeys'
  /** The regional standard of the road paint (`RoadDoc.markingStyle`) */
  | 'markingStyle'
  /** A building's wear (`Building.decay`: age, soot) and nothing else of it (`BuildingStore.wear`). */
  | 'buildingWear';
/** Every kind of change to the document, listed once (checked complete by the type) */
const DOC_KINDS = {
  roads: 1, traffic: 1, terrain: 1, paint: 1, buildings: 1, zones: 1, lots: 1, utilities: 1, barriers: 1, landscape: 1,
  transit: 1, people: 1, trees: 1, clearings: 1, elements: 1, fog: 1, clouds: 1, weather: 1, nature: 1, gullies: 1, economy: 1,
  lotKeys: 1, markingStyle: 1, buildingWear: 1,
} as const satisfies Record<DocChangeKind, 1>;
export const DOC_CHANGE_KINDS = Object.keys(DOC_KINDS) as DocChangeKind[];
/** What the game works out from it. */
export type DerivedChangeKind = 'elevation' | 'ground' | 'light' | 'surfaces';
export type ChangeKind = DocChangeKind | DerivedChangeKind;

/** The causes of a tile put in or taken out of the page's document (`RoadDoc.loadTile`): its records came or went from the page, not from the world
 *  - what keeps the world (the save, the economy, undo) reads past these entries; what is drawn or simulated of the page follows them as any other. */
export const TILE_LOADED = 'tile loaded';
export const TILE_UNLOADED = 'tile unloaded';
export const isStreaming = (entry: { readonly cause: string }): boolean => entry.cause === TILE_LOADED || entry.cause === TILE_UNLOADED;

export interface Change {
  /** Order of writing; every entry has its own. */
  readonly serial: number;
  readonly kind: ChangeKind;
  /** Where, in world units; `null` the whole map. */
  readonly rects: readonly ChangeRect[] | null;
  /** The ids it touched (segments, nodes, stamps, poles...), when it has them. */
  readonly ids?: readonly number[];
  /** A road entry's ids told apart (`'roads'`, `'traffic'`): within a tile a node and a segment may share an id (both counted from `tileIdBase`). */
  readonly nodes?: readonly number[];
  readonly segments?: readonly number[];
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

/** How many entries are kept, in all and of each kind: a reader older than that takes everything as changed. */
const KEPT = 2048;
/** What the diary holds at least, in rectangles and ids, however little is loaded (`ChangeJournal.cap`). */
const HELD_FLOOR = 65_536;
/** What an entry holds: its rectangles and its ids (a tile's load names every record of the tile). */
const weightOf = (entry: Change): number => 1 + (entry.rects?.length ?? 0) + (entry.ids?.length ?? 0) + (entry.nodes?.length ?? 0) + (entry.segments?.length ?? 0);

/** A reader of some kinds that follows the diary (`ChangeJournal.follow`) */
export interface JournalReader {
  readonly kinds: readonly ChangeKind[];
  /** The serial it has read up to; negative: it has read nothing yet (it reads everything first). */
  readonly seenSerial: number;
}

/** DO NOT let them go by count alone */
class KindLog {
  private entries: Change[] = [];
  /** What its entries hold (`weightOf`). */
  private weight = 0;
  constructor(public missingUpTo: number) {}

  /** `needed`: the oldest serial a reader of this kind has read up to (Infinity: none follows it); `cap`, the most it holds (`ChangeJournal.cap`). */
  push(entry: Change, needed: () => number, cap: number): void {
    this.entries.push(entry);
    this.weight += weightOf(entry);
    // DO NOT hold more than the cap for a reader however far behind: past what is loaded, it reads the document whole for no more (`ChangeJournal.cap`).
    // The newest is never counted against it: one entry larger than the cap (a list at its cap named whole) does not push out the ones just before it.
    // DO NOT cut what a live reader has not read (`needed`): it would take everything as changed, and a reader of the roads then looks at every building (`tests/editor/buildings.spec.ts`).
    const newest = weightOf(entry);
    if (this.weight - newest > cap && this.entries.length > 1) {
      const upTo = needed();
      let cut = 0;
      while (cut < this.entries.length - 1 && this.weight - newest > cap && this.entries[cut]!.serial <= upTo) this.weight -= weightOf(this.entries[cut++]!);
      if (cut) {
        this.missingUpTo = Math.max(this.missingUpTo, this.entries[cut - 1]!.serial);
        this.entries = this.entries.slice(cut);
      }
    }
    // Let go of what no one needs only past twice what is always kept: each entry looked at a constant number of times.
    if (this.entries.length < 2 * KEPT) return;
    const keepFrom = this.entries.length - KEPT;
    const upTo = needed();
    let cut = 0;
    while (cut < keepFrom && this.entries[cut]!.serial <= upTo) cut++;
    if (!cut) return;
    for (let i = 0; i < cut; i++) this.weight -= weightOf(this.entries[i]!);
    this.missingUpTo = Math.max(this.missingUpTo, this.entries[cut - 1]!.serial);
    this.entries = this.entries.slice(cut);
  }

  /** Whether an entry after `since` reaches one of `list` (a whole-map entry reaches all), newest first; each one looked at counted. */
  reachesAfter(since: number, list: readonly ChangeRect[]): boolean {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      journalWork.entries++;
      if (entry.serial <= since) return false;
      if (entry.rects === null) return true;
      for (const r of entry.rects) for (const a of list) if (overlaps(r, a)) return true;
    }
    return false;
  }

  /** Its entries after `since`, newest first, into `out`; each one looked at counted. */
  after(since: number, out: Change[]): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      journalWork.entries++;
      if (entry.serial <= since) return;
      out.push(entry);
    }
  }
}

/** The work of the diary's readers: entries looked at to answer `since` and `touches`. */
export const journalWork = { entries: 0 };

const isRect = (area: ChangeRect | readonly ChangeRect[]): area is ChangeRect => typeof area[0] === 'number';
const overlaps = (r: ChangeRect, a: ChangeRect): boolean => r[0] <= a[2] && r[2] >= a[0] && r[1] <= a[3] && r[3] >= a[1];

/** The rectangle round a set of points, grown by `pad`; null for none. */
/** One rectangle round some rectangles. */
export function rectsAround(rects: readonly ChangeRect[]): ChangeRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[2]); y1 = Math.max(y1, r[3]); }
  return [x0, y0, x1, y1];
}

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
  /** The readers that follow this diary (`follow`), held weakly: one gone needs nothing kept. */
  private readers: WeakRef<JournalReader>[] = [];

  /** A reader follows this diary: what it has not read of its kinds is kept until it reads it. */
  follow(reader: JournalReader): void {
    if (!this.readers.some((r) => r.deref() === reader)) this.readers.push(new WeakRef(reader));
  }

  /** The oldest serial a live reader of `kind` has read up to (Infinity: none follows it). */
  private neededFor(kind: ChangeKind): number {
    let upTo = Infinity;
    const live: WeakRef<JournalReader>[] = [];
    for (const ref of this.readers) {
      const reader = ref.deref();
      if (!reader) continue;
      live.push(ref);
      if (reader.seenSerial >= 0 && reader.kinds.includes(kind)) upTo = Math.min(upTo, reader.seenSerial);
    }
    this.readers = live;
    return upTo;
  }
  /** Entries after `forgotten`, oldest first, in a ring of `KEPT`. */
  private readonly ring: (Change | undefined)[] = new Array<Change | undefined>(KEPT);
  private count = 0;
  /** What the ring's entries hold (`weightOf`). */
  private ringWeight = 0;
  /** What the tiles loaded and not let go brought (`weightOf` of their streaming entries): what the document holds, as the diary sees it. */
  private loaded = 0;
  /** The cause given to the document's entries until the next (`causeNext`). */
  private pendingCause = 'edit';
  /** The serial of the latest entry of each kind, kept after the entry itself is forgotten. */
  private readonly lastOf = new Map<ChangeKind, number>();
  /** The entries of each kind (`since` with kinds reads these, never the others'). */
  private readonly byKind = new Map<ChangeKind, KindLog>();
  /** Up to where every kind may be missing entries: a copy starts with none (`continueFrom`). */
  private startedAt = 0;
  /** Every entry written since this diary went on from another as a working copy's (`forkFrom`), all of them, in order */
  private written: Change[] | null = null;

  /** The serial of the latest entry: what a reader that has seen everything holds. */
  get version(): number {
    return this.serial;
  }

  /** The serial of the latest entry of any of these kinds, 0 when none was written: the document's revisions */
  serialOf(...kinds: readonly ChangeKind[]): number {
    let latest = 0;
    for (const kind of kinds) latest = Math.max(latest, this.lastOf.get(kind) ?? 0);
    return latest;
  }

  /** Goes on from where `other` stands: its serial and the latest serial of each kind, with none of its entries */
  continueFrom(other: ChangeJournal): void {
    this.serial = other.serial;
    this.count = 0;
    this.ringWeight = 0;
    this.loaded = 0;
    this.ring.fill(undefined);
    this.lastOf.clear();
    for (const [kind, serial] of other.lastOf) this.lastOf.set(kind, serial);
    this.byKind.clear();
    this.startedAt = other.serial;
    this.pendingCause = other.pendingCause;
    this.written = null;
  }

  /** Goes on from `other` as a working copy's diary (`RoadDoc.fork`) */
  forkFrom(other: ChangeJournal): void {
    this.continueFrom(other);
    this.written = [];
  }

  /** Writes a working copy's entries into this diary, which stands where the copy's started */
  take(from: ChangeJournal): void {
    const entries = from.written;
    if (!entries) throw new Error('ChangeJournal.take: not a working copy\'s diary');
    if (from.startedAt !== this.serial) throw new Error(`ChangeJournal.take: the copy started at ${from.startedAt}, this diary stands at ${this.serial}`);
    for (const entry of entries) {
      if (entry.serial !== this.serial + 1) throw new Error(`ChangeJournal.take: entry ${entry.serial} after ${this.serial}`);
      this.serial = entry.serial;
      this.write(entry);
    }
    this.pendingCause = from.pendingCause;
  }

  /** The most the ring and each kind's log hold: twice what is loaded (a whole region let go and another taken in), and never less than `HELD_FLOOR`. */
  private get cap(): number {
    return Math.max(HELD_FLOOR, 2 * this.loaded);
  }

  /** The serial before which entries are no longer kept. */
  get forgotten(): number {
    return Math.max(0, this.serial - this.count);
  }

  /** What the next edits of the document come from (a tool and gesture: "tool road: draw"). */
  causeNext(cause: string): void {
    this.pendingCause = cause;
  }

  get cause(): string {
    return this.pendingCause;
  }

  /** Writes an entry; returns its serial. An empty list of rectangles writes nothing (0). */
  record(kind: ChangeKind, rects: readonly ChangeRect[] | null, extra: {
    readonly ids?: readonly number[]; readonly nodes?: readonly number[]; readonly segments?: readonly number[];
    readonly cause?: string; readonly parent?: number; readonly ms?: number; readonly detail?: string;
  } = {}): number {
    if (rects !== null && rects.length === 0) return 0;
    const serial = ++this.serial;
    const entry: Change = {
      serial, kind, rects, cause: extra.cause ?? this.pendingCause, at: performance.now(),
      ...(extra.ids && extra.ids.length ? { ids: extra.ids } : {}),
      ...(extra.nodes ? { nodes: extra.nodes } : {}),
      ...(extra.segments ? { segments: extra.segments } : {}),
      ...(extra.parent ? { parent: extra.parent } : {}),
      ...(extra.ms !== undefined ? { ms: extra.ms } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
    };
    this.write(entry);
    return serial;
  }

  /** An entry whose serial is this diary's latest, put in the ring, its kind's log and a copy's list. */
  private write(entry: Change): void {
    const { serial, kind } = entry;
    const weight = weightOf(entry);
    if (entry.cause === TILE_LOADED) this.loaded += weight;
    else if (entry.cause === TILE_UNLOADED) this.loaded = Math.max(0, this.loaded - weight);
    const over = this.ring[serial % KEPT];
    if (over && this.count >= KEPT) this.ringWeight -= weightOf(over);
    this.ring[serial % KEPT] = entry;
    this.ringWeight += weight;
    if (this.count < KEPT) this.count++;
    // DO NOT hold every tile the camera passed (a heap snapshot of the simulation's worker over 22 tiles walked, 2026-10-17: ~0.3 MB a tile in the ring and the kinds' logs): the oldest let go past the cap, a reader that far behind reads the document whole for no more.
    const cap = this.cap;
    while (this.count > 1 && this.ringWeight - weight > cap) {
      const at = (serial - this.count + 1) % KEPT, old = this.ring[at];
      if (old) this.ringWeight -= weightOf(old);
      this.ring[at] = undefined;
      this.count--;
    }
    this.lastOf.set(kind, serial);
    let log = this.byKind.get(kind);
    if (!log) this.byKind.set(kind, (log = new KindLog(this.startedAt)));
    log.push(entry, () => this.neededFor(kind), cap);
    this.written?.push(entry);
  }

  /** The entries after `since` (oldest first), of these kinds only when given; `null` if some were forgotten. */
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

  /** Whether a change after `since`, of these kinds, reaches `area` (`null`: a reader with nothing on the map). */
  touches(since: number, area: ChangeArea, kinds?: readonly ChangeKind[]): boolean {
    if (area === null || since >= this.serial) return false;
    const list = isRect(area) ? [area] : area;
    if (list.length === 0) return false;
    if (kinds) {
      // DO NOT go through `since` here: a building's plants asking "did the ground move under me" made and sorted every entry
      if (since >= this.serialOf(...kinds)) return false;
      for (const kind of kinds) {
        const log = this.byKind.get(kind);
        if (since < (log ? log.missingUpTo : this.startedAt)) return true;
        if (log?.reachesAfter(since, list)) return true;
      }
      return false;
    }
    const entries = this.since(since);
    if (entries === null) return true;
    for (const entry of entries) {
      if (entry.rects === null) return true;
      for (const r of entry.rects) for (const a of list) if (overlaps(r, a)) return true;
    }
    return false;
  }

  /** The ids the entries of these kinds after `since` carry, each once; null when it cannot say */
  idsSince(since: number, kinds: readonly ChangeKind[]): Set<number> | null {
    const entries = this.since(since, kinds);
    if (!entries) return null;
    const ids = new Set<number>();
    for (const entry of entries) {
      if (!entry.ids) return null;
      for (const id of entry.ids) ids.add(id);
    }
    return ids;
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
