/** A METER OF THE LAB'S CONSUMERS: the samples of one thing that costs (a system's ms, a measure, a pool's queue, the bytes a class holds), timed, read over a window or the whole session */

/** What a consumer spends: the main thread, a worker's, the GPU's time, video memory, the page's memory, the disk, the network. */
export type ResourceCategory = 'CPU-main' | 'CPU-worker' | 'GPU' | 'VRAM' | 'RAM' | 'Disk' | 'Network';

/** `event`: each sample a cost that happened (a measure, a frame's system) - its total means something; `gauge`: each sample a reading of a level (bytes held, jobs waiting) - its last is what stands now. */
export type MeterKind = 'event' | 'gauge';

/** A window of time read: the last 5 s, the last 30 s, or since the session's start (or the last reset). */
export type ResourceWindow = '5s' | '30s' | 'session';

export const WINDOW_MS: Readonly<Record<ResourceWindow, number>> = { '5s': 5_000, '30s': 30_000, session: Infinity };

/** One meter read: what the consumers' table shows of it. */
export interface MeterReading {
  readonly key: string;
  readonly name: string;
  readonly category: ResourceCategory;
  readonly source: string;
  readonly unit: string;
  readonly kind: MeterKind;
  readonly avg: number | null;
  readonly p95: number | null;
  readonly max: number | null;
  /** Events: their sum; gauges: null (a sum of levels means nothing). */
  readonly total: number | null;
  readonly count: number;
  /** The newest sample. */
  readonly last: number | null;
  /** What else is worth knowing of it (idle runs, transferred bytes, lanes...). */
  readonly note: string;
}

/** Samples kept per meter for the windows: past this the oldest go (a 30 s window at 68 Hz and more reads only its last 2048). */
const RING = 2048;
/** Samples kept at random for the session's 95th percentile (Vitter's reservoir, algorithm R). */
const RESERVOIR = 512;

/** The P-th percentile (nearest rank) of values already sorted. */
const ranked = (sorted: readonly number[], p: number): number => sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]!;

export class Meter {
  /** The ring: times and values, `head` the next slot, `size` how many are held. */
  private times: Float64Array = new Float64Array(16);
  private values: Float64Array = new Float64Array(16);
  private head = 0;
  private size = 0;
  /** The whole session (since `reset`): count, sum, largest, newest, and a reservoir of values. */
  private count = 0;
  private sum = 0;
  private largest = -Infinity;
  private newest: number | null = null;
  private readonly reservoir: number[] = [];
  note = '';

  constructor(
    readonly key: string,
    readonly name: string,
    readonly category: ResourceCategory,
    readonly source: string,
    readonly unit: string,
    readonly kind: MeterKind,
  ) {}

  add(value: number, t: number): void {
    if (!Number.isFinite(value)) return;
    if (this.size === this.times.length && this.size < RING) this.grow();
    this.times[this.head] = t;
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.times.length;
    if (this.size < this.times.length) this.size++;
    this.count++;
    this.sum += value;
    if (value > this.largest) this.largest = value;
    this.newest = value;
    if (this.reservoir.length < RESERVOIR) this.reservoir.push(value);
    else {
      const j = Math.floor(Math.random() * this.count);
      if (j < RESERVOIR) this.reservoir[j] = value;
    }
  }

  /** The ring doubled, its samples kept in order. */
  private grow(): void {
    const n = Math.min(RING, this.times.length * 2);
    const times = new Float64Array(n), values = new Float64Array(n);
    for (let i = 0; i < this.size; i++) {
      const j = (this.head - this.size + i + this.times.length) % this.times.length;
      times[i] = this.times[j]!;
      values[i] = this.values[j]!;
    }
    this.times = times;
    this.values = values;
    this.head = this.size % n;
  }

  /** The values sampled since `since`, oldest first. */
  since(since: number): number[] {
    const out: number[] = [];
    const n = this.times.length;
    for (let i = 0; i < this.size; i++) {
      const j = (this.head - this.size + i + n) % n;
      if (this.times[j]! >= since) out.push(this.values[j]!);
    }
    return out;
  }

  /** The time of the newest sample, -Infinity when none. */
  get lastAt(): number {
    return this.size ? this.times[(this.head - 1 + this.times.length) % this.times.length]! : -Infinity;
  }

  reset(): void {
    this.head = 0;
    this.size = 0;
    this.count = 0;
    this.sum = 0;
    this.largest = -Infinity;
    this.newest = null;
    this.reservoir.length = 0;
  }

  /** Read over `window` ending `now`: the session's from its running sums and its reservoir, a window's from the ring. */
  read(window: ResourceWindow, now: number): MeterReading {
    const base = { key: this.key, name: this.name, category: this.category, source: this.source, unit: this.unit, kind: this.kind, note: this.note };
    if (window === 'session') {
      const sorted = [...this.reservoir].sort((a, b) => a - b);
      return {
        ...base,
        avg: this.count ? this.sum / this.count : null,
        p95: sorted.length ? ranked(sorted, 95) : null,
        max: this.count ? this.largest : null,
        total: this.kind === 'event' ? this.sum : null,
        count: this.count,
        last: this.newest,
      };
    }
    const values = this.since(now - WINDOW_MS[window]);
    const sorted = [...values].sort((a, b) => a - b);
    let sum = 0;
    for (const v of values) sum += v;
    return {
      ...base,
      avg: values.length ? sum / values.length : null,
      p95: sorted.length ? ranked(sorted, 95) : null,
      max: sorted.length ? sorted[sorted.length - 1]! : null,
      total: this.kind === 'event' ? sum : null,
      count: values.length,
      // A gauge's level stands until read again: its newest, whatever the window.
      last: this.kind === 'gauge' ? this.newest : values.length ? values[values.length - 1]! : null,
    };
  }
}

/** Every meter by key, made on first use. */
export class MeterBook {
  private readonly meters = new Map<string, Meter>();

  /** The meter `key`, made with these traits the first time. */
  meter(key: string, name: string, category: ResourceCategory, source: string, unit: string, kind: MeterKind): Meter {
    let m = this.meters.get(key);
    if (!m) this.meters.set(key, m = new Meter(key, name, category, source, unit, kind));
    return m;
  }

  get(key: string): Meter | undefined {
    return this.meters.get(key);
  }

  all(): IterableIterator<Meter> {
    return this.meters.values();
  }

  /** Every meter emptied (the gauges' last level too: read again at the next poll). */
  reset(): void {
    for (const m of this.meters.values()) m.reset();
  }

  /** Every meter read over `window`; those with no sample in it left out (a gauge always kept while it has a level). */
  read(window: ResourceWindow, now: number): MeterReading[] {
    const out: MeterReading[] = [];
    for (const m of this.meters.values()) {
      const r = m.read(window, now);
      if (r.count > 0 || (r.kind === 'gauge' && r.last !== null)) out.push(r);
    }
    return out;
  }
}

/** The slope of `y` over `t` (least squares), per the unit of `t`; 0 with fewer than 3 points. */
export function slope(points: readonly (readonly [t: number, y: number])[]): number {
  const n = points.length;
  if (n < 3) return 0;
  let st = 0, sy = 0;
  for (const [t, y] of points) { st += t; sy += y; }
  const mt = st / n, my = sy / n;
  let num = 0, den = 0;
  for (const [t, y] of points) { num += (t - mt) * (y - my); den += (t - mt) ** 2; }
  return den > 0 ? num / den : 0;
}

/** Nearest-rank percentile of unsorted values; null when none. */
export function percentileOf(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  return ranked([...values].sort((a, b) => a - b), p);
}
