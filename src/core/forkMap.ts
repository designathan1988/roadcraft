/**
 * A COPY-ON-WRITE MAP OVER ANOTHER: a working copy of a keyed collection that
 * costs what it writes, not what it holds. Reads fall through to the map
 * below; writes stay in the fork; the map below is never written by it. One
 * level of what persistent maps do (Bagwell, "Ideal Hash Trees": a version
 * shares every entry it did not change with the one it came from).
 *
 * It reads exactly as a `Map` copied from the one below and then given the
 * same writes would (MDN, `Map`: iteration in insertion order; `set` on a key
 * held keeps its place; a key deleted and set again goes last; a new key goes
 * last): the keys below in their order, each with the fork's value where it
 * wrote one, then the keys added, in their order.
 *
 * VALUES ARE SHARED. A value read from the fork is the one below until the
 * fork writes that key: whoever changes a value in place takes its own copy
 * first (`writable`). The map below must not change while the fork is read
 * (a working copy is made, edited and taken back or dropped within one edit).
 *
 * `applyTo` writes what the fork changed into a map that holds what the one
 * below held, so that it then reads as the fork does: what was deleted, what
 * was replaced (in place), what was added (last, in order).
 */
export class ForkMap<K, V> implements Map<K, V> {
  /** Keys of the map below given another value; still at their place. */
  private readonly replaced = new Map<K, V>();
  /** Keys after those below: new ones, and those below deleted and set again. */
  private readonly added = new Map<K, V>();
  /** Keys below deleted (those set again are in `added` too). */
  private readonly gone = new Set<K>();

  constructor(private readonly below: ReadonlyMap<K, V>) {}

  get [Symbol.toStringTag](): string {
    return 'Map';
  }

  get size(): number {
    return this.below.size - this.gone.size + this.added.size;
  }

  get(key: K): V | undefined {
    if (this.added.has(key)) return this.added.get(key);
    if (this.gone.has(key)) return undefined;
    if (this.replaced.has(key)) return this.replaced.get(key);
    return this.below.get(key);
  }

  has(key: K): boolean {
    return this.added.has(key) || (!this.gone.has(key) && this.below.has(key));
  }

  /** Whether the fork holds this key's value itself (written here), not the one below. */
  owns(key: K): boolean {
    return this.added.has(key) || this.replaced.has(key);
  }

  /**
   * The value of `key` to change in place: the fork's own, or the one below
   * copied (`copy`) and set here first. Undefined when there is none.
   */
  writable(key: K, copy: (value: V) => V): V | undefined {
    if (this.added.has(key)) return this.added.get(key);
    if (this.replaced.has(key)) return this.replaced.get(key);
    if (this.gone.has(key)) return undefined;
    const value = this.below.get(key);
    if (value === undefined) return undefined;
    const own = copy(value);
    forkWork.copied++;
    this.replaced.set(key, own);
    return own;
  }

  set(key: K, value: V): this {
    if (this.added.has(key) || this.gone.has(key) || !this.below.has(key)) this.added.set(key, value);
    else this.replaced.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    if (this.added.delete(key)) return true;
    if (this.gone.has(key) || !this.below.has(key)) return false;
    this.replaced.delete(key);
    this.gone.add(key);
    return true;
  }

  /**
   * Every key gone. DO NOT call it on a working copy for an edit: it marks
   * every key below (what a whole replacement does, `RoadDoc.replaceContents`).
   */
  clear(): void {
    this.replaced.clear();
    this.added.clear();
    for (const key of this.below.keys()) this.gone.add(key);
  }

  *entries(): MapIterator<[K, V]> {
    for (const [key, value] of this.below) {
      if (this.gone.has(key)) continue;
      yield [key, this.replaced.has(key) ? this.replaced.get(key)! : value];
    }
    yield* this.added.entries();
  }

  *keys(): MapIterator<K> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  forEach(visit: (value: V, key: K, map: Map<K, V>) => void, self?: unknown): void {
    for (const [key, value] of this.entries()) visit.call(self, value, key, this);
  }

  /** What the fork wrote, in the order `applyTo` takes it: deleted keys, replaced values, added values. */
  changes(): { readonly gone: ReadonlySet<K>; readonly replaced: ReadonlyMap<K, V>; readonly added: ReadonlyMap<K, V> } {
    return { gone: this.gone, replaced: this.replaced, added: this.added };
  }

  /**
   * Writes the fork's changes into `target`, a map holding what the map below
   * held (the map below itself, or its owner's writers): afterwards it reads
   * as the fork does, order included. `put`/`drop` default to the map's own.
   */
  applyTo(target: { set(key: K, value: V): unknown; delete(key: K): unknown },
    put: (key: K, value: V) => void = (key, value) => { target.set(key, value); },
    drop: (key: K) => void = (key) => { target.delete(key); }): void {
    for (const key of this.gone) drop(key);
    for (const [key, value] of this.replaced) put(key, value);
    for (const [key, value] of this.added) put(key, value);
  }
}

/**
 * The work of the working copies (`ForkMap.writable`, and the lists and
 * indices a document's fork copies when it writes them): records copied. A
 * count, not a time (`tests/world/docFork.spec.ts`): an edit's copy that
 * copies the map shows at once.
 */
export const forkWork = { copied: 0 };
