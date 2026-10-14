import { expect } from 'vitest';
import { Rng } from '@core/rng';
import type { Derived } from '@world/derived';
import type { ChangeJournal } from '@world/changes';

/**
 * THE GENERIC PROOF OF A PRODUCT ON THE SPINE (`world/derived.ts`): random edits
 * with a seed, and after each one the product kept incrementally equals the
 * same product made from nothing; a refresh with no edit computes nothing.
 * Every product converted to the spine is proved by this, not by a test of
 * its own written by hand.
 */
export function proveIncremental<D extends { readonly changes: ChangeJournal }, K, V>(options: {
  readonly source: D;
  /** A new product (made from nothing at its first refresh). */
  readonly make: () => Derived<D, K, V>;
  /** Edits of the source; each draws what it needs from the generator. */
  readonly edits: readonly ((source: D, rng: Rng) => void)[];
  readonly steps: number;
  readonly seed: number;
  /** Whether two values are the same (the product's own `equals` by default). */
  readonly same?: (a: V, b: V) => boolean;
}): void {
  const { source, make, edits, steps, seed } = options;
  const rng = new Rng(seed);
  const kept = make();
  kept.refresh(source);
  for (let step = 0; step < steps; step++) {
    edits[Math.floor(rng.float() * edits.length)]!(source, rng);
    kept.refresh(source);
    const fresh = make();
    fresh.refresh(source);
    const same = options.same ?? kept.spec.equals ?? ((a: V, b: V) => a === b);
    expect(kept.size, `step ${step}: keys`).toBe(fresh.size);
    for (const [key, value] of fresh.entries()) {
      const mine = kept.get(key);
      expect(mine !== undefined && same(mine, value), `step ${step}: key ${String(key)}`).toBe(true);
    }
    // Nothing new: nothing computed.
    kept.refresh(source);
    expect(kept.work.last, `step ${step}: an idle refresh computes nothing`).toBe(0);
  }
}
