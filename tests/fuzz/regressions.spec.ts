import { describe, expect, it } from 'vitest';
import { loadFixtures, replay } from './support/runner';

/** Every defect the fuzzer ever shrank, replayed for ever. */
describe('fuzz regressions', () => {
  for (const fixture of loadFixtures()) {
    const test = fixture.open ? it.fails : it;
    test(`${fixture.name}: ${fixture.category}${fixture.open ? ' (open)' : ''}`, () => {
      const outcome = replay(fixture.ops, fixture.sim, fixture.category);
      expect(outcome.defects).toEqual([]);
    });
  }
  it('has a fixture directory the loader can read', () => {
    expect(Array.isArray(loadFixtures())).toBe(true);
  });
});
