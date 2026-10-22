/** DO NOT write another heap beside it: the copies drifted */
/** Its items, priorities and arrival order in typed columns (outside the JS heap, no array element boxed): a heap may hold one entry a building of the city (`decayWatch.ts`). */
export class Heap {
  constructor(private readonly before?: (a: number, b: number) => boolean) {}
  private items = new Float64Array(16);
  private keys = new Float64Array(16);
  private order = new Float64Array(16);
  private count = 0;
  private seq = 0;
  get size(): number { return this.count; }
  /** The smallest priority waiting (Infinity when empty), without taking it. */
  peekKey(): number { return this.count ? this.keys[0]! : Infinity; }
  clear(): void { this.count = 0; this.seq = 0; }
  push(item: number, key: number): void {
    if (this.count === this.items.length) this.grow();
    let i = this.count++;
    this.items[i] = item; this.keys[i] = key; this.order[i] = this.seq++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    // Empty: nothing, as an empty array's first item was.
    if (this.count === 0) return undefined as unknown as number;
    const top = this.items[0]!;
    const last = this.count - 1;
    this.swap(0, last);
    this.count--;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < this.count && this.less(l, m)) m = l;
      if (r < this.count && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m); i = m;
    }
    return top;
  }
  private grow(): void {
    const n = this.items.length * 2;
    const items = new Float64Array(n), keys = new Float64Array(n), order = new Float64Array(n);
    items.set(this.items); keys.set(this.keys); order.set(this.order);
    this.items = items; this.keys = keys; this.order = order;
  }
  private less(a: number, b: number): boolean {
    if (this.keys[a]! !== this.keys[b]!) return this.keys[a]! < this.keys[b]!;
    const before = this.before;
    if (before) {
      const ia = this.items[a]!, ib = this.items[b]!;
      if (before(ia, ib)) return true;
      if (before(ib, ia)) return false;
    }
    return this.order[a]! < this.order[b]!;
  }
  // Swapped through locals: a destructuring swap made two arrays a swap.
  private swap(a: number, b: number): void {
    const item = this.items[a]!; this.items[a] = this.items[b]!; this.items[b] = item;
    const key = this.keys[a]!; this.keys[a] = this.keys[b]!; this.keys[b] = key;
    const order = this.order[a]!; this.order[a] = this.order[b]!; this.order[b] = order;
  }
}
