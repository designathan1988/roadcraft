import { describe, expect, it } from 'vitest';
import type { LaneletId } from '@world/lanelets';
import { fixtureDoc, simOf } from './support/bodies';

describe('reading a lane', () => {
  it('makes no runtime state for it', () => {
    const sim = simOf(fixtureDoc(), 0x5eed, 2);
    const live = [...sim.graph.lanelets.keys()][0]!;
    const size = sim.runtime.size;
    expect(sim.rt(live).order.length).toBe(0);
    expect(sim.rt('no-such-lane' as LaneletId).ghost).toBe(false);
    expect(sim.runtime.size, 'a read added no lane runtime').toBe(size);
    expect(sim.ghostCandidates.size, 'a read added no ghost candidate').toBe(0);
  });

  it('cannot be written through: the empty answer is shared and frozen', () => {
    const sim = simOf(fixtureDoc(), 0x5eed, 2);
    const live = [...sim.graph.lanelets.keys()][0]!;
    expect(() => sim.rt(live).order.push(1 as never)).toThrow();
  });
});
