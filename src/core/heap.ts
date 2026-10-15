/**
 * A binary min-heap of (item, priority), ties broken by `before(a, b)` (item
 * a goes first) when given, then by insertion order. The one heap of the
 * game: a search that needs its ties by place (`editor/poleRoutes.ts`) passes
 * `before`. DO NOT write another heap beside it: the copies drifted (one read its
 * keys from the array the search lowers, so waiting entries changed key under
 * it, `sim/agents/lotNav.ts` before 2026-10-14).
 */
export class Heap {
  constructor(private readonly before?: (a: number, b: number) => boolean) {}
  private items: number[] = [];
  private keys: number[] = [];
  private order: number[] = [];
  private seq = 0;
  get size(): number { return this.items.length; }
  /** The smallest priority waiting (Infinity when empty), without taking it. */
  peekKey(): number { return this.items.length ? this.keys[0]! : Infinity; }
  clear(): void { this.items.length = 0; this.keys.length = 0; this.order.length = 0; this.seq = 0; }
  push(item: number, key: number): void {
    this.items.push(item); this.keys.push(key); this.order.push(this.seq++);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const top = this.items[0]!;
    const last = this.items.length - 1;
    this.swap(0, last);
    this.items.pop(); this.keys.pop(); this.order.pop();
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < this.items.length && this.less(l, m)) m = l;
      if (r < this.items.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m); i = m;
    }
    return top;
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
