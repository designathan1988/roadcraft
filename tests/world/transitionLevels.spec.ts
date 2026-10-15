import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NodeId } from '@world/ids';
import { Level, SURFACE_LEVELS } from '@world/roadTypes';
import { replay, type Fixture } from '../fuzz/support/runner';

/** EVERY SURFACE OF A BEND IS ONE BEND (AT2). */
function junctionOf(name: string, node: number) {
  const fixture = JSON.parse(readFileSync(`tests/fuzz/fixtures/${name}.json`, 'utf8')) as Fixture;
  return replay(fixture.ops, null).state.net.junctions.get(node as NodeId)!;
}

describe('a bend of one road', () => {
  it.each([
    ['turn-shaped-for-the-bus-alone-on-gentle-bend', 2],
    ['curved-mouth-strip-missing-from-turn-surface', 1],
    ['bus-leaves-kerb-on-acute-turn', 2],
    ['kink-at-chain-node-read-as-straight', 3],
  ])('is a transition on every surface, cut at the same distance (%s)', (name, node) => {
    const byLevel = junctionOf(name, node);
    const carriageway = byLevel.get(Level.Asphalt)!;
    expect(carriageway.transition).toBe(true);
    for (const level of SURFACE_LEVELS) {
      const junction = byLevel.get(level)!;
      expect(junction.transition, `level ${level}`).toBe(true);
      for (const [i, trim] of junction.trims.entries()) expect(trim, `level ${level} leg ${i}`).toBeCloseTo(carriageway.trims[i]!, 6);
    }
  });
});
