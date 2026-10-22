/** THE BUILDINGS' RECORDS SHARE WHAT THEY HAVE ALIKE (hash-consing): one storey, facade or material object for every building */

/** A record's member made of plain data (numbers, strings, booleans, null, arrays and objects of those). */
type Plain = Record<string, unknown> | unknown[];

/** Each canonical object's number: what a parent's key is made of (its children are canonical, so equal means the same object). */
const ids = new WeakMap<object, number>();
let nextId = 1;
/** The canonical objects by their shallow key's hash; held weakly, a shape no building uses any more goes. */
const table = new Map<number, WeakRef<Plain>[]>();

/** A canonical object collected: its entry let go, and its hash's bucket with it once empty. */
function letGoInterned(h: number, ref: WeakRef<object>): void {
  const bucket = table.get(h);
  if (!bucket) return;
  const at = bucket.indexOf(ref as WeakRef<Plain>);
  if (at >= 0) bucket.splice(at, 1);
  if (bucket.length === 0) table.delete(h);
}

/** DO NOT keep the entry of an object collected (its WeakRef, its bucket, its hash's key): a bucket was only swept when its own hash came again, so every thread that read buildings (the page, each job worker, the simulation) kept an entry for every shape it ever read - ~39,000 a dense tile - in the one V8 heap the page and its workers share (`jobs/jobPool.ts` CAGE_BYTES), and the page died at ~7.5 GB moving round the city (conferencia conf7-conf9, 2026-10-17). Let go when the collector takes the object (MDN, FinalizationRegistry). */
const collected = new FinalizationRegistry<{ readonly h: number; readonly ref: WeakRef<Plain> }>(({ h, ref }) => letGoInterned(h, ref));

/** Entries of the table now, and hashes: what the tests read. */
export function internedEntries(): { readonly entries: number; readonly hashes: number } {
  let entries = 0;
  for (const bucket of table.values()) entries += bucket.length;
  return { entries, hashes: table.size };
}

/** Inside the hash: 32-bit FNV-1a over the key's pieces. */
function mix(h: number, n: number): number {
  return Math.imul(h ^ n, 16777619) >>> 0;
}

function hashString(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i));
  return mix(h, 0x1f);
}

/** A number's bits, to hash it without making its text (DO NOT `String(v)`: a string for every number of every building loaded). */
const BITS = new Float64Array(1);
const WORDS = new Uint32Array(BITS.buffer);

function hashValue(h: number, v: unknown): number {
  if (v === null) return mix(h, 1);
  switch (typeof v) {
    case 'number': BITS[0] = v; return mix(mix(mix(h, 2), WORDS[0]!), WORDS[1]!);
    case 'string': return hashString(mix(h, 3), v);
    case 'boolean': return mix(h, v ? 4 : 5);
    case 'object': return mix(mix(h, 6), ids.get(v as object) ?? 0);
    default: return mix(h, 7);
  }
}

/** Whether two nodes with canonical children are the same: their primitives equal, their children the same objects. */
function sameShallow(a: Plain, b: Plain): boolean {
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== bb[i]) return false;
    return true;
  }
  const ka = Object.keys(a), bo = b as Record<string, unknown>;
  if (ka.length !== Object.keys(bo).length) return false;
  for (const k of ka) if (!(k in bo) || a[k] !== bo[k]) return false;
  return true;
}

/** The canonical object equal to `value` (its children made canonical first): the one already shared, or `value` itself. */
export function intern<T>(value: T): T {
  if (typeof value !== 'object' || value === null || ids.has(value)) return value;
  const node = value as unknown as Plain;
  let h = Array.isArray(node) ? 0x811c9dc5 : 0x01000193;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i];
      if (typeof item === 'object' && item !== null) node[i] = intern(item);
      h = hashValue(h, node[i]);
    }
  } else {
    for (const key of Object.keys(node)) {
      const item = node[key];
      if (typeof item === 'object' && item !== null) node[key] = intern(item);
      h = hashValue(hashString(h, key), node[key]);
    }
  }
  let bucket = table.get(h);
  if (bucket) {
    for (let i = bucket.length - 1; i >= 0; i--) {
      const known = bucket[i]!.deref();
      if (!known) { bucket.splice(i, 1); continue; }
      if (sameShallow(known, node)) return known as unknown as T;
    }
  } else table.set(h, bucket = []);
  const ref = new WeakRef(node);
  bucket.push(ref);
  collected.register(node, { h, ref });
  ids.set(node, nextId++);
  // DO NOT write a shared object in place: every building sharing it would change (records are replaced, never edited).
  Object.freeze(node);
  return value;
}

/**
 * RECORDS' MEMBERS SHARED AMONG THEM, A BATCH AT A TIME, in place (hash-consing as `intern`, with tables of its own): what records written
 * to a table have alike written once (`recordTable.ts` TableWriter, a member reached twice is one node). DO NOT `intern` records a long
 * synchronous job writes and lets go (a city grown off the page, `editor/preparedCity.ts`): each canonical object gets a `WeakRef`, and a
 * `WeakRef`'s target is held until the job's task ends (ECMA-262 AddToKeptObjects) - every member of every building grown stayed alive
 * for the whole generation. Its objects are not frozen: the records are written once and let go.
 * After each batch only the members met more than once are kept
 * in that batch (a material, a storey, a facade), the next batch's equal members made those very objects - a table written a batch at a
 * time with its shared nodes kept (`TableWriter` keepShared) writes each of them once while it is met. DO NOT keep every member met: a
 * building's own volumes and elements are met once, and keeping them is keeping every record.
 */
