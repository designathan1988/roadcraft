import { describe, expect, it } from 'vitest';
import type { Defect } from './support/invariants';
import { generate, openCategories, profile, replay, saveFixture, shrink } from './support/runner';

/** THE DEFECT DETECTOR. */
const run = profile();
const first = Number(process.env['FUZZ_FIRST'] ?? 1);
const seeds = Array.from({ length: run.sequences }, (_, i) => first + i);

describe('road fuzzer', () => {
  // One test per sequence, each in a few seconds (all of them in one test passed its 10 s).
  for (const seed of seeds) it(`finds no defect in seeded sequence ${seed}`, () => {
    // A category with an OPEN fixture is a known, recorded defect; it runs but does not fail the gate.
    const open = openCategories();
    const gated = (category: string): boolean => !open.has(category);
    const ops = generate(seed, run.ops);
    const outcome = replay(ops, run.sim, gated);
    if (!outcome.defects.length) return;
    const worst = outcome.defects[0] as Defect;
    const minimal = shrink(ops, worst.category, run.sim);
    if (process.env['FUZZ_RECORD'] === '1') {
      saveFixture({ name: `${worst.category}-seed${seed}`, category: worst.category, detail: worst.detail,
        sim: outcome.step < 0 ? run.sim : null, ops: minimal });
    }
    expect({ seed, defect: worst, ops: minimal }).toBeUndefined();
  });
});
