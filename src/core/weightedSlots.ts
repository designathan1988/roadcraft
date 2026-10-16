/** SLOTS IN ORDER, EACH EMPTY OR OF ONE OF A FEW CLASSES, AND THE DRAWS OF A WEIGHTED LIST OVER THEM WITHOUT WALKING IT */

/** DO NOT walk a list of thousands to draw one by weight: a Fenwick tree of counts per class, its prefix of weights read in log steps */
export class WeightedSlots {
  /** Slots the trees hold room for: a power of two, doubled as slots are handed out. */
  private cap = 0;
  private used = 0;
  /** Each slot's class, -1 empty. */
  private classes = new Int8Array(0);
  /** Per class, a Fenwick tree of the slots of that class (1-based). */
  private readonly trees: Int32Array[] = [];
  private readonly counts: Int32Array;
  private occupied = 0;

  /** `kinds`: how many classes, under 128. */
  constructor(private readonly kinds: number) {
    for (let c = 0; c < kinds; c++) this.trees.push(new Int32Array(1));
    this.counts = new Int32Array(kinds);
  }

  /** Slots handed out (`push`) since the last `clear`. */
  get length(): number {
    return this.used;
  }

  /** A new slot after every other, of class `cls` (-1: empty). */
  push(cls: number): number {
    if (this.used === this.cap) this.grow();
    const slot = this.used++;
    this.classes[slot] = -1;
    if (cls >= 0) this.set(slot, cls);
    return slot;
  }

  /** A slot's class changed (-1: empty). */
  set(slot: number, cls: number): void {
    const was = this.classes[slot]!;
    if (was === cls) return;
    if (was >= 0) { this.add(was, slot, -1); this.counts[was]!--; this.occupied--; }
    this.classes[slot] = cls;
    if (cls >= 0) { this.add(cls, slot, 1); this.counts[cls]!++; this.occupied++; }
  }

  /** A slot's class, -1 empty. */
  classAt(slot: number): number {
    return slot >= 0 && slot < this.used ? this.classes[slot]! : -1;
  }

  /** The slots of a class. */
  count(cls: number): number {
    return this.counts[cls]!;
  }

  /** The slots not empty. */
  total(): number {
    return this.occupied;
  }

  /** The first slot whose weights summed from the first slot on pass `target` (≥ 0), a slot's weight its class's; -1 when the whole sum does not */
  findWeighted(weights: ArrayLike<number>, target: number): number {
    let pos = 0, acc = 0;
    for (let step = this.cap; step > 0; step >>= 1) {
      const next = pos + step;
      if (next > this.cap) continue;
      let w = 0;
      for (let c = 0; c < this.kinds; c++) w += weights[c]! * this.trees[c]![next]!;
      if (acc + w <= target) { pos = next; acc += w; }
    }
    return pos < this.used ? pos : -1;
  }

  /** The `k`-th slot not empty, from 0, in order; -1 when there are not that many. */
  nth(k: number): number {
    if (k < 0 || k >= this.occupied) return -1;
    let pos = 0, acc = 0;
    for (let step = this.cap; step > 0; step >>= 1) {
      const next = pos + step;
      if (next > this.cap) continue;
      let n = 0;
      for (let c = 0; c < this.kinds; c++) n += this.trees[c]![next]!;
      if (acc + n <= k) { pos = next; acc += n; }
    }
    return pos;
  }

  /** Every slot taken back: the next `push` is slot 0 (the room is kept). */
  clear(): void {
    this.used = 0;
    this.occupied = 0;
    this.counts.fill(0);
    for (const tree of this.trees) tree.fill(0);
  }

  private add(cls: number, slot: number, delta: number): void {
    const tree = this.trees[cls]!;
    for (let i = slot + 1; i <= this.cap; i += i & -i) tree[i] = tree[i]! + delta;
  }

  /** Room doubled: each tree made again from the classes in one pass (a parent takes its child's sum). */
  private grow(): void {
    const cap = Math.max(64, this.cap * 2);
    const classes = new Int8Array(cap);
    classes.set(this.classes.subarray(0, this.used));
    this.classes = classes;
    this.cap = cap;
    for (let c = 0; c < this.kinds; c++) this.trees[c] = new Int32Array(cap + 1);
    for (let i = 0; i < this.used; i++) {
      const c = classes[i]!;
      if (c >= 0) this.trees[c]![i + 1]!++;
    }
    for (const tree of this.trees) {
      for (let i = 1; i <= cap; i++) {
        const parent = i + (i & -i);
        if (parent <= cap) tree[parent] = tree[parent]! + tree[i]!;
      }
    }
  }
}