export class SharedMembers {
  private ids = new Map<object, number>();
  private buckets = new Map<number, Plain[]>();
  private next = 1;
  private readonly keyCodes = new Map<string, number>();

  /** The members met twice in the batch so far (`end`). */
  private hits = new Set<Plain>();

  /** The records' members made canonical, in place, against those kept and each other. Several lists may make one batch (a city's records, then the same migrated, `editor/smallCityMap.ts`): the members of the first met again in the next one are found by identity, never hashed again. */
  share(records: readonly object[]): void {
    this.callStart = this.next;
    for (const record of records) this.shareRecord(record as Record<string, unknown>, this.hits);
  }

  /** The first id of this batch, and of this call (`share`): a member of an earlier call of the batch met again by identity is the same member read through another list (the migrated record), not one shared - DO NOT count it met twice: every member of the batch was kept, and the next batch walked them all. */
  private batchStart = 1;
  private callStart = 1;

  /** The batch over: the members met twice in it kept for the next (`keeps`), the others let go. */
  end(): void {
    const hits = this.hits;
    this.hits = new Set();
    // Only the members met twice (and their members, which their hashes are made of) stay known.
    const kept = new Map<object, number>(), buckets = new Map<number, Plain[]>();
    const keep = (node: Plain, h: number): void => {
      if (kept.has(node)) return;
      kept.set(node, this.ids.get(node)!);
      let bucket = buckets.get(h);
      if (!bucket) buckets.set(h, bucket = []);
      bucket.push(node);
    };
    // DO NOT keep what an earlier batch met twice and this one never: kept for good, they grew with the city (56 MB of the city of 25,000 buildings, 2026-10-22).
    for (const [h, bucket] of this.buckets) {
      for (const node of bucket) if (hits.has(node)) { keep(node, h); this.keepChildren(node, keep); }
    }
    this.ids = kept;
    this.buckets = buckets;
    this.batchStart = this.next;
  }

  /** Whether meeting `node` again now means it is shared: one kept from an earlier batch, or one of this list (`batchStart`, `callStart`). */
  private sharedAgain(node: Plain): boolean {
    const id = this.ids.get(node)!;
    return id < this.batchStart || id >= this.callStart;
  }

  /** Whether a member is kept for the next batch (`share`). */
  keeps(node: object): boolean {
    return this.ids.has(node);
  }

  /** Each node's hash, for the children of a node kept. */
  private readonly hashes = new WeakMap<object, number>();

  private keepChildren(node: Plain, keep: (node: Plain, h: number) => void): void {
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      if (typeof child !== 'object' || child === null) continue;
      const h = this.hashes.get(child);
      if (h === undefined) continue;
      keep(child as Plain, h);
      this.keepChildren(child as Plain, keep);
    }
  }

  private shareRecord(r: Record<string, unknown>, hits: Set<Plain>): void {
    for (const key of Object.keys(r)) {
      const value = r[key];
      if (typeof value === 'object' && value !== null) r[key] = this.canon(value as Plain, hits);
    }
  }

  private local(h: number, v: unknown): number {
    if (typeof v === 'string') return mix(mix(h, 3), this.code(v));
    return typeof v === 'object' && v !== null ? mix(mix(h, 6), this.ids.get(v) ?? 0) : hashValue(h, v);
  }

  /** A key's or a text's number, not its characters hashed again at every member (a few hundred texts, met millions of times). */
  private code(text: string): number {
    let code = this.keyCodes.get(text);
    if (code === undefined) this.keyCodes.set(text, code = this.keyCodes.size + 1);
    return code;
  }

  private canon(node: Plain, hits: Set<Plain>): Plain {
    // Met again (kept from the batch before, or reached twice in this list): shared.
    if (this.ids.has(node)) {
      if (this.sharedAgain(node)) hits.add(node);
      return node;
    }
    // One shared already (`intern`, frozen): its own canonical here, never written.
    if (Object.isFrozen(node)) { this.ids.set(node, this.next++); return node; }
    let h = Array.isArray(node) ? 0x811c9dc5 : 0x01000193;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        if (typeof item === 'object' && item !== null) node[i] = this.canon(item as Plain, hits);
        h = this.local(h, node[i]);
      }
    } else {
      for (const key of Object.keys(node)) {
        const item = node[key];
        if (typeof item === 'object' && item !== null) node[key] = this.canon(item as Plain, hits);
        h = this.local(mix(h, this.code(key)), node[key]);
      }
    }
    let bucket = this.buckets.get(h);
    if (bucket) {
      for (const known of bucket) if (sameShallow(known, node)) { if (this.sharedAgain(known)) hits.add(known); return known; }
    } else this.buckets.set(h, bucket = []);
    bucket.push(node);
    this.ids.set(node, this.next++);
    this.hashes.set(node, h);
    return node;
  }
}

/** A record's object members made canonical, in place (the record itself stays its own: its id, place and wear). */
export function internMembers(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value === 'object' && value !== null) record[key] = intern(value);
  }
}
