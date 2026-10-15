/** A MAP THAT TELLS ITS WRITES: each key's value before a set or a delete, while someone listens (an edit being recorded). */
export class RecordMap<K, V> extends Map<K, V> {
  /** Told a key's value before it is written (undefined: the key was not there); null: nobody listens. */
  before: ((key: K, was: V | undefined) => void) | null = null;

  override set(key: K, value: V): this {
    // During `super()` with entries the field is not set yet: nothing listens then.
    this.before?.(key, super.get(key));
    return super.set(key, value);
  }

  override delete(key: K): boolean {
    if (this.before && super.has(key)) this.before(key, super.get(key));
    return super.delete(key);
  }

  override clear(): void {
    if (this.before) for (const [key, value] of super.entries()) this.before(key, value);
    super.clear();
  }
}
