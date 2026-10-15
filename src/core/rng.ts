import { DIV_EPS } from './scalar';
/** The four words of an `Rng`'s state (`Rng.state`). */
export type RngState = readonly [number, number, number, number];

/** Deterministic RNG: xoshiro128** seeded through splitmix32. */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    let x = seed >>> 0;
    const next = (): number => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    // Guard against the all-zero state.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Where the stream stands: four words a message carries (`fromState` goes on from them, draw for draw). */
  state(): RngState {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  /** A stream going on from `state()`: the same draws, in another worker. */
  static fromState(state: RngState): Rng {
    const rng = new Rng(0);
    [rng.s0, rng.s1, rng.s2, rng.s3] = state;
    return rng;
  }

  u32(): number {
    const rot = (v: number, k: number): number => ((v << k) | (v >>> (32 - k))) >>> 0;
    const result = (Math.imul(rot(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0) >>> 0;
    const t = (this.s1 << 9) >>> 0;

    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rot(this.s3, 11);

    return result;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.u32() / 0x1_0000_0000;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + this.float() * (hi - lo);
  }

  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  bool(p = 0.5): boolean {
    return this.float() < p;
  }

  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error('Rng.pick: empty array');
    return xs[Math.floor(this.float() * xs.length)] as T;
  }

  /** Box-Muller normal deviate. */
  normal(mu = 0, sd = 1): number {
    const u = Math.max(this.float(), DIV_EPS);
    const v = this.float();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of entries) total += w;
    let r = this.float() * total;
    for (const [value, w] of entries) {
      r -= w;
      if (r <= 0) return value;
    }
    return entries[entries.length - 1]?.[0] as T;
  }

  /** Derives an independent stream from a string tag. */
  fork(tag: string): Rng {
    let h = 2166136261;
    for (let i = 0; i < tag.length; i++) {
      h = Math.imul(h ^ tag.charCodeAt(i), 16777619) >>> 0;
    }
    return new Rng((this.u32() ^ h) >>> 0);
  }
}

/** DO NOT copy it into a file: eight copies of it stood beside this module (2026-10-14). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
