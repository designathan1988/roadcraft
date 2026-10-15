/** The last `capacity` samples of a measure (ms), in a ring: nothing allocated per sample, so it can be fed every frame. */
export class SampleRing {
  private readonly values: Float32Array;
  private head = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    this.values = new Float32Array(capacity);
  }

  get size(): number {
    return this.filled;
  }

  push(value: number): void {
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
  }

  /** The samples kept, oldest first. */
  toArray(): number[] {
    const out: number[] = [];
    const start = this.filled < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.filled; i++) out.push(this.values[(start + i) % this.capacity]!);
    return out;
  }

  /** p50, p95, p99 and the largest; how many; how many over `over` ms. */
  stats(over = Infinity): SampleStats {
    const sorted = this.toArray().sort((a, b) => a - b);
    const n = sorted.length;
    const at = (p: number): number => (n ? sorted[Math.min(n, Math.max(1, Math.ceil((p / 100) * n))) - 1]! : 0);
    let above = 0;
    for (const v of sorted) if (v > over) above++;
    const round = (ms: number): number => Math.round(ms * 100) / 100;
    return { n, p50: round(at(50)), p95: round(at(95)), p99: round(at(99)), max: round(at(100)), over: above };
  }
}

export interface SampleStats {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  /** Samples over the threshold asked for. */
  readonly over: number;
}

/** Two periods of a 59 Hz display: a frame that took longer was seen as a stutter (NVIDIA, "Analysing Stutter"). */
export const STUTTER_MS = 2 * (1000 / 59);
