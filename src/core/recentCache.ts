/**
 * THE MOST RECENTLY ASKED VALUES, A BOUNDED NUMBER OF THEM: what is made again from what its owner keeps (a junction's outer levels,
 * a road's rings) held while it is asked, the longest unasked let go past `capacity` (a Map's insertion order is its age: MDN "Map",
 * "iteration happens in insertion order"). DO NOT keep in one anything that cannot be made again, the same, from its key alone.
 */
export class RecentCache<K, V> {
  private readonly held = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  /** The value of `key`: the one held, moved to the newest, or made by `make` and held. */
  get(key: K, make: (key: K) => V): V {
    const held = this.held;
    const known = held.get(key);
    if (known !== undefined) {
      held.delete(key);
      held.set(key, known);
      return known;
    }
    const value = make(key);
    held.set(key, value);
    if (held.size > this.capacity) held.delete(held.keys().next().value as K);
    return value;
  }

  /** How many values are held. */
  get size(): number {
    return this.held.size;
  }

  clear(): void {
    this.held.clear();
  }
}
