/** RUNS OF NUMBERS BY KEY IN ONE TYPED ARRAY: each key's run (its start and length in columns at the key) in a shared `Float64Array`; a run let go stays until the dead outweigh the live (`pack`). No array a key, outside the JS heap (`kerbBays.ts` EntranceBook's runs, made general). */
export class RunPool {
  private starts = new Int32Array(16);
  private lengths = new Int32Array(16);
  /** The numbers of every run; DO NOT keep it across a `put`: packing makes another. */
  data = new Float64Array(64);
  private used = 0;
  private live = 0;

  /** Where a key's run starts in `data`. */
  start(key: number): number {
    return this.starts[key] ?? 0;
  }

  /** How many numbers a key's run holds (0: none). */
  length(key: number): number {
    return key < this.lengths.length ? this.lengths[key]! : 0;
  }

  /** Room for `n` numbers at a key, its old run let go: where to write them in `data` (read `data` after the call). */
  put(key: number, n: number): number {
    this.drop(key);
    if (key >= this.starts.length) this.reserve(Math.max(key + 1, Math.ceil(this.starts.length * 1.5)));
    if (n <= 0) return 0;
    if (this.used + n > this.data.length) this.pack(n);
    const at = this.used;
    this.starts[key] = at;
    this.lengths[key] = n;
    this.used += n;
    this.live += n;
    return at;
  }

  /** Room for the keys below `keys` (a map's buildings, known before they are put). */
  reserve(keys: number): void {
    if (keys <= this.starts.length) return;
    const starts = new Int32Array(keys), lengths = new Int32Array(keys);
    starts.set(this.starts); lengths.set(this.lengths);
    this.starts = starts; this.lengths = lengths;
  }

  /** A key's run let go. */
  drop(key: number): void {
    if (key >= this.lengths.length || this.lengths[key] === 0) return;
    this.live -= this.lengths[key]!;
    this.lengths[key] = 0;
  }

  /** Every run let go; the room kept. */
  clear(): void {
    this.lengths.fill(0);
    this.used = 0;
    this.live = 0;
  }

  /** The live runs packed together, room made for `more` numbers: in an array of the same size while that leaves a quarter of it free, else half again what is needed (DO NOT double: twice the room a city's runs need, and as much again dead). */
  private pack(more: number): void {
    const need = this.live + more;
    const size = need <= this.data.length * 0.75 ? this.data.length : Math.max(64, Math.ceil(need * 1.5));
    const out = new Float64Array(size);
    let used = 0;
    for (let key = 0; key < this.lengths.length; key++) {
      const n = this.lengths[key]!;
      if (!n) continue;
      const from = this.starts[key]!;
      out.set(this.data.subarray(from, from + n), used);
      this.starts[key] = used;
      used += n;
    }
    this.data = out;
    this.used = used;
    this.live = used;
  }
}
