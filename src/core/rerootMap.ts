/** A PERSISTENT MAP BY REROOTING: every version stays readable as it was, a new version costs what it writes. */
// Baker's persistent arrays with rerooting ("shallow binding"; Conchon & Filliatre, "A Persistent Union-Find Data Structure", 2007)

/** A key absent from a version (a diff's entry). */
const GONE: unique symbol = Symbol('gone');
type Slot<V> = V | typeof GONE;

/** One version of a map: the root holds the values; any other holds its differences from the version it points to. */
export class RerootMap<K, V> {
  /** Root: the values (never `GONE`). Otherwise: this version's value of each key where it differs from `up`'s. */
  private data: Map<K, Slot<V>> = new Map();
  /** The version this one is read through; null for the root. */
  private up: RerootMap<K, V> | null = null;
  /** While this version is being written: the version it was derived from, told of each key before its first write. */
  private prev: RerootMap<K, V> | null = null;
  private sealed = false;

  /** `V` must not be `undefined`: an absent key reads as undefined. */
  get(key: K): V | undefined {
    let at: RerootMap<K, V> = this;
    while (at.up) {
      const value = at.data.get(key);
      if (value !== undefined) return value === GONE ? undefined : value;
      at = at.up;
    }
    return at.data.get(key) as V | undefined;
  }

  /** A new version holding this one's values, to be written; this one keeps its values (read through the new one). */
  derive(): RerootMap<K, V> {
    if (!this.sealed) throw new Error('RerootMap: a version is derived from once it is sealed');
    this.reroot();
    const next = new RerootMap<K, V>();
    next.data = this.data;
    next.prev = this;
    this.data = new Map();
    this.up = next;
    return next;
  }

  set(key: K, value: V): void {
    this.note(key);
    this.data.set(key, value);
  }

  delete(key: K): void {
    if (!this.writable().data.has(key)) return;
    this.note(key);
    this.data.delete(key);
  }

  /** No more writes: the version is what it holds now, and others may be derived from it. */
  seal(): void {
    this.sealed = true;
    this.prev = null;
  }

  /** Every entry of this version, in no particular order: O(map), for whole-map readers only. */
  *entries(): IterableIterator<[K, V]> {
    const seen = new Set<K>();
    let at: RerootMap<K, V> = this;
    for (; at.up; at = at.up) {
      for (const [key, value] of at.data) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (value !== GONE) yield [key, value];
      }
    }
    for (const [key, value] of at.data) if (!seen.has(key)) yield [key, value as V];
  }

  private writable(): this {
    if (this.up || this.sealed) throw new Error('RerootMap: only a version being made may be written');
    return this;
  }

  /** The version derived from keeps the key's value before this version's first write of it. */
  private note(key: K): void {
    const prev = this.writable().prev;
    if (!prev || prev.data.has(key)) return;
    const value = this.data.get(key);
    prev.data.set(key, value === undefined ? GONE : value);
  }

  /** Makes this version the root, reversing the differences on the way to it; every version keeps its values. */
  private reroot(): void {
    if (!this.up) return;
    const path: RerootMap<K, V>[] = [];
    for (let at: RerootMap<K, V> = this; at.up; at = at.up) path.push(at);
    for (let i = path.length - 1; i >= 0; i--) {
      const layer = path[i]!, root = layer.up!;
      const back = new Map<K, Slot<V>>();
      for (const [key, value] of layer.data) {
        const now = root.data.get(key);
        back.set(key, now === undefined ? GONE : now);
        if (value === GONE) root.data.delete(key); else root.data.set(key, value);
      }
      layer.data = root.data;
      layer.up = null;
      root.data = back;
      root.up = layer;
    }
  }
}
