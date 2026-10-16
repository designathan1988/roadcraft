/** THE MESO'S TABLES BY SLOT: a block arena, an index by number, and lists threaded through the slots, all in typed arrays (no object, Map entry or Set a link) */
// Data-oriented layout (structure of arrays indexed by a dense slot, free lists for slots let go), as Unity DOTS / Unreal Mass keep their entities.

/** A typed array of `n` with `a`'s values first, the rest `fill`. */
export function grown<T extends Float64Array | Float32Array | Int32Array | Uint8Array>(a: T, n: number, fill = 0): T {
  const b = new (a.constructor as unknown as new (n: number) => T)(n);
  b.set(a);
  if (fill !== 0) b.fill(fill, a.length);
  return b;
}

/** A block's room for `n` numbers: exact up to 16, then 8 classes an octave (at most 1/8 left unused). */
function roomFor(n: number): number {
  if (n <= 16) return Math.max(1, n);
  const step = 2 ** (Math.floor(Math.log2(n)) - 3);
  return Math.ceil(n / step) * step;
}

/** Blocks of doubles in one Float64Array, those given back taken again by their size class. DO NOT keep `data` across an `alloc`: it may grow. */
export class BlockArena {
  data = new Float64Array(1024);
  private top = 0;
  private readonly free = new Map<number, number[]>();

  /** The start of a block of `n` (its numbers as left by its last holder). */
  alloc(n: number): number {
    const room = roomFor(n);
    const list = this.free.get(room);
    if (list?.length) return list.pop()!;
    if (this.top + room > this.data.length) this.data = grown(this.data, Math.max(this.top + room, this.data.length * 2));
    const at = this.top;
    this.top += room;
    return at;
  }

  /** The block at `at` of `n` given back. */
  release(at: number, n: number): void {
    const room = roomFor(n);
    let list = this.free.get(room);
    if (!list) this.free.set(room, list = []);
    list.push(at);
  }

  /** Bytes it holds (taken and free). */
  get bytes(): number {
    return this.data.byteLength;
  }
}

/** Number keys (a link's id passes 2^31) to slots, open addressing with linear probing (no boxed key, no entry object). */
export class SlotIndex {
  private keys = new Float64Array(64);
  private vals = new Int32Array(64);
  /** 0 empty, 1 held, 2 a key taken out (kept for the probes past it). */
  private state = new Uint8Array(64);
  private used = 0;
  private size = 0;

  /** The slot of `key`, -1 when it has none. */
  get(key: number): number {
    const mask = this.keys.length - 1;
    for (let i = hash(key) & mask; ; i = (i + 1) & mask) {
      const s = this.state[i]!;
      if (s === 0) return -1;
      if (s === 1 && this.keys[i] === key) return this.vals[i]!;
    }
  }

  set(key: number, slot: number): void {
    if ((this.used + 1) * 10 > this.keys.length * 7) this.rehash(this.size * 4 > this.keys.length ? this.keys.length * 2 : this.keys.length);
    const mask = this.keys.length - 1;
    let tomb = -1;
    for (let i = hash(key) & mask; ; i = (i + 1) & mask) {
      const s = this.state[i]!;
      if (s === 1 && this.keys[i] === key) { this.vals[i] = slot; return; }
      if (s === 2 && tomb < 0) tomb = i;
      if (s === 0) {
        const at = tomb >= 0 ? tomb : i;
        if (tomb < 0) this.used++;
        this.state[at] = 1;
        this.keys[at] = key;
        this.vals[at] = slot;
        this.size++;
        return;
      }
    }
  }

  delete(key: number): void {
    const mask = this.keys.length - 1;
    for (let i = hash(key) & mask; ; i = (i + 1) & mask) {
      const s = this.state[i]!;
      if (s === 0) return;
      if (s === 1 && this.keys[i] === key) { this.state[i] = 2; this.size--; return; }
    }
  }

  private rehash(n: number): void {
    const { keys, vals, state } = this;
    this.keys = new Float64Array(n);
    this.vals = new Int32Array(n);
    this.state = new Uint8Array(n);
    this.used = 0;
    this.size = 0;
    for (let i = 0; i < keys.length; i++) if (state[i] === 1) this.set(keys[i]!, vals[i]!);
  }
}

