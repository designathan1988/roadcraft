import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NodeId } from '@world/ids';
import { Level, SURFACE_LEVELS } from '@world/roadTypes';
import { replay, type Fixture } from '../fuzz/support/runner';

/**
 * EVERY SURFACE OF A BEND IS ONE BEND (AT2).
 *
 * A node where one road bends on (a transition, `junction/transition.ts`) was
 * built a surface at a time, each over a run of its own half-width and cut by
 * a cap of its own: on a 45-degree bend of a highway the carriageway, kerb,
 * footway and verge were cut at 7.4, 7.5, 8.2 and 9.0 units, and the kerb
 * stepped out where the footway still ran straight; on a curved bend of a
 * boulevard into an avenue the footway and the verge fell back to a corner
 * plate under a transition carriageway, a strip of footway paving across the
 * road at the mouth. Every surface is now the carriageway's transition at its
 * own half-width (`junction/derive.ts deriveTransitionLevel`).
 */
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
