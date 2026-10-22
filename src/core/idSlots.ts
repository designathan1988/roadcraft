/** DENSE SLOTS FOR SPARSE NUMERIC IDS, ON TYPED ARRAYS: an id's slot found by open addressing (linear probing over a power-of-two table, deleted keys tombstoned), its data kept in the caller's columns at that slot. No JS object or `Map` entry an id: ~20 bytes of array an id, outside the JS heap (report "Arquitetura para cidades grandes", "colunas binárias"). */

const EMPTY = 0, FULL = 1, GONE = 2;
/** The table is grown past this share of it in use (full and tombstoned): probes stay short. */
const MOST_LOAD = 0.6;

/** Mixes an id's bits for the probe's start (ids may be any finite number: a tile's range, a table's row ids). */
function hashOf(id: number): number {
  let h = (id | 0) ^ Math.imul((id / 0x1_0000_0000) | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export class IdSlots {
  private keys: Float64Array;
  private values: Int32Array;
  private states: Uint8Array;
  private used = 0;
  private live = 0;
  /** The slots handed back (`delete`), taken again first; `next` the first never handed out. */
  private free: Int32Array = new Int32Array(16);
  private freeCount = 0;
  private next = 0;
  /** Told the slots now needed (`capacity`) whenever it grows: the caller grows its columns to it. */
  onGrow: ((capacity: number) => void) | null = null;
  private capacityNow = 0;

  constructor(expected = 64) {
    let size = 16;
    while (size * MOST_LOAD < expected) size *= 2;
    this.keys = new Float64Array(size);
    this.values = new Int32Array(size);
    this.states = new Uint8Array(size);
  }

  /** How many ids hold a slot. */
  get size(): number {
    return this.live;
  }

  /** The slots the columns must hold: every slot handed out so far fits under it. */
  get capacity(): number {
    return this.capacityNow;
  }

  /** The slot of an id; -1 when it has none. */
  get(id: number): number {
    const keys = this.keys, states = this.states, mask = keys.length - 1;
    for (let i = hashOf(id) & mask; ; i = (i + 1) & mask) {
      const state = states[i]!;
      if (state === EMPTY) return -1;
      if (state === FULL && keys[i] === id) return this.values[i]!;
    }
  }

  /** The slot of an id, handed one when it had none. */
  take(id: number): number {
    const known = this.get(id);
    if (known >= 0) return known;
    if ((this.used + 1) > this.keys.length * MOST_LOAD) this.rehash(this.live + 1 > this.keys.length * MOST_LOAD * 0.5 ? this.keys.length * 2 : this.keys.length);
    const slot = this.freeCount > 0 ? this.free[--this.freeCount]! : this.next++;
    if (slot >= this.capacityNow) {
      let capacity = Math.max(16, this.capacityNow);
      while (capacity <= slot) capacity *= 2;
      this.capacityNow = capacity;
      this.onGrow?.(capacity);
    }
    this.place(id, slot);
    this.live++;
    return slot;
  }

  /** The id's slot handed back (its columns are the caller's to clear); false when it had none. */
  delete(id: number): boolean {
    const keys = this.keys, states = this.states, mask = keys.length - 1;
    for (let i = hashOf(id) & mask; ; i = (i + 1) & mask) {
      const state = states[i]!;
      if (state === EMPTY) return false;
      if (state === FULL && keys[i] === id) {
        states[i] = GONE;
        this.live--;
        if (this.freeCount === this.free.length) { const grown = new Int32Array(this.free.length * 2); grown.set(this.free); this.free = grown; }
        this.free[this.freeCount++] = this.values[i]!;
        return true;
      }
    }
  }

  /** Every id with its slot. */
  forEach(visit: (id: number, slot: number) => void): void {
    const keys = this.keys, states = this.states, values = this.values;
    for (let i = 0; i < keys.length; i++) if (states[i] === FULL) visit(keys[i]!, values[i]!);
  }

  /** Every id let go; the columns' capacity kept. */
  clear(): void {
    this.states.fill(EMPTY);
    this.used = 0;
    this.live = 0;
    this.freeCount = 0;
    this.next = 0;
  }

  private place(id: number, slot: number): void {
    const keys = this.keys, states = this.states, mask = keys.length - 1;
    let i = hashOf(id) & mask;
    while (states[i] === FULL) i = (i + 1) & mask;
    if (states[i] === EMPTY) this.used++;
    keys[i] = id;
    this.values[i] = slot;
    states[i] = FULL;
  }

  /** The table laid again at `size`, its tombstones dropped. */
  private rehash(size: number): void {
    const keys = this.keys, values = this.values, states = this.states;
    this.keys = new Float64Array(size);
    this.values = new Int32Array(size);
    this.states = new Uint8Array(size);
    this.used = 0;
    for (let i = 0; i < keys.length; i++) if (states[i] === FULL) this.place(keys[i]!, values[i]!);
  }
}

/** A column grown to `capacity`, its values kept. */
export function grown<T extends Float64Array | Float32Array | Int32Array | Uint8Array>(column: T, capacity: number): T {
  if (column.length >= capacity) return column;
  const out = new (column.constructor as new (n: number) => T)(capacity);
  out.set(column);
  return out;
}