/** A double's hash from its two 32-bit halves (an integer key up to 2^53; murmur3's finaliser). */
function hash(key: number): number {
  const lo = key >>> 0, hi = Math.floor(key / 4294967296) >>> 0;
  let h = Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** Slots in groups by a number key (a node, a tile, a cell): each slot in one group at most, a group's slots in the order they joined (as a Set's). */
export class Threads {
  /** Each key's group, in the order the groups were made (as a Map's). */
  private readonly groups = new Map<number, number>();
  private gKey = new Float64Array(16);
  private gHead = new Int32Array(16);
  private gTail = new Int32Array(16);
  private gCount = new Int32Array(16);
  private readonly gFree: number[] = [];
  private gTop = 0;
  private next = new Int32Array(0);
  private prev = new Int32Array(0);
  /** Each slot's group, -1 for none. */
  private groupOf = new Int32Array(0);

  /** Room for slots below `n`. */
  reserve(n: number): void {
    if (n <= this.groupOf.length) return;
    const cap = Math.max(n, this.groupOf.length * 2, 64);
    this.next = grown(this.next, cap, -1);
    this.prev = grown(this.prev, cap, -1);
    this.groupOf = grown(this.groupOf, cap, -1);
  }

  /** `slot` put last in `key`'s group (out of the one it was in). */
  add(slot: number, key: number): void {
    this.reserve(slot + 1);
    if (this.groupOf[slot]! >= 0) this.remove(slot);
    let g = this.groups.get(key);
    if (g === undefined) {
      g = this.gFree.pop() ?? this.gTop++;
      if (g >= this.gKey.length) {
        const n = this.gKey.length * 2;
        this.gKey = grown(this.gKey, n); this.gHead = grown(this.gHead, n); this.gTail = grown(this.gTail, n); this.gCount = grown(this.gCount, n);
      }
      this.groups.set(key, g);
      this.gKey[g] = key; this.gHead[g] = -1; this.gTail[g] = -1; this.gCount[g] = 0;
    }
    const tail = this.gTail[g]!;
    this.prev[slot] = tail;
    this.next[slot] = -1;
    if (tail >= 0) this.next[tail] = slot; else this.gHead[g] = slot;
    this.gTail[g] = slot;
    this.gCount[g] = this.gCount[g]! + 1;
    this.groupOf[slot] = g;
  }

  /** `slot` out of its group; a group left empty goes. */
  remove(slot: number): void {
    const g = slot < this.groupOf.length ? this.groupOf[slot]! : -1;
    if (g < 0) return;
    const p = this.prev[slot]!, n = this.next[slot]!;
    if (p >= 0) this.next[p] = n; else this.gHead[g] = n;
    if (n >= 0) this.prev[n] = p; else this.gTail[g] = p;
    this.groupOf[slot] = -1;
    this.gCount[g] = this.gCount[g]! - 1;
    if (this.gCount[g] === 0) { this.groups.delete(this.gKey[g]!); this.gFree.push(g); }
  }

  /** The key of `slot`'s group (NaN: none). */
  keyOf(slot: number): number {
    const g = slot < this.groupOf.length ? this.groupOf[slot]! : -1;
    return g >= 0 ? this.gKey[g]! : Number.NaN;
  }

  /** The group of `key` (-1: none). */
  group(key: number): number {
    return this.groups.get(key) ?? -1;
  }

  /** Every group, in the order they were made. */
  allGroups(): IterableIterator<number> {
    return this.groups.values();
  }

  /** A group's first slot (-1: none), the slot after `slot` in its group (-1: the last), how many it holds. */
  head(g: number): number {
    return g >= 0 ? this.gHead[g]! : -1;
  }

  after(slot: number): number {
    return this.next[slot]!;
  }

  count(g: number): number {
    return g >= 0 ? this.gCount[g]! : 0;
  }

  /** The slots of `key`'s group, as a new list. */
  list(key: number): number[] {
    const out: number[] = [];
    for (let s = this.head(this.group(key)); s >= 0; s = this.next[s]!) out.push(s);
    return out;
  }

  get bytes(): number {
    return this.next.byteLength * 3 + this.gKey.byteLength + this.gHead.byteLength * 3;
  }
}
